import { describe, expect, test } from 'bun:test';
import { AuthCrypto, connectionAAD, digest, randomId } from '../src/auth/crypto';
import { AuthEngine } from '../src/auth/engine';
import { MemoryStore } from '../src/auth/memory-store';
import { type Connection, TemporaryUnavailable } from '../src/auth/contracts';
function setup(grace: 0 | 10 = 10) {
    let now = 1000; let backend: 'valid' | 'expired' | 'temporary' = 'valid';
    const store = new MemoryStore(); const crypto = new AuthCrypto({ activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(1) } });
    const engine = new AuthEngine(store, crypto, { validate: async () => backend }, { issuer: 'https://auth.example', refreshRetrySeconds: grace }, () => now);
    const client = { clientId: 'client', redirectUris: ['https://client.example/callback'] };
    const connection: Connection = { kind: 'connection', id: 'account', accountId: 'account', credentialGeneration: 1, revision: 0, status: 'active', expiresAt: 999999, credentials: crypto.seal('upstream-credentials', connectionAAD({ id: 'account', accountId: 'account', credentialGeneration: 1 }), { accessToken: 'upstream-secret' }) };
    const seed = () => store.transact({ conditions: [{ kind: 'connection', id: connection.id, revision: null }], puts: [connection], operationId: randomId() });
    const verifier = 'a'.repeat(43);
    const code = () => engine.issueCode({ client, connectionId: connection.id, redirectUri: client.redirectUris[0]!, resource: engine.resource, scopes: ['profile', 'mail:read'], challenge: digest(verifier) });
    const exchange = async () => engine.exchange({ client, code: await code(), verifier, redirectUri: client.redirectUris[0]!, resource: engine.resource });
    return { store, crypto, engine, client, connection, seed, code, verifier, exchange, tick: (seconds: number) => { now += seconds; }, backend: (value: typeof backend) => { backend = value; } };
}
describe('auth foundation', () => {
    test('AES GCM binds tenant, purpose, generation, key version and uses fresh nonces', () => {
        const f = setup(); const aad = connectionAAD(f.connection); const sealed = f.crypto.seal('upstream-credentials', aad, { token: 'secret' });
        expect(f.crypto.open('upstream-credentials', aad, sealed)).toEqual({ token: 'secret' });
        expect(() => f.crypto.open('upstream-credentials', `${aad}x`, sealed)).toThrow();
        expect(() => f.crypto.open('other', aad, sealed)).toThrow();
        expect(f.crypto.seal('upstream-credentials', aad, {}).nonce).not.toBe(sealed.nonce);
        const rotated = new AuthCrypto({ activeKeyId: 'k2', keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) } });
        expect(rotated.open('upstream-credentials', aad, sealed)).toEqual({ token: 'secret' });
    });
    test('code bindings are checked before atomic single use', async () => {
        const f = setup(); await f.seed(); const code = await f.code();
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: f.client.redirectUris[0]!, resource: f.engine.resource };
        await expect(f.engine.exchange({ ...request, verifier: 'b'.repeat(43) })).rejects.toThrow('invalid_grant');
        const results = await Promise.allSettled([f.engine.exchange(request), f.engine.exchange(request)]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        await expect(f.engine.exchange(request)).rejects.toThrow('invalid_grant');
    });
    test('parallel refresh and lost response return identical receipt; replay revokes after grace', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        const responses = await Promise.all([f.engine.refresh(request), f.engine.refresh(request)]);
        expect(responses[0]).toEqual(responses[1]); expect(await f.engine.refresh(request)).toEqual(responses[0]!);
        await expect(f.engine.verifyAccess(responses[0]!.access_token)).resolves.toMatchObject({ accountId: 'account' });
        f.tick(10); await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(responses[0]!.access_token)).rejects.toThrow('invalid_token');
    });
    test('wrong client, resource, scope escalation and random tokens never revoke', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        await expect(f.engine.refresh({ ...request, client: { ...f.client, clientId: 'attacker' } })).rejects.toThrow('invalid_grant');
        await expect(f.engine.refresh({ ...request, resource: 'https://other/mcp' })).rejects.toThrow('invalid_grant');
        await expect(f.engine.refresh({ ...request, scopes: ['mail:send'] })).rejects.toThrow('invalid_scope');
        await f.engine.revoke(tokens.refresh_token, { ...f.client, clientId: 'attacker' });
        await expect(f.engine.refresh({ ...request, refreshToken: randomId() })).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ accountId: 'account' });
    });
    test('backend temporary failure preserves code and refresh; expired sessions require reconnect', async () => {
        const f = setup(); await f.seed(); const code = await f.code();
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: f.client.redirectUris[0]!, resource: f.engine.resource };
        f.backend('temporary'); await expect(f.engine.exchange(request)).rejects.toThrow(TemporaryUnavailable);
        f.backend('valid'); const tokens = await f.engine.exchange(request);
        f.backend('temporary'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow(TemporaryUnavailable);
        f.backend('expired'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ connectionStatus: 'reconnect_required' });
    });
    test('TTL expiry is rejected while physical records remain', async () => {
        const f = setup(); await f.seed(); const code = await f.code(); f.tick(120);
        await expect(f.engine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: f.client.redirectUris[0]!, resource: f.engine.resource })).rejects.toThrow('invalid_grant');
        expect(await f.store.get('code', digest(code))).toBeDefined();
    });
});
