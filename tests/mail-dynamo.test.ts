import { describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoSender } from '../src/auth/dynamo-store';
import { DynamoMailOperationStore } from '../src/mail/dynamo-store';
import type { ConfirmedReceipt, MailOperationStore, OperationClaim, OperationKey, SourceGrade, WriteIntent } from '../src/mail/contracts';
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
    async send(command: GetCommand | TransactWriteCommand): Promise<unknown> {
        this.calls.push(command);
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
function fixture(timeoutMs = 5000) { const client = new ModelSender(); return { client, store: new DynamoMailOperationStore({ tableName: 'MailTable', client, timeoutMs }) }; }
async function lifecycleMatrix(store: MailOperationStore): Promise<void> {
    const send = intent();
    const reserved = await claim(store, send);
    expect((await store.reserve(send, 'other-owner'.padEnd(43, 'b'))).kind).toBe('replay');
    expect(await store.reserve({ ...send, payloadDigest: 'e'.repeat(43) }, owner)).toEqual({ kind: 'conflict', reason: 'operation_conflict' });
    expect(await store.reserve({ ...send, ...key('operation-00000002', 'x'.repeat(43)) }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const otherAccount = { ...send, ...key('operation-00000003', 'c'.repeat(43), '2'.repeat(24)) };
    const otherClaim = await claim(store, otherAccount);
    await store.failPreflight(otherClaim, { status: 'failed', operation_id: otherAccount.operationId, reason: 'version_conflict' });
    await claim(store, { ...otherAccount, operationId: 'operation-00000004' });
    const dispatched = await store.markDispatched(reserved);
    expect(dispatched.revision).toBe(1);
    await expect(store.markDispatched(reserved)).rejects.toThrow('temporarily_unavailable');
    await expect(store.complete({ ...dispatched, ownerToken: 'forged-owner'.padEnd(43, 'z') }, { status: 'queued', operation_id: send.operationId, queueId: 'queue-1' })).rejects.toThrow('temporarily_unavailable');
    await store.complete(dispatched, { status: 'queued', operation_id: send.operationId, queueId: 'queue-1' });
    const queued = await store.getOperation(key());
    expect(queued?.state).toBe('settled');
    if (queued?.state === 'settled') { expect(queued.receipt.status).toBe('queued'); }
    expect(await store.reserve({ ...send, operationId: 'operation-00000005' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    // A new mailbox/UID is independently writable; old targets never expire.
    const unknown = { ...intent('operation-00000006'), target: { mailboxId, uid: 2 } };
    const pending = await store.markDispatched(await claim(store, unknown));
    await store.markOutcomeUnknown(pending, { status: 'outcome_unknown', operation_id: unknown.operationId, reason: 'dispatch_uncertain' });
    expect((await store.reserve(unknown, owner)).kind).toBe('replay');
    expect(await store.reserve({ ...unknown, operationId: 'operation-00000007' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const update = { ...intent('operation-00000008', 'update_draft'), target: { mailboxId, uid: 3 } };
    const updating = await store.markDispatched(await claim(store, update));
    await store.complete(updating, { status: 'partial', operation_id: update.operationId, candidate: { mailboxId, uid: 4, version: digest }, candidateVerified: true, proof: verifiedDraft(4).proof, reason: 'original_deletion_failed', originalDeletion: 'failed' });
    expect(await store.reserve({ ...update, operationId: 'operation-00000009' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    await claim(store, { ...update, operationId: 'operation-00000010', target: { mailboxId, uid: 4 } });
    const create: WriteIntent = { ...key('operation-00000011'), tool: 'create_draft', payloadDigest: digest };
    const creating = await store.markDispatched(await claim(store, create));
    await store.complete(creating, { status: 'completed', operation_id: create.operationId, ...verifiedDraft(5) });
}
async function expandedMatrix(store: MailOperationStore): Promise<void> {
    const flags = { ...intent('operation-flags001', 'update_message_flags'), target: { mailboxId, uid: 200 } };
    await store.complete(await store.markDispatched(await claim(store, flags)), { status: 'completed', operation_id: flags.operationId, ...verifiedMessage(200) });
    const replay = await store.reserve(flags, owner);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay' && replay.record.state === 'settled') { expect(replay.record.receipt).toEqual({ status: 'completed', operation_id: flags.operationId, ...verifiedMessage(200) }); }
    const move = { ...flags, operationId: 'operation-move0001', tool: 'move_message' as const };
    const destination = 'b'.repeat(24);
    await store.complete(await store.markDispatched(await claim(store, move)), { status: 'completed', operation_id: move.operationId, ...verifiedMessage(201, destination) });
    expect(await store.reserve({ ...flags, operationId: 'operation-flags002' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    await claim(store, { ...flags, operationId: 'operation-flags003', target: { mailboxId: destination, uid: 201 } });
    const unknownFlags = { ...flags, operationId: 'operation-flags004', target: { mailboxId, uid: 202 } };
    await store.markOutcomeUnknown(await store.markDispatched(await claim(store, unknownFlags)), { status: 'outcome_unknown', operation_id: unknownFlags.operationId, reason: 'dispatch_uncertain' });
    expect(await store.reserve({ ...unknownFlags, operationId: 'operation-flags005' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const unverified = { ...intent('operation-partial01', 'update_draft'), target: { mailboxId, uid: 203 } };
    await store.complete(await store.markDispatched(await claim(store, unverified)), { status: 'partial', operation_id: unverified.operationId, candidate: { mailboxId, uid: 204 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
    expect(await store.reserve({ ...unverified, operationId: 'operation-partial02' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const stale = { ...intent('operation-partial03', 'update_draft'), target: { mailboxId, uid: 205 } };
    const receipt = { status: 'partial' as const, operation_id: stale.operationId, candidate: verifiedDraft(206).draft, candidateVerified: true as const, proof: verifiedDraft(206).proof, reason: 'original_version_changed' as const, originalDeletion: 'not_attempted' as const };
    await store.complete(await store.markDispatched(await claim(store, stale)), receipt);
    const staleReplay = await store.getOperation(key(stale.operationId));
    expect(staleReplay?.state).toBe('settled'); if (staleReplay?.state === 'settled') { expect(staleReplay.receipt).toEqual(receipt); }
    expect(await store.reserve({ ...stale, operationId: 'operation-partial04' }, owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    const sending = { ...intent('operation-send-sent'), target: { mailboxId, uid: 207 } };
    const sent = { mailboxId: destination, uid: 208 };
    await store.complete(await store.markDispatched(await claim(store, sending)), { status: 'queued', operation_id: sending.operationId, queueId: 'actual-queue', sent });
    const sentRecord = await store.getOperation(key(sending.operationId));
    if (sentRecord?.state === 'settled') { expect(sentRecord.receipt).toEqual({ status: 'queued', operation_id: sending.operationId, queueId: 'actual-queue', sent }); } else { throw new Error('missing send receipt'); }
}
async function provenanceMatrix(store: MailOperationStore): Promise<void> {
    let uid = 300;
    for (const tool of ['move_message', 'update_message_flags'] as const) {
        for (const grade of ['observed', 'mcp_authored'] as const) {
            const operationId = `operation-provenance${uid}`;
            const value = { ...intent(operationId, tool), target: { mailboxId, uid } };
            const message = verifiedMessage(uid, tool === 'move_message' ? 'b'.repeat(24) : mailboxId, grade);
            const receipt = { status: 'completed' as const, operation_id: operationId, ...message };
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
        await expect(store.failPreflight(reserved, { status: 'failed', operation_id: key().operationId, reason: 'forbidden' })).rejects.toThrow('temporarily_unavailable');
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
        await expect(store.complete(dispatched, { status: 'queued', operation_id: 'operation-other000', queueId: 'queue' })).rejects.toThrow('temporarily_unavailable');
        await expect(store.complete(dispatched, { status: 'completed', operation_id: key().operationId, ...verifiedDraft(1) })).rejects.toThrow('temporarily_unavailable');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(count);
        const stored = [...client.records.values()].find(value => String(value.pk).includes('#mail-operation#'));
        if (!stored) { throw new Error('missing operation'); } stored.expiresAt = 1;
        await expect(store.getOperation(key())).rejects.toThrow('temporarily_unavailable');
    });
    test('invalid partial replacement receipts cannot commit; dispatch cannot be released as preflight failure', async () => {
        const { store } = fixture(); const updating = await store.markDispatched(await claim(store, intent('operation-00000001', 'update_draft')));
        await expect(store.complete(updating, { status: 'completed', operation_id: key().operationId, ...verifiedDraft(2), previousDeleted: false } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
        await expect(store.failPreflight({ ...updating, state: 'reserved' }, { status: 'failed', operation_id: key().operationId, reason: 'forbidden' })).rejects.toThrow('temporarily_unavailable');
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
        await expect(store.complete(deleting, { status: 'completed', operation_id: key().operationId, deleted: { mailboxId, uid: 2 } })).rejects.toThrow('temporarily_unavailable');
        await store.complete(deleting, { status: 'completed', operation_id: key().operationId, deleted: { mailboxId, uid: 1 } });
        expect(await store.reserve(intent('operation-00000002'), owner)).toEqual({ kind: 'conflict', reason: 'draft_fenced' });
    });
    test('flag completion atomically releases guard, survives a lost response and never releases a subsequent owner on replay', async () => {
        const { client, store } = fixture(); const value = intent('operation-flags001', 'update_message_flags');
        const dispatched = await store.markDispatched(await claim(store, value)); client.fault = 'lost_once';
        await store.complete(dispatched, { status: 'completed', operation_id: value.operationId, ...verifiedMessage(1) });
        const writes = client.calls.filter(command => command instanceof TransactWriteCommand);
        expect(writes.at(-1)).toBe(writes.at(-2));
        expect(writes.at(-1)?.input.TransactItems?.[1]?.Delete).toBeDefined();
        const next = await claim(store, { ...value, operationId: 'operation-flags002', clientIdHash: 'x'.repeat(43) });
        const before = client.calls.filter(command => command instanceof TransactWriteCommand).length;
        expect((await store.reserve(value, owner)).kind).toBe('replay');
        expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(before);
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
        await expect(store.complete(dispatched, { status: 'completed', operation_id: value.operationId, ...verifiedMessage(1) })).rejects.toThrow('temporarily_unavailable');
        expect((await store.getOperation(key(value.operationId)))?.state).toBe('dispatched');
        expect(client.records.has(String(guard.pk))).toBe(true);
    });
    test('wrong-account proofs, wrong flag UID, same-mailbox moves and private flag sets never commit', async () => {
        for (const tool of ['update_message_flags', 'move_message', 'update_draft'] as const) {
            const { client, store } = fixture(); const value = intent('operation-invalid001', tool);
            const dispatched = await store.markDispatched(await claim(store, value));
            const valid = tool === 'update_draft' ? { status: 'completed', operation_id: value.operationId, ...verifiedDraft(2), previousDeleted: true } : { status: 'completed', operation_id: value.operationId, ...verifiedMessage(tool === 'move_message' ? 2 : 1, tool === 'move_message' ? 'b'.repeat(24) : mailboxId) };
            const count = client.calls.filter(command => command instanceof TransactWriteCommand).length;
            await expect(store.complete(dispatched, { ...valid, proof: { ...valid.proof, accountId: 'f'.repeat(24) } } as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            if (tool === 'update_message_flags') {
                await expect(store.complete(dispatched, { status: 'completed', operation_id: value.operationId, ...verifiedMessage(2) })).rejects.toThrow('temporarily_unavailable');
                await expect(store.complete(dispatched, { ...valid, labels: ['private-label'] } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            }
            if (tool === 'move_message') { await expect(store.complete(dispatched, { status: 'completed', operation_id: value.operationId, ...verifiedMessage(2) })).rejects.toThrow('temporarily_unavailable'); }
            expect(client.calls.filter(command => command instanceof TransactWriteCommand)).toHaveLength(count);
        }
    });
    test('draft receipts require authored proof, never upgrade observed or absent provenance', async () => {
        for (const tool of ['create_draft', 'update_draft'] as const) {
            const { client, store } = fixture();
            const value: WriteIntent = tool === 'create_draft' ? { ...key(), tool, payloadDigest: digest } : intent(key().operationId, tool);
            const dispatched = await store.markDispatched(await claim(store, value));
            const valid = { status: 'completed' as const, operation_id: value.operationId, ...verifiedDraft(2), ...(tool === 'update_draft' ? { previousDeleted: true as const } : {}) };
            const writes = client.calls.filter(command => command instanceof TransactWriteCommand).length;
            const { sourceGrade: _grade, ...missingGrade } = valid.proof;
            for (const proof of [missingGrade, { ...valid.proof, sourceGrade: 'observed' }, { ...valid.proof, sourceGrade: 'invented_grade' }]) {
                await expect(store.complete(dispatched, { ...valid, proof } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
            }
            if (tool === 'update_draft') {
                await expect(store.complete(dispatched, { status: 'partial', operation_id: value.operationId, candidate: verifiedDraft(2).draft, candidateVerified: true, proof: { ...valid.proof, sourceGrade: 'observed' }, reason: 'original_deletion_failed', originalDeletion: 'failed' } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
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
        await store.complete(await store.markDispatched(await claim(store, value)), { status: 'completed', operation_id: value.operationId, ...verifiedMessage(1) });
        const row = [...client.records.values()].find(record => String(record.pk).includes('#mail-operation#'));
        if (!row) { throw new Error('missing operation'); }
        const record = row.record as { receipt: { proof: Record<string, unknown> } };
        delete record.receipt.proof.sourceGrade;
        await expect(store.getOperation(key(value.operationId))).rejects.toThrow('temporarily_unavailable');
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
    await expect(f.store.complete(dispatched, { status: 'completed', operation_id: value.operationId, ...verifiedDraft(9), proof: { ...verifiedDraft(9).proof, sourceGrade: 'observed' } } as unknown as ConfirmedReceipt)).rejects.toThrow('temporarily_unavailable');
    const receipt = { status: 'completed' as const, operation_id: value.operationId, ...verifiedDraft(9) }; await f.store.complete(dispatched, receipt);
    expect(await f.store.getOperation(key())).toMatchObject({ state: 'settled', receipt }); expect((await f.store.reserve(value, owner)).kind).toBe('replay');
    expect(await f.store.reserve({ ...value, payloadDigest: 'e'.repeat(43) }, owner)).toEqual({ kind: 'conflict', reason: 'operation_conflict' }); expect(f.client.records.size).toBe(1);
});
