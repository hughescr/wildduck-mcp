import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const stack = JSON.parse(execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', process.env.STACK_NAME ?? 'wildduck-mcp-prod', '--output', 'json'], { encoding: 'utf8', timeout: 30_000 }));
const base = stack.Stacks[0].Outputs.find((entry) => entry.OutputKey === 'ApiLambdaFunctionUrl')?.OutputValue;
assert.ok(base, 'Function URL missing from stack outputs');
const health = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(10_000) });
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { service: 'wildduck-mcp', version, status: 'scaffold' }, 'Live service must serve the checked-out release');
const ready = await fetch(new URL('/readyz', base), { signal: AbortSignal.timeout(10_000) });
assert.equal(ready.status, 503);
assert.deepEqual(await ready.json(), { ready: false, reason: 'oauth_not_implemented' });
const mcp = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
assert.equal(mcp.status, 503, 'Scaffold must not expose mailbox access before OAuth exists');
