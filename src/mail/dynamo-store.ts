import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import type { DynamoSender } from '../auth/dynamo-store';
import { MailError, type ConfirmedReceipt, type DraftGuardKey, type DraftGuardRecord, type FailedReceipt, type MailOperationRecord, type MailOperationStore, type MailReceipt, type OperationClaim, type OperationKey, type ReservationResult, type UnknownReceipt, type WriteIntent } from './contracts';
import { mailOutputSchemas, messageKeySchema, operationIdSchema, versionSchema } from './schemas';

export interface DynamoMailStoreOptions { tableName: string; client?: DynamoSender; timeoutMs?: number }
const safe = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const owner = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const operationKey = z.strictObject({ accountId: safe, clientIdHash: versionSchema, operationId: operationIdSchema });
const targetKey = messageKeySchema.extend({ accountId: safe });
const createIntent = operationKey.extend({ payloadDigest: versionSchema, tool: z.literal('create_draft') });
const targetIntent = operationKey.extend({ payloadDigest: versionSchema, tool: z.enum(['update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags']), target: messageKeySchema, expectedVersion: versionSchema });
const intentSchema = z.union([createIntent, targetIntent]);
const claimSchema = z.strictObject({ key: operationKey, ownerToken: owner, revision, state: z.enum(['reserved', 'dispatched']) });
const operationBase = { key: operationKey, intent: intentSchema, ownerToken: owner, revision };
const operationSchema = z.union([
    z.strictObject({ ...operationBase, state: z.enum(['reserved', 'dispatched']) }),
    z.strictObject({ ...operationBase, state: z.literal('settled'), receipt: z.unknown() }),
]);
const guardSchema = z.strictObject({ key: targetKey, operation: operationKey, ownerToken: owner, revision, state: z.enum(['reserved', 'dispatched', 'retired', 'queued', 'outcome_unknown']) });
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
function receiptFor(intent: WriteIntent, value: unknown): MailReceipt {
    const receipt = parse(mailOutputSchemas[intent.tool], value);
    if (!['completed', 'partial', 'queued', 'failed', 'outcome_unknown'].includes(receipt.status) || receipt.operation_id !== intent.operationId) { throw unavailable(); }
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
function conflict(error: unknown, count: number): boolean {
    if (error === null || typeof error !== 'object') { return false; }
    const data = error as { name?: unknown; CancellationReasons?: unknown };
    return data.name === 'TransactionCanceledException' && Array.isArray(data.CancellationReasons) && data.CancellationReasons.length === count && data.CancellationReasons.every(reason => reason !== null && typeof reason === 'object' && ['None', 'ConditionalCheckFailed'].includes(reason.Code)) && data.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed');
}
/** Existing pk/sk table, fixed provisioned capacity. Receipts and fences have no TTL. */
export class DynamoMailOperationStore implements MailOperationStore {
    private readonly client: DynamoSender;
    private readonly timeoutMs: number;
    constructor(private readonly options: DynamoMailStoreOptions) {
        if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(options.tableName)) { throw new Error('Invalid mail table name'); }
        this.timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000) { throw new Error('Invalid mail store timeout'); }
        this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
    }
    private deadline(): number { return Date.now() + this.timeoutMs; }
    private async send(command: GetCommand | TransactWriteCommand, deadline: number): Promise<unknown> {
        if (deadline <= Date.now()) { throw unavailable(); }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const request = async () => {
                for (let attempt = 0; ; attempt++) {
                    try { return await this.client.send(command, { abortSignal: controller.signal }); }
                    catch (error) {
                        if (attempt >= 2 || controller.signal.aborted || (command instanceof TransactWriteCommand && conflict(error, command.input.TransactItems?.length ?? 0))) { throw error; }
                        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
                        if (controller.signal.aborted) { throw unavailable(); }
                    }
                }
            };
            return await Promise.race([request(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, Math.max(1, deadline - Date.now())); })]);
        } finally { clearTimeout(timer); }
    }
    private async read(key: { pk: string; sk: string }, deadline: number): Promise<unknown | undefined> {
        try {
            const result = await this.send(new GetCommand({ TableName: this.options.tableName, Key: key, ConsistentRead: true }), deadline) as { Item?: Record<string, unknown> };
            if (result.Item === undefined) { return undefined; }
            const { pk, sk, ...record } = result.Item;
            if (pk !== key.pk || sk !== key.sk) { throw unavailable(); }
            return record;
        } catch { throw unavailable(); }
    }
    async getOperation(key: OperationKey): Promise<MailOperationRecord | undefined> { return this.getStoredOperation(key, this.deadline()); }
    private async transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>, deadline: number): Promise<boolean> {
        try { await this.send(new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: items }), deadline); return true; }
        catch (error) { if (conflict(error, items.length)) { return false; } throw unavailable(); }
    }
    private absentPut(key: { pk: string; sk: string }, value: unknown): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: value }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } };
    }
    private async getStoredOperation(key: OperationKey, deadline: number): Promise<MailOperationRecord | undefined> {
        const value = await this.read(opKey(key), deadline);
        if (value === undefined) { return undefined; }
        const wrapper = parse(z.strictObject({ record: z.unknown() }), value);
        return operation(wrapper.record, key);
    }
    private async getGuard(key: DraftGuardKey, deadline: number): Promise<DraftGuardRecord | undefined> {
        const value = await this.read(guardKey(key), deadline);
        if (value === undefined) { return undefined; }
        const wrapper = parse(z.strictObject({ record: guardSchema }), value);
        if (!equal(wrapper.record.key, key) || wrapper.record.operation.accountId !== key.accountId) { throw unavailable(); }
        return wrapper.record;
    }
    async reserve(raw: WriteIntent, ownerToken: string): Promise<ReservationResult> {
        const deadline = this.deadline(); const intent = parse(intentSchema, raw); parse(owner, ownerToken);
        const key: OperationKey = { accountId: intent.accountId, clientIdHash: intent.clientIdHash, operationId: intent.operationId };
        const existing = await this.getStoredOperation(key, deadline);
        if (existing) { return equal(existing.intent, intent) ? { kind: 'replay', record: existing } : { kind: 'conflict', reason: 'operation_conflict' }; }
        const record: MailOperationRecord = { key, intent, ownerToken, revision: 0, state: 'reserved' };
        const items = [this.absentPut(opKey(key), record)];
        if (intent.tool !== 'create_draft') {
            const target: DraftGuardKey = { accountId: key.accountId, ...intent.target };
            const guard: DraftGuardRecord = { key: target, operation: key, ownerToken, revision: 0, state: 'reserved' };
            items.push(this.absentPut(guardKey(target), guard));
        }
        if (await this.transact(items, deadline)) { return { kind: 'acquired', claim: { key, ownerToken, revision: 0, state: 'reserved' } }; }
        // Only a proven conditional cancellation can be resolved as a conflict.
        const winner = await this.getStoredOperation(key, deadline);
        if (winner) { return equal(winner.intent, intent) ? { kind: 'replay', record: winner } : { kind: 'conflict', reason: 'operation_conflict' }; }
        if (intent.tool !== 'create_draft' && await this.getGuard({ accountId: key.accountId, ...intent.target }, deadline)) { return { kind: 'conflict', reason: 'draft_fenced' }; }
        throw unavailable();
    }
    private checkedPut(key: { pk: string; sk: string }, before: unknown, after: unknown): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
        return { Put: { TableName: this.options.tableName, Item: { ...key, record: after }, ConditionExpression: '#record = :before', ExpressionAttributeNames: { '#record': 'record' }, ExpressionAttributeValues: { ':before': before } } };
    }
    private async transition(claim: OperationClaim, expected: 'reserved' | 'dispatched', result: 'dispatched' | MailReceipt): Promise<OperationClaim<'dispatched'> | undefined> {
        const deadline = this.deadline(); parse(claimSchema, claim);
        if (claim.state !== expected) { throw unavailable(); }
        const before = await this.getStoredOperation(claim.key, deadline);
        if (!before || before.state !== expected || before.ownerToken !== claim.ownerToken || before.revision !== claim.revision) { throw unavailable(); }
        const receipt = typeof result === 'string' ? undefined : receiptFor(before.intent, result);
        if (receipt && ((expected === 'reserved' && receipt.status !== 'failed') || (expected === 'dispatched' && !['completed', 'partial', 'queued', 'outcome_unknown'].includes(receipt.status)))) { throw unavailable(); }
        const nextRevision = before.revision + 1;
        const after: MailOperationRecord = receipt ? { ...before, revision: nextRevision, state: 'settled', receipt } : { ...before, revision: nextRevision, state: 'dispatched' };
        // Revalidate the complete stored value before any write.
        operation(after, claim.key);
        const items = [this.checkedPut(opKey(claim.key), before, after)];
        if (before.intent.tool !== 'create_draft') {
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
}
