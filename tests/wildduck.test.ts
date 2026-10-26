import { describe, expect, test } from 'bun:test';
import { WildduckClient, WildduckSessionValidator, WILDDUCK_ORIGIN, type PendingTotp } from '../src/wildduck';
import { AuthCrypto, connectionAAD } from '../src/auth/crypto';
import type { Connection, UpstreamCredentials } from '../src/auth/contracts';
const id = 'a'.repeat(24); const token = 'b'.repeat(40); const nonce = 'c'.repeat(40);
const login = { success: true, id, username: 'canonical', address: 'me@example.com', scope: 'master', require2fa: false, token };
const credentials: UpstreamCredentials = { accessToken: token, profile: { id }, issuedAt: 1000 };
function fixture(responses: Array<{ body: unknown; status?: number }>, timeoutMs = 100) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const response = responses.shift(); if (!response) { throw new Error('Unexpected request'); }
        return Response.json(response.body, { status: response.status ?? 200 });
    }) as typeof fetch;
    const client = new WildduckClient({ issuer: 'https://issuer.example', fetch: fetcher, now: () => 1000, timeoutMs });
    return { client, calls };
}
function pending(overrides: Partial<PendingTotp> = {}): PendingTotp {
    return { kind: 'pendingTotp', accountId: id, profile: { id }, nonce, issuedAt: 1000, ...overrides };
}
describe('WildDuck bootstrap and session adapter', () => {
    test('login uses the sole fixed bootstrap host without a credential header and takes canonical identity', async () => {
        const f = fixture([{ body: login }]);
        expect(await f.client.beginLogin('input@example.com', 'password', 'flow')).toEqual({ kind: 'authenticated', credentials: { accessToken: token, profile: { id, name: 'canonical', email: 'me@example.com' }, issuedAt: 1000 } });
        expect(f.calls[0]?.url).toBe(`${WILDDUCK_ORIGIN}/authenticate`);
        expect(f.calls[0]?.init.redirect).toBe('error');
        expect(new Headers(f.calls[0]?.init.headers).has('X-Access-Token')).toBe(false);
        expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ username: 'input@example.com', password: 'password', scope: 'master', token: true, protocol: 'wildduck-mcp', appId: 'https://issuer.example', sess: 'flow' });
    });
    test('strict and provisional TOTP paths cannot produce credentials before challenge success', async () => {
        for (const provisional of [false, true]) {
            const f = fixture([{ body: { ...login, require2fa: ['totp', 'webauthn'], totpNonce: nonce, token: provisional ? token : undefined } }, { body: provisional ? { success: true } : { success: true, token } }]);
            const result = await f.client.beginLogin('u', 'p'); expect(result.kind).toBe('pendingTotp');
            if (result.kind !== 'pendingTotp') { throw new Error('Expected challenge'); }
            expect(result).not.toHaveProperty('credentials'); expect(result).not.toHaveProperty('password');
            expect((await f.client.completeTotp(result, '123456')).accessToken).toBe(token);
            expect(new Headers(f.calls[1]?.init.headers).has('X-Access-Token')).toBe(false);
            expect(f.calls[1]?.url).toBe(`${WILDDUCK_ORIGIN}/users/${id}/2fa/totp/check`);
        }
    });
    test('required enrollment policy allows an enrolled TOTP challenge but blocks absent enrollment', async () => {
        const f = fixture([{ body: { ...login, require2faEnabled: true, require2fa: ['totp'], totpNonce: nonce, token: undefined } }, { body: { success: true, token } }]);
        const result = await f.client.beginLogin('u', 'p');
        expect(result.kind).toBe('pendingTotp');
        if (result.kind !== 'pendingTotp') { throw new Error('Expected TOTP'); }
        expect((await f.client.completeTotp(result, '123456')).accessToken).toBe(token);
        for (const require2fa of [false, []]) {
            const blocked = fixture([{ body: { ...login, require2faEnabled: true, require2fa } }]);
            await expect(blocked.client.beginLogin('u', 'p')).rejects.toThrow('action_required');
        }
    });
    test('strict TOTP completion requires returned token and rejects wrong codes', async () => {
        for (const response of [{ body: { success: true } }, { body: { success: true, token: 7 } }, { body: { code: 'InvalidToken' }, status: 403 }]) {
            const f = fixture([response]); await expect(f.client.completeTotp(pending(), '123456')).rejects.toThrow();
        }
    });
    test('password changes, enrollment, unsupported MFA and malformed successes fail closed even with token', async () => {
        for (const update of [
            { requirePasswordChange: true }, { require2faEnabled: true }, { require2fa: ['webauthn'], twoFactorNonce: nonce },
            { require2fa: ['custom'] }, { require2fa: ['totp', 'unknown'], totpNonce: nonce }, { require2fa: ['totp'] },
            { require2fa: [] }, { require2fa: true }, { id: '../other' }, { scope: 'imap' }, { success: false }, { token: '' },
            { address: 'invalid' }, { requirePasswordChange: 'false' }, { require2fa: ['totp'], totpNonce: nonce, twoFactorNonce: token }
        ]) { const f = fixture([{ body: { ...login, ...update } }]); await expect(f.client.beginLogin('u', 'p')).rejects.toThrow(); }
    });
    test('pending state account, nonce and ten minute deadline are checked before fetching', async () => {
        for (const challenge of [pending({ accountId: '../evil' }), pending({ profile: { id: 'd'.repeat(24) } }), pending({ nonce: '' }), pending({ issuedAt: 400 }), pending({ issuedAt: 1001 })]) {
            const f = fixture([]); await expect(f.client.completeTotp(challenge, '123456')).rejects.toThrow('invalid_input'); expect(f.calls).toHaveLength(0);
        }
        const f = fixture([]); await expect(f.client.completeTotp(pending(), '12a456')).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    });
    test('user checks and logout always carry explicit token; missing token never invokes proxy fallback', async () => {
        const f = fixture([{ body: { success: true } }, { body: { success: true } }]);
        expect(await f.client.validateCredentials(credentials)).toBe('valid'); expect(await f.client.logout(token)).toBe(true);
        for (const call of f.calls) { expect(new Headers(call.init.headers).get('X-Access-Token')).toBe(token); }
        expect(await f.client.validateCredentials({ ...credentials, accessToken: '' })).toBe('temporary'); expect(await f.client.logout('')).toBe(false); expect(f.calls).toHaveLength(2);
    });
    test('only definitive InvalidToken expires; outages and permission denials preserve sessions', async () => {
        for (const [status, body, expected] of [
            [403, { code: 'InvalidToken' }, 'expired'], [401, { code: 'Unknown' }, 'temporary'], [403, { code: 'AccessDenied' }, 'temporary'],
            [500, { code: 'InvalidToken' }, 'temporary'], [429, {}, 'temporary'], [200, {}, 'temporary'], [200, { success: 'true' }, 'temporary']
        ] as const) { const f = fixture([{ status, body }]); expect(await f.client.validateCredentials(credentials)).toBe(expected); }
    });
    test('bootstrap failures are sanitized and never echo backend messages', async () => {
        const f = fixture([{ status: 403, body: { code: 'AuthFailed', error: 'password secret' } }]);
        await expect(f.client.beginLogin('u', 'p')).rejects.toThrow('authentication_failed');
    });
    test('redirects, oversized bodies and deadlines cannot authenticate', async () => {
        const responses = [new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
            Response.json({ ...login, excess: 'x'.repeat(65536) }), new Response('{', { headers: { 'content-type': 'application/json' } }),
            new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } })];
        for (const response of responses) {
            const client = new WildduckClient({ issuer: 'https://issuer.example', fetch: (async () => response) as unknown as typeof fetch });
            await expect(client.beginLogin('u', 'p')).rejects.toThrow('temporary');
        }
        let signal: AbortSignal | null | undefined;
        const slow = new WildduckClient({ issuer: 'https://issuer.example', timeoutMs: 5, fetch: (async (_url, init) => { signal = init?.signal; return await new Promise<Response>(() => {}); }) as typeof fetch });
        await expect(slow.beginLogin('u', 'p')).rejects.toThrow('temporary'); expect(signal?.aborted).toBe(true);
        const slowBody = new WildduckClient({ issuer: 'https://issuer.example', timeoutMs: 5, fetch: (async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
        await expect(slowBody.beginLogin('u', 'p')).rejects.toThrow('temporary');
    });
    test('connection decryption binds generation, account, and profile before network', async () => {
        const f = fixture([{ body: { success: true } }]);
        const crypto = new AuthCrypto({ activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(1) } });
        const base = { kind: 'connection' as const, id, accountId: id, credentialGeneration: 1, revision: 0, status: 'active' as const, expiresAt: 9999 };
        const connection: Connection = { ...base, credentials: crypto.seal('upstream-credentials', connectionAAD(base), credentials) };
        const validator = new WildduckSessionValidator(f.client, crypto);
        expect(await validator.validate(connection)).toBe('valid');
        expect(await validator.validate({ ...connection, credentialGeneration: 2 })).toBe('temporary');
        const wrong = crypto.seal('upstream-credentials', connectionAAD(base), { ...credentials, profile: { id: 'd'.repeat(24) } });
        expect(await validator.validate({ ...connection, credentials: wrong })).toBe('temporary'); expect(f.calls).toHaveLength(1);
    });
});
