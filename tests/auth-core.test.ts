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
    const code = () => engine.issueCode({ client, connectionId: connection.id, redirectUri: 'https://client.example/callback', resource: engine.resource, scopes: ['profile', 'mail:read'], challenge: digest(verifier) });
    const exchange = async () => engine.exchange({ client, code: await code(), verifier, redirectUri: 'https://client.example/callback', resource: engine.resource });
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
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource };
        await expect(f.engine.exchange({ ...request, verifier: 'b'.repeat(43) })).rejects.toThrow('invalid_grant');
        const results = await Promise.allSettled([f.engine.exchange(request), f.engine.exchange(request)]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        await expect(f.engine.exchange(request)).rejects.toThrow('invalid_grant');
    });
    test('parallel refresh and lost response return identical receipt; replay revokes after grace', async () => {
        const f = setup(); await f.seed(); const tokens = await f.exchange();
        const request = { client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token };
        const responses = await Promise.all([f.engine.refresh(request), f.engine.refresh(request)]);
        expect(responses[0]).toEqual(responses[1]); expect(await f.engine.refresh(request)).toEqual(responses[0]);
        await expect(f.engine.verifyAccess(responses[0]?.access_token ?? '')).resolves.toMatchObject({ accountId: 'account' });
        f.tick(10); await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(responses[0]?.access_token ?? '')).rejects.toThrow('invalid_token');
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
        const request = { client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource };
        f.backend('temporary'); await expect(f.engine.exchange(request)).rejects.toThrow(TemporaryUnavailable);
        f.backend('valid'); const tokens = await f.engine.exchange(request);
        f.backend('temporary'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow(TemporaryUnavailable);
        f.backend('expired'); await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow('invalid_grant');
        await expect(f.engine.verifyAccess(tokens.access_token)).resolves.toMatchObject({ connectionStatus: 'reconnect_required' });
    });
    test('TTL expiry is rejected while physical records remain', async () => {
        const f = setup(); await f.seed(); const code = await f.code(); f.tick(120);
        await expect(f.engine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: f.engine.resource })).rejects.toThrow('invalid_grant');
        expect(await f.store.get('code', digest(code))).toBeDefined();
    });
});

test('reconnect requires same account profile and expected generation; old receipt cannot cross reconnect', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const credentials = { accessToken: 'new-secret', profile: { id: 'account' }, issuedAt: 1000 };
    await expect(f.engine.connectOrReconnect({ accountId: 'account', credentials, expiresAt: 999999 })).rejects.toThrow('invalid_grant');
    await expect(f.engine.connectOrReconnect({ accountId: 'account', credentials: { ...credentials, profile: { id: 'other' } }, expiresAt: 999999, expectedCredentialGeneration: 1 })).rejects.toThrow('invalid_request');
    const reconnected = await f.engine.connectOrReconnect({ accountId: 'account', credentials, expiresAt: 999999, expectedCredentialGeneration: 1 });
    expect(reconnected.credentialGeneration).toBe(2);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('older generation replay and explicit revocation invalidate all outstanding access', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const latest = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: next.refresh_token });
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(latest.access_token)).rejects.toThrow('invalid_token');
    const fresh = await f.exchange(); await f.engine.revoke(fresh.refresh_token, f.client);
    await expect(f.engine.verifyAccess(fresh.access_token)).rejects.toThrow('invalid_token');
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: fresh.refresh_token })).rejects.toThrow('invalid_grant');
});
test('random signed-envelope failures do not perform database reads', async () => {
    const f = setup(); let reads = 0;
    const engine = new AuthEngine({ get: async () => { reads++; return undefined; }, transact: async () => { throw new Error('Unexpected write'); } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example' });
    await expect(engine.verifyAccess(randomId())).rejects.toThrow('invalid_token');
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: randomId() })).rejects.toThrow('invalid_grant');
    await expect(engine.exchange({ client: f.client, resource: engine.resource, redirectUri: 'https://client.example/callback', code: randomId(), verifier: f.verifier })).rejects.toThrow('invalid_grant');
    expect(reads).toBe(0);
});
test('unknown transaction outcomes remain temporary errors and committed refresh is recoverable', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange(); let fail = true;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => { const result = await f.store.transact(write); if (fail) { fail = false; throw new TemporaryUnavailable(); } return result; } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    const request = { client: f.client, resource: engine.resource, refreshToken: original.refresh_token };
    await expect(engine.refresh(request)).rejects.toThrow(TemporaryUnavailable);
    const recovered = await engine.refresh(request);
    await expect(engine.verifyAccess(recovered.access_token)).resolves.toMatchObject({ accountId: 'account' });
});
test('strong-read outages are temporary rather than invalid credentials', async () => {
    const f = setup(); await f.seed(); const tokens = await f.exchange();
    const engine = new AuthEngine({ get: async () => { throw new TemporaryUnavailable(); }, transact: f.store.transact.bind(f.store) }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example' }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: tokens.refresh_token })).rejects.toThrow(TemporaryUnavailable);
    await expect(engine.revoke(tokens.refresh_token, f.client)).rejects.toThrow(TemporaryUnavailable);
});
test('delayed expired reconnect candidate cannot overwrite a concurrent valid reconnect', async () => {
    const f = setup(); await f.seed();
    let releaseExpired: (result: 'expired') => void = () => { throw new Error('Barrier not installed'); };
    let signalStarted: () => void = () => { throw new Error('Barrier not installed'); };
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const pendingExpired = new Promise<'expired'>(resolve => { releaseExpired = resolve; });
    const engine = new AuthEngine(f.store, f.crypto, { validate: async connection => {
        const credentials = f.crypto.open<{ accessToken: string }>('upstream-credentials', connectionAAD(connection), connection.credentials);
        if (credentials.accessToken === 'expired-candidate') { signalStarted(); return pendingExpired; }
        return 'valid';
    } }, { issuer: 'https://auth.example' }, () => 1000);
    const common = { accountId: 'account', expiresAt: 999999, expectedCredentialGeneration: 1 };
    const failed = engine.connectOrReconnect({ ...common, credentials: { accessToken: 'expired-candidate', profile: { id: 'account' }, issuedAt: 1000 } });
    const rejected = failed.catch(error => error as Error);
    await started;
    const winner = await engine.connectOrReconnect({ ...common, credentials: { accessToken: 'valid-candidate', profile: { id: 'account' }, issuedAt: 1000 } });
    releaseExpired('expired'); const result = await rejected; expect(result).toBeInstanceOf(Error); if (result instanceof Error) { expect(result.message).toBe('invalid_grant'); }
    expect(await f.store.get('connection', 'account')).toEqual(winner);
    expect(winner.status).toBe('active');
});
test('old token replay after grace revokes despite a different allowed scope subset', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['profile'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).resolves.toMatchObject({ accountId: 'account' });
    f.tick(10);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['profile'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('downscoping cannot conceal old-token replay with original explicit scopes after grace', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['profile'] });
    f.tick(10);
    await expect(f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token, scopes: ['profile', 'mail:read'] })).rejects.toThrow('invalid_grant');
    await expect(f.engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('receipt deadline is rechecked after awaited connection lookup before disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000;
    const engine = new AuthEngine({ get: async (kind, id) => { const result = await f.store.get(kind, id); if (kind === 'connection') { now = 1010; } return result; }, transact: f.store.transact.bind(f.store) }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    await expect(engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('strict policy has a single refresh winner without a receipt retry exception', async () => {
    const f = setup(0); await f.seed(); const original = await f.exchange();
    const request = { client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token };
    const outcomes = await Promise.allSettled([f.engine.refresh(request), f.engine.refresh(request)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(f.engine.refresh(request)).rejects.toThrow('invalid_grant');
});
test('a subsequent rotation during receipt connection lookup prevents stale receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let rotate = true;
    const engine = new AuthEngine({ get: async (kind, id) => { const record = await f.store.get(kind, id); if (kind === 'connection' && rotate) { rotate = false; await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: next.refresh_token }); } return record; }, transact: f.store.transact.bind(f.store) }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('revocation during receipt connection lookup prevents receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let revoke = true;
    const engine = new AuthEngine({ get: async (kind, id) => { const record = await f.store.get(kind, id); if (kind === 'connection' && revoke) { revoke = false; await f.engine.revoke(next.refresh_token, f.client); } return record; }, transact: f.store.transact.bind(f.store) }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('receipt deadline is rechecked after the atomic authorization check completes', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000; let checks = 0;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write);
        if (write.puts.length === 0) { checks++; now = 1010; }
        return result;
    } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    expect(checks).toBe(1);
    await expect(engine.verifyAccess(next.access_token)).rejects.toThrow('invalid_token');
});
test('connection expiry during the atomic receipt check prevents disclosure', async () => {
    const f = setup(); await f.seed();
    await f.store.transact({ conditions: [{ kind: 'connection', id: 'account', revision: 0 }], puts: [{ ...f.connection, revision: 1, expiresAt: 1005 }], operationId: randomId() });
    const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let now = 1000;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write); if (write.puts.length === 0) { now = 1005; } return result;
    } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('grant and presented token expiry during the atomic receipt check prevents disclosure', async () => {
    const f = setup(); await f.seed();
    let now = 1000;
    const mintEngine = new AuthEngine(f.store, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', accessSeconds: 1, grantSeconds: 5, refreshRetrySeconds: 10 }, () => now);
    const code = await mintEngine.issueCode({ client: f.client, connectionId: 'account', redirectUri: 'https://client.example/callback', resource: mintEngine.resource, scopes: ['profile'], challenge: digest(f.verifier) });
    const original = await mintEngine.exchange({ client: f.client, code, verifier: f.verifier, redirectUri: 'https://client.example/callback', resource: mintEngine.resource });
    await mintEngine.refresh({ client: f.client, resource: mintEngine.resource, refreshToken: original.refresh_token });
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        const result = await f.store.transact(write); if (write.puts.length === 0) { now = 1005; } return result;
    } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', accessSeconds: 1, grantSeconds: 5, refreshRetrySeconds: 10 }, () => now);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
});
test('receipt check temporary failure stays temporary and later recovery uses a fresh operation ID', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    const next = await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    const operationIds: string[] = []; let fail = true;
    const engine = new AuthEngine({ get: f.store.get.bind(f.store), transact: async write => {
        if (write.puts.length === 0) { operationIds.push(write.operationId); if (fail) { fail = false; throw new TemporaryUnavailable(); } }
        return f.store.transact(write);
    } }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    const request = { client: f.client, resource: engine.resource, refreshToken: original.refresh_token };
    await expect(engine.refresh(request)).rejects.toThrow(TemporaryUnavailable);
    expect(await engine.refresh(request)).toEqual(next);
    expect(operationIds).toHaveLength(2); expect(operationIds[0]).not.toBe(operationIds[1]);
});
test('reconnect during receipt connection lookup prevents old-generation receipt disclosure', async () => {
    const f = setup(); await f.seed(); const original = await f.exchange();
    await f.engine.refresh({ client: f.client, resource: f.engine.resource, refreshToken: original.refresh_token });
    let reconnect = true;
    const engine = new AuthEngine({ get: async (kind, id) => {
        const record = await f.store.get(kind, id);
        if (kind === 'connection' && reconnect) {
            reconnect = false;
            await f.engine.connectOrReconnect({ accountId: 'account', credentials: { accessToken: 'reconnected-token', profile: { id: 'account' }, issuedAt: 1000 }, expiresAt: 999999, expectedCredentialGeneration: 1 });
        }
        return record;
    }, transact: f.store.transact.bind(f.store) }, f.crypto, { validate: async () => 'valid' }, { issuer: 'https://auth.example', refreshRetrySeconds: 10 }, () => 1000);
    await expect(engine.refresh({ client: f.client, resource: engine.resource, refreshToken: original.refresh_token })).rejects.toThrow('invalid_grant');
    const connection = await f.store.get('connection', 'account');
    expect(connection?.kind === 'connection' && connection.credentialGeneration).toBe(2);
});
