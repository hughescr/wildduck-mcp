import { remainingRequestTimeMs } from '../request-budget';
import { MailError } from './contracts';

/** A read-only verification GET is retried once only while this much of the request is left: transport keeps 2 s back for the ledger
 * writes after it, and a second read needs room of its own. */
export const VERIFY_RETRY_MIN_REMAINING_MS = 5000;
/** A read-only verification GET that runs after a mutation was sent: one transient failure there would turn a change that
 * happened into an unknown outcome. Retried once, only for temporarily_unavailable or upstream_timeout and only while the
 * request budget has VERIFY_RETRY_MIN_REMAINING_MS left. Never wrap a mutating request in this. */
export async function verifyRead<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
        if (!(error instanceof MailError) || error.code !== 'temporarily_unavailable' && error.code !== 'upstream_timeout') { throw error; }
        const remaining = remainingRequestTimeMs();
        if (remaining !== undefined && remaining < VERIFY_RETRY_MIN_REMAINING_MS) { throw error; }
        return read();
    }
}
