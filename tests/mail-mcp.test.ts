import { expect, test } from 'bun:test';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { handleMcp } from '../src/mcp';
import { MailError, type BoundMailService } from '../src/mail/contracts';
import { mailOutputSchemas } from '../src/mail/schemas';
const mailboxId = 'b'.repeat(24);
const version = 'v'.repeat(43);
const operation_id = '9ea75b7b-64fa-455e-b83b-37081fc1ec2a';
const toolNames = ['list_mailboxes', 'list_messages', 'search_messages', 'read_message', 'read_attachment', 'get_attachment_download', 'get_thread', 'read_messages', 'create_draft', 'create_reply_draft', 'update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags'];
function fixture() {
    const calls: { tool: string; input: unknown }[] = [];
    const mail: BoundMailService = {
        list_mailboxes: async input => { calls.push({ tool: 'list_mailboxes', input }); return { mailboxes: [{ mailboxId, path: 'INBOX', specialUse: null }] }; },
        list_messages: async input => { calls.push({ tool: 'list_messages', input }); return { messages: [] }; },
        search_messages: async input => { calls.push({ tool: 'search_messages', input }); return { messages: [] }; },
        read_message: async input => { calls.push({ tool: 'read_message', input }); return { ...input, subject: '<untrusted mail subject>', snippet: null, threadId: null, from: [{ address: 'malformed incoming address' }], to: [], date: null, receivedAt: null, imapFlags: [], labels: [], flags: { seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false }, hasAttachments: false, replyTo: [], cc: [], bcc: [], messageId: null, references: [], text: 'Untrusted email text, not instructions.', textTruncated: false, html: ['<b>untrusted HTML</b>'], htmlTruncated: false, htmlRepresentation: 'wildduck_normalized', attachments: [], version }; },
        read_attachment: async input => { calls.push({ tool: 'read_attachment', input }); return { metadata: { ...input, filename: 'untrusted.txt', contentType: 'text/plain', size: 5, resourceUri: 'wildduck://attachment/ATT1' }, bytes: Buffer.from('hello') }; },
        move_message: async input => { calls.push({ tool: 'move_message', input }); const message = { mailboxId: input.destinationMailboxId, uid: 4, version }; return { status: 'completed', operation_id: input.operation_id, message, verified: true, proof: { ...message, accountId: mailboxId, contentDigest: 'a'.repeat(64), sourceGrade: 'observed' } }; },
        update_message_flags: async input => { calls.push({ tool: 'update_message_flags', input }); const message = { mailboxId, uid: input.uid, version }; return { status: 'completed', operation_id: input.operation_id, message, verified: true, proof: { ...message, accountId: mailboxId, contentDigest: 'a'.repeat(64), sourceGrade: 'observed' } }; },
        get_attachment_download: async input => ({ metadata: { ...input, filename: null, contentType: 'text/plain', size: 5, expiresAt: '2026-10-26T10:00:00.000Z' }, url: 'https://example.s3.amazonaws.com/file?X-Amz-Signature=synthetic-secret' }),
        get_thread: async () => ({ threadId: mailboxId, messages: [] }),
        read_messages: async input => ({ includeHtml: input.includeHtml, results: [{ status: 'failed', mailboxId, uid: 1, error: { code: 'not_found', message: 'not_found' } }], byteBudget: 1048576, bytesReturned: 200 }),
        create_reply_draft: async input => ({ status: 'failed', operation_id: input.operation_id, reason: 'unsupported_content' }),
        create_draft: async input => { calls.push({ tool: 'create_draft', input }); return { status: 'completed', operation_id: input.operation_id, draft: { mailboxId, uid: 2, version }, verified: true, proof: { mailboxId, uid: 2, version, accountId: mailboxId, contentDigest: 'a'.repeat(64), sourceGrade: 'mcp_authored' } }; },
        update_draft: async input => { calls.push({ tool: 'update_draft', input }); return { status: 'partial', operation_id: input.operation_id, candidate: { mailboxId, uid: 3, version }, candidateVerified: true, proof: { mailboxId, uid: 3, version, accountId: mailboxId, contentDigest: 'a'.repeat(64), sourceGrade: 'mcp_authored' }, originalDeletion: 'unconfirmed', reason: 'original_deletion_unconfirmed' }; },
        delete_draft: async input => { calls.push({ tool: 'delete_draft', input }); return { status: 'completed', operation_id: input.operation_id, deleted: { mailboxId, uid: input.uid } }; },
        send_draft: async input => { calls.push({ tool: 'send_draft', input }); return { status: 'queued', operation_id: input.operation_id, queueId: 'synthetic-queue-id' }; },
    };
    const rpc = async (method: string, params?: unknown, scopes = ['mail:read', 'mail:draft', 'mail:send', 'mail:modify']) => {
        const authInfo: AuthInfo = { token: 'synthetic-oauth-token', clientId: 'verified-client', scopes, resource: new URL('https://service.example/mcp') };
        const response = await handleMcp(new Request('https://service.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) }), authInfo, mail);
        expect(response.status).toBe(200); return response.json();
    };
    const call = (name: string, args: unknown = {}, scopes?: string[]) => rpc('tools/call', { name, arguments: args }, scopes);
    return { mail, calls, rpc, call };
}
test('actual SDK HTTP surface lists all mail tools and no legacy profile/status/inbox tools', async () => {
    const f = fixture(); const reply = await f.rpc('tools/list');
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual(toolNames);
    for (const old of ['get_profile', 'whoami', 'get_service_info', 'get_connection_status', 'list_inbox_subjects']) { expect(JSON.stringify(reply)).not.toContain(old); }
    const list = reply.result.tools.find((tool: { name: string }) => tool.name === 'list_messages'); expect(list.inputSchema.properties.limit.maximum).toBe(50); expect(list.inputSchema.additionalProperties).toBe(false);
    const update = reply.result.tools.find((tool: { name: string }) => tool.name === 'update_draft'); expect(update.annotations.destructiveHint).toBe(true);
    expect(reply.result.tools.slice(0, 5).every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)).toBe(true);
    expect(f.calls).toHaveLength(0);
});
test('scope checks precede bound services, and missing scopes give explicit reauthorization guidance', async () => {
    const f = fixture(); for (const [name, args] of [['list_mailboxes', {}], ['read_attachment', { mailboxId, uid: 1, attachmentId: 'ATT1' }], ['send_draft', { uid: 1, expected_version: version, operation_id }], ['move_message', { mailboxId, uid: 1, destinationMailboxId: 'c'.repeat(24), expected_version: version, operation_id }], ['update_message_flags', { mailboxId, uid: 1, expected_version: version, operation_id, seen: false }]] as const) {
        const result = await f.call(name, args, ['profile']); expect(result.result.isError).toBe(true); expect(result.result.content[0].text).toContain('reconnect and authorize');
    } expect(f.calls).toHaveLength(0);
});
test('native schemas apply pagination defaults and reject caller identity, token and backend URL fields', async () => {
    const f = fixture(); expect((await f.call('list_messages', { mailboxId })).result.structuredContent).toEqual({ messages: [] }); expect(f.calls).toEqual([{ tool: 'list_messages', input: { mailboxId, limit: 20 } }]);
    for (const bad of [{ mailboxId, accountId: 'forged' }, { mailboxId, accessToken: 'never-echo-this-token' }, { mailboxId, url: 'https://other.example' }, { mailboxId, next: 'one', previous: 'two' }]) {
        const reply = await f.call('list_messages', bad); expect(Boolean(reply.error || reply.result?.isError)).toBe(true); expect(JSON.stringify(reply)).not.toContain('never-echo-this-token');
    } expect(f.calls).toHaveLength(1);
});
test('read output preserves untrusted mail as structured data and writes return actual typed references/queue acceptance', async () => {
    const f = fixture(); const read = await f.call('read_message', { mailboxId, uid: 1 }); expect(read.result.structuredContent.subject).toBe('<untrusted mail subject>'); expect(read.result._meta).toBeUndefined();
    const created = await f.call('create_draft', { operation_id, to: [], cc: [], bcc: [], subject: 'Draft', body: { text: 'Body', html: null } }); expect(created.result.structuredContent.draft).toEqual({ mailboxId, uid: 2, version });
    const updated = await f.call('update_draft', { operation_id, uid: 2, expected_version: version, to: [], cc: [], bcc: [], subject: 'Draft', body: { text: 'Body', html: null } }); expect(updated.result.isError).toBe(true); expect(updated.result.content[1].text).toContain('not complete success'); expect(updated.result.structuredContent.status).toBe('partial'); expect(updated.result.structuredContent.originalDeletion).toBe('unconfirmed');
    const sent = await f.call('send_draft', { uid: 3, operation_id, expected_version: version }); expect(sent.result.structuredContent).toEqual({ status: 'queued', operation_id, queueId: 'synthetic-queue-id' }); expect(JSON.stringify(sent)).not.toContain('delivered');
});
test('mail exceptions redact backend messages and uncertain sends never trigger a transport resend', async () => {
    const f = fixture(); f.mail.list_mailboxes = async () => { throw new Error('private upstream token/body'); };
    const unexpected = await f.call('list_mailboxes'); expect(unexpected.result.isError).toBe(true); expect(JSON.stringify(unexpected)).not.toContain('private');
    f.mail.list_mailboxes = async () => { throw new MailError('reconnect_required'); }; expect((await f.call('list_mailboxes')).result.content[0].text).toContain('Reconnect');
    let submissions = 0; f.mail.send_draft = async input => { submissions++; return { status: 'outcome_unknown', operation_id: input.operation_id, reason: 'dispatch_uncertain' }; };
    const unknown = await f.call('send_draft', { uid: 1, expected_version: version, operation_id }); expect(unknown.result.isError).toBe(true); expect(unknown.result.structuredContent.status).toBe('outcome_unknown'); expect(unknown.result.content[1].text).toContain('Do not resend or use a new operation_id'); expect(submissions).toBe(1);
});
test('attachment binary appears once in embedded resource; metadata stays binary-free and size is checked', async () => {
    const f = fixture(); const result = (await f.call('read_attachment', { mailboxId, uid: 1, attachmentId: 'ATT1' })).result;
    expect(result.isError).toBeUndefined(); expect(result.structuredContent.size).toBe(5);
    expect(result.content[1]).toEqual({ type: 'resource', resource: { uri: 'wildduck://attachment/ATT1', mimeType: 'text/plain', blob: 'aGVsbG8=' } });
    expect(JSON.stringify(result).split('aGVsbG8=')).toHaveLength(2); expect(JSON.stringify(result.structuredContent)).not.toContain('blob');
    f.mail.read_attachment = async input => ({ metadata: { ...input, filename: null, contentType: 'text/plain', size: 99, resourceUri: 'wildduck://attachment/ATT1' }, bytes: Buffer.from('hello') });
    const bad = await f.call('read_attachment', { mailboxId, uid: 1, attachmentId: 'ATT1' }); expect(bad.result.isError).toBe(true); expect(JSON.stringify(bad)).not.toContain('aGVsbG8=');
});
test('HTML truncation and pending receipts are explicit incomplete errors', async () => {
    const f = fixture(); const read = f.mail.read_message; f.mail.read_message = async input => ({ ...await read(input), htmlTruncated: true });
    const html = await f.call('read_message', { mailboxId, uid: 1 }); expect(html.result.isError).toBe(true); expect(html.result.content[1].text).toContain('Incomplete read');
    f.mail.send_draft = async input => ({ status: 'in_progress', operation_id: input.operation_id });
    const pending = await f.call('send_draft', { uid: 1, expected_version: version, operation_id }); expect(pending.result.isError).toBe(true); expect(pending.result.content[1].text).toContain('same operation_id');
});
test('moves and custom flag/label writes validate native schemas and return minimal verified references', async () => {
    const f = fixture(); const target = { mailboxId, uid: 1, expected_version: version, operation_id };
    const flags = await f.call('update_message_flags', { ...target, addFlags: ['$Forwarded', 'Custom'], labels: ['My Label'] });
    expect(flags.result.structuredContent.verified).toBe(true); expect(flags.result.structuredContent.labels).toBeUndefined();
    const moved = await f.call('move_message', { ...target, destinationMailboxId: 'c'.repeat(24) }); expect(moved.result.structuredContent.message.mailboxId).toBe('c'.repeat(24));
    const before = f.calls.length;
    for (const args of [{ ...target, addFlags: ['\\Draft'] }, { ...target, seen: false, addFlags: ['\\Seen'] }]) { const rejected = await f.call('update_message_flags', args); expect(Boolean(rejected.error || rejected.result?.isError)).toBe(true); }
    expect(f.calls).toHaveLength(before);
});
test('legacy edit/send rejection explains authored-source requirements without suggesting reconnection', async () => {
    const f = fixture(); f.mail.update_draft = async () => { throw new MailError('unsupported_content'); }; f.mail.send_draft = async () => { throw new MailError('unsupported_content'); };
    for (const [name, args] of [['update_draft', { uid: 1, expected_version: version, operation_id, subject: 'Change' }], ['send_draft', { uid: 1, expected_version: version, operation_id }]] as const) {
        const result = (await f.call(name, args)).result; expect(result.isError).toBe(true); expect(result.content[0].text).toContain('durable MCP-authored source proof'); expect(result.content[0].text.toLowerCase()).not.toContain('reconnect');
    }
    const flags = await f.call('update_message_flags', { mailboxId, uid: 1, expected_version: version, operation_id, seen: false }); expect(flags.result.structuredContent.proof.sourceGrade).toBe('observed'); expect(flags.result.isError).toBeUndefined();
});
test('published descriptions distinguish existing API snapshots and authored source eligibility', async () => {
    const f = fixture(); const tools = (await f.rpc('tools/list')).result.tools;
    const description = (name: string) => tools.find((tool: { name: string }) => tool.name === name).description;
    expect(description('update_draft')).toContain('legacy/observed drafts are rejected before upload'); expect(description('send_draft')).toContain('verified before dispatch'); expect(description('read_message')).toContain('potential upstream truncation');
    const read = tools.find((tool: { name: string }) => tool.name === 'read_message'); expect(read.outputSchema.properties.textTruncated.description).toContain('potentially truncated upstream');
});
test('read errors never prescribe operation IDs or write ambiguity handling', async () => {
    const inputs = { list_mailboxes: {}, list_messages: { mailboxId }, search_messages: { subject: 'Requested search' }, read_message: { mailboxId, uid: 1 }, read_attachment: { mailboxId, uid: 1, attachmentId: 'ATT1' } };
    for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
        for (const error of [new MailError('temporarily_unavailable'), new MailError('upstream_timeout'), new MailError('verification_failed'), new MailError('version_conflict'), new MailError('unsupported_content'), new MailError('unsupported_draft'), new MailError('no_recipients'), new Error('private failure')]) {
            const f = fixture(); f.mail[name] = async () => { throw error; };
            const result = (await f.call(name, inputs[name])).result; const text = result.content[0].text;
            expect(result.isError).toBe(true); expect(text).not.toMatch(/operation_id|resend|new (?:ID|operation)|for (?:a )?write|uncertain outcome|editing or sending|before sending|canonical Drafts/i); expect(text).not.toContain('private failure');
        }
    }
    const f = fixture(); const searches: unknown[] = []; f.mail.search_messages = async input => { searches.push(input); throw new MailError('temporarily_unavailable'); };
    const unavailable = (await f.call('search_messages', { subject: 'Requested search' })).result.content[0].text;
    expect(unavailable).toContain('search is temporarily unavailable'); expect(unavailable).not.toMatch(/timeout|timed out/i); expect(searches).toEqual([{ subject: 'Requested search', limit: 20 }]);
});
test('write temporary and verification failures retain conservative same-operation retry guidance', async () => {
    const inputs = { create_draft: { operation_id, subject: '', body: { text: '', html: null } }, update_draft: { uid: 1, expected_version: version, operation_id, subject: 'Change' }, delete_draft: { uid: 1, expected_version: version, operation_id }, send_draft: { uid: 1, expected_version: version, operation_id }, move_message: { mailboxId, uid: 1, destinationMailboxId: 'c'.repeat(24), expected_version: version, operation_id }, update_message_flags: { mailboxId, uid: 1, expected_version: version, operation_id, seen: false } };
    for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
        for (const code of ['temporarily_unavailable', 'upstream_timeout', 'verification_failed'] as const) {
            const f = fixture(); f.mail[name] = async () => { throw new MailError(code); };
            const result = (await f.call(name, inputs[name])).result; expect(result.isError).toBe(true); expect(result.content[0].text).toContain('same operation_id'); expect(result.content[0].text).toMatch(/do not (?:retry under a new ID|submit a new operation)/i);
        }
    }
});

test('actual upstream timeout reports read budget exhaustion without guessing generic failures are timeouts', async () => {
    const f = fixture(); f.mail.search_messages = async () => { throw new MailError('upstream_timeout'); };
    const result = (await f.call('search_messages', { subject: 'Requested search' })).result;
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain('exceeded the available request time budget'); expect(result.content[0].text).toContain('explicitly narrow'); expect(result.content[0].text).not.toContain('operation_id');
});

test('durable preflight timeout receipts retain explicit same-operation guidance', async () => {
    const f = fixture(); f.mail.create_draft = async input => ({ status: 'failed', operation_id: input.operation_id, reason: 'upstream_timeout' });
    const result = (await f.call('create_draft', { operation_id, subject: '', body: { text: '', html: null } })).result;
    expect(result.isError).toBe(true); expect(result.structuredContent.reason).toBe('upstream_timeout'); expect(result.content[1].text).toContain('same operation_id');
});

test('structured errors expose stable sanitized code and only a supplied validated retry hint', async () => {
    const f = fixture(); f.mail.list_mailboxes = async () => { throw new MailError('temporarily_unavailable', 42); };
    const unavailable = (await f.call('list_mailboxes')).result; expect(unavailable.structuredContent.error).toEqual({ code: 'temporarily_unavailable', message: unavailable.content[0].text, retry_after: 42 });
    f.mail.list_mailboxes = async () => { throw new Error('private token'); }; const unknown = (await f.call('list_mailboxes')).result; expect(unknown.structuredContent.error.code).toBe('temporarily_unavailable'); expect(unknown.structuredContent.error.retry_after).toBeUndefined(); expect(JSON.stringify(unknown)).not.toContain('private token');
});

test('attachment download publishes resource_link and metadata only, without inline binary', async () => {
    const f = fixture(); const result = (await f.call('get_attachment_download', { mailboxId, uid: 1, attachmentId: 'ATT1' })).result;
    expect(result.isError).toBeUndefined(); expect(result.content[1]).toEqual({ type: 'resource_link', uri: 'https://example.s3.amazonaws.com/file?X-Amz-Signature=synthetic-secret', name: 'ATT1', mimeType: 'text/plain', size: 5 });
    expect(JSON.stringify(result)).not.toContain('blob'); expect(JSON.stringify(result)).not.toContain('base64'); expect(result.content.some((item: {type: string}) => item.type === 'resource')).toBe(false);
});

test('forged unknown MailError codes cannot leak through structured tool errors', async () => {
    const f = fixture(); f.mail.list_mailboxes = async () => { throw Reflect.construct(MailError, ['private-upstream-secret', 30]); };
    const result = (await f.call('list_mailboxes')).result; expect(result.structuredContent.error.code).toBe('temporarily_unavailable'); expect(result.structuredContent.error.retry_after).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('private-upstream-secret');
});

test('download URL occurs exactly once across the entire SDK result, only at resource_link.uri', async () => {
    const f = fixture(); const url = 'https://example.s3.amazonaws.com/file?X-Amz-Signature=synthetic-secret';
    const reply = await f.call('get_attachment_download', { mailboxId, uid: 1, attachmentId: 'ATT1' }); const result = reply.result;
    expect(JSON.stringify(reply).split(url).length - 1).toBe(1);
    expect(result.content.filter((item: { type: string }) => item.type === 'resource_link')).toEqual([{ type: 'resource_link', uri: url, name: 'ATT1', mimeType: 'text/plain', size: 5 }]);
    expect(result.structuredContent).not.toHaveProperty('url'); expect(JSON.stringify(result.structuredContent)).not.toContain(url);
    const text = result.content.filter((item: { type: string }) => item.type === 'text'); expect(text).toHaveLength(1); expect(JSON.parse(text[0].text)).toEqual(result.structuredContent); expect(text[0].text).not.toContain(url);
});
test('download public output schema advertises metadata without a URL', async () => {
    const f = fixture(); const tool = (await f.rpc('tools/list')).result.tools.find((item: { name: string }) => item.name === 'get_attachment_download');
    expect(tool.outputSchema.properties.url).toBeUndefined(); expect(tool.outputSchema.required).not.toContain('url'); expect(tool.outputSchema.additionalProperties).toBe(false);
});

test('malformed internal download URLs and carrier metadata fail without leaking their URL', async () => {
    const f = fixture(); const valid = f.mail.get_attachment_download;
    for (const url of ['http://example.s3.amazonaws.com/file?secret=private', 'javascript:private-secret', 'private invalid download URL']) {
        f.mail.get_attachment_download = async input => ({ ...await valid(input), url });
        const result = (await f.call('get_attachment_download', { mailboxId, uid: 1, attachmentId: 'ATT1' })).result;
        expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(url); expect(result.content.some((item: { type: string }) => item.type === 'resource_link')).toBe(false);
    }
    const url = 'https://example.s3.amazonaws.com/file?X-Amz-Signature=synthetic-secret';
    f.mail.get_attachment_download = async input => { const link = await valid(input); return { ...link, metadata: { ...link.metadata, url } }; };
    const result = (await f.call('get_attachment_download', { mailboxId, uid: 1, attachmentId: 'ATT1' })).result;
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(url);
});

test('all not_found batch items remain a normal result rather than a whole-tool error', async () => {
    const f = fixture(); const result = (await f.call('read_messages', { messages: [{ mailboxId, uid: 1 }] })).result;
    expect(result.isError).toBeUndefined(); expect(result.structuredContent.results).toEqual([{ status: 'failed', mailboxId, uid: 1, error: { code: 'not_found', message: 'not_found' } }]);
});

test('batch defaults retain HTML while text-only and mixed failed/truncated items are normal SDK results', async () => {
    const f = fixture(); const message = await f.mail.read_message({ mailboxId, uid: 1 }); const privateHtml = 'PRIVATE_HTML_PAYLOAD_ONLY'; const { html: _html, ...textOnly } = message;
    f.mail.read_messages = async input => ({ includeHtml: input.includeHtml, results: [
        { status: 'ok', message: input.includeHtml ? { ...message, html: [privateHtml], htmlOmitted: false, textTruncated: true, htmlTruncated: true } : { ...textOnly, htmlOmitted: true, textTruncated: true, htmlTruncated: true } },
        { status: 'failed', mailboxId, uid: 2, error: { code: 'not_found', message: 'not_found' } },
    ], byteBudget: 1048576, bytesReturned: 500 });
    const defaults = (await f.call('read_messages', { messages: [{ mailboxId, uid: 1 }, { mailboxId, uid: 2 }] })).result;
    expect(defaults.isError).toBeUndefined(); expect(defaults.structuredContent.includeHtml).toBe(true); expect(defaults.structuredContent.results[0].message).toMatchObject({ html: [privateHtml], htmlOmitted: false });
    const text = await f.call('read_messages', { messages: [{ mailboxId, uid: 1 }, { mailboxId, uid: 2 }], includeHtml: false });
    expect(text.result.isError).toBeUndefined(); expect(text.result.structuredContent.includeHtml).toBe(false); expect(text.result.structuredContent.results[0].message).toMatchObject({ htmlOmitted: true, textTruncated: true, htmlTruncated: true }); expect(text.result.structuredContent.results[0].message).not.toHaveProperty('html'); expect(JSON.parse(text.result.content[0].text).results[0].message).not.toHaveProperty('html'); expect(JSON.stringify(text)).not.toContain(privateHtml);
    expect(message).not.toHaveProperty('htmlOmitted');
});
test('whole batch scope, input and execution failures remain tool errors', async () => {
    const f = fixture(); let executed = 0;
    f.mail.read_messages = async () => { executed++; throw new MailError('temporarily_unavailable'); };
    const forbidden = (await f.call('read_messages', { messages: [{ mailboxId, uid: 1 }] }, [])).result; expect(forbidden.isError).toBe(true); expect(forbidden.structuredContent.error.code).toBe('forbidden'); expect(executed).toBe(0);
    const invalid = await f.call('read_messages', { messages: [], includeHtml: false }); expect(Boolean(invalid.error || invalid.result?.isError)).toBe(true); expect(executed).toBe(0);
    const unavailable = (await f.call('read_messages', { messages: [{ mailboxId, uid: 1 }] })).result; expect(unavailable.isError).toBe(true); expect(unavailable.structuredContent.error.code).toBe('temporarily_unavailable'); expect(executed).toBe(1);
});
test('thread body item failures remain normal navigation while thread lookup failures remain tool errors', async () => {
    const f = fixture(); const bodies = await f.mail.read_messages({ messages: [{ mailboxId, uid: 1 }], includeHtml: true });
    f.mail.get_thread = async () => ({ threadId: mailboxId, messages: [], bodies });
    const page = (await f.call('get_thread', { threadId: mailboxId, limit: 1, includeBodies: true })).result; expect(page.isError).toBeUndefined(); expect(page.structuredContent.bodies.results[0].status).toBe('failed');
    f.mail.get_thread = async () => { throw new MailError('not_found'); };
    const missing = (await f.call('get_thread', { threadId: mailboxId })).result; expect(missing.isError).toBe(true); expect(missing.structuredContent.error.code).toBe('not_found');
});

test('published batch schema requires html only for the full-body variant', async () => {
    const f = fixture(); const tool = (await f.rpc('tools/list')).result.tools.find((item: { name: string }) => item.name === 'read_messages');
    const items = tool.outputSchema.properties.results.items; const ok = (items.anyOf ?? items.oneOf).find((variant: { properties: { status: { const: string } } }) => variant.properties.status.const === 'ok');
    const variants = ok.properties.message.anyOf ?? ok.properties.message.oneOf; expect(variants).toHaveLength(2);
    const omitted = variants.find((variant: { properties: { htmlOmitted: { const: boolean } } }) => variant.properties.htmlOmitted.const === true);
    const full = variants.find((variant: { properties: { htmlOmitted: { const: boolean } } }) => variant.properties.htmlOmitted.const === false);
    expect(omitted.properties.html).toBeUndefined(); expect(omitted.required).not.toContain('html'); expect(omitted.additionalProperties).toBe(false);
    expect(full.properties.html.type).toBe('array'); expect(full.required).toContain('html'); expect(full.additionalProperties).toBe(false);
});

test('batch output variants reject empty or undefined HTML on text-only items and require HTML for full items', async () => {
    const f = fixture(); const full = await f.mail.read_message({ mailboxId, uid: 1 }); const { html: _html, ...textOnly } = full;
    const batch = (includeHtml: boolean, message: unknown) => ({ includeHtml, results: [{ status: 'ok', message }], byteBudget: 1048576, bytesReturned: 500 });
    const omitted = { ...textOnly, htmlOmitted: true };
    expect(mailOutputSchemas.read_messages.safeParse(batch(false, omitted)).success).toBe(true);
    for (const html of [undefined, []]) { expect(mailOutputSchemas.read_messages.safeParse(batch(false, { ...omitted, html })).success).toBe(false); }
    expect(mailOutputSchemas.read_messages.safeParse(batch(true, { ...full, html: [], htmlOmitted: false })).success).toBe(true);
    expect(mailOutputSchemas.read_messages.safeParse(batch(true, { ...textOnly, htmlOmitted: false })).success).toBe(false);
    expect(mailOutputSchemas.read_messages.safeParse(batch(true, omitted)).success).toBe(false);
    expect(mailOutputSchemas.read_message.safeParse(full).success).toBe(true); expect(mailOutputSchemas.read_message.safeParse(textOnly).success).toBe(false);
});
test('batch callers cannot forge output HTML projection fields in tool input', async () => {
    const f = fixture(); let executed = 0; f.mail.read_messages = async () => { executed++; throw new Error('must not execute'); };
    for (const input of [
        { messages: [{ mailboxId, uid: 1 }], includeHtml: false, htmlOmitted: true },
        { messages: [{ mailboxId, uid: 1, htmlOmitted: true }], includeHtml: false },
        { messages: [{ mailboxId, uid: 1, html: [] }], includeHtml: false },
    ]) { const reply = await f.call('read_messages', input); expect(Boolean(reply.error || reply.result?.isError)).toBe(true); }
    expect(executed).toBe(0);
});
