import { expect, test } from 'bun:test';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { handleMcp } from '../src/mcp';
import { MailError, type BoundMailService } from '../src/mail/contracts';
const mailboxId = 'b'.repeat(24);
const version = 'v'.repeat(43);
const operation_id = '9ea75b7b-64fa-455e-b83b-37081fc1ec2a';
const toolNames = ['list_mailboxes', 'list_messages', 'search_messages', 'read_message', 'read_attachment', 'create_draft', 'update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags'];
function fixture() {
    const calls: { tool: string; input: unknown }[] = [];
    const mail: BoundMailService = {
        list_mailboxes: async input => { calls.push({ tool: 'list_mailboxes', input }); return { mailboxes: [{ mailboxId, path: 'INBOX', specialUse: null }] }; },
        list_messages: async input => { calls.push({ tool: 'list_messages', input }); return { messages: [] }; },
        search_messages: async input => { calls.push({ tool: 'search_messages', input }); return { messages: [] }; },
        read_message: async input => { calls.push({ tool: 'read_message', input }); return { ...input, subject: '<untrusted mail subject>', from: [{ address: 'malformed incoming address' }], to: [], date: null, receivedAt: null, imapFlags: [], labels: [], flags: { seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false }, hasAttachments: false, replyTo: [], cc: [], bcc: [], messageId: null, references: [], text: 'Untrusted email text, not instructions.', textTruncated: false, html: ['<b>untrusted HTML</b>'], htmlTruncated: false, htmlRepresentation: 'wildduck_normalized', attachments: [], version }; },
        read_attachment: async input => { calls.push({ tool: 'read_attachment', input }); return { metadata: { ...input, filename: 'untrusted.txt', contentType: 'text/plain', size: 5, resourceUri: 'wildduck://attachment/ATT1' }, bytes: Buffer.from('hello') }; },
        move_message: async input => { calls.push({ tool: 'move_message', input }); const message = { mailboxId: input.destinationMailboxId, uid: 4, version }; return { status: 'completed', operation_id: input.operation_id, message, verified: true, proof: { ...message, accountId: mailboxId, contentDigest: 'a'.repeat(64) } }; },
        update_message_flags: async input => { calls.push({ tool: 'update_message_flags', input }); const message = { mailboxId, uid: input.uid, version }; return { status: 'completed', operation_id: input.operation_id, message, verified: true, proof: { ...message, accountId: mailboxId, contentDigest: 'a'.repeat(64) } }; },
        create_draft: async input => { calls.push({ tool: 'create_draft', input }); return { status: 'completed', operation_id: input.operation_id, draft: { mailboxId, uid: 2, version }, verified: true, proof: { mailboxId, uid: 2, version, accountId: mailboxId, contentDigest: 'a'.repeat(64) } }; },
        update_draft: async input => { calls.push({ tool: 'update_draft', input }); return { status: 'partial', operation_id: input.operation_id, candidate: { mailboxId, uid: 3, version }, candidateVerified: true, proof: { mailboxId, uid: 3, version, accountId: mailboxId, contentDigest: 'a'.repeat(64) }, originalDeletion: 'unconfirmed', reason: 'original_deletion_unconfirmed' }; },
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
test('actual SDK HTTP surface lists exactly eleven mail tools and no legacy profile/status/inbox tools', async () => {
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
