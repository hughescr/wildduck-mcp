import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * scripts/deploy.sh deletes published Lambda versions beyond the newest 5 after a successful deploy. These tests run the real
 * script with bash against stub `aws` and `serverless` executables first on PATH: no network, no AWS, nothing outside the temp dir.
 */
const DEPLOY_SH = join(import.meta.dir, '..', 'scripts', 'deploy.sh');
const FUNCTION = 'wildduck-mcp-prod-api';
const root = mkdtempSync(join(tmpdir(), 'deploy-prune-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const AWS_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  'lambda list-aliases')
    if [[ "\${STUB_ALIASES_FAIL:-0}" == 1 ]]; then echo 'An error occurred (AccessDenied)' >&2; exit 254; fi
    cat "$STUB_ALIASES_JSON" ;;
  'lambda list-versions-by-function')
    if [[ "\${STUB_VERSIONS_FAIL:-0}" == 1 ]]; then echo 'An error occurred (AccessDenied)' >&2; exit 254; fi
    cat "$STUB_VERSIONS_TXT" ;;
  'lambda delete-function')
    case " $* " in *" --qualifier \${STUB_FAIL_DELETE:-none} "*) echo 'ResourceConflictException' >&2; exit 254 ;; esac ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

/** `aws lambda list-versions-by-function --output text` prints the version list tab-separated on one line. */
const versionList = (low: number, high: number): string => ['$LATEST', ...Array.from({ length: high - low + 1 }, (_, i) => String(low + i))].join('\t');
const NO_ALIASES = '{"Aliases":[]}';
const PROD_ALIAS_ON_10_ROUTING_12 = `{"Aliases":[{"AliasArn":"arn:aws:lambda:us-west-2:000000000000:function:${FUNCTION}:prod","Name":"prod","FunctionVersion":"10","RoutingConfig":{"AdditionalVersionWeights":{"12":0.1}}}]}`;

interface Scenario { serverlessExit?: number; aliasesFail?: boolean; versionsFail?: boolean; failDelete?: string; versions: string; aliases: string }
interface Outcome { status: number; stdout: string; stderr: string; calls: string[]; deleted: string[]; warnings: string[] }

let counter = 0;
function deploy(scenario: Scenario): Outcome {
    const dir = join(root, `case-${counter += 1}`);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'node_modules', '.bin'), { recursive: true });
    copyFileSync(DEPLOY_SH, join(dir, 'repo', 'scripts', 'deploy.sh'));
    writeFileSync(join(dir, 'bin', 'aws'), AWS_STUB);
    chmodSync(join(dir, 'bin', 'aws'), 0o755);
    const serverless = join(dir, 'repo', 'node_modules', '.bin', 'serverless');
    writeFileSync(serverless, `#!/usr/bin/env bash\necho "serverless $*"\nexit ${scenario.serverlessExit ?? 0}\n`);
    chmodSync(serverless, 0o755);
    writeFileSync(join(dir, 'versions.txt'), `${scenario.versions}\n`);
    writeFileSync(join(dir, 'aliases.json'), `${scenario.aliases}\n`);
    writeFileSync(join(dir, 'calls.log'), '');
    const result = Bun.spawnSync(['bash', 'scripts/deploy.sh'], {
        cwd: join(dir, 'repo'),
        // A clean environment: only the stubs and system tools, and only the variables deploy.sh requires.
        env: {
            PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
            AWS_DEPLOYMENT_BUCKET_NAME: 'stub',
            AWS_EXECUTION_ROLE_ARN: 'stub',
            SERVERLESS_ACCESS_KEY: 'stub',
            AUTH_KEYRING_PARAMETER: '/wildduck-mcp/prod/auth-keyring',
            STUB_LOG: join(dir, 'calls.log'),
            STUB_ALIASES_JSON: join(dir, 'aliases.json'),
            STUB_VERSIONS_TXT: join(dir, 'versions.txt'),
            STUB_ALIASES_FAIL: scenario.aliasesFail ? '1' : '0',
            STUB_VERSIONS_FAIL: scenario.versionsFail ? '1' : '0',
            STUB_FAIL_DELETE: scenario.failDelete ?? 'none',
        },
    });
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(line => line !== '');
    const stderr = result.stderr.toString();
    return {
        status: result.exitCode,
        stdout: result.stdout.toString(),
        stderr,
        calls,
        deleted: calls.filter(call => call.startsWith('lambda delete-function')).map(call => /--qualifier (\S+)/u.exec(call)?.[1] ?? ''),
        warnings: stderr.split('\n').filter(line => line.startsWith('WARNING:')),
    };
}

describe('deploy.sh version pruning', () => {
    test('keeps the newest 5 and deletes the rest, newest first, protecting alias and routing-weight versions', () => {
        const run = deploy({ versions: versionList(1, 28), aliases: PROD_ALIAS_ON_10_ROUTING_12 });
        expect(run.status).toBe(0);
        // 28..24 are the newest 5; 10 (alias) and 12 (routing weight) are protected; everything else is deleted.
        expect(run.deleted).toEqual(['23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13', '11', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
        expect(run.stdout).toContain(`Pruned 21 old ${FUNCTION} versions; kept newest 5 and alias-referenced versions.`);
        expect(run.warnings).toEqual([]);
        expect(run.stderr).toBe('');
    });

    test('uses the function, region and a fixed call shape; never touches $LATEST', () => {
        const run = deploy({ versions: versionList(1, 8), aliases: NO_ALIASES });
        expect(run.calls[0]).toBe(`lambda list-aliases --function-name ${FUNCTION} --region us-west-2 --output json`);
        expect(run.calls[1]).toBe(`lambda list-versions-by-function --function-name ${FUNCTION} --region us-west-2 --query Versions[].Version --output text`);
        expect(run.calls.filter(call => call.startsWith('lambda delete-function'))).toEqual([
            `lambda delete-function --function-name ${FUNCTION} --qualifier 3 --region us-west-2`,
            `lambda delete-function --function-name ${FUNCTION} --qualifier 2 --region us-west-2`,
            `lambda delete-function --function-name ${FUNCTION} --qualifier 1 --region us-west-2`,
        ]);
        expect(run.calls.some(call => call.includes('LATEST'))).toBe(false);
    });

    test('orders versions numerically, not as text (100 outranks 9)', () => {
        const run = deploy({ versions: '$LATEST\t1\t2\t3\t4\t5\t9\t10\t100', aliases: NO_ALIASES });
        expect(run.status).toBe(0);
        // Newest five are 100, 10, 9, 5, 4.
        expect(run.deleted).toEqual(['3', '2', '1']);
    });

    test('a version used only as an alias routing target is kept', () => {
        const run = deploy({ versions: versionList(1, 7), aliases: '{"Aliases":[{"Name":"canary","FunctionVersion":"$LATEST","RoutingConfig":{"AdditionalVersionWeights":{"2":0.5}}}]}' });
        expect(run.status).toBe(0);
        expect(run.deleted).toEqual(['1']);
    });

    test('a version an alias points at is kept even when it is old', () => {
        const run = deploy({ versions: versionList(1, 9), aliases: '{"Aliases":[{"Name":"prod","FunctionVersion":"2"}]}' });
        expect(run.deleted).toEqual(['4', '3', '1']);
    });

    test('exactly 5 numbered versions: nothing is pruned', () => {
        const run = deploy({ versions: versionList(1, 5), aliases: '{"Aliases":[{"Name":"prod","FunctionVersion":"$LATEST"}]}' });
        expect(run.status).toBe(0);
        expect(run.deleted).toEqual([]);
        expect(run.stdout).toContain('Pruned 0 old');
    });

    test('only $LATEST exists: nothing is pruned', () => {
        const run = deploy({ versions: '$LATEST', aliases: NO_ALIASES });
        expect(run.status).toBe(0);
        expect(run.deleted).toEqual([]);
        expect(run.stdout).toContain('Pruned 0 old');
    });

    test('a failed deploy exits non-zero and makes no AWS calls', () => {
        const run = deploy({ serverlessExit: 1, versions: versionList(1, 28), aliases: PROD_ALIAS_ON_10_ROUTING_12 });
        expect(run.status).toBe(1);
        expect(run.calls).toEqual([]);
        expect(run.stderr).toBe('');
        expect(run.stdout).not.toContain('Pruned');
    });

    test('a failed alias listing prints one WARNING, exits 0, and lists and deletes nothing', () => {
        const run = deploy({ aliasesFail: true, versions: versionList(1, 28), aliases: PROD_ALIAS_ON_10_ROUTING_12 });
        expect(run.status).toBe(0);
        expect(run.warnings).toEqual([`WARNING: could not list aliases for ${FUNCTION}; skipped version pruning`]);
        expect(run.calls).toHaveLength(1);
        expect(run.deleted).toEqual([]);
    });

    test('a failed version listing prints one WARNING, exits 0, and deletes nothing', () => {
        const run = deploy({ versionsFail: true, versions: versionList(1, 28), aliases: PROD_ALIAS_ON_10_ROUTING_12 });
        expect(run.status).toBe(0);
        expect(run.warnings).toEqual([`WARNING: could not list versions for ${FUNCTION}; skipped version pruning`]);
        expect(run.deleted).toEqual([]);
    });

    test('a failed delete prints one WARNING, exits 0, and stops there', () => {
        const run = deploy({ failDelete: '5', versions: versionList(1, 28), aliases: PROD_ALIAS_ON_10_ROUTING_12 });
        expect(run.status).toBe(0);
        // Attempts run newest first and stop at the failing one: 21 candidates, 16 deleted, then 5 fails.
        expect(run.deleted).toEqual(['23', '22', '21', '20', '19', '18', '17', '16', '15', '14', '13', '11', '9', '8', '7', '6', '5']);
        expect(run.warnings).toEqual([`WARNING: could not delete ${FUNCTION} version 5; pruned 16 before stopping`]);
        expect(run.stdout).not.toContain('Pruned');
    });
});
