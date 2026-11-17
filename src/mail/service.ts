import { randomUUID } from 'node:crypto';
import { DEFAULT_THROTTLE_TIMEOUT_MS, RESPONSE_RESERVE_MS } from '../dynamo-retry';
import { remainingRequestTimeMs, withRequestBudget } from '../request-budget';
import { digest, randomId } from '../auth/crypto';
import { MailError, ATTACHMENT_UPLOAD_KEY_PREFIX, type AttachmentUploadRecord, type CanonicalReadMessage, type ActivationProof, type AuthoredSourceDescriptor, type SourceGrade, type AttachmentDownloadLink, type MessageSourceDownloadLink, type AttachmentDownload, type AttachmentUploadLink, type AttachmentUploadStager, type AttachmentUploadStore, type BackendMailSession, type DraftMailSession, type ConfirmedReceipt, type FailedReceipt, type MailBackendReader, type MailBackendWriter, type MailContext, type MailInput, type MailOperationMarker, type MailOperationRecord, type MailOperationStore, type MailOutput, type MailService, type MailToolName, type MailWriteTool, type MessageKey, type MessageRef, type MessageSnapshot, type OperationClaim, type OperationKey, type PreparedDraft, type ReservationResult, type UnknownReceipt, type WriteIntent } from './contracts';
import { batchSummary, errorText } from './summary';
import { activationProofSchema, draftContentSchema, failureReasonSchema, mailboxSchema, mailInputSchemas, mailOperationMarkerSchema, mailOutputSchemas, canonicalReadMessageOutputSchema, attachmentDownloadLinkSchema, messageSourceDownloadLinkSchema, attachmentUploadLinkSchema, UPLOAD_TTL_SECONDS, messageKeySchema, messageRefSchema, MAX_BATCH_BYTES, BATCH_CONCURRENCY } from './schemas';

/** uploads is optional so deployments without an upload bucket still serve every other tool;
 * create_attachment_upload then fails closed with temporarily_unavailable. */
interface Dependencies { reader: MailBackendReader; writer: MailBackendWriter; operations: MailOperationStore; uploads?: { store: AttachmentUploadStore; stager: AttachmentUploadStager } }
type WriteInput = MailInput<MailWriteTool>;
type ReadTool = Exclude<MailToolName, MailWriteTool | 'read_attachment' | 'get_attachment_download' | 'get_message_source_download' | 'read_messages' | 'create_attachment_upload'>;
/** Copying an attachment of a stored message reads mail, so it needs mail:read as well as mail:draft. */
const copiesMailboxAttachment = (parsed: WriteInput) => 'attachments' in parsed && (parsed.attachments ?? []).some(item => 'source' in item);
type Verification = 'verified' | 'pending' | 'outcome_unknown' | 'unverified';
interface Provenance { verification: Verification; source?: AuthoredSourceDescriptor }
const temporary = () => new MailError('temporarily_unavailable');
/** What a write keeps back for after its preflight. Its preflight (inspection, provenance, a source download,
 * attachment resolution, composition) runs in a window that ends this long before the request does, under a request
 * budget of its own, so every WildDuck and DynamoDB call in it ends by then, and a hard stop at its end fails
 * whatever is still running as upstream_timeout. Every ledger call, the reservation included, runs on the full
 * request budget: a narrowed one could abort a reservation DynamoDB has committed and leave it reserved for good.
 * Worst case for a 25 MiB create or update in the Lambda's 60 s, each step clamped to the live request (WildDuck
 * transports keep 2 s back, DynamoDB RESPONSE_RESERVE_MS):
 *  - before: authentication, getOperation and the Drafts lookup (a DynamoDB operation 5 s, 10 s once throttled;
 *    WildDuck 10 s), normally well under 1 s. The window then ends at 40 s with ~39 s of it left.
 *  - admission: a write reserves only with at least RESERVE_ADMISSION_MS (10 s) of the window left, i.e. at least
 *    30 s of the request; otherwise it fails temporarily_unavailable with nothing stored. Even a getOperation
 *    throttled for its whole 10 s plus a 10 s Drafts lookup leaves 20 s of window, so only a request that has
 *    already lost 30 s before reserving is refused.
 *  - reserve, at most 10 s, so it ends by the window's end with at least 20 s of the request left. A reservation
 *    whose outcome is unknown is read back once, on what is left beyond SETTLEMENT_RESERVE_MS (12 s), so at least
 *    8 s, ending by request end - 14 s; if this call provably owns it, failPreflight then starts with at least 12 s
 *    and settles it as a failure (see write()).
 *  - window, to request end - 20 s: for an update the inspection, provenance and the 25 MiB source (~5 s at 5 MiB/s);
 *    attachment resolution, ending RESOLVE_RESERVE_MS (5 s) before the window and after RESOLVE_MAX_MS (30 s) at
 *    most; then composing (~2 s) and an update's identity and reference reads. A window already closed when the
 *    reservation returns fails at once as upstream_timeout, before any backend call.
 *  - after, at least 20 s: failPreflight (one store operation, 10 s throttled + 2 s response = 12 s), or
 *    markDispatched (the same 12 s throttled, ~0.1 s healthy) then the upload (~5 s plus ~2 s for WildDuck to store
 *    it), the read-back (~1 s JSON, ~5 s source), an update's original check and delete (~1 s), complete and the
 *    response: ~15 s with DynamoDB healthy. After a throttled markDispatched what runs out is already dispatched and
 *    ends outcome_unknown: never left reserved, never a false failure.
 * Sized for the default throttle budget (DEFAULT_THROTTLE_TIMEOUT_MS); a test checks it covers one plus the response. */
export const PREFLIGHT_RESERVE_MS = 20_000;
/** The longest a reservation can take: one store operation's throttle budget, which bounds all its reads and its
 * transaction together and is at least its unthrottled timeout (at most 5 s). Derived from, and so only exact for,
 * the default the runtime's DynamoMailOperationStore uses; a store given a longer throttleTimeoutMs can overrun the
 * window, and its preflight is then cut off at once and its failure recorded on what is left of the request. */
export const RESERVE_ADMISSION_MS = DEFAULT_THROTTLE_TIMEOUT_MS;
/** Kept back for settling an owned reservation whose outcome was unknown: failPreflight throttled for its whole
 * budget, plus the response. Its read-back runs under a request budget that ends this long before the request does. */
const SETTLEMENT_RESERVE_MS = DEFAULT_THROTTLE_TIMEOUT_MS + RESPONSE_RESERVE_MS;
function sanitized(error: unknown): MailError {
    const code = error instanceof MailError ? failureReasonSchema.safeParse(error.code) : undefined;
    return code?.success ? new MailError(code.data, error instanceof MailError ? error.retryAfter : undefined, error instanceof MailError ? { cause: error.searchCause, status: error.upstreamStatus } : undefined) : temporary();
}
function stable(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
/** The arguments a payload digest covers: everything except operationId. The digest keeps the
 * 0.6 key name expected_version, so it is unchanged by the 0.7 rename and an identical retry of a
 * delete, send, move or flag change recorded by 0.6 still replays its stored outcome. */
function digestedPayload(parsed: WriteInput): Record<string, unknown> {
    const { operationId: _operationId, ...payload } = parsed;
    if (!('expectedVersion' in payload)) { return payload; }
    const { expectedVersion, ...rest } = payload;
    return { ...rest, expected_version: expectedVersion };
}
function session(context: MailContext, scope: string): BackendMailSession {
    if (!context || typeof context.accountId !== 'string' || !/^[a-f0-9]{24}$/u.test(context.accountId) || typeof context.accessToken !== 'string' || !/^[a-fA-F0-9]{40}$/u.test(context.accessToken) || typeof context.clientId !== 'string' || context.clientId.length < 1 || context.clientId.length > 16384 || !Array.isArray(context.scopes) || !context.scopes.every(value => typeof value === 'string')) { throw new MailError('forbidden'); }
    if (context.connectionStatus !== 'active') { throw new MailError('reconnect_required'); }
    if (!context.scopes.includes(scope)) { throw new MailError('forbidden'); }
    return { accountId: context.accountId, accessToken: context.accessToken };
}
function input<Name extends MailToolName>(tool: Name, raw: unknown): MailInput<Name> {
    const result = mailInputSchemas[tool].safeParse(raw);
    if (!result.success) { throw new MailError('invalid_input'); }
    return result.data as MailInput<Name>;
}
function output<Name extends MailToolName>(tool: Name, raw: unknown): MailOutput<Name> {
    const result = mailOutputSchemas[tool].safeParse(raw);
    if (!result.success) { throw temporary(); }
    return result.data as MailOutput<Name>;
}
const sameKey = (left: OperationKey, right: OperationKey) => left.accountId === right.accountId && left.clientIdHash === right.clientIdHash && left.operationId === right.operationId;
const sameMessage = (left: MessageKey, right: MessageKey) => left.mailboxId === right.mailboxId && left.uid === right.uid;
function matches(record: MailOperationRecord, key: OperationKey, tool: MailWriteTool, parsed: WriteInput, payloadDigest: string): boolean {
    if (!sameKey(record.key, key) || !sameKey(record.intent, key) || record.intent.tool !== tool || record.intent.payloadDigest !== payloadDigest) { return false; }
    if (tool === 'create_draft' || tool === 'create_reply_draft') { return record.intent.tool === tool; }
    return 'uid' in parsed && record.intent.tool !== 'create_draft' && record.intent.tool !== 'create_reply_draft' && record.intent.target.uid === parsed.uid && record.intent.expectedVersion === parsed.expectedVersion && /^[a-f0-9]{24}$/u.test(record.intent.target.mailboxId) && (!('mailboxId' in parsed) || record.intent.target.mailboxId === parsed.mailboxId);
}
function receipt(tool: MailWriteTool, record: MailOperationRecord): MailOutput<MailWriteTool> {
    if (record.state === 'reserved') { return output(tool, { status: 'in_progress', operationId: record.key.operationId }); }
    if (record.state === 'dispatched') { return output(tool, { status: 'outcome_unknown', operationId: record.key.operationId, reason: 'dispatch_uncertain' }); }
    if (record.state !== 'settled' || record.receipt.operationId !== record.key.operationId) { throw temporary(); }
    if (!['completed', 'queued', 'partial', 'failed', 'outcome_unknown'].includes(record.receipt.status)) { throw temporary(); }
    return output(tool, record.receipt);
}
function proof(accountId: string, message: MessageRef, contentDigest: string, sourceGrade: SourceGrade): ActivationProof {
    const result = activationProofSchema.safeParse({ accountId, ...message, contentDigest, sourceGrade });
    if (!result.success) { throw temporary(); }
    return result.data;
}

function projectMessage(message: CanonicalReadMessage, includeHtml: boolean): MailOutput<'read_message'> {
    const { html: _html, htmlTruncated: _htmlTruncated, htmlRepresentation: _htmlRepresentation, ...textOnly } = message;
    return includeHtml ? { ...message, htmlOmitted: false } : { ...textOnly, htmlOmitted: true };
}

/** Every mutation has a durable receipt and an account-wide message fence. */
export function createMailService({ reader, writer, operations, uploads }: Dependencies): MailService {
    async function provenance(bound: BackendMailSession, target: MessageKey, rawMarker: MailOperationMarker): Promise<Provenance> {
        const parsed = mailOperationMarkerSchema.safeParse(rawMarker);
        if (!parsed.success || parsed.data.accountId !== bound.accountId) { return { verification: 'unverified' }; }
        const marker = parsed.data;
        const record = await operations.getOperation({ accountId: marker.accountId, clientIdHash: marker.clientIdHash, operationId: marker.operationId });
        if (!record || !sameKey(record.key, marker) || !sameKey(record.intent, marker) || record.intent.tool !== marker.tool || record.intent.payloadDigest !== marker.payloadDigest) { return { verification: 'unverified' }; }
        if (record.state === 'reserved') { return { verification: 'pending' }; }
        if (record.state === 'dispatched') { return { verification: 'outcome_unknown' }; }
        const result = receipt(marker.tool, record);
        if (result.status === 'outcome_unknown') { return { verification: 'outcome_unknown' }; }
        // Submission changes MIME. A real Sent identity activates the marker but
        // never inherits authored-byte provenance from the submitted draft.
        if (result.status === 'queued') { return { verification: result.sent && sameMessage(result.sent, target) ? 'verified' : 'unverified' }; }
        if ('proof' in result && result.proof.accountId === bound.accountId && sameMessage(result.proof, target)) {
            const active = result.status === 'completed' || (result.status === 'partial' && result.candidateVerified && ['original_deletion_failed', 'original_deletion_unconfirmed'].includes(result.reason));
            if (active) {
                // Only the parsed durable receipt grants this descriptor. Fresh
                // snapshot versions and upstream markers cannot author legacy mail.
                const source = result.proof.sourceGrade === 'mcp_authored' ? {
                    grade: 'mcp_authored' as const, accountId: bound.accountId,
                    mailboxId: target.mailboxId, uid: target.uid, contentDigest: result.proof.contentDigest,
                } : undefined;
                return { verification: 'verified', ...(source ? { source } : {}) };
            }
        }
        return { verification: 'unverified' };
    }
    async function inspect(bound: BackendMailSession, target: MessageKey, expectedVersion: string, requireDraft: boolean): Promise<{ snapshot: MessageSnapshot; source?: AuthoredSourceDescriptor }> {
        const snapshot = await writer.inspectMessage(bound, target);
        const message = messageRefSchema.parse(snapshot.message);
        if (!sameMessage(message, target) || typeof snapshot.isDraft !== 'boolean' || typeof snapshot.hasHtml !== 'boolean' || typeof snapshot.hasAttachments !== 'boolean' || typeof snapshot.hasRecipients !== 'boolean') { throw temporary(); }
        const trusted = snapshot.marker ? await provenance(bound, target, snapshot.marker) : undefined;
        if (trusted && trusted.verification !== 'verified') { throw new MailError('verification_failed'); }
        if (message.version !== expectedVersion) { throw new MailError('version_conflict'); }
        if (requireDraft && !snapshot.isDraft) { throw new MailError('unsupported_draft'); }
        return { snapshot, ...(trusted?.source ? { source: trusted.source } : {}) };
    }
    async function readFullMessage(bound: BackendMailSession, target: MessageKey): Promise<CanonicalReadMessage> {
        const read = await reader.readMessage(bound, target);
        if (!sameMessage(read.message, target)) { throw temporary(); }
        const { managedOperation: _managedOperation, ...message } = read.message;
        const result = read.marker ? { ...message, managedOperation: { operationId: mailOperationMarkerSchema.parse(read.marker).operationId, verification: (await provenance(bound, message, read.marker)).verification } } : message;
        return canonicalReadMessageOutputSchema.parse(result);
    }
    async function read<Name extends ReadTool>(tool: Name, context: MailContext, raw: unknown): Promise<MailOutput<Name>> {
        const bound = session(context, 'mail:read'); const parsed = input(tool, raw);
        try {
            let result: unknown;
            switch (tool) {
                case 'list_mailboxes': result = await reader.listMailboxes(bound); break;
                case 'list_messages': result = await reader.listMessages(bound, parsed as MailInput<'list_messages'>); break;
                case 'get_thread': {
                    const data = parsed as MailInput<'get_thread'>; const inherited = remainingRequestTimeMs(); const deadline = performance.now() + Math.min(inherited ?? 47000, 47000);
                    result = await withRequestBudget(() => Math.max(0, deadline - performance.now()), async () => {
                        const page = output('get_thread', await reader.getThread(bound, data));
                        return data.includeBodies && page.messages.length > 0 ? { ...page, bodies: await batch(context, { includeHtml: true, messages: page.messages.map(({ mailboxId, uid }) => ({ mailboxId, uid })) }, false) } : page;
                    }); break;
                }
                case 'search_messages': result = await reader.searchMessages(bound, parsed as MailInput<'search_messages'>); break;
                case 'read_message': {
                    const data = parsed as MailInput<'read_message'>;
                    result = projectMessage(await readFullMessage(bound, { mailboxId: data.mailboxId, uid: data.uid }), data.includeHtml);
                    break;
                }
            }
            return output(tool, result);
        } catch (error) { throw sanitized(error); }
    }
    /** The read_messages result: byteBudget and bytesReturned describe the exact JSON returned, summary included.
     * Nested in get_thread (standalone false) it has no summary and counts only itself; the thread's own summary sits outside it. */
    async function batch(context: MailContext, raw: MailInput<'read_messages'>, standalone: boolean): Promise<MailOutput<'read_messages'>> {
        const bound = session(context, 'mail:read'); const parsed = input('read_messages', raw);
        type Item = MailOutput<'read_messages'>['results'][number];
        const inherited = remainingRequestTimeMs(); const deadline = performance.now() + Math.min(inherited ?? 32000, 32000);
        return withRequestBudget(() => Math.max(0, deadline - performance.now()), async () => {
        const results: Item[] = []; let next = 0;
        const failure = (key: MessageKey, error: unknown): Item => { const safe = sanitized(error); return { status: 'failed', ...key, error: { code: safe.code, message: errorText(safe.code, 'read_messages'), ...(safe.retryAfter === undefined ? {} : { retryAfter: safe.retryAfter }) } }; };
        // The summary is first, as in the JSON the client receives, and is worked out from the items it describes.
        const envelope = (items: Item[], bytesReturned: number) => { const summary = standalone ? batchSummary(items) : undefined; return { ...summary === undefined ? {} : { summary }, includeHtml: parsed.includeHtml, results: items, byteBudget: MAX_BATCH_BYTES as typeof MAX_BATCH_BYTES, bytesReturned }; };
        const size = (value: object) => Buffer.byteLength(JSON.stringify(value));
        // Reserve every failure slot and the envelope before dispatch. Replace slots in
        // input order so asynchronous completion cannot change which message fits.
        // Each proposal is measured whole, with the summary of exactly its items and the
        // widest bytesReturned (seven digits), so the state kept always fits and the final result does too.
        const reserved = parsed.messages.map(key => failure(key, new MailError('too_large')));
        for (let start = 0; start < parsed.messages.length; start += BATCH_CONCURRENCY) {
            const keys = parsed.messages.slice(start, start + BATCH_CONCURRENCY);
            const group = await Promise.all(keys.map(async key => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const available = deadline - performance.now() - 2000; if (available <= 0) { throw new MailError('upstream_timeout'); }
                    const message = await Promise.race([readFullMessage(bound, key), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MailError('upstream_timeout')), available); })]);
                    return { status: 'ok' as const, message: projectMessage(message, parsed.includeHtml) };
                } catch (error) { return failure(key, error); } finally { if (timer !== undefined) { clearTimeout(timer); } }
            }));
            for (const candidate of group) {
                const fallback = reserved[next]; if (!fallback) { throw temporary(); }
                const proposed = [...results, candidate, ...reserved.slice(next + 1)];
                results.push(size(envelope(proposed, MAX_BATCH_BYTES)) <= MAX_BATCH_BYTES ? candidate : fallback); next++;
            }
        }
        const result = output('read_messages', envelope(results, 0));
        // Fixed point includes the decimal accounting field itself.
        for (let i = 0; i < 4; i++) { result.bytesReturned = size(result); }
        if (size(result) !== result.bytesReturned || result.bytesReturned > MAX_BATCH_BYTES) { throw temporary(); }
        return result;
        });
    }
    async function downloadLink(context: MailContext, raw: MailInput<'get_attachment_download'>): Promise<AttachmentDownloadLink> {
        const bound = session(context, 'mail:read'); const parsed = input('get_attachment_download', raw);
        try {
            const result = attachmentDownloadLinkSchema.parse(await reader.getAttachmentDownload(bound, parsed));
            if (!sameMessage(result.metadata, parsed) || result.metadata.attachmentId !== parsed.attachmentId) { throw temporary(); }
            return result;
        } catch (error) { throw sanitized(error); }
    }
    async function sourceDownloadLink(context: MailContext, raw: MailInput<'get_message_source_download'>): Promise<MessageSourceDownloadLink> {
        const bound = session(context, 'mail:read'); const parsed = input('get_message_source_download', raw);
        try {
            const result = messageSourceDownloadLinkSchema.parse(await reader.getMessageSourceDownload(bound, parsed));
            if (!sameMessage(result.metadata, parsed)) { throw temporary(); }
            return result;
        } catch (error) { throw sanitized(error); }
    }
    async function attachment(context: MailContext, raw: MailInput<'read_attachment'>): Promise<AttachmentDownload> {
        const bound = session(context, 'mail:read'); const parsed = input('read_attachment', raw);
        try {
            const result = await reader.readAttachment(bound, parsed);
            const metadata = output('read_attachment', result.metadata);
            if (!sameMessage(metadata, parsed) || metadata.attachmentId !== parsed.attachmentId || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== metadata.size) { throw temporary(); }
            return { metadata, bytes: new Uint8Array(result.bytes) };
        } catch (error) { throw sanitized(error); }
    }
    async function write(tool: MailWriteTool, context: MailContext, raw: WriteInput): Promise<MailOutput<MailWriteTool>> {
        // Derived once: the window ends PREFLIGHT_RESERVE_MS before the request; without a request budget there is none.
        const inherited = remainingRequestTimeMs(); const preflightEnd = inherited === undefined ? undefined : performance.now() + inherited - PREFLIGHT_RESERVE_MS;
        const windowLeft = () => preflightEnd === undefined ? Infinity : Math.max(0, preflightEnd - performance.now());
        /** fn under the window's own request budget, cut off at its end whatever fn still awaits; not started once it has closed. */
        const inWindow = <T>(fn: () => Promise<T>): Promise<T> => preflightEnd === undefined ? fn() : withRequestBudget(windowLeft, async () => {
            if (windowLeft() <= 0) { throw new MailError('upstream_timeout'); }
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { return await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new MailError('upstream_timeout')); }, windowLeft()); })]); }
            finally { if (timer !== undefined) { clearTimeout(timer); } }
        });
        const scope = tool === 'send_draft' ? 'mail:send' : tool === 'move_message' || tool === 'update_message_flags' ? 'mail:modify' : 'mail:draft';
        const bound = session(context, scope); if (tool === 'create_reply_draft') { session(context, 'mail:read'); } const parsed = input(tool, raw);
        if (copiesMailboxAttachment(parsed)) { session(context, 'mail:read'); }
        const key: OperationKey = { accountId: bound.accountId, clientIdHash: digest(context.clientId), operationId: parsed.operationId };
        const drafting: DraftMailSession = { ...bound, clientIdHash: key.clientIdHash };
        const payloadDigest = digest(stable({ accountId: bound.accountId, tool, input: digestedPayload(parsed) }));
        const marker: MailOperationMarker = { ...key, payloadDigest, tool };
        const conflict = (reason: 'operation_conflict' | 'draft_fenced') => output(tool, { status: 'conflict', operationId: key.operationId, reason });
        const checkedReplay = (record: MailOperationRecord) => matches(record, key, tool, parsed, payloadDigest) ? receipt(tool, record) : conflict('operation_conflict');
        let existing: MailOperationRecord | undefined;
        try { existing = await operations.getOperation(key); } catch (error) { throw sanitized(error); }
        if (existing) { return checkedReplay(existing); }
        let mailboxId: string;
        try {
            if (tool === 'move_message' || tool === 'update_message_flags') { mailboxId = (parsed as MailInput<'move_message'>).mailboxId; }
            else {
                const mailbox = mailboxSchema.parse(await writer.resolveDraftMailbox(bound));
                if (mailbox.specialUse !== '\\Drafts') { throw new MailError('unsupported_draft'); }
                mailboxId = mailbox.mailboxId;
            }
        } catch (error) { throw sanitized(error); }
        const intent: WriteIntent = tool === 'create_draft' || tool === 'create_reply_draft' ? { ...key, payloadDigest, tool } : {
            ...key, payloadDigest, tool, target: { mailboxId, uid: (parsed as MailInput<'send_draft'>).uid }, expectedVersion: (parsed as MailInput<'send_draft'>).expectedVersion,
        };
        const ownerToken = randomId(); let claim: OperationClaim<'reserved'>;
        // Admission: reserve only if even the slowest reservation ends by the window's end, so its outcome can always be
        // recorded after it; nothing is stored otherwise. The reservation itself runs on the full request budget.
        if (windowLeft() < RESERVE_ADMISSION_MS) { throw temporary(); }
        let reservation: ReservationResult;
        try { reservation = await operations.reserve(intent, ownerToken); } catch (error) {
            // The transaction may have committed. Only a stored reservation carrying this call's fresh ownerToken proves it
            // did, and only that one is settled, as a durable failure that releases its guard; it is never carried on into
            // a preflight, so this path cannot dispatch and needs no admission of its own. failPreflight's owner and
            // revision compare-and-set, not this read, keeps it from touching anything else. No record, a failed read
            // or another owner proves nothing (a commit may still land after this read): the outcome stays unknown.
            // The settlement has priority: the read-back ends SETTLEMENT_RESERVE_MS before the request, or is skipped.
            const left = remainingRequestTimeMs(); const readBackEnd = left === undefined ? undefined : performance.now() + left - SETTLEMENT_RESERVE_MS;
            const readBackLeft = () => readBackEnd === undefined ? Infinity : Math.max(0, readBackEnd - performance.now());
            if (readBackLeft() <= 0) { throw sanitized(error); }
            let record: MailOperationRecord | undefined;
            try { record = await (readBackEnd === undefined ? operations.getOperation(key) : withRequestBudget(readBackLeft, () => operations.getOperation(key))); } catch { throw sanitized(error); }
            if (!record || record.state !== 'reserved' || record.ownerToken !== ownerToken || !matches(record, key, tool, parsed, payloadDigest)) { throw sanitized(error); }
            const failed: FailedReceipt = { status: 'failed', operationId: key.operationId, reason: 'temporarily_unavailable' };
            try { await operations.failPreflight({ key, ownerToken, revision: record.revision, state: 'reserved' }, failed); } catch { throw temporary(); }
            return output(tool, failed);
        }
        try {
            if (reservation.kind === 'conflict') { return conflict(reservation.reason); }
            if (reservation.kind === 'replay') { return checkedReplay(reservation.record); }
            claim = reservation.claim;
            if (claim.state !== 'reserved' || !sameKey(claim.key, key) || claim.ownerToken !== ownerToken || !Number.isSafeInteger(claim.revision) || claim.revision < 0) { throw temporary(); }
        } catch (error) { throw sanitized(error); }
        let source: AuthoredSourceDescriptor | undefined; let snapshot: MessageSnapshot | undefined; let prepared: PreparedDraft | undefined;
        try {
            // Returned, not assigned: work cut off by the window's end can never change what follows.
            ({ source, snapshot, prepared } = await inWindow(async () => {
                let source: AuthoredSourceDescriptor | undefined; let snapshot: MessageSnapshot | undefined; let prepared: PreparedDraft | undefined;
                if (intent.tool !== 'create_draft' && intent.tool !== 'create_reply_draft') {
                    const inspected = await inspect(bound, intent.target, intent.expectedVersion, tool !== 'move_message' && tool !== 'update_message_flags');
                    snapshot = inspected.snapshot; source = inspected.source;
                    if ((tool === 'update_draft' || tool === 'send_draft') && !source) { throw new MailError('unsupported_content'); }
                    if (source && ['send_draft', 'move_message', 'update_message_flags'].includes(tool)) { await writer.verifyAuthoredSource(bound, snapshot, source); }
                    if (tool === 'send_draft' && !snapshot.hasRecipients) { throw new MailError('no_recipients'); }
                }
                if (tool === 'create_reply_draft') {
                    if (!writer.prepareReply) { throw temporary(); }
                    prepared = await writer.prepareReply(drafting, parsed as MailInput<'create_reply_draft'>, marker);
                } else if (tool === 'create_draft') {
                    const { operationId: _id, ...content } = parsed as MailInput<'create_draft'>;
                    prepared = await writer.prepareCreate(drafting, draftContentSchema.parse(content), marker);
                } else if (tool === 'update_draft' && snapshot && source) {
                    const { operationId: _id, uid: _uid, expectedVersion: _version, ...patch } = parsed as MailInput<'update_draft'>;
                    prepared = await writer.prepareUpdate(drafting, snapshot, patch, marker, source);
                }
                if ((tool === 'create_draft' || tool === 'create_reply_draft' || tool === 'update_draft') && !prepared) { throw temporary(); }
                if (prepared && (prepared.mailboxId !== mailboxId || stable(mailOperationMarkerSchema.parse(prepared.marker)) !== stable(marker) || !/^[a-f0-9]{64}$/u.test(prepared.mime.sha256))) { throw temporary(); }
                return { source, snapshot, prepared };
            }));
        } catch (error) {
            // Outside the window: the full request budget, at least PREFLIGHT_RESERVE_MS of it, records the failure.
            const failed: FailedReceipt = { status: 'failed', operationId: key.operationId, reason: sanitized(error).code };
            try { await operations.failPreflight(claim, failed); } catch { throw temporary(); }
            return output(tool, failed);
        }
        const unknown: UnknownReceipt = { status: 'outcome_unknown', operationId: key.operationId, reason: 'dispatch_uncertain' };
        async function saved(): Promise<MailOutput<MailWriteTool> | undefined> {
            try { const record = await operations.getOperation(key); if (record && record.state === 'settled' && matches(record, key, tool, parsed, payloadDigest)) { return receipt(tool, record); } } catch { /* No durable outcome can be proved. */ }
            return undefined;
        }
        async function uncertain(dispatched?: OperationClaim<'dispatched'>): Promise<MailOutput<MailWriteTool>> {
            const known = await saved(); if (known) { return known; }
            if (dispatched) {
                try { await operations.markOutcomeUnknown(dispatched, unknown); } catch { /* Existing fence remains in place. */ }
                const settled = await saved(); if (settled) { return settled; }
            }
            return output(tool, unknown);
        }
        let dispatched: OperationClaim<'dispatched'>;
        try {
            dispatched = await operations.markDispatched(claim);
            if (dispatched.state !== 'dispatched' || !sameKey(dispatched.key, key) || dispatched.ownerToken !== ownerToken || !Number.isSafeInteger(dispatched.revision) || dispatched.revision <= claim.revision) { return uncertain(); }
        } catch {
            try {
                const record = await operations.getOperation(key);
                if (record && matches(record, key, tool, parsed, payloadDigest)) {
                    if (record.state === 'settled') { return receipt(tool, record); }
                    if (record.state === 'dispatched' && record.ownerToken === ownerToken) { return uncertain({ key, ownerToken, revision: record.revision, state: 'dispatched' }); }
                }
            } catch { /* Explicit uncertainty without dispatching. */ }
            return output(tool, unknown);
        }
        async function finish(result: unknown): Promise<MailOutput<MailWriteTool>> {
            const validated = output(tool, result);
            await operations.complete(dispatched, validated as ConfirmedReceipt);
            return validated;
        }
        try {
            if ((tool === 'create_draft' || tool === 'create_reply_draft' || tool === 'update_draft') && prepared) {
                const candidate = messageKeySchema.parse(await writer.uploadPreparedDraft(bound, prepared));
                if (candidate.mailboxId !== mailboxId || (intent.tool !== 'create_draft' && intent.tool !== 'create_reply_draft' && sameMessage(candidate, intent.target))) { throw temporary(); }
                let verified: MessageRef;
                try {
                    verified = messageRefSchema.parse(await writer.verifyPreparedDraft(bound, candidate, prepared));
                    if (!sameMessage(candidate, verified)) { throw temporary(); }
                } catch {
                    return await finish({ status: 'partial', operationId: key.operationId, candidate, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
                }
                const activation = proof(bound.accountId, verified, prepared.mime.sha256, 'mcp_authored');
                if (intent.tool === 'create_draft' || intent.tool === 'create_reply_draft') { return await finish({ status: 'completed', operationId: key.operationId, draft: verified, verified: true, proof: activation }); }
                try { await inspect(bound, intent.target, intent.expectedVersion, true); } catch (error) {
                    return await finish({ status: 'partial', operationId: key.operationId, candidate: verified, candidateVerified: true, proof: activation, reason: error instanceof MailError && error.code === 'version_conflict' ? 'original_version_changed' : 'original_verification_failed', originalDeletion: 'not_attempted' });
                }
                try { await writer.deleteDraft(bound, intent.target); } catch (error) {
                    const confirmedFailure = error instanceof MailError && ['forbidden', 'not_found', 'unsupported_draft'].includes(error.code);
                    return await finish({ status: 'partial', operationId: key.operationId, candidate: verified, candidateVerified: true, proof: activation, reason: confirmedFailure ? 'original_deletion_failed' : 'original_deletion_unconfirmed', originalDeletion: confirmedFailure ? 'failed' : 'unconfirmed' });
                }
                return await finish({ status: 'completed', operationId: key.operationId, draft: verified, verified: true, proof: activation, previousDeleted: true });
            }
            if (intent.tool === 'create_draft' || intent.tool === 'create_reply_draft' || !snapshot) { throw temporary(); }
            if (tool === 'delete_draft') {
                await writer.deleteDraft(bound, intent.target);
                return await finish({ status: 'completed', operationId: key.operationId, deleted: intent.target });
            }
            if (tool === 'send_draft') {
                if (!source) { throw temporary(); }
                const stamped = messageRefSchema.parse(await writer.stampSendMarker(bound, snapshot, marker, source));
                if (!sameMessage(stamped, intent.target)) { throw temporary(); }
                const result = await writer.submitDraft(bound, intent.target);
                return await finish({ status: 'queued', operationId: key.operationId, queueId: result.queueId, ...(result.sent === undefined ? {} : { sent: messageKeySchema.parse(result.sent) }) });
            }
            const mutation = tool === 'move_message'
                ? await writer.moveMessage(bound, snapshot, (parsed as MailInput<'move_message'>).destinationMailboxId, marker, source)
                : await writer.updateMessageFlags(bound, snapshot, parsed as MailInput<'update_message_flags'>, marker, source);
            const message = messageRefSchema.parse(mutation.message);
            if (tool === 'move_message' ? message.mailboxId !== (parsed as MailInput<'move_message'>).destinationMailboxId : !sameMessage(message, intent.target)) { throw temporary(); }
            if (source ? mutation.sourceGrade !== 'mcp_authored' || mutation.contentDigest !== source.contentDigest : mutation.sourceGrade !== 'observed') { throw temporary(); }
            return await finish({ status: 'completed', operationId: key.operationId, message, verified: true, proof: proof(bound.accountId, message, mutation.contentDigest, mutation.sourceGrade) });
        } catch { return uncertain(dispatched); }
    }
    /** Not a write tool: no operationId and no ledger. Each call stages a new upload record bound to
     * this account and OAuth client (digest(context.clientId)), expiring after UPLOAD_TTL_SECONDS. */
    async function attachmentUpload(context: MailContext, raw: MailInput<'create_attachment_upload'>): Promise<AttachmentUploadLink> {
        const bound = session(context, 'mail:draft'); const parsed = input('create_attachment_upload', raw);
        if (!uploads) { throw temporary(); }
        try {
            // Owner fields come only from the verified context. One conditional write per call (the table has one write unit per
            // second), then a signature that needs no database access: no read, no second write.
            const uploadId = randomUUID();
            const record: AttachmentUploadRecord = { accountId: bound.accountId, clientIdHash: digest(context.clientId), uploadId, sizeBytes: parsed.sizeBytes, sha256: parsed.sha256, objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + uploadId, expiresAt: Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS };
            await uploads.store.createUpload(record);
            const { url, expiresAt, method, headers } = await uploads.stager.presign(record);
            // A link must never outlive the upload it feeds.
            if (typeof expiresAt !== 'string' || !(Date.parse(expiresAt) <= record.expiresAt * 1000)) { throw temporary(); }
            return attachmentUploadLinkSchema.parse({ metadata: { uploadId, sizeBytes: record.sizeBytes, sha256: record.sha256, expiresAt, method, headers }, url });
        } catch (error) { throw sanitized(error); }
    }
    return {
        list_mailboxes: (context, raw) => read('list_mailboxes', context, raw),
        list_messages: (context, raw) => read('list_messages', context, raw),
        search_messages: (context, raw) => read('search_messages', context, raw),
        read_message: (context, raw) => read('read_message', context, raw),
        read_attachment: attachment,
        get_attachment_download: downloadLink,
        get_message_source_download: sourceDownloadLink,
        get_thread: (context, raw) => read('get_thread', context, raw),
        read_messages: (context, raw) => batch(context, raw, true),
        create_attachment_upload: attachmentUpload,
        create_reply_draft: (context, raw) => write('create_reply_draft', context, raw) as Promise<MailOutput<'create_reply_draft'>>,
        create_draft: (context, raw) => write('create_draft', context, raw) as Promise<MailOutput<'create_draft'>>,
        update_draft: (context, raw) => write('update_draft', context, raw) as Promise<MailOutput<'update_draft'>>,
        delete_draft: (context, raw) => write('delete_draft', context, raw) as Promise<MailOutput<'delete_draft'>>,
        send_draft: (context, raw) => write('send_draft', context, raw) as Promise<MailOutput<'send_draft'>>,
        move_message: (context, raw) => write('move_message', context, raw) as Promise<MailOutput<'move_message'>>,
        update_message_flags: (context, raw) => write('update_message_flags', context, raw) as Promise<MailOutput<'update_message_flags'>>,
    };
}
