import assert from 'node:assert/strict';
import { handler } from '../dist/handler.mjs';

assert.equal(Number(process.versions.node.split('.')[0]), 26, 'Smoke test must execute under Node 26');
const event = (path, headers = {}) => ({
    version: '2.0', routeKey: '$default', rawPath: path, rawQueryString: '', headers: { host: 'example.lambda-url.us-west-2.on.aws', ...headers },
    requestContext: { accountId: 'local', apiId: 'local', domainName: 'example.lambda-url.us-west-2.on.aws', domainPrefix: 'local', requestId: 'smoke', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0, http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'node-smoke' } },
    isBase64Encoded: false,
});
const health = await handler(event('/healthz'), {});
assert.equal(health.statusCode, 200);
assert.equal(JSON.parse(health.body).service, 'wildduck-mcp');
const mail = await handler(event('/mcp', { authorization: 'Bearer fabricated', 'x-access-token': 'fabricated' }), {});
assert.equal(mail.statusCode, 503, 'Unimplemented authentication must fail closed');
assert.equal((await handler(event('/readyz'), {})).statusCode, 503);
