import { expect, test } from 'bun:test';
import { issuer, page, post, setup } from './auth-http.test';
import type { MailContext } from '../src/mail/contracts';

/** Runs the real OAuth consent and token exchange for the given scope and returns an invoker for MCP tool calls. */
async function connected(scope: string) {
    const env = setup(); env.params.set('scope', scope);
    const start = await env.app.request(`/authorize?${env.params}`); const login = page(start, await start.text()); login.fields.set('username', 'user'); login.fields.set('password', 'password');
    const consent = await post(env.app, '/auth/login', login.fields, login.cookie); const approval = page(consent, await consent.text()); approval.fields.set('decision', 'allow');
    const approved = await post(env.app, '/auth/consent', approval.fields, approval.cookie); expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await (await post(env.app, '/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: env.registration.client_id, redirect_uri: env.params.get('redirect_uri') ?? '', resource: `${issuer}/mcp`, code, code_verifier: env.verifier }))).json();
    const invoke = async (name: string, args: object) => (await (await env.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
    return { env, invoke, tokens };
}
const request = { sizeBytes: 5, sha256: 'e'.repeat(64) };

test('create_attachment_upload reaches the mail service with the verified account, client and scopes, and its link leaves only as a resource_link', async () => {
    const { env, invoke, tokens } = await connected('mail:read mail:draft'); const seen: { context: MailContext; input: unknown }[] = [];
    env.runtime.mail.create_attachment_upload = async (context, input) => {
        seen.push({ context, input });
        return { metadata: { uploadId: '0b5e7c1a-3f2d-4c8b-9a6e-1d2c3b4a5f60', sizeBytes: input.sizeBytes, sha256: input.sha256, expiresAt: '2026-10-26T10:15:00.000Z', method: 'PUT', headers: { 'Content-Length': String(input.sizeBytes) } }, url: 'https://bucket.s3.amazonaws.com/uploads/v1/x?X-Amz-Signature=synthetic-upload-secret' };
    };
    // Identity fields in the arguments are refused; the service never sees them.
    expect((await invoke('create_attachment_upload', { ...request, accountId: 'b'.repeat(24) })).isError).toBe(true); expect(seen).toHaveLength(0);
    const result = await invoke('create_attachment_upload', request);
    expect(result.isError).toBeUndefined(); expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toEqual(request); expect(seen[0]?.context).toMatchObject({ accountId: 'a'.repeat(24), accessToken: 'a'.repeat(40), connectionStatus: 'active' }); expect([...seen[0]?.context.scopes ?? []].sort()).toEqual(['mail:draft', 'mail:read']); expect(seen[0]?.context.clientId).toBeString();
    expect(Object.keys(result.structuredContent)[0]).toBe('summary'); expect(result.content[1].type).toBe('resource_link'); expect(result.content[1].uri).toContain('synthetic-upload-secret');
    expect(JSON.stringify(result).split('synthetic-upload-secret')).toHaveLength(2); expect(JSON.stringify(result)).not.toContain(tokens.access_token); expect(JSON.stringify(result)).not.toContain('a'.repeat(40));
});
test('create_attachment_upload is refused without the mail:draft permission before the mail service is called', async () => {
    const { env, invoke } = await connected('mail:read'); let called = 0; env.runtime.mail.create_attachment_upload = async () => { called++; throw new Error('must not be called'); };
    const result = await invoke('create_attachment_upload', request);
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain('needs the mail:draft permission'); expect(called).toBe(0);
});
test('get_message_source_download reaches the mail service with the verified account, and is refused without mail:read', async () => {
    const { env, invoke, tokens } = await connected('mail:read'); const seen: { context: MailContext; input: unknown }[] = [];
    env.runtime.mail.get_message_source_download = async (context, input) => { seen.push({ context, input }); return { metadata: { ...input, size: 9, sha256: 'd'.repeat(64), expiresAt: '2026-10-26T10:05:00.000Z' }, url: 'https://bucket.s3.amazonaws.com/downloads/v1/x?X-Amz-Signature=synthetic-source-secret' }; };
    expect((await invoke('get_message_source_download', { mailboxId: 'b'.repeat(24), uid: 1, accountId: 'b'.repeat(24) })).isError).toBe(true); expect(seen).toHaveLength(0);
    const result = await invoke('get_message_source_download', { mailboxId: 'b'.repeat(24), uid: 1 });
    expect(result.isError).toBeUndefined(); expect(seen).toEqual([{ context: expect.objectContaining({ accountId: 'a'.repeat(24), accessToken: 'a'.repeat(40), connectionStatus: 'active' }), input: { mailboxId: 'b'.repeat(24), uid: 1 } }]);
    expect(result.content[1]).toMatchObject({ type: 'resource_link', mimeType: 'message/rfc822', name: 'message-1.eml' }); expect(JSON.stringify(result).split('synthetic-source-secret')).toHaveLength(2); expect(JSON.stringify(result)).not.toContain(tokens.access_token);
    const draftOnly = await connected('mail:draft'); let called = 0; draftOnly.env.runtime.mail.get_message_source_download = async () => { called++; throw new Error('must not be called'); };
    const denied = await draftOnly.invoke('get_message_source_download', { mailboxId: 'b'.repeat(24), uid: 1 }); expect(denied.isError).toBe(true); expect(denied.content[0].text).toContain('needs the mail:read permission'); expect(called).toBe(0);
});
test('a draft that copies a stored attachment is refused without mail:read before the mail service is called', async () => {
    const { env, invoke } = await connected('mail:draft'); let called = 0; env.runtime.mail.create_draft = async () => { called++; throw new Error('must not be called'); };
    const result = await invoke('create_draft', { operationId: '9ea75b7b-64fa-455e-b83b-37081fc1ec2a', subject: '', body: { text: '' }, attachments: [{ source: { mailboxId: 'b'.repeat(24), uid: 1, attachmentId: 'ATT1' } }] });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain('needs the mail:read and mail:draft permissions'); expect(result.content[0].text).toContain('or attach the file with uploadId or contentBase64 instead'); expect(called).toBe(0);
});
