import { expect, test } from 'bun:test';
import { isEmailValid } from '@hapi/address';
import { MailError } from '../src/mail/contracts';
import { McpServer, WebStandardStreamableHTTPServerTransport, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { mailInputSchemas, mailOutputSchemas, draftContentSchema, inputAddressSchema, outputAddressSchema, operationIdSchema, versionSchema, MAX_DRAFT_TEXT_BYTES, MAX_SUBJECT_BYTES, MAX_ATTACHMENT_BYTES, MAX_HTML_BYTES } from '../src/mail/schemas';
const mailboxId = 'a'.repeat(24), otherMailbox = 'b'.repeat(24);
const operation_id = '061a78f9-14bd-4bb9-849d-5f6a3f304612', expected_version = 'v'.repeat(43);
const target = { uid: 1, expected_version, operation_id };
const body = { text: 'First line\nSecond line\r\nThird line', html: null };
const draft = { to: [{ address: 'recipient@example.invalid', name: 'Recipient' }], subject: 'Hello', body };
const attachment = { filename: 'hello.txt', contentType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') };
const ref = { mailboxId, uid: 2, version: expected_version };
const proof = { ...ref, accountId: mailboxId, contentDigest: 'a'.repeat(64), sourceGrade: 'mcp_authored' as const };

test('strict tools expose bounded pagination without hidden filters', () => {
    expect(Object.keys(mailInputSchemas)).toEqual(['list_mailboxes', 'list_messages', 'search_messages', 'read_message', 'get_thread', 'read_messages', 'read_attachment', 'get_attachment_download', 'create_draft', 'create_reply_draft', 'update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags']);
    expect(mailInputSchemas.list_mailboxes.parse({})).toEqual({});
    expect(mailInputSchemas.list_mailboxes.safeParse({ limit: 20 }).success).toBe(false);
    expect(mailInputSchemas.list_messages.parse({ mailboxId })).toEqual({ mailboxId, limit: 20 });
    for (const limit of [0, 51, 1.5, '20', NaN, Infinity]) { expect(mailInputSchemas.list_messages.safeParse({ mailboxId, limit }).success).toBe(false); }
    expect(mailInputSchemas.list_messages.safeParse({ mailboxId, limit: 50, next: 'x'.repeat(1024) }).success).toBe(true);
    for (const extra of [{ next: 'x'.repeat(1025) }, { next: '  ' }, { next: 'next', previous: 'previous' }, { unexpected: true }]) { expect(mailInputSchemas.list_messages.safeParse({ mailboxId, ...extra }).success).toBe(false); }
});
test('targets are explicit and downloads accept attachment IDs, never arbitrary paths or URLs', () => {
    for (const value of [{ uid: 1 }, { mailboxId, uid: 0 }, { mailboxId, uid: 4294967296 }, { mailboxId, uid: 1.1 }, { mailboxId: 'G'.repeat(24), uid: 1 }]) { expect(mailInputSchemas.read_message.safeParse(value).success).toBe(false); }
    expect(mailInputSchemas.read_message.safeParse({ mailboxId, uid: 1, markAsSeen: true }).success).toBe(false);
    expect(mailInputSchemas.read_attachment.safeParse({ mailboxId, uid: 1, attachmentId: 'ATT001' }).success).toBe(true);
    for (const attachmentId of ['att1', 'ATT', '../ATT1', 'https://example.invalid/file', 'ATT' + '1'.repeat(62)]) { expect(mailInputSchemas.read_attachment.safeParse({ mailboxId, uid: 1, attachmentId }).success).toBe(false); }
});
test('search requires a meaningful filter, preserves false, and rejects rather than truncates 256 characters', () => {
    for (const value of [{}, { limit: 20 }, { next: 'cursor' }, { from: '' }, { to: ' \t ' }, { subject: ' ' }, { text: '\n' }, { query: 'raw expression' }]) { expect(mailInputSchemas.search_messages.safeParse(value).success).toBe(false); }
    for (const value of [{ seen: false }, { flagged: false }, { hasAttachments: false }, { mailboxId }]) { expect(mailInputSchemas.search_messages.safeParse(value).success).toBe(true); }
    expect(mailInputSchemas.search_messages.parse({ text: 'é'.repeat(255) }).text).toBe('é'.repeat(255));
    for (const value of [{ text: 'x'.repeat(256) }, { from: 'a'.repeat(321) }, { subject: 'é'.repeat(1025) }, { seen: false, next: 'a', previous: 'b' }]) { expect(mailInputSchemas.search_messages.safeParse(value).success).toBe(false); }
    expect(mailInputSchemas.search_messages.safeParse({ receivedSince: '2026-10-26T01:00:00+02:00', receivedUntil: '2026-10-25T23:30:00Z' }).success).toBe(true);
    for (const value of [{ receivedSince: '2026-02-30T12:00:00Z' }, { receivedSince: '2026-10-26' }, { receivedSince: '2026-10-26T12:00:00' }, { receivedSince: '2026-10-26T00:00:01Z', receivedUntil: '2026-10-26T00:00:00Z' }]) { expect(mailInputSchemas.search_messages.safeParse(value).success).toBe(false); }
});
test('create uses paired rich body; patches preserve omitted fields and explicitly allow recipient clearing', () => {
    expect(mailInputSchemas.create_draft.parse({ ...draft, operation_id })).toEqual({ ...draft, cc: [], bcc: [], attachments: [], operation_id });
    expect(mailInputSchemas.create_draft.safeParse({ ...draft, operation_id, from: { address: 'owner@example.invalid' }, replyTo: [] }).success).toBe(true);
    expect(mailInputSchemas.update_draft.parse({ ...target, subject: 'Changed' })).toEqual({ ...target, subject: 'Changed' });
    expect(mailInputSchemas.update_draft.parse({ ...target, to: [] })).toEqual({ ...target, to: [] });
    for (const patch of [{}, { attachments: [] }, { deleteAttachmentIds: [] }, { body: { text: '' } }, { body: { html: '' } }, { text: 'legacy replacement' }, { deleteAttachmentIds: ['ATT1', 'ATT1'] }]) { expect(mailInputSchemas.update_draft.safeParse({ ...target, ...patch }).success).toBe(false); }
    expect(mailInputSchemas.update_draft.safeParse({ ...target, body: { text: '', html: '<b>new</b>' }, deleteAttachmentIds: ['ATT1'] }).success).toBe(true);
    for (const fields of [{ raw: 'MIME' }, { mailboxId }, { storageId: 'file' }, { html: '<b>legacy</b>' }]) { expect(mailInputSchemas.create_draft.safeParse({ ...draft, operation_id, ...fields }).success).toBe(false); }
});
test('outbound headers reject injections and UTF-8 overflow while paired bodies preserve newlines', () => {
    for (const injection of ['hello\rX-Forged: yes', 'hello\nX-Forged: yes', 'hello\0suffix']) {
        expect(draftContentSchema.safeParse({ ...draft, subject: injection }).success).toBe(false);
        expect(inputAddressSchema.safeParse({ address: 'recipient@example.invalid', name: injection }).success).toBe(false);
    }
    for (const address of ['not an email', 'a@example.invalid\r\nBcc: other@example.invalid', '', 'name <address@example.invalid>']) { expect(inputAddressSchema.safeParse({ address }).success).toBe(false); }
    expect(draftContentSchema.safeParse({ ...draft, subject: 'é'.repeat(MAX_SUBJECT_BYTES / 2), body: { text: 'é'.repeat(MAX_DRAFT_TEXT_BYTES / 2), html: 'x'.repeat(MAX_HTML_BYTES) } }).success).toBe(true);
    for (const fields of [{ subject: 'é'.repeat(MAX_SUBJECT_BYTES / 2 + 1) }, { body: { text: 'é'.repeat(MAX_DRAFT_TEXT_BYTES / 2 + 1), html: null } }, { body: { text: '', html: 'é'.repeat(MAX_HTML_BYTES / 2 + 1) } }]) { expect(draftContentSchema.safeParse({ ...draft, ...fields }).success).toBe(false); }
    const many = Array.from({ length: 50 }, () => ({ address: 'recipient@example.invalid' }));
    expect(draftContentSchema.safeParse({ ...draft, to: many, cc: many }).success).toBe(true);
    expect(draftContentSchema.safeParse({ ...draft, to: many, cc: many, bcc: [many[0]] }).success).toBe(false);
});
test('attachment additions require canonical bounded base64, safe names/types and unique inline CIDs', () => {
    const parse = (attachments: unknown[]) => mailInputSchemas.create_draft.safeParse({ ...draft, operation_id, attachments });
    expect(parse([attachment]).success).toBe(true);
    for (const fields of [{ filename: '../file\nInjected' }, { filename: 'é'.repeat(128) }, { contentType: 'text/plain; charset=utf-8' }, { contentBase64: 'aGVsbG8' }, { contentBase64: 'aGVsbG8=\n' }, { contentBase64: 'Zh==' }, { disposition: 'inline' }, { url: 'https://example.invalid' }]) { expect(parse([{ ...attachment, ...fields }]).success).toBe(false); }
    expect(parse([{ ...attachment, disposition: 'inline', cid: 'part@example.invalid' }]).success).toBe(true);
    expect(parse([{ ...attachment, cid: 'same' }, { ...attachment, cid: 'same' }]).success).toBe(false);
    const max = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
    expect(parse([{ ...attachment, contentBase64: max }]).success).toBe(true);
    expect(parse([{ ...attachment, contentBase64: max }, attachment]).success).toBe(false);
    expect(parse([{ ...attachment, contentBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }]).success).toBe(false);
});
test('IMAP keywords and labels stay distinct and unsafe/contradictory mutations fail explicitly', () => {
    const parse = (fields: object) => mailInputSchemas.update_message_flags.safeParse({ ...target, mailboxId, ...fields });
    expect(parse({ addFlags: ['Custom', '\\Answered', '$Forwarded'], addLabels: ['My Label'], seen: false }).success).toBe(true);
    expect(parse({ removeFlags: ['historical keyword with spaces', 'x'.repeat(4096)], labels: [] }).success).toBe(true);
    expect(parse({ flagged: false }).success).toBe(true);
    expect(parse({ labels: Array.from({ length: 5000 }, (_, i) => `label${i}`) }).success).toBe(true);
    for (const fields of [{}, { addFlags: [] }, { addFlags: ['\\Draft'] }, { removeFlags: ['\\Deleted'] }, { addFlags: ['\\Recent'] }, { addFlags: ['$wdlabel$secret'] }, { removeFlags: ['$WDLABEL$secret'] }, { addFlags: ['bad flag'] }, { addFlags: ['bad]flag'] }, { removeFlags: ['bad\nflag'] }, { labels: ['$system'] }, { labels: ['\\Drafts'] }, { addFlags: ['\\SEEN'], removeFlags: ['\\seen'] }, { seen: false, addFlags: ['\\Seen'] }, { flagged: true, removeFlags: ['\\Flagged'] }, { labels: [], addLabels: [] }, { addLabels: ['same'], removeLabels: ['same'] }, { addFlags: ['\\Seen', '\\seen'] }, { labels: ['same', 'same'] }]) { expect(parse(fields).success).toBe(false); }
    expect(parse({ addFlags: ['custom[valid', 'custom}valid'] }).success).toBe(true);
    expect(mailInputSchemas.move_message.safeParse({ ...target, mailboxId, destinationMailboxId: mailboxId }).success).toBe(false);
    expect(mailInputSchemas.move_message.safeParse({ ...target, mailboxId, destinationMailboxId: otherMailbox }).success).toBe(true);
});
test('operation IDs and versions are strict; canonical draft writes cannot accept caller mailboxes', () => {
    expect(operationIdSchema.safeParse(operation_id).success).toBe(true);
    for (const value of ['short', 'x'.repeat(129), 'a'.repeat(15) + '/', 'x'.repeat(15) + '\n', '💌'.repeat(16)]) { expect(operationIdSchema.safeParse(value).success).toBe(false); }
    for (const value of ['x'.repeat(42), 'x'.repeat(44), 'x'.repeat(42) + '+']) { expect(versionSchema.safeParse(value).success).toBe(false); }
    for (const name of ['delete_draft', 'send_draft'] as const) { expect(mailInputSchemas[name].safeParse(target).success).toBe(true); expect(mailInputSchemas[name].safeParse({ mailboxId, ...target }).success).toBe(false); }
});
test('read data retains full flags/labels, separate dates, HTML data, explicit truncation and honest sizes', () => {
    expect(outputAddressSchema.safeParse({ address: 'malformed sender <>', name: 'Untrusted\nMIME' }).success).toBe(true);
    const value = { mailboxId, uid: 1, subject: 's'.repeat(4096), snippet: null, threadId: null, from: [{ address: 'malformed sender <>' }], to: [], date: null, receivedAt: '2026-10-26T00:00:00Z', flags: { seen: false, flagged: false, draft: false, answered: false, deleted: false, forwarded: true }, imapFlags: ['$Forwarded', 'legacy keyword'], labels: ['My Label'], hasAttachments: true, replyTo: [], cc: [], bcc: [], messageId: null, references: [], text: 'partial text', textTruncated: true, html: ['<script>untrusted data</script>'], htmlTruncated: false, htmlRepresentation: 'wildduck_normalized' as const, attachments: [{ attachmentId: 'ATT1', filename: '<untrusted>.txt', contentType: 'text/plain', size: 1024, sizeIsApproximate: true, inline: false, cid: null }], version: expected_version };
    expect(mailOutputSchemas.read_message.parse(value)).toEqual(value);
    for (const fields of [{ receivedAt: undefined }, { htmlTruncated: undefined }, { rawHeaders: 'headers' }, { attachments: [{ ...value.attachments[0], content: 'bytes' }] }, { attachments: [{ ...value.attachments[0], size: null }] }]) { expect(mailOutputSchemas.read_message.safeParse({ ...value, ...fields }).success).toBe(false); }
    const download = { mailboxId, uid: 1, attachmentId: 'ATT1', filename: null, contentType: 'application/octet-stream', size: 5, resourceUri: 'wildduck://attachment/ATT1' };
    expect(mailOutputSchemas.read_attachment.safeParse(download).success).toBe(true);
    expect(mailOutputSchemas.read_attachment.safeParse({ ...download, blob: 'aGVsbG8=' }).success).toBe(false);
});
test('receipts bind verified targets and distinguish stale, partial and unknown outcomes from success', () => {
    expect(mailOutputSchemas.create_draft.safeParse({ status: 'completed', operation_id, draft: ref, verified: true, proof }).success).toBe(true);
    expect(mailOutputSchemas.create_draft.safeParse({ status: 'completed', operation_id, draft: ref, verified: true, proof: { ...proof, uid: 99 } }).success).toBe(false);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'completed', operation_id, draft: ref, verified: true, proof, previousDeleted: false }).success).toBe(false);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'partial', operation_id, candidate: ref, candidateVerified: true, proof, reason: 'original_version_changed', originalDeletion: 'not_attempted' }).success).toBe(true);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'partial', operation_id, candidate: ref, candidateVerified: true, proof, reason: 'original_deletion_unconfirmed', originalDeletion: 'failed' }).success).toBe(false);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'partial', operation_id, candidate: ref, candidateVerified: true, proof, reason: 'original_verification_failed', originalDeletion: 'not_attempted' }).success).toBe(true);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'partial', operation_id, candidate: ref, candidateVerified: true, proof, reason: 'original_verification_failed', originalDeletion: 'unconfirmed' }).success).toBe(false);
    const partial = { status: 'partial', operation_id, candidate: { mailboxId, uid: 2 }, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' };
    expect(mailOutputSchemas.create_draft.safeParse(partial).success).toBe(true);
    expect(mailOutputSchemas.create_draft.safeParse({ ...partial, proof }).success).toBe(false);
    expect(mailOutputSchemas.update_message_flags.safeParse({ status: 'completed', operation_id, message: ref, verified: true, proof }).success).toBe(true);
    expect(mailOutputSchemas.update_message_flags.safeParse({ status: 'completed', operation_id, message: ref, verified: true, proof, labels: [] }).success).toBe(false);
    expect(mailOutputSchemas.send_draft.safeParse({ status: 'queued', operation_id, queueId: 'queue-123', sent: { mailboxId, uid: 2 } }).success).toBe(true);
    for (const value of [{ status: 'delivered', operation_id, queueId: 'queue-123' }, { status: 'queued', operation_id, queueId: '' }, { status: 'outcome_unknown', operation_id, reason: 'dispatch_uncertain', retryable: true }]) { expect(mailOutputSchemas.send_draft.safeParse(value).success).toBe(false); }
});
test('native Zod exposes all schemas and validation directly through installed MCP SDK', async () => {
    const standard: StandardSchemaWithJSON = mailInputSchemas.list_messages;
    const result = await standard['~standard'].validate({ mailboxId }); expect('value' in result && result.value).toEqual({ mailboxId, limit: 20 });
    for (const schema of [...Object.values(mailInputSchemas), ...Object.values(mailOutputSchemas)]) { expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toBeObject(); }
    expect(mailInputSchemas.search_messages['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({ properties: { text: { maxLength: 255 } } });
    const request = async (rpc: object) => {
    const server = new McpServer({ name: 'schema-contract-test', version: '1' });
    server.registerTool('list_messages', { inputSchema: mailInputSchemas.list_messages, outputSchema: mailOutputSchemas.list_messages }, async () => ({ content: [{ type: 'text', text: '[]' }], structuredContent: { messages: [] } }));
    server.registerTool('send_draft', { inputSchema: mailInputSchemas.send_draft, outputSchema: mailOutputSchemas.send_draft }, async () => ({ content: [{ type: 'text', text: 'Synthetic queue receipt.' }], structuredContent: { status: 'queued', operation_id, queueId: 'synthetic' } }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); await server.connect(transport);
    try { return await transport.handleRequest(new Request('https://service.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify(rpc) })); } finally { await server.close(); }
    };
    {
        const listed = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); const list = await listed.json();
        expect(list.result.tools[0].inputSchema.properties.limit.maximum).toBe(50); expect(list.result.tools[0].inputSchema.additionalProperties).toBe(false);
        const response = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_draft', arguments: target } });
        expect(response.status).toBe(200); expect((await response.json()).result.structuredContent).toEqual({ status: 'queued', operation_id, queueId: 'synthetic' });
    }
});
test('MailError accepts only sanitized codes without retaining raw causes or details', () => {
    const error = Reflect.construct(MailError, ['source_integrity_unavailable', { cause: 'private-upstream-response', token: 'private-upstream-token' }]) as MailError;
    expect(MailError.length).toBe(1); expect(error).toBeInstanceOf(Error); expect(error.code).toBe('source_integrity_unavailable'); expect(error.message).toBe(error.code);
    expect(Object.keys(error).sort()).toEqual(['code', 'name']); expect(error.cause).toBeUndefined(); expect(JSON.stringify(error)).not.toContain('private');
});

test('recipient validation exactly matches pinned existing API predicate and never drops invalid entries', () => {
    const addresses = ['a@example.invalid', 'a@example.c', 'é@example.invalid', 'a@éxample.invalid', 'a..b@example.invalid', 'a@b', 'x'.repeat(65) + '@example.invalid', 'a@' + 'x'.repeat(64) + '.invalid', 'a@example.invalid\r\nBcc: injected@example.invalid'];
    for (const address of addresses) { expect(inputAddressSchema.safeParse({ address }).success).toBe(isEmailValid(address, { tlds: false } as unknown as Parameters<typeof isEmailValid>[1])); }
    const invalid = 'x'.repeat(65) + '@example.invalid';
    for (const field of ['to', 'cc', 'bcc', 'replyTo'] as const) {
        const recipients = [{ address: 'valid@example.invalid' }, { address: invalid }];
        expect(mailInputSchemas.create_draft.safeParse({ ...draft, operation_id, [field]: recipients }).success).toBe(false);
        expect(mailInputSchemas.update_draft.safeParse({ ...target, [field]: recipients }).success).toBe(false);
    }
    expect(mailInputSchemas.create_draft.parse({ ...draft, operation_id }).to).toEqual(draft.to);
});
test('activation proof requires an explicit source grade; observed source cannot create authored drafts', () => {
    const complete = { status: 'completed', operation_id, draft: ref, verified: true, proof };
    const { sourceGrade: _grade, ...missingGrade } = proof;
    expect(mailOutputSchemas.create_draft.safeParse({ ...complete, proof: missingGrade }).success).toBe(false);
    expect(mailOutputSchemas.create_draft.safeParse({ ...complete, proof: { ...proof, sourceGrade: 'observed' } }).success).toBe(false);
    expect(mailOutputSchemas.update_draft.safeParse({ ...complete, previousDeleted: true, proof: { ...proof, sourceGrade: 'observed' } }).success).toBe(false);
    expect(mailOutputSchemas.update_draft.safeParse({ status: 'partial', operation_id, candidate: ref, candidateVerified: true, proof: { ...proof, sourceGrade: 'observed' }, reason: 'original_deletion_failed', originalDeletion: 'failed' }).success).toBe(false);
    for (const name of ['move_message', 'update_message_flags'] as const) {
        expect(mailOutputSchemas[name].safeParse({ status: 'completed', operation_id, message: ref, verified: true, proof: { ...proof, sourceGrade: 'observed' } }).success).toBe(true);
    }
    expect(mailInputSchemas.update_draft.safeParse({ ...target, subject: 'Change', source: { grade: 'mcp_authored', accountId: mailboxId, mailboxId, uid: 1, contentDigest: proof.contentDigest } }).success).toBe(false);
});
