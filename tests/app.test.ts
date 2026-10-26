import { describe, expect, test } from 'bun:test';
import type { LambdaEvent, LambdaContext } from '@hono/aws-lambda';

type FunctionUrlEvent = Extract<LambdaEvent, { rawPath: string }>;
import { createApp } from '../src/app';
import { handler } from '../src/handler';
import { loadConfig } from '../src/config';

function lambdaEvent(path: string, method = 'GET', body?: string): FunctionUrlEvent {
    return {
        version: '2.0', routeKey: '$default', rawPath: path, rawQueryString: '',
        headers: { host: 'example.lambda-url.us-west-2.on.aws', 'content-type': 'application/json' },
        requestContext: {
            accountId: 'test', apiId: 'test', authentication: null, authorizer: {}, domainName: 'example.lambda-url.us-west-2.on.aws', domainPrefix: 'example',
            requestId: 'test', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0,
            http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        },
        isBase64Encoded: false,
        body: body ?? null,
    };
}

describe('production Lambda adapter', () => {
    test('health and readiness distinguish a deployed scaffold from a usable mail service', async () => {
        const health = await handler(lambdaEvent('/healthz'), {} as LambdaContext);
        expect(health.statusCode).toBe(200);
        expect(JSON.parse(health.body ?? '{}')).toMatchObject({ service: 'wildduck-mcp', status: 'scaffold' });
        expect(health.headers?.['cache-control']).toBe('no-store');
        expect((await handler(lambdaEvent('/readyz'), {} as LambdaContext)).statusCode).toBe(503);
    });

    test.each(['GET', 'POST', 'DELETE'])('%s /mcp cannot bypass missing OAuth using supplied credentials', async (method) => {
        const event = lambdaEvent('/mcp', method, '{}');
        event.headers['authorization'] = 'Bearer fabricated-user-token';
        event.headers['x-access-token'] = 'fabricated-upstream-token';
        const result = await handler(event, {} as LambdaContext);
        expect(result.statusCode).toBe(503);
        expect(result.body).not.toContain('fabricated');
    });

    test('oversized MCP request is rejected before authentication', async () => {
        const response = await createApp({ verify: () => { throw new Error('Authentication must not be reached'); } }).request('/mcp', {
            method: 'POST', body: 'x'.repeat(1024 * 1024 + 1),
        });
        expect(response.status).toBe(413);
    });

    test('unimplemented OAuth endpoints are not advertised as an identity provider', async () => {
        const app = createApp();
        const results = await Promise.all(['/authorize', '/token', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource'].map((path) => app.request(path)));
        expect(results.map((result) => result.status)).toEqual([404, 404, 404, 404]);
    });
});

describe('verified authentication seam', () => {
    test('invalid access token returns a bearer challenge', async () => {
        const response = await createApp({ verify: async () => ({ status: 'invalid' }) }).request('/mcp');
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    });

    test('a verified request reaches the official stateless JSON MCP transport', async () => {
        const app = createApp({ verify: async () => ({ status: 'verified', connection: { connectionId: 'test', accountId: 'mailbox-test' } }) });
        const response = await app.request('/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_service_info']);
        expect(response.headers.get('mcp-session-id')).toBeNull();
    });
});

test.each(['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?secret=value'])('public origin rejects unsafe configuration: %s', (publicBaseUrl) => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: publicBaseUrl })).toThrow();
});
