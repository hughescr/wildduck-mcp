import { withRequestBudget } from '../src/request-budget';
import { expect, test } from 'bun:test';
import { digest } from '../src/auth/crypto';
import { createMailService } from '../src/mail/service';
import { MailError, type ConfirmedReceipt, type MailOperationMarker, type FailedReceipt, type MailBackendReader, type MailBackendWriter, type MailContext, type MailOperationRecord, type MailOperationStore, type OperationClaim, type OperationKey, type ReservationResult, type UnknownReceipt, type WriteIntent, type MessageSnapshot, type PreparedDraft } from '../src/mail/contracts';

const accountId = 'a'.repeat(24); const mailboxId = 'b'.repeat(24); const version = 'v'.repeat(43);
const context: MailContext = { accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:read', 'mail:draft', 'mail:send', 'mail:modify'], connectionStatus: 'active' };
const operation_id = 'operation_test_001';
const target = { uid: 7, expected_version: version, operation_id };
const content = { to: [{ address: 'to@example.com' }], cc: [], bcc: [], subject: 'private subject', body: { text: 'private body', html: '<p>private body</p>' }, attachments: [] };
const keyOf = (key: OperationKey) => JSON.stringify([key.accountId, key.clientIdHash, key.operationId]);
const guardOf = (intent: WriteIntent) => intent.tool === 'create_draft' || intent.tool === 'create_reply_draft' ? undefined : JSON.stringify([intent.accountId, intent.target.mailboxId, intent.target.uid]);
class Store implements MailOperationStore {
    records = new Map<string, MailOperationRecord>(); guards = new Map<string, string>(); calls: string[] = [];
    completeFault: 'none' | 'before' | 'after' = 'none'; markFault: 'none' | 'before' | 'after' = 'none'; unknownFault = false; preflightFault = false;
    async getOperation(key: OperationKey): Promise<MailOperationRecord | undefined> { this.calls.push('get'); const record = this.records.get(keyOf(key)); return record && structuredClone(record); }
    async reserve(intent: WriteIntent, ownerToken: string): Promise<ReservationResult> {
        this.calls.push('reserve'); const key = keyOf(intent); const existing = this.records.get(key);
        if (existing) { return JSON.stringify(existing.intent) === JSON.stringify(intent) ? { kind: 'replay', record: structuredClone(existing) } : { kind: 'conflict', reason: 'operation_conflict' }; }
        const guard = guardOf(intent); if (guard && this.guards.has(guard)) { return { kind: 'conflict', reason: 'draft_fenced' }; }
        const operation: MailOperationRecord = { key: { accountId: intent.accountId, clientIdHash: intent.clientIdHash, operationId: intent.operationId }, intent, ownerToken, revision: 0, state: 'reserved' };
        this.records.set(key, structuredClone(operation)); if (guard) { this.guards.set(guard, key); }
        return { kind: 'acquired', claim: { key: operation.key, ownerToken, revision: 0, state: 'reserved' } };
    }
    checked(claim: OperationClaim): MailOperationRecord {
        const record = this.records.get(keyOf(claim.key));
        if (!record || record.state !== claim.state || record.revision !== claim.revision || record.ownerToken !== claim.ownerToken) { throw new MailError('temporarily_unavailable'); }
        const guard = guardOf(record.intent); if (guard && this.guards.get(guard) !== keyOf(claim.key)) { throw new MailError('temporarily_unavailable'); }
        return record;
    }
    async markDispatched(claim: OperationClaim<'reserved'>): Promise<OperationClaim<'dispatched'>> {
        this.calls.push('dispatch'); if (this.markFault === 'before') { throw new Error('secret dispatch failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, state: 'dispatched', revision: record.revision + 1 });
        if (this.markFault === 'after') { throw new Error('secret committed dispatch failure'); }
        return { ...claim, state: 'dispatched', revision: record.revision + 1 };
    }
    async failPreflight(claim: OperationClaim<'reserved'>, receipt: FailedReceipt): Promise<void> {
        this.calls.push('fail'); if (this.preflightFault) { throw new Error('secret failed release'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt });
        const guard = guardOf(record.intent); if (guard) { this.guards.delete(guard); }
    }
    async complete(claim: OperationClaim<'dispatched'>, receipt: ConfirmedReceipt): Promise<void> {
        this.calls.push('complete'); if (this.completeFault === 'before') { throw new Error('secret completion failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt });
        if (record.intent.tool === 'update_message_flags') { const guard = guardOf(record.intent); if (guard) { this.guards.delete(guard); } }
        if (this.completeFault === 'after') { throw new Error('secret committed completion failure'); }
    }
    async markOutcomeUnknown(claim: OperationClaim<'dispatched'>, receipt: UnknownReceipt): Promise<void> {
        this.calls.push('unknown'); if (this.unknownFault) { throw new Error('secret unknown failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt });
    }
}
function fixture(authored = true) {
    const operations = new Store(); const calls: { method: string; args: unknown[] }[] = [];
    const mailbox = { mailboxId, path: 'Drafts', specialUse: '\\Drafts' };
    const message = { mailboxId, uid: 7, subject: 'subject', snippet: null, threadId: null, from: [], to: [], date: null, receivedAt: null, flags: { seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false }, imapFlags: [], labels: [], hasAttachments: false };
    const snapshot = { message: { mailboxId, uid: 7, version }, isDraft: true, hasHtml: true, hasAttachments: true, hasRecipients: true };
    const messages = new Map<string, MessageSnapshot>();
    const seedKey = { accountId, clientIdHash: digest('seed-client'), operationId: 'seed_authored_001' };
    const seedMarker: MailOperationMarker & { tool: 'create_draft' } = { ...seedKey, tool: 'create_draft', payloadDigest: digest('seed-input') };
    if (authored) {
        operations.records.set(keyOf(seedKey), structuredClone({ key: seedKey, intent: seedMarker, ownerToken: 'seed-owner', revision: 1, state: 'settled', receipt: { status: 'completed', operation_id: seedKey.operationId, draft: snapshot.message, verified: true, proof: { accountId, ...snapshot.message, contentDigest: 'd'.repeat(64), sourceGrade: 'mcp_authored' } } }));
    }
    const behavior = { snapshot, sourceMismatch: false, unexpectedGrade: false, mutationDigestMismatch: false, nextUid: 8, queueId: 'queue-1', postError: false, wrongMailbox: false, verificationError: false, preparationError: false, originalChanged: false, originalReadError: false, deletionError: undefined as Error | undefined, marker: (authored ? seedMarker : undefined) as MailOperationMarker | undefined, beforeInspect: async () => {} };
    const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
    const find = (key: { mailboxId: string; uid: number }): MessageSnapshot => messages.get(JSON.stringify(key)) ?? { ...behavior.snapshot, ...(behavior.marker ? { marker: behavior.marker } : {}) };
    const reader: MailBackendReader = {
        getAttachmentDownload: async (_bound, input) => ({ ...input, filename: null, contentType: 'text/plain', size: 5, url: 'https://example.s3.amazonaws.com/file', expiresAt: '2026-10-26T10:00:00.000Z' }),
        getThread: async (_bound, input) => ({ threadId: input.threadId ?? mailboxId, messages: [message] }),
        listMailboxes: async (...args) => { record('listMailboxes', ...args); return { mailboxes: [mailbox] }; },
        listMessages: async (...args) => { record('listMessages', ...args); return { messages: [message] }; },
        searchMessages: async (...args) => { record('searchMessages', ...args); return { messages: [message] }; },
        readMessage: async (...args) => {
            record('readMessage', ...args); const stored = find(args[1]);
            return { message: { ...message, ...stored.message, replyTo: [], cc: [], bcc: [], messageId: null, references: [], text: 'text', textTruncated: false, html: ['<p>html</p>'], htmlTruncated: false, htmlRepresentation: 'wildduck_normalized', attachments: [] }, ...(stored.marker ? { marker: stored.marker } : {}) };
        },
        readAttachment: async (...args) => { record('readAttachment', ...args); return { metadata: { ...args[1], filename: 'file.bin', contentType: 'application/octet-stream', size: 3, resourceUri: 'wildduck://attachment/file' }, bytes: new Uint8Array([0, 1, 255]) }; },
    };
    const prepare = (marker: MailOperationMarker): PreparedDraft => ({ mailboxId, marker, mime: { raw: Buffer.from('test MIME bytes'), sha256: 'd'.repeat(64), envelope: { from: [], replyTo: [], to: [], cc: [], bcc: [] }, retainedAttachments: [] } });
    const writer: MailBackendWriter = {
        resolveDraftMailbox: async (...args) => { record('resolve', ...args); return mailbox; },
        inspectMessage: async (...args) => { record('inspect', ...args); await behavior.beforeInspect(); if (behavior.originalReadError) { throw new MailError('temporarily_unavailable'); } return find(args[1]); },
        verifyAuthoredSource: async (...args) => { record('sourcecheck', ...args); if (behavior.sourceMismatch) { throw new MailError('verification_failed'); } },
        prepareReply: async (...args) => { record('prepareReply', ...args); if (behavior.preparationError) { throw new MailError('unsupported_content'); } return prepare(args[2]); },
        prepareCreate: async (...args) => { record('prepareCreate', ...args); if (behavior.preparationError) { throw new MailError('unsupported_content'); } return prepare(args[2]); },
        prepareUpdate: async (...args) => { record('prepareUpdate', ...args); if (behavior.sourceMismatch) { throw new MailError('verification_failed'); } if (behavior.preparationError) { throw new MailError('source_integrity_unavailable'); } return prepare(args[3]); },
        uploadPreparedDraft: async (...args) => {
            record('upload', ...args); if (behavior.postError) { throw new Error('secret token or backend body'); }
            const key = { mailboxId: behavior.wrongMailbox ? 'd'.repeat(24) : mailboxId, uid: behavior.nextUid++ };
            messages.set(JSON.stringify(key), { ...snapshot, message: { ...key, version }, marker: args[1].marker }); return key;
        },
        verifyPreparedDraft: async (...args) => {
            record('verify', ...args); if (behavior.verificationError) { throw new MailError('verification_failed'); }
            if (behavior.originalChanged) { behavior.snapshot.message.version = 'z'.repeat(43); }
            return { ...args[1], version };
        },
        deleteDraft: async (...args) => { record('delete', ...args); if (behavior.deletionError) { throw behavior.deletionError; } if (behavior.postError) { throw new Error('secret token or backend body'); } },
        stampSendMarker: async (...args) => { record('stamp', ...args); behavior.marker = args[2]; return args[1].message; },
        submitDraft: async (...args) => { record('submit', ...args); if (behavior.postError) { throw new Error('secret token or backend body'); } return { queueId: behavior.queueId }; },
        moveMessage: async (...args) => { record('move', ...args); const moved = { mailboxId: args[2], uid: 9, version }; messages.set(JSON.stringify({ mailboxId: moved.mailboxId, uid: moved.uid }), { ...snapshot, message: moved, marker: args[3] }); return { message: moved, contentDigest: (behavior.mutationDigestMismatch ? 'e' : 'd').repeat(64), sourceGrade: args[4] || behavior.unexpectedGrade ? 'mcp_authored' : 'observed' }; },
        updateMessageFlags: async (...args) => { record('flags', ...args); const changed = { ...args[1].message, version: 'f'.repeat(43) }; messages.set(JSON.stringify({ mailboxId: changed.mailboxId, uid: changed.uid }), { ...snapshot, message: changed, marker: args[3] }); return { message: changed, contentDigest: (behavior.mutationDigestMismatch ? 'e' : 'd').repeat(64), sourceGrade: args[4] || behavior.unexpectedGrade ? 'mcp_authored' : 'observed' }; },
    };
    return { service: createMailService({ reader, writer, operations }), operations, calls, behavior, reader, writer, mailbox, messages };
}
const posts = (f: ReturnType<typeof fixture>) => f.calls.filter(call => ['upload', 'delete', 'submit', 'move', 'flags'].includes(call.method));

test('read methods return sanitized DTOs and bind only server credentials to readers', async () => {
    const f = fixture(false);
    expect((await f.service.list_mailboxes(context, {})).mailboxes).toHaveLength(1);
    expect((await f.service.list_messages(context, { mailboxId, limit: 20 })).messages).toHaveLength(1);
    expect((await f.service.search_messages(context, { text: 'needle', limit: 20 })).messages).toHaveLength(1);
    expect((await f.service.read_message(context, { mailboxId, uid: 7 })).text).toBe('text');
    for (const call of f.calls) { expect(call.args[0]).toEqual({ accountId, accessToken: context.accessToken }); }
    expect(f.operations.calls).toHaveLength(0);
});
test('invalid account, raw token, scope, status and unknown arguments fail before backend/store', async () => {
    const f = fixture();
    for (const bad of [{ ...context, accountId: 'other' }, { ...context, accessToken: '' }, { ...context, scopes: [] }, { ...context, connectionStatus: 'reconnect_required' as const }]) {
        await expect(f.service.send_draft(bad, target)).rejects.toBeInstanceOf(MailError);
    }
    await expect(f.service.create_draft(context, { ...content, operation_id, accountId } as never)).rejects.toThrow('invalid_input');
    expect(f.calls).toHaveLength(0); expect(f.operations.calls).toHaveLength(0);
});
test('concurrent identical send has one backend dispatch; receipt replay never resolves drafts again', async () => {
    const f = fixture(); const outcomes = await Promise.all([f.service.send_draft(context, target), f.service.send_draft(context, target)]);
    expect(f.calls.filter(call => call.method === 'submit')).toHaveLength(1); expect(outcomes.some(result => result.status === 'queued')).toBe(true);
    const calls = f.calls.length; const replay = await f.service.send_draft(context, target);
    expect(replay).toEqual({ status: 'queued', operation_id, queueId: 'queue-1' }); expect(f.calls).toHaveLength(calls);
    expect(JSON.stringify(replay)).not.toContain(context.accessToken);
});
test('send versus update/delete across clients uses one shared permanent draft fence', async () => {
    const f = fixture(); const other = { ...context, clientId: 'other-client' };
    const results = await Promise.all([f.service.send_draft(context, target), f.service.update_draft(other, { ...content, ...target, operation_id: 'operation_test_002' }), f.service.delete_draft(other, { ...target, operation_id: 'operation_test_003' })]);
    expect(f.calls.filter(call => ['upload', 'delete', 'submit', 'move', 'flags'].includes(call.method))).toHaveLength(1); expect(results.filter(result => result.status === 'conflict')).toHaveLength(2);
});
test('changed payload with same operation ID conflicts before reading drafts', async () => {
    const f = fixture(); await f.service.create_draft(context, { ...content, operation_id }); const before = f.calls.length;
    expect(await f.service.create_draft(context, { ...content, body: { text: 'changed', html: null }, operation_id })).toEqual({ status: 'conflict', operation_id, reason: 'operation_conflict' });
    expect(f.calls).toHaveLength(before); expect(posts(f)).toHaveLength(1);
    const stored = JSON.stringify([...f.operations.records.values()]); expect(stored).not.toContain(content.body.text); expect(stored).not.toContain(content.subject); expect(stored).not.toContain(context.accessToken);
});
test('preflight version, recipient, draft state and target mismatch failures release only before dispatch', async () => {
    for (const [field, value, reason] of [['hasRecipients', false, 'no_recipients'], ['isDraft', false, 'unsupported_draft'], ] as const) {
        const f = fixture(); f.behavior.snapshot[field] = value;
        const result = field === 'hasRecipients' ? await f.service.send_draft(context, target) : await f.service.update_draft(context, { ...content, ...target });
        expect(result).toEqual({ status: 'failed', operation_id, reason }); expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(0);
    }
    const f = fixture();
    expect(await f.service.delete_draft(context, { ...target, expected_version: 'x'.repeat(43) })).toEqual({ status: 'failed', operation_id, reason: 'version_conflict' });
    f.behavior.snapshot.message.uid = 99;
    expect(await f.service.delete_draft(context, { ...target, operation_id: 'operation_test_002' })).toEqual({ status: 'failed', operation_id: 'operation_test_002', reason: 'temporarily_unavailable' });
    expect(posts(f)).toHaveLength(0);
});
test('failure to durably release preflight is temporary and never dispatches', async () => {
    const f = fixture(); f.behavior.snapshot.hasRecipients = false; f.operations.preflightFault = true;
    await expect(f.service.send_draft(context, target)).rejects.toThrow('temporarily_unavailable');
    expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(1);
    expect((await f.service.send_draft(context, target)).status).toBe('in_progress');
});
test('lost submit response is permanently unknown and never resent under old or new operation IDs', async () => {
    const f = fixture(); f.behavior.postError = true;
    const result = await f.service.send_draft(context, target);
    expect(result).toEqual({ status: 'outcome_unknown', operation_id, reason: 'dispatch_uncertain' });
    expect(await f.service.send_draft(context, target)).toEqual(result);
    expect((await f.service.send_draft(context, { ...target, operation_id: 'operation_test_002' })).status).toBe('conflict');
    expect(posts(f)).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('secret');
});
test('completion lost after commit recovers known queue; before commit records unknown without resending', async () => {
    for (const mode of ['after', 'before'] as const) {
        const f = fixture(); f.operations.completeFault = mode;
        const result = await f.service.send_draft(context, target);
        expect(result.status).toBe(mode === 'after' ? 'queued' : 'outcome_unknown');
        expect(await f.service.send_draft(context, target)).toEqual(result); expect(posts(f)).toHaveLength(1);
    }
});
test('unknown receipt persistence failure replays explicit uncertainty and fences every client key', async () => {
    const f = fixture(); f.behavior.postError = true; f.operations.unknownFault = true;
    expect((await f.service.send_draft(context, target)).status).toBe('outcome_unknown');
    expect(await f.service.send_draft(context, target)).toEqual({ status: 'outcome_unknown', operation_id, reason: 'dispatch_uncertain' });
    expect((await f.service.send_draft(context, { ...target, operation_id: 'operation_test_003' })).status).toBe('conflict');
    expect((await f.service.delete_draft({ ...context, clientId: 'another' }, { ...target, operation_id: 'operation_test_002' })).status).toBe('conflict'); expect(posts(f)).toHaveLength(1);
});
test('crashed or uncertain dispatch markers never cause backend calls on replay', async () => {
    for (const mode of ['before', 'after'] as const) {
        const f = fixture(); f.operations.markFault = mode;
        expect((await f.service.send_draft(context, target)).status).toBe('outcome_unknown');
        expect((await f.service.send_draft(context, target)).status).toBe(mode === 'before' ? 'in_progress' : 'outcome_unknown');
        expect(posts(f)).toHaveLength(0);
    }
});
test('replacement verifies candidate before fresh original inspection and deletion', async () => {
    const f = fixture(); const result = await f.service.update_draft(context, { subject: 'changed', ...target });
    expect(result.status).toBe('completed');
    expect(f.calls.map(call => call.method)).toEqual(['resolve', 'inspect', 'prepareUpdate', 'upload', 'verify', 'inspect', 'delete']);
    expect(f.calls.find(call => call.method === 'prepareUpdate')?.args[2]).toEqual({ subject: 'changed' });
    expect(f.operations.guards.size).toBe(1);
    expect((await f.service.delete_draft(context, { ...target, operation_id: 'operation_test_002' })).status).toBe('conflict');
});
test('write preflight uses its write scope without granting public read access', async () => {
    const f = fixture(); const sendOnly = { ...context, scopes: ['mail:send'] };
    await expect(f.service.read_message(sendOnly, { mailboxId, uid: 7 })).rejects.toThrow('forbidden');
    expect((await f.service.send_draft(sendOnly, target)).status).toBe('queued');
});
test('attachment returns validated exact binary separately from metadata', async () => {
    const f = fixture(); const result = await f.service.read_attachment(context, { mailboxId, uid: 7, attachmentId: 'ATT00001' });
    expect(result.bytes).toEqual(new Uint8Array([0, 1, 255])); expect(result.metadata.size).toBe(3);
    expect(Object.keys(result.metadata)).not.toContain('bytes'); expect(f.operations.calls).toHaveLength(0);
    f.reader.readAttachment = async () => ({ ...result, bytes: new Uint8Array([1]) });
    await expect(f.service.read_attachment(context, { mailboxId, uid: 7, attachmentId: 'ATT00001' })).rejects.toThrow('temporarily_unavailable');
});
test('MIME preparation errors settle before dispatch and preserve rich originals', async () => {
    const f = fixture(); f.behavior.preparationError = true;
    const result = await f.service.update_draft(context, { ...target, subject: 'change only subject' });
    expect(result).toEqual({ status: 'failed', operation_id, reason: 'source_integrity_unavailable' });
    expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(0);
});
test('candidate verification failure is explicit partial without invented version or original deletion', async () => {
    const f = fixture(); f.behavior.verificationError = true;
    const result = await f.service.update_draft(context, { ...target, subject: 'change only subject' });
    expect(result).toEqual({ status: 'partial', operation_id, candidate: { mailboxId, uid: 8 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    expect(await f.service.send_draft(context, { ...target, uid: 8, operation_id: 'candidate_send_001' })).toEqual({ status: 'failed', operation_id: 'candidate_send_001', reason: 'verification_failed' });
    expect(f.calls.some(call => call.method === 'submit')).toBe(false);
});
test('stale original after candidate verification leaves explicit nonactivated partial', async () => {
    const f = fixture(); f.behavior.originalChanged = true;
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('partial');
    if (result.status === 'partial') { expect(result.reason).toBe('original_version_changed'); expect(result.originalDeletion).toBe('not_attempted'); }
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    const candidate = { ...target, uid: 8, operation_id: 'candidate_send_001' };
    expect((await f.service.send_draft(context, candidate)).status).toBe('failed');
    const flags = await f.service.update_message_flags(context, { ...candidate, mailboxId, operation_id: 'candidate_flags_01', seen: true });
    expect(flags).toEqual({ status: 'failed', operation_id: 'candidate_flags_01', reason: 'verification_failed' });
});
test('fresh original read outage yields verification partial without falsely claiming version change', async () => {
    const f = fixture(); const verify = f.writer.verifyPreparedDraft;
    f.writer.verifyPreparedDraft = async (...args) => { const result = await verify(...args); f.behavior.originalReadError = true; return result; };
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('partial');
    if (result.status === 'partial') { expect(result.reason).toBe('original_verification_failed'); expect(result.originalDeletion).toBe('not_attempted'); }
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    f.behavior.originalReadError = false;
    expect((await f.service.send_draft(context, { ...target, uid: 8, operation_id: 'candidate_send_001' })).status).toBe('failed');
});
test('verified candidate with failed or uncertain original deletion has explicit partial and activation', async () => {
    for (const error of [new MailError('forbidden'), new Error('backend timeout with secret')]) {
        const f = fixture(); f.behavior.deletionError = error;
        const result = await f.service.update_draft(context, { ...target, subject: 'change' });
        expect(result.status).toBe('partial');
        if (result.status === 'partial') { expect(result.reason).toBe(error instanceof MailError ? 'original_deletion_failed' : 'original_deletion_unconfirmed'); }
        f.behavior.deletionError = undefined;
        expect((await f.service.send_draft(context, { ...target, uid: 8, operation_id: 'candidate_send_001' })).status).toBe('queued');
        expect((await f.service.delete_draft(context, { ...target, operation_id: 'old_delete_op_001' })).status).toBe('conflict');
    }
});
test('historical activation proof survives later version changes but fresh expected version alone cannot activate', async () => {
    const f = fixture(); const created = await f.service.create_draft(context, { ...content, operation_id });
    expect(created.status).toBe('completed');
    const candidateKey = { mailboxId, uid: 8 }; const stored = f.messages.get(JSON.stringify(candidateKey));
    if (!stored) { throw new Error('Missing test candidate'); }
    f.messages.set(JSON.stringify(candidateKey), { ...stored, message: { ...stored.message, version: 'h'.repeat(43) } });
    expect((await f.service.send_draft(context, { ...target, uid: 8, expected_version: 'h'.repeat(43), operation_id: 'candidate_send_001' })).status).toBe('queued');
    const g = fixture(); g.behavior.verificationError = true;
    await g.service.create_draft(context, { ...content, operation_id });
    expect(await g.service.send_draft(context, { ...target, uid: 8, operation_id: 'candidate_send_001' })).toEqual({ status: 'failed', operation_id: 'candidate_send_001', reason: 'verification_failed' });
});
test('read marker checks one operation, never leaks private marker or performs list N+1', async () => {
    const f = fixture(); await f.service.create_draft(context, { ...content, operation_id });
    const before = f.operations.calls.length;
    const result = await f.service.read_message(context, { mailboxId, uid: 8 });
    expect(result.managedOperation).toEqual({ operationId: operation_id, verification: 'verified' });
    expect(f.operations.calls.length - before).toBe(1); expect(JSON.stringify(result)).not.toContain('payloadDigest'); expect(JSON.stringify(result)).not.toContain('clientIdHash');
    const start = f.operations.calls.length;
    await f.service.list_messages(context, { mailboxId, limit: 20 }); await f.service.search_messages(context, { text: 'x', limit: 20 });
    expect(f.operations.calls.length).toBe(start);
});
test('send stamps after durable dispatch before queue submission and returns actual Sent identity only', async () => {
    const f = fixture(); const stamp = f.writer.stampSendMarker;
    f.writer.stampSendMarker = async (...args) => { expect(f.operations.calls).toContain('dispatch'); return stamp(...args); };
    f.writer.submitDraft = async () => ({ queueId: 'queue-actual', sent: { mailboxId: 'e'.repeat(24), uid: 90 } });
    expect(await f.service.send_draft(context, target)).toEqual({ status: 'queued', operation_id, queueId: 'queue-actual', sent: { mailboxId: 'e'.repeat(24), uid: 90 } });
    expect(f.calls.find(call => call.method === 'stamp')).toBeDefined();
    const g = fixture(); g.behavior.queueId = '';
    expect((await g.service.send_draft(context, target)).status).toBe('outcome_unknown');
});
test('move retires source, flags release same UID and both require modify scope', async () => {
    const f = fixture(); const flags = { ...target, mailboxId, seen: true };
    expect((await f.service.update_message_flags(context, flags)).status).toBe('completed'); expect(f.operations.guards.size).toBe(0);
    expect((await f.service.update_message_flags(context, { ...flags, operation_id: 'flags_operation_02', expected_version: 'f'.repeat(43), flagged: true })).status).toBe('completed');
    const next = { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24), expected_version: 'f'.repeat(43), operation_id: 'move_operation_01' };
    expect((await f.service.move_message(context, next)).status).toBe('completed'); expect(f.operations.guards.size).toBe(1);
    expect((await f.service.update_message_flags(context, { ...flags, operation_id: 'flags_operation_03', expected_version: 'f'.repeat(43) })).status).toBe('conflict');
    const g = fixture(); await expect(g.service.move_message({ ...context, scopes: ['mail:draft'] }, next)).rejects.toThrow('forbidden'); expect(g.calls).toHaveLength(0); expect(g.operations.calls).toHaveLength(0);
});
test('verified partial replay is durable and performs no upload, verification or deletion again', async () => {
    const f = fixture(); f.behavior.deletionError = new Error('uncertain original deletion');
    const request = { ...target, subject: 'patch only' }; const first = await f.service.update_draft(context, request); const count = f.calls.length;
    expect(first.status).toBe('partial'); expect(await f.service.update_draft(context, request)).toEqual(first); expect(f.calls.length).toBe(count);
});
test('lost flag completion atomically preserves either confirmed release or an uncertainty fence', async () => {
    for (const mode of ['after', 'before'] as const) {
        const f = fixture(); f.operations.completeFault = mode;
        const request = { ...target, mailboxId, seen: true };
        expect((await f.service.update_message_flags(context, request)).status).toBe(mode === 'after' ? 'completed' : 'outcome_unknown');
        expect(f.operations.guards.size).toBe(mode === 'after' ? 0 : 1);
        f.operations.completeFault = 'none';
        const next = await f.service.update_message_flags(context, { ...request, expected_version: 'f'.repeat(43), operation_id: 'flag_followup_001', flagged: true });
        expect(next.status).toBe(mode === 'after' ? 'completed' : 'conflict');
    }
});
test('candidate with verified MIME but lost durable completion remains unactivated', async () => {
    const f = fixture(); f.operations.completeFault = 'before';
    expect((await f.service.create_draft(context, { ...content, operation_id })).status).toBe('outcome_unknown');
    const read = await f.service.read_message(context, { mailboxId, uid: 8 });
    expect(read.managedOperation?.verification).toBe('outcome_unknown');
    expect(await f.service.send_draft(context, { ...target, uid: 8, operation_id: 'candidate_send_001' })).toEqual({ status: 'failed', operation_id: 'candidate_send_001', reason: 'verification_failed' });
    expect(f.calls.some(call => call.method === 'submit')).toBe(false);
});
test('invalid backend error codes and extra output fields never expose secrets', async () => {
    const f = fixture(); f.reader.listMailboxes = async () => { throw new MailError('backend-secret-token' as never); };
    await expect(f.service.list_mailboxes(context, {})).rejects.toThrow('temporarily_unavailable');
    const g = fixture(); g.reader.listMailboxes = async () => ({ mailboxes: [], rawToken: context.accessToken } as never);
    await expect(g.service.list_mailboxes(context, {})).rejects.toThrow('temporarily_unavailable');
});
test('unmanaged drafts cannot update or send and fail before every irreversible effect', async () => {
    for (const tool of ['update_draft', 'send_draft'] as const) {
        const f = fixture(false);
        const result = tool === 'update_draft' ? await f.service.update_draft(context, { ...target, subject: 'change' }) : await f.service.send_draft(context, target);
        expect(result).toEqual({ status: 'failed', operation_id, reason: 'unsupported_content' });
        expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0);
        expect(f.calls.some(call => ['stamp', 'prepareUpdate', 'sourcecheck'].includes(call.method))).toBe(false); expect(f.operations.guards.size).toBe(0);
    }
});
test('legacy read and deletion remain available without authored provenance', async () => {
    const f = fixture(false); expect((await f.service.read_message(context, { mailboxId, uid: 7 })).text).toBe('text');
    expect((await f.service.delete_draft(context, target)).status).toBe('completed');
    expect(f.calls.some(call => call.method === 'sourcecheck')).toBe(false);
});
test('legacy flag and move receipts stay observed and cannot promote later edit or send', async () => {
    const f = fixture(false);
    const flagged = await f.service.update_message_flags(context, { ...target, mailboxId, seen: true });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('observed'); }
    const changed = { ...target, expected_version: 'f'.repeat(43), operation_id: 'legacy_send_operation_01' };
    expect((await f.service.send_draft(context, changed)).status).toBe('failed');
    expect(await f.service.update_draft(context, { ...changed, operation_id: 'legacy_edit_operation_01', subject: 'change' })).toEqual({ status: 'failed', operation_id: 'legacy_edit_operation_01', reason: 'unsupported_content' });
    const moved = await f.service.move_message(context, { ...changed, operation_id: 'legacy_move_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) });
    expect(moved.status).toBe('completed'); if (moved.status === 'completed') { expect(moved.proof.sourceGrade).toBe('observed'); }
    const back = await f.service.move_message(context, { uid: 9, expected_version: version, operation_id: 'legacy_move_operation_02', mailboxId: 'e'.repeat(24), destinationMailboxId: mailboxId });
    expect(back.status).toBe('completed'); if (back.status === 'completed') { expect(back.proof.sourceGrade).toBe('observed'); }
    expect(await f.service.send_draft(context, { ...target, uid: 9, operation_id: 'legacy_send_operation_02' })).toEqual({ status: 'failed', operation_id: 'legacy_send_operation_02', reason: 'unsupported_content' });
    expect(f.calls.some(call => call.method === 'sourcecheck')).toBe(false);
});
test('MCP create through flags and moves preserves trusted grade for later edit and send', async () => {
    const f = fixture(false);
    const created = await f.service.create_draft(context, { ...content, operation_id });
    expect(created.status).toBe('completed'); if (created.status === 'completed') { expect(created.proof.sourceGrade).toBe('mcp_authored'); }
    const flagged = await f.service.update_message_flags(context, { ...target, uid: 8, mailboxId, seen: true, operation_id: 'authored_flags_operation_01' });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('mcp_authored'); }
    const moved = await f.service.move_message(context, { uid: 8, expected_version: 'f'.repeat(43), operation_id: 'authored_move_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) });
    expect(moved.status).toBe('completed'); if (moved.status === 'completed') { expect(moved.proof.sourceGrade).toBe('mcp_authored'); }
    await f.service.move_message(context, { uid: 9, expected_version: version, operation_id: 'authored_move_operation_02', mailboxId: 'e'.repeat(24), destinationMailboxId: mailboxId });
    f.behavior.nextUid = 10;
    const edited = await f.service.update_draft(context, { ...target, uid: 9, subject: 'change', operation_id: 'authored_edit_operation_01' });
    expect(edited.status).toBe('completed'); if (edited.status === 'completed') { expect(edited.proof.sourceGrade).toBe('mcp_authored'); }
    expect((await f.service.send_draft(context, { ...target, uid: 10, operation_id: 'authored_send_operation_01' })).status).toBe('queued');
    const checked = f.calls.filter(call => call.method === 'sourcecheck'); expect(checked).toHaveLength(4);
    for (const call of checked) { expect(call.args[2]).toMatchObject({ grade: 'mcp_authored', accountId, contentDigest: 'd'.repeat(64) }); }
});
test('authored hash mismatch rejects update, send, move and flags before dispatch without demotion', async () => {
    for (const tool of ['update_draft', 'send_draft', 'move_message', 'update_message_flags'] as const) {
        const f = fixture(); f.behavior.sourceMismatch = true;
        const args = tool === 'move_message' ? { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24) } : tool === 'update_message_flags' ? { ...target, mailboxId, seen: true } : tool === 'update_draft' ? { ...target, subject: 'change' } : target;
        expect(await f.service[tool](context, args as never)).toEqual({ status: 'failed', operation_id, reason: 'verification_failed' });
        expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0); expect(f.calls.some(call => call.method === 'stamp')).toBe(false); expect(f.operations.guards.size).toBe(0);
    }
});
test('writer cannot unexpectedly promote legacy observations or change an authored digest', async () => {
    const f = fixture(false); f.behavior.unexpectedGrade = true;
    expect((await f.service.update_message_flags(context, { ...target, mailboxId, seen: true })).status).toBe('outcome_unknown');
    expect(f.operations.guards.size).toBe(1);
    const g = fixture(); g.behavior.mutationDigestMismatch = true;
    expect((await g.service.move_message(context, { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24) })).status).toBe('outcome_unknown'); expect(g.operations.guards.size).toBe(1);
});
test('raw markers, matching client IDs, foreign accounts and wrong UID receipts cannot author mail', async () => {
    for (const variant of ['no-record', 'foreign-account', 'wrong-uid', 'observed'] as const) {
        const f = fixture(false);
        const key = { accountId, clientIdHash: digest(context.clientId), operationId: 'spoofed_operation_001' };
        const marker: MailOperationMarker = { ...key, tool: 'update_message_flags', payloadDigest: digest('spoof') };
        f.behavior.marker = variant === 'foreign-account' ? { ...marker, accountId: 'e'.repeat(24) } : marker;
        if (variant !== 'no-record') {
            const reference = { mailboxId, uid: variant === 'wrong-uid' ? 99 : 7, version };
            f.operations.records.set(keyOf(key), { key, intent: { ...marker, tool: 'update_message_flags', target: { mailboxId, uid: 7 }, expectedVersion: version }, ownerToken: 'spoof-owner', revision: 2, state: 'settled', receipt: { status: 'completed', operation_id: key.operationId, message: reference, verified: true, proof: { ...reference, accountId, contentDigest: 'd'.repeat(64), sourceGrade: variant === 'observed' ? 'observed' : 'mcp_authored' } } });
        }
        const result = await f.service.send_draft(context, target); expect(result.status).toBe('failed');
        expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0);
    }
});
test('queued Sent activation never carries authored bytes into later flags or preserving edits', async () => {
    const f = fixture(); const sent = { mailboxId: 'e'.repeat(24), uid: 91 };
    f.writer.submitDraft = async () => {
        if (!f.behavior.marker) { throw new Error('Missing test send marker'); }
        f.messages.set(JSON.stringify(sent), { ...f.behavior.snapshot, message: { ...sent, version }, isDraft: false, marker: f.behavior.marker });
        return { queueId: 'sent-queue', sent };
    };
    expect((await f.service.send_draft(context, target)).status).toBe('queued');
    expect((await f.service.read_message(context, sent)).managedOperation?.verification).toBe('verified');
    const flagged = await f.service.update_message_flags(context, { ...sent, expected_version: version, operation_id: 'sent_flags_operation_01', seen: true });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('observed'); }
    expect(f.calls.filter(call => call.method === 'sourcecheck')).toHaveLength(1);
});

test('upstream_timeout after dispatched upload, submit or flags preserves uncertainty and every client fence', async () => {
    for (const tool of ['update_draft', 'send_draft', 'update_message_flags'] as const) {
        const f = fixture(); let effects = 0;
        const observedEffect = () => {
            const record = f.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId: operation_id }));
            expect(record?.state).toBe('dispatched'); effects++;
        };
        if (tool === 'update_draft') {
            const upload = f.writer.uploadPreparedDraft;
            f.writer.uploadPreparedDraft = async (...args) => { await upload(...args); observedEffect(); throw new MailError('upstream_timeout'); };
        } else if (tool === 'send_draft') {
            const submit = f.writer.submitDraft;
            f.writer.submitDraft = async (...args) => { await submit(...args); observedEffect(); throw new MailError('upstream_timeout'); };
        } else {
            const flags = f.writer.updateMessageFlags;
            f.writer.updateMessageFlags = async (...args) => { await flags(...args); observedEffect(); throw new MailError('upstream_timeout'); };
        }
        const request = tool === 'update_draft' ? { ...target, subject: 'change' } : tool === 'update_message_flags' ? { ...target, mailboxId, seen: true } : target;
        const unknown = { status: 'outcome_unknown', operation_id, reason: 'dispatch_uncertain' } as const;
        expect(await f.service[tool](context, request as never)).toEqual(unknown);
        const calls = f.calls.length;
        expect(await f.service[tool](context, request as never)).toEqual(unknown);
        expect(f.calls.length).toBe(calls); expect(effects).toBe(1); expect(f.operations.guards.size).toBe(1);
        for (const client of [context, { ...context, clientId: 'another-client' }]) {
            expect(await f.service[tool](client, { ...request, operation_id: 'deadline_followup_001' } as never)).toEqual({ status: 'conflict', operation_id: 'deadline_followup_001', reason: 'draft_fenced' });
        }
        expect(effects).toBe(1); expect(f.operations.guards.size).toBe(1);
        expect(f.calls.filter(call => ['upload', 'submit', 'flags'].includes(call.method))).toHaveLength(1);
    }
});
test('upstream_timeout during source verification settles failure and releases the guard before dispatch', async () => {
    const f = fixture(); let checks = 0;
    const verify = f.writer.verifyAuthoredSource;
    f.writer.verifyAuthoredSource = async () => { checks++; throw new MailError('upstream_timeout'); };
    const failed = { status: 'failed', operation_id, reason: 'upstream_timeout' } as const;
    expect(await f.service.send_draft(context, target)).toEqual(failed);
    expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0);
    expect(f.calls.some(call => call.method === 'stamp')).toBe(false); expect(f.operations.guards.size).toBe(0);
    expect(await f.service.send_draft(context, target)).toEqual(failed); expect(checks).toBe(1);
    f.writer.verifyAuthoredSource = verify;
    expect((await f.service.send_draft(context, { ...target, operation_id: 'deadline_retry_new_001' })).status).toBe('queued');
    expect(f.calls.filter(call => call.method === 'submit')).toHaveLength(1);
});
test('read and search upstream_timeout stay read errors without operation records or guards', async () => {
    const f = fixture(false);
    f.reader.readMessage = async () => { throw new MailError('upstream_timeout'); };
    f.reader.searchMessages = async () => { throw new MailError('upstream_timeout'); };
    await expect(f.service.read_message(context, { mailboxId, uid: 7 })).rejects.toMatchObject({ code: 'upstream_timeout', message: 'upstream_timeout' });
    await expect(f.service.search_messages(context, { text: 'needle', limit: 20 })).rejects.toMatchObject({ code: 'upstream_timeout', message: 'upstream_timeout' });
    expect(f.operations.calls).toHaveLength(0); expect(f.operations.records.size).toBe(0); expect(f.operations.guards.size).toBe(0); expect(posts(f)).toHaveLength(0);
});

test('batch reads preserve order, cap concurrency and return isolated sanitized failures', async () => {
    const f = fixture(false); const original = f.reader.readMessage; let active = 0; let high = 0;
    f.reader.readMessage = async (bound, key) => { active++; high = Math.max(high, active); try { await Bun.sleep(2); if (key.uid === 3) { throw new MailError('not_found'); } const result = await original(bound, key); return { message: { ...result.message, ...key } }; } finally { active--; } };
    const result = await f.service.read_messages(context, { messages: Array.from({ length: 8 }, (_, index) => ({ mailboxId, uid: index + 1 })) });
    expect(high).toBe(3); expect(result.results.map(item => item.status === 'ok' ? item.message.uid : item.uid)).toEqual([1,2,3,4,5,6,7,8]);
    expect(result.results[2]).toEqual({ status: 'failed', mailboxId, uid: 3, error: { code: 'not_found', message: 'not_found' } }); expect(result.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(result))); expect(f.operations.calls).toHaveLength(0);
});
test('batch serialized budget includes metadata, envelope and reserved failure slots', async () => {
    const f = fixture(false); const original = f.reader.readMessage;
    f.reader.readMessage = async (bound, key) => ({ message: { ...(await original(bound, key)).message, ...key, text: 'x'.repeat(128 * 1024), html: ['x'.repeat(256 * 1024)] } });
    const result = await f.service.read_messages(context, { messages: Array.from({ length: 10 }, (_, index) => ({ mailboxId, uid: index + 1 })) });
    expect(result.results.filter(item => item.status === 'ok')).toHaveLength(2); expect(result.results.filter(item => item.status === 'failed').every(item => item.status === 'failed' && item.error.code === 'too_large')).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576); expect(result.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(result)));
});

test('reply draft uses distinct durable create intent, skips preparation on replay, and requires both read and draft', async () => {
    const f = fixture(false); const reply = { original: { mailboxId, uid: 7 }, mode: 'reply_all' as const, body: { text: 'Reply', html: null }, quoteOriginal: false, attachments: [], operation_id };
    const created = await f.service.create_reply_draft(context, reply); expect(created.status).toBe('completed'); expect(f.calls.filter(call => call.method === 'prepareReply')).toHaveLength(1); expect(f.calls.some(call => call.method === 'inspect')).toBe(false);
    const calls = f.calls.length; expect(await f.service.create_reply_draft(context, reply)).toEqual(created); expect(f.calls).toHaveLength(calls); expect(await f.service.create_reply_draft(context, { ...reply, body: { text: 'Changed', html: null } })).toMatchObject({ status: 'conflict', reason: 'operation_conflict' });
    expect([...f.operations.records.values()][0]?.intent.tool).toBe('create_reply_draft');
    const denied = fixture(false); await expect(denied.service.create_reply_draft({ ...context, scopes: ['mail:draft'] }, reply)).rejects.toMatchObject({ code: 'forbidden' }); expect(denied.calls).toHaveLength(0); expect(denied.operations.calls).toHaveLength(0);
});
test('reply preparation failure settles preflight without upload and authored reply can later send', async () => {
    const f = fixture(false); const reply = { original: { mailboxId, uid: 7 }, mode: 'reply' as const, body: { text: 'Reply', html: null }, quoteOriginal: false, attachments: [], operation_id };
    f.behavior.preparationError = true; expect(await f.service.create_reply_draft(context, reply)).toMatchObject({ status: 'failed', reason: 'unsupported_content' }); expect(f.calls.some(call => call.method === 'upload')).toBe(false); expect(f.operations.calls).not.toContain('dispatch');
    const good = fixture(false); const created = await good.service.create_reply_draft(context, reply); if (created.status !== 'completed') { throw new Error('expected created draft'); }
    const sent = await good.service.send_draft(context, { uid: created.draft.uid, expected_version: created.draft.version, operation_id: 'reply-send-operation' }); expect(sent.status).toBe('queued');
});
test('thread body pages reuse bounded batch reader, retaining per-item failures and limiting body page size', async () => {
    const f = fixture(false); const original = f.reader.readMessage;
    f.reader.getThread = async () => { const summary = (await f.reader.listMessages(context, { mailboxId, limit: 20 })).messages[0]; if (!summary) { throw new Error('missing summary'); } return { threadId: mailboxId, messages: [summary, { ...summary, uid: 8 }], next: 'thread-next' }; };
    f.reader.readMessage = async (bound, key) => { if (key.uid === 8) { throw new MailError('not_found'); } return original(bound, key); };
    const page = await f.service.get_thread(context, { threadId: mailboxId, limit: 2, includeBodies: true }); expect(page.next).toBe('thread-next'); expect(page.bodies?.results.map(item => item.status)).toEqual(['ok', 'failed']);
    await expect(f.service.get_thread(context, { threadId: mailboxId, limit: 11, includeBodies: true })).rejects.toMatchObject({ code: 'invalid_input' });
});
test('batch deadline includes a stalled provenance lookup and returns item timeout', async () => {
    const f = fixture(); f.operations.getOperation = async () => new Promise(() => {}); const deadline = performance.now() + 2020;
    const started = performance.now(); const result = await withRequestBudget(() => Math.max(0, deadline - performance.now()), () => f.service.read_messages(context, { messages: [{ mailboxId, uid: 7 }] }));
    expect(performance.now() - started).toBeLessThan(500); expect(result.results[0]).toMatchObject({ status: 'failed', error: { code: 'upstream_timeout' } });
});
