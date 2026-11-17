/** Test support: memory bounds measured inside a spawned child process, which reports its own
 * figures (see memoryViolations), and the child-side snippet that collects them. */
import { execFileSync } from 'node:child_process';

/** Memory figures, all in KiB, reported by the child process itself. */
export interface ChildMemory {
    /** process.resourceUsage().maxRSS before the measured work. */
    before: number;
    /** process.resourceUsage().maxRSS after the measured work. */
    after: number;
    /** process.memoryUsage().rss (current, not peak) after the measured work. */
    rss: number;
    /** Linux only: VmHWM from /proc/self/status, the child's own peak RSS. */
    hwm?: number;
}
/**
 * Decide whether a child stayed under `limit` KiB; returns the violated rules (empty = pass).
 *
 * Why not just assert on maxRSS: on Linux ru_maxrss is inherited across fork/exec from the
 * parent's RSS at spawn time (verified: a child of a 377 MB bun parent reports maxRSS 377 MB
 * while its current RSS is 12 MB), so the number can reflect the test runner, not the child.
 * macOS does not inherit it. Units are KiB on both platforms in Bun.
 *
 * Rules, strictest first:
 *  1. Current RSS after the work must be under the limit; the parent cannot inflate it.
 *  2. If /proc gave the child's own high-water mark (Linux), it must be under the limit. This is
 *     the real peak check and is immune to inheritance (it comes from the new process image).
 *  3. Without that, if maxRSS rose during the child's life (after > before) the rise is the
 *     child's own peak, so it must be under the limit. If it did not rise, the value is either
 *     below the limit (so passes) or an inherited value at or above it. The latter hides the
 *     child's own peak anywhere below the inherited value, so the peak cannot be proven here and
 *     only rule 1 applies; a child that peaked and shrank back inside that window is covered
 *     only by the parent-side ps poll. This gap does not exist where /proc is available.
 */
export function memoryViolations({ before, after, rss, hwm }: ChildMemory, limit: number): string[] {
    const violations: string[] = [];
    if (!(rss < limit)) { violations.push(`current rss ${rss} KiB >= ${limit}`); }
    if (hwm !== undefined) {
        if (!(hwm < limit)) { violations.push(`own peak rss ${hwm} KiB >= ${limit}`); }
    } else if (after > before) {
        if (!(after < limit)) { violations.push(`maxRSS rose to ${after} KiB (from ${before}) >= ${limit}`); }
    }
    return violations;
}
/** The child's own peak: VmHWM where /proc exists (Linux), else the maxRSS it reports. */
export const childPeak = (memory: ChildMemory) => memory.hwm ?? memory.after;
/** Child-side source: `usage()` and `ownPeak()` as the parent's ChildMemory expects them. */
export const CHILD_MEMORY_SOURCE = `
    import { readFileSync } from 'node:fs';
    const usage = () => ({ maxRSS: process.resourceUsage().maxRSS, rss: Math.round(process.memoryUsage().rss / 1024) });
    const ownPeak = () => { try { const match = /^VmHWM:\\s+(\\d+) kB/m.exec(readFileSync('/proc/self/status', 'utf8')); return match ? Number(match[1]) : undefined; } catch { return undefined; } };
`;
/** Runs `script` in a child bun with a heap hint of `ramBytes`, polling its RSS (best effort: ps may
 * be missing or denied) and killing it past `killKiB` or after `deadlineMs`; returns its stdout. */
export async function runChild(script: string, options: { readonly ramBytes: number; readonly killKiB: number; readonly deadlineMs: number; readonly stdin?: Blob }): Promise<{ exceeded: boolean; timedOut: boolean; status: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: options.stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_JSC_forceRAMSize: String(options.ramBytes) } });
    let exceeded = false; let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill(); }, options.deadlineMs);
    const monitor = setInterval(() => {
        try {
            const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
            if (rss > options.killKiB) { exceeded = true; child.kill(); }
        } catch { /* ps can race a normally exiting child. */ }
    }, 20);
    const status = await child.exited;
    clearInterval(monitor); clearTimeout(deadline);
    return { exceeded, timedOut, status, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
