import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const stack = JSON.parse(execFileSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', process.env.STACK_NAME ?? 'wildduck-mcp-prod', '--output', 'json'], { encoding: 'utf8' }));
const base = stack.Stacks[0].Outputs.find((entry) => entry.OutputKey === 'ApiLambdaFunctionUrl')?.OutputValue;
assert.ok(base, 'Function URL missing from stack outputs');
const health = await fetch(new URL('/healthz', base));
assert.equal(health.status, 200);
assert.equal((await health.json()).service, 'wildduck-mcp');
const mcp = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(mcp.status, 503, 'Scaffold must not expose mailbox access before OAuth exists');
