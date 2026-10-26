import { expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { WildduckClient, WildduckSessionValidator, WILDDUCK_ORIGIN } from '../src/wildduck';
import { AuthCrypto, digest } from '../src/auth/crypto';
import { AuthEngine } from '../src/auth/engine';
import { MemoryStore } from '../src/auth/memory-store';
import { ClientRegistry } from '../src/auth/clients';
import type { AuthRuntime } from '../src/auth/runtime';
const issuer = 'https://service.example'; const account = 'a'.repeat(24); const mailbox = 'b'.repeat(24); const secret = 'c'.repeat(40);
const credentials = { accessToken: secret, profile: { id: account }, issuedAt: Math.floor(Date.now() / 1000) };
function backend() {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    let messages: unknown[] = [{ id: 19, subject: 'Newest subject', mailbox, intro: 'Never return this snippet', from: { address: 'private@example.com' }, attachmentsList: [{ id: 'private' }] }, { id: 12, subject: '', mailbox }];
    let failure: { status: number; body: unknown } | undefined;
    let resolved: unknown = { success: true, id: mailbox, path: 'INBOX' };
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url)); calls.push({ url: parsed, init: init ?? {} });
        expect(parsed.origin).toBe(WILDDUCK_ORIGIN); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('X-Access-Token')).toBe(secret);
        if (parsed.pathname === '/authenticated') { return Response.json({ success: true }); }
        if (failure) { return Response.json(failure.body, { status: failure.status }); }
        if (parsed.pathname === `/users/${account}/mailboxes/resolve`) { return Response.json(resolved); }
        if (parsed.pathname === `/users/${account}/mailboxes/${mailbox}/messages`) { return Response.json({ success: true, results: messages }); }
        throw new Error('Unexpected URL');
    }) as typeof fetch;
    return { client: new WildduckClient({ issuer, fetch: fetcher }), calls, mailCalls: () => calls.filter(call => call.url.pathname !== '/authenticated'), setMessages: (value: unknown[]) => { messages = value; }, setResolve: (value: unknown) => { resolved = value; }, fail: (status: number, body: unknown) => { failure = { status, body }; } };
}
async function connected(scopes = ['profile', 'mail:read']) {
    const b = backend(); const store = new MemoryStore(); const crypto = new AuthCrypto({ activeKeyId: 'v1', keys: { v1: new Uint8Array(32).fill(4) } });
    const engine = new AuthEngine(store, crypto, new WildduckSessionValidator(b.client, crypto), { issuer });
    const connection = await engine.connectOrReconnect({ accountId: account, credentials, expiresAt: Math.floor(Date.now() / 1000) + 10000 });
    const client = { clientId: 'test', redirectUris: ['https://client.example/callback'] }; const verifier = 'v'.repeat(43);
    const code = await engine.issueCode({ client, connectionId: connection.id, redirectUri: client.redirectUris[0] ?? '', resource: engine.resource, scopes, challenge: digest(verifier) });
    const tokens = await engine.exchange({ client, code, verifier, redirectUri: client.redirectUris[0] ?? '', resource: engine.resource });
    const runtime: AuthRuntime = { issuer, crypto, engine, store, clients: new ClientRegistry({ crypto }), wildduck: b.client };
    const app = createApp({ config: { publicBaseUrl: issuer }, runtime: async () => runtime }); b.calls.length = 0;
    const rpc = async (args: unknown = {}, method = 'tools/call') => {
        const response = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'x-access-token': 'caller-header-must-never-forward', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name: 'list_inbox_subjects', arguments: args } : {} }) });
        expect(response.status).toBe(200); return await response.json();
    };
    return { ...b, rpc, store, connection };
}
test('HTTP inbox tool returns only bounded subjects and UIDs using canonical account INBOX, newest first, GET only', async () => {
    const f = await connected(); const reply = await f.rpc({ limit: 2 });
    expect(reply.result.structuredContent).toEqual({ subjects: [{ uid: 19, subject: 'Newest subject' }, { uid: 12, subject: '' }] });
    expect(JSON.stringify(reply)).not.toContain('Never return'); expect(JSON.stringify(reply)).not.toContain('private@example'); expect(JSON.stringify(reply)).not.toContain(secret);
    expect(f.mailCalls().map(call => `${call.url.pathname}${call.url.search}`)).toEqual([`/users/${account}/mailboxes/resolve?path=INBOX`, `/users/${account}/mailboxes/${mailbox}/messages?limit=2&order=desc`]);
    const tools = await f.rpc({}, 'tools/list'); const tool = tools.result.tools.find((item: { name: string }) => item.name === 'list_inbox_subjects');
    expect(tool.inputSchema.additionalProperties).toBe(false); expect(tool.outputSchema.type).toBe('object'); expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
});
test('default limit is ten and empty inbox is a successful empty result', async () => {
    const f = await connected(); f.setMessages([]); const reply = await f.rpc();
    expect(reply.result.structuredContent).toEqual({ subjects: [] }); expect(f.mailCalls()[1]?.url.search).toBe('?limit=10&order=desc');
});
test('profile-only grants are denied before any mailbox call and request explicit reauthorization', async () => {
    const f = await connected(['profile']); const reply = await f.rpc(); expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('Reconnect and authorize mail:read'); expect(f.mailCalls()).toHaveLength(0);
});
test('invalid limits and caller account/token/mailbox/path/URL inputs are rejected before any mail call', async () => {
    const f = await connected();
    for (const args of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '2' }, { limit: null }, { accountId: 'd'.repeat(24) }, { accessToken: secret }, { mailbox }, { path: 'Sent' }, { url: 'https://evil.example' }]) {
        const reply = await f.rpc(args); expect(Boolean(reply.error || reply.result?.isError)).toBe(true);
    }
    expect(f.mailCalls()).toHaveLength(0);
});
test('inactive connection cannot list mail', async () => {
    const f = await connected();
    await f.store.transact({ conditions: [{ kind: 'connection', id: f.connection.id, revision: f.connection.revision }], puts: [{ ...f.connection, revision: f.connection.revision + 1, status: 'reconnect_required' }], operationId: 'set-reconnect' });
    const reply = await f.rpc(); expect(reply.result.isError).toBe(true); expect(reply.result.content[0].text).toContain('Reconnect'); expect(f.calls).toHaveLength(0);
});
test('backend token expiry asks to reconnect while outages and malformed data are sanitized', async () => {
    for (const [status, code, expected] of [[403, 'InvalidToken', 'Reconnect'], [403, 'AccessDenied', 'temporarily unavailable'], [500, 'InvalidToken', 'temporarily unavailable'], [429, 'RateLimit', 'temporarily unavailable']] as const) {
        const f = await connected(); f.fail(status, { code, error: 'sensitive upstream detail' }); const reply = await f.rpc();
        expect(reply.result.isError).toBe(true); expect(reply.result.content[0].text).toContain(expected); expect(JSON.stringify(reply)).not.toContain('sensitive');
    }
    const f = await connected(); f.setResolve({ success: true, id: mailbox, path: 'Sent' }); expect((await f.rpc()).result.isError).toBe(true); expect(f.mailCalls()).toHaveLength(1);
});
test('missing tokens, account mismatch and invalid direct limit fail before all network requests', async () => {
    const f = backend();
    for (const [id, value, limit] of [[account, { ...credentials, accessToken: '' }, 10], ['d'.repeat(24), credentials, 10], [account, credentials, 21]] as const) {
        await expect(f.client.listInboxSubjects(id, value, limit)).rejects.toThrow('invalid_input');
    }
    expect(f.calls).toHaveLength(0);
});
test('malformed, oversized or excessive message results never return partial data', async () => {
    for (const messages of [[{ id: 1, subject: 'x', mailbox: 'd'.repeat(24) }], [{ id: 0, subject: 'x', mailbox }], [{ id: 1, subject: null, mailbox }], [{ id: 1, subject: 'x', mailbox }, { id: 1, subject: 'duplicate', mailbox }], Array.from({ length: 3 }, (_, i) => ({ id: i + 1, subject: 'x', mailbox })), [{ id: 1, subject: 'x'.repeat(65536), mailbox }]]) {
        const f = backend(); f.setMessages(messages); await expect(f.client.listInboxSubjects(account, credentials, 2)).rejects.toThrow('temporary');
    }
});
