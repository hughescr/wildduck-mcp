import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { DEFAULT_THROTTLE_TIMEOUT_MS, DynamoRetrier, MAX_THROTTLE_TIMEOUT_MS, retryEnv, type DynamoRetryEnv, type DynamoSender } from '../dynamo-retry';
import { ATTACHMENT_UPLOAD_KEY_PREFIX, MailError, type AttachmentUploadOwner, type AttachmentUploadRecord, type AttachmentUploadStore } from './contracts';
import { MAX_UPLOAD_BYTES, uploadIdSchema, versionSchema } from './schemas';

/** timeoutMs bounds an unthrottled call; throttleTimeoutMs (default 10 s) is the total once DynamoDB has throttled it. */
export interface DynamoAttachmentUploadStoreOptions { tableName: string; client?: DynamoSender; timeoutMs?: number; throttleTimeoutMs?: number; retry?: Partial<DynamoRetryEnv> }
const accountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const ownerSchema = z.strictObject({ accountId: accountIdSchema, clientIdHash: versionSchema });
/** pk/sk are added when writing and checked when reading; everything else is the record itself, so the table's TTL
 * attribute expiresAt (a top-level Number of epoch seconds) is the logical expiry, with no copy that could drift. */
const recordSchema = ownerSchema.extend({
    uploadId: uploadIdSchema, sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    objectKey: z.string(), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(record => record.objectKey === ATTACHMENT_UPLOAD_KEY_PREFIX + record.uploadId);
const storedSchema = recordSchema.safeExtend({ pk: z.string(), sk: z.literal('STATE') });
const BATCH_LIMIT = 100;
const unavailable = () => new MailError('temporarily_unavailable');
function uploadKey(accountId: string, uploadId: string): { pk: string; sk: string } {
    // The leading key must start with wildduck-mcp#: the execution role's IAM condition requires it.
    return { pk: `wildduck-mcp#attachment-upload#${accountId}#${uploadId}`, sk: 'STATE' };
}
/** Staged-upload records on the shared state table (no extra table, index or capacity). One conditional PutItem to create,
 * one strongly consistent BatchGetItem to read, both under the shared throttling-aware retry. TTL removes expired items
 * for free but lazily (days), so expiry is also enforced on every read. */
export class DynamoAttachmentUploadStore implements AttachmentUploadStore {
    private readonly retrier: DynamoRetrier;
    private readonly env: DynamoRetryEnv;
    constructor(private readonly options: DynamoAttachmentUploadStoreOptions) {
        if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(options.tableName)) { throw new Error('Invalid upload table name'); }
        const timeoutMs = options.timeoutMs ?? 5000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) { throw new Error('Invalid upload store timeout'); }
        const throttleTimeoutMs = options.throttleTimeoutMs ?? DEFAULT_THROTTLE_TIMEOUT_MS;
        if (!Number.isInteger(throttleTimeoutMs) || throttleTimeoutMs < 1 || throttleTimeoutMs > MAX_THROTTLE_TIMEOUT_MS) { throw new Error('Invalid upload store throttle timeout'); }
        const client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
        this.env = retryEnv(options.retry);
        this.retrier = new DynamoRetrier({ store: 'upload', client, unavailable, env: this.env, timeoutMs, throttleTimeoutMs, retryTransient: () => true });
    }
    async createUpload(raw: AttachmentUploadRecord): Promise<void> {
        const parsed = recordSchema.safeParse(raw);
        if (!parsed.success) { throw unavailable(); }
        const record = parsed.data;
        // One plain conditional put (a transaction would cost double): an existing key, or any unknown outcome, is temporarily_unavailable.
        const command = new PutCommand({ TableName: this.options.tableName, Item: { ...uploadKey(record.accountId, record.uploadId), ...record }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } });
        try { await this.retrier.send(command, this.retrier.begin()); } catch { throw unavailable(); }
    }
    async getUploads(rawOwner: AttachmentUploadOwner, uploadIds: readonly string[]): Promise<ReadonlyMap<string, AttachmentUploadRecord>> {
        const found = new Map<string, AttachmentUploadRecord>();
        const owner = ownerSchema.safeParse(rawOwner);
        if (!owner.success) { throw unavailable(); }
        // Ids that cannot be ours are simply absent, like unknown ones; nothing is read for them.
        const keys = new Map<string, string>();
        for (const id of new Set(uploadIds)) { if (uploadIdSchema.safeParse(id).success) { keys.set(uploadKey(owner.data.accountId, id).pk, id); } }
        if (keys.size === 0) { return found; }
        const budget = this.retrier.begin(); const nowSeconds = this.env.now() / 1000;
        try {
            const pending = [...keys.keys()];
            for (let start = 0; start < pending.length; start += BATCH_LIMIT) {
                let batch = pending.slice(start, start + BATCH_LIMIT).map(pk => ({ pk, sk: 'STATE' }));
                for (let round = 1; batch.length > 0; round++) {
                    const result = await this.retrier.send(new BatchGetCommand({ RequestItems: { [this.options.tableName]: { Keys: batch, ConsistentRead: true } } }), budget) as { Responses?: Record<string, unknown>; UnprocessedKeys?: Record<string, { Keys?: { pk?: unknown; sk?: unknown }[] } | undefined> };
                    const items = result.Responses?.[this.options.tableName]; const left = result.UnprocessedKeys?.[this.options.tableName]?.Keys ?? [];
                    if ((items !== undefined && !Array.isArray(items)) || (items?.length ?? 0) + left.length > batch.length) { throw unavailable(); }
                    for (const item of items ?? []) {
                        // Malformed, mismatched or foreign-client items are dropped: the caller sees them as absent, exactly like unknown ids.
                        const stored = storedSchema.safeParse(item);
                        if (!stored.success) { continue; }
                        const { pk, sk: _sk, ...record } = stored.data;
                        const id = keys.get(pk);
                        if (id === undefined || pk !== uploadKey(record.accountId, record.uploadId).pk || record.uploadId !== id) { continue; }
                        if (record.accountId === owner.data.accountId && record.clientIdHash === owner.data.clientIdHash && record.expiresAt > nowSeconds) { found.set(id, record); }
                    }
                    const asked = new Set(batch.map(key => key.pk));
                    batch = left.map(key => ({ pk: typeof key.pk === 'string' && asked.has(key.pk) ? key.pk : '', sk: 'STATE' }));
                    if (batch.some(key => key.pk === '')) { throw unavailable(); }
                    // DynamoDB returns keys unprocessed when it throttles part of a batch; retry only those, with backoff, within the budget.
                    if (batch.length > 0) { await this.retrier.unprocessed(budget, round); }
                }
            }
        } catch { throw unavailable(); }
        return found;
    }
}
