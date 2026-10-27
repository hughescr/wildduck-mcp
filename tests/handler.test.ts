import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createLambdaHandler, MAX_LAMBDA_PAYLOAD_BYTES } from '../src/handler';
import { lambdaEvent } from './app.test';

test('serialized request bound counts escaping/metadata before any application work', async () => {
    let calls = 0; const app = new Hono(); app.post('/mcp', context => { calls++; return context.json({ ok: true }); }); const invoke = createLambdaHandler(app);
    const escaped = lambdaEvent('/mcp', 'POST', '"'.repeat(MAX_LAMBDA_PAYLOAD_BYTES / 2));
    expect(Buffer.byteLength(escaped.body ?? '')).toBeLessThan(5 * 1024 * 1024);
    const denied = await invoke(escaped); expect(denied.statusCode).toBe(413); expect(JSON.parse(denied.body).error).toBe('payload_too_large'); expect(calls).toBe(0);
    const headerHeavy = lambdaEvent('/mcp', 'POST', '{}'); headerHeavy.headers.authorization = 'private-test-token'; headerHeavy.cookies = ['x='.padEnd(MAX_LAMBDA_PAYLOAD_BYTES, 'a')];
    const deniedHeaders = await invoke(headerHeavy); expect(deniedHeaders.statusCode).toBe(413); expect(deniedHeaders.body).not.toContain('private-test-token'); expect(calls).toBe(0);
});
test('encoded event bodies are counted and ordinary attachment-size JSON still reaches app', async () => {
    let calls = 0; const app = new Hono(); app.post('/mcp', async context => { calls++; return context.json({ bytes: (await context.req.arrayBuffer()).byteLength }); }); const invoke = createLambdaHandler(app);
    const encoded = lambdaEvent('/mcp', 'POST', Buffer.alloc(4_500_001).toString('base64')); encoded.isBase64Encoded = true;
    expect((await invoke(encoded)).statusCode).toBe(413); expect(calls).toBe(0);
    const size = 2 * 1024 * 1024; const ordinary = lambdaEvent('/mcp', 'POST', JSON.stringify({ attachment: Buffer.alloc(size).toString('base64') }));
    const accepted = await invoke(ordinary); expect(accepted.statusCode).toBe(200); expect(JSON.parse(accepted.body).bytes).toBe(Buffer.byteLength(ordinary.body ?? '')); expect(calls).toBe(1);
});
test('serialized response bound prevents silent omission and counts escaped JSON bodies', async () => {
    const app = new Hono(); app.get('/large', context => context.json({ labels: '"'.repeat(1_600_000), private: 'private-response-data' })); app.get('/small', context => { context.header('Set-Cookie', 'safe=value; Secure; HttpOnly'); return context.json({ ok: true }); });
    const invoke = createLambdaHandler(app); const denied = await invoke(lambdaEvent('/large'));
    expect(denied.statusCode).toBe(502); expect(JSON.parse(denied.body).error).toBe('response_too_large'); expect(denied.body).toContain('no data was silently dropped'); expect(denied.body).toContain('identical operation_id'); expect(denied.body).not.toContain('private-response-data'); expect(Buffer.byteLength(JSON.stringify(denied))).toBeLessThan(MAX_LAMBDA_PAYLOAD_BYTES);
    const ordinary = await invoke(lambdaEvent('/small')); expect(ordinary.statusCode).toBe(200); expect(JSON.parse(ordinary.body)).toEqual({ ok: true }); expect(ordinary.cookies).toEqual(['safe=value; Secure; HttpOnly']);
});
