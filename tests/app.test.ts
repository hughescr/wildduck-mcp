import { expect, test } from 'bun:test';
import type { LambdaEvent, LambdaContext } from '@hono/aws-lambda';
import { createApp } from '../src/app';
import { handler } from '../src/handler';
import { loadConfig } from '../src/config';
export function lambdaEvent(path: string, method = 'GET', body?: string): Extract<LambdaEvent, { rawPath: string }> {
    const url = new URL(path, 'https://service.example');
    return { version: '2.0', routeKey: '$default', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: 'service.example', 'content-type': 'application/json' }, requestContext: { accountId: 'test', apiId: 'test', authentication: null, authorizer: {}, domainName: 'service.example', domainPrefix: 'example', requestId: 'test', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0, http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' } }, isBase64Encoded: false, body: body ?? null };
}
test('unconfigured production Lambda fails closed without consulting AWS', async () => {
    expect((await handler(lambdaEvent('/healthz'), {} as LambdaContext)).statusCode).toBe(200);
    for (const path of ['/readyz', '/mcp', '/authorize', '/.well-known/oauth-authorization-server']) { expect((await handler(lambdaEvent(path), {} as LambdaContext)).statusCode).toBe(503); }
});
test('configured discovery and missing bearer need no secret access', async () => {
    const app = createApp({ config: { publicBaseUrl: 'https://service.example' }, runtime: async () => { throw new Error('must not load'); } });
    expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(200);
    const result = await app.request('/mcp'); expect(result.status).toBe(401); expect(result.headers.get('www-authenticate')).toContain('https://service.example/.well-known/oauth-protected-resource/mcp');
});
test('oversized MCP bodies are bounded', async () => { expect((await createApp().request('/mcp', { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024 + 1) })).status).toBe(413); });
test.each(['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=value'])('reject unsafe issuer %s', value => { expect(() => loadConfig({ PUBLIC_BASE_URL: value })).toThrow(); });
