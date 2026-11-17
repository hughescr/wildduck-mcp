import { createHash } from 'node:crypto';
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type GetCommandOutput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { conditionalConflict, DEFAULT_THROTTLE_TIMEOUT_MS, DynamoRetrier, MAX_THROTTLE_TIMEOUT_MS, retryEnv, type DynamoRetryEnv, type DynamoSender } from '../dynamo-retry';
import { TemporaryUnavailable, type AtomicStore, type AtomicWrite, type AuthRecord } from './contracts';

export type { DynamoSender };
export interface DynamoStoreOptions {
    tableName: string; client?: DynamoSender; timeoutMs?: number;
    /** Total time one call may wait once DynamoDB has throttled it (default 10 s); timeoutMs bounds an unthrottled call. */
    throttleTimeoutMs?: number; retry?: Partial<DynamoRetryEnv>;
    /** Resolve identity, region and transport at SDK construction; retries remain adapter-owned. */
    clientConfig?: Pick<DynamoDBClientConfig, 'region' | 'credentials' | 'requestHandler'>;
}
const SK = 'STATE';
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sealed(value: unknown): boolean {
    return object(value) && Object.keys(value).sort().join(',') === 'ciphertext,keyId,nonce,tag' && safeId(value.keyId) && typeof value.nonce === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value.nonce) && typeof value.tag === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.tag) && typeof value.ciphertext === 'string' && /^[A-Za-z0-9_-]{1,32768}$/.test(value.ciphertext);
}
function record(value: unknown): value is AuthRecord {
    if (!object(value) || !safeId(value.id) || !integer(value.revision) || !integer(value.expiresAt)) { return false; }
    const common = ['kind', 'id', 'revision', 'expiresAt', 'accountId'];
    if (!text(value.accountId)) { return false; }
    let fields: string[];
    if (value.kind === 'connection') {
        fields = ['credentialGeneration', 'status', 'credentials'];
        if (!integer(value.credentialGeneration) || (typeof value.status !== 'string' || !['active', 'reconnect_required', 'revoked'].includes(value.status)) || !sealed(value.credentials)) { return false; }
    } else if (value.kind === 'grant' || value.kind === 'code') {
        common.push('clientId', 'connectionId', 'resource', 'scopes');
        if (!text(value.clientId) || !safeId(value.connectionId) || !text(value.resource) || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 16 || value.scopes.some(scope => typeof scope !== 'string' || !['mail:read', 'mail:modify', 'mail:draft', 'mail:send', 'profile'].includes(scope))) { return false; }
        if (value.kind === 'code') {
            fields = ['credentialGeneration', 'redirectUri', 'challenge', 'consumedGrantId'];
            if (!integer(value.credentialGeneration) || !text(value.redirectUri) || typeof value.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge) || (value.consumedGrantId !== undefined && !safeId(value.consumedGrantId))) { return false; }
        } else {
            fields = ['credentialGeneration', 'status', 'tokenVersion', 'refreshGeneration', 'refreshHash', 'previousRefreshHash', 'receiptUntil', 'receipt', 'receiptBinding'];
            if (!integer(value.credentialGeneration) || (typeof value.status !== 'string' || !['active', 'revoked'].includes(value.status)) || !integer(value.tokenVersion) || !integer(value.refreshGeneration) || typeof value.refreshHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.refreshHash) || (value.previousRefreshHash !== undefined && (typeof value.previousRefreshHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.previousRefreshHash))) || (value.receiptUntil !== undefined && !integer(value.receiptUntil)) || (value.receipt !== undefined && !sealed(value.receipt)) || (value.receiptBinding !== undefined && !text(value.receiptBinding))) { return false; }
        }
    } else { return false; }
    return Object.keys(value).every(key => value[key] !== undefined && [...common, ...fields].includes(key)) && Buffer.byteLength(JSON.stringify(value)) <= 65536;
}
function key(kind: AuthRecord['kind'], id: string): { pk: string; sk: string } {
    if (!['connection', 'grant', 'code'].includes(kind) || !safeId(id)) { throw new Error('Invalid auth record key'); }
    return { pk: `wildduck-mcp#${kind}#${id}`, sk: SK };
}
/** Dedicated table: pk + sk strings, expiresAt Unix seconds TTL; no indexes required. */
export class DynamoAtomicStore implements AtomicStore {
    private readonly retrier: DynamoRetrier;
    constructor(private readonly options: DynamoStoreOptions) {
        if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.tableName)) { throw new Error('Invalid auth table name'); }
        const timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) { throw new Error('Invalid auth timeout'); }
        const throttleTimeoutMs = options.throttleTimeoutMs ?? DEFAULT_THROTTLE_TIMEOUT_MS;
        if (!Number.isInteger(throttleTimeoutMs) || throttleTimeoutMs < 1 || throttleTimeoutMs > MAX_THROTTLE_TIMEOUT_MS) { throw new Error('Invalid auth throttle timeout'); }
        // The outer transaction loop owns retries; nested SDK retries multiply writes.
        const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ ...options.clientConfig, maxAttempts: 1 }), { marshallOptions: { removeUndefinedValues: false } });
        // Throttled reads and writes are retried (the table is 1/1 provisioned); other errors only for the transaction, whose fixed token makes that safe.
        this.retrier = new DynamoRetrier({ store: 'auth', client, unavailable: () => new TemporaryUnavailable(), env: retryEnv(options.retry), timeoutMs, throttleTimeoutMs, retryTransient: command => command instanceof TransactWriteCommand });
    }
    private send(command: GetCommand | TransactWriteCommand): Promise<unknown> { return this.retrier.send(command, this.retrier.begin()); }
    async get(kind: AuthRecord['kind'], id: string): Promise<AuthRecord | undefined> {
        const expectedKey = key(kind, id);
        try {
            const result = await this.send(new GetCommand({ TableName: this.options.tableName, Key: expectedKey, ConsistentRead: true })) as GetCommandOutput;
            if (result.Item === undefined) { return undefined; }
            const { pk, sk, ...value } = result.Item;
            if (pk !== expectedKey.pk || sk !== SK || !record(value) || value.kind !== kind || value.id !== id) { throw new TemporaryUnavailable(); }
            return value;
        } catch { throw new TemporaryUnavailable(); }
    }
    async transact(write: AtomicWrite): Promise<boolean> {
        if (!safeId(write.operationId) || !Array.isArray(write.conditions) || !Array.isArray(write.puts) || write.puts.length === 0) { throw new Error('Invalid auth transaction'); }
        const conditions = new Map<string, AtomicWrite['conditions'][number]>();
        for (const condition of write.conditions) {
            if (Object.keys(condition).sort().join(',') !== 'id,kind,revision' || (condition.revision !== null && !integer(condition.revision))) { throw new Error('Invalid auth condition'); }
            const pk = key(condition.kind, condition.id).pk;
            if (conditions.has(pk)) { throw new Error('Duplicate auth condition'); }
            conditions.set(pk, condition);
        }
        const puts = new Map<string, AuthRecord>();
        for (const value of write.puts) {
            if (!record(value)) { throw new Error('Invalid auth record'); }
            const pk = key(value.kind, value.id).pk;
            const condition = conditions.get(pk);
            if (puts.has(pk) || !condition || value.revision !== (condition.revision === null ? 0 : condition.revision + 1)) { throw new Error('Unsafe auth write'); }
            puts.set(pk, value);
        }
        if (conditions.size > 100 || Buffer.byteLength(JSON.stringify(write)) > 3500000) { throw new Error('Auth transaction too large'); }
        const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
        for (const [pk, condition] of conditions) {
            const expression = condition.revision === null ? { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } : { ConditionExpression: '#revision = :revision', ExpressionAttributeNames: { '#revision': 'revision' }, ExpressionAttributeValues: { ':revision': condition.revision } };
            const value = puts.get(pk);
            if (value) { items.push({ Put: { TableName: this.options.tableName, Item: { ...value, ...key(value.kind, value.id) }, ...expression } }); }
            else { items.push({ ConditionCheck: { TableName: this.options.tableName, Key: key(condition.kind, condition.id), ...expression } }); }
        }
        try {
            await this.send(new TransactWriteCommand({ TransactItems: items, ClientRequestToken: createHash('sha256').update(write.operationId).digest('hex').slice(0, 36) }));
            return true;
        } catch (error) {
            // A cancellation is a known conflict only when all reported reasons are
            // None/ConditionalCheckFailed and at least one is ConditionalCheckFailed.
            if (conditionalConflict(error, items.length)) { return false; }
            throw new TemporaryUnavailable();
        }
    }
}
