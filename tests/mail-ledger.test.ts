import { describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { guardKey, opKey, RECORD_TTL_SECONDS } from '../src/mail/dynamo-store';
import type { DraftGuardRecord, MailOperationRecord } from '../src/mail/contracts';
import { HOLD_AGED_MS, holdAction, SEND_CHECK_AGED_MS, type HoldAction } from '../src/mail/service';
import {
    applyPlan, decideGuard, describeHold, explainHold, GUARD_PK_PREFIX, OPERATION_PK_PREFIX, parseGuardItem, parseOperationItem, planCleanup, runLedger, stillDeletable, USAGE,
    type CliDeps, type ItemKey, type LedgerClient, type Pacing, type PlannedDelete, type RawItem, type ScanPage, type WriteOutcome,
} from '../scripts/mail-ledger-core';

const must = <T>(value: T | undefined): T => {
    if (value === undefined) { throw new Error('missing fixture value'); }
    return value;
};
const NOW = 1_800_000_000;
const EXPIRES = NOW + RECORD_TTL_SECONDS;
const ACCOUNT = '1'.repeat(24);
const MAILBOX = 'a'.repeat(24);
const SENT = 'b'.repeat(24);
const HASH = 'c'.repeat(43);
const DIGEST = 'd'.repeat(43);
const OWNER_TOKEN = 'owner-token-'.padEnd(43, 'a');
const opId = (n: number) => `operation-${String(n).padStart(8, '0')}`;
const keyOf = (n: number) => ({ accountId: ACCOUNT, clientIdHash: HASH, operationId: opId(n) });

type Tool = 'create_draft' | 'update_draft' | 'delete_draft' | 'send_draft' | 'move_message' | 'update_message_flags';
type GuardState = DraftGuardRecord['state'];
const proof = (mailboxId: string, uid: number, sourceGrade = 'observed') => ({ accountId: ACCOUNT, mailboxId, uid, version: DIGEST, contentDigest: 'a'.repeat(64), sourceGrade });
const ref = (mailboxId: string, uid: number) => ({ mailboxId, uid, version: DIGEST });
/** Receipts in the stored spelling (operation_id), as 0.6 to 0.10 wrote them. */
const receipts = {
    deleted: (n: number, uid: number) => ({ status: 'completed', operation_id: opId(n), deleted: { mailboxId: MAILBOX, uid } }),
    moved: (n: number, uid: number) => ({ status: 'completed', operation_id: opId(n), message: ref(SENT, uid), verified: true, proof: proof(SENT, uid) }),
    updated: (n: number, uid: number) => ({ status: 'completed', operation_id: opId(n), draft: ref(MAILBOX, uid + 1000), verified: true, previousDeleted: true, proof: proof(MAILBOX, uid + 1000, 'mcp_authored') }),
    created: (n: number, uid: number) => ({ status: 'completed', operation_id: opId(n), draft: ref(MAILBOX, uid), verified: true, proof: proof(MAILBOX, uid, 'mcp_authored') }),
    queued: (n: number) => ({ status: 'queued', operation_id: opId(n), queueId: `queue-${n}` }),
    unknown: (n: number) => ({ status: 'outcome_unknown', operation_id: opId(n), reason: 'dispatch_uncertain' }),
    heldPartial: (n: number, uid: number, reason = 'original_deletion_failed') => ({ status: 'partial', operation_id: opId(n), candidate: ref(MAILBOX, uid + 1000), candidateVerified: true, proof: proof(MAILBOX, uid + 1000, 'mcp_authored'), reason, originalDeletion: reason === 'original_deletion_failed' ? 'failed' : 'unconfirmed' }),
};

interface PairSpec { n: number; tool: Tool; uid: number; state: 'reserved' | 'dispatched' | 'settled'; receipt?: Record<string, unknown>; guard?: GuardState | undefined; reservedAt?: number; opExpires?: number; guardExpires?: number }
/** An operation item and, when `guard` is given, its lock item. */
function pair(spec: PairSpec): RawItem[] {
    const key = keyOf(spec.n);
    const guarded = spec.tool !== 'create_draft';
    const intent = { ...key, tool: spec.tool, payloadDigest: DIGEST, ...(guarded ? { target: { mailboxId: MAILBOX, uid: spec.uid }, expectedVersion: DIGEST } : {}) };
    const record: Record<string, unknown> = { key, intent, ownerToken: OWNER_TOKEN, revision: spec.state === 'reserved' ? 0 : 2, state: spec.state, ...(spec.receipt ? { receipt: spec.receipt } : {}), ...(spec.reservedAt === undefined ? {} : { reservedAt: spec.reservedAt }) };
    const items: RawItem[] = [{ ...opKey(key), record, ...(spec.opExpires === undefined ? {} : { expiresAt: spec.opExpires }) }];
    if (spec.guard) {
        const target = { accountId: ACCOUNT, mailboxId: MAILBOX, uid: spec.uid };
        items.push({ ...guardKey(target), record: { key: target, operation: key, ownerToken: OWNER_TOKEN, revision: spec.state === 'reserved' ? 0 : 2, state: spec.guard }, ...(spec.guardExpires === undefined ? {} : { expiresAt: spec.guardExpires }) });
    }
    return items;
}
const guardPk = (uid: number) => guardKey({ accountId: ACCOUNT, mailboxId: MAILBOX, uid }).pk;

/** A table shaped like production before the migration: 140 settled operations, 76 old guards (45 retired, 27 queued, 4 outcome_unknown), nothing has expiresAt. */
function production(): RawItem[] {
    const items: RawItem[] = [];
    // Numbered from 1000 so these never collide with the edge cases.
    let n = 1000;
    const kinds: [Tool, (n: number, uid: number) => Record<string, unknown>][] = [['delete_draft', receipts.deleted], ['move_message', receipts.moved], ['update_draft', receipts.updated]];
    for (let i = 0; i < 45; i += 1) {
        const [tool, receipt] = must(kinds[i % 3]);
        items.push(...pair({ n, tool, uid: 100 + n, state: 'settled', receipt: receipt(n, 100 + n), guard: 'retired' })); n += 1;
    }
    for (let i = 0; i < 27; i += 1) { items.push(...pair({ n, tool: 'send_draft', uid: 100 + n, state: 'settled', receipt: receipts.queued(n), guard: 'queued' })); n += 1; }
    for (let i = 0; i < 4; i += 1) { items.push(...pair({ n, tool: 'move_message', uid: 100 + n, state: 'settled', receipt: receipts.unknown(n), guard: 'outcome_unknown' })); n += 1; }
    for (let i = 0; i < 64; i += 1) { items.push(...pair({ n, tool: 'create_draft', uid: 100 + n, state: 'settled', receipt: receipts.created(n, 100 + n) })); n += 1; }
    return items;
}

const nonMail: RawItem[] = ['connection', 'grant', 'code', 'attachment-upload'].map(kind => ({ pk: `wildduck-mcp#${kind}#abc`, sk: 'STATE', record: { anything: kind }, expiresAt: 5 }));

/**
 * Edge cases, each with a known uid so a test can find its guard. A row with expiresAt was written by the current version;
 * a row without it is a legacy row. Cases 1, 4, 7, 8, 10, 11 and 13 have a legacy guard; the others are current.
 */
function edgeCases(): RawItem[] {
    return [
        // 1: legacy update_draft that left both copies alive: a real hold, kept and given an expiry.
        ...pair({ n: 1, tool: 'update_draft', uid: 1, state: 'settled', receipt: receipts.heldPartial(1, 1), guard: 'retired' }),
        // 2: unconfirmed variant of the same, written by the current version: left alone.
        ...pair({ n: 2, tool: 'update_draft', uid: 2, state: 'settled', receipt: receipts.heldPartial(2, 2, 'original_deletion_unconfirmed'), guard: 'retired', opExpires: EXPIRES, guardExpires: EXPIRES }),
        // 3: send_draft with an unknown outcome, current version: the server handles it.
        ...pair({ n: 3, tool: 'send_draft', uid: 3, state: 'settled', receipt: receipts.unknown(3), guard: 'outcome_unknown', opExpires: EXPIRES, guardExpires: EXPIRES }),
        // 4: orphan guard.
        { ...guardKey({ accountId: ACCOUNT, mailboxId: MAILBOX, uid: 4 }), record: { key: { accountId: ACCOUNT, mailboxId: MAILBOX, uid: 4 }, operation: keyOf(4), ownerToken: OWNER_TOKEN, revision: 2, state: 'retired' } },
        // 5: fresh reserved pair written by 1.0.0.
        ...pair({ n: 5, tool: 'move_message', uid: 5, state: 'reserved', guard: 'reserved', reservedAt: NOW - 30, opExpires: EXPIRES, guardExpires: EXPIRES }),
        // 6: dispatched with reservedAt: left to the server's timeout.
        ...pair({ n: 6, tool: 'move_message', uid: 6, state: 'dispatched', guard: 'dispatched', reservedAt: NOW - 4000, opExpires: EXPIRES, guardExpires: EXPIRES }),
        // 7: old dispatched move with no reservedAt, legacy guard (its operation already has expiresAt): abandoned by an earlier version.
        ...pair({ n: 7, tool: 'move_message', uid: 7, state: 'dispatched', guard: 'dispatched', opExpires: EXPIRES }),
        // 8: legacy send_draft dispatched with no reservedAt: left in place and given an expiry (the server cannot tell its age, so never checks it).
        ...pair({ n: 8, tool: 'send_draft', uid: 8, state: 'dispatched', guard: 'dispatched', opExpires: EXPIRES }),
        // 9: settled operation that already has expiresAt and no guard: nothing to do.
        ...pair({ n: 9, tool: 'create_draft', uid: 9, state: 'settled', receipt: receipts.created(9, 9), opExpires: EXPIRES }),
        // 10: finished hold with a legacy guard (its operation already has expiresAt): the guard is deleted, the operation needs no write.
        ...pair({ n: 10, tool: 'delete_draft', uid: 10, state: 'settled', receipt: receipts.deleted(10, 10), guard: 'retired', opExpires: EXPIRES }),
        // 11: unreadable operation and the legacy guard that names it.
        { ...opKey(keyOf(11)), record: { nonsense: true } },
        { ...guardKey({ accountId: ACCOUNT, mailboxId: MAILBOX, uid: 11 }), record: { key: { accountId: ACCOUNT, mailboxId: MAILBOX, uid: 11 }, operation: keyOf(11), ownerToken: OWNER_TOKEN, revision: 2, state: 'retired' } },
        // 12: current-version retired guard of a held partial, with expiresAt on both: never written.
        ...pair({ n: 12, tool: 'update_draft', uid: 12, state: 'settled', receipt: receipts.heldPartial(12, 12), guard: 'retired', opExpires: EXPIRES, guardExpires: EXPIRES }),
        // 13: legacy guard whose revision differs from its owner's (the pair changed between two scan pages): left alone.
        ...mismatched(pair({ n: 13, tool: 'delete_draft', uid: 13, state: 'settled', receipt: receipts.deleted(13, 13), guard: 'retired' })),
        ...nonMail,
    ];
}

/** The guard of a pair, one revision ahead of its owner. */
function mismatched(items: RawItem[]): RawItem[] {
    return items.map(item => String(item.pk).startsWith(GUARD_PK_PREFIX) ? { ...item, record: { ...(item.record as Record<string, unknown>), revision: 3 } } : item);
}

const plansFor = (items: readonly RawItem[]) => planCleanup(items, NOW);
const deletesOf = (plan: ReturnType<typeof planCleanup>) => plan.actions.filter(a => a.kind === 'delete_guard').map(a => a.pk).sort();

describe('key prefixes', () => {
    test('match the store key builders (the scan filter depends on them)', () => {
        expect(opKey(keyOf(1)).pk.startsWith(OPERATION_PK_PREFIX)).toBe(true);
        expect(guardKey({ accountId: ACCOUNT, mailboxId: MAILBOX, uid: 1 }).pk.startsWith(GUARD_PK_PREFIX)).toBe(true);
        expect(opKey(keyOf(1)).pk).toBe(`wildduck-mcp#mail-operation#${ACCOUNT}#${HASH}#${opId(1)}`);
    });
});

describe('item readers', () => {
    test('read the stored operation_id receipt spelling with the store reader', () => {
        const parsed = parseOperationItem(must(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'settled', receipt: receipts.queued(1), guard: 'queued' })[0]));
        expect(parsed?.record).toMatchObject({ state: 'settled', receipt: { status: 'queued', operationId: opId(1) } });
        expect(parsed?.expiresAt).toBeUndefined();
    });
    test('reject a key that does not match the stored record, and malformed items', () => {
        const [first, second] = pair({ n: 1, tool: 'send_draft', uid: 1, state: 'settled', receipt: receipts.queued(1), guard: 'queued' });
        const op = must(first); const guard = must(second);
        expect(parseOperationItem({ ...op, pk: opKey(keyOf(2)).pk })).toBeUndefined();
        expect(parseGuardItem({ ...guard, pk: guardPk(2) })).toBeUndefined();
        expect(parseGuardItem({ ...guard, extra: 1 })).toBeUndefined();
        expect(parseOperationItem({ ...op, sk: 'OTHER' })).toBeUndefined();
        expect(parseGuardItem({ ...guard, expiresAt: 'soon' })).toBeUndefined();
    });
});

describe('planCleanup on production-shaped data', () => {
    const plan = plansFor([...production(), ...nonMail]);
    test('deletes all 76 old guards and gives all 140 operations an expiry', () => {
        expect(plan.scanned).toEqual({ operations: 140, guards: 76, ignored: 4, unreadable: 0 });
        expect(plan.guardDecisions).toMatchObject({ delete_finished_hold: 72, delete_unknown_outcome_old: 4, delete_owner_missing: 0, keep_held_update_draft: 0 });
        expect(plan.operationsWithoutExpiry).toBe(140);
        expect(plan.actions.filter(a => a.kind === 'delete_guard')).toHaveLength(76);
        expect(plan.actions.filter(a => a.kind === 'set_expiry')).toHaveLength(140);
        expect(plan.actions).toHaveLength(216);
    });
    test('counts planned writes per tool', () => {
        // Each guard delete and each operation expiry counts under the owning tool.
        expect(plan.byTool).toEqual({ delete_draft: 30, move_message: 38, update_draft: 30, send_draft: 54, create_draft: 64 });
    });
    test('every action is an expiry in the ttl window or a conditional delete of the scanned value', () => {
        for (const action of plan.actions) {
            if (action.kind === 'set_expiry') { expect(action.expiresAt).toBe(EXPIRES); }
            else { expect(action.before).toBeDefined(); expect(action.decision.startsWith('delete_')).toBe(true); }
        }
    });
    test('never targets a key outside the two mail prefixes', () => {
        for (const action of plan.actions) { expect(action.pk.startsWith(OPERATION_PK_PREFIX) || action.pk.startsWith(GUARD_PK_PREFIX)).toBe(true); }
    });
});

describe('planCleanup decisions', () => {
    const plan = plansFor(edgeCases());
    test('one decision per case', () => {
        expect(plan.guardDecisions).toEqual({
            delete_owner_missing: 1,
            delete_finished_hold: 1,
            delete_unknown_outcome_old: 1,
            keep_held_update_draft: 1,
            leave_send_draft_unknown: 1,
            leave_in_flight: 0,
            leave_owner_unreadable: 1,
            leave_owner_mismatch: 1,
            leave_current_version: 5,
        });
        expect(deletesOf(plan)).toEqual([guardPk(4), guardPk(7), guardPk(10)].sort());
    });
    test('the held update_draft keeps its guard and gets an expiry on guard and operation', () => {
        expect(plan.actions).toContainEqual({ kind: 'set_expiry', pk: guardPk(1), item: 'guard', expiresAt: EXPIRES, tool: 'update_draft' });
        expect(plan.actions).toContainEqual({ kind: 'set_expiry', pk: opKey(keyOf(1)).pk, item: 'operation', expiresAt: EXPIRES, tool: 'update_draft' });
        expect(deletesOf(plan)).not.toContain(guardPk(1));
        expect(deletesOf(plan)).not.toContain(guardPk(2));
    });
    test('the orphan is deleted and remembers which owner to re-check', () => {
        expect(plan.actions.find(a => a.pk === guardPk(4))).toMatchObject({ kind: 'delete_guard', decision: 'delete_owner_missing', ownerPk: opKey(keyOf(4)).pk, tool: '(owner missing)' });
    });
    test('a guard or operation that has expiresAt (current version) is never written, whatever state it is in', () => {
        for (const uid of [2, 3, 5, 6, 12]) { expect(plan.actions.filter(a => a.pk === guardPk(uid))).toEqual([]); }
        for (const n of [2, 3, 5, 6, 7, 8, 9, 10, 12]) { expect(plan.actions.filter(a => a.pk === opKey(keyOf(n)).pk)).toEqual([]); }
    });
    test('a legacy send_draft with an unknown outcome is left in place and given an expiry; a legacy guard that disagrees with its owner is only given an expiry', () => {
        expect(plan.actions.filter(a => a.pk === guardPk(8))).toEqual([{ kind: 'set_expiry', pk: guardPk(8), item: 'guard', expiresAt: EXPIRES, tool: 'send_draft' }]);
        expect(plan.actions.filter(a => a.pk === guardPk(13)).map(a => a.kind)).toEqual(['set_expiry']);
        expect(plan.actions.filter(a => a.pk === guardPk(11)).map(a => a.kind)).toEqual(['set_expiry']);
    });
    test('an old dispatched move without reservedAt is deleted; its operation already has expiresAt', () => {
        expect(plan.actions.find(a => a.pk === guardPk(7))).toMatchObject({ kind: 'delete_guard', decision: 'delete_unknown_outcome_old', tool: 'move_message' });
    });
    test('scan counts', () => { expect(plan.scanned).toEqual({ operations: 11, guards: 12, ignored: 4, unreadable: 1 }); });
    test('unreadable items are counted and never written', () => {
        expect(plan.scanned.unreadable).toBe(1);
        expect(plan.unreadablePks).toEqual([opKey(keyOf(11)).pk]);
        expect(plan.actions.some(a => a.pk === opKey(keyOf(11)).pk)).toBe(false);
    });
    test('non-mail items are ignored', () => {
        expect(plan.scanned.ignored).toBe(4);
        for (const item of nonMail) { expect(plan.actions.some(a => a.pk === item.pk)).toBe(false); }
    });
    test('a table that already has expiresAt everywhere plans nothing at all, deletes included', () => {
        const done = production().map(item => ({ ...item, expiresAt: EXPIRES }));
        const planned = plansFor(done);
        expect(planned.actions).toEqual([]);
        expect(planned.guardDecisions.leave_current_version).toBe(76);
    });
    test('decideGuard follows the table for each guard state', () => {
        const guard = (state: GuardState): DraftGuardRecord => ({ key: { accountId: ACCOUNT, mailboxId: MAILBOX, uid: 1 }, operation: keyOf(1), ownerToken: OWNER_TOKEN, revision: 1, state });
        const owner = (tool: Tool, extra: Partial<MailOperationRecord> = {}) => ({ key: keyOf(1), ownerToken: OWNER_TOKEN, revision: 1, intent: { ...keyOf(1), tool, payloadDigest: DIGEST, target: { mailboxId: MAILBOX, uid: 1 }, expectedVersion: DIGEST }, state: 'dispatched', ...extra }) as MailOperationRecord;
        expect(decideGuard(guard('retired'), undefined)).toBe('delete_owner_missing');
        expect(decideGuard(guard('reserved'), undefined)).toBe('delete_owner_missing');
        expect(decideGuard(guard('queued'), owner('send_draft'))).toBe('delete_finished_hold');
        expect(decideGuard(guard('retired'), owner('move_message'))).toBe('delete_finished_hold');
        expect(decideGuard(guard('outcome_unknown'), owner('move_message'))).toBe('delete_unknown_outcome_old');
        expect(decideGuard(guard('dispatched'), owner('update_message_flags'))).toBe('delete_unknown_outcome_old');
        expect(decideGuard(guard('dispatched'), owner('move_message', { reservedAt: NOW }))).toBe('leave_in_flight');
        expect(decideGuard(guard('outcome_unknown'), owner('send_draft'))).toBe('leave_send_draft_unknown');
        expect(decideGuard(guard('dispatched'), owner('send_draft'))).toBe('leave_send_draft_unknown');
        expect(decideGuard(guard('dispatched'), owner('send_draft', { reservedAt: NOW }))).toBe('leave_in_flight');
        expect(decideGuard(guard('reserved'), owner('move_message'))).toBe('leave_in_flight');
    });
    test('decideGuard leaves a guard whose ownerToken or revision differs from its owner', () => {
        const guard = (extra: Partial<DraftGuardRecord>): DraftGuardRecord => ({ key: { accountId: ACCOUNT, mailboxId: MAILBOX, uid: 1 }, operation: keyOf(1), ownerToken: OWNER_TOKEN, revision: 1, state: 'retired', ...extra });
        const owner = { key: keyOf(1), ownerToken: OWNER_TOKEN, revision: 1, intent: { ...keyOf(1), tool: 'delete_draft', payloadDigest: DIGEST, target: { mailboxId: MAILBOX, uid: 1 }, expectedVersion: DIGEST }, state: 'dispatched' } as MailOperationRecord;
        expect(decideGuard(guard({}), owner)).toBe('delete_finished_hold');
        expect(decideGuard(guard({ revision: 2 }), owner)).toBe('leave_owner_mismatch');
        expect(decideGuard(guard({ ownerToken: 'other-token-'.padEnd(43, 'b') }), owner)).toBe('leave_owner_mismatch');
    });
});

// ------------------------------------------------------------------ in-memory fake of the three AWS calls

class FakeLedger implements LedgerClient {
    readonly table = new Map<string, RawItem>();
    readonly calls: string[] = [];
    /** Throttle errors thrown by the next N calls of a kind, before anything is applied. */
    readonly throttles: Record<'scan' | 'get' | 'set' | 'delete', number> = { scan: 0, get: 0, set: 0, delete: 0 };
    /** Runs just before a write is evaluated (a concurrent change). */
    beforeWrite: ((kind: 'set' | 'delete', pk: string) => void) | undefined;
    /** Runs after each scan page has been read, with the page number (1-based): a change between two pages. */
    afterScanPage: ((page: number) => void) | undefined;
    /** Scan order: operation items before guard items (DynamoDB's real order is by hashed key, so either can come first). */
    operationsFirst = false;
    private pagesRead = 0;
    constructor(items: readonly RawItem[]) { for (const item of items) { this.table.set(String(item.pk), structuredClone(item)); } }
    private compare = (a: string, b: string): number => {
        const rank = (k: string) => this.operationsFirst && k.startsWith(OPERATION_PK_PREFIX) ? 0 : 1;
        return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
    };
    private throttle(kind: keyof FakeLedger['throttles']): void {
        if (this.throttles[kind] > 0) { this.throttles[kind] -= 1; throw Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' }); }
    }
    async scanPage(startKey: RawItem | undefined, limit: number): Promise<ScanPage> {
        this.throttle('scan'); this.calls.push('scan');
        const keys = [...this.table.keys()].sort(this.compare);
        const from = startKey === undefined ? 0 : keys.findIndex(k => this.compare(k, String(startKey.pk)) > 0);
        const slice = from < 0 ? [] : keys.slice(from, from + limit);
        const last = slice.at(-1);
        const more = last !== undefined && keys.indexOf(last) < keys.length - 1;
        const items = slice.filter(k => k.startsWith(OPERATION_PK_PREFIX) || k.startsWith(GUARD_PK_PREFIX)).map(k => structuredClone(must(this.table.get(k))));
        this.pagesRead += 1;
        this.afterScanPage?.(this.pagesRead);
        return { items, lastKey: more && last !== undefined ? { pk: last, sk: 'STATE' } : undefined };
    }
    async getItem(key: ItemKey): Promise<RawItem | undefined> {
        this.throttle('get'); this.calls.push(`get ${key.pk}`);
        const item = this.table.get(key.pk);
        return item === undefined ? undefined : structuredClone(item);
    }
    async setExpiresAt(key: ItemKey, expiresAt: number): Promise<WriteOutcome> {
        this.throttle('set'); this.calls.push(`set ${key.pk}`);
        this.beforeWrite?.('set', key.pk);
        const item = this.table.get(key.pk);
        if (!item || item.expiresAt !== undefined) { return 'condition_failed'; }
        item.expiresAt = expiresAt;
        return 'applied';
    }
    async deleteGuard(key: ItemKey, before: unknown): Promise<WriteOutcome> {
        this.throttle('delete'); this.calls.push(`delete ${key.pk}`);
        this.beforeWrite?.('delete', key.pk);
        const item = this.table.get(key.pk);
        if (!item || !isDeepStrictEqual(item.record, before)) { return 'condition_failed'; }
        this.table.delete(key.pk);
        return 'applied';
    }
    get writes(): string[] { return this.calls.filter(c => c.startsWith('set ') || c.startsWith('delete ')); }
    items(): RawItem[] { return [...this.table.values()].map(i => structuredClone(i)); }
}

function pacing(): Pacing & { sleeps: number[] } {
    const sleeps: number[] = [];
    return { sleeps, sleep: async (ms) => { sleeps.push(ms); }, pageSize: 25, pageDelayMs: 1000, writeDelayMs: 1000, maxAttempts: 4, retryBaseMs: 1000 };
}

function run(args: string[], client: FakeLedger, pace = pacing()) {
    const out: string[] = []; const err: string[] = [];
    const made: { table: string; region: string }[] = [];
    const deps: CliDeps = { makeClient: (options) => { made.push(options); return client; }, nowMs: () => NOW * 1000, pacing: pace };
    return runLedger(args, { stdout: v => { out.push(v); }, stderr: v => { err.push(v); } }, deps).then(code => ({ code, out: out.join(''), err: err.join(''), made, pace }));
}

describe('applyPlan', () => {
    test('applies every planned write, pacing about one per second, and touches nothing else', async () => {
        const fake = new FakeLedger([...edgeCases()]);
        const before = fake.items();
        const pace = pacing();
        const plan = plansFor(fake.items());
        const result = await applyPlan(fake, plan, pace);
        expect(result).toMatchObject({ applied: plan.actions.length, skipped: 0, error: undefined });
        // Each of the three guard deletes costs one verification read of its owner, paced the same way.
        expect(pace.sleeps.filter(ms => ms === 1000)).toHaveLength(plan.actions.length + 3);
        const after = new Map(fake.items().map(i => [String(i.pk), i]));
        for (const item of nonMail) { expect(after.get(String(item.pk))).toEqual(item); }
        expect(after.has(guardPk(4))).toBe(false); expect(after.has(guardPk(7))).toBe(false); expect(after.has(guardPk(10))).toBe(false);
        expect(after.get(guardPk(1))?.expiresAt).toBe(EXPIRES);
        // UpdateItem leaves the record map alone, so the store's whole-map conditions still match.
        for (const item of before) { const now = after.get(String(item.pk)); if (now) { expect(now.record).toEqual(item.record); } }
    });
    test('is idempotent: applying the plan and planning again yields no actions', async () => {
        // Without the unreadable pair (case 11), which no run can fix.
        const fake = new FakeLedger([...production(), ...nonMail, ...edgeCases().filter(i => !String(i.pk).endsWith(opId(11)) && i.pk !== guardPk(11))]);
        const first = plansFor(fake.items());
        expect(first.actions.length).toBeGreaterThan(200);
        const result = await applyPlan(fake, first, pacing());
        expect(result.error).toBeUndefined();
        expect(plansFor(fake.items()).actions).toEqual([]);
    });
    test('a throttled write succeeds on retry, with doubling backoff', async () => {
        const fake = new FakeLedger(pair({ n: 1, tool: 'create_draft', uid: 1, state: 'settled', receipt: receipts.created(1, 1) }));
        fake.throttles.set = 2;
        const pace = pacing();
        const result = await applyPlan(fake, plansFor(fake.items()), pace);
        expect(result).toMatchObject({ applied: 1, skipped: 0, error: undefined });
        expect(pace.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    });
    test('a throttle that never clears stops the run with the error and leaves the rest unwritten', async () => {
        const fake = new FakeLedger([...pair({ n: 1, tool: 'create_draft', uid: 1, state: 'settled', receipt: receipts.created(1, 1) }), ...pair({ n: 2, tool: 'create_draft', uid: 2, state: 'settled', receipt: receipts.created(2, 2) })]);
        fake.throttles.set = 100;
        const result = await applyPlan(fake, plansFor(fake.items()), pacing());
        expect(result.applied).toBe(0);
        expect(result.error).toMatchObject({ name: 'ProvisionedThroughputExceededException' });
        // Stopped at the first item: the throttle fired maxAttempts (4) times, 100 - 4 remain, and nothing was applied.
        expect(fake.throttles.set).toBe(96);
        expect(fake.writes).toEqual([]);
    });
    test('a conditional delete that fails is skipped, not an error, and the guard stays', async () => {
        const fake = new FakeLedger(pair({ n: 1, tool: 'delete_draft', uid: 1, state: 'settled', receipt: receipts.deleted(1, 1), guard: 'retired', opExpires: EXPIRES }));
        const plan = plansFor(fake.items());
        fake.beforeWrite = (kind, pk) => { if (kind === 'delete') { (must(fake.table.get(pk)).record as { revision: number }).revision += 1; } };
        const result = await applyPlan(fake, plan, pacing());
        expect(result).toMatchObject({ applied: 0, skipped: 1, error: undefined, skippedPks: [guardPk(1)] });
        expect(fake.table.has(guardPk(1))).toBe(true);
    });
    test('an orphan whose owner appeared after the scan is not deleted', async () => {
        const fake = new FakeLedger(edgeCases().filter(i => i.pk === guardPk(4)));
        const plan = plansFor(fake.items());
        fake.table.set(opKey(keyOf(4)).pk, pair({ n: 4, tool: 'move_message', uid: 4, state: 'reserved', reservedAt: NOW, opExpires: EXPIRES })[0] ?? {});
        const result = await applyPlan(fake, plan, pacing());
        expect(result).toMatchObject({ applied: 0, skipped: 1 });
        expect(fake.calls.some(c => c.startsWith('delete '))).toBe(false);
    });
    // A finished hold as the scan saw it: legacy owner (update_draft, completed) and its retired guard.
    const finished = () => pair({ n: 1, tool: 'update_draft', uid: 1, state: 'settled', receipt: receipts.updated(1, 1), guard: 'retired' });
    const heldNow = (): RawItem[] => pair({ n: 1, tool: 'update_draft', uid: 1, state: 'settled', receipt: receipts.heldPartial(1, 1), guard: 'retired' });
    test('EVERY guard delete re-reads the owner and classifies again: a hold that became real after the scan is not deleted', async () => {
        const fake = new FakeLedger(finished());
        const plan = plansFor(fake.items());
        expect(deletesOf(plan)).toEqual([guardPk(1)]);
        // The owner settled as a held partial after its page was read; same token and revision, so only the fresh classification can catch it.
        for (const item of heldNow()) { fake.table.set(String(item.pk), item); }
        const result = await applyPlan(fake, plan, pacing());
        expect(result).toMatchObject({ appliedDeletes: 0, skipped: 1, skippedPks: [guardPk(1)] });
        expect(fake.calls).toContain(`get ${opKey(keyOf(1)).pk}`);
        expect(fake.calls.some(c => c.startsWith('delete '))).toBe(false);
        expect(fake.table.has(guardPk(1))).toBe(true);
    });
    test('a guard delete is skipped unless the guard and the fresh owner carry the same ownerToken and revision', async () => {
        for (const change of [{ revision: 3 }, { ownerToken: 'other-token-'.padEnd(43, 'b') }]) {
            const fake = new FakeLedger(finished());
            const plan = plansFor(fake.items());
            const opItem = must(fake.table.get(opKey(keyOf(1)).pk));
            opItem.record = { ...(opItem.record as Record<string, unknown>), ...change };
            const result = await applyPlan(fake, plan, pacing());
            expect({ change, ...result }).toMatchObject({ change, appliedDeletes: 0, skipped: 1 });
            expect(fake.table.has(guardPk(1))).toBe(true);
        }
    });
    test('scan pages that straddle a settlement never delete the live guard (guard rev 3 read with an owner snapshot at rev 2)', async () => {
        // update_draft is dispatched when the owner page is read; its write then settles as a held partial and the guard becomes retired (a real hold).
        for (const withExpiry of [true, false]) {
            const dispatched = pair({ n: 1, tool: 'update_draft', uid: 1, state: 'dispatched', guard: 'dispatched' });
            const fake = new FakeLedger(dispatched);
            fake.operationsFirst = true;
            const pace = pacing(); pace.pageSize = 1;
            fake.afterScanPage = (page) => {
                if (page !== 1) { return; }
                const settled = heldNow().map((item): RawItem => ({ ...item, record: { ...(item.record as Record<string, unknown>), revision: 3 }, ...(withExpiry ? { expiresAt: EXPIRES } : {}) }));
                for (const item of settled) { fake.table.set(String(item.pk), item); }
            };
            const { code, out } = await run(['cleanup', '--apply'], fake, pace);
            expect({ withExpiry, code }).toEqual({ withExpiry, code: 0 });
            expect(fake.calls.filter(c => c === 'scan')).toHaveLength(2);
            expect(fake.calls.some(c => c.startsWith('delete '))).toBe(false);
            expect(fake.table.has(guardPk(1))).toBe(true);
            expect(out).toContain(withExpiry ? 'current version' : 'disagree');
        }
    });
    test('the delete re-checks a pair the planner paired from a stale owner (the failing sequence, applied directly)', async () => {
        // Hand-made plan: stale owner snapshot dispatched (no reservedAt, so "old unknown outcome") paired with the later-read retired guard.
        const guard = must(parseGuardItem(must(heldNow()[1]))).record;
        const action: PlannedDelete = { kind: 'delete_guard', pk: guardPk(1), before: guard, guard, decision: 'delete_finished_hold', tool: 'update_draft', ownerPk: opKey(keyOf(1)).pk };
        const fake = new FakeLedger(heldNow());
        const result = await applyPlan(fake, { actions: [action], scanned: { operations: 1, guards: 1, ignored: 0, unreadable: 0 }, guardDecisions: plansFor([]).guardDecisions, operationsWithoutExpiry: 0, operationsWithExpiry: 0, byTool: {}, unreadablePks: [] }, pacing());
        expect(result).toMatchObject({ appliedDeletes: 0, skipped: 1 });
        expect(fake.table.has(guardPk(1))).toBe(true);
        expect(stillDeletable(action, fake.table.get(opKey(keyOf(1)).pk))).toBe(false);
        expect(stillDeletable(action, undefined)).toBe(false);
    });
    test('a current-version retired guard of a held partial is neither planned nor written, even when the owner is stale', async () => {
        const items = pair({ n: 1, tool: 'update_draft', uid: 1, state: 'settled', receipt: receipts.heldPartial(1, 1), guard: 'retired', opExpires: EXPIRES, guardExpires: EXPIRES });
        const fake = new FakeLedger(items);
        expect(plansFor(fake.items()).actions).toEqual([]);
        // Even the guard alone, with its owner not scanned at all, is not an orphan to delete: it has expiresAt.
        const guardOnly = new FakeLedger(items.filter(i => String(i.pk).startsWith(GUARD_PK_PREFIX)));
        const { code, out } = await run(['cleanup', '--apply'], guardOnly);
        expect(code).toBe(0);
        expect(guardOnly.writes).toEqual([]);
        expect(guardOnly.calls.every(c => c === 'scan')).toBe(true);
        expect(out).toContain('current version');
        expect(out).toContain('Nothing to do.');
    });
    test('an expiry update never creates an item that vanished after the scan', async () => {
        const fake = new FakeLedger(pair({ n: 1, tool: 'create_draft', uid: 1, state: 'settled', receipt: receipts.created(1, 1) }));
        const plan = plansFor(fake.items());
        fake.table.clear();
        const result = await applyPlan(fake, plan, pacing());
        expect(result).toMatchObject({ applied: 0, skipped: 1 });
        expect(fake.table.size).toBe(0);
    });
});

describe('cleanup command', () => {
    test('dry run writes nothing, prints counts only, and pages the scan with pauses', async () => {
        const fake = new FakeLedger([...production(), ...nonMail]);
        const { code, out, pace } = await run(['cleanup'], fake);
        expect(code).toBe(0);
        expect(fake.writes).toEqual([]);
        expect(out).toContain('DRY RUN');
        expect(out).toContain('Writes planned: 216 (76 guard deletes, 140 expiresAt updates)');
        expect(out).toContain('Dry run only. Re-run with --apply');
        expect(out).not.toContain('wildduck-mcp#mail-');
        expect(fake.calls.filter(c => c === 'scan').length).toBeGreaterThan(1);
        expect(pace.sleeps.filter(ms => ms === 1000)).toHaveLength(fake.calls.filter(c => c === 'scan').length - 1);
    });
    test('the default run issues no write call of any kind: only scans, and no verification reads either', async () => {
        for (const items of [[...production(), ...nonMail], edgeCases()]) {
            const fake = new FakeLedger(items);
            const before = fake.items();
            const { out } = await run(['cleanup'], fake);
            expect(fake.calls.length).toBeGreaterThan(0);
            expect(fake.calls.every(c => c === 'scan')).toBe(true);
            expect(fake.items()).toEqual(before);
            expect(out).toContain('DRY RUN, nothing is written');
            // Not even --verbose writes.
            const verbose = await run(['cleanup', '--verbose'], fake);
            expect(verbose.code).toBeLessThanOrEqual(1);
            expect(fake.calls.every(c => c === 'scan')).toBe(true);
        }
    });
    test('the dry run says a legacy uncertain send is never checked and expires after 90 days', async () => {
        const { out } = await run(['cleanup'], new FakeLedger(edgeCases()));
        expect(out).toContain('send_draft with unknown outcome and no reservedAt (the server never checks it; it expires after 90 days)');
    });
    test('after an applied run the dry run is empty: only legacy rows are ever planned, and they now have expiresAt', async () => {
        const fake = new FakeLedger([...production(), ...nonMail, ...edgeCases().filter(i => !String(i.pk).endsWith(opId(11)) && i.pk !== guardPk(11))]);
        expect((await run(['cleanup', '--apply'], fake)).code).toBe(0);
        const writes = fake.writes.length;
        const again = await run(['cleanup'], fake);
        expect(again.out).toContain('Writes planned: 0');
        expect(again.out).toContain('Nothing to do.');
        expect(plansFor(fake.items()).actions).toEqual([]);
        expect(fake.writes).toHaveLength(writes);
        // The leftover guards that stay (real hold, legacy send, mismatched pair) now carry expiresAt.
        for (const uid of [1, 8, 13]) { expect(fake.table.get(guardPk(uid))?.expiresAt).toBe(EXPIRES); }
    });
    test('--apply performs the writes and a second run plans none', async () => {
        const fake = new FakeLedger([...production(), ...nonMail]);
        const first = await run(['cleanup', '--apply'], fake);
        expect(first.code).toBe(0);
        expect(first.out).toContain('Applied 216 writes (76 deletes, 140 expiresAt updates); skipped 0');
        const second = await run(['cleanup', '--apply'], fake);
        expect(second.code).toBe(0);
        expect(second.out).toContain('Writes planned: 0');
        expect(second.out).toContain('Nothing to do.');
        expect(fake.writes).toHaveLength(216);
    });
    test('output never contains ownerToken or payloadDigest, even with --verbose; keys only with --verbose', async () => {
        const plain = await run(['cleanup'], new FakeLedger(edgeCases()));
        const verbose = await run(['cleanup', '--verbose'], new FakeLedger(edgeCases()));
        expect(plain.out).not.toContain('wildduck-mcp#mail-');
        expect(verbose.out).toContain(`delete ${guardPk(4)}`);
        for (const text of [plain.out, verbose.out, plain.err, verbose.err]) { expect(text).not.toContain(OWNER_TOKEN); expect(text).not.toContain(DIGEST); expect(text).not.toContain('payloadDigest'); }
    });
    test('unreadable items give a non-zero exit and are never written', async () => {
        const fake = new FakeLedger(edgeCases());
        const { code, out } = await run(['cleanup', '--apply'], fake);
        expect(code).toBe(1);
        expect(out).toContain('1 items are not in a readable format');
        expect(fake.writes.some(w => w.includes(`#${HASH}#${opId(11)}`))).toBe(false);
    });
    test('a write that keeps being throttled exits non-zero and says to re-run', async () => {
        const fake = new FakeLedger(pair({ n: 1, tool: 'create_draft', uid: 1, state: 'settled', receipt: receipts.created(1, 1) }));
        fake.throttles.set = 100;
        const { code, err } = await run(['cleanup', '--apply'], fake);
        expect(code).toBe(1);
        expect(err).toContain('ProvisionedThroughputExceededException');
        expect(err).toContain('safe to repeat');
    });
    test('defaults to the production table and region; flags override', async () => {
        const fake = new FakeLedger([]);
        expect((await run(['cleanup'], fake)).made).toEqual([{ table: 'wildduck-mcp-prod-state', region: 'us-west-2' }]);
        expect((await run(['cleanup', '--table', 'other-table', '--region', 'eu-west-1'], fake)).made).toEqual([{ table: 'other-table', region: 'eu-west-1' }]);
    });
});

describe('usage', () => {
    test('bad commands and mismatched flags exit 2 with usage and never build a client', async () => {
        for (const args of [[], ['nope'], ['show', 'a', 'b'], ['cleanup', 'x'], ['show', ACCOUNT, MAILBOX, '1', '--apply'], ['cleanup', '--yes'], ['show', ACCOUNT, MAILBOX, '1', '--verbose'], ['cleanup', '--bogus'], ['show', 'bad id', MAILBOX, '1'], ['show', ACCOUNT, MAILBOX, 'x'], ['cleanup', '--table', 'x'],
        ['release', ACCOUNT, MAILBOX, '1'], ['release', ACCOUNT, MAILBOX, '1', '--yes'], ['show', ACCOUNT, MAILBOX, '1', '--yes']]) {
            const result = await run(args, new FakeLedger([]));
            expect({ args, code: result.code }).toEqual({ args, code: 2 });
            expect(result.err).toContain('Usage: bun scripts/mail-ledger.ts');
        }
    });
    test('--help exits 0', async () => { expect((await run(['--help'], new FakeLedger([]))).code).toBe(0); });
    test('there is no command that deletes a single lock: no release command and no --yes flag anywhere in the usage', () => {
        expect(USAGE).not.toMatch(/release|--yes/u);
        expect(USAGE).toContain('show <accountId> <mailboxId> <uid>');
    });
});

describe('show', () => {
    const target = (uid: number) => [ACCOUNT, MAILBOX, String(uid)];
    test('reads exactly the guard and its owner, prints readable dates and a plain-English line, and does not scan', async () => {
        const fake = new FakeLedger(edgeCases());
        const { code, out } = await run(['show', ...target(1)], fake);
        expect(code).toBe(0);
        expect(fake.calls).toEqual([`get ${guardPk(1)}`, `get ${opKey(keyOf(1)).pk}`]);
        expect(out).toContain('state retired');
        expect(out).toContain('tool update_draft, state settled, receipt partial (original_deletion_failed)');
        expect(out).toContain('reservedAt none');
        expect(out).toContain('meaning: update_draft finished halfway');
        expect(out).not.toContain(OWNER_TOKEN);
    });
    test('prints dates for a reserved pair', async () => {
        const { out } = await run(['show', ...target(5)], new FakeLedger(edgeCases()));
        expect(out).toContain(`reservedAt ${new Date((NOW - 30) * 1000).toISOString()}`);
        expect(out).toContain(`expiresAt ${new Date(EXPIRES * 1000).toISOString()}`);
        expect(out).toContain('meaning: A write is in progress');
    });
    test('says so when nothing holds the message, and when the owner is missing', async () => {
        expect((await run(['show', ...target(99)], new FakeLedger([]))).out).toContain('No lock on this message');
        expect((await run(['show', ...target(4)], new FakeLedger(edgeCases()))).out).toContain('abandoned');
    });
});

describe('show uses the server rule table (holdAction), not a copy', () => {
    const target = (uid: number) => [ACCOUNT, MAILBOX, String(uid)];
    const owner = (tool: Tool, state: 'reserved' | 'dispatched' | 'settled', extra: Partial<PairSpec> = {}) => must(parseOperationItem(must(pair({ n: 1, tool, uid: 1, state, ...extra })[0]))).record;
    const NOW_MS = NOW * 1000;
    const meaning = async (items: RawItem[]) => (await run(['show', ...target(1)], new FakeLedger(items))).out.split('\n').find(line => line.startsWith('meaning: ')) ?? '';

    /** Every action holdAction can return, as samples. A Record keyed by HoldAction['act'] stops compiling when the server adds an action. */
    const SAMPLES: Record<HoldAction['act'], readonly HoldAction[]> = {
        none: [{ act: 'none' }],
        fail: [{ act: 'fail', from: 'reserved' }],
        release: [{ act: 'release', from: 'dispatched' }, { act: 'release', from: 'unknown' }, { act: 'release', from: 'expired' }, { act: 'release', from: 'leftover' }],
        check_send: [{ act: 'check_send', from: 'dispatched' }, { act: 'check_send', from: 'unknown' }],
        keep_original: [{ act: 'keep_original', from: 'partial' }],
    };
    const owners = [undefined, owner('move_message', 'dispatched', { reservedAt: NOW - 60 }), owner('move_message', 'reserved', { reservedAt: NOW - 60 }), owner('send_draft', 'dispatched', { reservedAt: NOW - 60 }), owner('send_draft', 'dispatched')];

    test('describes every action holdAction can return, for every kind of owner, in one plain line', () => {
        for (const samples of Object.values(SAMPLES)) {
            for (const action of samples) {
                for (const record of owners) {
                    const text = describeHold(action, record, NOW_MS);
                    expect({ action, text }).toEqual({ action, text: expect.stringMatching(/^\S.*\.$/u) });
                    expect(text).not.toMatch(/undefined|\[object|\n/u);
                }
            }
        }
    });
    test('different actions are described differently (no action falls into a shared default)', () => {
        const record = owner('move_message', 'dispatched', { reservedAt: NOW - 60 });
        const lines = [{ act: 'none' }, { act: 'fail', from: 'reserved' }, { act: 'release', from: 'dispatched' }, { act: 'release', from: 'expired' }, { act: 'release', from: 'leftover' }, { act: 'check_send', from: 'unknown' }, { act: 'keep_original', from: 'partial' }]
            .map(action => describeHold(action as HoldAction, record, NOW_MS));
        expect(new Set(lines).size).toBe(lines.length);
    });
    test('every action is reachable from real owners, and the description is the one for the action holdAction returns', () => {
        const seen = new Set<string>();
        const fixtures: (MailOperationRecord | undefined)[] = [undefined];
        // Not every combination is a valid record (the store's reader rejects some); the valid ones are what a server can meet.
        const add = (tool: Tool, state: 'reserved' | 'dispatched' | 'settled', extra: Partial<PairSpec>) => {
            const parsed = parseOperationItem(must(pair({ n: 1, tool, uid: 1, state, ...extra })[0]));
            if (parsed) { fixtures.push(parsed.record); }
        };
        for (const tool of ['move_message', 'send_draft', 'update_draft'] as const) {
            for (const reservedAt of [undefined, NOW - 10, NOW - HOLD_AGED_MS / 1000 - 1, NOW - SEND_CHECK_AGED_MS / 1000 - 1]) {
                const extra = reservedAt === undefined ? {} : { reservedAt };
                add(tool, 'reserved', extra); add(tool, 'dispatched', extra);
                add(tool, 'settled', { ...extra, receipt: receipts.unknown(1) }); add(tool, 'settled', { ...extra, receipt: receipts.queued(1) }); add(tool, 'settled', { ...extra, receipt: receipts.moved(1, 1) });
            }
        }
        add('update_draft', 'settled', { receipt: receipts.heldPartial(1, 1) });
        expect(fixtures.length).toBeGreaterThan(20);
        for (const record of fixtures) {
            const action = holdAction(record, NOW_MS);
            seen.add(action.act);
            expect(explainHold(record, NOW_MS)).toBe(describeHold(action, record, NOW_MS));
        }
        expect([...seen].sort()).toEqual(Object.keys(SAMPLES).sort());
    });
    test('a reservation of ANY tool is abandoned after 5 minutes: a reserved send says 5, not 15', async () => {
        const young = await meaning(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'reserved', guard: 'reserved', reservedAt: NOW - 60 }));
        expect(young).toContain('until it is 5 minutes old');
        expect(young).not.toContain('15 minutes');
        const aged = await meaning(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'reserved', guard: 'reserved', reservedAt: NOW - 600 }));
        expect(aged).toContain('settles it as failed');
    });
    test('an uncertain send with a reservedAt waits 15 minutes, then the server looks in WildDuck', async () => {
        const waiting = await meaning(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'dispatched', guard: 'dispatched', reservedAt: NOW - 600 }));
        expect(waiting).toContain('until it is 15 minutes old');
        const aged = await meaning(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'dispatched', guard: 'dispatched', reservedAt: NOW - 1000 }));
        expect(aged).toContain('looks in WildDuck');
    });
    test('a legacy uncertain send (no reservedAt) is said to be never checked and to expire after 90 days', async () => {
        const text = await meaning(pair({ n: 1, tool: 'send_draft', uid: 1, state: 'settled', receipt: receipts.unknown(1), guard: 'outcome_unknown' }));
        expect(text).toContain('never checks it');
        expect(text).toContain('expires 90 days');
        expect(text).not.toContain('looks in WildDuck');
    });
    test('other tools: young is left alone for 5 minutes; aged is released and the record stays', async () => {
        expect(await meaning(pair({ n: 1, tool: 'move_message', uid: 1, state: 'dispatched', guard: 'dispatched', reservedAt: NOW - 60 }))).toContain('until it is 5 minutes old');
        expect(await meaning(pair({ n: 1, tool: 'move_message', uid: 1, state: 'dispatched', guard: 'dispatched', reservedAt: NOW - 600 }))).toContain('deletes the lock');
    });
    test('a leftover of an older release, and a held partial', async () => {
        expect(await meaning(pair({ n: 1, tool: 'delete_draft', uid: 1, state: 'settled', receipt: receipts.deleted(1, 1), guard: 'retired' }))).toContain('already ended');
        expect(await meaning(pair({ n: 1, tool: 'update_draft', uid: 1, state: 'settled', receipt: receipts.heldPartial(1, 1), guard: 'retired' }))).toContain('both copies of the draft are alive');
    });
});
