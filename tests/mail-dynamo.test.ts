import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoSender } from '../src/auth/dynamo-store';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { digest as hashOf } from '../src/auth/crypto';
import { handleMcp } from '../src/mcp';
import { DynamoMailOperationStore } from '../src/mail/dynamo-store';
import { createMailService, PREFLIGHT_RESERVE_MS, RESERVE_ADMISSION_MS } from '../src/mail/service';
import { MailError, type BoundMailService, type ConfirmedReceipt, type MailContext, type MailOperationStore, type MailService, type OperationClaim, type OperationKey, type SourceGrade, type WriteIntent } from '../src/mail/contracts';
import { DEFAULT_THROTTLE_TIMEOUT_MS, RESPONSE_RESERVE_MS } from '../src/dynamo-retry';
import { remainingRequestTimeMs, withRequestBudget } from '../src/request-budget';
import { cancelled, captureWarnings, steppedClock, throttleError, virtualRetry } from './dynamo-virtual';
let logs: Record<string, unknown>[] = [];
let restoreWarnings = () => {};
beforeEach(() => { const captured = captureWarnings(); logs = captured.lines; restoreWarnings = captured.restore; });
afterEach(() => { restoreWarnings(); });
const mailboxId = 'a'.repeat(24); const digest = 'd'.repeat(43); const owner = 'owner-token-'.padEnd(43, 'a');
const key = (operationId = 'operation-00000001', clientIdHash = 'c'.repeat(43), accountId = '1'.repeat(24)): OperationKey => ({ accountId, clientIdHash, operationId });
const intent = (operationId = 'operation-00000001', tool: Exclude<WriteIntent['tool'], 'create_draft' | 'create_reply_draft'> = 'send_draft'): Exclude<WriteIntent, { tool: 'create_draft' | 'create_reply_draft' }> => ({ ...key(operationId), tool, payloadDigest: digest, target: { mailboxId, uid: 1 }, expectedVersion: digest });
const verifiedDraft = (uid: number, targetMailbox = mailboxId) => ({ draft: { mailboxId: targetMailbox, uid, version: digest }, verified: true as const, proof: { accountId: key().accountId, mailboxId: targetMailbox, uid, version: digest, contentDigest: 'a'.repeat(64), sourceGrade: 'mcp_authored' as const } });
const verifiedMessage = (uid: number, targetMailbox = mailboxId, sourceGrade: SourceGrade = 'observed') => { const { draft, verified, proof } = verifiedDraft(uid, targetMailbox); return { message: draft, verified, proof: { ...proof, sourceGrade } }; };
const claim = async (store: MailOperationStore, value: WriteIntent): Promise<OperationClaim<'reserved'>> => { const result = await store.reserve(value, owner); expect(result.kind).toBe('acquired'); if (result.kind !== 'acquired') { throw new Error('expected acquisition'); } return result.claim; };
class ModelSender implements DynamoSender {
    readonly records = new Map<string, Record<string, unknown>>();
    readonly calls: (GetCommand | TransactWriteCommand)[] = [];
    readonly committed = new Map<string, string>();
    fault: 'none' | 'lost_once' | 'unknown_always' | 'lost_persistent' = 'none';
    beforeTransaction: (() => void) | undefined;
    /** Errors thrown by the next calls of each kind, before the command is applied (throttles, conflicts). */
    readonly failures: { get: unknown[]; transact: unknown[] } = { get: [], transact: [] };
    async send(command: GetCommand | TransactWriteCommand): Promise<unknown> {
        this.calls.push(command);
        const failure = (command instanceof GetCommand ? this.failures.get : this.failures.transact).shift();
        if (failure !== undefined) { throw failure; }
        if (command instanceof GetCommand) { return { Item: structuredClone(this.records.get(String(command.input.Key?.pk))) }; }
        if (this.fault === 'unknown_always') { throw new Error('ambiguous socket outcome'); }
        const token = String(command.input.ClientRequestToken); const payload = JSON.stringify(command.input.TransactItems);
        const prior = this.committed.get(token);
        if (prior !== undefined) { if (prior !== payload) { throw new Error('idempotency mismatch'); } if (this.fault === 'lost_persistent') { throw new Error('lost commit acknowledgement'); } return {}; }
        this.beforeTransaction?.(); this.beforeTransaction = undefined;
        const items = command.input.TransactItems ?? [];
        const reasons = items.map(item => {
            const action = item.Put ?? item.Delete;
            const pk = String(item.Put?.Item?.pk ?? item.Delete?.Key?.pk);
            const stored = this.records.get(pk);
            const passed = action?.ConditionExpression === 'attribute_not_exists(#pk)' ? !stored : isDeepStrictEqual(stored?.record, action?.ExpressionAttributeValues?.[':before']);
            return { Code: passed ? 'None' : 'ConditionalCheckFailed' };
        });
        if (reasons.some(reason => reason.Code !== 'None')) { throw { name: 'TransactionCanceledException', CancellationReasons: reasons }; }
        for (const item of items) {
            if (item.Put?.Item) { this.records.set(String(item.Put.Item.pk), structuredClone(item.Put.Item)); }
            if (item.Delete?.Key) { this.records.delete(String(item.Delete.Key.pk)); }
        }
        this.committed.set(token, payload);
        if (this.fault === 'lost_persistent') { throw new Error('committed but acknowledgement unavailable'); }
        if (this.fault === 'lost_once') { this.fault = 'none'; throw new Error('response lost after commit'); }
        return {};
    }
}
// A virtual clock: backoff waits cost no real time, and the longest jitter makes the schedule deterministic.
function fixture(timeoutMs = 5000) { const client = new ModelSender(); const virtual = virtualRetry(); return { client, virtual, store: new DynamoMailOperationStore({ tableName: 'MailTable', client, timeoutMs, retry: virtual.retry }) }; }
const throttled = (attempt: number, operation: string) => ({ event: 'dynamodb_throttled', store: 'mail', operation, attempt });
async function lifecycleMatrix(store: MailOperationStore): Promise<void> {
    const send = intent();
    const reserved = await claim(store, send);
    expect((await store.reserve(send, 'other-owner'.padEnd(43, 'b'))).kind).toBe('replay');
    expect(await store.reserve({ ...send, payloadDigest: 'e'.repeat(43) }, owner)).toEqual({ kind: 'conflict', reason: 'operation_conflict' });
    expect(await store.reserve({ ...send, ...key('operation-00000002', 'x'.repeat(43)) }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const otherAccount = { ...send, ...key('operation-00000003', 'c'.repeat(43), '2'.repeat(24)) };
    const otherClaim = await claim(store, otherAccount);
    await store.failPreflight(otherClaim, { status: 'failed', operationId: otherAccount.operationId, reason: 'version_conflict' });
    await claim(store, { ...otherAccount, operationId: 'operation-00000004' });
    const dispatched = await store.markDispatched(reserved);
    expect(dispatched.revision).toBe(1);
    await expect(store.markDispatched(reserved)).rejects.toThrow('temporarily_unavailable');
    await expect(store.complete({ ...dispatched, ownerToken: 'forged-owner'.padEnd(43, 'z') }, { status: 'queued', operationId: send.operationId, queueId: 'queue-1' })).rejects.toThrow('temporarily_unavailable');
    await store.complete(dispatched, { status: 'queued', operationId: send.operationId, queueId: 'queue-1' });
    const queued = await store.getOperation(key());
    expect(queued?.state).toBe('settled');
    if (queued?.state === 'settled') { expect(queued.receipt.status).toBe('queued'); }
    expect(await store.reserve({ ...send, operationId: 'operation-00000005' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    // A new mailbox/UID is independently writable; old targets never expire.
    const unknown = { ...intent('operation-00000006'), target: { mailboxId, uid: 2 } };
    const pending = await store.markDispatched(await claim(store, unknown));
    await store.markOutcomeUnknown(pending, { status: 'outcome_unknown', operationId: unknown.operationId, reason: 'dispatch_uncertain' });
    expect((await store.reserve(unknown, owner)).kind).toBe('replay');
    expect(await store.reserve({ ...unknown, operationId: 'operation-00000007' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const update = { ...intent('operation-00000008', 'update_draft'), target: { mailboxId, uid: 3 } };
    const updating = await store.markDispatched(await claim(store, update));
    await store.complete(updating, { status: 'partial', operationId: update.operationId, candidate: { mailboxId, uid: 4, version: digest }, candidateVerified: true, proof: verifiedDraft(4).proof, reason: 'original_deletion_failed', originalDeletion: 'failed' });
    expect(await store.reserve({ ...update, operationId: 'operation-00000009' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    await claim(store, { ...update, operationId: 'operation-00000010', target: { mailboxId, uid: 4 } });
    const create: WriteIntent = { ...key('operation-00000011'), tool: 'create_draft', payloadDigest: digest };
    const creating = await store.markDispatched(await claim(store, create));
    await store.complete(creating, { status: 'completed', operationId: create.operationId, ...verifiedDraft(5) });
}
async function expandedMatrix(store: MailOperationStore): Promise<void> {
    const flags = { ...intent('operation-flags001', 'update_message_flags'), target: { mailboxId, uid: 200 } };
    await store.complete(await store.markDispatched(await claim(store, flags)), { status: 'completed', operationId: flags.operationId, ...verifiedMessage(200) });
    const replay = await store.reserve(flags, owner);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay' && replay.record.state === 'settled') { expect(replay.record.receipt).toEqual({ status: 'completed', operationId: flags.operationId, ...verifiedMessage(200) }); }
    const move = { ...flags, operationId: 'operation-move0001', tool: 'move_message' as const };
    const destination = 'b'.repeat(24);
    await store.complete(await store.markDispatched(await claim(store, move)), { status: 'completed', operationId: move.operationId, ...verifiedMessage(201, destination) });
    expect(await store.reserve({ ...flags, operationId: 'operation-flags002' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    await claim(store, { ...flags, operationId: 'operation-flags003', target: { mailboxId: destination, uid: 201 } });
    const unknownFlags = { ...flags, operationId: 'operation-flags004', target: { mailboxId, uid: 202 } };
    await store.markOutcomeUnknown(await store.markDispatched(await claim(store, unknownFlags)), { status: 'outcome_unknown', operationId: unknownFlags.operationId, reason: 'dispatch_uncertain' });
    expect(await store.reserve({ ...unknownFlags, operationId: 'operation-flags005' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const unverified = { ...intent('operation-partial01', 'update_draft'), target: { mailboxId, uid: 203 } };
    await store.complete(await store.markDispatched(await claim(store, unverified)), { status: 'partial', operationId: unverified.operationId, candidate: { mailboxId, uid: 204 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
    expect(await store.reserve({ ...unverified, operationId: 'operation-partial02' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const stale = { ...intent('operation-partial03', 'update_draft'), target: { mailboxId, uid: 205 } };
    const receipt = { status: 'partial' as const, operationId: stale.operationId, candidate: verifiedDraft(206).draft, candidateVerified: true as const, proof: verifiedDraft(206).proof, reason: 'original_version_changed' as const, originalDeletion: 'not_attempted' as const };
    await store.complete(await store.markDispatched(await claim(store, stale)), receipt);
    const staleReplay = await store.getOperation(key(stale.operationId));
    expect(staleReplay?.state).toBe('settled'); if (staleReplay?.state === 'settled') { expect(staleReplay.receipt).toEqual(receipt); }
    expect(await store.reserve({ ...stale, operationId: 'operation-partial04' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const sending = { ...intent('operation-send-sent'), target: { mailboxId, uid: 207 } };
    const sent = { mailboxId: destination, uid: 208 };
    await store.complete(await store.markDispatched(await claim(store, sending)), { status: 'queued', operationId: sending.operationId, queueId: 'actual-queue', sent });
    const sentRecord = await store.getOperation(key(sending.operationId));
    if (sentRecord?.state === 'settled') { expect(sentRecord.receipt).toEqual({ status: 'queued', operationId: sending.operationId, queueId: 'actual-queue', sent }); } else { throw new Error('missing send receipt'); }
}
async function provenanceMatrix(store: MailOperationStore): Promise<void> {
    let uid = 300;
    for (const tool of ['move_message', 'update_message_flags'] as const) {
        for (const grade of ['observed', 'mcp_authored'] as const) {
            const operationId = `operation-provenance${uid}`;
            const value = { ...intent(operationId, tool), target: { mailboxId, uid } };
            const message = verifiedMessage(uid, tool === 'move_message' ? 'b'.repeat(24) : mailboxId, grade);
            const receipt = { status: 'completed' as const, operationId, ...message };
            await store.complete(await store.markDispatched(await claim(store, value)), receipt);
            const stored = await store.getOperation(key(operationId));
            expect(stored?.state).toBe('settled');
            if (stored?.state === 'settled') { expect(stored.receipt).toEqual(receipt); }
            const replay = await store.reserve(value, owner);
            expect(replay.kind).toBe('replay');
            if (replay.kind === 'replay' && replay.record.state === 'settled') { expect(replay.record.receipt).toEqual(receipt); }
            uid++;
        }
    }
}
describe('Dynamo mail operation adapter', () => {
    test('atomic lifecycle matrix preserves receipts, shared fences, preflight release and permanent retirement', async () => {
        const { client, store } = fixture(); await lifecycleMatrix(store); await expandedMatrix(store); await provenanceMatrix(store);
        expect(client.calls.filter(command => command instanceof GetCommand).every(command => command.input.ConsistentRead === true)).toBe(true);
        for (const [pk, record] of client.records) {
            expect(pk.startsWith('wildduck-mcp#mail-')).toBe(true); expect(record.sk).toBe('STATE');
            expect(JSON.stringify(record)).not.toMatch(/expiresAt|subject|accessToken|recipients|clientId"/u);
        }
        expect([...client.records.values()].some(value => (value.record as { state: string }).state === 'outcome_unknown')).toBe(true);
    });
    test('concurrent same intent yields one acquisition and replay; independent clients share one UID fence', async () => {
        const { store } = fixture();
        const same = await Promise.all([store.reserve(intent(), owner), store.reserve(intent(), owner)]);
        expect(same.map(result => result.kind).sort()).toEqual(['acquired', 'replay']);
        const different = { ...intent('operation-00000002'), ...key('operation-00000002', 'x'.repeat(43)) };
        expect(await store.reserve(different, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
        const { store: separate } = fixture();
        const racing = await Promise.all([separate.reserve(intent(), owner), separate.reserve(different, owner)]);
        expect(racing.map(result => result.kind).sort()).toEqual(['acquired', 'conflict']);
    });
    test('lost response retries same SDK transaction/token, exhausted ambiguity never returns a conflict', async () => {
        const { client, store } = fixture(); client.fault = 'lost_once';
        await claim(store, intent());
        const writes = client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(writes).toHaveLength(2); expect(writes[0]).toBe(writes[1]);
        expect(writes[0]?.input.ClientRequestToken).toHaveLength(36);
        const before = client.calls.length; client.fault = 'unknown_always';
        await expect(store.reserve({ ...intent('operation-00000002'), target: { mailboxId, uid: 22 } }, owner)).rejects.toThrow('temporarily_unavailable');
        expect(client.calls.slice(before).filter(command => command instanceof TransactWriteCommand)).toHaveLength(3);
    });
    test('CAS checks complete observed operation and guard; no partial transition or unowned guard release', async () => {
        const { client, store } = fixture(); const reserved = await claim(store, intent());
        const guard = [...client.records.entries()].find(([pk]) => pk.includes('#mail-guard#'));
        if (!guard) { throw new Error('missing guard'); }
        client.beforeTransaction = () => { const data = guard[1].record as Record<string, unknown>; data.ownerToken = 'changed-owner'.padEnd(43, 'x'); };
        await expect(store.markDispatched(reserved)).rejects.toThrow('temporarily_unavailable');
        expect((await store.getOperation(key()))?.state).toBe('reserved');
        await expect(store.failPreflight(reserved, { status: 'failed', operationId: key().operationId, reason: 'forbidden' })).rejects.toThrow('temporarily_unavailable');
        expect(client.records.has(guard[0])).toBe(true);
    });
    test('malformed keys, intent, persisted fields and receipt mismatches fail closed before transaction', async () => {
        const { client, store } = fixture();
        await expect(store.reserve({ ...intent(), subject: 'secret' } as unknown as WriteIntent, owner)).rejects.toThrow('temporarily_unavailable');
        await expect(store.reserve({ ...intent(), accountId: 'namespace#injection' }, owner)).rejects.toThrow('temporarily_unavailable');
        await expect(store.reserve(intent(), 'short')).rejects.toThrow('temporarily_unavailable');
        expect(client.calls).toHaveLength(0);
        const reserved = await claim(store, intent()); const dispatched = await store.markDispatched(reserved);
        const count = client.calls.filter(command => command instanceof TransactWriteCommand).length;
        await expect(store.complete(dispatched, { status: 'queued', operationId: 'operation-other000', queueId: 'queue' })).rejects.toThrow('temporarily_unavailable');
        await expect(store.complete(dispatched, { status: 'completed', operationId: key().operationId, ...verifiedDraft(1) })).rejects.toThrow('temporarily_unavailable');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(count);
        const stored = [...client.records.values()].find(value => String(value.pk).includes('#mail-operation#'));
        if (!stored) { throw new Error('missing operation'); } stored.expiresAt = 1;
        expect((await store.getOperation(key()))?.state).toBe('dispatched');
        stored.expiresAt = 'soon'; await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
        delete stored.expiresAt; stored.ttl = 1; await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
    });
    test('invalid partial replacement receipts cannot commit; dispatch cannot be released as preflight failure', async () => {
        const { store } = fixture(); const updating = await store.markDispatched(await claim(store, intent('operation-00000001', 'update_draft')));
        await expect(store.complete(updating, { status: 'completed', operationId: key().operationId, ...verifiedDraft(2), previousDeleted: false } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
        await expect(store.failPreflight({ ...updating, state: 'reserved' }, { status: 'failed', operationId: key().operationId, reason: 'forbidden' })).rejects.toThrow('temporarily_unavailable');
    });
    test('a committed reservation with persistently lost acknowledgements never grants dispatch permission', async () => {
        const { client, store } = fixture(); client.fault = 'lost_persistent';
        await expect(store.reserve(intent(), owner)).rejects.toThrow('temporarily_unavailable');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(3);
        client.fault = 'none';
        const replay = await store.reserve(intent(), owner);
        expect(replay.kind).toBe('replay');
        expect(await store.reserve({ ...intent(), operationId: 'operation-00000002' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    });
    test('delete receipts bind the exact target and successful deletion permanently retires its UID', async () => {
        const { store } = fixture(); const deleting = await store.markDispatched(await claim(store, intent('operation-00000001', 'delete_draft')));
        await expect(store.complete(deleting, { status: 'completed', operationId: key().operationId, deleted: { mailboxId, uid: 2 } })).rejects.toThrow('temporarily_unavailable');
        await store.complete(deleting, { status: 'completed', operationId: key().operationId, deleted: { mailboxId, uid: 1 } });
        expect(await store.reserve(intent('operation-00000002'), owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    });
    const rowOf = (client: ModelSender, part: string) => { const row = [...client.records.values()].find(item => String(item.pk).includes(part)); if (!row) { throw new Error(`missing ${part}`); } return row; };
    test('fields a later version writes are read: reservedAt survives every transition and the compare-and-set still matches; expiresAt is ignored', async () => {
        const { client, store } = fixture(); const value = intent(); const reservedAt = 1_800_000_000;
        const reserved = await claim(store, value);
        (rowOf(client, '#mail-operation#').record as Record<string, unknown>).reservedAt = reservedAt;
        rowOf(client, '#mail-operation#').expiresAt = reservedAt + 7_776_000; rowOf(client, '#mail-guard#').expiresAt = reservedAt + 7_776_000;
        expect(await store.getOperation(key())).toMatchObject({ state: 'reserved', reservedAt });
        const dispatched = await store.markDispatched(reserved);
        expect(rowOf(client, '#mail-operation#').record).toMatchObject({ state: 'dispatched', revision: 1, reservedAt });
        await store.complete(dispatched, { status: 'queued', operationId: value.operationId, queueId: 'queue-r1' });
        const settled = await store.getOperation(key());
        expect(settled).toMatchObject({ state: 'settled', revision: 2, reservedAt, receipt: { status: 'queued', queueId: 'queue-r1' } });
        // A Put writes pk, sk and record only, so the expiresAt read from the item is not written back.
        expect(rowOf(client, '#mail-operation#')).not.toHaveProperty('expiresAt');
        const failing = { ...intent('operation-00000002'), target: { mailboxId, uid: 2 } };
        const failed = await store.markDispatched(await claim(store, failing));
        const other = [...client.records.values()].find(item => String(item.pk).includes('operation-00000002'));
        if (!other) { throw new Error('missing second operation'); } (other.record as Record<string, unknown>).reservedAt = reservedAt;
        const again = await store.reserve(failing, owner);
        expect(again).toMatchObject({ kind: 'replay', record: { reservedAt } });
        await store.failDispatched(failed, { status: 'failed', operationId: failing.operationId, reason: 'not_found' });
        expect(await store.getOperation(key('operation-00000002'))).toMatchObject({ state: 'settled', reservedAt, receipt: { status: 'failed' } });
    });
    test('reservedAt must be a positive safe integer; an unknown attribute, on the record or beside it, is still rejected', async () => {
        const { client, store } = fixture(); await claim(store, intent());
        const record = rowOf(client, '#mail-operation#').record as Record<string, unknown>;
        for (const bad of [0, -1, 1.5, '1700000000', null, 2 ** 53]) { record.reservedAt = bad; await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable'); }
        delete record.reservedAt; record.settledAt = 1; await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
        delete record.settledAt; expect((await store.getOperation(key()))?.state).toBe('reserved');
        const guard = rowOf(client, '#mail-guard#'); const claimed = { key: key(), ownerToken: owner, revision: 0, state: 'reserved' as const };
        guard.ttl = 1; await expect(store.markDispatched(claimed)).rejects.toThrow('temporarily_unavailable');
        delete guard.ttl; guard.expiresAt = 'soon'; await expect(store.markDispatched(claimed)).rejects.toThrow('temporarily_unavailable');
        guard.expiresAt = 1_900_000_000; expect((await store.markDispatched(claimed)).state).toBe('dispatched');
    });
    test('a queued send receipt without a queueId is stored and returned as it is', async () => {
        const { client, store } = fixture(); const value = intent(); const sent = { mailboxId: 'e'.repeat(24), uid: 40 };
        await store.complete(await store.markDispatched(await claim(store, value)), { status: 'queued', operationId: value.operationId, sent });
        expect(rowOf(client, '#mail-operation#').record).toMatchObject({ receipt: { status: 'queued', operation_id: value.operationId, sent } });
        expect(rowOf(client, '#mail-operation#').record).not.toHaveProperty('receipt.queueId');
        expect(await store.getOperation(key())).toMatchObject({ state: 'settled', receipt: { status: 'queued', operationId: value.operationId, sent } });
    });
    test('failDispatched settles a dispatched operation as failed and deletes its guard in one transaction; a stale claim or a later settlement is refused', async () => {
        const { client, store } = fixture(); const value = intent();
        const dispatched = await store.markDispatched(await claim(store, value));
        const failed = { status: 'failed' as const, operationId: value.operationId, reason: 'not_found' as const };
        await expect(store.failDispatched({ ...dispatched, ownerToken: 'forged-owner'.padEnd(43, 'z') }, failed)).rejects.toThrow('temporarily_unavailable');
        await expect(store.failDispatched(dispatched, { ...failed, operationId: 'operation-other000' })).rejects.toThrow('temporarily_unavailable');
        await expect(store.failDispatched(dispatched, { status: 'outcome_unknown', operationId: value.operationId } as never)).rejects.toThrow('temporarily_unavailable');
        expect(rowOf(client, '#mail-guard#')).toBeDefined();
        const before = client.calls.filter(command => command instanceof TransactWriteCommand).length;
        await store.failDispatched(dispatched, failed);
        const writes = client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(writes).toHaveLength(before + 1); expect(writes.at(-1)?.input.TransactItems?.map(item => Object.keys(item)[0])).toEqual(['Put', 'Delete']);
        expect([...client.records.keys()].some(pk => pk.includes('#mail-guard#'))).toBe(false);
        expect(await store.getOperation(key())).toMatchObject({ state: 'settled', revision: 2, receipt: { status: 'failed', reason: 'not_found' } });
        expect(rowOf(client, '#mail-operation#').record).toMatchObject({ receipt: { status: 'failed', operation_id: value.operationId } });
        // The stale claim is now behind the record.
        await expect(store.failDispatched(dispatched, failed)).rejects.toThrow('temporarily_unavailable');
        await expect(store.complete(dispatched, { status: 'queued', operationId: value.operationId, queueId: 'late' })).rejects.toThrow('temporarily_unavailable');
        await expect(store.markOutcomeUnknown(dispatched, { status: 'outcome_unknown', operationId: value.operationId } as never)).rejects.toThrow('temporarily_unavailable');
        expect(await store.reserve({ ...intent('operation-00000002'), ...key('operation-00000002', 'x'.repeat(43)) }, owner)).toMatchObject({ kind: 'acquired' });
    });
    test('failDispatched is refused for a reserved claim, and failPreflight for a dispatched one; a create has no guard to delete', async () => {
        const { client, store } = fixture(); const value = intent(); const failed = { status: 'failed' as const, operationId: value.operationId, reason: 'forbidden' as const };
        const reserved = await claim(store, value);
        await expect(store.failDispatched({ ...reserved, state: 'dispatched' } as never, failed)).rejects.toThrow('temporarily_unavailable');
        const dispatched = await store.markDispatched(reserved);
        await expect(store.failPreflight({ ...dispatched, state: 'reserved' } as never, failed)).rejects.toThrow('temporarily_unavailable');
        const create: WriteIntent = { ...key('operation-create001'), payloadDigest: digest, tool: 'create_draft' };
        const created = await store.markDispatched(await claim(store, create));
        await store.failDispatched(created, { status: 'failed', operationId: create.operationId, reason: 'upstream_timeout' });
        expect(await store.getOperation(key('operation-create001'))).toMatchObject({ state: 'settled', receipt: { status: 'failed', reason: 'upstream_timeout' } });
        expect(rowOf(client, '#mail-guard#')).toBeDefined();
    });
    test('flag completion atomically releases guard, survives a lost response and never releases a subsequent owner on replay', async () => {
        const { client, store } = fixture(); const value = intent('operation-flags001', 'update_message_flags');
        const dispatched = await store.markDispatched(await claim(store, value)); client.fault = 'lost_once';
        await store.complete(dispatched, { status: 'completed', operationId: value.operationId, ...verifiedMessage(1) });
        const writes = client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(writes.at(-1)).toBe(writes.at(-2));
        expect(writes.at(-1)?.input.TransactItems?.[1]?.Delete).toBeDefined();
        const next = await claim(store, { ...value, operationId: 'operation-flags002', clientIdHash: 'x'.repeat(43) });
        const before = client.calls.filter(command => command instanceof TransactWriteCommand).length;
        // Reserve no longer reads first: its absent-put is refused, then the winner is read and replayed.
        expect((await store.reserve(value, owner)).kind).toBe('replay');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(before + 1);
        const guard = [...client.records.values()].find(row => String(row.pk).includes('#mail-guard#'));
        if (!guard) { throw new Error('missing next guard'); }
        expect((guard.record as { operation: OperationKey }).operation).toEqual(next.key);
    });
    test('flag release CAS cannot partially settle or erase a guard changed since observation', async () => {
        const { client, store } = fixture(); const value = intent('operation-flags001', 'update_message_flags');
        const dispatched = await store.markDispatched(await claim(store, value));
        const guard = [...client.records.values()].find(row => String(row.pk).includes('#mail-guard#'));
        if (!guard) { throw new Error('missing guard'); }
        client.beforeTransaction = () => { (guard.record as { revision: number }).revision++; };
        await expect(store.complete(dispatched, { status: 'completed', operationId: value.operationId, ...verifiedMessage(1) })).rejects.toThrow('temporarily_unavailable');
        expect((await store.getOperation(key(value.operationId)))?.state).toBe('dispatched');
        expect(client.records.has(String(guard.pk))).toBe(true);
    });
    test('wrong-account proofs, wrong flag UID, same-mailbox moves and private flag sets never commit', async () => {
        for (const tool of ['update_message_flags', 'move_message', 'update_draft'] as const) {
            const { client, store } = fixture(); const value = intent('operation-invalid001', tool);
            const dispatched = await store.markDispatched(await claim(store, value));
            const valid = tool === 'update_draft' ? { status: 'completed', operationId: value.operationId, ...verifiedDraft(2), previousDeleted: true } : { status: 'completed', operationId: value.operationId, ...verifiedMessage(tool === 'move_message' ? 2 : 1, tool === 'move_message' ? 'b'.repeat(24) : mailboxId) };
            const count = client.calls.filter(command => command instanceof TransactWriteCommand).length;
            await expect(store.complete(dispatched, { ...valid, proof: { ...valid.proof, accountId: 'f'.repeat(24) } } as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            if (tool === 'update_message_flags') {
                await expect(store.complete(dispatched, { status: 'completed', operationId: value.operationId, ...verifiedMessage(2) })).rejects.toThrow('temporarily_unavailable');
                await expect(store.complete(dispatched, { ...valid, labels: ['private-label'] } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            }
            if (tool === 'move_message') { await expect(store.complete(dispatched, { status: 'completed', operationId: value.operationId, ...verifiedMessage(2) })).rejects.toThrow('temporarily_unavailable'); }
            expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(count);
        }
    });
    test('draft receipts require authored proof, never upgrade observed or absent provenance', async () => {
        for (const tool of ['create_draft', 'update_draft'] as const) {
            const { client, store } = fixture();
            const value: WriteIntent = tool === 'create_draft' ? { ...key(), tool, payloadDigest: digest } : intent(key().operationId, tool);
            const dispatched = await store.markDispatched(await claim(store, value));
            const valid = { status: 'completed' as const, operationId: value.operationId, ...verifiedDraft(2), ...(tool === 'update_draft' ? { previousDeleted: true as const } : {}) };
            const writes = client.calls.filter(command => command instanceof TransactWriteCommand).length;
            const { sourceGrade: _grade, ...missingGrade } = valid.proof;
            for (const proof of [missingGrade, { ...valid.proof, sourceGrade: 'observed' }, { ...valid.proof, sourceGrade: 'invented_grade' }]) {
                await expect(store.complete(dispatched, { ...valid, proof } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            }
            if (tool === 'update_draft') {
                await expect(store.complete(dispatched, { status: 'partial', operationId: value.operationId, candidate: verifiedDraft(2).draft, candidateVerified: true, proof: { ...valid.proof, sourceGrade: 'observed' }, reason: 'original_deletion_failed', originalDeletion: 'failed' } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            }
            expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(writes);
            await store.complete(dispatched, valid as ConfirmedReceipt);
            const stored = await store.getOperation(key());
            if (stored?.state !== 'settled') { throw new Error('missing authored receipt'); }
            expect(stored.receipt).toEqual(valid);
        }
    });
    test('persisted proof without a provenance grade fails closed rather than migrating to authored', async () => {
        const { client, store } = fixture(); const value = intent('operation-provenance1', 'update_message_flags');
        await store.complete(await store.markDispatched(await claim(store, value)), { status: 'completed', operationId: value.operationId, ...verifiedMessage(1) });
        const row = [...client.records.values()].find(record => String(record.pk).includes('#mail-operation#'));
        if (!row) { throw new Error('missing operation'); }
        const record = row.record as { receipt: { proof: Record<string, unknown> } };
        delete record.receipt.proof.sourceGrade;
        await expect(store.getOperation(key(value.operationId))).rejects.toThrow('temporarily_unavailable');
    });
    test('throttled reads and a throttled transaction are retried with backoff; the transaction keeps one token and applies once', async () => {
        const { client, store, virtual } = fixture();
        client.failures.transact.push(cancelled('None', 'ThrottlingError'));
        await claim(store, intent());
        client.failures.get.push(throttleError(), throttleError('ThrottlingException'));
        expect((await store.getOperation(key()))?.state).toBe('reserved');
        expect(client.calls.filter(command => command instanceof GetCommand)).toHaveLength(3);
        const writes = client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(writes).toHaveLength(2); expect(writes[1]).toBe(writes[0]);
        expect(writes[0]?.input.ClientRequestToken).toHaveLength(36);
        expect([...client.records.keys()].filter(pk => pk.includes('#mail-operation#'))).toHaveLength(1);
        expect(virtual.sleeps).toEqual([200, 200, 400]);
        expect(logs).toEqual([throttled(1, 'transact'), throttled(1, 'get'), throttled(2, 'get')]);
        expect((await store.reserve(intent(), owner)).kind).toBe('replay');
    });
    test('throttling that outlasts the throttle budget is temporarily_unavailable, never a conflict or success, and nothing is applied', async () => {
        const reads = fixture(); reads.client.failures.get.push(...Array.from({ length: 50 }, () => throttleError()));
        await expect(reads.store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
        // Waits of 200, 400, 800, 1600 ms, then 1600 each, the last cut to the 10 s deadline.
        expect(reads.virtual.sleeps).toEqual([200, 400, 800, 1600, 1600, 1600, 1600, 1600, 600]);
        expect(reads.client.calls).toHaveLength(9); expect(logs).toHaveLength(9);
        logs.length = 0;
        const writes = fixture(); writes.client.failures.transact.push(...Array.from({ length: 50 }, () => cancelled('ProvisionedThroughputExceeded', 'ProvisionedThroughputExceeded')));
        await expect(writes.store.reserve(intent(), owner)).rejects.toThrow('temporarily_unavailable');
        const sent = writes.client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(sent).toHaveLength(9); expect(new Set(sent).size).toBe(1);
        expect(writes.client.records.size).toBe(0); expect(writes.virtual.clock.ms).toBe(10000);
        expect(logs.filter(line => line.operation === 'transact')).toHaveLength(9);
    });
    test('a condition conflict is not retried or logged as throttling', async () => {
        const { client, store, virtual } = fixture();
        client.failures.transact.push(cancelled('ConditionalCheckFailed', 'None'));
        await expect(store.reserve(intent(), owner)).rejects.toThrow('temporarily_unavailable');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(1);
        expect(virtual.sleeps).toEqual([]); expect(logs).toEqual([]);
    });
    test('an unthrottled call keeps the short timeout; the throttle budget must be a sane duration', async () => {
        // The service's time arithmetic derives from the default, so the mail store accepts nothing above it.
        for (const throttleTimeoutMs of [0, 1.5, DEFAULT_THROTTLE_TIMEOUT_MS + 1, 50_000]) { expect(() => new DynamoMailOperationStore({ tableName: 'MailTable', client: new ModelSender(), throttleTimeoutMs })).toThrow('Invalid mail store throttle timeout'); }
        for (const throttleTimeoutMs of [1, DEFAULT_THROTTLE_TIMEOUT_MS]) { expect(new DynamoMailOperationStore({ tableName: 'MailTable', client: new ModelSender(), throttleTimeoutMs })).toBeDefined(); }
        const { client, store, virtual } = fixture(); client.failures.get.push(new Error('socket closed'), new Error('socket closed'), new Error('socket closed'));
        await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
        expect(client.calls).toHaveLength(3); expect(virtual.sleeps).toEqual([25, 50]);
        expect(logs).toEqual([{ event: 'dynamodb_failed', store: 'mail', operation: 'get', kind: 'transient_exhausted' }]);
    });
    test('whole request deadline bounds stalled SDK transport and aborts it', async () => {


        let signal: AbortSignal | undefined;
        const store = new DynamoMailOperationStore({ tableName: 'MailTable', timeoutMs: 5, client: { send(_command, options) { signal = options?.abortSignal; return new Promise(() => {}); } } });
        await expect(store.reserve(intent(), owner)).rejects.toThrow('temporarily_unavailable'); expect(signal?.aborted).toBe(true);
    });
});

test.skipIf(process.env.DYNAMO_LOCAL_MAIL_TEST !== '1')('actual DynamoDB Local mail lifecycle and concurrent reservations on fixed 1/1 table', async () => {
    const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DeleteTableCommand } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const client = new DynamoDBClient({ endpoint: 'http://127.0.0.1:18765', region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1 });
    const tableName = `MailTest${Date.now()}`;
    try {
        await client.send(new CreateTableCommand({ TableName: tableName, AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }));
        const store = new DynamoMailOperationStore({ tableName, client: DynamoDBDocumentClient.from(client) });
        await lifecycleMatrix(store); await expandedMatrix(store); await provenanceMatrix(store);
        const fresh = { ...intent('operation-concurrency01'), target: { mailboxId, uid: 100 } };
        const racing = await Promise.all([store.reserve(fresh, owner), store.reserve({ ...fresh, operationId: 'operation-concurrency02', clientIdHash: 'q'.repeat(43) }, owner)]);
        expect(racing.map(result => result.kind).sort()).toEqual(['acquired', 'conflict']);
        const sdk = DynamoDBDocumentClient.from(client); let lost = false; let writes = 0;
        const uncertainStore = new DynamoMailOperationStore({ tableName, client: { async send(command, options) {
            const result = await sdk.send(command as TransactWriteCommand, options);
            if (command instanceof TransactWriteCommand) { writes++; if (!lost) { lost = true; throw new Error('lost actual service commit response'); } }
            return result;
        } } });
        await claim(uncertainStore, { ...intent('operation-lostresponse'), target: { mailboxId, uid: 101 } });
        expect(writes).toBe(2);
        const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
        expect(table.Table?.ProvisionedThroughput?.ReadCapacityUnits).toBe(1); expect(table.Table?.ProvisionedThroughput?.WriteCapacityUnits).toBe(1);
    } finally { await client.send(new DeleteTableCommand({ TableName: tableName })); client.destroy(); }
});

test('reply draft ledger reserves without original guard and validates authored create receipts', async () => {
    const f = fixture(); const value: WriteIntent = { ...key(), tool: 'create_reply_draft', payloadDigest: digest };
    const reservation = await f.store.reserve(value, owner); expect(reservation.kind).toBe('acquired'); if (reservation.kind !== 'acquired') { throw new Error('expected acquisition'); }
    expect(f.client.records.size).toBe(1);
    const dispatched = await f.store.markDispatched(reservation.claim);
    await expect(f.store.complete(dispatched, { status: 'completed', operationId: value.operationId, ...verifiedDraft(9), proof: { ...verifiedDraft(9).proof, sourceGrade: 'observed' } } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
    const receipt = { status: 'completed' as const, operationId: value.operationId, ...verifiedDraft(9) }; await f.store.complete(dispatched, receipt);
    expect(await f.store.getOperation(key())).toMatchObject({ state: 'settled', receipt }); expect((await f.store.reserve(value, owner)).kind).toBe('replay');
    expect(await f.store.reserve({ ...value, payloadDigest: 'e'.repeat(43) }, owner)).toEqual({ kind: 'conflict', reason: 'operation_conflict' }); expect(f.client.records.size).toBe(1);
});

describe('receipts stored by 0.6.x', () => {
    const operationPk = (value: OperationKey) => `wildduck-mcp#mail-operation#${value.accountId}#${value.clientIdHash}#${value.operationId}`;
    /** The exact item shape 0.6.x wrote: receipts carry operation_id. */
    const seed = (client: ModelSender, value: WriteIntent, receipt: Record<string, unknown>) => {
        const pk = operationPk(value); const record = { key: key(value.operationId), intent: value, ownerToken: owner, revision: 2, state: 'settled', receipt };
        client.records.set(pk, { pk, sk: 'STATE', record });
    };
    const create = (operationId: string): WriteIntent => ({ ...key(operationId), tool: 'create_draft', payloadDigest: digest });
    const legacy: [WriteIntent, Record<string, unknown>][] = [
        [intent('operation-legacy-send'), { status: 'queued', operation_id: 'operation-legacy-send', queueId: 'queue-0-6' }],
        [create('operation-legacy-create'), { status: 'completed', operation_id: 'operation-legacy-create', ...verifiedDraft(7) }],
        [create('operation-legacy-partial'), { status: 'partial', operation_id: 'operation-legacy-partial', candidate: { mailboxId, uid: 8 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' }],
        [{ ...intent('operation-legacy-update', 'update_draft'), target: { mailboxId, uid: 9 } }, { status: 'partial', operation_id: 'operation-legacy-update', candidate: verifiedDraft(10).draft, candidateVerified: true, proof: verifiedDraft(10).proof, reason: 'original_deletion_unconfirmed', originalDeletion: 'unconfirmed' }],
        [{ ...intent('operation-legacy-flags', 'update_message_flags'), target: { mailboxId, uid: 11 } }, { status: 'completed', operation_id: 'operation-legacy-flags', ...verifiedMessage(11) }],
        [{ ...intent('operation-legacy-delete', 'delete_draft'), target: { mailboxId, uid: 12 } }, { status: 'completed', operation_id: 'operation-legacy-delete', deleted: { mailboxId, uid: 12 } }],
        [intent('operation-legacy-failed'), { status: 'failed', operation_id: 'operation-legacy-failed', reason: 'version_conflict' }],
        [intent('operation-legacy-unknown'), { status: 'outcome_unknown', operation_id: 'operation-legacy-unknown', reason: 'dispatch_uncertain' }],
    ];
    test('read back and replay with operationId, and validate against the current output schemas', async () => {
        const f = fixture();
        for (const [value, receipt] of legacy) {
            seed(f.client, value, receipt);
            const { operation_id: stored, ...rest } = receipt; const expected = { ...rest, operationId: stored };
            const record = await f.store.getOperation(key(value.operationId));
            expect(record?.state).toBe('settled'); if (record?.state !== 'settled') { throw new Error('expected settled record'); }
            expect(record.receipt).toEqual(expected as never); expect(record.receipt).not.toHaveProperty('operation_id');
            const replay = await f.store.reserve(value, owner);
            expect(replay.kind).toBe('replay'); if (replay.kind === 'replay' && replay.record.state === 'settled') { expect(replay.record.receipt).toEqual(expected as never); }
        }
    });
    test('new receipts are stored in the same 0.6.x shape, so a rollback can still read them', async () => {
        const f = fixture(); const value = intent('operation-current-send');
        await f.store.complete(await f.store.markDispatched(await claim(f.store, value)), { status: 'queued', operationId: value.operationId, queueId: 'queue-0-7' });
        expect((f.client.records.get(operationPk(value))?.['record'] as { receipt?: unknown } | undefined)?.receipt).toEqual({ status: 'queued', operation_id: value.operationId, queueId: 'queue-0-7' });
        const record = await f.store.getOperation(key(value.operationId)); if (record?.state !== 'settled') { throw new Error('expected settled record'); }
        expect(record.receipt).toEqual({ status: 'queued', operationId: value.operationId, queueId: 'queue-0-7' });
    });
    test('a stored receipt carrying both names, or a mismatched id, is refused', async () => {
        const f = fixture(); const value = intent('operation-legacy-both'); const other = intent('operation-legacy-other');
        seed(f.client, value, { status: 'queued', operation_id: value.operationId, operationId: value.operationId, queueId: 'queue' });
        seed(f.client, other, { status: 'queued', operation_id: 'operation-legacy-xxxx', queueId: 'queue' });
        await expect(f.store.getOperation(key(value.operationId))).rejects.toThrow('temporarily_unavailable');
        await expect(f.store.getOperation(key(other.operationId))).rejects.toThrow('temporarily_unavailable');
    });
    test('a summary is never written to the store, and one found in a stored record is dropped when it is read', async () => {
        const f = fixture(); const queued = intent('operation-plain-send'); const failed = { ...intent('operation-plain-failed'), target: { mailboxId, uid: 2 } };
        await f.store.complete(await f.store.markDispatched(await claim(f.store, queued)), { status: 'queued', operationId: queued.operationId, queueId: 'queue-q1', summary: 'Draft sent: this must not be stored.' });
        await f.store.failPreflight(await claim(f.store, failed), { status: 'failed', operationId: failed.operationId, reason: 'version_conflict', summary: 'Not done: this must not be stored.' });
        const stored = (value: WriteIntent) => (f.client.records.get(operationPk(value))?.['record'] as { receipt?: unknown } | undefined)?.receipt;
        expect(stored(queued)).toEqual({ status: 'queued', operation_id: queued.operationId, queueId: 'queue-q1' });
        expect(stored(failed)).toEqual({ status: 'failed', operation_id: failed.operationId, reason: 'version_conflict' });
        expect(JSON.stringify([...f.client.records.values()])).not.toContain('summary');
        // A record that carries one anyway (written by something else) still reads back in the stored shape.
        const odd = { ...intent('operation-plain-odd'), target: { mailboxId, uid: 3 } }; seed(f.client, odd, { status: 'queued', operation_id: odd.operationId, queueId: 'queue-odd', summary: 'Not stored.' });
        const record = await f.store.getOperation(key(odd.operationId)); if (record?.state !== 'settled') { throw new Error('expected settled record'); }
        expect(record.receipt).toEqual({ status: 'queued', operationId: odd.operationId, queueId: 'queue-odd' }); expect(record.receipt).not.toHaveProperty('summary');
        const before = structuredClone([...f.client.records.entries()]);
        const replay = await f.store.reserve(odd, owner); expect(replay.kind).toBe('replay'); if (replay.kind === 'replay' && replay.record.state === 'settled') { expect(replay.record.receipt).not.toHaveProperty('summary'); }
        expect([...f.client.records.entries()]).toEqual(before);
    });
    test('a stray stored summary of any shape never blocks the message: it reads, replays and takes later changes', async () => {
        const context: MailContext = { accountId: key().accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:read', 'mail:draft', 'mail:send', 'mail:modify'], connectionStatus: 'active' };
        const clientIdHash = hashOf(context.clientId);
        const strays: [string, unknown][] = [['too long', 'x'.repeat(701)], ['empty', ''], ['null', null], ['number', 42]];
        for (const [index, [label, stray]] of strays.entries()) {
            const f = fixture();
            // Replay: a delete receipt that carries a stray summary replays its stored outcome, with a freshly worked-out summary.
            const operationId = `operation-stray-${index}-delete`; const uid = 30 + index;
            const forDelete: WriteIntent = { accountId: context.accountId, clientIdHash, operationId, tool: 'delete_draft', payloadDigest: hashOf(JSON.stringify({ accountId: context.accountId, input: { expected_version: digest, uid }, tool: 'delete_draft' })), target: { mailboxId, uid }, expectedVersion: digest };
            const pk = operationPk(forDelete); const receipt = { status: 'completed', operation_id: operationId, deleted: { mailboxId, uid }, summary: stray };
            f.client.records.set(pk, { pk, sk: 'STATE', record: { key: { accountId: forDelete.accountId, clientIdHash: forDelete.clientIdHash, operationId }, intent: forDelete, ownerToken: owner, revision: 2, state: 'settled', receipt } });
            const service = createMailService({ reader: {} as never, writer: {} as never, operations: f.store });
            const mail = { delete_draft: (input: never) => service.delete_draft(context, input) } as unknown as BoundMailService;
            const authInfo: AuthInfo = { token: 'synthetic-oauth-token', clientId: 'verified-client', scopes: context.scopes as string[], resource: new URL('https://service.example/mcp') };
            const before = structuredClone([...f.client.records.entries()]);
            const response = await handleMcp(new Request('https://service.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_draft', arguments: { uid, expectedVersion: digest, operationId } } }) }), authInfo, mail);
            const reply = (await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
            expect({ label, isError: reply.isError }).toEqual({ label, isError: undefined });
            expect({ label, keys: Object.keys(reply.structuredContent), deleted: reply.structuredContent['deleted'] }).toEqual({ label, keys: ['summary', 'status', 'operationId', 'deleted'], deleted: { mailboxId, uid } });
            expect(String(reply.structuredContent['summary'])).toStartWith(`Draft uid ${uid} permanently deleted`);
            expect([...f.client.records.entries()]).toEqual(before);
            // Reads and later changes: a flags change recorded by this store, then given a stray summary by something else.
            const flags: Exclude<WriteIntent, { tool: 'create_draft' | 'create_reply_draft' }> = { ...intent(`operation-stray-${index}-flags`, 'update_message_flags'), target: { mailboxId, uid: 11 } };
            await f.store.complete(await f.store.markDispatched(await claim(f.store, flags)), { status: 'completed', operationId: flags.operationId, ...verifiedMessage(11) });
            ((f.client.records.get(operationPk(flags)) as { record: { receipt: Record<string, unknown> } }).record.receipt)['summary'] = stray;
            const marker = { accountId: flags.accountId, clientIdHash: flags.clientIdHash, operationId: flags.operationId, payloadDigest: flags.payloadDigest, tool: flags.tool };
            const message = { mailboxId, uid: 11, version: digest, subject: 'subject', snippet: null, threadId: null, from: [], to: [], date: null, receivedAt: null, flags: { seen: false, flagged: false, draft: false, answered: false, deleted: false, forwarded: false }, imapFlags: [], labels: [], hasAttachments: false, replyTo: [], cc: [], bcc: [], messageId: null, references: [], text: 'text', textTruncated: false, html: [], htmlTruncated: false, htmlRepresentation: 'wildduck_normalized', attachments: [] };
            const reading = createMailService({ reader: { readMessage: async () => ({ message, marker }) } as never, writer: {} as never, operations: f.store });
            const read = await reading.read_message(context, { mailboxId, uid: 11, includeHtml: false });
            expect({ label, verification: read.managedOperation?.verification }).toEqual({ label, verification: 'verified' });
            const record = await f.store.getOperation(key(flags.operationId)); if (record?.state !== 'settled') { throw new Error('expected settled record'); }
            expect({ label, receipt: record.receipt }).toEqual({ label, receipt: { status: 'completed', operationId: flags.operationId, ...verifiedMessage(11) } }); expect(record.receipt).not.toHaveProperty('summary');
            expect((await f.store.reserve({ ...flags, operationId: `operation-stray-${index}-next` }, owner)).kind).toBe('acquired');
        }
    });
    test('receipts stored by 0.6.x and 0.7.2 replay through the MCP handler with a summary that is added to the output only', async () => {
        const f = fixture(); const context: MailContext = { accountId: key().accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:read', 'mail:draft', 'mail:send', 'mail:modify'], connectionStatus: 'active' };
        const clientIdHash = hashOf(context.clientId); const draftsTarget = { mailboxId, uid: 12 };
        const forTool = (operationId: string, tool: 'delete_draft' | 'send_draft', uid: number): Extract<WriteIntent, { target: unknown }> => ({ accountId: context.accountId, clientIdHash, operationId, tool, payloadDigest: hashOf(JSON.stringify({ accountId: context.accountId, input: { expected_version: digest, uid }, tool })), target: { mailboxId, uid }, expectedVersion: digest });
        const service = createMailService({ reader: {} as never, writer: {} as never, operations: f.store });
        const mail = { delete_draft: (input: never) => service.delete_draft(context, input), send_draft: (input: never) => service.send_draft(context, input) } as unknown as BoundMailService;
        const call = async (name: string, args: unknown) => {
            const authInfo: AuthInfo = { token: 'synthetic-oauth-token', clientId: 'verified-client', scopes: context.scopes as string[], resource: new URL('https://service.example/mcp') };
            const response = await handleMcp(new Request('https://service.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), authInfo, mail);
            return (await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] } }).result;
        };
        // 0.6.x wrote operation_id and no summary; 0.7.2 wrote the same shape through this store.
        const cases: { label: string; tool: 'delete_draft' | 'send_draft'; operationId: string; uid: number; stored: Record<string, unknown>; summary: string; isError: boolean }[] = [
            { label: '0.6.x delete', tool: 'delete_draft', operationId: 'operation-replay-delete-06', uid: 12, stored: { status: 'completed', operation_id: 'operation-replay-delete-06', deleted: draftsTarget }, summary: 'Draft uid 12 permanently deleted: it was not moved to the Trash mailbox and cannot be recovered through this server.', isError: false },
            { label: '0.6.x send', tool: 'send_draft', operationId: 'operation-replay-send-06', uid: 13, stored: { status: 'queued', operation_id: 'operation-replay-send-06', queueId: 'queue-0-6', sent: { mailboxId: 'e'.repeat(24), uid: 40 } }, summary: 'Draft sent: accepted by the mail server for delivery (queued), which does not confirm it arrived; the copy in Sent is uid 40 in mailbox eeeeeeeeeeeeeeeeeeeeeeee.', isError: false },
            { label: '0.6.x failed', tool: 'send_draft', operationId: 'operation-replay-failed-06', uid: 14, stored: { status: 'failed', operation_id: 'operation-replay-failed-06', reason: 'version_conflict' }, summary: 'Not done: The message has changed since you read it', isError: true },
            { label: '0.6.x unknown', tool: 'send_draft', operationId: 'operation-replay-unknown-06', uid: 15, stored: { status: 'outcome_unknown', operation_id: 'operation-replay-unknown-06', reason: 'dispatch_uncertain' }, summary: 'Outcome unknown:', isError: true },
        ];
        for (const item of cases) {
            const value = forTool(item.operationId, item.tool, item.uid); const pk = operationPk(value);
            f.client.records.set(pk, { pk, sk: 'STATE', record: { key: { accountId: value.accountId, clientIdHash: value.clientIdHash, operationId: value.operationId }, intent: value, ownerToken: owner, revision: 2, state: 'settled', receipt: item.stored } });
            const reply = await call(item.tool, { uid: item.uid, expectedVersion: digest, operationId: item.operationId });
            expect({ label: item.label, isError: reply.isError === true }).toEqual({ label: item.label, isError: item.isError });
            expect({ label: item.label, first: Object.keys(reply.structuredContent)[0], summary: String(reply.structuredContent['summary']).startsWith(item.summary) }).toEqual({ label: item.label, first: 'summary', summary: true });
            const { summary: _summary, operationId, ...rest } = reply.structuredContent; const { operation_id: _operationId, ...expected } = item.stored; expect({ label: item.label, rest, operationId }).toEqual({ label: item.label, rest: expected, operationId: item.operationId });
            expect(JSON.parse(reply.content[0]?.text ?? 'null')).toEqual(reply.structuredContent);
        }
        // The 0.7.2 path: a receipt this store wrote, replayed with the same arguments.
        const written = forTool('operation-replay-delete-072', 'delete_draft', 21);
        await f.store.complete(await f.store.markDispatched(await claim(f.store, written)), { status: 'completed', operationId: written.operationId, deleted: { mailboxId, uid: 21 } });
        expect((f.client.records.get(operationPk(written))?.['record'] as { receipt?: unknown } | undefined)?.receipt).toEqual({ status: 'completed', operation_id: written.operationId, deleted: { mailboxId, uid: 21 } });
        const before = structuredClone([...f.client.records.entries()]);
        const replayed = await call('delete_draft', { uid: 21, expectedVersion: digest, operationId: written.operationId });
        expect(Object.keys(replayed.structuredContent)).toEqual(['summary', 'status', 'operationId', 'deleted']); expect(String(replayed.structuredContent['summary'])).toContain('Draft uid 21 permanently deleted');
        // Replaying never writes: every stored record is exactly as it was, and none has a summary.
        expect([...f.client.records.entries()]).toEqual(before); expect(JSON.stringify([...f.client.records.values()])).not.toContain('summary');
        // A reserved record replays as in_progress, with the explanation in the result.
        const pending = forTool('operation-replay-pending', 'send_draft', 22); expect((await f.store.reserve(pending, owner)).kind).toBe('acquired');
        const progress = await call('send_draft', { uid: 22, expectedVersion: digest, operationId: pending.operationId });
        expect(progress.isError).toBe(true); expect(Object.keys(progress.structuredContent)).toEqual(['summary', 'status', 'operationId']); expect(String(progress.structuredContent['summary'])).toContain('Retry the identical request');
        expect(JSON.stringify([...f.client.records.values()])).not.toContain('summary');
    });
});

describe('the preflight window of a write', () => {
    const context: MailContext = { accountId: key().accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:draft', 'mail:send', 'mail:modify'], connectionStatus: 'active' };
    const clientHash = hashOf(context.clientId);
    const draft = (operationId: string) => ({ to: [{ address: 'to@example.com' }], cc: [], bcc: [], subject: 'x', body: { text: 'x' }, attachments: [], operationId });
    const drafts = { mailboxId, path: 'Drafts', specialUse: '\\Drafts' };
    /** A writer whose draft preparation is `prepare`: by default it never finishes, whatever its budget. */
    const writer = (prepare: () => Promise<never> = () => new Promise(() => {})) => ({ resolveDraftMailbox: async () => drafts, prepareCreate: prepare }) as never;
    /** A writer that records every call by name: the Drafts lookup answers, any other read or write fails invalid_input. */
    const recording = (called: string[]) => new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : async () => {
        called.push(String(name)); if (name === 'resolveDraftMailbox') { return drafts; } throw new MailError('invalid_input');
    } }) as never;
    /** The store, observed: every call by name and the request time left when failPreflight starts; `over` replaces methods. */
    const observed = (store: MailOperationStore, seen: { calls: string[]; atFailure?: number | undefined }, over: Partial<MailOperationStore> = {}): MailOperationStore => {
        const methods: MailOperationStore = {
            getOperation: value => store.getOperation(value), reserve: (value, token) => store.reserve(value, token), markDispatched: value => store.markDispatched(value),
            failPreflight: async (value, receipt) => { seen.atFailure = remainingRequestTimeMs(); await store.failPreflight(value, receipt); },
            complete: (value, receipt) => store.complete(value, receipt), markOutcomeUnknown: (value, receipt) => store.markOutcomeUnknown(value, receipt), failDispatched: (value, receipt) => store.failDispatched(value, receipt), ...over,
        };
        return Object.fromEntries(Object.entries(methods).map(([name, method]: [string, (...args: unknown[]) => Promise<unknown>]) => [name, (...args: unknown[]) => { seen.calls.push(name); return method(...args); }])) as unknown as MailOperationStore;
    };
    let clock: ReturnType<typeof steppedClock>;
    beforeEach(() => { clock = steppedClock(); }); afterEach(() => { clock.restore(); });
    /** The window's clock moved on by ms: a step that took that long. */
    const advance = (ms: number) => { if (clock.state.frozen === undefined) { clock.state.skew += ms; } else { clock.state.frozen += ms; } };
    /** A reservation that takes ms. */
    const taking = (store: MailOperationStore, ms: number): Partial<MailOperationStore> => ({ reserve: async (value, token) => { const result = await store.reserve(value, token); advance(ms); return result; } });
    /** The first reservation commits while every answer to its transaction is lost; later ones are answered. */
    const unanswered = (f: ReturnType<typeof fixture>): Partial<MailOperationStore> => {
        let first = true;
        return { reserve: async (value, token) => { if (first) { first = false; f.client.fault = 'lost_persistent'; } try { return await f.store.reserve(value, token); } finally { f.client.fault = 'none'; } } };
    };
    const transacts = (client: ModelSender) => client.calls.filter(call => call instanceof TransactWriteCommand).length;
    const states = (client: ModelSender) => [...client.records.values()].map(item => (item['record'] as { state: string }).state);
    test('the reserve covers one throttled ledger operation and the response; admission covers a whole reservation, and a fresh request is admitted', async () => {
        expect(PREFLIGHT_RESERVE_MS).toBeGreaterThanOrEqual(DEFAULT_THROTTLE_TIMEOUT_MS + RESPONSE_RESERVE_MS);
        // Exact for the store's default: a reservation throttled for as long as it can be ends after RESERVE_ADMISSION_MS.
        expect(RESERVE_ADMISSION_MS).toBe(DEFAULT_THROTTLE_TIMEOUT_MS);
        const f = fixture(); f.client.failures.transact.push(...Array.from({ length: 50 }, () => cancelled('ProvisionedThroughputExceeded', 'ProvisionedThroughputExceeded')));
        await expect(f.store.reserve(intent(), owner)).rejects.toThrow('temporarily_unavailable');
        expect(f.virtual.clock.ms).toBe(RESERVE_ADMISSION_MS);
        // A fresh 60 s request whose getOperation was throttled for its whole 10 s and whose Drafts lookup took 10 s still reserves.
        expect(60_000 - PREFLIGHT_RESERVE_MS - DEFAULT_THROTTLE_TIMEOUT_MS - 10_000).toBeGreaterThanOrEqual(RESERVE_ADMISSION_MS);
        const g = fixture(); let prepared = false; clock.state.frozen = 1_000_000;
        const slow = { resolveDraftMailbox: async () => { advance(10_000); return drafts; }, prepareCreate: async () => { prepared = true; throw new MailError('invalid_input'); } } as never;
        const service = createMailService({ reader: {} as never, writer: slow, operations: observed(g.store, { calls: [] }, { getOperation: async value => { const record = await g.store.getOperation(value); advance(DEFAULT_THROTTLE_TIMEOUT_MS); return record; } }) });
        expect(await withRequestBudget(() => 60_000 - (performance.now() - 1_000_000), () => service.create_draft(context, draft('fresh-request-0001')))).toMatchObject({ status: 'failed', reason: 'invalid_input' });
        expect(prepared).toBe(true); expect(states(g.client)).toEqual(['settled']);
    });
    test('a preflight that would overrun is cut off at the window end, under its own budget, and its failure is recorded with the reserve left', async () => {
        const f = fixture(); const seen: { calls: string[]; atFailure?: number | undefined; inside?: number | undefined } = { calls: [] };
        const service = createMailService({ reader: {} as never, writer: writer(() => { seen.inside = remainingRequestTimeMs(); return new Promise(() => {}); }), operations: observed(f.store, seen, taking(f.store, RESERVE_ADMISSION_MS)) });
        // Admitted with 10.3 s of window; the reservation takes 10 s of it, leaving 0.3 s of preflight.
        const started = performance.now(); const real = Date.now(); const window = RESERVE_ADMISSION_MS + 300;
        const result = await withRequestBudget(() => PREFLIGHT_RESERVE_MS + window - (performance.now() - started), () => service.create_draft(context, draft('late-preflight-0001')));
        expect(result).toMatchObject({ status: 'failed', reason: 'upstream_timeout' });
        expect(Date.now() - real).toBeLessThan(1500);
        // Inside, the backend sees only the window; the failure is written with the full reserve of the request.
        expect(seen.inside).toBeLessThanOrEqual(300); expect(seen.inside).toBeGreaterThan(0);
        expect(seen.atFailure).toBeGreaterThan(PREFLIGHT_RESERVE_MS - 1000);
        expect(await f.store.getOperation(key('late-preflight-0001', clientHash))).toMatchObject({ state: 'settled', receipt: { status: 'failed', reason: 'upstream_timeout' } });
    });
    test('a late failure is recorded even when DynamoDB throttles it for nearly its whole throttle budget', async () => {
        const f = fixture();
        const throttles = () => { for (let i = 0; i < 5; i++) { f.client.failures.get.push(throttleError()); f.client.failures.transact.push(throttleError()); } };
        const service = createMailService({ reader: {} as never, writer: writer(() => { throttles(); return new Promise(() => {}); }), operations: observed(f.store, { calls: [] }, taking(f.store, RESERVE_ADMISSION_MS)) });
        const started = performance.now(); const window = RESERVE_ADMISSION_MS + 300;
        const result = await withRequestBudget(() => PREFLIGHT_RESERVE_MS + window - (performance.now() - started), () => service.create_draft(context, draft('late-throttled-0001')));
        expect(result).toMatchObject({ status: 'failed', reason: 'upstream_timeout' });
        // Five throttled reads and five throttled writes: 2 x (200 + 400 + 800 + 1600 + 1600) ms of backoff, inside 10 s.
        expect(f.virtual.clock.ms).toBe(9200); expect(f.virtual.clock.ms).toBeLessThan(DEFAULT_THROTTLE_TIMEOUT_MS);
        expect(states(f.client)).toEqual(['settled']);
    });
    test('a reservation that ends exactly at the window end leaves no preflight: it fails at once, before any backend call, with the whole reserve to record it', async () => {
        const f = fixture(); const seen: { calls: string[]; atFailure?: number | undefined } = { calls: [] }; let prepared = false; clock.state.frozen = 1_000_000;
        const service = createMailService({ reader: {} as never, writer: writer(() => { prepared = true; return new Promise(() => {}); }), operations: observed(f.store, seen, taking(f.store, RESERVE_ADMISSION_MS)) });
        const result = await withRequestBudget(() => PREFLIGHT_RESERVE_MS + RESERVE_ADMISSION_MS - (performance.now() - 1_000_000), () => service.create_draft(context, draft('edge-window-00001')));
        expect(result).toMatchObject({ status: 'failed', reason: 'upstream_timeout' });
        expect(prepared).toBe(false); expect(seen.atFailure).toBe(PREFLIGHT_RESERVE_MS); expect(states(f.client)).toEqual(['settled']);
    });
    test('a write reserves only with a whole reservation\'s time left in its window; below that nothing is stored or written', async () => {
        clock.state.frozen = 1_000_000;
        for (const window of [-1000, 0, RESPONSE_RESERVE_MS, RESERVE_ADMISSION_MS - 1, RESERVE_ADMISSION_MS, RESERVE_ADMISSION_MS + 1]) {
            const f = fixture(); const seen = { calls: [] as string[] }; let prepared = false;
            const service = createMailService({ reader: {} as never, writer: writer(async () => { prepared = true; throw new MailError('invalid_input'); }), operations: observed(f.store, seen) });
            const outcome = await withRequestBudget(() => PREFLIGHT_RESERVE_MS + window, () => service.create_draft(context, draft('admission-0000001'))).catch((error: unknown) => error);
            if (window < RESERVE_ADMISSION_MS) {
                expect(outcome).toMatchObject({ code: 'temporarily_unavailable' });
                expect({ window, records: f.client.records.size, transacts: transacts(f.client), prepared, calls: seen.calls }).toEqual({ window, records: 0, transacts: 0, prepared: false, calls: ['getOperation'] });
            } else {
                expect(outcome).toMatchObject({ status: 'failed', reason: 'invalid_input' });
                expect({ window, prepared, states: states(f.client) }).toEqual({ window, prepared: true, states: ['settled'] });
            }
        }
    });
    test('a write that starts with too little time left stores nothing, even with DynamoDB slow to answer, so its retry is not fenced', async () => {
        // The reviewer's case: send_draft with 22.2 s of the request left; DynamoDB commits a transaction at once but answers after 300 ms.
        const records = new Map<string, Record<string, unknown>>(); let transactions = 0; const called: string[] = [];
        const client: DynamoSender = { async send(command) {
            if (command instanceof GetCommand) { return { Item: structuredClone(records.get(String(command.input.Key?.pk))) }; }
            if (!(command instanceof TransactWriteCommand)) { throw new Error('unexpected command'); }
            transactions++;
            for (const item of command.input.TransactItems ?? []) {
                if (item.Put?.Item) { records.set(String(item.Put.Item.pk), structuredClone(item.Put.Item)); }
                if (item.Delete?.Key) { records.delete(String(item.Delete.Key.pk)); }
            }
            await Bun.sleep(300); return {};
        } };
        const service = createMailService({ reader: {} as never, writer: recording(called), operations: new DynamoMailOperationStore({ tableName: 'MailTable', client }) });
        const args = { uid: 1, expectedVersion: digest, operationId: 'ambiguous-reserve-0001' };
        const started = performance.now();
        await expect(withRequestBudget(() => 22_200 - (performance.now() - started), () => service.send_draft(context, args))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        expect({ transactions, records: records.size, called }).toEqual({ transactions: 0, records: 0, called: ['resolveDraftMailbox'] });
        // Nothing was left reserved: the identical retry, with time enough, reserves the draft and records its preflight failure.
        expect(await service.send_draft(context, args)).toMatchObject({ status: 'failed', reason: 'invalid_input' });
        expect([...records.values()].map(item => (item['record'] as { state: string }).state)).toEqual(['settled']);
    });
    test('a reservation that committed but whose answer was lost or aborted is proved ours by its owner token and settled as a failure that releases the draft', async () => {
        for (const { budget, fault } of [undefined, 60_000].flatMap(budget => (['lost', 'aborted'] as const).map(fault => ({ budget, fault })))) {
            const f = fixture(); const seen = { calls: [] as string[] }; const called: string[] = []; const reads: (number | undefined)[] = [];
            // Aborted: the store gives up on its transaction after 50 ms; DynamoDB has committed it and answers after 300 ms.
            let late = true;
            const slow: DynamoSender = { async send(command) { const result = await f.client.send(command as GetCommand | TransactWriteCommand); if (command instanceof TransactWriteCommand && late) { late = false; await Bun.sleep(300); } return result; } };
            const store = fault === 'lost' ? f.store : new DynamoMailOperationStore({ tableName: 'MailTable', client: slow, timeoutMs: 50 });
            const reading = { getOperation: (value: OperationKey) => { reads.push(remainingRequestTimeMs()); return store.getOperation(value); } };
            const service = createMailService({ reader: {} as never, writer: recording(called), operations: observed(store, seen, { ...(fault === 'lost' ? unanswered(f) : {}), ...reading }) });
            const args = { uid: 1, expectedVersion: digest, operationId: 'unanswered-reserve-01' };
            const run = () => service.send_draft(context, args);
            const first = await (budget === undefined ? run() : withRequestBudget(() => budget, run));
            expect({ fault, first }).toMatchObject({ fault, first: { status: 'failed', reason: 'temporarily_unavailable' } });
            expect(seen.calls).toEqual(['getOperation', 'reserve', 'getOperation', 'failPreflight']);
            // Without a request budget the read-back has none; with one, it ends a whole settlement before the request.
            if (budget === undefined) { expect(reads).toEqual([undefined, undefined]); } else { expect(reads[1]).toBeLessThanOrEqual(budget - DEFAULT_THROTTLE_TIMEOUT_MS - RESPONSE_RESERVE_MS); expect(reads[1]).toBeGreaterThan(budget - DEFAULT_THROTTLE_TIMEOUT_MS - RESPONSE_RESERVE_MS - 1000); }
            // Settled, and the guard released with it; no backend call but the Drafts lookup was made.
            expect(states(f.client)).toEqual(['settled']); expect(called).toEqual(['resolveDraftMailbox']);
            // The identical retry replays the failure, not in_progress; a new operation on the same draft reserves it.
            expect(await service.send_draft(context, args)).toMatchObject({ status: 'failed', reason: 'temporarily_unavailable' });
            expect(await service.send_draft(context, { ...args, operationId: 'after-settled-0002' })).toMatchObject({ status: 'failed', reason: 'invalid_input' });
            expect(called).toEqual(['resolveDraftMailbox', 'resolveDraftMailbox', 'inspectMessage']);
        }
    });
    test('recovering an owned reservation keeps a whole throttled settlement: a slow read-back is cut short instead, and nothing is touched', async () => {
        // The reviewer's case: admitted with exactly 30 s left; the reservation commits, throttled, and its answer is lost
        // after 9.475 s; the read-back is throttled `throttles` times; failPreflight then is throttled for 9.4 s.
        const settlement = DEFAULT_THROTTLE_TIMEOUT_MS + RESPONSE_RESERVE_MS; clock.state.frozen = 1_000_000;
        const outcomes: Record<number, string> = {};
        for (const throttles of [0, 3, 6, 7, 8]) {
            const f = fixture(); const seen = { calls: [] as string[] }; let reads = 0; const readBack: { inside?: number | undefined; outside?: number } = {}; let atFailure: number | undefined;
            const store = new DynamoMailOperationStore({ tableName: 'MailTable', client: f.client, retry: { ...f.virtual.retry, sleep: async ms => { f.virtual.clock.ms += ms; advance(ms); } } });
            const service = createMailService({ reader: {} as never, writer: recording([]), operations: observed(store, seen, {
                reserve: async (value, token) => {
                    f.client.failures.transact.push(...Array.from({ length: 8 }, () => throttleError())); f.client.fault = 'lost_persistent';
                    try { return await store.reserve(value, token); } finally { f.client.fault = 'none'; }
                },
                getOperation: value => {
                    if (++reads === 2) { readBack.inside = remainingRequestTimeMs(); readBack.outside = 30_000 - f.virtual.clock.ms; f.client.failures.get.push(...Array.from({ length: throttles }, () => throttleError())); }
                    return store.getOperation(value);
                },
                failPreflight: async (value, receipt) => {
                    atFailure = remainingRequestTimeMs(); f.client.failures.get.push(...Array.from({ length: 8 }, () => throttleError()));
                    await store.failPreflight(value, receipt);
                },
            }) });
            const args = { uid: 1, expectedVersion: digest, operationId: 'slow-read-back-0001' };
            const outcome = await withRequestBudget(() => 30_000 - f.virtual.clock.ms, () => service.send_draft(context, args)).catch((error: unknown) => error);
            // The read-back sees only what is left beyond a whole settlement.
            expect(readBack.inside).toBe((readBack.outside ?? 0) - settlement);
            if (seen.calls.includes('failPreflight')) {
                expect(atFailure).toBeGreaterThanOrEqual(settlement);
                expect({ throttles, outcome, states: states(f.client) }).toMatchObject({ throttles, outcome: { status: 'failed', reason: 'temporarily_unavailable' }, states: ['settled'] });
                outcomes[throttles] = 'settled';
            } else {
                // The documented residual: nothing proved, nothing touched; the draft stays fenced and the retry is in_progress.
                expect({ throttles, outcome, states: states(f.client) }).toMatchObject({ throttles, outcome: { code: 'temporarily_unavailable' }, states: ['reserved', 'reserved'] });
                expect(await service.send_draft(context, args)).toMatchObject({ status: 'in_progress' });
                outcomes[throttles] = 'reserved';
            }
        }
        expect(outcomes).toEqual({ 0: 'settled', 3: 'settled', 6: 'settled', 7: 'reserved', 8: 'reserved' });
    });
    test('with no more than a settlement left after the reservation, the read-back is skipped; with a little more, it runs and the reservation is settled', async () => {
        for (const [took, expected] of [[30_000 - DEFAULT_THROTTLE_TIMEOUT_MS - RESPONSE_RESERVE_MS, 'reserved'], [30_000 - DEFAULT_THROTTLE_TIMEOUT_MS - RESPONSE_RESERVE_MS - 4000, 'settled']] as const) {
            const f = fixture(); const seen = { calls: [] as string[] }; clock.state.frozen = 1_000_000;
            // A store with a longer throttle budget: its reservation commits, takes `took` ms and loses its answer.
            const service = createMailService({ reader: {} as never, writer: recording([]), operations: observed(f.store, seen, {
                reserve: async (value, token) => { await f.store.reserve(value, token); advance(took); throw new MailError('temporarily_unavailable'); },
            }) });
            const outcome = await withRequestBudget(() => 30_000 - (performance.now() - 1_000_000), () => service.send_draft(context, { uid: 1, expectedVersion: digest, operationId: 'late-read-back-0001' })).catch((error: unknown) => error);
            if (expected === 'reserved') {
                expect({ outcome, calls: seen.calls, states: states(f.client) }).toMatchObject({ outcome: { code: 'temporarily_unavailable' }, calls: ['getOperation', 'reserve'], states: ['reserved', 'reserved'] });
            } else {
                expect({ outcome, calls: seen.calls, states: states(f.client) }).toMatchObject({ outcome: { status: 'failed', reason: 'temporarily_unavailable' }, calls: ['getOperation', 'reserve', 'getOperation', 'failPreflight'], states: ['settled'] });
            }
        }
    });
    test('a reservation another request won is never touched by the read-back: the outcome stays unknown, as before', async () => {
        const f = fixture(); const seen = { calls: [] as string[] }; const called: string[] = []; const rival = 'rival-owner-token-'.padEnd(43, 'r');
        const service = createMailService({ reader: {} as never, writer: recording(called), operations: observed(f.store, seen, {
            // An identical concurrent request reserves first; this call's own attempt then fails without an answer.
            reserve: async value => { await f.store.reserve(value, rival); throw new MailError('temporarily_unavailable'); },
        }) });
        const args = { uid: 1, expectedVersion: digest, operationId: 'rival-reserve-00001' };
        await expect(withRequestBudget(() => 60_000, () => service.send_draft(context, args))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        expect(seen.calls).toEqual(['getOperation', 'reserve', 'getOperation']); expect(transacts(f.client)).toBe(1);
        expect(await f.store.getOperation(key(args.operationId, clientHash))).toMatchObject({ state: 'reserved', ownerToken: rival, revision: 0 });
        expect(states(f.client)).toEqual(['reserved', 'reserved']);
        expect(await service.send_draft(context, args)).toMatchObject({ status: 'in_progress' }); expect(called).toEqual(['resolveDraftMailbox']);
    });
    test('a failed reservation with no record, or whose read-back fails, is temporarily_unavailable and writes nothing more', async () => {
        for (const readBack of ['absent', 'fails'] as const) {
            const f = fixture(); const seen = { calls: [] as string[] }; let reads = 0;
            const service = createMailService({ reader: {} as never, writer: recording([]), operations: observed(f.store, seen, {
                reserve: () => Promise.reject(new MailError('temporarily_unavailable')),
                getOperation: value => ++reads === 2 && readBack === 'fails' ? Promise.reject(new MailError('temporarily_unavailable')) : f.store.getOperation(value),
            }) });
            await expect(withRequestBudget(() => 60_000, () => service.send_draft(context, { uid: 1, expectedVersion: digest, operationId: 'absent-reserve-00001' }))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
            expect({ readBack, calls: seen.calls, transacts: transacts(f.client), records: f.client.records.size }).toEqual({ readBack, calls: ['getOperation', 'reserve', 'getOperation'], transacts: 0, records: 0 });
        }
    });
    test.each(['create_draft', 'update_draft', 'send_draft', 'move_message'] as const)('%s: neither a refused admission nor a settled unanswered reservation reaches the backend or dispatches', async tool => {
        const args = (operationId: string) => tool === 'create_draft' ? draft(operationId) : tool === 'update_draft' ? { uid: 1, expectedVersion: digest, subject: 'y', operationId } : tool === 'send_draft' ? { uid: 1, expectedVersion: digest, operationId } : { mailboxId, uid: 1, expectedVersion: digest, destinationMailboxId: 'b'.repeat(24), operationId };
        const run = (service: MailService, operationId: string) => (service[tool] as unknown as (context: MailContext, input: unknown) => Promise<unknown>)(context, args(operationId));
        const lookups = tool === 'move_message' ? [] : ['resolveDraftMailbox']; clock.state.frozen = 1_000_000;
        const refused = fixture(); const seen = { calls: [] as string[] }; const called: string[] = [];
        await expect(withRequestBudget(() => PREFLIGHT_RESERVE_MS + RESERVE_ADMISSION_MS - 1, () => run(createMailService({ reader: {} as never, writer: recording(called), operations: observed(refused.store, seen) }), 'refused-00000001'))).rejects.toMatchObject({ code: 'temporarily_unavailable' });
        expect({ calls: seen.calls, called, transacts: transacts(refused.client) }).toEqual({ calls: ['getOperation'], called: lookups, transacts: 0 });
        const lost = fixture(); const lostSeen = { calls: [] as string[] }; const lostCalled: string[] = [];
        expect(await withRequestBudget(() => 60_000, () => run(createMailService({ reader: {} as never, writer: recording(lostCalled), operations: observed(lost.store, lostSeen, unanswered(lost)) }), 'unanswered-000001'))).toMatchObject({ status: 'failed', reason: 'temporarily_unavailable' });
        expect({ calls: lostSeen.calls, called: lostCalled, states: states(lost.client) }).toEqual({ calls: ['getOperation', 'reserve', 'getOperation', 'failPreflight'], called: lookups, states: ['settled'] });
    });
    test('without a request budget, or with most of the Lambda left, a slow preflight is not cut off', async () => {
        for (const budget of [undefined, 60_000]) {
            const f = fixture(); let inside: number | undefined = -1;
            const slow = async (): Promise<never> => { inside = remainingRequestTimeMs(); await Bun.sleep(300); throw new MailError('invalid_input'); };
            const service = createMailService({ reader: {} as never, writer: writer(slow), operations: f.store });
            const run = () => service.create_draft(context, draft('slow-preflight-0001'));
            expect(await (budget === undefined ? run() : withRequestBudget(() => budget, run))).toMatchObject({ status: 'failed', reason: 'invalid_input' });
            if (budget === undefined) { expect(inside).toBeUndefined(); } else { expect(inside).toBeLessThanOrEqual(budget - PREFLIGHT_RESERVE_MS); expect(inside).toBeGreaterThan(budget - PREFLIGHT_RESERVE_MS - 200); }
        }
    });
});
