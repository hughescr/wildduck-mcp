import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { conditionalConflict, DynamoRetrier, isThrottled, retryEnv, RESPONSE_RESERVE_MS, type DynamoCommand, type DynamoSender } from '../src/dynamo-retry';
import { DynamoAtomicStore } from '../src/auth/dynamo-store';
import { DynamoMailOperationStore } from '../src/mail/dynamo-store';
import { DynamoAttachmentUploadStore } from '../src/mail/upload-store';
import { ATTACHMENT_UPLOAD_KEY_PREFIX } from '../src/mail/contracts';
import { withRequestBudget } from '../src/request-budget';
import { cancelled, captureWarnings, throttleError, virtualRetry } from './dynamo-virtual';

let logs: Record<string, unknown>[] = [];
let restoreWarnings = () => {};
beforeEach(() => { const captured = captureWarnings(); logs = captured.lines; restoreWarnings = captured.restore; });
afterEach(() => { restoreWarnings(); });
const get = () => new GetCommand({ TableName: 'T', Key: { pk: 'p', sk: 'STATE' } });
const unavailable = () => new Error('unavailable');

describe('classification', () => {
    test('throttling is exactly the three documented exception names or a cancelled transaction that only throttled', () => {
        for (const name of ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded']) { expect(isThrottled({ name })).toBe(true); }
        expect(isThrottled(cancelled('ThrottlingError'))).toBe(true);
        expect(isThrottled(cancelled('None', 'ProvisionedThroughputExceeded'))).toBe(true);
        expect(isThrottled(cancelled('ThrottlingError', 'TransactionConflict'))).toBe(true);
        for (const value of [
            cancelled('ConditionalCheckFailed'), cancelled('ConditionalCheckFailed', 'ThrottlingError'), cancelled('TransactionConflict'), cancelled('None'), cancelled('ValidationError'),
            { name: 'TransactionCanceledException' }, { name: 'TransactionCanceledException', CancellationReasons: 'ThrottlingError' },
            { name: 'ConditionalCheckFailedException' }, { name: 'InternalServerError' }, { name: 'ServiceUnavailable' }, { name: 'IdempotentParameterMismatchException' },
            { message: 'ProvisionedThroughputExceededException' }, new Error('Throttling'), 'ThrottlingException', null, undefined, 3,
        ]) { expect(isThrottled(value)).toBe(false); }
    });
    test('a conflict is a cancellation of exactly the transaction size with only None and at least one ConditionalCheckFailed', () => {
        expect(conditionalConflict(cancelled('ConditionalCheckFailed', 'None'), 2)).toBe(true);
        for (const [value, count] of [[cancelled('ConditionalCheckFailed', 'None'), 3], [cancelled('None', 'None'), 2], [cancelled('ConditionalCheckFailed', 'ProvisionedThroughputExceeded'), 2], [{ name: 'Other', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }, 1], [null, 1]] as const) {
            expect(conditionalConflict(value, count)).toBe(false);
        }
    });
});

describe('retrier', () => {
    function make(send: (command: DynamoCommand, signal?: AbortSignal) => Promise<unknown>, options: { timeoutMs?: number; throttleTimeoutMs?: number; retryTransient?: boolean; env?: ReturnType<typeof virtualRetry>['retry'] } = {}) {
        const calls: DynamoCommand[] = [];
        const retrier = new DynamoRetrier({ store: 'mail', client: { send(command, sendOptions) { calls.push(command); return send(command, sendOptions?.abortSignal); } }, unavailable, env: retryEnv(options.env), timeoutMs: options.timeoutMs ?? 5000, throttleTimeoutMs: options.throttleTimeoutMs ?? 10_000, retryTransient: () => options.retryTransient ?? true });
        return { retrier, calls };
    }
    test('waits are capped exponential steps of full jitter: 200, 400, 800, then 1600 ms at most', async () => {
        for (const [random, expected] of [[1, [200, 400, 800, 1600, 1600, 1600]], [0.5, [100, 200, 400, 800, 800, 800]], [0, [0, 0, 0, 0, 0, 0]]] as const) {
            const virtual = virtualRetry(random); let attempts = 0;
            const { retrier } = make(async () => { if (++attempts <= 6) { throw throttleError(); } return 'ok'; }, { env: virtual.retry });
            expect(await retrier.send(get(), retrier.begin())).toBe('ok');
            expect(virtual.sleeps).toEqual([...expected]);
        }
    });
    test('an unthrottled stalled call is aborted at the short timeout; throttling extends the budget of the whole operation to the throttle timeout', async () => {
        let signal: AbortSignal | undefined;
        const stalled = make((_command, abortSignal) => { signal = abortSignal; return new Promise(() => {}); }, { timeoutMs: 20, throttleTimeoutMs: 10_000 });
        await expect(stalled.retrier.send(get(), stalled.retrier.begin())).rejects.toThrow('unavailable');
        expect(signal?.aborted).toBe(true); expect(stalled.calls).toHaveLength(1);
        // After a throttle the same operation may run past timeoutMs: the sleep below moves the virtual clock to 5 s and the call still goes on.
        const virtual = virtualRetry(1); let attempts = 0;
        const slow = make(async () => { if (++attempts === 1) { throw throttleError(); } virtual.clock.ms += 5000; return 'late'; }, { timeoutMs: 1000, throttleTimeoutMs: 10_000, env: virtual.retry });
        const budget = slow.retrier.begin();
        expect(await slow.retrier.send(get(), budget)).toBe('late');
        expect(budget.deadline).toBe(10_000);
        const plain = virtualRetry(1); const never = make(async () => { plain.clock.ms += 5000; return 'late'; }, { timeoutMs: 1000, env: plain.retry });
        // Unthrottled: the deadline stays at the short timeout.
        expect(never.retrier.begin().deadline).toBe(1000);
    });
    test('transient errors get two short retries only where allowed; an exhausted budget is never exceeded', async () => {
        const virtual = virtualRetry(); const failing = make(async () => { throw new Error('socket closed'); }, { env: virtual.retry });
        await expect(failing.retrier.send(get(), failing.retrier.begin())).rejects.toThrow('socket closed');
        expect(failing.calls).toHaveLength(3); expect(virtual.sleeps).toEqual([25, 50]);
        const none = make(async () => { throw new Error('socket closed'); }, { env: virtualRetry().retry, retryTransient: false });
        await expect(none.retrier.send(get(), none.retrier.begin())).rejects.toThrow('socket closed');
        expect(none.calls).toHaveLength(1);
        const late = virtualRetry(); const budgeted = make(async () => { late.clock.ms += 6000; throw new Error('slow failure'); }, { env: late.retry });
        await expect(budgeted.retrier.send(get(), budgeted.retrier.begin())).rejects.toThrow('unavailable');
        expect(budgeted.calls).toHaveLength(1);
    });
    test('conditional failures and token mismatches are final, and a conflicting transaction is returned untouched', async () => {
        for (const name of ['ConditionalCheckFailedException', 'IdempotentParameterMismatchException']) {
            const failing = make(async () => { throw Object.assign(new Error(name), { name }); }, { env: virtualRetry().retry });
            await expect(failing.retrier.send(get(), failing.retrier.begin())).rejects.toThrow(name);
            expect(failing.calls).toHaveLength(1);
        }
        // A failed condition is a normal outcome and says nothing; a reused token with another payload is a failure.
        expect(logs).toEqual([{ event: 'dynamodb_failed', store: 'mail', operation: 'get', kind: 'validation' }]); logs.length = 0;
        const conflict = cancelled('ConditionalCheckFailed');
        const transact = make(async () => { throw conflict; }, { env: virtualRetry().retry });
        const command = new TransactWriteCommand({ ClientRequestToken: 'token', TransactItems: [{ ConditionCheck: { TableName: 'T', Key: { pk: 'p', sk: 'STATE' }, ConditionExpression: 'attribute_exists(pk)' } }] });
        await expect(transact.retrier.send(command, transact.retrier.begin())).rejects.toBe(conflict);
        expect(transact.calls).toHaveLength(1); expect(logs).toEqual([]);
    });
    test('the short deadline is clamped to the live request time too; without a request budget, or early in a request, nothing changes', async () => {
        const virtual = virtualRetry(1); const { retrier } = make(async () => 'ok', { timeoutMs: 5000, env: virtual.retry });
        expect(retrier.begin().deadline).toBe(5000);
        // Authentication runs with nearly all of the 60 s left: the clamp is far beyond the short timeout.
        expect(withRequestBudget(() => 58_000, () => retrier.begin().deadline)).toBe(5000);
        expect(withRequestBudget(() => 3000, () => retrier.begin().deadline)).toBe(1000);
        // A stalled unthrottled call is aborted at the request deadline less the response reserve, not after its 5 s.
        let signal: AbortSignal | undefined; const started = performance.now();
        const stalled = make((_command, abortSignal) => { signal = abortSignal; return new Promise(() => {}); });
        await expect(withRequestBudget(() => RESPONSE_RESERVE_MS + 200 - (performance.now() - started), () => stalled.retrier.send(get(), stalled.retrier.begin()))).rejects.toThrow('unavailable');
        expect(signal?.aborted).toBe(true); expect(stalled.calls).toHaveLength(1); expect(performance.now() - started).toBeLessThan(2000);
    });
    test('the diagnostic is a fixed-literal structured line per throttled attempt and names no table, key, token or error text', async () => {
        const { retrier } = make(async () => { throw Object.assign(new Error('secret table detail pk=wildduck-mcp#x'), { name: 'ThrottlingException' }); }, { env: virtualRetry().retry, throttleTimeoutMs: 700 });
        await expect(retrier.send(get(), retrier.begin())).rejects.toThrow('unavailable');
        expect(logs.length).toBeGreaterThan(1);
        logs.forEach((line, index) => expect(line).toEqual({ event: 'dynamodb_throttled', store: 'mail', operation: 'get', attempt: index + 1 }));
    });
    test('a final non-throttle failure is one fixed-literal dynamodb_failed line with a kind from a fixed set, and never error text', async () => {
        const secret = 'secret table detail pk=wildduck-mcp#x account 123456789012';
        const failed = async (error: unknown, options: Parameters<typeof make>[1] = {}, command: DynamoCommand = get()) => {
            logs.length = 0; const { retrier } = make(async () => { throw error; }, { env: virtualRetry().retry, ...options });
            await expect(retrier.send(command, retrier.begin())).rejects.toBe(error); return [...logs];
        };
        const named = (name: string) => Object.assign(new Error(secret), { name });
        const line = (kind: string, operation = 'get') => ({ event: 'dynamodb_failed', store: 'mail', operation, kind });
        expect(await failed(new Error(secret))).toEqual([line('transient_exhausted')]);
        expect(await failed(new Error(secret), { retryTransient: false })).toEqual([line('other')]);
        expect(await failed(named('InternalServerError'), { retryTransient: false })).toEqual([line('transient_exhausted')]);
        for (const name of ['AccessDeniedException', 'UnrecognizedClientException', 'ExpiredTokenException']) { expect(await failed(named(name))).toEqual([line('access_denied')]); }
        for (const name of ['ValidationException', 'SerializationException']) { expect(await failed(named(name))).toEqual([line('validation')]); }
        expect(await failed(named('toString'), { retryTransient: false })).toEqual([line('other')]);
        expect(await failed({ code: 'x' }, { retryTransient: false })).toEqual([line('other')]);
        const transact = new TransactWriteCommand({ ClientRequestToken: 'token', TransactItems: [{ ConditionCheck: { TableName: 'T', Key: { pk: 'p', sk: 'STATE' }, ConditionExpression: 'attribute_exists(pk)' } }] });
        expect(await failed(named('ValidationException'), {}, transact)).toEqual([line('validation', 'transact')]);
        // Not logged: a failed condition, a cancelled transaction that only conflicted, and throttling (which has its own line).
        expect(await failed(named('ConditionalCheckFailedException'))).toEqual([]);
        expect(await failed(cancelled('ConditionalCheckFailed'), {}, transact)).toEqual([]);
        // A stalled call and a spent budget.
        logs.length = 0; const stalled = make(() => new Promise(() => {}), { timeoutMs: 20 });
        await expect(stalled.retrier.send(get(), stalled.retrier.begin())).rejects.toThrow('unavailable');
        expect(logs).toEqual([line('stalled')]); logs.length = 0;
        const late = virtualRetry(); const slow = make(async () => { late.clock.ms += 6000; throw new Error(secret); }, { env: late.retry });
        await expect(slow.retrier.send(get(), slow.retrier.begin())).rejects.toThrow('unavailable');
        expect(logs).toEqual([line('deadline')]); logs.length = 0;
        const spent = virtualRetry(); const over = make(async () => 'ok', { env: spent.retry }); const budget = over.retrier.begin(); spent.clock.ms += 6000;
        await expect(over.retrier.send(get(), budget)).rejects.toThrow('unavailable');
        expect(over.calls).toHaveLength(0); expect(logs).toEqual([line('deadline')]);
        expect(JSON.stringify(logs)).not.toContain('secret');
    });
});

describe('an exhausted request budget', () => {
    test('dispatches no request in any of the three stores: they fail temporarily_unavailable at once', async () => {
        const sent: DynamoCommand[] = [];
        const client: DynamoSender = { send(command) { sent.push(command); return new Promise(() => {}); } };
        const auth = new DynamoAtomicStore({ tableName: 'AuthTable', client });
        const mail = new DynamoMailOperationStore({ tableName: 'MailTable', client });
        const upload = new DynamoAttachmentUploadStore({ tableName: 'UploadTable', client });
        const account = '1'.repeat(24); const clientIdHash = 'c'.repeat(43); const uploadId = '00000000-0000-4000-8000-000000000001';
        const connection = { kind: 'connection', id: 'conn', revision: 0, expiresAt: 2000000000, accountId: 'account', credentialGeneration: 0, status: 'active', credentials: { keyId: 'v1', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abc' } } as const;
        const actions: Array<[string, () => Promise<unknown>]> = [
            ['auth get', () => auth.get('connection', 'conn')],
            ['auth transact', () => auth.transact({ operationId: 'a'.repeat(43), conditions: [{ kind: 'connection', id: 'conn', revision: null }], puts: [connection] })],
            ['mail getOperation', () => mail.getOperation({ accountId: account, clientIdHash, operationId: 'operation-00000001' })],
            ['mail reserve', () => mail.reserve({ accountId: account, clientIdHash, operationId: 'operation-00000001', tool: 'create_draft', payloadDigest: 'd'.repeat(43) }, 'owner-token-'.padEnd(43, 'a'))],
            ['upload getUploads', () => upload.getUploads({ accountId: account, clientIdHash }, [uploadId])],
            ['upload createUpload', () => upload.createUpload({ accountId: account, clientIdHash, uploadId, sizeBytes: 10, sha256: 'ab'.repeat(32), objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + uploadId, expiresAt: Math.floor(Date.now() / 1000) + 900 })],
        ];
        // At or below the response reserve nothing is left for the call itself.
        for (const remaining of [0, RESPONSE_RESERVE_MS - 1, RESPONSE_RESERVE_MS]) {
            for (const [label, action] of actions) {
                const started = performance.now();
                const outcome = await withRequestBudget(() => remaining, action).then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : 'thrown');
                expect({ label, remaining, outcome, fast: performance.now() - started < 100 }).toEqual({ label, remaining, outcome: 'temporarily_unavailable', fast: true });
            }
        }
        expect(sent).toEqual([]);
    });
});
