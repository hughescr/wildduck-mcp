import { BatchGetCommand, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { remainingRequestTimeMs } from './request-budget';

export type DynamoCommand = GetCommand | BatchGetCommand | PutCommand | TransactWriteCommand;
export interface DynamoSender {
    send(command: DynamoCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}
export type DynamoStoreName = 'mail' | 'auth' | 'upload';
/** Injectable so tests need no real waiting: the clock, the sleep and the jitter source. */
export interface DynamoRetryEnv { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number }
export function retryEnv(env: Partial<DynamoRetryEnv> | undefined): DynamoRetryEnv {
    return { now: env?.now ?? (() => Date.now()), sleep: env?.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); })), random: env?.random ?? Math.random };
}

/** The table is deliberately 1 RCU / 1 WCU, so throttling is expected under bursts and must be ridden out, not
 * failed on: full-jitter exponential backoff from 200 ms, capped at 1.6 s per wait, until the call's budget ends. */
export const THROTTLE_BASE_MS = 200;
export const THROTTLE_CAP_MS = 1600;
/** A call that was never throttled keeps its short timeout (a stalled SDK call is aborted then). Once DynamoDB has
 * reported throttling, the call may wait this long in total (counted from the start of the store operation), while
 * three such store operations in one request still fit the Lambda's 60 s with room for WildDuck. Both deadlines, short and throttled, are clamped to the live request time minus RESPONSE_RESERVE_MS when
 * the handler supplies one, and no request is sent once that is spent; without a request budget (tests, local dev)
 * neither is clamped. The write tools keep PREFLIGHT_RESERVE_MS (mail/service.ts) for one such throttled ledger
 * write after their preflight, and reserve only with this whole budget left before it (RESERVE_ADMISSION_MS); that
 * is where the whole timeline is written down. */
export const DEFAULT_THROTTLE_TIMEOUT_MS = 10_000;
export const MAX_THROTTLE_TIMEOUT_MS = 50_000;
/** Kept back from the request for the response itself: 2 s of the Lambda's 60 s, so a clamp only bites at the very
 * end of a request (authentication runs at its start, with nearly all of it left). */
export const RESPONSE_RESERVE_MS = 2000;
/** Short retries for other transient errors: after 25 ms, then 50 ms (unchanged from before throttling awareness). */
const TRANSIENT_RETRIES = 2;
const THROTTLE_ERRORS = new Set(['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded']);
const THROTTLE_REASONS = new Set(['ThrottlingError', 'ProvisionedThroughputExceeded']);
/** Never worth repeating: the outcome cannot change (a failed condition) or the token was reused with another payload. */
const FINAL_ERRORS = new Set(['ConditionalCheckFailedException', 'IdempotentParameterMismatchException']);

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function reasonCodes(error: Record<string, unknown>): string[] | undefined {
    return error.name === 'TransactionCanceledException' && Array.isArray(error.CancellationReasons) ? error.CancellationReasons.map(reason => object(reason) ? String(reason.Code) : '') : undefined;
}
/** DynamoDB throttling: the three documented exception names, or a cancelled transaction whose reasons include a throttle
 * and no failed condition (a ConditionalCheckFailed alongside is a real conflict or ambiguity, never "just throttled"). */
export function isThrottled(error: unknown): boolean {
    if (!object(error)) { return false; }
    if (typeof error.name === 'string' && THROTTLE_ERRORS.has(error.name)) { return true; }
    const codes = reasonCodes(error);
    return codes !== undefined && !codes.includes('ConditionalCheckFailed') && codes.some(code => THROTTLE_REASONS.has(code));
}
/** A proven conditional cancellation: every reason is None/ConditionalCheckFailed and at least one is the latter. */
export function conditionalConflict(error: unknown, count: number): boolean {
    if (!object(error)) { return false; }
    const codes = reasonCodes(error);
    return codes !== undefined && codes.length === count && codes.every(code => code === 'None' || code === 'ConditionalCheckFailed') && codes.includes('ConditionalCheckFailed');
}
function operationOf(command: DynamoCommand): 'get' | 'batch_get' | 'put' | 'transact' {
    return command instanceof TransactWriteCommand ? 'transact' : command instanceof BatchGetCommand ? 'batch_get' : command instanceof PutCommand ? 'put' : 'get';
}

/** The time one store operation may take (it can span several sends). Starts with the short timeout and, as soon as
 * DynamoDB reports throttling, grows to the throttle budget; either way never past the live request deadline. */
export class DynamoBudget {
    private throttled = false;
    constructor(private readonly start: number, private readonly softMs: number, private readonly hardMs: number, private readonly env: DynamoRetryEnv) {}
    get deadline(): number {
        const soft = this.start + this.softMs;
        const own = this.throttled ? Math.max(soft, this.start + this.hardMs) : soft; const remaining = remainingRequestTimeMs();
        return remaining === undefined ? own : Math.min(own, this.env.now() + remaining - RESPONSE_RESERVE_MS);
    }
    markThrottled(): void { this.throttled = true; }
}

export interface DynamoRetrierOptions {
    store: DynamoStoreName; client: DynamoSender; unavailable: () => Error; env: DynamoRetryEnv;
    timeoutMs: number; throttleTimeoutMs: number;
    /** Whether errors other than throttling get the short 25 ms / 50 ms retries for this command. */
    retryTransient: (command: DynamoCommand) => boolean;
}
/** The one retry policy of all DynamoDB stores. A retried TransactWrite is the same command object, so it carries the
 * same ClientRequestToken and can never apply twice (DynamoDB honours a token for ten minutes; every budget here is
 * far shorter). A conditional conflict is returned to the caller untouched and never retried. */
export class DynamoRetrier {
    constructor(private readonly options: DynamoRetrierOptions) {}
    begin(): DynamoBudget { return new DynamoBudget(this.options.env.now(), this.options.timeoutMs, this.options.throttleTimeoutMs, this.options.env); }
    private log(operation: ReturnType<typeof operationOf>, attempt: number): void {
        // eslint-disable-next-line no-console -- Deliberate fixed-literal diagnostic: no ids, keys, tokens or error text; evidence of throttling for capacity decisions.
        try { console.warn(JSON.stringify({ event: 'dynamodb_throttled', store: this.options.store, operation, attempt })); } catch { /* Diagnostics must not alter results. */ }
    }
    private async pause(budget: DynamoBudget, throttles: number): Promise<void> {
        const { env } = this.options;
        const wait = Math.floor(env.random() * Math.min(THROTTLE_CAP_MS, THROTTLE_BASE_MS * 2 ** (throttles - 1)));
        await env.sleep(Math.max(0, Math.min(wait, budget.deadline - env.now())));
        if (budget.deadline <= env.now()) { throw this.options.unavailable(); }
    }
    /** For keys a BatchGetItem left unprocessed (DynamoDB's partial throttling): the same logged, jittered wait. */
    async unprocessed(budget: DynamoBudget, attempt: number): Promise<void> {
        budget.markThrottled(); this.log('batch_get', attempt);
        await this.pause(budget, attempt);
    }
    async send(command: DynamoCommand, budget: DynamoBudget): Promise<unknown> {
        const { client, env, unavailable } = this.options;
        let throttles = 0; let transients = 0;
        for (let attempt = 1; ; attempt++) {
            const left = budget.deadline - env.now();
            if (left <= 0) { throw unavailable(); }
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined; let stalled = false;
            try {
                return await Promise.race([client.send(command, { abortSignal: controller.signal }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { stalled = true; controller.abort(); reject(unavailable()); }, left); })]);
            } catch (error) {
                clearTimeout(timer); // The attempt is over; the timer must not fire during the backoff below.
                if (stalled || (command instanceof TransactWriteCommand && conditionalConflict(error, command.input.TransactItems?.length ?? 0)) || (object(error) && typeof error.name === 'string' && FINAL_ERRORS.has(error.name))) { throw error; }
                if (isThrottled(error)) {
                    budget.markThrottled(); throttles++; this.log(operationOf(command), attempt);
                    await this.pause(budget, throttles);
                } else {
                    if (transients >= TRANSIENT_RETRIES || !this.options.retryTransient(command)) { throw error; }
                    await env.sleep(25 * 2 ** transients++);
                    if (budget.deadline <= env.now()) { throw unavailable(); }
                }
            } finally { clearTimeout(timer); }
        }
    }
}
