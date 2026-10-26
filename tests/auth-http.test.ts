import { expect, test } from 'bun:test';
import { handle, type LambdaContext } from '@hono/aws-lambda';
import { createApp } from '../src/app';
import { AuthCrypto, digest } from '../src/auth/crypto';
import { AuthEngine } from '../src/auth/engine';
import { MemoryStore } from '../src/auth/memory-store';
import { ClientRegistry } from '../src/auth/clients';
import type { AuthRuntime } from '../src/auth/runtime';
import type { UpstreamCredentials } from '../src/auth/contracts';
import { lambdaEvent } from './app.test';
const issuer = 'https://service.example';
const credentials: UpstreamCredentials = { accessToken: 'a'.repeat(40), profile: { id: 'a'.repeat(24), name: '<Account>' }, issuedAt: Math.floor(Date.now() / 1000) };
function setup(totp = false) {
    const crypto = new AuthCrypto({ activeKeyId: 'v1', keys: { v1: new Uint8Array(32).fill(3) } });
    const store = new MemoryStore();
    let state: 'valid' | 'expired' | 'temporary' = 'valid';
    const engine = new AuthEngine(store, crypto, { validate: async () => state }, { issuer, refreshRetrySeconds: 10 });
    const clients = new ClientRegistry({ crypto });
    let loginCalls = 0;
    const runtime: AuthRuntime = { issuer, crypto, store, engine, clients, wildduck: { beginLogin: async (username, password) => { expect(username).toBe('user'); expect(password).toBe('password'); loginCalls++; return totp ? { kind: 'pendingTotp', accountId: credentials.profile.id, profile: credentials.profile, nonce: 'b'.repeat(40), provisionalToken: credentials.accessToken, issuedAt: credentials.issuedAt } : { kind: 'authenticated', credentials }; }, completeTotp: async (pending, code) => { expect(pending.accountId).toBe(credentials.profile.id); expect(code).toBe('123456'); return credentials; }, validateCredentials: async () => state, logout: async () => true } };
    const app = createApp({ config: { publicBaseUrl: issuer }, runtime: async () => runtime });
    const registration = clients.register({ client_name: '<Client>', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', application_type: 'native', grant_types: ['authorization_code', 'refresh_token'] });
    const verifier = 'v'.repeat(43);
    const params = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'http://127.0.0.1:5678/callback', resource: `${issuer}/mcp`, scope: 'profile mail:read', code_challenge_method: 'S256', code_challenge: digest(verifier), state: 'original-state' });
    return { app, runtime, params, verifier, setState: (value: typeof state) => { state = value; }, loginCalls: () => loginCalls };
}
function page(response: Response, html: string) {
    const fields = new URLSearchParams();
    for (const match of html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)) { fields.set(match[1] ?? '', (match[2] ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')); }
    return { fields, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
}
async function post(app: ReturnType<typeof createApp>, path: string, fields: URLSearchParams, cookie?: string, origin = issuer) {
    return app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...(cookie ? { cookie } : {}) }, body: fields.toString() });
}
async function connect(env: ReturnType<typeof setup>) {
    const start = await env.app.request(`/authorize?${env.params}`); expect(start.status).toBe(200);
    const login = page(start, await start.text()); login.fields.set('username', 'user'); login.fields.set('password', 'password');
    let consent = await post(env.app, '/auth/login', login.fields, login.cookie);
    let html = await consent.text();
    if (html.includes('name="totp"')) { const mfa = page(consent, html); expect(html).not.toContain(credentials.accessToken); mfa.fields.set('totp', '123456'); consent = await post(env.app, '/auth/mfa', mfa.fields, mfa.cookie); html = await consent.text(); }
    expect(consent.status).toBe(200); expect(html).toContain('&lt;Account&gt;'); expect(html).not.toContain(credentials.accessToken); expect(html).not.toContain('value="password"');
    const approval = page(consent, html); approval.fields.set('decision', 'allow');
    const redirect = await post(env.app, '/auth/consent', approval.fields, approval.cookie); expect(redirect.status).toBe(302);
    const target = new URL(redirect.headers.get('location') ?? ''); expect(target.searchParams.get('iss')).toBe(issuer); expect(target.searchParams.get('state')).toBe('original-state');
    const fields = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.params.get('client_id') ?? '', redirect_uri: env.params.get('redirect_uri') ?? '', resource: `${issuer}/mcp`, code: target.searchParams.get('code') ?? '', code_verifier: env.verifier });
    const response = await post(env.app, '/token', fields); expect(response.status).toBe(200); return { tokens: await response.json(), fields };
}
test.each([false, true])('browser consent, PKCE, native callback and authenticated MCP (TOTP=%s)', async totp => {
    const env = setup(totp); const { tokens, fields } = await connect(env);
    expect((await post(env.app, '/token', fields)).status).toBe(400);
    const rpc = await env.app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_profile', arguments: {} } }) });
    expect(rpc.status).toBe(200); const result = await rpc.json(); expect(result.result.structuredContent.id).toBe(credentials.profile.id); expect(result.result._meta['openai/profile'].id).toBe(credentials.profile.id);
    const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token });
    const rotated = await post(env.app, '/token', refresh); expect(rotated.status).toBe(200); const next = await rotated.json(); expect(next.refresh_token).not.toBe(tokens.refresh_token); expect(await (await post(env.app, '/token', refresh)).json()).toEqual(next);
    env.setState('temporary'); const latest = new URLSearchParams(refresh); latest.set('refresh_token', next.refresh_token); expect((await post(env.app, '/token', latest)).status).toBe(503);
    env.setState('valid'); expect((await post(env.app, '/token', latest)).status).toBe(200);
});
test('CSRF origin, tampered public fields and duplicate parameters never reach backend login', async () => {
    const env = setup(); const start = await env.app.request(`/authorize?${env.params}`); const login = page(start, await start.text()); login.fields.set('username', 'user'); login.fields.set('password', 'password');
    expect((await post(env.app, '/auth/login', login.fields, login.cookie, 'https://attacker.example')).status).toBe(400);
    const tamper = new URLSearchParams(login.fields); tamper.set('scope', 'profile mail:send'); expect((await post(env.app, '/auth/login', tamper, login.cookie)).status).toBe(400);
    const duplicate = new URLSearchParams(login.fields); duplicate.append('csrf', 'other'); expect((await post(env.app, '/auth/login', duplicate, login.cookie)).status).toBe(400); expect(env.loginCalls()).toBe(0);
    const invalid = new URLSearchParams(env.params); invalid.set('redirect_uri', 'https://attacker.example'); const bad = await env.app.request(`/authorize?${invalid}`); expect(bad.status).toBe(400); expect(bad.headers.get('location')).toBeNull();
});
test('token endpoint rejects duplicate fields, mixed authentication and wrong resource', async () => {
    const env = setup(); const { fields } = await connect(env); fields.set('code', 'bad'); fields.append('client_id', 'other'); expect((await post(env.app, '/token', fields)).status).toBe(400); fields.delete('client_id'); fields.set('client_id', env.params.get('client_id') ?? '');
    expect((await env.app.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic dXNlcjpwYXNz' }, body: fields.toString() })).status).toBe(401);
    fields.set('resource', 'https://attacker.example/mcp'); expect((await post(env.app, '/token', fields)).status).toBe(400);
});
test('Lambda adapter carries browser cookies, redirects, metadata and token errors', async () => {
    const env = setup(); const handler = handle(env.app);
    const response = await handler(lambdaEvent(`/authorize?${env.params}`), {} as LambdaContext); expect(response.statusCode).toBe(200); expect(response.cookies?.[0]).toContain('__Host-wildduck-flow='); expect(response.body).toContain('Connect your mail account');
    expect((await handler(lambdaEvent('/mcp'), {} as LambdaContext)).statusCode).toBe(401);
    const token = lambdaEvent('/token', 'POST', 'client_id=one&client_id=two'); token.headers['content-type'] = 'application/x-www-form-urlencoded'; expect((await handler(token, {} as LambdaContext)).statusCode).toBe(400);
});
test('upstream expiration makes refresh actionable without accepting static headers', async () => {
    const env = setup(); const { tokens } = await connect(env); env.setState('expired');
    expect((await env.app.request('/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    const refresh = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.params.get('client_id') ?? '', resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token });
    const expired = await post(env.app, '/token', refresh); expect(expired.status).toBe(400); expect((await expired.json()).error_description).toContain('Reconnect');
    expect((await env.app.request('/mcp', { headers: { 'x-access-token': credentials.accessToken } })).status).toBe(401);
});
test.each(['client_secret_basic', 'client_secret_post'])('registered confidential clients enforce %s across HTTP and revocation', async method => {
    const env = setup();
    const registration = await env.app.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Confidential', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: method }) });
    expect(registration.status).toBe(201); expect(registration.headers.get('access-control-allow-origin')).toBe('*');
    const client = await registration.json();
    const fields = new URLSearchParams({ token: 'unrecognized' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (method === 'client_secret_basic') { headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`; }
    else { fields.set('client_id', client.client_id); fields.set('client_secret', client.client_secret); }
    expect((await env.app.request('/revoke', { method: 'POST', headers, body: fields.toString() })).status).toBe(200);
    if (method === 'client_secret_basic') { headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:wrong`).toString('base64')}`; }
    else { fields.set('client_secret', 'wrong'); }
    expect((await env.app.request('/revoke', { method: 'POST', headers, body: fields.toString() })).status).toBe(401);
});
test('CIMD public client metadata resolves through HTTP and escapes presentation data', async () => {
    const env = setup(); const id = 'https://client.example/oauth/client.json';
    env.runtime.clients = new ClientRegistry({ crypto: env.runtime.crypto, fetchMetadata: async () => new Response(JSON.stringify({ client_id: id, client_name: '<Metadata client>', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_methods_supported: ['none'] }), { headers: { 'content-type': 'application/json' } }) });
    const params = new URLSearchParams(env.params); params.set('client_id', id); params.set('redirect_uri', 'https://client.example/callback');
    const response = await env.app.request(`/authorize?${params}`); expect(response.status).toBe(200); expect(await response.text()).toContain('&lt;Metadata client&gt;');
});
test('PKCE failure preserves code for the correct verifier and HTTP revocation invalidates access', async () => {
    const env = setup(); const start = await env.app.request(`/authorize?${env.params}`); const login = page(start, await start.text()); login.fields.set('username', 'user'); login.fields.set('password', 'password');
    const consent = await post(env.app, '/auth/login', login.fields, login.cookie); const approve = page(consent, await consent.text()); approve.fields.set('decision', 'allow'); const callback = await post(env.app, '/auth/consent', approve.fields, approve.cookie);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const fields = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.params.get('client_id') ?? '', redirect_uri: env.params.get('redirect_uri') ?? '', resource: `${issuer}/mcp`, code, code_verifier: 'w'.repeat(43) });
    expect((await post(env.app, '/token', fields)).status).toBe(400); fields.set('code_verifier', env.verifier); const response = await post(env.app, '/token', fields); expect(response.status).toBe(200); const tokens = await response.json();
    expect((await post(env.app, '/revoke', new URLSearchParams({ client_id: env.params.get('client_id') ?? '', token: tokens.refresh_token }))).status).toBe(200);
    expect((await env.app.request('/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
});
