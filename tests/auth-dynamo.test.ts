import { describe, expect, test } from 'bun:test';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoAtomicStore } from '../src/auth/dynamo-store';
import type { AtomicWrite, Connection } from '../src/auth/contracts';
const connection = (id = 'conn', revision = 0): Connection => ({ kind: 'connection', id, revision, expiresAt: 2000000000, accountId: 'account', credentialGeneration: 0, status: 'active', credentials: { keyId: 'v1', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abc' } });
const write = (): AtomicWrite => ({ operationId: 'a'.repeat(43), conditions: [{ kind: 'connection', id: 'conn', revision: null }], puts: [connection()] });
function fixture(handler: (command: GetCommand | TransactWriteCommand) => Promise<unknown> = async () => ({}), timeoutMs = 5000) {
    const calls: (GetCommand | TransactWriteCommand)[] = [];
    const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs, client: { async send(command) { calls.push(command); return handler(command); } } });
    return { calls, store };
}
describe('DynamoDB auth store', () => {
    test('strong reads use exact namespace, validate stored shape and do not write', async () => {
        const { store, calls } = fixture(async () => ({ Item: { ...connection(), pk: 'wildduck-mcp#connection#conn', sk: 'STATE' } }));
        expect(await store.get('connection', 'conn')).toEqual(connection());
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBeInstanceOf(GetCommand);
        expect(calls[0]?.input).toEqual({ TableName: 'AuthTable', Key: { pk: 'wildduck-mcp#connection#conn', sk: 'STATE' }, ConsistentRead: true });
        for (const item of [{ ...connection(), pk: 'other', sk: 'STATE' }, { ...connection(), revision: NaN, pk: 'wildduck-mcp#connection#conn', sk: 'STATE' }, { ...connection(), extra: 'injected', pk: 'wildduck-mcp#connection#conn', sk: 'STATE' }]) {
            await expect(fixture(async () => ({ Item: item })).store.get('connection', 'conn')).rejects.toThrow('temporarily_unavailable');
        }
        expect(await fixture().store.get('connection', 'conn')).toBeUndefined();
        await expect(store.get('connection', 'x#grant#id')).rejects.toThrow('Invalid auth record key');
        expect(calls).toHaveLength(1);
    });
    test('mixed transactions combine put conditions without duplicate keys; stable AWS idempotency token', async () => {
        const { store, calls } = fixture();
        const transaction = write();
        transaction.conditions.push({ kind: 'connection', id: 'reader', revision: 4 });
        expect(await store.transact(transaction)).toBe(true);
        expect(await store.transact(transaction)).toBe(true);
        const first = calls[0] as TransactWriteCommand;
        expect(first.input).toEqual((calls[1] as TransactWriteCommand).input);
        expect(first.input.ClientRequestToken).toHaveLength(36);
        expect(first.input.TransactItems).toHaveLength(2);
        expect(first.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(#pk)');
        expect(first.input.TransactItems?.[1]?.ConditionCheck?.Key).toEqual({ pk: 'wildduck-mcp#connection#reader', sk: 'STATE' });
        const update = { ...write(), conditions: [{ kind: 'connection' as const, id: 'conn', revision: 0 }], puts: [connection('conn', 1)] };
        await store.transact(update);
        expect((calls[2] as TransactWriteCommand).input.TransactItems?.[0]?.Put?.ExpressionAttributeValues).toEqual({ ':revision': 0 });
    });
    test('rejects blind overwrites, duplicates and unsupported record fields before sending', async () => {
        const { store, calls } = fixture();
        const transactions = [
            { ...write(), conditions: [] },
            { ...write(), puts: [connection(), connection()] },
            { ...write(), conditions: [...write().conditions, ...write().conditions] },
            { ...write(), puts: [{ ...connection(), revision: 1 }] },
            { ...write(), puts: [{ ...connection(), pk: 'other' }] },
            { ...write(), puts: [{ ...connection(), expiresAt: Infinity }] },
        ];
        for (const transaction of transactions) { await expect(store.transact(transaction)).rejects.toThrow(); }
        expect(calls).toHaveLength(0);
    });
    test('only explicit conditional cancellation is false; throttles and unknown outcomes remain temporary', async () => {
        const failure = (value: unknown) => fixture(async () => { throw value; }).store.transact(write());
        expect(await failure({ name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] })).toBe(false);
        for (const error of [
            { name: 'TransactionCanceledException' },
            { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] },
            { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] },
            { name: 'ThrottlingException' }, { name: 'ProvisionedThroughputExceededException' },
            { name: 'IdempotentParameterMismatchException' }, new Error('unknown commit outcome'),
        ]) { await expect(failure(error)).rejects.toThrow('temporarily_unavailable'); }
        const mixed = fixture(async () => { throw { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ProvisionedThroughputExceeded' }] }; }).store;
        await expect(mixed.transact({ ...write(), conditions: [...write().conditions, { kind: 'connection', id: 'other', revision: 1 }] })).rejects.toThrow('temporarily_unavailable');
    });
    test('a stalled SDK call is bounded and aborted', async () => {
        let signal: AbortSignal | undefined;
        const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs: 5, client: { send(_command, options) { signal = options?.abortSignal; return new Promise(() => {}); } } });
        await expect(store.transact(write())).rejects.toThrow('temporarily_unavailable');
        expect(signal?.aborted).toBe(true);
    });
});

test('ambiguous delivery retries the identical transaction token and payload before success', async () => {
    let attempts = 0;
    const { store, calls } = fixture(async () => { if (++attempts === 1) { throw new Error('socket closed after commit'); } return {}; });
    expect(await store.transact(write())).toBe(true);
    expect(calls).toHaveLength(2);
    expect((calls[0] as TransactWriteCommand).input).toEqual((calls[1] as TransactWriteCommand).input);
});

test.skipIf(process.env.DYNAMO_LOCAL_AUTH_TEST !== '1')('actual DynamoDB Local: atomic CAS, mixed read conditions, 1/1 capacity and idempotent retry', async () => {
    const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DeleteTableCommand, UpdateTimeToLiveCommand } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    // Endpoint and dummy credentials are hardcoded: this test can never reach AWS.
    const client = new DynamoDBClient({ endpoint: 'http://127.0.0.1:18765', region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1 });
    const tableName = `AuthTest${Date.now()}`;
    try {
        await client.send(new CreateTableCommand({ TableName: tableName, AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }));
        await client.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }));
        const store = new DynamoAtomicStore({ tableName, client: DynamoDBDocumentClient.from(client) });
        const create = write();
        expect(await store.transact(create)).toBe(true);
        expect(await store.transact(create)).toBe(true);
        expect(await store.get('connection', 'conn')).toEqual(connection());
        expect(await store.transact({ ...create, operationId: 'another-create' })).toBe(false);
        const mixed: AtomicWrite = { operationId: 'mixed-update', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }, { kind: 'connection', id: 'new', revision: null }], puts: [connection('new')] };
        expect(await store.transact(mixed)).toBe(true);
        expect(await store.transact({ operationId: 'update', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }], puts: [connection('conn', 1)] })).toBe(true);
        expect(await store.transact({ ...mixed, operationId: 'stale-mixed', conditions: [{ kind: 'connection', id: 'conn', revision: 0 }, { kind: 'connection', id: 'blocked', revision: null }], puts: [connection('blocked')] })).toBe(false);
        expect(await store.get('connection', 'blocked')).toBeUndefined();
        await expect(store.transact({ ...create, puts: [{ ...connection(), status: 'revoked' }] })).rejects.toThrow('temporarily_unavailable');
        const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
        expect(table.Table?.ProvisionedThroughput?.ReadCapacityUnits).toBe(1);
        expect(table.Table?.ProvisionedThroughput?.WriteCapacityUnits).toBe(1);
    } finally { await client.send(new DeleteTableCommand({ TableName: tableName })); client.destroy(); }
});

test('real SDK throttling consumes only the unified three-attempt HTTP budget', async () => {
    const { Readable } = await import('node:stream');
    const store = new DynamoAtomicStore({ tableName: 'AuthTable', timeoutMs: 5000 });
    // Keep the production-created SDK client and retry stack. Replace only its
    // transport and identity providers so no HTTP or credential lookup escapes.
    const { client } = store as unknown as { client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient };
    client.config.region = async () => 'us-east-1';
    client.config.credentials = async () => ({ accessKeyId: 'local', secretAccessKey: 'local' });
    let attempts = 0;
    const payloads: string[] = [];
    let failure = { __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException', message: 'local synthetic throttle' } as Record<string, unknown>;
    client.config.requestHandler = {
        async handle(request) {
            attempts++;
            payloads.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8'));
            return { response: { statusCode: 400, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(failure)]) } };
        },
    };
    try {
        await expect(store.transact(write())).rejects.toThrow('temporarily_unavailable');
        expect(attempts).toBe(3);
        expect(new Set(payloads).size).toBe(1);
        attempts = 0;
        failure = { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] };
        expect(await store.transact(write())).toBe(false);
        expect(attempts).toBe(1);
    } finally { client.destroy(); }
});
