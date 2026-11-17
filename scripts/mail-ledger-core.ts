/**
 * Decisions and command logic for scripts/mail-ledger.ts. No AWS import lives here: the planning functions are
 * pure (scanned items in, planned writes out) and the commands talk to the table only through the small
 * LedgerClient interface, so tests drive them with an in-memory fake.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { DraftGuardRecord, MailOperationRecord, OperationKey } from '../src/mail/contracts';
import { guardKey, guardSchema, itemSchema, operation, opKey, RECORD_TTL_SECONDS } from '../src/mail/dynamo-store';
import { HOLD_AGED_MS, holdAction, SEND_CHECK_AGED_MS, type HoldAction } from '../src/mail/service';

/** The two item kinds this script may read or write. Every other kind in the table is never touched. */
export const OPERATION_PK_PREFIX = 'wildduck-mcp#mail-operation#';
export const GUARD_PK_PREFIX = 'wildduck-mcp#mail-guard#';
export const DEFAULT_TABLE = 'wildduck-mcp-prod-state';
export const DEFAULT_REGION = 'us-west-2';

export type RawItem = Record<string, unknown>;
export interface ItemKey { pk: string; sk: string }

export interface ParsedGuard { readonly pk: string; readonly raw: unknown; readonly record: DraftGuardRecord; readonly expiresAt: number | undefined }
export interface ParsedOperation { readonly pk: string; readonly record: MailOperationRecord; readonly expiresAt: number | undefined }

/** Reads one scanned guard item with the store's own schema. Undefined when it is not a well-formed guard. */
export function parseGuardItem(item: RawItem): ParsedGuard | undefined {
    const { pk, sk, ...rest } = item;
    if (typeof pk !== 'string' || sk !== 'STATE') { return undefined; }
    const parsed = itemSchema(guardSchema).safeParse(rest);
    if (!parsed.success) { return undefined; }
    try {
        if (guardKey(parsed.data.record.key).pk !== pk) { return undefined; }
    } catch { return undefined; }
    return { pk, raw: parsed.data.record, record: parsed.data.record, expiresAt: parsed.data.expiresAt };
}

/** Reads one scanned operation item with the store's own reader (which also accepts the stored operation_id spelling). */
export function parseOperationItem(item: RawItem): ParsedOperation | undefined {
    const { pk, sk, ...rest } = item;
    if (typeof pk !== 'string' || sk !== 'STATE') { return undefined; }
    const parsed = itemSchema(z.unknown()).safeParse(rest);
    if (!parsed.success) { return undefined; }
    try {
        const stored = parsed.data.record;
        const key = typeof stored === 'object' && stored !== null && 'key' in stored ? stored.key as OperationKey : undefined;
        if (key === undefined) { return undefined; }
        const record = operation(stored, key);
        if (opKey(record.key).pk !== pk) { return undefined; }
        return { pk, record, expiresAt: parsed.data.expiresAt };
    } catch { return undefined; }
}

/** The key of the operation a guard names. */
export const ownerPk = (guard: DraftGuardRecord): string => opKey(guard.operation).pk;

export type GuardDecision =
    | 'delete_owner_missing'
    | 'delete_finished_hold'
    | 'delete_unknown_outcome_old'
    | 'keep_held_update_draft'
    | 'leave_send_draft_unknown'
    | 'leave_in_flight'
    | 'leave_owner_unreadable'
    | 'leave_owner_mismatch'
    | 'leave_current_version';
export const GUARD_DECISIONS: readonly GuardDecision[] = ['delete_owner_missing', 'delete_finished_hold', 'delete_unknown_outcome_old', 'keep_held_update_draft', 'leave_send_draft_unknown', 'leave_in_flight', 'leave_owner_unreadable', 'leave_owner_mismatch', 'leave_current_version'];
export const DECISION_LABELS: Record<GuardDecision, string> = {
    delete_owner_missing: 'delete: owning operation record is missing',
    delete_finished_hold: 'delete: hold already ended (retired or queued)',
    delete_unknown_outcome_old: 'delete: old unknown outcome, not a send',
    keep_held_update_draft: 'keep: update_draft with both copies alive (real hold)',
    leave_send_draft_unknown: 'leave: send_draft with unknown outcome and no reservedAt (the server never checks it; it expires after 90 days)',
    leave_in_flight: 'leave: reserved, or has reservedAt (server times it out)',
    leave_owner_unreadable: 'leave: owning operation record could not be read',
    leave_owner_mismatch: 'leave: lock and record disagree (changed during the scan)',
    leave_current_version: 'leave: has expiresAt, written by the current version (the server handles it)',
};

export interface PlannedDelete {
    readonly kind: 'delete_guard';
    readonly pk: string;
    /** The guard's record exactly as scanned: the delete is conditional on it still being equal. */
    readonly before: unknown;
    readonly decision: GuardDecision;
    readonly tool: string;
    /** The guard as scanned: its ownerToken and revision must match the owner's when the delete is made. */
    readonly guard: DraftGuardRecord;
    /** The owning operation's key. Every delete re-reads it with a consistent read first (a scan is not a snapshot). */
    readonly ownerPk: string;
}
export interface PlannedExpiry {
    readonly kind: 'set_expiry';
    readonly pk: string;
    readonly item: 'operation' | 'guard';
    readonly expiresAt: number;
    readonly tool: string;
}
export type PlannedAction = PlannedDelete | PlannedExpiry;

export interface Plan {
    readonly actions: readonly PlannedAction[];
    readonly scanned: { readonly operations: number; readonly guards: number; readonly ignored: number; readonly unreadable: number };
    readonly guardDecisions: Readonly<Record<GuardDecision, number>>;
    readonly operationsWithoutExpiry: number;
    readonly operationsWithExpiry: number;
    /** Planned writes per owning tool ("(owner missing)" for an orphan guard). */
    readonly byTool: Readonly<Record<string, number>>;
    /** Keys of items that could not be read; they are never written. */
    readonly unreadablePks: readonly string[];
}

const ORPHAN_TOOL = '(owner missing)';
const heldPartial = (owner: MailOperationRecord): boolean =>
    owner.intent.tool === 'update_draft' && owner.state === 'settled' && owner.receipt.status === 'partial'
    && 'reason' in owner.receipt && (owner.receipt.reason === 'original_deletion_failed' || owner.receipt.reason === 'original_deletion_unconfirmed');

/** A guard and its owner belong together when they carry the same owner token and revision: the store writes both in one transaction with the same new revision. */
export const belongTogether = (guard: DraftGuardRecord, owner: MailOperationRecord): boolean => guard.ownerToken === owner.ownerToken && guard.revision === owner.revision;

/** The decision for one LEGACY guard (no expiresAt) given its owner (undefined = no such record anywhere in the scan). */
export function decideGuard(guard: DraftGuardRecord, owner: MailOperationRecord | undefined): GuardDecision {
    if (owner === undefined) { return 'delete_owner_missing'; }
    if (!belongTogether(guard, owner)) { return 'leave_owner_mismatch'; }
    // Both copies of a half-updated draft are alive: this guard is a real hold whatever state it carries.
    if (heldPartial(owner)) { return 'keep_held_update_draft'; }
    if (guard.state === 'retired' || guard.state === 'queued') { return 'delete_finished_hold'; }
    if (guard.state === 'outcome_unknown' || guard.state === 'dispatched') {
        // The server cannot know the age of a send without reservedAt, so it never checks one; the row is left to expire.
        if (owner.intent.tool === 'send_draft') { return owner.reservedAt === undefined ? 'leave_send_draft_unknown' : 'leave_in_flight'; }
        return owner.reservedAt === undefined ? 'delete_unknown_outcome_old' : 'leave_in_flight';
    }
    return 'leave_in_flight';
}

/** Scanned items in, planned writes out. Pure: no clock (nowSeconds is passed) and no AWS. */
export function planCleanup(items: readonly RawItem[], nowSeconds: number): Plan {
    const operations = new Map<string, ParsedOperation>();
    const guards = new Map<string, ParsedGuard>();
    const unreadablePks = new Set<string>();
    let ignored = 0;
    for (const item of items) {
        const pk = item.pk;
        if (typeof pk === 'string' && pk.startsWith(OPERATION_PK_PREFIX)) {
            const parsed = parseOperationItem(item);
            if (parsed) { operations.set(pk, parsed); } else { unreadablePks.add(pk); }
        } else if (typeof pk === 'string' && pk.startsWith(GUARD_PK_PREFIX)) {
            const parsed = parseGuardItem(item);
            if (parsed) { guards.set(pk, parsed); } else { unreadablePks.add(pk); }
        } else { ignored += 1; }
    }
    const expiresAt = nowSeconds + RECORD_TTL_SECONDS;
    const guardActions: PlannedAction[] = [];
    const operationActions: PlannedAction[] = [];
    const guardDecisions = Object.fromEntries(GUARD_DECISIONS.map(decision => [decision, 0])) as Record<GuardDecision, number>;
    for (const guard of guards.values()) {
        const ownerKey = ownerPk(guard.record);
        const owner = operations.get(ownerKey);
        // Only a legacy guard (no expiresAt) is this script's business: every Put since 0.11.0 writes expiresAt, so a guard that has it belongs to the running server.
        const decision: GuardDecision = guard.expiresAt !== undefined ? 'leave_current_version' : unreadablePks.has(ownerKey) ? 'leave_owner_unreadable' : decideGuard(guard.record, owner?.record);
        guardDecisions[decision] += 1;
        const tool = owner?.record.intent.tool ?? ORPHAN_TOOL;
        if (decision === 'leave_current_version') { continue; }
        if (decision.startsWith('delete_')) {
            guardActions.push({ kind: 'delete_guard', pk: guard.pk, before: guard.raw, guard: guard.record, decision, tool, ownerPk: ownerKey });
        } else {
            guardActions.push({ kind: 'set_expiry', pk: guard.pk, item: 'guard', expiresAt, tool });
        }
    }
    let withExpiry = 0;
    let withoutExpiry = 0;
    for (const owner of operations.values()) {
        // An operation item that already has expiresAt was written by the current version and needs nothing.
        if (owner.expiresAt === undefined) {
            withoutExpiry += 1;
            operationActions.push({ kind: 'set_expiry', pk: owner.pk, item: 'operation', expiresAt, tool: owner.record.intent.tool });
        } else { withExpiry += 1; }
    }
    const actions = [...guardActions, ...operationActions];
    const byTool: Record<string, number> = {};
    for (const action of actions) { byTool[action.tool] = (byTool[action.tool] ?? 0) + 1; }
    return {
        actions,
        scanned: { operations: operations.size, guards: guards.size, ignored, unreadable: unreadablePks.size },
        guardDecisions,
        operationsWithoutExpiry: withoutExpiry,
        operationsWithExpiry: withExpiry,
        byTool,
        unreadablePks: [...unreadablePks].sort(),
    };
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const when = (seconds: number | undefined, none: string): string => seconds === undefined ? none : iso(seconds);
const receiptOf = (owner: MailOperationRecord): { status: string; reason: string | undefined } | undefined => {
    if (owner.state !== 'settled') { return undefined; }
    return { status: owner.receipt.status, reason: 'reason' in owner.receipt ? owner.receipt.reason : undefined };
};

const minutes = (ms: number): number => Math.floor(ms / 60_000);
const LEGACY_SEND = 'The outcome of this send is unknown and its record has no reservedAt, so the server cannot tell its age and never checks it; the row stays until it expires 90 days after it was last written. Look in WildDuck (Sent and Drafts) and settle it by hand.';

/**
 * One plain-English line for what the server will do with a hold: the server's own rule table (holdAction) decides, this
 * only words each of its actions. The switch is exhaustive, so an action added to the server fails to compile here.
 * `owner` is the record the guard names (undefined: gone); `nowMs` is the clock holdAction was given.
 */
export function describeHold(action: HoldAction, owner: MailOperationRecord | undefined, nowMs: number): string {
    const tool = owner?.intent.tool ?? 'the operation';
    const legacySend = owner?.intent.tool === 'send_draft' && owner.reservedAt === undefined;
    switch (action.act) {
        case 'none': {
            // Young: the table only says "not yet". The wait is the one holdAction applies to this owner.
            const limit = owner?.state !== 'reserved' && owner?.intent.tool === 'send_draft' ? SEND_CHECK_AGED_MS : HOLD_AGED_MS;
            const reservedAt = owner?.reservedAt;
            if (legacySend) { return LEGACY_SEND; }
            const readyAt = reservedAt === undefined ? '' : ` (from ${iso(reservedAt + limit / 1000)}, in ${Math.max(0, Math.ceil((reservedAt * 1000 + limit - nowMs) / 1000))} seconds)`;
            if (owner?.state === 'reserved') { return `A write is in progress or just died; the server leaves it alone until it is ${minutes(limit)} minutes old${readyAt}, then the next request that touches this message settles it as failed and deletes the lock.`; }
            if (owner?.intent.tool === 'send_draft') { return `The outcome of this send is unknown; the server leaves it alone until it is ${minutes(limit)} minutes old${readyAt}, then the next request for it looks in WildDuck. Retry the same request later.`; }
            return `The change may still be running; the server leaves it alone until it is ${minutes(limit)} minutes old${readyAt}, then the next request that touches this message deletes the lock and the record stays as it is.`;
        }
        case 'fail':
            return 'The request that took this lock died or never finished; the next request that touches this message settles it as failed and deletes the lock.';
        case 'release':
            if (action.from === 'expired') { return 'The operation record for this lock is gone (expired or never written), so the lock is abandoned; the next request that touches this message deletes it.'; }
            if (action.from === 'leftover') { return `The hold already ended when ${tool} settled and nothing waits on it; the next request that touches this message deletes the lock.`; }
            if (action.from === 'dispatched' || action.from === 'unknown') { return 'The outcome of this change is unknown and old; the record stays as it is (dispatched or outcome_unknown), and the next request that touches this message deletes the lock. The agent re-reads the message and retries under a new operationId.'; }
            return 'The next request that touches this message deletes the lock.';
        case 'check_send':
            return legacySend
                ? LEGACY_SEND
                : 'The outcome of this send is unknown and old enough to check: the next request for it looks in WildDuck, settles it queued if the copy is in Sent, failed if the draft is still in Drafts, or leaves it outcome_unknown if neither is found, and deletes the lock.';
        case 'keep_original':
            return 'update_draft finished halfway and both copies of the draft are alive, so this lock is a real hold on the original; it ends when a delete_draft of the original takes it over, or when the row expires 90 days after it was last written.';
        default: {
            const unreachable: never = action;
            return unreachable;
        }
    }
}

/** What `show` prints as "meaning": holdAction's answer for this owner, worded. */
export const explainHold = (owner: MailOperationRecord | undefined, nowMs: number): string => describeHold(holdAction(owner, nowMs), owner, nowMs);

// ---------------------------------------------------------------- AWS boundary

export interface ScanPage { items: RawItem[]; lastKey: RawItem | undefined }
export type WriteOutcome = 'applied' | 'condition_failed';
/** The whole AWS surface of the script. The real implementation is in mail-ledger.ts. */
export interface LedgerClient {
    /** One eventually consistent Scan page over the two mail key prefixes. */
    scanPage(startKey: RawItem | undefined, limit: number): Promise<ScanPage>;
    /** Strongly consistent GetItem; undefined when the item does not exist. */
    getItem(key: ItemKey): Promise<RawItem | undefined>;
    /** SET expiresAt, only while the item exists and has no expiresAt. */
    setExpiresAt(key: ItemKey, expiresAt: number): Promise<WriteOutcome>;
    /** Delete, only while the item's record still equals `before`. */
    deleteGuard(key: ItemKey, before: unknown): Promise<WriteOutcome>;
}
export interface Pacing {
    sleep: (ms: number) => Promise<void>;
    pageSize: number;
    pageDelayMs: number;
    /** Pause after every write (and every verification read): about one per second for 1 WCU. */
    writeDelayMs: number;
    maxAttempts: number;
    retryBaseMs: number;
}
export const DEFAULT_PACING: Pacing = {
    sleep: (ms) => new Promise<void>(resolve => { setTimeout(resolve, ms); }),
    pageSize: 25,
    pageDelayMs: 1000,
    writeDelayMs: 1000,
    maxAttempts: 6,
    retryBaseMs: 1000,
};
const THROTTLE_NAMES = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException']);
export const isThrottle = (error: unknown): boolean => typeof error === 'object' && error !== null && THROTTLE_NAMES.has(String((error as { name?: unknown }).name));

/** Retries a throttled call with doubling backoff; any other error, or the last throttle, is thrown. */
export async function withRetry<T>(call: () => Promise<T>, pacing: Pacing): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try { return await call(); }
        catch (error) {
            if (!isThrottle(error) || attempt >= pacing.maxAttempts) { throw error; }
            await pacing.sleep(pacing.retryBaseMs * 2 ** (attempt - 1));
        }
    }
}

export async function scanAll(client: LedgerClient, pacing: Pacing): Promise<{ items: RawItem[]; pages: number }> {
    const items: RawItem[] = [];
    let pages = 0;
    let startKey: RawItem | undefined;
    do {
        if (pages > 0) { await pacing.sleep(pacing.pageDelayMs); }
        const lastStart = startKey;
        const page = await withRetry(() => client.scanPage(lastStart, pacing.pageSize), pacing);
        items.push(...page.items);
        startKey = page.lastKey;
        pages += 1;
    } while (startKey !== undefined);
    return { items, pages };
}

export interface ApplyResult {
    applied: number;
    /** Condition failed, or the owner re-read before a guard delete no longer matched: the item changed since the scan, so it was left alone. */
    skipped: number;
    appliedDeletes: number;
    appliedExpiries: number;
    skippedPks: string[];
    /** Set when a write failed for good; the run stopped there. */
    error: unknown;
}

/** Whether the planned delete still holds against the owner as it is now: the guard and the fresh owner belong together (same ownerToken and revision) and classify to the same delete. */
export function stillDeletable(action: PlannedDelete, ownerItem: RawItem | undefined): boolean {
    if (ownerItem === undefined) { return action.decision === 'delete_owner_missing'; }
    const owner = parseOperationItem(ownerItem);
    if (!owner || opKey(owner.record.key).pk !== action.ownerPk) { return false; }
    return belongTogether(action.guard, owner.record) && decideGuard(action.guard, owner.record) === action.decision;
}

/** Sequential, paced single-item writes. Stops at the first write that fails after its retries. */
export async function applyPlan(client: LedgerClient, plan: Plan, pacing: Pacing): Promise<ApplyResult> {
    const result: ApplyResult = { applied: 0, skipped: 0, appliedDeletes: 0, appliedExpiries: 0, skippedPks: [], error: undefined };
    const skip = (pk: string) => { result.skipped += 1; result.skippedPks.push(pk); };
    try {
        for (const action of plan.actions) {
            const key: ItemKey = { pk: action.pk, sk: 'STATE' };
            if (action.kind === 'delete_guard') {
                // The scan is not a snapshot: pages are read at different times, so the owner snapshot may be stale (a settlement can have
                // turned this guard into a real hold). Read the owner again, exactly, and decide again from that before deleting.
                const ownerItem = await withRetry(() => client.getItem({ pk: action.ownerPk, sk: 'STATE' }), pacing);
                await pacing.sleep(pacing.writeDelayMs);
                if (!stillDeletable(action, ownerItem)) { skip(action.pk); continue; }
            }
            const outcome = action.kind === 'delete_guard'
                ? await withRetry(() => client.deleteGuard(key, action.before), pacing)
                : await withRetry(() => client.setExpiresAt(key, action.expiresAt), pacing);
            if (outcome === 'applied') {
                result.applied += 1;
                if (action.kind === 'delete_guard') { result.appliedDeletes += 1; } else { result.appliedExpiries += 1; }
            } else { skip(action.pk); }
            await pacing.sleep(pacing.writeDelayMs);
        }
    } catch (error) { result.error = error; }
    return result;
}

// ---------------------------------------------------------------- commands

export interface Output { stdout: (value: string) => void; stderr: (value: string) => void }
export interface CliDeps {
    /** Called once arguments are valid; the real one builds the DynamoDB client from the default credential chain. */
    makeClient: (options: { table: string; region: string }) => LedgerClient;
    nowMs: () => number;
    pacing: Pacing;
}

export const USAGE = `Usage: bun scripts/mail-ledger.ts <command> [options]

Commands:
  show <accountId> <mailboxId> <uid>      Print the lock on a message, its owning operation and what the server will do about it.
                                          Reads two items; writes nothing.
  cleanup [--apply]                       One-time migration after 0.11.0: one paced Scan, then delete finished locks and set
                                          expiresAt on items written before 0.11.0 (items that already have expiresAt are left alone).
                                          Dry run (writes nothing) unless --apply is given.

Options:
  --table <name>    Table (default ${DEFAULT_TABLE})
  --region <name>   AWS region (default ${DEFAULT_REGION})
  --apply           cleanup only: perform the writes
  --verbose         cleanup only: also print the key of every item acted on
  --help            This message

Runs with your own AWS credentials (default credential chain). It never prints ownerToken or payloadDigest.
`;

class UsageError extends Error {}

interface Parsed { command: 'show' | 'cleanup'; positionals: string[]; table: string; region: string; apply: boolean; verbose: boolean }

function parseCli(argv: readonly string[]): Parsed | 'help' {
    let parsed;
    try {
        parsed = parseArgs({
            args: [...argv],
            allowPositionals: true,
            strict: true,
            options: { table: { type: 'string' }, region: { type: 'string' }, apply: { type: 'boolean' }, verbose: { type: 'boolean' }, help: { type: 'boolean' } },
        });
    } catch (error) { throw new UsageError(error instanceof Error ? error.message : 'invalid arguments'); }
    const { values, positionals } = parsed;
    if (values.help === true) { return 'help'; }
    const [command, ...rest] = positionals;
    if (command !== 'show' && command !== 'cleanup') { throw new UsageError(command === undefined ? 'missing command' : `unknown command: ${command}`); }
    if (command === 'cleanup' ? rest.length !== 0 : rest.length !== 3) { throw new UsageError(command === 'cleanup' ? 'cleanup takes no positional arguments' : 'show needs <accountId> <mailboxId> <uid>'); }
    if (values.apply === true && command !== 'cleanup') { throw new UsageError('--apply is only for cleanup'); }
    if (values.verbose === true && command !== 'cleanup') { throw new UsageError('--verbose is only for cleanup'); }
    const table = values.table ?? DEFAULT_TABLE;
    const region = values.region ?? DEFAULT_REGION;
    if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(table)) { throw new UsageError('invalid --table'); }
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/u.test(region)) { throw new UsageError('invalid --region'); }
    return { command, positionals: rest, table, region, apply: values.apply === true, verbose: values.verbose === true };
}

/** The guard key from the three positional arguments, validated with the store's own schema. */
function targetFrom(positionals: readonly string[]): { accountId: string; mailboxId: string; uid: number } {
    const [accountId, mailboxId, uidText] = positionals;
    const uid = Number(uidText);
    const target = { accountId: accountId ?? '', mailboxId: mailboxId ?? '', uid };
    try { guardKey(target); } catch { throw new UsageError('invalid <accountId> <mailboxId> <uid>'); }
    return target;
}

interface Found { guard: ParsedGuard; owner: ParsedOperation | undefined | 'unreadable'; guardItem: RawItem }

async function readTarget(client: LedgerClient, target: { accountId: string; mailboxId: string; uid: number }, pacing: Pacing): Promise<Found | undefined> {
    const key = guardKey(target);
    const guardItem = await withRetry(() => client.getItem(key), pacing);
    if (guardItem === undefined) { return undefined; }
    const guard = parseGuardItem(guardItem);
    if (!guard) { throw new Error(`the lock item for this message is not in a readable format (${key.pk})`); }
    const ownerItem = await withRetry(() => client.getItem({ pk: ownerPk(guard.record), sk: 'STATE' }), pacing);
    if (ownerItem === undefined) { return { guard, owner: undefined, guardItem }; }
    const owner = parseOperationItem(ownerItem);
    return { guard, owner: owner ?? 'unreadable', guardItem };
}

function describe(found: Found, nowMs: number, out: string[]): void {
    const { guard, owner } = found;
    const ownerRecord = owner === 'unreadable' ? undefined : owner?.record;
    out.push(`lock: mailbox ${guard.record.key.mailboxId} uid ${guard.record.key.uid}, state ${guard.record.state}, revision ${guard.record.revision}, expiresAt ${when(guard.expiresAt, 'none (written before 0.11.0)')}`);
    out.push(`operation: ${guard.record.operation.operationId}`);
    if (owner === undefined) { out.push('  record missing (expired, or never written)'); }
    else if (owner === 'unreadable') { out.push('  record present but not in a readable format'); }
    else {
        const receipt = receiptOf(owner.record);
        out.push(`  tool ${owner.record.intent.tool}, state ${owner.record.state}, receipt ${receipt ? `${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ''}` : 'none'}`);
        out.push(`  reservedAt ${when(owner.record.reservedAt, 'none (written before 0.11.0; counts as aged)')}, expiresAt ${when(owner.expiresAt, 'none (written before 0.11.0)')}`);
    }
    out.push(owner === 'unreadable' ? 'meaning: the owning record cannot be read, so the server cannot judge this lock; inspect it by hand.' : `meaning: ${explainHold(ownerRecord, nowMs)}`);
}

async function runShow(client: LedgerClient, parsed: Parsed, deps: CliDeps, output: Output): Promise<number> {
    const found = await readTarget(client, targetFrom(parsed.positionals), deps.pacing);
    if (!found) { output.stdout('No lock on this message: nothing holds it.\n'); return 0; }
    const lines: string[] = [];
    describe(found, deps.nowMs(), lines);
    output.stdout(`${lines.join('\n')}\n`);
    return 0;
}

function printPlan(plan: Plan, pages: number, apply: boolean, parsed: Parsed, output: Output): void {
    const lines: string[] = [];
    lines.push(`Table ${parsed.table} (${parsed.region}): ${apply ? 'APPLY' : 'DRY RUN, nothing is written'}`);
    lines.push(`Scanned ${plan.scanned.operations + plan.scanned.guards + plan.scanned.unreadable + plan.scanned.ignored} mail items in ${pages} pages: ${plan.scanned.operations} operations, ${plan.scanned.guards} guards, ${plan.scanned.ignored} ignored, ${plan.scanned.unreadable} unreadable`);
    lines.push('Guards by decision:');
    for (const decision of GUARD_DECISIONS) { lines.push(`  ${String(plan.guardDecisions[decision]).padStart(4)}  ${DECISION_LABELS[decision]}`); }
    lines.push(`Operations: ${plan.operationsWithoutExpiry} need expiresAt, ${plan.operationsWithExpiry} already have it`);
    const deletes = plan.actions.filter(action => action.kind === 'delete_guard').length;
    lines.push(`Writes planned: ${plan.actions.length} (${deletes} guard deletes, ${plan.actions.length - deletes} expiresAt updates)`);
    const tools = Object.entries(plan.byTool).sort(([a], [b]) => a.localeCompare(b));
    if (tools.length > 0) { lines.push('Planned writes by tool:'); for (const [tool, count] of tools) { lines.push(`  ${String(count).padStart(4)}  ${tool}`); } }
    if (parsed.verbose) {
        for (const action of plan.actions) { lines.push(action.kind === 'delete_guard' ? `  delete ${action.pk} (${action.decision})` : `  expiresAt ${action.pk}`); }
        for (const pk of plan.unreadablePks) { lines.push(`  unreadable ${pk}`); }
    }
    if (plan.scanned.unreadable > 0) { lines.push(`WARNING: ${plan.scanned.unreadable} items are not in a readable format; they were left alone${parsed.verbose ? '' : ' (--verbose lists their keys)'}.`); }
    output.stdout(`${lines.join('\n')}\n`);
}

async function runCleanup(client: LedgerClient, parsed: Parsed, deps: CliDeps, output: Output): Promise<number> {
    const nowSeconds = Math.floor(deps.nowMs() / 1000);
    const { items, pages } = await scanAll(client, deps.pacing);
    const plan = planCleanup(items, nowSeconds);
    printPlan(plan, pages, parsed.apply, parsed, output);
    let status = plan.scanned.unreadable > 0 ? 1 : 0;
    if (plan.actions.length === 0) { output.stdout('Nothing to do.\n'); return status; }
    if (!parsed.apply) {
        output.stdout('Dry run only. Re-run with --apply to perform these writes.\n');
        return status;
    }
    const result = await applyPlan(client, plan, deps.pacing);
    output.stdout(`Applied ${result.applied} writes (${result.appliedDeletes} deletes, ${result.appliedExpiries} expiresAt updates); skipped ${result.skipped} that changed since the scan.\n`);
    if (parsed.verbose) { for (const pk of result.skippedPks) { output.stdout(`  skipped ${pk}\n`); } }
    if (result.error !== undefined) {
        output.stderr(`Stopped: a write failed after retries (${errorText(result.error)}). Re-run to continue; it is safe to repeat.\n`);
        status = 1;
    }
    return status;
}

const errorText = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';

/** Runs one command line and returns the process exit status. 0 success, 1 failure or refusal, 2 usage error. */
export async function runLedger(argv: readonly string[], output: Output, deps: CliDeps): Promise<number> {
    let parsed: Parsed | 'help';
    try { parsed = parseCli(argv); }
    catch (error) {
        output.stderr(`${error instanceof Error ? error.message : 'invalid arguments'}\n\n${USAGE}`);
        return 2;
    }
    if (parsed === 'help') { output.stdout(USAGE); return 0; }
    try {
        const client = deps.makeClient({ table: parsed.table, region: parsed.region });
        if (parsed.command === 'show') { return await runShow(client, parsed, deps, output); }
        return await runCleanup(client, parsed, deps, output);
    } catch (error) {
        if (error instanceof UsageError) { output.stderr(`${error.message}\n\n${USAGE}`); return 2; }
        output.stderr(`mail-ledger failed: ${errorText(error)}\n`);
        return 1;
    }
}
