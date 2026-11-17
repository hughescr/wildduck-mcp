import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BatchGetCommand, PutCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoCommand, DynamoSender } from '../src/dynamo-retry';
import { ATTACHMENT_UPLOAD_KEY_PREFIX, type AttachmentUploadOwner, type AttachmentUploadRecord } from '../src/mail/contracts';
import { MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS } from '../src/mail/schemas';
import { DynamoAttachmentUploadStore } from '../src/mail/upload-store';
import { captureWarnings, throttleError, virtualRetry } from './dynamo-virtual';

const NOW_MS = 1_800_000_000_000; const NOW = NOW_MS / 1000;
const owner: AttachmentUploadOwner = { accountId: 'a'.repeat(24), clientIdHash: 'c'.repeat(43) };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UPPER = 'ABCDEFAB-0000-4000-8000-000000000001'; // the lowercase-only uuid format refuses it
const record = (n: number, extra: Partial<AttachmentUploadRecord> = {}): AttachmentUploadRecord => ({ ...owner, uploadId: id(n), sizeBytes: 1234, sha256: 'ab'.repeat(32), objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + id(n), expiresAt: NOW + UPLOAD_TTL_SECONDS, ...extra });
const pkOf = (accountId: string, uploadId: string) => `wildduck-mcp#attachment-upload#${accountId}#${uploadId}`;
const stored = (value: AttachmentUploadRecord) => ({ pk: pkOf(value.accountId, value.uploadId), sk: 'STATE', ...value });
const throttled = (attempt: number, operation: string) => ({ event: 'dynamodb_throttled', store: 'upload', operation, attempt });
let logs: Record<string, unknown>[] = [];
let restoreWarnings = () => {};
beforeEach(() => { const captured = captureWarnings(); logs = captured.lines; restoreWarnings = captured.restore; });
afterEach(() => { restoreWarnings(); });

/** A table that enforces what DynamoDB enforces for these two calls: attribute_not_exists on the put, and for
 * BatchGetItem at most 100 distinct keys. Errors in `failures` are thrown before the command is applied. */
class FakeTable implements DynamoSender {
    readonly items = new Map<string, Record<string, unknown>>();
    readonly calls: DynamoCommand[] = [];
    readonly failures: unknown[] = [];
    /** Keys to hand back as UnprocessedKeys, per BatchGetItem call, instead of reading them. */
    readonly leaveUnprocessed: number[] = [];
    async send(command: DynamoCommand): Promise<unknown> {
        this.calls.push(command);
        const failure = this.failures.shift();
        if (failure !== undefined) { throw failure; }
        if (command instanceof PutCommand) {
            const item = command.input.Item as Record<string, unknown>; const pk = String(item.pk);
            if (command.input.ConditionExpression === 'attribute_not_exists(#pk)' && this.items.has(pk)) { throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }); }
            this.items.set(pk, structuredClone(item)); return {};
        }
        if (command instanceof BatchGetCommand) {
            const [table, request] = Object.entries(command.input.RequestItems ?? {})[0] ?? [];
            const keys = [...(request?.Keys ?? [])] as { pk: string; sk: string }[];
            if (keys.length > 100 || new Set(keys.map(key => key.pk)).size !== keys.length) { throw Object.assign(new Error('bad batch'), { name: 'ValidationException' }); }
            const skipped = keys.splice(keys.length - Math.min(this.leaveUnprocessed.shift() ?? 0, keys.length));
            const found = keys.flatMap(key => { const item = this.items.get(key.pk); return item === undefined ? [] : [structuredClone(item)]; });
            return { Responses: { [String(table)]: found }, UnprocessedKeys: skipped.length === 0 ? {} : { [String(table)]: { Keys: skipped, ConsistentRead: true } } };
        }
        throw new Error('unexpected command');
    }
}
function fixture(timeoutMs = 5000) {
    const client = new FakeTable(); const virtual = virtualRetry(1, NOW_MS);
    return { client, virtual, store: new DynamoAttachmentUploadStore({ tableName: 'UploadTable', client, timeoutMs, retry: virtual.retry }) };
}
const keysOf = (command: DynamoCommand | undefined) => ((command as BatchGetCommand).input.RequestItems?.UploadTable?.Keys ?? []).map(key => String(key.pk));

describe('createUpload', () => {
    test('is exactly one plain conditional put with a top-level numeric expiresAt (the table TTL attribute)', async () => {
        const { client, store } = fixture();
        await store.createUpload(record(1));
        expect(client.calls).toHaveLength(1);
        const command = client.calls[0] as PutCommand;
        expect(command).toBeInstanceOf(PutCommand);
        expect(command.input).toEqual({ TableName: 'UploadTable', Item: { pk: pkOf(owner.accountId, id(1)), sk: 'STATE', ...record(1) }, ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } });
        expect(typeof command.input.Item?.expiresAt).toBe('number');
        expect(Object.keys(command.input.Item ?? {}).sort()).toEqual(['accountId', 'clientIdHash', 'expiresAt', 'objectKey', 'pk', 'sha256', 'sizeBytes', 'sk', 'uploadId']);
        expect(String(command.input.Item?.pk).startsWith('wildduck-mcp#')).toBe(true);
        expect((client.calls as unknown[]).some(call => (call as TransactWriteCommand).input?.TransactItems !== undefined)).toBe(false);
    });
    test('an existing key is temporarily_unavailable, is not retried and leaves the stored record untouched', async () => {
        const { client, store, virtual } = fixture();
        await store.createUpload(record(1));
        await expect(store.createUpload(record(1, { sizeBytes: 99 }))).rejects.toThrow('temporarily_unavailable');
        expect(client.calls).toHaveLength(2); expect(virtual.sleeps).toEqual([]); expect(logs).toEqual([]);
        expect(client.items.get(pkOf(owner.accountId, id(1)))?.sizeBytes).toBe(1234);
    });
    test('invalid records are refused before any DynamoDB call', async () => {
        const { client, store } = fixture();
        const bad: Partial<AttachmentUploadRecord>[] = [
            { uploadId: 'not-a-uuid' }, { uploadId: UPPER }, { objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + id(2) }, { objectKey: id(1) },
            { sha256: 'AB'.repeat(32) }, { sha256: 'ab'.repeat(31) }, { sizeBytes: 0 }, { sizeBytes: MAX_UPLOAD_BYTES + 1 }, { sizeBytes: 1.5 },
            { accountId: 'a#b' }, { accountId: '' }, { clientIdHash: 'short' }, { expiresAt: 0 }, { expiresAt: 1.5 }, { expiresAt: Number.NaN }, { expiresAt: Infinity },
        ];
        for (const extra of bad) { await expect(store.createUpload(record(1, extra))).rejects.toThrow('temporarily_unavailable'); }
        await expect(store.createUpload({ ...record(1), extra: 'field' } as AttachmentUploadRecord)).rejects.toThrow('temporarily_unavailable');
        await store.createUpload(record(1, { sizeBytes: MAX_UPLOAD_BYTES }));
        expect(client.calls).toHaveLength(1);
    });
    test('throttling is retried with the identical command until it succeeds; an unknown error ends as temporarily_unavailable', async () => {
        const { client, store, virtual } = fixture();
        client.failures.push(throttleError(), throttleError('ThrottlingException'));
        await store.createUpload(record(1));
        expect(client.calls).toHaveLength(3); expect(client.calls[1]).toBe(client.calls[0]); expect(client.calls[2]).toBe(client.calls[0]);
        expect(virtual.sleeps).toEqual([200, 400]); expect(logs).toEqual([throttled(1, 'put'), throttled(2, 'put')]);
        expect(client.items.size).toBe(1);
        const failing = fixture(); failing.client.failures.push(new Error('boom'), new Error('boom'), new Error('boom'));
        await expect(failing.store.createUpload(record(1))).rejects.toThrow('temporarily_unavailable');
        expect(failing.client.calls).toHaveLength(3); expect(failing.virtual.sleeps).toEqual([25, 50]);
    });
    test('throttling that outlasts the budget is temporarily_unavailable and writes nothing', async () => {
        const { client, store, virtual } = fixture();
        client.failures.push(...Array.from({ length: 50 }, () => throttleError('RequestLimitExceeded')));
        await expect(store.createUpload(record(1))).rejects.toThrow('temporarily_unavailable');
        expect(client.items.size).toBe(0); expect(client.calls).toHaveLength(9); expect(logs).toHaveLength(9); expect(virtual.clock.ms).toBe(NOW_MS + 10000);
    });
});

describe('getUploads', () => {
    test('one strongly consistent batch read; only unexpired records of this account and client are returned, the rest simply absent', async () => {
        const { client, store } = fixture();
        const mine = record(1); const otherClient = record(2, { clientIdHash: 'd'.repeat(43) }); const otherAccount = record(3, { accountId: 'b'.repeat(24) });
        const expired = record(4, { expiresAt: NOW - 1 }); const exactlyNow = record(5, { expiresAt: NOW }); const lastSecond = record(6, { expiresAt: NOW + 1 });
        for (const value of [mine, otherClient, otherAccount, expired, exactlyNow, lastSecond]) { client.items.set(stored(value).pk, stored(value)); }
        const result = await store.getUploads(owner, [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(1)]);
        expect([...result.keys()].sort()).toEqual([id(1), id(6)]);
        expect(result.get(id(1))).toEqual(mine); expect(result.get(id(6))).toEqual(lastSecond);
        expect(client.calls).toHaveLength(1);
        const command = client.calls[0] as BatchGetCommand;
        expect(command).toBeInstanceOf(BatchGetCommand);
        expect(command.input).toEqual({ RequestItems: { UploadTable: { Keys: [1, 2, 3, 4, 5, 6, 7].map(n => ({ pk: pkOf(owner.accountId, id(n)), sk: 'STATE' })), ConsistentRead: true } } });
    });
    test('unknown, expired, foreign-client and foreign-account ids are indistinguishable (the same empty Map, no error)', async () => {
        const { client, store } = fixture();
        for (const value of [record(2, { clientIdHash: 'd'.repeat(43) }), record(3, { accountId: 'b'.repeat(24) }), record(4, { expiresAt: NOW - 5 })]) { client.items.set(stored(value).pk, stored(value)); }
        const outcomes = await Promise.all([1, 2, 3, 4].map(n => store.getUploads(owner, [id(n)])));
        for (const outcome of outcomes) { expect(outcome.size).toBe(0); }
        // The other account's item is not even requested: keys are always built from the caller's own account.
        expect(keysOf(client.calls[2])).toEqual([pkOf(owner.accountId, id(3))]);
    });
    test('no ids, or only ids that cannot exist, make no DynamoDB call', async () => {
        const { client, store } = fixture();
        expect((await store.getUploads(owner, [])).size).toBe(0);
        expect((await store.getUploads(owner, ['nope', '../x', UPPER, ''])).size).toBe(0);
        expect(client.calls).toHaveLength(0);
        await expect(store.getUploads({ ...owner, accountId: 'a#b' }, [id(1)])).rejects.toThrow('temporarily_unavailable');
        await expect(store.getUploads({ ...owner, clientIdHash: 'x' }, [id(1)])).rejects.toThrow('temporarily_unavailable');
        expect(client.calls).toHaveLength(0);
    });
    test('duplicates are asked for once; 100 ids are one call and a larger set is split at the batch limit', async () => {
        const { client, store } = fixture();
        const values = Array.from({ length: 150 }, (_, n) => record(n + 1));
        for (const value of values) { client.items.set(stored(value).pk, stored(value)); }
        const hundred = await store.getUploads(owner, [...values.slice(0, 100), ...values.slice(0, 50)].map(value => value.uploadId));
        expect(hundred.size).toBe(100); expect(client.calls).toHaveLength(1);
        client.calls.length = 0;
        const all = await store.getUploads(owner, values.map(value => value.uploadId));
        expect(all.size).toBe(150); expect(client.calls).toHaveLength(2);
        expect(keysOf(client.calls[0])).toHaveLength(100); expect(keysOf(client.calls[1])).toHaveLength(50);
    });
    test('UnprocessedKeys are retried, only those keys, with backoff and a throttle log, until complete', async () => {
        const { client, store, virtual } = fixture();
        for (const n of [1, 2, 3]) { client.items.set(stored(record(n)).pk, stored(record(n))); }
        client.leaveUnprocessed.push(2, 1);
        const result = await store.getUploads(owner, [id(1), id(2), id(3)]);
        expect([...result.keys()].sort()).toEqual([id(1), id(2), id(3)]);
        expect(client.calls).toHaveLength(3);
        expect(keysOf(client.calls[0])).toHaveLength(3); expect(keysOf(client.calls[1])).toEqual([pkOf(owner.accountId, id(2)), pkOf(owner.accountId, id(3))]); expect(keysOf(client.calls[2])).toEqual([pkOf(owner.accountId, id(3))]);
        expect(virtual.sleeps).toEqual([200, 400]); expect(logs).toEqual([throttled(1, 'batch_get'), throttled(2, 'batch_get')]);
    });
    test('keys that stay unprocessed until the budget ends are temporarily_unavailable, never a partial answer', async () => {
        const { client, store, virtual } = fixture();
        client.items.set(stored(record(1)).pk, stored(record(1)));
        client.leaveUnprocessed.push(...Array.from({ length: 50 }, () => 1));
        await expect(store.getUploads(owner, [id(1)])).rejects.toThrow('temporarily_unavailable');
        expect(virtual.clock.ms).toBe(NOW_MS + 10000);
    });
    test('a throttled batch read is retried, a throttle that never ends and any other error are temporarily_unavailable', async () => {
        const { client, store, virtual } = fixture();
        client.items.set(stored(record(1)).pk, stored(record(1)));
        client.failures.push(throttleError());
        expect((await store.getUploads(owner, [id(1)])).size).toBe(1);
        expect(client.calls).toHaveLength(2); expect(virtual.sleeps).toEqual([200]); expect(logs).toEqual([throttled(1, 'batch_get')]);
        client.failures.push(...Array.from({ length: 50 }, () => throttleError()));
        await expect(store.getUploads(owner, [id(1)])).rejects.toThrow('temporarily_unavailable');
        client.failures.length = 0; client.failures.push(new Error('socket closed'), new Error('socket closed'), new Error('socket closed'));
        await expect(store.getUploads(owner, [id(1)])).rejects.toThrow('temporarily_unavailable');
    });
    test('malformed stored items are dropped as absent while valid siblings are still returned', async () => {
        const { client, store } = fixture();
        const good = record(1);
        const corrupt: Record<string, unknown>[] = [
            { ...stored(record(2)), sizeBytes: '1234' }, { ...stored(record(3)), sha256: 'zz' }, { ...stored(record(4)), objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + id(1) },
            { ...stored(record(5)), extra: 'injected' }, { ...stored(record(6)), sk: 'OTHER' }, { ...stored(record(7)), expiresAt: String(NOW + 900) },
            { ...stored(record(8)), accountId: 'b'.repeat(24) }, { ...stored(record(9)), pk: pkOf(owner.accountId, id(1)) }, { ...stored(record(10)), clientIdHash: 7 },
        ];
        client.items.set(stored(good).pk, stored(good));
        // Each corrupt item sits under the key the caller will ask for, whatever its own pk/accountId/uploadId fields claim.
        for (const item of corrupt) { client.items.set(pkOf(owner.accountId, String(item.uploadId)), item); }
        const result = await store.getUploads(owner, [good.uploadId, ...corrupt.map(item => String(item.uploadId))]);
        expect([...result.keys()]).toEqual([id(1)]); expect(result.get(id(1))).toEqual(good);
        expect(logs).toEqual([]);
    });
});

test('construction validates the table name and both timeouts', () => {
    const client = new FakeTable();
    expect(() => new DynamoAttachmentUploadStore({ tableName: 'x', client })).toThrow('Invalid upload table name');
    expect(() => new DynamoAttachmentUploadStore({ tableName: 'UploadTable', client, timeoutMs: 5001 })).toThrow('Invalid upload store timeout');
    expect(() => new DynamoAttachmentUploadStore({ tableName: 'UploadTable', client, throttleTimeoutMs: 50_001 })).toThrow('Invalid upload store throttle timeout');
});
