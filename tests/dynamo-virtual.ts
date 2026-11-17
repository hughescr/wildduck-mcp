import { spyOn } from 'bun:test';
import type { DynamoRetryEnv } from '../src/dynamo-retry';

/** A clock that only moves when the store sleeps: retries take no real time and every delay is recorded.
 * random 1 gives the longest jitter (the full cap of each step), 0 none. */
export function virtualRetry(random = 1, start = 0) {
    const clock = { ms: start }; const sleeps: number[] = [];
    const retry: DynamoRetryEnv = { now: () => clock.ms, sleep: async (ms: number) => { sleeps.push(ms); clock.ms += ms; }, random: () => random };
    return { clock, sleeps, retry };
}
/** performance.now, the clock of a write's preflight window, moved forward by `skew` ms (a step that took that long,
 * without waiting for it), or held still at `frozen` for exact boundaries. Restore it after the test. */
export function steppedClock() {
    const real = performance.now.bind(performance); const state: { skew: number; frozen?: number | undefined } = { skew: 0 };
    const spy = spyOn(performance, 'now').mockImplementation(() => state.frozen ?? real() + state.skew);
    return { state, restore: () => { spy.mockRestore(); } };
}
/** Captures the structured console.warn diagnostics (and keeps them out of the test output). */
export function captureWarnings() {
    const lines: Record<string, unknown>[] = [];
    const spy = spyOn(console, 'warn').mockImplementation((line?: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); });
    return { lines, restore: () => { spy.mockRestore(); } };
}
export const throttleError = (name = 'ProvisionedThroughputExceededException') => Object.assign(new Error('throttled'), { name });
export const cancelled = (...codes: string[]) => ({ name: 'TransactionCanceledException', CancellationReasons: codes.map(Code => ({ Code })) });
