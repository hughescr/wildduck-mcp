import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { conditionalConflict, DEFAULT_THROTTLE_TIMEOUT_MS, DynamoRetrier, retryEnv, type DynamoBudget, type DynamoRetryEnv, type DynamoSender } from '../dynamo-retry';
import { MailError, type ConfirmedReceipt, type DraftGuardKey, type DraftGuardRecord, type FailedReceipt, type MailOperationRecord, type MailOperationStore, type MailReceipt, type MessageKey, type OperationClaim, type OperationKey, type ReservationResult, type ResolvedReceipt, type UnknownReceipt, type WriteIntent } from './contracts';
import { mailOutputSchemas, messageKeySchema, operationIdSchema, versionSchema } from './schemas';

/** How long an item lives after it was last written: every Put sets the table's TTL attribute expiresAt this far ahead. */
export const RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
/** timeoutMs bounds an unthrottled operation; throttleTimeoutMs (default and maximum 10 s) is the total once DynamoDB has throttled it; now is the clock in ms. */
export interface DynamoMailStoreOptions { tableName: string; client?: DynamoSender; timeoutMs?: number; throttleTimeoutMs?: number; retry?: Partial<DynamoRetryEnv>; now?: () => number }
const safe = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const owner = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const operationKey = z.strictObject({ accountId: safe, clientIdHash: versionSchema, operationId: operationIdSchema });
const targetKey = messageKeySchema.extend({ accountId: safe });
const createIntent = z.union([operationKey.extend({ payloadDigest: versionSchema, tool: z.literal('create_draft') }), operationKey.extend({ payloadDigest: versionSchema, tool: z.literal('create_reply_draft') })]);
const targetIntent = operationKey.extend({ payloadDigest: versionSchema, tool: z.enum(['update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags']), target: messageKeySchema, expectedVersion: versionSchema });
const intentSchema = z.union([createIntent, targetIntent]);
const claimSchema = z.strictObject({ key: operationKey, ownerToken: owner, revision, state: z.enum(['reserved', 'dispatched']) });
const operationBase = { key: operationKey, intent: intentSchema, ownerToken: owner, revision, reservedAt: z.number().int().positive().safe().optional() };
const operationSchema = z.union([
    z.strictObject({ ...operationBase, state: z.enum(['reserved', 'dispatched']) }),
    z.strictObject({ ...operationBase, state: z.literal('settled'), receipt: z.unknown() }),
]);
export const guardSchema = z.strictObject({ key: targetKey, operation: operationKey, ownerToken: owner, revision, state: z.enum(['reserved', 'dispatched', 'retired', 'queued', 'outcome_unknown']) });
/** An item is its record plus, optionally, a numeric expiresAt (written by every Put, never used when reading); any other attribute is rejected. */
export const itemSchema = <Record extends z.ZodType>(record: Record) => z.strictObject({ record, expiresAt: z.number().optional() });
const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) { return true; }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) { return false; }
    const left = a as Record<string, unknown>; const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
};
const unavailable = () => new MailError('temporarily_unavailable');
function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
    const result = schema.safeParse(value);
    if (!result.success) { throw unavailable(); }
    return result.data;
}
/** Stored receipts keep the 0.6 field name operation_id, so receipts written by 0.6.x to 0.9.x still
 * replay unchanged; tool results call it operationId. */
const STORED_OPERATION_ID = 'operation_id';
function storedReceipt(receipt: MailReceipt): Record<string, unknown> {
    // The summary is worked out again from the receipt whenever a result is returned; it is never stored.
    const { operationId, summary: _summary, ...rest } = receipt;
    return { ...rest, [STORED_OPERATION_ID]: operationId };
}
/** Accepts the stored form and the result form. A value carrying both names is left as is and
 * then fails the strict schema. */
function resultReceipt(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, STORED_OPERATION_ID) || Object.hasOwn(value, 'operationId')) { return value; }
    const { [STORED_OPERATION_ID]: operationId, ...rest } = value as Record<string, unknown>;
    return { ...rest, operationId };
}
/** A summary is never stored data, so a stray one, of any shape, is dropped before validation; only that key is removed. */
function withoutSummary(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { return value; }
    const { summary: _summary, ...rest } = value as Record<string, unknown>;
    return rest;
}
function receiptFor(intent: WriteIntent, value: unknown): MailReceipt {
    // Schema validation preserves the supplied grade; absent/invalid grades are never inferred.
    const receipt = parse(mailOutputSchemas[intent.tool], resultReceipt(withoutSummary(value)));
    if (!['completed', 'partial', 'queued', 'failed', 'outcome_unknown'].includes(receipt.status) || receipt.operationId !== intent.operationId) { throw unavailable(); }
    if (intent.tool === 'delete_draft' && receipt.status === 'completed' && 'deleted' in receipt && !equal(receipt.deleted, intent.target)) { throw unavailable(); }
    if ('proof' in receipt && receipt.proof.accountId !== intent.accountId) { throw unavailable(); }
    if (intent.tool === 'update_message_flags' && receipt.status === 'completed' && 'message' in receipt && (receipt.message.mailboxId !== intent.target.mailboxId || receipt.message.uid !== intent.target.uid)) { throw unavailable(); }
    if (intent.tool === 'move_message' && receipt.status === 'completed' && 'message' in receipt && receipt.message.mailboxId === intent.target.mailboxId) { throw unavailable(); }
    if (intent.tool === 'update_draft') {
        const candidate = receipt.status === 'completed' && 'draft' in receipt ? receipt.draft : receipt.status === 'partial' && 'candidate' in receipt ? receipt.candidate : undefined;
        if (candidate && candidate.mailboxId === intent.target.mailboxId && candidate.uid === intent.target.uid) { throw unavailable(); }
    }
    return receipt as MailReceipt;
}
export function operation(value: unknown, expected: OperationKey): MailOperationRecord {
    const data = parse(operationSchema, value);
    if (!equal(data.key, expected) || !equal(data.key, { accountId: data.intent.accountId, clientIdHash: data.intent.clientIdHash, operationId: data.intent.operationId })) { throw unavailable(); }
    if (data.state === 'settled') { return { ...data, receipt: receiptFor(data.intent, data.receipt) }; }
    return data;
}
export function opKey(value: OperationKey): { pk: string; sk: string } {
    const data = parse(operationKey, value);
    return { pk: `wildduck-mcp#mail-operation#${data.accountId}#${data.clientIdHash}#${data.operationId}`, sk: 'STATE' };
}
export function guardKey(value: DraftGuardKey): { pk: string; sk: string } {
    const data = parse(targetKey, value);
    return { pk: `wildduck-mcp#mail-guard#${data.accountId}#${data.mailboxId}#${data.uid}`, sk: 'STATE' };
}
/** The guarded message of a targeted write; a create has none. */
const targetOf = (intent: WriteIntent): MessageKey | undefined => 'target' in intent ? intent.target : undefined;
/** Existing pk/sk table, fixed provisioned capacity. Items expire RECORD_TTL_SECONDS after their last write (table TTL on expiresAt). */
export class DynamoMailOperationStore implements MailOperationStore {
    private readonly retrier: DynamoRetrier;
    private readonly now: () => number;
    constructor(private readonly options: DynamoMailStoreOptions) {
        this.now = options.now ?? Date.now;
        if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(options.tableName)) { throw new Error('Invalid mail table name'); }
        const timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) { throw new Error('Invalid mail store timeout'); }
        const throttleTimeoutMs = options.throttleTimeoutMs ?? DEFAULT_THROTTLE_TIMEOUT_MS;
        // The service's time arithmetic (mail/service.ts) is derived from the default, so no longer budget is accepted.
        if (!Number.isInteger(throttleTimeoutMs) || throttleTimeoutMs < 1 || throttleTimeoutMs > DEFAULT_THROTTLE_TIMEOUT_MS) { throw new Error('Invalid mail store throttle timeout'); }
        const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
        this.retrier = new DynamoRetrier({ store: 'mail', client, unavailable, env: retryEnv(options.retry), timeoutMs, throttleTimeoutMs, retryTransient: () => true });
    }
    /** The time budget of one public operation, shared by all its reads and writes ("deadline" below): timeoutMs
     * while unthrottled, the throttle budget once DynamoDB has throttled any of them. */
    private deadline(): DynamoBudget { return this.retrier.begin(); }
    private send(command: GetCommand | TransactWriteCommand, deadline: DynamoBudget): Promise<unknown> { return this.retrier.send(command, deadline); }
    private async read(key: { pk: string; sk: string }, deadline: DynamoBudget): Promise<unknown | undefined> {
        try {
            const result = await this.send(new GetCommand({ TableName: this.options.tableName, Key: key, ConsistentRead: true }), deadline) as { Item?: Record<string, unknown> };
            if (result.Item === undefined) { return undefined; }
            const { pk, sk, ...record } = result.Item;
            if (pk !== key.pk || sk !== key.sk) { throw unavailable(); }
            return record;
        } catch { throw unavailable(); }
    }
    /** Whole epoch seconds, rounded up so a reservedAt never makes a hold look older than it is (an age check never fires
     * early); one value is taken per public operation so every item it writes agrees. */
    private seconds(): number { return Math.ceil(this.now() / 1000); }
    async getOperation(key: OperationKey): Promise<MailOperationRecord | undefined> { return (await this.readOperation(key, this.deadline()))?.record; }
    private async transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>, deadline: DynamoBudget): Promise<boolean> {
        // Built once: every retry inside send() re-sends this same command, hence the same ClientRequestToken.
        try { await this.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: items }), deadline); return true; }
        catch (error) { if (conditionalConflict(error, items.length)) { return false; } throw unavailable(); }
    }
    private absentPut(key: { pk: string; sk: string }, value: unknown, expiresAt: number): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: value, expiresAt }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } };
    }
    /** The record as stored (raw, for a compare-and-set) and as read (receipt spelling normalised). */
    private async readOperation(key: OperationKey, deadline: DynamoBudget): Promise<{ stored: unknown; record: MailOperationRecord } | undefined> {
        const value = await this.read(opKey(key), deadline);
        if (value === undefined) { return undefined; }
        const wrapper = parse(itemSchema(z.unknown()), value);
        return { stored: wrapper.record, record: operation(wrapper.record, key) };
    }
    private async getStoredOperation(key: OperationKey, deadline: DynamoBudget): Promise<MailOperationRecord | undefined> { return (await this.readOperation(key, deadline))?.record; }
    async getGuard(key: DraftGuardKey): Promise<DraftGuardRecord | undefined> { return this.readGuard(key, this.deadline()); }
    private async readGuard(key: DraftGuardKey, deadline: DynamoBudget): Promise<DraftGuardRecord | undefined> {
        const value = await this.read(guardKey(key), deadline);
        if (value === undefined) { return undefined; }
        const wrapper = parse(itemSchema(guardSchema), value);
        if (!equal(wrapper.record.key, key) || wrapper.record.operation.accountId !== key.accountId) { throw unavailable(); }
        return wrapper.record;
    }
    async reserve(raw: WriteIntent, ownerToken: string): Promise<ReservationResult> {
        const deadline = this.deadline(); const intent = parse(intentSchema, raw); parse(owner, ownerToken);
        const key: OperationKey = { accountId: intent.accountId, clientIdHash: intent.clientIdHash, operationId: intent.operationId };
        // No read first: the service has just read this key, and a record created since fails the absent-put below and is read then.
        const seconds = this.seconds(); const expiresAt = seconds + RECORD_TTL_SECONDS;
        const record: MailOperationRecord = { key, intent, ownerToken, revision: 0, state: 'reserved', reservedAt: seconds };
        const items = [this.absentPut(opKey(key), record, expiresAt)];
        const guarded = targetOf(intent);
        if (guarded) {
            const target: DraftGuardKey = { accountId: key.accountId, ...guarded };
            const guard: DraftGuardRecord = { key: target, operation: key, ownerToken, revision: 0, state: 'reserved' };
            items.push(this.absentPut(guardKey(target), guard, expiresAt));
        }
        if (await this.transact(items, deadline)) { return { kind: 'acquired', claim: { key, ownerToken, revision: 0, state: 'reserved' } }; }
        // Only a proven conditional cancellation can be resolved as a conflict.
        const winner = await this.getStoredOperation(key, deadline);
        if (winner) { return equal(winner.intent, intent) ? { kind: 'replay', record: winner } : { kind: 'conflict', reason: 'operation_conflict' }; }
        const blocker = guarded && await this.readGuard({ accountId: key.accountId, ...guarded }, deadline);
        if (blocker) { return { kind: 'conflict', reason: 'draft_fenced', blocker }; }
        throw unavailable();
    }
    /** Writes pk, sk, record and expiresAt: the item's TTL restarts at every write. */
    private checkedPut(key: { pk: string; sk: string }, before: unknown, after: unknown, expiresAt: number): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: after, expiresAt }, ConditionExpression: '#record = :before', ExpressionAttributeNames: { '#record': 'record' }, ExpressionAttributeValues: { ':before': before } } };
    }
    /** Deletes the guard only while it still equals the value that was read. */
    private guardDelete(guard: DraftGuardRecord): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Delete: { TableName: this.options.tableName, Key: guardKey(guard.key), ConditionExpression: '#record = :before', ExpressionAttributeNames: { '#record': 'record' }, ExpressionAttributeValues: { ':before': guard } } };
    }
    /** Ends a hold the service has decided is over; the operation record is not touched. */
    async releaseGuard(raw: DraftGuardRecord): Promise<boolean> {
        const deadline = this.deadline(); const guard = parse(guardSchema, raw);
        return this.transact([this.guardDelete(guard)], deadline);
    }
    /** Settles a dispatched or outcome_unknown record as failed or queued (and deletes its guard) iff it is still exactly the value now stored. */
    async resolveUnknown(record: MailOperationRecord, receipt: ResolvedReceipt, rawGuard?: DraftGuardRecord): Promise<void> {
        const deadline = this.deadline(); const key = parse(operationKey, record.key);
        const unknown = (value: MailOperationRecord) => value.state === 'dispatched' || (value.state === 'settled' && value.receipt.status === 'outcome_unknown');
        if (!unknown(record) || (receipt.status !== 'failed' && receipt.status !== 'queued')) { throw unavailable(); }
        const current = await this.readOperation(key, deadline);
        if (!current || !unknown(current.record) || current.record.state !== record.state || current.record.revision !== record.revision || current.record.ownerToken !== record.ownerToken) { throw unavailable(); }
        const settled = receiptFor(current.record.intent, receipt);
        const after = { ...current.record, revision: current.record.revision + 1, state: 'settled' as const, receipt: storedReceipt(settled) };
        operation(after, key);
        // The condition is the value as stored (receipt spelling operation_id), not the normalised one read from it.
        const items = [this.checkedPut(opKey(key), current.stored, after, this.seconds() + RECORD_TTL_SECONDS)];
        if (rawGuard) {
            const guard = parse(guardSchema, rawGuard); const target = targetOf(current.record.intent);
            if (!target || !equal(guard.operation, key) || !equal(guard.key, { accountId: key.accountId, ...target })) { throw unavailable(); }
            items.push(this.guardDelete(guard));
        }
        if (!await this.transact(items, deadline)) { throw unavailable(); }
    }
    private async transition(claim: OperationClaim, expected: 'reserved' | 'dispatched', result: 'dispatched' | MailReceipt): Promise<OperationClaim<'dispatched'> | undefined> {
        const deadline = this.deadline(); parse(claimSchema, claim);
        if (claim.state !== expected) { throw unavailable(); }
        const before = await this.getStoredOperation(claim.key, deadline);
        if (!before || before.state !== expected || before.ownerToken !== claim.ownerToken || before.revision !== claim.revision) { throw unavailable(); }
        const receipt = typeof result === 'string' ? undefined : receiptFor(before.intent, result);
        if (receipt && !(expected === 'reserved' ? ['failed'] : ['completed', 'partial', 'queued', 'outcome_unknown', 'failed']).includes(receipt.status)) { throw unavailable(); }
        const nextRevision = before.revision + 1;
        const after = receipt ? { ...before, revision: nextRevision, state: 'settled' as const, receipt: storedReceipt(receipt) } : { ...before, revision: nextRevision, state: 'dispatched' as const };
        // Revalidate the complete stored value before any write.
        operation(after, claim.key);
        const expiresAt = this.seconds() + RECORD_TTL_SECONDS;
        const items = [this.checkedPut(opKey(claim.key), before, after, expiresAt)];
        const guarded = targetOf(before.intent);
        if (guarded) {
            const target = { accountId: before.key.accountId, ...guarded };
            const guard = await this.readGuard(target, deadline);
            if (!guard || !equal(guard.operation, before.key) || guard.ownerToken !== before.ownerToken || guard.revision !== before.revision || guard.state !== expected) { throw unavailable(); }
            // The hold ends with the receipt, except an unknown outcome and a draft update whose two copies are both alive.
            const bothAlive = before.intent.tool === 'update_draft' && receipt?.status === 'partial' && (receipt.reason === 'original_deletion_failed' || receipt.reason === 'original_deletion_unconfirmed');
            if (receipt && receipt.status !== 'outcome_unknown' && !bothAlive) { items.push(this.guardDelete(guard)); }
            else { items.push(this.checkedPut(guardKey(target), guard, { ...guard, revision: nextRevision, state: !receipt ? 'dispatched' : receipt.status === 'outcome_unknown' ? 'outcome_unknown' : 'retired' }, expiresAt)); }
        }
        if (!await this.transact(items, deadline)) { throw unavailable(); }
        return receipt ? undefined : { key: before.key, ownerToken: before.ownerToken, revision: nextRevision, state: 'dispatched' };
    }
    async markDispatched(claim: OperationClaim<'reserved'>): Promise<OperationClaim<'dispatched'>> {
        const next = await this.transition(claim, 'reserved', 'dispatched');
        if (!next) { throw unavailable(); } return next;
    }
    async failPreflight(claim: OperationClaim<'reserved'>, receipt: FailedReceipt): Promise<void> { await this.transition(claim, 'reserved', receipt); }
    async complete(claim: OperationClaim<'dispatched'>, receipt: ConfirmedReceipt): Promise<void> {
        if (!['completed', 'partial', 'queued'].includes(receipt.status)) { throw unavailable(); }
        await this.transition(claim, 'dispatched', receipt);
    }
    async markOutcomeUnknown(claim: OperationClaim<'dispatched'>, receipt: UnknownReceipt): Promise<void> {
        if (receipt.status !== 'outcome_unknown') { throw unavailable(); }
        await this.transition(claim, 'dispatched', receipt);
    }
    async failDispatched(claim: OperationClaim<'dispatched'>, receipt: FailedReceipt): Promise<void> {
        if (receipt.status !== 'failed') { throw unavailable(); }
        await this.transition(claim, 'dispatched', receipt);
    }
}
