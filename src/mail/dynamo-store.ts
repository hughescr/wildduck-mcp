import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { conditionalConflict, DEFAULT_THROTTLE_TIMEOUT_MS, DynamoRetrier, retryEnv, type DynamoBudget, type DynamoRetryEnv, type DynamoSender } from '../dynamo-retry';
import { MailError, type ConfirmedReceipt, type DraftGuardKey, type DraftGuardRecord, type FailedReceipt, type MailOperationRecord, type MailOperationStore, type MailReceipt, type OperationClaim, type OperationKey, type ReservationResult, type UnknownReceipt, type WriteIntent } from './contracts';
import { mailOutputSchemas, messageKeySchema, operationIdSchema, versionSchema } from './schemas';

/** timeoutMs bounds an unthrottled operation; throttleTimeoutMs (default and maximum 10 s) is the total once DynamoDB has throttled it. */
export interface DynamoMailStoreOptions { tableName: string; client?: DynamoSender; timeoutMs?: number; throttleTimeoutMs?: number; retry?: Partial<DynamoRetryEnv> }
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
const guardSchema = z.strictObject({ key: targetKey, operation: operationKey, ownerToken: owner, revision, state: z.enum(['reserved', 'dispatched', 'retired', 'queued', 'outcome_unknown']) });
/** An item is its record plus, optionally, a numeric expiresAt (read and ignored); any other attribute is rejected. */
const itemSchema = <Record extends z.ZodType>(record: Record) => z.strictObject({ record, expiresAt: z.number().optional() });
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
function operation(value: unknown, expected: OperationKey): MailOperationRecord {
    const data = parse(operationSchema, value);
    if (!equal(data.key, expected) || !equal(data.key, { accountId: data.intent.accountId, clientIdHash: data.intent.clientIdHash, operationId: data.intent.operationId })) { throw unavailable(); }
    if (data.state === 'settled') { return { ...data, receipt: receiptFor(data.intent, data.receipt) }; }
    return data;
}
function opKey(value: OperationKey): { pk: string; sk: string } {
    const data = parse(operationKey, value);
    return { pk: `wildduck-mcp#mail-operation#${data.accountId}#${data.clientIdHash}#${data.operationId}`, sk: 'STATE' };
}
function guardKey(value: DraftGuardKey): { pk: string; sk: string } {
    const data = parse(targetKey, value);
    return { pk: `wildduck-mcp#mail-guard#${data.accountId}#${data.mailboxId}#${data.uid}`, sk: 'STATE' };
}
/** Existing pk/sk table, fixed provisioned capacity. Receipts and fences have no TTL. */
export class DynamoMailOperationStore implements MailOperationStore {
    private readonly retrier: DynamoRetrier;
    constructor(private readonly options: DynamoMailStoreOptions) {
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
    async getOperation(key: OperationKey): Promise<MailOperationRecord | undefined> { return this.getStoredOperation(key, this.deadline()); }
    private async transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>, deadline: DynamoBudget): Promise<boolean> {
        // Built once: every retry inside send() re-sends this same command, hence the same ClientRequestToken.
        try { await this.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: items }), deadline); return true; }
        catch (error) { if (conditionalConflict(error, items.length)) { return false; } throw unavailable(); }
    }
    private absentPut(key: { pk: string; sk: string }, value: unknown): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: value }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } };
    }
    private async getStoredOperation(key: OperationKey, deadline: DynamoBudget): Promise<MailOperationRecord | undefined> {
        const value = await this.read(opKey(key), deadline);
        if (value === undefined) { return undefined; }
        const wrapper = parse(itemSchema(z.unknown()), value);
        return operation(wrapper.record, key);
    }
    private async getGuard(key: DraftGuardKey, deadline: DynamoBudget): Promise<DraftGuardRecord | undefined> {
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
        const record: MailOperationRecord = { key, intent, ownerToken, revision: 0, state: 'reserved' };
        const items = [this.absentPut(opKey(key), record)];
        if (intent.tool !== 'create_draft' && intent.tool !== 'create_reply_draft') {
            const target: DraftGuardKey = { accountId: key.accountId, ...intent.target };
            const guard: DraftGuardRecord = { key: target, operation: key, ownerToken, revision: 0, state: 'reserved' };
            items.push(this.absentPut(guardKey(target), guard));
        }
        if (await this.transact(items, deadline)) { return { kind: 'acquired', claim: { key, ownerToken, revision: 0, state: 'reserved' } }; }
        // Only a proven conditional cancellation can be resolved as a conflict.
        const winner = await this.getStoredOperation(key, deadline);
        if (winner) { return equal(winner.intent, intent) ? { kind: 'replay', record: winner } : { kind: 'conflict', reason: 'operation_conflict' }; }
        if (intent.tool !== 'create_draft' && intent.tool !== 'create_reply_draft' && await this.getGuard({ accountId: key.accountId, ...intent.target }, deadline)) { return { kind: 'conflict', reason: 'draft_fenced' }; }
        throw unavailable();
    }
    /** Writes pk, sk and record only: an expiresAt attribute on the item read is dropped by this Put. */
    private checkedPut(key: { pk: string; sk: string }, before: unknown, after: unknown): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: after }, ConditionExpression: '#record = :before', ExpressionAttributeNames: { '#record': 'record' }, ExpressionAttributeValues: { ':before': before } } };
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
        const items = [this.checkedPut(opKey(claim.key), before, after)];
        if (before.intent.tool !== 'create_draft' && before.intent.tool !== 'create_reply_draft') {
            const target = { accountId: before.key.accountId, ...before.intent.target };
            const guard = await this.getGuard(target, deadline);
            if (!guard || !equal(guard.operation, before.key) || guard.ownerToken !== before.ownerToken || guard.revision !== before.revision || guard.state !== expected) { throw unavailable(); }
            if (receipt?.status === 'failed' || (before.intent.tool === 'update_message_flags' && receipt?.status === 'completed')) {
                items.push({ Delete: { TableName: this.options.tableName, Key: guardKey(target), ConditionExpression: '#record = :before', ExpressionAttributeNames: { '#record': 'record' }, ExpressionAttributeValues: { ':before': guard } } });
            } else {
                const state = !receipt ? 'dispatched' : receipt.status === 'queued' ? 'queued' : receipt.status === 'outcome_unknown' ? 'outcome_unknown' : 'retired';
                items.push(this.checkedPut(guardKey(target), guard, { ...guard, revision: nextRevision, state }));
            }
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
