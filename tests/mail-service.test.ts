import { readFileSync } from 'node:fs';
import { withRequestBudget } from '../src/request-budget';
import { withRequestId } from '../src/request-id';
import { captureWarnings, steppedClock, virtualRetry } from './dynamo-virtual';
import { ModelSender } from './dynamo-model';
import { describe, expect, test } from 'bun:test';
import { digest } from '../src/auth/crypto';
import { DynamoMailOperationStore, guardKey, opKey } from '../src/mail/dynamo-store';
import { createMailService, holdAction, HOLD_AGED_MS, SEND_CHECK_AGED_MS } from '../src/mail/service';
import { errorText } from '../src/mail/summary';
import { MailError, type ConfirmedReceipt, type DraftGuardKey, type MailFailureCode, type MailOutput, type MailOperationMarker, type FailedReceipt, type MailBackendReader, type MailBackendWriter, type MailContext, type DraftGuardRecord, type MailOperationRecord, type MailOperationStore, type OperationClaim, type OperationKey, type ReservationResult, type ResolvedReceipt, type UnknownReceipt, type WriteIntent, type MessageSnapshot, type PreparedDraft } from '../src/mail/contracts';

const accountId = 'a'.repeat(24); const mailboxId = 'b'.repeat(24); const version = 'v'.repeat(43);
const context: MailContext = { accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:read', 'mail:draft', 'mail:send', 'mail:modify'], connectionStatus: 'active' };
const operationId = 'operation_test_001';
const target = { uid: 7, expectedVersion: version, operationId };
const content = { to: [{ address: 'to@example.com' }], cc: [], bcc: [], subject: 'private subject', body: { markdown: 'private **body**' }, attachments: [] };
const keyOf = (key: OperationKey) => JSON.stringify([key.accountId, key.clientIdHash, key.operationId]);
const guardOf = (intent: WriteIntent) => intent.tool === 'create_draft' || intent.tool === 'create_reply_draft' ? undefined : JSON.stringify([intent.accountId, intent.target.mailboxId, intent.target.uid]);
/** What the real store keeps: a summary is never stored. The fixture notes any that reaches it, so a service that passes one on is caught. */
const stored = <Receipt extends object>(receipt: Receipt, offered: string[]): Receipt => {
    if ('summary' in receipt) { offered.push(JSON.stringify((receipt as { summary: unknown }).summary)); }
    const { summary: _summary, ...rest } = receipt as Receipt & { summary?: unknown };
    return rest as Receipt;
};
class Store implements MailOperationStore {
    records = new Map<string, MailOperationRecord>(); guards = new Map<string, string>(); calls: string[] = []; summariesOffered: string[] = [];
    completeFault: 'none' | 'before' | 'after' = 'none'; completeFailures = 0; markFault: 'none' | 'before' | 'after' | 'shape' = 'none'; unknownFault = false; preflightFault = false;
    /** failDispatched fails before it commits, or commits and then fails; readsFailAfterMark makes every read fail once markDispatched has faulted. */
    failDispatchedFault: 'none' | 'before' | 'after' = 'none'; readsFailAfterMark = false; private readsFail = false;
    async getOperation(key: OperationKey): Promise<MailOperationRecord | undefined> { this.calls.push('get'); if (this.readsFail) { throw new Error('secret read failure'); } const record = this.records.get(keyOf(key)); return record && structuredClone(record); }
    async reserve(intent: WriteIntent, ownerToken: string): Promise<ReservationResult> {
        this.calls.push('reserve'); const key = keyOf(intent); const existing = this.records.get(key);
        if (existing) { return JSON.stringify(existing.intent) === JSON.stringify(intent) ? { kind: 'replay', record: structuredClone(existing) } : { kind: 'conflict', reason: 'operation_conflict' }; }
        const guard = guardOf(intent);
        if (guard && this.guards.has(guard) && 'target' in intent) {
            const blocker = await this.getGuard({ accountId: intent.accountId, ...intent.target });
            if (blocker) { return { kind: 'conflict', reason: 'draft_fenced', blocker }; }
        }
        const operation: MailOperationRecord = { key: { accountId: intent.accountId, clientIdHash: intent.clientIdHash, operationId: intent.operationId }, intent, ownerToken, revision: 0, state: 'reserved', reservedAt: Math.ceil(Date.now() / 1000) };
        this.records.set(key, structuredClone(operation)); if (guard) { this.guards.set(guard, key); }
        return { kind: 'acquired', claim: { key: operation.key, ownerToken, revision: 0, state: 'reserved' } };
    }
    /** The guard row as the real store keeps it: the holder's owner and revision, and its state. */
    async getGuard(key: DraftGuardKey): Promise<DraftGuardRecord | undefined> {
        const holder = this.records.get(String(this.guards.get(JSON.stringify([key.accountId, key.mailboxId, key.uid]))));
        if (!holder) { return undefined; }
        return { key, operation: holder.key, ownerToken: holder.ownerToken, revision: holder.revision, state: holder.state === 'settled' ? holder.receipt.status === 'outcome_unknown' ? 'outcome_unknown' : 'retired' : holder.state };
    }
    checked(claim: OperationClaim): MailOperationRecord {
        const record = this.records.get(keyOf(claim.key));
        if (!record || record.state !== claim.state || record.revision !== claim.revision || record.ownerToken !== claim.ownerToken) { throw new MailError('temporarily_unavailable'); }
        const guard = guardOf(record.intent); if (guard && this.guards.get(guard) !== keyOf(claim.key)) { throw new MailError('temporarily_unavailable'); }
        return record;
    }
    async markDispatched(claim: OperationClaim<'reserved'>): Promise<OperationClaim<'dispatched'>> {
        this.calls.push('dispatch'); if (this.markFault === 'before') { this.readsFail = this.readsFailAfterMark; throw new Error('secret dispatch failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, state: 'dispatched', revision: record.revision + 1 });
        if (this.markFault === 'after') { this.readsFail = this.readsFailAfterMark; throw new Error('secret committed dispatch failure'); }
        if (this.markFault === 'shape') { return { ...claim, state: 'dispatched', revision: claim.revision }; }
        return { ...claim, state: 'dispatched', revision: record.revision + 1 };
    }
    async failPreflight(claim: OperationClaim<'reserved'>, receipt: FailedReceipt): Promise<void> {
        this.calls.push('fail'); if (this.preflightFault) { throw new Error('secret failed release'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt: stored(receipt, this.summariesOffered) });
        const guard = guardOf(record.intent); if (guard) { this.guards.delete(guard); }
    }
    async complete(claim: OperationClaim<'dispatched'>, receipt: ConfirmedReceipt): Promise<void> {
        this.calls.push('complete'); if (this.completeFault === 'before' || this.completeFailures > 0) { this.completeFailures = Math.max(0, this.completeFailures - 1); throw new Error('secret completion failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt: stored(receipt, this.summariesOffered) });
        // As the real store: the guard ends with the receipt, except on an update's original while both copies are alive.
        const bothAlive = receipt.status === 'partial' && (receipt.reason === 'original_deletion_failed' || receipt.reason === 'original_deletion_unconfirmed');
        const guard = guardOf(record.intent); if (guard && !bothAlive) { this.guards.delete(guard); }
        if (this.completeFault === 'after') { throw new Error('secret committed completion failure'); }
    }
    async markOutcomeUnknown(claim: OperationClaim<'dispatched'>, receipt: UnknownReceipt): Promise<void> {
        this.calls.push('unknown'); if (this.unknownFault) { throw new Error('secret unknown failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt: stored(receipt, this.summariesOffered) });
    }
    async failDispatched(claim: OperationClaim<'dispatched'>, receipt: FailedReceipt): Promise<void> {
        this.calls.push('fail_dispatched'); if (this.failDispatchedFault === 'before') { throw new Error('secret settlement failure'); }
        const record = this.checked(claim); this.records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, state: 'settled', receipt: stored(receipt, this.summariesOffered) });
        const guard = guardOf(record.intent); if (guard) { this.guards.delete(guard); }
        if (this.failDispatchedFault === 'after') { throw new Error('secret committed settlement failure'); }
    }
    async releaseGuard(guard: DraftGuardRecord): Promise<boolean> {
        this.calls.push('release'); const id = JSON.stringify([guard.key.accountId, guard.key.mailboxId, guard.key.uid]);
        if (this.guards.get(id) !== keyOf(guard.operation)) { return false; }
        this.guards.delete(id); return true;
    }
    async resolveUnknown(record: MailOperationRecord, receipt: ResolvedReceipt, guard?: DraftGuardRecord): Promise<void> {
        this.calls.push('resolve'); const current = this.records.get(keyOf(record.key));
        if (!current || current.revision !== record.revision || (current.state !== 'dispatched' && !(current.state === 'settled' && current.receipt.status === 'outcome_unknown'))) { throw new MailError('temporarily_unavailable'); }
        this.records.set(keyOf(record.key), { ...current, revision: current.revision + 1, state: 'settled', receipt: stored(receipt, this.summariesOffered) });
        if (guard) { await this.releaseGuard(guard); }
    }
}
/** The fake WildDuck and, unless `real` gives the store and clock to use instead, the in-memory ledger above. */
function fixture(authored = true, real?: { store: MailOperationStore; now: () => number }) {
    const operations = new Store(); const calls: { method: string; args: unknown[] }[] = [];
    const mailbox = { mailboxId, path: 'Drafts', specialUse: '\\Drafts' };
    const message = { mailboxId, uid: 7, subject: 'subject', snippet: null, threadId: null, from: [], to: [], date: null, receivedAt: null, flags: { seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false }, imapFlags: [], labels: [], hasAttachments: false };
    const snapshot = { message: { mailboxId, uid: 7, version }, isDraft: true, hasHtml: true, hasAttachments: true, hasRecipients: true };
    const messages = new Map<string, MessageSnapshot>();
    const seedKey = { accountId, clientIdHash: digest('seed-client'), operationId: 'seed_authored_001' };
    const seedMarker: MailOperationMarker & { tool: 'create_draft' } = { ...seedKey, tool: 'create_draft', payloadDigest: digest('seed-input') };
    if (authored) {
        operations.records.set(keyOf(seedKey), structuredClone({ key: seedKey, intent: seedMarker, ownerToken: 'seed-owner', revision: 1, state: 'settled', receipt: { status: 'completed', operationId: seedKey.operationId, draft: snapshot.message, verified: true, proof: { accountId, ...snapshot.message, contentDigest: 'd'.repeat(64), sourceGrade: 'mcp_authored' } } }));
    }
    const behavior = { snapshot, sourceMismatch: false, unexpectedGrade: false, mutationDigestMismatch: false, nextUid: 8, queueId: 'queue-1', postError: false, wrongMailbox: false, verificationError: false, preparationError: false, originalChanged: false, originalReadError: false, deletionError: undefined as Error | undefined, marker: (authored ? seedMarker : undefined) as MailOperationMarker | undefined, beforeInspect: async () => {},
        /** What the send check sees: the draft still in Drafts, and the copy in Sent; an Error is thrown instead. */
        present: true as boolean | Error, sentCopy: undefined as { message: { mailboxId: string; uid: number }; queueId?: string } | undefined | Error };
    /** Messages deleted or moved away: inspecting them is not_found, as WildDuck answers. */
    const gone = new Set<string>();
    const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
    const find = (key: { mailboxId: string; uid: number }): MessageSnapshot => { if (gone.has(JSON.stringify(key))) { throw new MailError('not_found'); } return messages.get(JSON.stringify(key)) ?? { ...behavior.snapshot, ...(behavior.marker ? { marker: behavior.marker } : {}) }; };
    const reader: MailBackendReader = {
        getAttachmentDownload: async (_bound, input) => ({ metadata: { ...input, filename: null, contentType: 'text/plain', size: 5, expiresAt: '2026-10-26T10:00:00.000Z' }, url: 'https://example.s3.amazonaws.com/file' }),
        getMessageSourceDownload: async (...args) => { record('getMessageSourceDownload', ...args); const [, input] = args; return { metadata: { ...input, size: 9, sha256: 'd'.repeat(64), expiresAt: '2026-10-26T10:05:00.000Z' }, url: 'https://example.s3.amazonaws.com/source' }; },
        getThread: async (_bound, input) => ({ threadId: input.threadId ?? mailboxId, messages: [message] }),
        listMailboxes: async (...args) => { record('listMailboxes', ...args); return { mailboxes: [mailbox] }; },
        listMessages: async (...args) => { record('listMessages', ...args); return { messages: [message] }; },
        searchMessages: async (...args) => { record('searchMessages', ...args); return { messages: [message], search: { mode: 'fast', strategy: 'fulltext', complete: true, verified: false } }; },
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
        deleteDraft: async (...args) => { record('delete', ...args); if (behavior.deletionError) { throw behavior.deletionError; } if (behavior.postError) { throw new Error('secret token or backend body'); } gone.add(JSON.stringify({ mailboxId: args[1].mailboxId, uid: args[1].uid })); },
        stampSendMarker: async (...args) => { record('stamp', ...args); behavior.marker = args[2]; return args[1].message; },
        submitDraft: async (...args) => { record('submit', ...args); if (behavior.postError) { throw new Error('secret token or backend body'); } return { queueId: behavior.queueId }; },
        draftPresent: async (...args) => { record('draftPresent', ...args); if (behavior.present instanceof Error) { throw behavior.present; } return behavior.present; },
        findSentCopy: async (...args) => { record('findSentCopy', ...args); if (behavior.sentCopy instanceof Error) { throw behavior.sentCopy; } return behavior.sentCopy; },
        moveMessage: async (...args) => { record('move', ...args); gone.add(JSON.stringify({ mailboxId: args[1].message.mailboxId, uid: args[1].message.uid })); const moved = { mailboxId: args[2], uid: 9, version }; messages.set(JSON.stringify({ mailboxId: moved.mailboxId, uid: moved.uid }), { ...snapshot, message: moved, marker: args[3] }); return { message: moved, contentDigest: (behavior.mutationDigestMismatch ? 'e' : 'd').repeat(64), sourceGrade: args[4] || behavior.unexpectedGrade ? 'mcp_authored' : 'observed' }; },
        updateMessageFlags: async (...args) => { record('flags', ...args); const changed = { ...args[1].message, version: 'f'.repeat(43) }; messages.set(JSON.stringify({ mailboxId: changed.mailboxId, uid: changed.uid }), { ...snapshot, message: changed, marker: args[3] }); return { message: changed, contentDigest: (behavior.mutationDigestMismatch ? 'e' : 'd').repeat(64), sourceGrade: args[4] || behavior.unexpectedGrade ? 'mcp_authored' : 'observed' }; },
    };
    const service = createMailService({ reader, writer, operations: real?.store ?? operations, ...(real ? { now: real.now } : {}) });
    return { service, operations, calls, behavior, reader, writer, mailbox, messages, gone, seedKey, seedMarker };
}
const posts = (f: ReturnType<typeof fixture>) => f.calls.filter(call => ['upload', 'delete', 'submit', 'move', 'flags'].includes(call.method));

test('read methods return sanitized DTOs and bind only server credentials to readers', async () => {
    const f = fixture(false);
    expect((await f.service.list_mailboxes(context, {})).mailboxes).toHaveLength(1);
    expect((await f.service.list_messages(context, { mailboxId, limit: 20 })).messages).toHaveLength(1);
    expect((await f.service.search_messages(context, { text: 'needle', limit: 20 })).messages).toHaveLength(1);
    expect((await f.service.read_message(context, { includeHtml: true, mailboxId, uid: 7 })).text).toBe('text');
    for (const call of f.calls) { expect(call.args[0]).toEqual({ accountId, accessToken: context.accessToken }); }
    expect(f.operations.calls).toHaveLength(0);
});
test('invalid account, raw token, scope, status and unknown arguments fail before backend/store', async () => {
    const f = fixture();
    for (const bad of [{ ...context, accountId: 'other' }, { ...context, accessToken: '' }, { ...context, scopes: [] }, { ...context, connectionStatus: 'reconnect_required' as const }]) {
        await expect(f.service.send_draft(bad, target)).rejects.toBeInstanceOf(MailError);
    }
    await expect(f.service.create_draft(context, { ...content, operationId, accountId } as never)).rejects.toThrow('invalid_input');
    expect(f.calls).toHaveLength(0); expect(f.operations.calls).toHaveLength(0);
});
test('concurrent identical send has one backend dispatch; receipt replay never resolves drafts again', async () => {
    const f = fixture(); const outcomes = await Promise.all([f.service.send_draft(context, target), f.service.send_draft(context, target)]);
    expect(f.calls.filter(call => call.method === 'submit')).toHaveLength(1); expect(outcomes.some(result => result.status === 'queued')).toBe(true);
    const calls = f.calls.length; const replay = await f.service.send_draft(context, target);
    expect(replay).toEqual({ status: 'queued', operationId, queueId: 'queue-1' }); expect(f.calls).toHaveLength(calls);
    expect(JSON.stringify(replay)).not.toContain(context.accessToken);
});
test('send versus update/delete across clients uses one shared message guard', async () => {
    const f = fixture(); const other = { ...context, clientId: 'other-client' };
    const results = await Promise.all([f.service.send_draft(context, target), f.service.update_draft(other, { ...content, ...target, operationId: 'operation_test_002' }), f.service.delete_draft(other, { ...target, operationId: 'operation_test_003' })]);
    expect(f.calls.filter(call => ['upload', 'delete', 'submit', 'move', 'flags'].includes(call.method))).toHaveLength(1); expect(results.filter(result => result.status === 'conflict')).toHaveLength(2);
});
test('changed payload with same operation ID conflicts before reading drafts', async () => {
    const f = fixture(); await f.service.create_draft(context, { ...content, operationId }); const before = f.calls.length;
    for (const body of [{ text: 'changed' }, { markdown: 'private **body** changed' }, { html: 'private **body**' }, { text: 'private **body**' }]) {
        expect(await f.service.create_draft(context, { ...content, body, operationId })).toEqual({ status: 'conflict', operationId, reason: 'operation_conflict' });
    }
    expect(f.calls).toHaveLength(before); expect(posts(f)).toHaveLength(1);
    const stored = JSON.stringify([...f.operations.records.values()]); expect(stored).not.toContain(content.body.markdown); expect(stored).not.toContain('private'); expect(stored).not.toContain(content.subject); expect(stored).not.toContain(context.accessToken);
});
test('preflight version, recipient, draft state and target mismatch failures release only before dispatch', async () => {
    for (const [field, value, reason] of [['hasRecipients', false, 'no_recipients'], ['isDraft', false, 'unsupported_draft'], ] as const) {
        const f = fixture(); f.behavior.snapshot[field] = value;
        const result = field === 'hasRecipients' ? await f.service.send_draft(context, target) : await f.service.update_draft(context, { ...content, ...target });
        expect(result).toEqual({ status: 'failed', operationId, reason }); expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(0);
    }
    const f = fixture();
    expect(await f.service.delete_draft(context, { ...target, expectedVersion: 'x'.repeat(43) })).toEqual({ status: 'failed', operationId, reason: 'version_conflict' });
    f.behavior.snapshot.message.uid = 99;
    expect(await f.service.delete_draft(context, { ...target, operationId: 'operation_test_002' })).toEqual({ status: 'failed', operationId: 'operation_test_002', reason: 'temporarily_unavailable' });
    expect(posts(f)).toHaveLength(0);
});
test('failure to durably release preflight is temporary and never dispatches', async () => {
    const f = fixture(); f.behavior.snapshot.hasRecipients = false; f.operations.preflightFault = true;
    await expect(f.service.send_draft(context, target)).rejects.toThrow('temporarily_unavailable');
    expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(1);
    expect((await f.service.send_draft(context, target)).status).toBe('in_progress');
});
test('lost submit response stays unknown and is never resent under old or new operation IDs', async () => {
    const f = fixture(); f.behavior.postError = true;
    const result = await f.service.send_draft(context, target);
    expect(result).toEqual({ status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' });
    expect(await f.service.send_draft(context, target)).toEqual(result);
    expect((await f.service.send_draft(context, { ...target, operationId: 'operation_test_002' })).status).toBe('conflict');
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
    expect(await f.service.send_draft(context, target)).toEqual({ status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' });
    expect((await f.service.send_draft(context, { ...target, operationId: 'operation_test_003' })).status).toBe('conflict');
    expect((await f.service.delete_draft({ ...context, clientId: 'another' }, { ...target, operationId: 'operation_test_002' })).status).toBe('conflict'); expect(posts(f)).toHaveLength(1);
});
const unsettledLine = (tool: string, step: string, code: string) => ({ event: 'mail_write_unsettled', tool, step, code });
const temporarilyFailed = { status: 'failed', operationId, reason: 'temporarily_unavailable' } as const;
const send = (f: ReturnType<typeof fixture>) => f.service.send_draft(context, target);
test('a markDispatched failure made no WildDuck call, so it settles as failed whether or not the transition committed', async () => {
    for (const mode of ['before', 'after', 'shape'] as const) {
        const f = fixture(); f.operations.markFault = mode; const warnings = captureWarnings();
        try {
            expect(await send(f)).toEqual(temporarilyFailed);
            expect(f.operations.calls).toContain(mode === 'before' ? 'fail' : 'fail_dispatched');
            expect(posts(f)).toHaveLength(0); expect(f.calls.some(call => call.method === 'stamp')).toBe(false); expect(f.operations.guards.size).toBe(0);
            expect(f.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId }))?.state).toBe('settled');
            const calls = f.operations.calls.length; expect(await send(f)).toEqual(temporarilyFailed); expect(f.operations.calls.slice(calls)).toEqual(['get']);
            f.operations.markFault = 'none'; expect((await f.service.send_draft(context, { ...target, operationId: 'operation_test_002' })).status).toBe('queued');
            expect(warnings.lines).toEqual([]);
        } finally { warnings.restore(); }
    }
});
test('a markDispatched failure that cannot be settled stays in_progress (reserved) or outcome_unknown (dispatched) and is logged once', async () => {
    const reserved = fixture(); reserved.operations.markFault = 'before'; reserved.operations.preflightFault = true; const warnings = captureWarnings();
    try {
        expect(await send(reserved)).toEqual({ status: 'in_progress', operationId }); expect(reserved.operations.guards.size).toBe(1); expect(posts(reserved)).toHaveLength(0);
        expect(warnings.lines).toEqual([unsettledLine('send_draft', 'dispatch_mark', 'temporarily_unavailable')]);
        const unreadable = fixture(); unreadable.operations.markFault = 'before'; unreadable.operations.readsFailAfterMark = true; warnings.lines.length = 0;
        expect((await send(unreadable)).status).toBe('in_progress'); expect(unreadable.operations.guards.size).toBe(1); expect(warnings.lines).toEqual([unsettledLine('send_draft', 'dispatch_mark', 'temporarily_unavailable')]);
        const dispatched = fixture(); dispatched.operations.markFault = 'after'; dispatched.operations.failDispatchedFault = 'before'; warnings.lines.length = 0;
        expect(await send(dispatched)).toEqual({ status: 'in_progress', operationId }); expect(dispatched.operations.guards.size).toBe(1); expect(posts(dispatched)).toHaveLength(0); expect(dispatched.calls.some(call => call.method === 'stamp')).toBe(false);
        expect(dispatched.operations.calls).not.toContain('unknown'); expect(dispatched.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId }))?.state).toBe('dispatched');
        expect(warnings.lines).toEqual([unsettledLine('send_draft', 'dispatch_mark', 'temporarily_unavailable')]);
        const committed = fixture(); committed.operations.markFault = 'after'; committed.operations.failDispatchedFault = 'after'; warnings.lines.length = 0;
        expect(await send(committed)).toEqual(temporarilyFailed); expect(committed.operations.guards.size).toBe(0); expect(warnings.lines).toEqual([]);
    } finally { warnings.restore(); }
});
const notApplied = (code: 'not_found' | 'unsupported_draft' | 'temporarily_unavailable') => new MailError(code, undefined, { upstreamCode: 'MessageNotFound', notApplied: true });
const unproven = (code: 'not_found' | 'unsupported_draft' | 'temporarily_unavailable') => new MailError(code, undefined, { upstreamCode: 'MessageNotFound' });
/** Each write tool with a target, with the point where its first WildDuck mutation can be made to fail with a given error. */
const targeted = [
    { tool: 'update_draft', code: 'temporarily_unavailable', request: { ...target, subject: 'change' }, arm: (f: ReturnType<typeof fixture>, error: MailError) => { const upload = f.writer.uploadPreparedDraft; f.writer.uploadPreparedDraft = async () => { f.writer.uploadPreparedDraft = upload; throw error; }; } },
    { tool: 'delete_draft', code: 'not_found', request: target, arm: (f: ReturnType<typeof fixture>, error: MailError) => { const remove = f.writer.deleteDraft; f.writer.deleteDraft = async () => { f.writer.deleteDraft = remove; throw error; }; } },
    { tool: 'send_draft', code: 'unsupported_draft', request: target, arm: (f: ReturnType<typeof fixture>, error: MailError) => { const stamp = f.writer.stampSendMarker; f.writer.stampSendMarker = async () => { f.writer.stampSendMarker = stamp; throw error; }; } },
    { tool: 'move_message', code: 'not_found', request: { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24) }, arm: (f: ReturnType<typeof fixture>, error: MailError) => { const move = f.writer.moveMessage; f.writer.moveMessage = async () => { f.writer.moveMessage = move; throw error; }; } },
    { tool: 'update_message_flags', code: 'not_found', request: { ...target, mailboxId, seen: true }, arm: (f: ReturnType<typeof fixture>, error: MailError) => { const flags = f.writer.updateMessageFlags; f.writer.updateMessageFlags = async () => { f.writer.updateMessageFlags = flags; throw error; }; } },
] as const;
test('an error that proves the change was not applied settles as failed and releases the message; the same error unproven stays outcome_unknown', async () => {
    for (const { tool, code, request, arm } of targeted) {
        const f = fixture(); const warnings = captureWarnings();
        try {
            arm(f, notApplied(code));
            const failed = { status: 'failed', operationId, reason: code } as const;
            expect(await f.service[tool](context, request as never)).toEqual(failed);
            expect(f.operations.calls).toContain('fail_dispatched'); expect(f.operations.guards.size).toBe(0);
            expect(f.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId }))?.state).toBe('settled');
            const calls = f.calls.length; expect(await f.service[tool](context, request as never)).toEqual(failed); expect(f.calls).toHaveLength(calls);
            const again = { ...request, operationId: 'operation_test_002' };
            expect((await f.service[tool](context, again as never)).status).toBe(tool === 'send_draft' ? 'queued' : 'completed');
            expect(warnings.lines).toEqual([]);
            const g = fixture(); arm(g, unproven(code));
            const unknown = { status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' } as const;
            expect(await g.service[tool](context, request as never)).toEqual(unknown); expect(g.operations.calls).not.toContain('fail_dispatched'); expect(g.operations.guards.size).toBe(1);
            expect((await g.service[tool](context, { ...request, operationId: 'operation_test_002' } as never)).status).toBe('conflict');
            expect(warnings.lines).toEqual([unsettledLine(tool, 'upstream', 'MessageNotFound')]);
        } finally { warnings.restore(); }
    }
});
test('only a named WildDuck code is logged: an identifier-like upstream code is replaced by the local failure code and reaches no result', async () => {
    const identifier = 'a1B2c3D4e5F6g7H8i9J0k1L2'; const warnings = captureWarnings();
    try {
        const f = fixture(); f.writer.stampSendMarker = async () => { throw new MailError('not_found', undefined, { upstreamCode: identifier }); };
        const result = await send(f); expect(result).toEqual({ status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' });
        expect(warnings.lines).toEqual([unsettledLine('send_draft', 'upstream', 'not_found')]);
        expect(JSON.stringify([result, warnings.lines, [...f.operations.records.values()]])).not.toContain(identifier);
    } finally { warnings.restore(); }
});
test('notApplied inside update_draft keeps the meaning of its own partial results', async () => {
    const f = fixture(); f.behavior.deletionError = notApplied('not_found');
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('partial'); expect(f.operations.calls).not.toContain('fail_dispatched'); expect(f.operations.guards.size).toBe(1);
});
test('a notApplied error that arrives once complete has begun never settles as failed', async () => {
    const f = fixture(); f.operations.completeFault = 'before'; const warnings = captureWarnings();
    try {
        f.operations.complete = async () => { throw notApplied('temporarily_unavailable'); };
        expect((await send(f)).status).toBe('outcome_unknown'); expect(f.operations.calls).not.toContain('fail_dispatched');
        expect(warnings.lines).toEqual([unsettledLine('send_draft', 'complete', 'MessageNotFound')]);
    } finally { warnings.restore(); }
});
test('failDispatched failing falls back to the uncertain path, which returns the settlement if it committed', async () => {
    const warnings = captureWarnings();
    try {
        for (const mode of ['before', 'after'] as const) {
            const f = fixture(); f.operations.failDispatchedFault = mode; f.writer.stampSendMarker = async () => { throw notApplied('unsupported_draft'); }; warnings.lines.length = 0;
            const result = await send(f);
            if (mode === 'before') {
                expect(result).toEqual({ status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' }); expect(f.operations.calls).toContain('unknown'); expect(f.operations.guards.size).toBe(1);
                expect(warnings.lines).toEqual([unsettledLine('send_draft', 'upstream', 'MessageNotFound')]);
            } else { expect(result).toEqual({ status: 'failed', operationId, reason: 'unsupported_draft' }); expect(f.operations.guards.size).toBe(0); expect(warnings.lines).toEqual([]); }
            expect(posts(f)).toHaveLength(0);
        }
    } finally { warnings.restore(); }
});
test('complete is repeated once: one failure completes, two fail into the uncertain path, and no repeat starts without room in the request', async () => {
    const once = fixture(); once.operations.completeFailures = 1; const warnings = captureWarnings();
    try {
        expect((await send(once)).status).toBe('queued'); expect(once.operations.calls.filter(call => call === 'complete')).toHaveLength(2); expect(posts(once)).toHaveLength(1); expect(once.operations.guards.size).toBe(0);
        expect(warnings.lines).toEqual([]);
        const twice = fixture(); twice.operations.completeFailures = 2;
        expect(await send(twice)).toEqual({ status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' }); expect(twice.operations.calls.filter(call => call === 'complete')).toHaveLength(2); expect(posts(twice)).toHaveLength(1);
        expect(warnings.lines).toEqual([unsettledLine('send_draft', 'complete', 'temporarily_unavailable')]);
        const tight = fixture(); tight.operations.completeFailures = 1; let left = 60_000; const complete = tight.operations.complete.bind(tight.operations);
        tight.operations.complete = async (...args) => { left = 5_000; return complete(...args); };
        expect((await withRequestBudget(() => left, () => send(tight))).status).toBe('outcome_unknown'); expect(tight.operations.calls.filter(call => call === 'complete')).toHaveLength(1);
    } finally { warnings.restore(); }
});
test('every unsettled step logs one line with only the tool, step, code and request ID', async () => {
    const warnings = captureWarnings();
    try {
        const run = async (f: ReturnType<typeof fixture>, tool: 'send_draft' | 'create_draft' = 'send_draft') => { warnings.lines.length = 0; try { await (tool === 'send_draft' ? send(f) : f.service.create_draft(context, { ...content, operationId })); } catch { /* A thrown reserve or settlement failure. */ } return [...warnings.lines]; };
        // reserve: the outcome of the reservation is unknown and the read-back finds nothing.
        const reserve = fixture(); reserve.operations.reserve = async () => { throw new Error('secret reserve failure'); };
        expect(await run(reserve)).toEqual([unsettledLine('send_draft', 'reserve', 'temporarily_unavailable')]);
        // reserve: this call's reservation was found but could not be settled.
        const readBack = fixture(); const reserved = readBack.operations.reserve.bind(readBack.operations);
        readBack.operations.reserve = async (...args) => { await reserved(...args); throw new Error('secret reserve failure'); }; readBack.operations.preflightFault = true;
        expect(await run(readBack)).toEqual([unsettledLine('send_draft', 'reserve', 'temporarily_unavailable')]);
        const preflight = fixture(); preflight.behavior.snapshot.hasRecipients = false; preflight.operations.preflightFault = true;
        expect(await run(preflight)).toEqual([unsettledLine('send_draft', 'preflight_settle', 'temporarily_unavailable')]);
        const dispatchMark = fixture(); dispatchMark.operations.markFault = 'after'; dispatchMark.operations.failDispatchedFault = 'before';
        expect(await run(dispatchMark)).toEqual([unsettledLine('send_draft', 'dispatch_mark', 'temporarily_unavailable')]);
        const upstream = fixture(); upstream.behavior.postError = true;
        expect(await run(upstream)).toEqual([unsettledLine('send_draft', 'upstream', 'temporarily_unavailable')]);
        const complete = fixture(); complete.operations.completeFault = 'before';
        expect(await run(complete, 'create_draft')).toEqual([unsettledLine('create_draft', 'complete', 'temporarily_unavailable')]);
        const unknownMark = fixture(); unknownMark.behavior.postError = true; unknownMark.operations.unknownFault = true;
        expect(await run(unknownMark)).toEqual([unsettledLine('send_draft', 'unknown_mark', 'temporarily_unavailable')]);
        const withId = fixture(); withId.behavior.postError = true; warnings.lines.length = 0;
        await withRequestId('request-id-1', () => send(withId));
        expect(warnings.lines).toEqual([{ ...unsettledLine('send_draft', 'upstream', 'temporarily_unavailable'), requestId: 'request-id-1' }]);
        expect(JSON.stringify(warnings.lines)).not.toMatch(/operation_test|secret|aaaaaaaa|bbbbbbbb/u);
    } finally { warnings.restore(); }
});
test('replacement verifies candidate before fresh original inspection and deletion', async () => {
    const f = fixture(); const result = await f.service.update_draft(context, { subject: 'changed', ...target });
    expect(result.status).toBe('completed');
    expect(f.calls.map(call => call.method)).toEqual(['resolve', 'inspect', 'prepareUpdate', 'upload', 'verify', 'inspect', 'delete']);
    expect(f.calls.find(call => call.method === 'prepareUpdate')?.args[2]).toEqual({ subject: 'changed' });
    // The hold ended with the receipt; the old uid is gone, so a later change of it reaches WildDuck's own not_found.
    expect(f.operations.guards.size).toBe(0);
    expect(await f.service.delete_draft(context, { ...target, operationId: 'operation_test_002' })).toEqual({ status: 'failed', operationId: 'operation_test_002', reason: 'not_found' });
    expect(f.calls.filter(call => call.method === 'delete')).toHaveLength(1);
});
test('write preflight uses its write scope without granting public read access', async () => {
    const f = fixture(); const sendOnly = { ...context, scopes: ['mail:send'] };
    await expect(f.service.read_message(sendOnly, { includeHtml: true, mailboxId, uid: 7 })).rejects.toThrow('forbidden');
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
    expect(result).toEqual({ status: 'failed', operationId, reason: 'source_integrity_unavailable' });
    expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0); expect(f.operations.guards.size).toBe(0);
});
test('candidate verification failure is explicit partial without invented version or original deletion', async () => {
    const f = fixture(); f.behavior.verificationError = true;
    const result = await f.service.update_draft(context, { ...target, subject: 'change only subject' });
    expect(result).toEqual({ status: 'partial', operationId, candidate: { mailboxId, uid: 8 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    expect(await f.service.send_draft(context, { ...target, uid: 8, operationId: 'candidate_send_001' })).toEqual({ status: 'failed', operationId: 'candidate_send_001', reason: 'verification_failed' });
    expect(f.calls.some(call => call.method === 'submit')).toBe(false);
});
test('stale original after candidate verification leaves explicit nonactivated partial', async () => {
    const f = fixture(); f.behavior.originalChanged = true;
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('partial');
    if (result.status === 'partial') { expect(result.reason).toBe('original_version_changed'); expect(result.originalDeletion).toBe('not_attempted'); }
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    const candidate = { ...target, uid: 8, operationId: 'candidate_send_001' };
    expect((await f.service.send_draft(context, candidate)).status).toBe('failed');
    const flags = await f.service.update_message_flags(context, { ...candidate, mailboxId, operationId: 'candidate_flags_01', seen: true });
    expect(flags).toEqual({ status: 'failed', operationId: 'candidate_flags_01', reason: 'verification_failed' });
});
test('fresh original read outage yields verification partial without falsely claiming version change', async () => {
    const f = fixture(); const verify = f.writer.verifyPreparedDraft;
    f.writer.verifyPreparedDraft = async (...args) => { const result = await verify(...args); f.behavior.originalReadError = true; return result; };
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('partial');
    if (result.status === 'partial') { expect(result.reason).toBe('original_verification_failed'); expect(result.originalDeletion).toBe('not_attempted'); }
    expect(f.calls.some(call => call.method === 'delete')).toBe(false);
    f.behavior.originalReadError = false;
    expect((await f.service.send_draft(context, { ...target, uid: 8, operationId: 'candidate_send_001' })).status).toBe('failed');
});
test('one transient failure of the fresh original read is retried, so the update completes with one upload and one delete', async () => {
    const f = fixture(); const verify = f.writer.verifyPreparedDraft; const inspect = f.writer.inspectMessage; let armed = false; let reads = 0;
    f.writer.verifyPreparedDraft = async (...args) => { const result = await verify(...args); armed = true; return result; };
    f.writer.inspectMessage = async (...args) => { if (armed) { reads++; if (reads === 1) { throw new MailError('temporarily_unavailable'); } } return inspect(...args); };
    const result = await f.service.update_draft(context, { ...target, subject: 'change' });
    expect(result.status).toBe('completed'); expect(reads).toBe(2);
    expect(f.calls.filter(call => call.method === 'upload')).toHaveLength(1); expect(f.calls.filter(call => call.method === 'delete')).toHaveLength(1);
});
test('verified candidate with failed or uncertain original deletion has explicit partial and activation', async () => {
    for (const error of [new MailError('forbidden'), new Error('backend timeout with secret')]) {
        const f = fixture(); f.behavior.deletionError = error;
        const result = await f.service.update_draft(context, { ...target, subject: 'change' });
        expect(result.status).toBe('partial');
        if (result.status === 'partial') { expect(result.reason).toBe(error instanceof MailError ? 'original_deletion_failed' : 'original_deletion_unconfirmed'); }
        f.behavior.deletionError = undefined;
        // The old copy stays held for its deletion only: flags are refused, delete_draft of it takes the hold over.
        expect((await f.service.update_message_flags(context, { ...target, mailboxId, operationId: 'old_flags_op_001', seen: true })).status).toBe('conflict');
        expect((await f.service.delete_draft(context, { ...target, operationId: 'old_delete_op_001' })).status).toBe('completed');
        expect((await f.service.send_draft(context, { ...target, uid: 8, operationId: 'candidate_send_001' })).status).toBe('queued');
        expect(f.calls.filter(call => call.method === 'delete')).toHaveLength(2); expect(f.operations.guards.size).toBe(0);
    }
});
test('historical activation proof survives later version changes but fresh expected version alone cannot activate', async () => {
    const f = fixture(); const created = await f.service.create_draft(context, { ...content, operationId });
    expect(created.status).toBe('completed');
    const candidateKey = { mailboxId, uid: 8 }; const stored = f.messages.get(JSON.stringify(candidateKey));
    if (!stored) { throw new Error('Missing test candidate'); }
    f.messages.set(JSON.stringify(candidateKey), { ...stored, message: { ...stored.message, version: 'h'.repeat(43) } });
    expect((await f.service.send_draft(context, { ...target, uid: 8, expectedVersion: 'h'.repeat(43), operationId: 'candidate_send_001' })).status).toBe('queued');
    const g = fixture(); g.behavior.verificationError = true;
    await g.service.create_draft(context, { ...content, operationId });
    expect(await g.service.send_draft(context, { ...target, uid: 8, operationId: 'candidate_send_001' })).toEqual({ status: 'failed', operationId: 'candidate_send_001', reason: 'verification_failed' });
});
test('read marker checks one operation, never leaks private marker or performs list N+1', async () => {
    const f = fixture(); await f.service.create_draft(context, { ...content, operationId });
    const before = f.operations.calls.length;
    const result = await f.service.read_message(context, { includeHtml: true, mailboxId, uid: 8 });
    expect(result.managedOperation).toEqual({ operationId, verification: 'verified' });
    expect(f.operations.calls.length - before).toBe(1); expect(JSON.stringify(result)).not.toContain('payloadDigest'); expect(JSON.stringify(result)).not.toContain('clientIdHash');
    const start = f.operations.calls.length;
    await f.service.list_messages(context, { mailboxId, limit: 20 }); await f.service.search_messages(context, { text: 'x', limit: 20 });
    expect(f.operations.calls.length).toBe(start);
});
test('send stamps after durable dispatch before queue submission and returns actual Sent identity only', async () => {
    const f = fixture(); const stamp = f.writer.stampSendMarker;
    f.writer.stampSendMarker = async (...args) => { expect(f.operations.calls).toContain('dispatch'); return stamp(...args); };
    f.writer.submitDraft = async () => ({ queueId: 'queue-actual', sent: { mailboxId: 'e'.repeat(24), uid: 90 } });
    expect(await f.service.send_draft(context, target)).toEqual({ status: 'queued', operationId, queueId: 'queue-actual', sent: { mailboxId: 'e'.repeat(24), uid: 90 } });
    expect(f.calls.find(call => call.method === 'stamp')).toBeDefined();
    const g = fixture(); g.behavior.queueId = '';
    expect((await g.service.send_draft(context, target)).status).toBe('outcome_unknown');
});
test('move and flags end their hold with the receipt, and both require modify scope', async () => {
    const f = fixture(); const flags = { ...target, mailboxId, seen: true };
    expect((await f.service.update_message_flags(context, flags)).status).toBe('completed'); expect(f.operations.guards.size).toBe(0);
    expect((await f.service.update_message_flags(context, { ...flags, operationId: 'flags_operation_02', expectedVersion: 'f'.repeat(43), flagged: true })).status).toBe('completed');
    const next = { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24), expectedVersion: 'f'.repeat(43), operationId: 'move_operation_01' };
    expect((await f.service.move_message(context, next)).status).toBe('completed'); expect(f.operations.guards.size).toBe(0);
    expect(await f.service.update_message_flags(context, { ...flags, operationId: 'flags_operation_03', expectedVersion: 'f'.repeat(43) })).toEqual({ status: 'failed', operationId: 'flags_operation_03', reason: 'not_found' });
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
        const next = await f.service.update_message_flags(context, { ...request, expectedVersion: 'f'.repeat(43), operationId: 'flag_followup_001', flagged: true });
        expect(next.status).toBe(mode === 'after' ? 'completed' : 'conflict');
    }
});
test('candidate with verified MIME but lost durable completion remains unactivated', async () => {
    const f = fixture(); f.operations.completeFault = 'before';
    expect((await f.service.create_draft(context, { ...content, operationId })).status).toBe('outcome_unknown');
    const read = await f.service.read_message(context, { includeHtml: true, mailboxId, uid: 8 });
    expect(read.managedOperation?.verification).toBe('outcome_unknown');
    expect(await f.service.send_draft(context, { ...target, uid: 8, operationId: 'candidate_send_001' })).toEqual({ status: 'failed', operationId: 'candidate_send_001', reason: 'verification_failed' });
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
        expect(result).toEqual({ status: 'failed', operationId, reason: 'unsupported_content' });
        expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0);
        expect(f.calls.some(call => ['stamp', 'prepareUpdate', 'sourcecheck'].includes(call.method))).toBe(false); expect(f.operations.guards.size).toBe(0);
    }
});
test('legacy read and deletion remain available without authored provenance', async () => {
    const f = fixture(false); expect((await f.service.read_message(context, { includeHtml: true, mailboxId, uid: 7 })).text).toBe('text');
    expect((await f.service.delete_draft(context, target)).status).toBe('completed');
    expect(f.calls.some(call => call.method === 'sourcecheck')).toBe(false);
});
test('legacy flag and move receipts stay observed and cannot promote later edit or send', async () => {
    const f = fixture(false);
    const flagged = await f.service.update_message_flags(context, { ...target, mailboxId, seen: true });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('observed'); }
    const changed = { ...target, expectedVersion: 'f'.repeat(43), operationId: 'legacy_send_operation_01' };
    expect((await f.service.send_draft(context, changed)).status).toBe('failed');
    expect(await f.service.update_draft(context, { ...changed, operationId: 'legacy_edit_operation_01', subject: 'change' })).toEqual({ status: 'failed', operationId: 'legacy_edit_operation_01', reason: 'unsupported_content' });
    const moved = await f.service.move_message(context, { ...changed, operationId: 'legacy_move_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) });
    expect(moved.status).toBe('completed'); if (moved.status === 'completed') { expect(moved.proof.sourceGrade).toBe('observed'); }
    const back = await f.service.move_message(context, { uid: 9, expectedVersion: version, operationId: 'legacy_move_operation_02', mailboxId: 'e'.repeat(24), destinationMailboxId: mailboxId });
    expect(back.status).toBe('completed'); if (back.status === 'completed') { expect(back.proof.sourceGrade).toBe('observed'); }
    expect(await f.service.send_draft(context, { ...target, uid: 9, operationId: 'legacy_send_operation_02' })).toEqual({ status: 'failed', operationId: 'legacy_send_operation_02', reason: 'unsupported_content' });
    expect(f.calls.some(call => call.method === 'sourcecheck')).toBe(false);
});
test('MCP create through flags and moves preserves trusted grade for later edit and send', async () => {
    const f = fixture(false);
    const created = await f.service.create_draft(context, { ...content, operationId });
    expect(created.status).toBe('completed'); if (created.status === 'completed') { expect(created.proof.sourceGrade).toBe('mcp_authored'); }
    const flagged = await f.service.update_message_flags(context, { ...target, uid: 8, mailboxId, seen: true, operationId: 'authored_flags_operation_01' });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('mcp_authored'); }
    const moved = await f.service.move_message(context, { uid: 8, expectedVersion: 'f'.repeat(43), operationId: 'authored_move_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) });
    expect(moved.status).toBe('completed'); if (moved.status === 'completed') { expect(moved.proof.sourceGrade).toBe('mcp_authored'); }
    await f.service.move_message(context, { uid: 9, expectedVersion: version, operationId: 'authored_move_operation_02', mailboxId: 'e'.repeat(24), destinationMailboxId: mailboxId });
    f.behavior.nextUid = 10;
    const edited = await f.service.update_draft(context, { ...target, uid: 9, subject: 'change', operationId: 'authored_edit_operation_01' });
    expect(edited.status).toBe('completed'); if (edited.status === 'completed') { expect(edited.proof.sourceGrade).toBe('mcp_authored'); }
    expect((await f.service.send_draft(context, { ...target, uid: 10, operationId: 'authored_send_operation_01' })).status).toBe('queued');
    const checked = f.calls.filter(call => call.method === 'sourcecheck'); expect(checked).toHaveLength(4);
    for (const call of checked) { expect(call.args[2]).toMatchObject({ grade: 'mcp_authored', accountId, contentDigest: 'd'.repeat(64) }); }
});
test('authored hash mismatch rejects update, send, move and flags before dispatch without demotion', async () => {
    for (const tool of ['update_draft', 'send_draft', 'move_message', 'update_message_flags'] as const) {
        const f = fixture(); f.behavior.sourceMismatch = true;
        const args = tool === 'move_message' ? { ...target, mailboxId, destinationMailboxId: 'e'.repeat(24) } : tool === 'update_message_flags' ? { ...target, mailboxId, seen: true } : tool === 'update_draft' ? { ...target, subject: 'change' } : target;
        expect(await f.service[tool](context, args as never)).toEqual({ status: 'failed', operationId, reason: 'verification_failed' });
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
            f.operations.records.set(keyOf(key), { key, intent: { ...marker, tool: 'update_message_flags', target: { mailboxId, uid: 7 }, expectedVersion: version }, ownerToken: 'spoof-owner', revision: 2, state: 'settled', receipt: { status: 'completed', operationId: key.operationId, message: reference, verified: true, proof: { ...reference, accountId, contentDigest: 'd'.repeat(64), sourceGrade: variant === 'observed' ? 'observed' : 'mcp_authored' } } });
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
    expect((await f.service.read_message(context, { ...sent, includeHtml: true })).managedOperation?.verification).toBe('verified');
    const flagged = await f.service.update_message_flags(context, { ...sent, expectedVersion: version, operationId: 'sent_flags_operation_01', seen: true });
    expect(flagged.status).toBe('completed'); if (flagged.status === 'completed') { expect(flagged.proof.sourceGrade).toBe('observed'); }
    expect(f.calls.filter(call => call.method === 'sourcecheck')).toHaveLength(1);
});

test('upstream_timeout after dispatched upload, submit or flags preserves uncertainty and every client fence', async () => {
    for (const tool of ['update_draft', 'send_draft', 'update_message_flags'] as const) {
        const f = fixture(); let effects = 0;
        const observedEffect = () => {
            const record = f.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId }));
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
        const unknown = { status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' } as const;
        expect(await f.service[tool](context, request as never)).toEqual(unknown);
        const calls = f.calls.length;
        expect(await f.service[tool](context, request as never)).toEqual(unknown);
        expect(f.calls.length).toBe(calls); expect(effects).toBe(1); expect(f.operations.guards.size).toBe(1);
        for (const client of [context, { ...context, clientId: 'another-client' }]) {
            expect(await f.service[tool](client, { ...request, operationId: 'deadline_followup_001' } as never)).toEqual({ status: 'conflict', operationId: 'deadline_followup_001', reason: 'draft_fenced' });
        }
        expect(effects).toBe(1); expect(f.operations.guards.size).toBe(1);
        expect(f.calls.filter(call => ['upload', 'submit', 'flags'].includes(call.method))).toHaveLength(1);
    }
});
test('upstream_timeout during source verification settles failure and releases the guard before dispatch', async () => {
    const f = fixture(); let checks = 0;
    const verify = f.writer.verifyAuthoredSource;
    f.writer.verifyAuthoredSource = async () => { checks++; throw new MailError('upstream_timeout'); };
    const failed = { status: 'failed', operationId, reason: 'upstream_timeout' } as const;
    expect(await f.service.send_draft(context, target)).toEqual(failed);
    expect(f.operations.calls).not.toContain('dispatch'); expect(posts(f)).toHaveLength(0);
    expect(f.calls.some(call => call.method === 'stamp')).toBe(false); expect(f.operations.guards.size).toBe(0);
    expect(await f.service.send_draft(context, target)).toEqual(failed); expect(checks).toBe(1);
    f.writer.verifyAuthoredSource = verify;
    expect((await f.service.send_draft(context, { ...target, operationId: 'deadline_retry_new_001' })).status).toBe('queued');
    expect(f.calls.filter(call => call.method === 'submit')).toHaveLength(1);
});
test('read and search upstream_timeout stay read errors without operation records or guards', async () => {
    const f = fixture(false);
    f.reader.readMessage = async () => { throw new MailError('upstream_timeout'); };
    f.reader.searchMessages = async () => { throw new MailError('upstream_timeout'); };
    await expect(f.service.read_message(context, { includeHtml: true, mailboxId, uid: 7 })).rejects.toMatchObject({ code: 'upstream_timeout', message: 'upstream_timeout' });
    await expect(f.service.search_messages(context, { text: 'needle', limit: 20 })).rejects.toMatchObject({ code: 'upstream_timeout', message: 'upstream_timeout' });
    expect(f.operations.calls).toHaveLength(0); expect(f.operations.records.size).toBe(0); expect(f.operations.guards.size).toBe(0); expect(posts(f)).toHaveLength(0);
});

test('batch reads preserve order, cap concurrency and return isolated sanitized failures', async () => {
    const f = fixture(false); const original = f.reader.readMessage; let active = 0; let high = 0;
    f.reader.readMessage = async (bound, key) => { active++; high = Math.max(high, active); try { await Bun.sleep(2); if (key.uid === 3) { throw new MailError('not_found'); } const result = await original(bound, key); return { message: { ...result.message, ...key } }; } finally { active--; } };
    const result = await f.service.read_messages(context, { includeHtml: true, messages: Array.from({ length: 8 }, (_, index) => ({ mailboxId, uid: index + 1 })) });
    expect(high).toBe(3); expect(result.results.map(item => item.status === 'ok' ? item.message.uid : item.uid)).toEqual([1,2,3,4,5,6,7,8]);
    expect(result.results[2]).toEqual({ status: 'failed', mailboxId, uid: 3, error: { code: 'not_found', message: errorText('not_found', 'read_messages') } }); expect(JSON.stringify(result.results[2])).toContain('List or search again for current ids'); expect(result.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(result))); expect(f.operations.calls).toHaveLength(0);
});
test('batch serialized budget includes metadata, envelope and reserved failure slots', async () => {
    const f = fixture(false); const original = f.reader.readMessage;
    f.reader.readMessage = async (bound, key) => ({ message: { ...(await original(bound, key)).message, ...key, text: 'x'.repeat(128 * 1024), html: ['x'.repeat(256 * 1024)] } });
    const result = await f.service.read_messages(context, { includeHtml: true, messages: Array.from({ length: 10 }, (_, index) => ({ mailboxId, uid: index + 1 })) });
    expect(result.results.filter(item => item.status === 'ok')).toHaveLength(2); expect(result.results.filter(item => item.status === 'failed').every(item => item.status === 'failed' && item.error.code === 'too_large' && item.error.message.includes('Read it alone with read_message'))).toBe(true); expect(Object.keys(result)[0]).toBe('summary'); expect(result.summary).toBe('Of 10 messages, 8 could not be read (see the error in each failed item).'); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576); expect(result.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(result)));
});

test('reply draft uses distinct durable create intent, skips preparation on replay, and requires both read and draft', async () => {
    const f = fixture(false); const reply = { original: { mailboxId, uid: 7 }, mode: 'reply_all' as const, body: { text: 'Reply' }, quoteOriginal: false, attachments: [], operationId };
    const created = await f.service.create_reply_draft(context, reply); expect(created.status).toBe('completed'); expect(f.calls.filter(call => call.method === 'prepareReply')).toHaveLength(1); expect(f.calls.some(call => call.method === 'inspect')).toBe(false);
    const calls = f.calls.length; expect(await f.service.create_reply_draft(context, reply)).toEqual(created); expect(f.calls).toHaveLength(calls); expect(await f.service.create_reply_draft(context, { ...reply, body: { text: 'Changed' } })).toMatchObject({ status: 'conflict', reason: 'operation_conflict' });
    expect([...f.operations.records.values()][0]?.intent.tool).toBe('create_reply_draft');
    const denied = fixture(false); await expect(denied.service.create_reply_draft({ ...context, scopes: ['mail:draft'] }, reply)).rejects.toMatchObject({ code: 'forbidden' }); expect(denied.calls).toHaveLength(0); expect(denied.operations.calls).toHaveLength(0);
});
test('reply preparation failure settles preflight without upload and authored reply can later send', async () => {
    const f = fixture(false); const reply = { original: { mailboxId, uid: 7 }, mode: 'reply' as const, body: { text: 'Reply' }, quoteOriginal: false, attachments: [], operationId };
    f.behavior.preparationError = true; expect(await f.service.create_reply_draft(context, reply)).toMatchObject({ status: 'failed', reason: 'unsupported_content' }); expect(f.calls.some(call => call.method === 'upload')).toBe(false); expect(f.operations.calls).not.toContain('dispatch');
    const good = fixture(false); const created = await good.service.create_reply_draft(context, reply); if (created.status !== 'completed') { throw new Error('expected created draft'); }
    const send = { uid: created.draft.uid, expectedVersion: created.draft.version, operationId: 'reply-send-operation' };
    const sent = await good.service.send_draft(context, send); expect(sent.status).toBe('queued');
    const count = good.calls.length; expect(await good.service.send_draft(context, send)).toEqual(sent); expect(good.calls).toHaveLength(count);
    expect(good.calls.filter(call => call.method === 'submit')).toHaveLength(1); expect(good.calls.some(call => call.method === 'flags')).toBe(false);
});
test('reply verification failure stays partial on replay and uncertain reply sends never redispatch', async () => {
    const reply = { original: { mailboxId, uid: 7 }, mode: 'reply' as const, body: { text: 'Reply' }, quoteOriginal: false, attachments: [], operationId };
    const partial = fixture(false); partial.behavior.verificationError = true;
    const result = await partial.service.create_reply_draft(context, reply); expect(result).toMatchObject({ status: 'partial', candidateVerified: false, reason: 'candidate_verification_failed' });
    const count = partial.calls.length; expect(await partial.service.create_reply_draft(context, reply)).toEqual(result); expect(partial.calls).toHaveLength(count);
    expect(partial.calls.some(call => call.method === 'submit' || call.method === 'flags')).toBe(false);
    const uncertain = fixture(false); const created = await uncertain.service.create_reply_draft(context, reply);
    if (created.status !== 'completed') { throw new Error('expected created draft'); }
    uncertain.behavior.postError = true;
    const send = { uid: created.draft.uid, expectedVersion: created.draft.version, operationId: 'reply-send-operation' };
    const unknown = await uncertain.service.send_draft(context, send); expect(unknown).toMatchObject({ status: 'outcome_unknown', reason: 'dispatch_uncertain' });
    const sentCalls = uncertain.calls.length; expect(await uncertain.service.send_draft(context, send)).toEqual(unknown); expect(uncertain.calls).toHaveLength(sentCalls);
    expect(uncertain.calls.filter(call => call.method === 'submit')).toHaveLength(1); expect(uncertain.calls.some(call => call.method === 'flags')).toBe(false);
});
test('thread body pages reuse bounded batch reader, retaining per-item failures and limiting body page size', async () => {
    const f = fixture(false); const original = f.reader.readMessage;
    f.reader.getThread = async () => { const summary = (await f.reader.listMessages(context, { mailboxId, limit: 20 })).messages[0]; if (!summary) { throw new Error('missing summary'); } return { threadId: mailboxId, messages: [summary, { ...summary, uid: 8 }], next: 'thread-next' }; };
    f.reader.readMessage = async (bound, key) => { if (key.uid === 8) { throw new MailError('not_found'); } return original(bound, key); };
    const page = await f.service.get_thread(context, { threadId: mailboxId, limit: 2, includeBodies: true }); expect(page.next).toBe('thread-next'); expect(page.bodies?.results.map(item => item.status)).toEqual(['ok', 'failed']); expect(page.bodies?.includeHtml).toBe(true); expect(page.bodies?.results[0]).toMatchObject({ status: 'ok', message: { html: ['<p>html</p>'], htmlOmitted: false } });
    await expect(f.service.get_thread(context, { threadId: mailboxId, limit: 11, includeBodies: true })).rejects.toMatchObject({ code: 'invalid_input' });
});
test('batch deadline includes a stalled provenance lookup and returns item timeout', async () => {
    const f = fixture(); f.operations.getOperation = async () => new Promise(() => {}); const deadline = performance.now() + 2020;
    const started = performance.now(); const result = await withRequestBudget(() => Math.max(0, deadline - performance.now()), () => f.service.read_messages(context, { includeHtml: true, messages: [{ mailboxId, uid: 7 }] }));
    expect(performance.now() - started).toBeLessThan(500); expect(result.results[0]).toMatchObject({ status: 'failed', error: { code: 'upstream_timeout' } });
});

test('download link carrier validates public metadata identity and URL before returning the private link', async () => {
    const f = fixture(false); const request = { mailboxId, uid: 7, attachmentId: 'ATT1' }; const valid = f.reader.getAttachmentDownload;
    const link = await f.service.get_attachment_download(context, request);
    expect(link.metadata).toEqual({ ...request, filename: null, contentType: 'text/plain', size: 5, expiresAt: '2026-10-26T10:00:00.000Z' }); expect(link.metadata).not.toHaveProperty('url'); expect(link.url).toBe('https://example.s3.amazonaws.com/file');
    for (const metadata of [{ mailboxId: 'f'.repeat(24) }, { uid: 8 }, { attachmentId: 'ATT2' }, { size: -1 }, { expiresAt: 'invalid-expiry' }]) {
        f.reader.getAttachmentDownload = async (bound, input) => { const original = await valid(bound, input); return { ...original, metadata: { ...original.metadata, ...metadata } }; };
        await expect(f.service.get_attachment_download(context, request)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    }
    f.reader.getAttachmentDownload = async (bound, input) => ({ ...await valid(bound, input), url: 'http://example.s3.amazonaws.com/private-secret' });
    await expect(f.service.get_attachment_download(context, request)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(f.operations.calls).toHaveLength(0);
});

test('message source link needs mail:read and an active session, binds only the verified account, and validates its carrier', async () => {
    const f = fixture(false); const request = { mailboxId, uid: 7 }; const valid = f.reader.getMessageSourceDownload;
    const link = await f.service.get_message_source_download(context, request);
    expect(link).toEqual({ metadata: { ...request, size: 9, sha256: 'd'.repeat(64), expiresAt: '2026-10-26T10:05:00.000Z' }, url: 'https://example.s3.amazonaws.com/source' });
    // The backend sees only the account and its token: no client id, scopes or connection state.
    expect(f.calls).toEqual([{ method: 'getMessageSourceDownload', args: [{ accountId, accessToken: context.accessToken }, request] }]);
    for (const [bad, code] of [[{ ...context, scopes: ['mail:draft', 'mail:send', 'mail:modify'] }, 'forbidden'], [{ ...context, scopes: [] }, 'forbidden'], [{ ...context, accountId: 'not-an-account' }, 'forbidden'], [{ ...context, accessToken: '' }, 'forbidden'], [{ ...context, connectionStatus: 'reconnect_required' as const }, 'reconnect_required']] as const) {
        await expect(f.service.get_message_source_download(bad, request)).rejects.toMatchObject({ code });
    }
    for (const bad of [{ mailboxId, uid: 0 }, { mailboxId, uid: 7, attachmentId: 'ATT1' }, { mailboxId, uid: 7, accountId }]) { await expect(f.service.get_message_source_download(context, bad as never)).rejects.toMatchObject({ code: 'invalid_input' }); }
    expect(f.calls).toHaveLength(1);
    for (const metadata of [{ mailboxId: 'f'.repeat(24) }, { uid: 8 }, { size: -1 }, { sha256: 'not-a-hash' }, { expiresAt: 'invalid-expiry' }, { url: 'https://example.s3.amazonaws.com/leak' }]) {
        f.reader.getMessageSourceDownload = async (bound, input) => { const original = await valid(bound, input); return { ...original, metadata: { ...original.metadata, ...metadata } }; };
        await expect(f.service.get_message_source_download(context, request)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    }
    f.reader.getMessageSourceDownload = async (bound, input) => ({ ...await valid(bound, input), url: 'http://example.s3.amazonaws.com/private-secret' });
    await expect(f.service.get_message_source_download(context, request)).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    for (const code of ['not_found', 'too_large', 'upstream_timeout', 'source_integrity_unavailable'] as const) {
        f.reader.getMessageSourceDownload = async () => { throw new MailError(code); };
        await expect(f.service.get_message_source_download(context, request)).rejects.toMatchObject({ code });
    }
    f.reader.getMessageSourceDownload = async () => { throw new Error('private upstream body https://signed.example/?token=secret'); };
    const error = await f.service.get_message_source_download(context, request).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'temporarily_unavailable' }); expect(String((error as Error).message)).not.toContain('secret');
    expect(f.operations.calls).toHaveLength(0);
});

test('text-only batches omit HTML explicitly before aggregate budgeting and preserve genuine text truncation', async () => {
    const f = fixture(false); const original = f.reader.readMessage; const html = 'PRIVATE_HTML_PAYLOAD_'.repeat(12000);
    f.reader.readMessage = async (bound, key) => ({ message: { ...(await original(bound, key)).message, ...key, text: 'x'.repeat(64 * 1024), textTruncated: key.uid === 1, html: [html], htmlTruncated: true } });
    const messages = Array.from({ length: 10 }, (_, index) => ({ mailboxId, uid: index + 1 }));
    const full = await f.service.read_messages(context, { messages, includeHtml: true }); expect(full.includeHtml).toBe(true); expect(full.results.filter(item => item.status === 'ok').length).toBeLessThan(messages.length); expect(full.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(full))); for (const item of full.results) { if (item.status === 'ok') { expect(item.message).toMatchObject({ html: [html], htmlOmitted: false, htmlTruncated: true, htmlRepresentation: 'wildduck_normalized' }); } }
    const result = await f.service.read_messages(context, { messages, includeHtml: false });
    expect(result.results.every((item: { status: string }) => item.status === 'ok')).toBe(true); expect(result.includeHtml).toBe(false);
    for (const item of result.results) { if (item.status !== 'ok') { throw new Error('expected successful text-only projection'); } expect(item.message).not.toHaveProperty('html'); expect('html' in item.message).toBe(false); expect(item.message.htmlOmitted).toBe(true); expect(item.message).not.toHaveProperty('htmlTruncated'); expect(item.message).not.toHaveProperty('htmlRepresentation'); }
    expect(result.results[0]).toMatchObject({ status: 'ok', message: { textTruncated: true } }); expect(JSON.stringify(result)).not.toContain('PRIVATE_HTML_PAYLOAD_'); expect(result.bytesReturned).toBe(Buffer.byteLength(JSON.stringify(result))); expect(result.bytesReturned).toBeLessThan(1048576);
});

test('single text-only projection keeps version and provenance while its backend receives only message identity', async () => {
    const f = fixture(); const original = f.reader.readMessage;
    f.reader.readMessage = async (bound, key) => { const full = await original(bound, key); return { ...full, message: { ...full.message, htmlTruncated: true } }; };
    const input = { mailboxId, uid: 7 }; const full = await f.service.read_message(context, { ...input, includeHtml: true });
    const text = await f.service.read_message(context, { ...input, includeHtml: false });
    expect(full).toMatchObject({ htmlOmitted: false, htmlTruncated: true, htmlRepresentation: 'wildduck_normalized' }); expect(text.htmlOmitted).toBe(true); expect(text.textTruncated).toBe(false);
    for (const key of ['html', 'htmlTruncated', 'htmlRepresentation']) { expect(text).not.toHaveProperty(key); }
    expect(text.version).toBe(full.version); expect(text.managedOperation).toEqual(full.managedOperation); expect(text.managedOperation?.verification).toBe('verified');
    expect(f.calls.filter(call => call.method === 'readMessage').every(call => JSON.stringify(call.args[1]) === JSON.stringify(input))).toBe(true);
});
test('an identical retry of a send settled by 0.6.x replays its outcome; a changed create conflicts without dispatch', async () => {
    const f = fixture(); const key = { accountId, clientIdHash: digest(context.clientId), operationId };
    // 0.6.x digested the parsed arguments without operation_id, with the key expected_version.
    const sendDigest = digest(JSON.stringify({ accountId, input: { expected_version: version, uid: 7 }, tool: 'send_draft' }));
    const receipt = { status: 'queued' as const, operationId, queueId: 'queue-from-0-6' };
    f.operations.records.set(keyOf(key), { key, intent: { ...key, tool: 'send_draft', payloadDigest: sendDigest, target: { mailboxId, uid: 7 }, expectedVersion: version }, ownerToken: 'owner-0-6', revision: 2, state: 'settled', receipt });
    expect(await f.service.send_draft(context, target)).toEqual(receipt);
    const createKey = { ...key, operationId: 'operation_create_0_6' };
    f.operations.records.set(keyOf(createKey), { key: createKey, intent: { ...createKey, tool: 'create_draft', payloadDigest: digest('0.6.x create payload') }, ownerToken: 'owner-0-6', revision: 1, state: 'dispatched' });
    expect(await f.service.create_draft(context, { ...content, operationId: createKey.operationId })).toEqual({ status: 'conflict', operationId: createKey.operationId, reason: 'operation_conflict' });
    expect(posts(f)).toHaveLength(0); expect(f.operations.calls).not.toContain('dispatch');
});
test('the in-memory store keeps no summary, and notes any the service offers it', async () => {
    // The fixture works as the real store does: a summary is dropped on write, and its being offered at all is recorded.
    const probe = fixture(); const claimed = await probe.operations.reserve({ accountId, clientIdHash: digest(context.clientId), operationId: 'probe_operation_001', tool: 'create_draft', payloadDigest: digest('probe') }, 'owner');
    if (claimed.kind !== 'acquired') { throw new Error('expected a claim'); }
    const failed: FailedReceipt & { summary: string } = { status: 'failed', operationId: 'probe_operation_001', reason: 'not_found', summary: 'Not done.' };
    await probe.operations.failPreflight(claimed.claim, failed);
    expect(probe.operations.summariesOffered).toEqual(['"Not done."']); expect(JSON.stringify([...probe.operations.records.values()])).not.toContain('summary');
    // The service itself never passes one: every kind of write outcome leaves the list empty.
    const settled = fixture(); await settled.service.send_draft(context, target); await settled.service.create_draft(context, { ...content, operationId: 'summary_create_001' });
    await settled.service.update_message_flags(context, { uid: 7, mailboxId, expectedVersion: version, operationId: 'summary_flags_001', flagged: true });
    const failing = fixture(); failing.behavior.preparationError = true; await failing.service.create_draft(context, { ...content, operationId: 'summary_failed_001' });
    const unknown = fixture(); unknown.behavior.postError = true; await unknown.service.send_draft(context, target);
    for (const f of [settled, failing, unknown]) { expect(f.operations.summariesOffered).toEqual([]); expect(JSON.stringify([...f.operations.records.values()])).not.toContain('"summary":'); expect(f.operations.records.size).toBeGreaterThan(0); }
});
const uploadId = '0b5e7c1a-3f2d-4c8b-9a6e-1d2c3b4a5f60';
const uploaded = { filename: 'report.pdf', contentType: 'application/pdf', uploadId, disposition: 'attachment' as const };
const copied = { source: { mailboxId, uid: 3, attachmentId: 'ATT1' }, disposition: 'attachment' as const };
test('an identical retry replays the stored result before any attachment is resolved again', async () => {
    const f = fixture(); const request = { ...content, operationId: 'upload_replay_001', attachments: [uploaded] };
    const first = await f.service.create_draft(context, request); expect(first.status).toBe('completed');
    expect(f.calls.filter(call => call.method === 'prepareCreate')).toHaveLength(1);
    // The upload is gone now (expired, or its store is down): resolving it again would fail, so any resolution is a test failure.
    f.writer.prepareCreate = async () => { throw new MailError('not_found'); };
    const calls = f.calls.length; const before = structuredClone([...f.operations.records.values()]);
    const replay = await f.service.create_draft(context, structuredClone(request));
    expect(replay).toEqual(first); expect(f.calls).toHaveLength(calls); expect(f.operations.calls.at(-1)).toBe('get'); expect(f.operations.calls).not.toContain('fail');
    expect([...f.operations.records.values()]).toEqual(before);
    // The same operationId with another upload is a different request, and is refused without looking at either upload.
    const other = await f.service.create_draft(context, { ...request, attachments: [{ ...uploaded, uploadId: '1b5e7c1a-3f2d-4c8b-9a6e-1d2c3b4a5f60' }] });
    expect(other).toEqual({ status: 'conflict', operationId: 'upload_replay_001', reason: 'operation_conflict' }); expect(f.calls).toHaveLength(calls);
});
test('an upload that cannot be resolved is a stored failure: a retry replays it and only a new operationId tries again', async () => {
    const f = fixture(); f.writer.prepareCreate = async () => { throw new MailError('not_found'); };
    const request = { ...content, operationId: 'upload_missing_001', attachments: [uploaded] };
    const failed = await f.service.create_draft(context, request);
    expect(failed).toEqual({ status: 'failed', operationId: 'upload_missing_001', reason: 'not_found' });
    f.writer.prepareCreate = async () => { throw new Error('must not be called again'); };
    expect(await f.service.create_draft(context, structuredClone(request))).toEqual(failed);
    expect(f.calls.filter(call => call.method === 'upload')).toHaveLength(0);
});
test('copying a stored attachment (source) needs mail:read on every draft tool, checked before any store or backend call', async () => {
    const draftOnly: MailContext = { ...context, scopes: ['mail:draft'] };
    const attempts = {
        create_draft: (f: ReturnType<typeof fixture>) => f.service.create_draft(draftOnly, { ...content, operationId: 'source_scope_001', attachments: [copied] }),
        create_reply_draft: (f: ReturnType<typeof fixture>) => f.service.create_reply_draft(draftOnly, { original: { mailboxId, uid: 1 }, mode: 'reply', body: { text: 'Hi' }, quoteOriginal: false, attachments: [copied], operationId: 'source_scope_002' }),
        update_draft: (f: ReturnType<typeof fixture>) => f.service.update_draft(draftOnly, { ...target, attachments: [copied] }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
        const f = fixture(); const outcome = await attempt(f).then(() => 'accepted', (error: unknown) => (error as MailError).code);
        expect({ name, outcome, backend: f.calls.length, store: f.operations.calls.length }).toEqual({ name, outcome: 'forbidden', backend: 0, store: 0 });
    }
    // With mail:read the same request reaches the backend; uploads and base64 attachments never need it.
    const f = fixture(); expect((await f.service.create_draft(context, { ...content, operationId: 'source_scope_003', attachments: [copied] })).status).toBe('completed');
    const inline = { filename: 'a.txt', contentType: 'text/plain', contentBase64: 'aGk=', disposition: 'attachment' as const };
    const g = fixture(); expect((await g.service.create_draft(draftOnly, { ...content, operationId: 'source_scope_004', attachments: [uploaded, inline] })).status).toBe('completed');
    const h = fixture(); expect((await h.service.update_draft(draftOnly, { ...target, attachments: [uploaded] })).status).toBe('completed');
});
test('the payload digest of a request with only base64 attachments is the one earlier versions stored', async () => {
    const f = fixture(); const request = { ...content, operationId: 'digest_stable_001', attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'aGk=', disposition: 'attachment' as const }] };
    await f.service.create_draft(context, request);
    const record = f.operations.records.get(keyOf({ accountId, clientIdHash: digest(context.clientId), operationId: 'digest_stable_001' }));
    const { operationId: _operationId, ...payload } = request;
    // The digest of the 0.7 payload shape, worked out here independently of the service.
    const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
    expect(record?.intent.payloadDigest).toBe(digest(stable({ accountId, tool: 'create_draft', input: payload })));
});

test('a hold ends only well after the Lambda timeout, and an uncertain send waits longer still', () => {
    const timeouts = [...readFileSync(new URL('../serverless.yml', import.meta.url), 'utf8').matchAll(/^\s*timeout:\s*(\d+)\s*$/gmu)].map(match => Number(match[1]));
    expect(timeouts).toEqual([60]);
    expect(HOLD_AGED_MS).toBeGreaterThanOrEqual(2 * Math.max(...timeouts) * 1000); expect(SEND_CHECK_AGED_MS).toBeGreaterThan(HOLD_AGED_MS);
});
test('holdAction: a record without reservedAt counts as aged, except an uncertain send, which is never checked', () => {
    const key = { accountId, clientIdHash: digest(context.clientId), operationId };
    const record = (tool: 'send_draft' | 'update_message_flags', state: 'reserved' | 'dispatched' | 'unknown', reservedAt?: number): MailOperationRecord => {
        const base = { key, intent: { ...key, payloadDigest: 'p'.repeat(43), tool, target: { mailboxId, uid: 7 }, expectedVersion: version }, ownerToken: 'owner-token-00000001', revision: 1, ...(reservedAt === undefined ? {} : { reservedAt }) };
        return state === 'unknown' ? { ...base, state: 'settled', receipt: { status: 'outcome_unknown', operationId, reason: 'dispatch_uncertain' } } : { ...base, state };
    };
    const now = 1_800_000_000_000; const at = now / 1000;
    for (const state of ['dispatched', 'unknown'] as const) {
        const from = state === 'unknown' ? 'unknown' : 'dispatched';
        expect(holdAction(record('send_draft', state), now)).toEqual({ act: 'none' });
        expect(holdAction(record('send_draft', state, at - SEND_CHECK_AGED_MS / 1000), now)).toEqual({ act: 'check_send', from });
        expect(holdAction(record('send_draft', state, at - SEND_CHECK_AGED_MS / 1000 + 1), now)).toEqual({ act: 'none' });
        expect(holdAction(record('update_message_flags', state), now)).toEqual({ act: 'release', from });
    }
    expect(holdAction(record('send_draft', 'reserved'), now)).toEqual({ act: 'fail', from: 'reserved' });
    expect(holdAction(record('update_message_flags', 'reserved'), now)).toEqual({ act: 'fail', from: 'reserved' });
});

describe('a hold ends at the next request that meets it (the real store over the DynamoDB model, an injected clock)', () => {
    const T0 = 1_800_000_000_000; const MINUTE = 60_000;
    /** The fake WildDuck over the real store; authored seeds the create record of draft uid 7, as fixture() does. */
    async function ledger(authored = true) {
        const client = new ModelSender(); const clock = { ms: T0 };
        const store = new DynamoMailOperationStore({ tableName: 'MailTable', client, retry: virtualRetry().retry, now: () => clock.ms });
        const f = fixture(false, { store, now: () => clock.ms });
        if (authored) {
            const claimed = await store.reserve(f.seedMarker, 'seed-owner-token-0001'); if (claimed.kind !== 'acquired') { throw new Error('seed'); }
            const draft = { ...f.behavior.snapshot.message };
            await store.complete(await store.markDispatched(claimed.claim), { status: 'completed', operationId: f.seedKey.operationId, draft, verified: true, proof: { accountId, ...draft, contentDigest: 'd'.repeat(64), sourceGrade: 'mcp_authored' } });
            f.behavior.marker = f.seedMarker;
        }
        return { ...f, client, store, advance: (ms: number) => { clock.ms += ms; } };
    }
    type Ledger = Awaited<ReturnType<typeof ledger>>;
    const own = (operation = operationId) => ({ accountId, clientIdHash: digest(context.clientId), operationId: operation });
    const recordOf = async (f: Ledger, operation = operationId) => { const record = await f.store.getOperation(own(operation)); if (!record) { throw new Error('missing record'); } return record; };
    const guardOn = (f: Ledger, uid = 7) => f.store.getGuard({ accountId, mailboxId, uid });
    const rows = (f: Ledger) => structuredClone([...f.client.records.entries()]);
    const mutations = (f: Ledger) => f.calls.filter(call => ['upload', 'delete', 'stamp', 'submit', 'move', 'flags'].includes(call.method)).map(call => call.method);
    const checks = (f: Ledger) => f.calls.filter(call => call.method === 'draftPresent' || call.method === 'findSentCopy').map(call => call.method);
    const line = (tool: string | undefined, trigger: 'retry' | 'lock_hit', from: string, action: string) => ({ event: 'mail_write_recovered', ...(tool === undefined ? {} : { tool }), trigger, from, action });
    /** The next call of this store method fails before it reaches DynamoDB. */
    const failOnce = (f: Ledger, name: 'markDispatched' | 'failPreflight' | 'markOutcomeUnknown') => { Object.defineProperty(f.store, name, { configurable: true, value: async () => { Reflect.deleteProperty(f.store, name); throw new MailError('temporarily_unavailable'); } }); };
    /** Replaces one store method for its next call; `inner` gets the store's own method. */
    const wrapOnce = <Name extends 'markDispatched' | 'failPreflight' | 'releaseGuard' | 'reserve' | 'getGuard'>(f: Ledger, name: Name, inner: (original: MailOperationStore[Name], ...args: Parameters<MailOperationStore[Name]>) => ReturnType<MailOperationStore[Name]>) => {
        const original = (f.store[name] as (...args: unknown[]) => unknown).bind(f.store) as MailOperationStore[Name];
        Object.defineProperty(f.store, name, { configurable: true, value: (...args: Parameters<MailOperationStore[Name]>) => { Reflect.deleteProperty(f.store, name); return inner(original, ...args); } });
    };
    const flagsOf = (operation = operationId, expectedVersion = version, uid = 7, box = mailboxId) => ({ uid, mailboxId: box, expectedVersion, operationId: operation, seen: true });
    const deleteOf = (operation: string, uid = 7, expectedVersion = version) => ({ uid, expectedVersion, operationId: operation });
    const unknownOf = (operation = operationId) => ({ status: 'outcome_unknown', operationId: operation, reason: 'dispatch_uncertain' } as const);
    const fenced = (operation: string) => ({ status: 'conflict', operationId: operation, reason: 'draft_fenced' } as const);
    const failedOf = (operation: string, reason: MailFailureCode): FailedReceipt => ({ status: 'failed', operationId: operation, reason });
    const changed = 'f'.repeat(43);
    /** A flags change of uid 7 left reserved: its dispatch mark and then its settlement failed (in_progress). */
    async function leftReserved(f: Ledger) { failOnce(f, 'markDispatched'); failOnce(f, 'failPreflight'); expect(await f.service.update_message_flags(context, flagsOf())).toEqual({ status: 'in_progress', operationId }); }
    /** A flags change of uid 7 that landed and then timed out: settled outcome_unknown, or still dispatched when that mark failed too. */
    async function leftUnknown(f: Ledger, dispatched = false, operation = operationId, expectedVersion = version) {
        const flags = f.writer.updateMessageFlags;
        f.writer.updateMessageFlags = async (...args) => { f.writer.updateMessageFlags = flags; await flags(...args); throw new MailError('upstream_timeout'); };
        if (dispatched) { failOnce(f, 'markOutcomeUnknown'); }
        expect(await f.service.update_message_flags(context, flagsOf(operation, expectedVersion))).toEqual(unknownOf(operation));
    }
    /** A send of uid 7 whose submit got no answer, after the draft was stamped with the send's marker. */
    async function leftUnsent(f: Ledger, dispatched = false) {
        f.behavior.postError = true; if (dispatched) { failOnce(f, 'markOutcomeUnknown'); }
        expect(await f.service.send_draft(context, target)).toEqual(unknownOf()); f.behavior.postError = false;
    }
    const logged = (run: (lines: Record<string, unknown>[]) => Promise<void>) => async () => { const warnings = captureWarnings(); try { await run(warnings.lines); } finally { warnings.restore(); } };
    const recovered = (lines: Record<string, unknown>[]) => lines.filter(item => item.event === 'mail_write_recovered');

    test('reserved: young, a retry is in_progress and a lock hit draft_fenced with nothing written; aged, either settles it failed', logged(async lines => {
        for (const trigger of ['retry', 'lock_hit'] as const) {
            const f = await ledger(); await leftReserved(f);
            f.advance(HOLD_AGED_MS - 1000); const before = rows(f); lines.length = 0;
            expect(await f.service.update_message_flags(context, flagsOf())).toEqual({ status: 'in_progress', operationId });
            expect(await f.service.update_message_flags(context, flagsOf('operation_test_002'))).toEqual(fenced('operation_test_002'));
            expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]);
            f.advance(1000);
            if (trigger === 'retry') { expect(await f.service.update_message_flags(context, flagsOf())).toEqual(failedOf(operationId, 'temporarily_unavailable')); expect(mutations(f)).toEqual([]); }
            else { expect((await f.service.update_message_flags(context, flagsOf('operation_test_003'))).status).toBe('completed'); expect(mutations(f)).toEqual(['flags']); }
            expect(await recordOf(f)).toMatchObject({ state: 'settled', receipt: failedOf(operationId, 'temporarily_unavailable') }); expect(await guardOn(f)).toBeUndefined();
            expect(recovered(lines)).toEqual([line('update_message_flags', trigger, 'reserved', 'failed')]);
            // Settled now: the same request only replays its failure.
            expect(await f.service.update_message_flags(context, flagsOf())).toEqual(failedOf(operationId, 'temporarily_unavailable'));
        }
    }));
    test('unknown or dispatched, not a send: young, it holds; aged, the guard is deleted, the outcome stays unknown, and the message is written as mail of no record', logged(async lines => {
        for (const dispatched of [false, true]) {
            for (const trigger of ['retry', 'lock_hit'] as const) {
                const f = await ledger(); await leftUnknown(f, dispatched); const state = dispatched ? 'dispatched' : 'settled';
                f.advance(HOLD_AGED_MS - 1000); const before = rows(f); lines.length = 0;
                expect(await f.service.update_message_flags(context, flagsOf())).toEqual(unknownOf());
                expect(await f.service.update_message_flags(context, flagsOf('operation_test_002', changed))).toEqual(fenced('operation_test_002'));
                expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]);
                f.advance(1000);
                if (trigger === 'retry') { expect(await f.service.update_message_flags(context, flagsOf())).toEqual(unknownOf()); expect(await guardOn(f)).toBeUndefined(); }
                const next = await f.service.update_message_flags(context, flagsOf('operation_test_003', changed));
                // The landed change left this operation's marker on the message: it now proves nothing, so the grade is observed.
                expect(next).toMatchObject({ status: 'completed', proof: { sourceGrade: 'observed' } });
                expect(await recordOf(f)).toMatchObject({ state, ...(dispatched ? {} : { receipt: unknownOf() }) }); expect(await guardOn(f)).toBeUndefined();
                expect(recovered(lines)).toEqual([line('update_message_flags', trigger, dispatched ? 'dispatched' : 'unknown', 'released')]);
                expect(mutations(f)).toEqual(['flags', 'flags']);
                // The retry still reports the unknown outcome; the guard is gone, so nothing more is done.
                lines.length = 0; expect(await f.service.update_message_flags(context, flagsOf())).toEqual(unknownOf()); expect(recovered(lines)).toEqual([]);
            }
        }
    }));
    test('an uncertain send younger than 15 minutes is never cleared or checked, even with its draft already gone', logged(async lines => {
        const f = await ledger(); await leftUnsent(f); f.behavior.present = false; f.gone.add(JSON.stringify({ mailboxId, uid: 7 }));
        f.advance(SEND_CHECK_AGED_MS - 1000); const before = rows(f); lines.length = 0;
        expect(await f.service.send_draft(context, target)).toEqual(unknownOf());
        expect(await f.service.delete_draft({ ...context, clientId: 'another-client' }, deleteOf('operation_test_002'))).toEqual(fenced('operation_test_002'));
        expect(checks(f)).toEqual([]); expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]); expect(mutations(f)).toEqual(['stamp', 'submit']);
        expect(await guardOn(f)).toMatchObject({ operation: own(), state: 'outcome_unknown' });
    }));
    const sentKey = { mailboxId: 'c'.repeat(24), uid: 501 };
    const deletedOf = (operation: string) => ({ status: 'completed' as const, operationId: operation, deleted: { mailboxId, uid: 7 } });
    // Sent is looked at first: WildDuck stores the Sent copy before it deletes the draft, so both can be there, and then the mail was sent.
    // deleted: what a delete_draft of the old draft gets once the send is settled (completed while it is still in Drafts, sent or not; WildDuck's not_found once gone).
    const sendCases: { name: string; present: boolean; sentCopy?: { message: typeof sentKey; queueId?: string }; result: MailOutput<'send_draft'>; action: string; looked: string[]; deleted: MailOutput<'delete_draft'> }[] = [
        { name: 'no Sent copy, draft still in Drafts', present: true, result: failedOf(operationId, 'upstream_timeout'), action: 'not_sent', looked: ['findSentCopy', 'draftPresent'], deleted: deletedOf('operation_test_002') },
        { name: 'Sent copy with a queue id', present: false, sentCopy: { message: sentKey, queueId: 'queue-501' }, result: { status: 'queued', operationId, sent: sentKey, queueId: 'queue-501' }, action: 'sent_found', looked: ['findSentCopy'], deleted: failedOf('operation_test_002', 'not_found') },
        { name: 'Sent copy without a queue id', present: false, sentCopy: { message: sentKey }, result: { status: 'queued', operationId, sent: sentKey }, action: 'sent_found', looked: ['findSentCopy'], deleted: failedOf('operation_test_002', 'not_found') },
        { name: 'Sent copy and the draft still in Drafts (its deletion after the Sent copy failed)', present: true, sentCopy: { message: sentKey, queueId: 'queue-501' }, result: { status: 'queued', operationId, sent: sentKey, queueId: 'queue-501' }, action: 'sent_found', looked: ['findSentCopy'], deleted: deletedOf('operation_test_002') },
        { name: 'neither', present: false, result: unknownOf(), action: 'released', looked: ['findSentCopy', 'draftPresent'], deleted: failedOf('operation_test_002', 'not_found') },
    ];
    for (const { name, present, sentCopy, result, action, looked, deleted } of sendCases) {
        test(`an uncertain send 15 minutes old, ${name}: settled from what WildDuck shows, on a retry or a lock hit, and its guard is deleted`, logged(async lines => {
            for (const [trigger, dispatched] of [['retry', false], ['lock_hit', false], ['retry', true]] as const) {
                const f = await ledger(); await leftUnsent(f, dispatched); f.behavior.present = present; f.behavior.sentCopy = sentCopy;
                if (!present) { f.gone.add(JSON.stringify({ mailboxId, uid: 7 })); }
                f.advance(SEND_CHECK_AGED_MS); lines.length = 0;
                if (trigger === 'retry') { expect(await f.service.send_draft(context, target)).toEqual(result); }
                else {
                    expect(await f.service.delete_draft(context, deleteOf('operation_test_002'))).toEqual(deleted);
                    expect(await f.service.send_draft(context, target)).toEqual(result);
                }
                expect(checks(f)).toEqual([...looked]); expect(await guardOn(f)).toBeUndefined();
                expect(await recordOf(f)).toMatchObject(action === 'released' ? { state: dispatched ? 'dispatched' : 'settled' } : { state: 'settled', receipt: result });
                expect(recovered(lines)).toEqual([line('send_draft', trigger, dispatched ? 'dispatched' : 'unknown', action)]);
                expect(f.calls.find(call => call.method === 'findSentCopy')?.args[1]).toEqual({ ...own(), payloadDigest: (await recordOf(f)).intent.payloadDigest, tool: 'send_draft' });
                expect(mutations(f)).toEqual(['stamp', 'submit', ...trigger === 'lock_hit' && deleted.status === 'completed' ? ['delete'] : []]);
                // Asked again, the same request makes no more lookups.
                expect(await f.service.send_draft(context, target)).toEqual(result); expect(checks(f)).toEqual([...looked]);
            }
        }));
    }
    test('an uncertain send whose WildDuck lookup fails is left exactly as it was, and the failure is logged once', logged(async lines => {
        for (const [present, sentCopy] of [[new MailError('upstream_timeout'), undefined], [false, new MailError('temporarily_unavailable')]] as const) {
            for (const trigger of ['retry', 'lock_hit'] as const) {
                const f = await ledger(); await leftUnsent(f); f.behavior.present = present; f.behavior.sentCopy = sentCopy;
                f.advance(SEND_CHECK_AGED_MS); const before = rows(f); lines.length = 0;
                expect(trigger === 'retry' ? await f.service.send_draft(context, target) : await f.service.delete_draft(context, deleteOf('operation_test_002'))).toEqual(trigger === 'retry' ? unknownOf() : fenced('operation_test_002'));
                expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]);
                expect(lines).toEqual([{ event: 'mail_write_unsettled', tool: 'send_draft', step: 'send_check', code: present instanceof Error ? 'upstream_timeout' : 'temporarily_unavailable' }]);
                expect(mutations(f)).toEqual(['stamp', 'submit']);
            }
        }
    }));
    test('the draft a sent mail left in Drafts can be deleted and nothing else; its Sent copy and any other message carrying the marker keep their treatment', logged(async () => {
        for (const withSent of [true, false]) {
            const f = await ledger();
            if (withSent) {
                // Settled by the send check: a Sent copy was found while the draft was still in Drafts.
                await leftUnsent(f); f.behavior.sentCopy = { message: sentKey, queueId: 'queue-501' }; f.advance(SEND_CHECK_AGED_MS);
                expect(await f.service.send_draft(context, target)).toEqual({ status: 'queued', operationId, sent: sentKey, queueId: 'queue-501' });
            } else {
                // A queued receipt without a sent key: the fake WildDuck reports no Sent copy and keeps the draft.
                expect(await f.service.send_draft(context, target)).toEqual({ status: 'queued', operationId, queueId: 'queue-1' });
            }
            const marker = f.behavior.marker; if (!marker) { throw new Error('missing send marker'); }
            const other = { mailboxId, uid: 50 }; f.messages.set(JSON.stringify(other), { ...f.behavior.snapshot, message: { ...other, version }, marker });
            if (withSent) { f.messages.set(JSON.stringify(sentKey), { ...f.behavior.snapshot, isDraft: false, message: { ...sentKey, version }, marker }); }
            const refused = (operation: string) => failedOf(operation, 'verification_failed');
            expect(await f.service.send_draft(context, { ...target, operationId: 'resend_operation_01' })).toEqual(refused('resend_operation_01'));
            expect(await f.service.update_draft(context, { ...target, operationId: 'reedit_operation_01', subject: 'x' })).toEqual(refused('reedit_operation_01'));
            expect(await f.service.update_message_flags(context, flagsOf('reflag_operation_01'))).toEqual(refused('reflag_operation_01'));
            expect(await f.service.move_message(context, { ...target, operationId: 'remove_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) })).toEqual(refused('remove_operation_01'));
            // Another message carrying the send's marker is not the send's own target: still refused, delete included.
            expect(await f.service.delete_draft(context, deleteOf('other_delete_op_0001', 50))).toEqual(refused('other_delete_op_0001'));
            if (withSent) {
                // The Sent copy keeps its verified marker (delete_draft only reaches Drafts): flagging it works as before, with no source.
                expect(await f.service.update_message_flags(context, flagsOf('sent_flags_op_000001', version, sentKey.uid, sentKey.mailboxId))).toMatchObject({ status: 'completed', proof: { sourceGrade: 'observed' } });
            }
            expect(await f.service.delete_draft(context, deleteOf('leftover_delete_op01'))).toEqual(deletedOf('leftover_delete_op01'));
            expect(mutations(f)).toEqual(['stamp', 'submit', ...withSent ? ['flags'] : [], 'delete']);
        }
    }));
    test('a send settled not sent leaves its stamped draft deletable and nothing else: it can no longer be sent, edited, moved or flagged here', logged(async () => {
        const f = await ledger(); await leftUnsent(f); f.advance(SEND_CHECK_AGED_MS);
        expect(await f.service.send_draft(context, target)).toEqual(failedOf(operationId, 'upstream_timeout'));
        expect(await f.service.send_draft(context, { ...target, operationId: 'resend_operation_01' })).toEqual(failedOf('resend_operation_01', 'verification_failed'));
        expect(await f.service.update_draft(context, { ...target, operationId: 'reedit_operation_01', subject: 'x' })).toEqual(failedOf('reedit_operation_01', 'verification_failed'));
        expect(await f.service.update_message_flags(context, flagsOf('reflag_operation_01'))).toEqual(failedOf('reflag_operation_01', 'verification_failed'));
        expect(await f.service.move_message(context, { ...target, operationId: 'remove_operation_01', mailboxId, destinationMailboxId: 'e'.repeat(24) })).toEqual(failedOf('remove_operation_01', 'verification_failed'));
        expect((await f.service.delete_draft(context, deleteOf('redelete_operation_1'))).status).toBe('completed');
        expect(mutations(f)).toEqual(['stamp', 'submit', 'delete']);
    }));
    test('an update that left both copies keeps the old one held for its deletion only, whatever its age', logged(async lines => {
        const f = await ledger(); f.behavior.deletionError = new MailError('forbidden');
        const request = { ...target, subject: 'change' }; const partial = await f.service.update_draft(context, request);
        expect(partial).toMatchObject({ status: 'partial', reason: 'original_deletion_failed' }); f.behavior.deletionError = undefined;
        f.advance(SEND_CHECK_AGED_MS * 4); const before = rows(f); lines.length = 0;
        expect(await f.service.update_draft(context, request)).toEqual(partial);
        expect(await f.service.update_message_flags(context, flagsOf('operation_test_002'))).toEqual(fenced('operation_test_002'));
        expect(await f.service.move_message(context, { ...target, operationId: 'operation_test_003', mailboxId, destinationMailboxId: 'e'.repeat(24) })).toEqual(fenced('operation_test_003'));
        expect(await f.service.update_draft(context, { ...request, operationId: 'operation_test_004' })).toEqual(fenced('operation_test_004'));
        expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]);
        expect(await f.service.delete_draft(context, deleteOf('operation_test_005'))).toEqual({ status: 'completed', operationId: 'operation_test_005', deleted: { mailboxId, uid: 7 } });
        expect(recovered(lines)).toEqual([line('update_draft', 'lock_hit', 'partial', 'released')]); expect(await guardOn(f)).toBeUndefined();
        expect(await f.service.update_draft(context, request)).toEqual(partial); expect(mutations(f)).toEqual(['upload', 'delete', 'delete']);
    }));
    /** An update_draft of uid 7 that saved its new copy (uid 8) and could not delete the original: both copies alive, the original held. */
    async function leftBothAlive(f: Ledger) {
        f.behavior.deletionError = new MailError('forbidden');
        expect(await f.service.update_draft(context, { ...target, subject: 'change' })).toMatchObject({ status: 'partial', reason: 'original_deletion_failed' }); f.behavior.deletionError = undefined;
    }
    test('a delete of the held original that would fail its own inspection never frees it: the error is answered, the guard stays and the original stays unsendable', logged(async lines => {
        const f = await ledger(); await leftBothAlive(f); f.advance(MINUTE); const before = rows(f); lines.length = 0;
        // A stale expectedVersion: version_conflict, as the delete's own preflight would answer; nothing is stored, so the same request may be retried.
        await expect(f.service.delete_draft(context, deleteOf('operation_test_005', 7, changed))).rejects.toThrow('version_conflict');
        expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]);
        expect(await guardOn(f)).toMatchObject({ operation: own(), state: 'retired' });
        expect(await f.service.send_draft(context, { ...target, operationId: 'operation_test_006' })).toEqual(fenced('operation_test_006'));
        // Not a draft any more: unsupported_draft, and the guard still holds.
        f.behavior.snapshot.isDraft = false;
        await expect(f.service.delete_draft(context, deleteOf('operation_test_007'))).rejects.toThrow('unsupported_draft');
        f.behavior.snapshot.isDraft = true;
        expect(rows(f)).toEqual(before); expect(mutations(f)).toEqual(['upload', 'delete']);
        // With the right version the hand-over goes through.
        expect(await f.service.delete_draft(context, deleteOf('operation_test_008'))).toEqual(deletedOf('operation_test_008'));
        expect(recovered(lines)).toEqual([line('update_draft', 'lock_hit', 'partial', 'released')]); expect(await guardOn(f)).toBeUndefined();
        expect(mutations(f)).toEqual(['upload', 'delete', 'delete']);
    }));
    test('a delete of a held original that is already gone ends the hold and gets the normal not-found answer', logged(async lines => {
        const f = await ledger(); await leftBothAlive(f); f.gone.add(JSON.stringify({ mailboxId, uid: 7 })); lines.length = 0;
        expect(await f.service.delete_draft(context, deleteOf('operation_test_005'))).toEqual(failedOf('operation_test_005', 'not_found'));
        expect(recovered(lines)).toEqual([line('update_draft', 'lock_hit', 'partial', 'released')]); expect(await guardOn(f)).toBeUndefined();
        expect(mutations(f)).toEqual(['upload', 'delete']);
    }));
    test('a guard row left by an older version over a finished operation is deleted at the first lock hit', logged(async lines => {
        for (const state of ['retired', 'queued'] as const) {
            const f = await ledger(); expect((await f.service.update_message_flags(context, flagsOf())).status).toBe('completed');
            const finished = await recordOf(f); const at = { accountId, mailboxId, uid: 7 };
            f.client.records.set(guardKey(at).pk, { ...guardKey(at), record: { key: at, operation: own(), ownerToken: finished.ownerToken, revision: finished.revision, state } });
            lines.length = 0;
            // Its own retry replays the settled result and leaves the row alone.
            expect((await f.service.update_message_flags(context, flagsOf())).status).toBe('completed'); expect(await guardOn(f)).toMatchObject({ state });
            expect((await f.service.update_message_flags(context, flagsOf('operation_test_002', changed))).status).toBe('completed');
            expect(recovered(lines)).toEqual([line('update_message_flags', 'lock_hit', 'leftover', 'released')]); expect(await guardOn(f)).toBeUndefined();
            expect(mutations(f)).toEqual(['flags', 'flags']);
        }
    }));
    test('a guard whose record has expired is deleted, and its message is written as mail of no record: movable and flaggable, never editable or sendable', logged(async lines => {
        const f = await ledger(); await leftUnknown(f); f.client.records.delete(opKey(own()).pk); lines.length = 0;
        expect(await f.service.send_draft(context, { ...target, expectedVersion: changed, operationId: 'operation_test_002' })).toEqual(failedOf('operation_test_002', 'unsupported_content'));
        expect(recovered(lines)).toEqual([line(undefined, 'lock_hit', 'expired', 'released')]); expect(await guardOn(f)).toBeUndefined();
        expect(await f.service.update_draft(context, { ...target, expectedVersion: changed, operationId: 'operation_test_003', subject: 'x' })).toEqual(failedOf('operation_test_003', 'unsupported_content'));
        expect(await f.service.update_message_flags(context, flagsOf('operation_test_004', changed))).toMatchObject({ status: 'completed', proof: { sourceGrade: 'observed' } });
        expect(await f.service.move_message(context, { ...target, expectedVersion: changed, operationId: 'operation_test_005', mailboxId, destinationMailboxId: 'e'.repeat(24) })).toMatchObject({ status: 'completed', proof: { sourceGrade: 'observed' } });
        expect(mutations(f)).toEqual(['flags', 'flags', 'move']); expect(f.calls.some(call => call.method === 'sourcecheck' && f.calls.indexOf(call) > 3)).toBe(false);
    }));
    const strip = (f: Ledger) => { const row = f.client.records.get(opKey(own()).pk); Reflect.deleteProperty(row?.record as object, 'reservedAt'); };
    test('records written without reservedAt count as aged: their hold ends at once', logged(async lines => {
        const reserved = await ledger(); await leftReserved(reserved); strip(reserved); lines.length = 0;
        expect(await reserved.service.update_message_flags(context, flagsOf())).toEqual(failedOf(operationId, 'temporarily_unavailable'));
        expect(recovered(lines)).toEqual([line('update_message_flags', 'retry', 'reserved', 'failed')]);
        const unknown = await ledger(); await leftUnknown(unknown); strip(unknown); lines.length = 0;
        expect((await unknown.service.update_message_flags(context, flagsOf('operation_test_002', changed))).status).toBe('completed');
        expect(recovered(lines)).toEqual([line('update_message_flags', 'lock_hit', 'unknown', 'released')]);
    }));
    test('an uncertain send written without reservedAt is never checked or released, however long it waits', logged(async lines => {
        for (const dispatched of [false, true]) {
            // An older version may still have been submitting it at the deploy: it holds until its items expire.
            const f = await ledger(); await leftUnsent(f, dispatched); strip(f); f.behavior.present = true; f.advance(SEND_CHECK_AGED_MS * 4); const before = rows(f); lines.length = 0;
            expect(await f.service.send_draft(context, target)).toEqual(unknownOf());
            expect(await f.service.delete_draft({ ...context, clientId: 'another-client' }, deleteOf('operation_test_002'))).toEqual(fenced('operation_test_002'));
            expect(await f.service.update_message_flags(context, flagsOf('operation_test_003'))).toEqual(fenced('operation_test_003'));
            expect(checks(f)).toEqual([]); expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]); expect(mutations(f)).toEqual(['stamp', 'submit']);
            expect(await guardOn(f)).toMatchObject({ operation: own(), state: dispatched ? 'dispatched' : 'outcome_unknown' });
        }
    }));
    test('race: the abandon wins, so the resumed first attempt fails at its dispatch mark and makes no WildDuck call', logged(async lines => {
        const f = await ledger(); let entered!: () => void; let resume!: () => void;
        const inside = new Promise<void>(resolve => { entered = resolve; }); const paused = new Promise<void>(resolve => { resume = resolve; });
        wrapOnce(f, 'markDispatched', async (original, claim) => { entered(); await paused; return original(claim); });
        const first = f.service.delete_draft(context, deleteOf(operationId)); await inside;
        f.advance(HOLD_AGED_MS);
        expect((await f.service.update_message_flags(context, flagsOf('operation_test_002'))).status).toBe('completed');
        resume(); expect(await first).toEqual(failedOf(operationId, 'temporarily_unavailable'));
        expect(mutations(f)).toEqual(['flags']); expect(recovered(lines)).toEqual([line('delete_draft', 'lock_hit', 'reserved', 'failed')]);
    }));
    test('race: the dispatch mark wins, so the abandon is refused and the new operation is answered draft_fenced', logged(async lines => {
        const f = await ledger(); let entered!: () => void; let resume!: () => void; let dispatching: Promise<unknown> = Promise.resolve();
        const inside = new Promise<void>(resolve => { entered = resolve; }); const paused = new Promise<void>(resolve => { resume = resolve; });
        wrapOnce(f, 'markDispatched', (original, claim) => { entered(); const marked = paused.then(() => original(claim)); dispatching = marked.catch(() => undefined); return marked; });
        const first = f.service.delete_draft(context, deleteOf(operationId)); await inside;
        f.advance(HOLD_AGED_MS);
        wrapOnce(f, 'failPreflight', async (original, claim, receipt) => { resume(); await dispatching; return original(claim, receipt); });
        expect(await f.service.update_message_flags(context, flagsOf('operation_test_002'))).toEqual(fenced('operation_test_002'));
        expect(await first).toEqual({ status: 'completed', operationId, deleted: { mailboxId, uid: 7 } });
        expect(mutations(f)).toEqual(['delete']); expect(recovered(lines)).toEqual([]);
    }));
    test('race: a retry of an old operation never deletes the guard a newer operation now holds on the same message', logged(async lines => {
        const f = await ledger(); await leftUnknown(f); f.advance(HOLD_AGED_MS);
        await leftUnknown(f, false, 'operation_test_002', changed);
        expect(await guardOn(f)).toMatchObject({ operation: own('operation_test_002'), state: 'outcome_unknown' });
        const before = rows(f); lines.length = 0;
        expect(await f.service.update_message_flags(context, flagsOf())).toEqual(unknownOf());
        expect(rows(f)).toEqual(before); expect(recovered(lines)).toEqual([]); expect(mutations(f)).toEqual(['flags', 'flags']);
    }));
    test('race: a stale retry never deletes the guard of a later incarnation of its own operationId on the same message', logged(async lines => {
        const f = await ledger(); await leftUnknown(f); f.advance(HOLD_AGED_MS); const stale = await recordOf(f); const at = { accountId, mailboxId, uid: 7 };
        // After the retry has read its record and before it reads the guard, both rows expire and the same request is reserved again.
        wrapOnce(f, 'getGuard', async (original, guard) => {
            f.client.records.delete(opKey(own()).pk); f.client.records.delete(guardKey(at).pk);
            expect((await f.store.reserve(stale.intent, 'fresh-owner-token-0001')).kind).toBe('acquired');
            return original(guard);
        });
        lines.length = 0;
        expect(await f.service.update_message_flags(context, flagsOf())).toEqual(unknownOf());
        expect(await guardOn(f)).toMatchObject({ operation: own(), ownerToken: 'fresh-owner-token-0001', revision: 0, state: 'reserved' });
        expect(await recordOf(f)).toMatchObject({ state: 'reserved', ownerToken: 'fresh-owner-token-0001', revision: 0 });
        expect(recovered(lines)).toEqual([]); expect(mutations(f)).toEqual(['flags']);
    }));
    test('a lock hit ends a hold only with time for a whole reservation after it, and reserves again only after the same admission check', logged(async lines => {
        const late = await ledger(); await leftUnknown(late); late.advance(HOLD_AGED_MS); const clock = steppedClock();
        try {
            const budget = () => { const deadline = performance.now() + 60_000; return () => Math.max(0, deadline - performance.now()); };
            // The hold is ended, then too little of the window is left to reserve: temporarily_unavailable, and the retry goes through.
            wrapOnce(late, 'releaseGuard', async (original, guard) => { const released = await original(guard); clock.state.skew += 31_000; return released; });
            await expect(withRequestBudget(budget(), () => late.service.update_message_flags(context, flagsOf('operation_test_002', changed)))).rejects.toThrow('temporarily_unavailable');
        } finally { clock.restore(); }
        expect(await guardOn(late)).toBeUndefined(); expect(recovered(lines)).toEqual([line('update_message_flags', 'lock_hit', 'unknown', 'released')]);
        expect((await late.service.update_message_flags(context, flagsOf('operation_test_002', changed))).status).toBe('completed');
        // A first reservation that leaves less than a whole reservation's time in the window: no recovery starts.
        const tight = await ledger(); await leftUnknown(tight); tight.advance(HOLD_AGED_MS); const before = rows(tight); lines.length = 0; const stepped = steppedClock();
        try {
            const deadline = performance.now() + 60_000;
            wrapOnce(tight, 'reserve', async (original, intent, owner) => { const result = await original(intent, owner); stepped.state.skew += 31_000; return result; });
            expect(await withRequestBudget(() => Math.max(0, deadline - performance.now()), () => tight.service.update_message_flags(context, flagsOf('operation_test_002', changed)))).toEqual(fenced('operation_test_002'));
        } finally { stepped.restore(); }
        expect(rows(tight)).toEqual(before); expect(recovered(lines)).toEqual([]); expect(mutations(tight)).toEqual(['flags']);
    }));
    test('a moved message whose move stayed unknown can, once that is aged, be flagged, moved and deleted in its new mailbox', logged(async () => {
        const f = await ledger(); const archive = 'e'.repeat(24); const move = f.writer.moveMessage;
        f.writer.moveMessage = async (...args) => { f.writer.moveMessage = move; await move(...args); throw new MailError('upstream_timeout'); };
        expect(await f.service.move_message(context, { ...target, mailboxId, destinationMailboxId: archive })).toEqual(unknownOf());
        f.advance(MINUTE);
        expect(await f.service.update_message_flags(context, flagsOf('copy_flags_early_01', version, 9, archive))).toEqual(failedOf('copy_flags_early_01', 'verification_failed'));
        f.advance(HOLD_AGED_MS);
        expect(await f.service.update_message_flags(context, flagsOf('copy_flags_operation1', version, 9, archive))).toMatchObject({ status: 'completed', proof: { sourceGrade: 'observed' } });
        expect(await f.service.move_message(context, { uid: 9, mailboxId: archive, expectedVersion: changed, operationId: 'copy_move_operation_1', destinationMailboxId: mailboxId })).toMatchObject({ status: 'completed', message: { mailboxId, uid: 9 } });
        expect((await f.service.delete_draft(context, deleteOf('copy_delete_operation', 9))).status).toBe('completed');
        expect(mutations(f)).toEqual(['move', 'flags', 'move', 'delete']);
    }));
    test('a message carrying the marker of an unsettled send refuses every change, young or aged', logged(async () => {
        const f = await ledger(); await leftUnsent(f); const copy = { mailboxId, uid: 50 };
        const marker = f.behavior.marker; if (!marker) { throw new Error('missing send marker'); }
        f.messages.set(JSON.stringify(copy), { ...f.behavior.snapshot, message: { ...copy, version }, marker });
        for (const [step, age] of [['young', 10 * MINUTE], ['aged', 20 * MINUTE]] as const) {
            f.advance(age);
            expect(await f.service.update_message_flags(context, flagsOf(`${step}_flags_operation`, version, 50))).toEqual(failedOf(`${step}_flags_operation`, 'verification_failed'));
            expect(await f.service.move_message(context, { uid: 50, mailboxId, expectedVersion: version, operationId: `${step}_move_operation_`, destinationMailboxId: 'e'.repeat(24) })).toEqual(failedOf(`${step}_move_operation_`, 'verification_failed'));
            expect(await f.service.delete_draft(context, deleteOf(`${step}_delete_operation`, 50))).toEqual(failedOf(`${step}_delete_operation`, 'verification_failed'));
        }
        expect(mutations(f)).toEqual(['stamp', 'submit']);
    }));
    test('a copy that never became active can be deleted, and nothing else', logged(async () => {
        const f = await ledger(); f.behavior.originalChanged = true;
        expect(await f.service.update_draft(context, { ...target, subject: 'change' })).toMatchObject({ status: 'partial', reason: 'original_version_changed' });
        f.advance(SEND_CHECK_AGED_MS);
        for (const [tool, request] of [['update_message_flags', flagsOf('candidate_flags_op_1', version, 8)], ['move_message', { uid: 8, mailboxId, expectedVersion: version, operationId: 'candidate_move_op_01', destinationMailboxId: 'e'.repeat(24) }], ['send_draft', deleteOf('candidate_send_op_01', 8)], ['update_draft', { ...deleteOf('candidate_edit_op_01', 8), subject: 'x' }]] as const) {
            expect(await f.service[tool](context, request as never)).toEqual(failedOf(request.operationId, 'verification_failed'));
        }
        expect((await f.service.delete_draft(context, deleteOf('candidate_delete_op1', 8))).status).toBe('completed');
        expect(mutations(f)).toEqual(['upload', 'delete']);
    }));
    test('a recovery line carries fixed fields and the request ID, never an id or account data', logged(async lines => {
        const f = await ledger(); await leftUnknown(f); f.advance(HOLD_AGED_MS); lines.length = 0;
        await withRequestId('request-id-7', () => f.service.update_message_flags(context, flagsOf('operation_test_002', changed)));
        expect(recovered(lines)).toEqual([{ ...line('update_message_flags', 'lock_hit', 'unknown', 'released'), requestId: 'request-id-7' }]);
        expect(JSON.stringify(lines)).not.toMatch(/operation_test|aaaaaaaa|bbbbbbbb|client-one/u);
    }));
});
