/** Regression for hono GHSA-h7mg-cq63-vhpq (fixed in 4.13.16): RegExpRouter skipped wildcard middleware for
 * some route sets and for paths holding an encoded line terminator. src/app.ts depends on three
 * app.use('*', ...) layers (secure headers, cache/referrer headers, CORS), so every registered
 * route and a set of odd paths must still run all of them. */
import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';

const app = createApp({ config: { publicBaseUrl: 'https://service.example' }, runtime: async () => undefined });
/** The CORS layer's own rule: these exact paths and everything under /.well-known/. */
const corsPath = (path: string): boolean => ['/register', '/token', '/revoke', '/mcp'].includes(path) || path.startsWith('/.well-known/');

function expectLayers(response: Response, label: string): void {
    // Layer 1: secureHeaders (referrerPolicy off, so layer 2 owns Referrer-Policy).
    expect([label, response.headers.get('x-content-type-options')]).toEqual([label, 'nosniff']);
    expect([label, response.headers.get('x-frame-options')]).toEqual([label, 'SAMEORIGIN']);
    expect([label, response.headers.get('strict-transport-security')]).toEqual([label, 'max-age=15552000; includeSubDomains']);
    expect([label, response.headers.get('cross-origin-opener-policy')]).toEqual([label, 'same-origin']);
    // Layer 2: cache and referrer headers.
    expect([label, response.headers.get('cache-control')]).toEqual([label, 'no-store']);
    expect([label, response.headers.get('referrer-policy')]).toEqual([label, 'no-referrer']);
}
/** Layer 3 ran iff the response carries (or deliberately lacks) its CORS headers for the decoded path. */
function expectCors(response: Response, label: string, expected: boolean): void {
    expect([label, response.headers.get('access-control-allow-origin')]).toEqual([label, expected ? '*' : null]);
    expect([label, response.headers.get('access-control-expose-headers')]).toEqual([label, expected ? 'WWW-Authenticate' : null]);
}

describe('wildcard middleware covers the whole route set', () => {
    // Every concrete path the app registers, read from the router rather than a hand-kept list.
    const registered = [...new Set(app.routes.filter(route => route.path !== '/*').map(route => route.path.replace(':step', 'x')))].sort();

    test('the registered route set is the one these tests expect to cover', () => {
        expect(registered).toEqual(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/auth/x', '/authorize', '/healthz', '/mcp', '/readyz', '/register', '/revoke', '/token']);
    });
    test.each(['GET', 'POST', 'DELETE', 'PUT'])('every registered route answers %s through all three layers', async method => {
        for (const path of registered) {
            const response = await app.request(path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
            expectLayers(response, `${method} ${path}`);
            expectCors(response, `${method} ${path}`, corsPath(path));
        }
    });
    test('OPTIONS preflight on every registered route is answered by the CORS layer, still behind layers 1 and 2', async () => {
        for (const path of registered) {
            const response = await app.request(path, { method: 'OPTIONS' });
            expect([path, response.status]).toEqual([path, 204]);
            expectLayers(response, `OPTIONS ${path}`);
            expect([path, response.headers.get('access-control-allow-origin')]).toEqual([path, '*']);
            expect([path, response.headers.get('access-control-allow-headers')]).toEqual([path, 'Authorization, Content-Type, MCP-Protocol-Version']);
            expect([path, response.headers.get('access-control-allow-methods')]).toEqual([path, 'GET, POST, DELETE, OPTIONS']);
        }
    });
});

describe('wildcard middleware covers non-matching and odd paths', () => {
    // [path as sent, whether the CORS layer must tag it]. Hono routes on the decoded path, so
    // '/mcp%0A' is '/mcp\n': not '/mcp' (no CORS, 404), while '/.well-known/' anything is tagged.
    // '/%2e%2e/mcp' is normalised to '/mcp' by the URL parser before Hono sees it.
    const odd: [string, boolean][] = [
        ['/', false], ['/nope', false], ['/nope/deeper/still', false], ['//mcp', false], ['/mcp/', false], ['/mcp/extra', false], ['/MCP', false], ['/healthz/', false],
        ['/mcp%0A', false], ['/mcp%0D', false], ['/mcp%0D%0A', false], ['/mcp%0a', false], ['/token%0A', false], ['/healthz%0A', false], ['/%0A', false], ['/%0D', false], ['/%0A%0D', false], ['/authorize%0A', false],
        ['/.well-known/%0A', true], ['/.well-known/oauth-authorization-server%0A', true], ['/.well-known/oauth-protected-resource%0D%0A/mcp', true], ['/.well-known/nothing', true],
        ['/auth', false], ['/auth/', false], ['/auth/x%0A', false], ['/mcp%2F', false], ['/%2e%2e/mcp', true], ['/mcp;x', false], ['/mcp%00', false], ['/%', false],
    ];
    test.each(odd)('%s runs every layer', async (path, cors) => {
        for (const method of ['GET', 'POST', 'OPTIONS']) {
            const response = await app.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
            expectLayers(response, `${method} ${path}`);
            if (method === 'OPTIONS') { expect([path, response.status]).toEqual([path, 204]); expect([path, response.headers.get('access-control-allow-origin')]).toEqual([path, '*']); }
            else { expectCors(response, `${method} ${path}`, cors); }
        }
    });
    test('a path with an encoded line terminator that matches no route is the JSON 404, not a bare router miss', async () => {
        for (const path of ['/mcp%0A', '/%0D%0A', '/healthz%0A']) {
            const response = await app.request(path);
            expect([path, response.status]).toEqual([path, 404]);
            expect(await response.json()).toEqual({ error: 'not_found' });
        }
    });
    test('the body limit still applies on /mcp alongside the wildcard layers', async () => {
        const response = await app.request('/mcp', { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024 + 1) });
        expect(response.status).toBe(413);
        // bodyLimit is registered before the CORS layer and answers without calling next(), so only layers 1 and 2 are asserted.
        expectLayers(response, 'POST /mcp (oversize)');
    });
});
