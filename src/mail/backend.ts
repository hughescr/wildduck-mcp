import { createHash, randomUUID } from 'node:crypto';
import { isEmailValid } from '@hapi/address';
import libmime from 'libmime';
import { WILDDUCK_ORIGIN } from '../wildduck';
import { remainingRequestTimeMs, withRequestBudget } from '../request-budget';
import { currentRequestId } from '../request-id';
import { MailError, MAIL_OPERATION_METADATA_KEY, ATTACHMENT_UPLOAD_KEY_PREFIX, type BackendMailSession, type DraftMailSession, type MailBackendReader, type MailBackendWriter, type Mailbox, type MailInput, type MailInputRaw, type MailOutput, type MessageKey, type DraftContent, type DraftPatch, type MessageSnapshot, type PreparedDraft, type MailOperationMarker, type MessageRef, type MessageSummary, type MailAddress, type AttachmentMetadata, type AttachmentDownload, type AttachmentDownloadLink, type MessageSourceDownloadLink, type VerifiedMessageMutation, type AuthoredSourceDescriptor, type AttachmentUploadStore, type AttachmentUploadStager, type AttachmentUploadRecord, type AttachmentSource, type NewAttachment, type ResolvedAttachment } from './contracts';
import { draftContentSchema, namedAddress, mailboxIdSchema, messageKeySchema, mailInputSchemas, mailOutputSchemas, canonicalReadMessageOutputSchema, attachmentDownloadLinkSchema, messageSourceDownloadLinkSchema, mailOperationMarkerSchema, addFlagSchema, labelSchema, attachmentFilenameSchema, attachmentContentTypeSchema, MAX_READ_TEXT_BYTES, MAX_HTML_BYTES, MAX_ATTACHMENT_BYTES, MAX_SNIPPET_BYTES, MAX_SEARCH_TEXT_CHARACTERS, MAX_UPLOAD_BYTES } from './schemas';
import { MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS, SOURCE_DOWNLOAD_TIMEOUT_MS, type AttachmentDownloadStager } from './downloads';
import { deriveReply, sanitizeHeaderText } from './reply';
import { ownedIdentityMatcher } from './identities';
import { createMime, inspectSource, preparePatch, retainedAttachmentBytes, verifyCandidate, attachmentBodyBytes, AMBIGUOUS_INLINE, AUTHORED_LIMITS, MAX_MESSAGE_BYTES, MimeError, type MimeEnvelope } from './mime';
import { renderBody } from './render';

const META_BYTES = 512 * 1024;
// The message JSON (text, HTML and attachment metadata, never attachment content), so it does
// not grow with the 25 MiB message cap; WildDuck itself caps its text and HTML fields.
const MESSAGE_BYTES = 4 * 1024 * 1024;
/** Large bodies (a draft upload, a source or attachment read) get the base timeout plus 1 ms per
 * this many bytes: 1 MiB/s (~8 Mbit/s), a floor below which a transfer counts as stalled, not an
 * estimate of throughput. Always within the request's remaining time. */
const TIMEOUT_BYTES_PER_MS = 1024;
/** Attachment resolution (issue #2) runs under one deadline: what is left of the request less
 * RESOLVE_RESERVE_MS, and never more than RESOLVE_MAX_MS. Called from a write, "the request" is its
 * preflight window, which already ends PREFLIGHT_RESERVE_MS (mail/service.ts, with the whole timeline)
 * before the Lambda's, keeping the upload, read-back and ledger writes. This reserve is only what still
 * follows inside that window once every byte is here, for a 25 MiB message: composing and inspecting
 * it (~2 s) and an update's identity and reference reads, plus margin. get_attachment_download
 * likewise keeps 2 s of its 32 s for its own epilogue. */
const RESOLVE_RESERVE_MS = 5000;
const RESOLVE_MAX_MS = 30_000;
/** Concurrent metadata reads and byte fetches while resolving: a few overlap latency, more would only
 * hold more bytes in memory at once. */
const RESOLVE_CONCURRENCY = 3;
const CLIENT_ID_HASH = /^[A-Za-z0-9_-]{43}$/u;
// The schema's own validators for a final file name and media type, applied to the values a
// source attachment supplies: the rules are those of a caller's value, not a second copy of them.
const ACCOUNT = /^[a-f0-9]{24}$/u;
const TOKEN = /^[a-fA-F0-9]{40}$/u;
const API_EMAIL_OPTIONS = { tlds: false } as unknown as Parameters<typeof isEmailValid>[1];
type Json = Record<string, unknown>;
/** WildDuck's JSON binary validator treats strings as UTF-8, not base64.
 * Multipart keeps RFC822 bytes exact and parses application/json fields into
 * their native types, so the operation marker travels atomically with them. */
class MultipartUpload {
    readonly contentType: string;
    readonly bytes: Buffer<ArrayBuffer>;
    constructor(raw: Buffer, fields: Json) {
        const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`Content-Disposition: form-data; name="${name}"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`));
        const file = Buffer.from('Content-Disposition: form-data; name="raw"; filename="message.eml"\r\nContent-Type: message/rfc822\r\n\r\n');
        let boundary: string;
        do { boundary = `wildduck-mcp-${randomUUID()}`; } while ([...parts, file, raw].some(part => part.includes(boundary)));
        this.contentType = `multipart/form-data; boundary=${boundary}`;
        // One join, so the message is copied once into the request body (at 25 MiB, not twice).
        this.bytes = Buffer.concat([...parts.flatMap(part => [Buffer.from(`--${boundary}\r\n`), part]), Buffer.from(`--${boundary}\r\n`), file, raw, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    }
}
type SearchCategory = import('./contracts').SearchFailureCause;
export interface SearchDiagnostic { requestId?: string; event: 'wildduck_search'; outcome: 'success' | 'failure'; scope: 'global' | 'mailbox'; category?: SearchCategory; durationMs: number; headersMs?: number; bodyMs?: number; validationMs?: number; status?: number; timeoutMs?: number }
type DraftVerificationCheck = 'target' | 'message' | 'mime' | 'draft_state' | 'envelope' | 'metadata' | 'received_at' | 'reference' | 'files' | 'flags' | 'labels';
export interface DraftVerificationDiagnostic { requestId?: string; event: 'wildduck_draft_verification_failed'; check: DraftVerificationCheck; code: 'mime_verification_failed' | 'verification_failed' | 'upstream_failure' }
interface SearchTiming { category: SearchCategory; headersMs?: number; bodyMs?: number; status?: number; timeoutMs?: number }
export interface MailBackendOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number; searchTimeoutMs?: number; dotAsPlus?: boolean; stripReplySuffix?: boolean; downloadStager?: AttachmentDownloadStager; onSearchDiagnostic?: (diagnostic: SearchDiagnostic) => void; onDraftVerificationDiagnostic?: (diagnostic: DraftVerificationDiagnostic) => void;
    /** Staged uploads (issue #2). Without both, uploadId attachments fail closed with temporarily_unavailable. */
    uploadStore?: AttachmentUploadStore; uploadStager?: AttachmentUploadStager }
const fail = (): never => { throw new MailError('temporarily_unavailable'); };
function object(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown): string { return typeof value === 'string' ? value : fail(); }
function count(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : fail(); }
function id(value: unknown): string { return typeof value === 'string' && ACCOUNT.test(value) ? value : fail(); }
function uid(value: unknown): number { const n = count(value); return n >= 1 && n <= 4294967295 ? n : fail(); }
function sessionValid(session: BackendMailSession): void {
    if (!session || typeof session.accountId !== 'string' || !ACCOUNT.test(session.accountId) || typeof session.accessToken !== 'string' || !TOKEN.test(session.accessToken)) { throw new MailError('invalid_input'); }
}
function targetValid(target: MessageKey): void { if (!target || !messageKeySchema.safeParse({ mailboxId: target.mailboxId, uid: target.uid }).success) { throw new MailError('invalid_input'); } }
function strings(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) { return fail(); }
    return value as string[];
}
function json(bytes: Uint8Array): Json {
    try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return object(value) ? value : fail(); }
    catch { return fail(); }
}
function metadata(raw: Json): Json {
    if (raw['metaData'] === undefined || raw['metaData'] === null) { return {}; }
    if (!object(raw['metaData'])) { throw new MailError('unsupported_content'); }
    return raw['metaData'];
}
function markerOf(raw: Json): MailOperationMarker | undefined {
    const data = metadata(raw);
    if (!Object.hasOwn(data, MAIL_OPERATION_METADATA_KEY)) { return undefined; }
    const parsed = mailOperationMarkerSchema.safeParse(data[MAIL_OPERATION_METADATA_KEY]);
    if (!parsed.success) { throw new MailError('verification_failed'); }
    return parsed.data;
}
function mimeError(error: unknown): never {
    if (error instanceof MailError) { throw error; }
    if (error instanceof MimeError) { throw new MailError(error.code === 'mime_limit' ? 'too_large' : error.code === 'mime_verification_failed' ? 'verification_failed' : error.code === 'invalid_attachment' ? 'invalid_input' : 'unsupported_content'); }
    return fail();
}
interface TransportExtra {
    /** Aborts the request (as upstream_timeout), e.g. when attachment resolution stops. */
    readonly signal?: AbortSignal | undefined;
    /** Told the bytes of a 200 body so far (its declared length first); throws to stop the read. */
    readonly meter?: ((bytes: number) => void) | undefined;
}
/** The request's attachments sorted by source, before any I/O. */
interface AttachmentPlan {
    readonly items: readonly NewAttachment[];
    /** contentBase64 bytes by item index, decoded once (the schema proved them canonical). */
    readonly inline: ReadonlyMap<number, Buffer>;
    readonly uploadIds: readonly string[];
    /** Distinct source messages, by mailbox:uid, with the indices of the items that copy from each. */
    readonly messages: ReadonlyMap<string, { readonly target: MessageKey; readonly indices: number[] }>;
}
/** What resolution uses of one source attachment, for the item at its index: the final name and type and the least
 * decoded size (decodedLowerBound). */
interface SourceFile { readonly filename: string; readonly contentType: string; readonly lower: number; readonly exact: boolean }
const messageKeyOf = (key: MessageKey) => `${key.mailboxId}:${key.uid}`;
const sourceKeyOf = (source: AttachmentSource) => `${messageKeyOf(source)}:${source.attachmentId}`;
/** The final file name and type of an attachment by the schema's own rules for a caller's value,
 * the inline text rule included, so a default taken from a source attachment is held to exactly
 * what the caller could have written. */
function authoredAttachment(filename: unknown, contentType: unknown, disposition: 'attachment' | 'inline'): { filename: string; contentType: string } {
    const name = attachmentFilenameSchema.safeParse(filename); const type = attachmentContentTypeSchema.safeParse(contentType);
    if (!name.success || !type.success || (disposition === 'inline' && AMBIGUOUS_INLINE.test(type.data))) { throw new MailError('invalid_input'); }
    return { filename: name.data, contentType: type.data };
}
/** The least decoded size of a stored attachment, and whether it is exact. WildDuck's size counts
 * the transfer-encoded body, so it is exact only for identity encodings. Any other encoding may be
 * nearly all line breaks or soft breaks, so its only sure lower bound is 0: such a file is budgeted
 * by its bytes as they arrive (ByteBudget's meter), never refused on an estimate. */
function decodedLowerBound(raw: Json): { bytes: number; exact: boolean } {
    const metadata = attachment(raw);
    return metadata.size !== null && !metadata.sizeIsApproximate ? { bytes: metadata.size, exact: true } : { bytes: 0, exact: false };
}
/** The SourceFile of each item (by index) that copies from the message whose JSON is `raw`, validated at once. Only
 * these small records may outlive the read: a message's JSON is up to MESSAGE_BYTES (a value unrelated to the files,
 * such as one long header, can fill it) and a draft may copy from a hundred messages. */
function sourceFiles(items: readonly NewAttachment[], indices: readonly number[], raw: Json, into = new Map<number, SourceFile>()): Map<number, SourceFile> {
    const listed = raw['attachments']; if (!Array.isArray(listed)) { return fail(); }
    for (const index of indices) {
        const item = items[index]; if (!item || !('source' in item)) { return fail(); }
        const { source } = item;
        const found = listed.find((entry: unknown) => object(entry) && entry['id'] === source.attachmentId);
        if (!object(found)) { throw new MailError('not_found'); }
        const metadata = attachment(found); const size = decodedLowerBound(found);
        // The caller's name and type, else the source's; disposition and cid are always the caller's.
        into.set(index, { ...authoredAttachment(item.filename ?? metadata.filename, item.contentType ?? metadata.contentType, item.disposition), lower: size.bytes, exact: size.exact });
    }
    return into;
}
/** What the resolved attachments add to the message once encoded, kept against MAX_MESSAGE_BYTES:
 * first at declared or least sizes, before any bytes are fetched, then as bytes arrive. */
class ByteBudget {
    private total: number;
    constructor(fixedBytes: number) { this.total = fixedBytes; this.add(0); }
    /** One file at `lower` bytes, attached once per entry of contentTypes; the returned meter raises
     * the charge to the bytes seen so far and throws too_large once the total no longer fits. */
    charge(lower: number, contentTypes: readonly string[]): (bytes: number) => void {
        const cost = (bytes: number) => contentTypes.reduce((sum, type) => sum + attachmentBodyBytes(bytes, type), 0);
        let charged = lower; this.add(cost(lower));
        return bytes => { if (bytes > charged) { this.add(cost(bytes) - cost(charged)); charged = bytes; } };
    }
    private add(bytes: number): void { this.total += bytes; if (this.total > MAX_MESSAGE_BYTES) { throw new MailError('too_large'); } }
}
/** Runs task over items, at most `limit` at a time, and starts none once signal is aborted. */
async function pooled<T, R>(items: readonly T[], limit: number, signal: AbortSignal, task: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = []; let next = 0;
    const worker = async () => { while (next < items.length && !signal.aborted) { const index = next++; results[index] = await task(items[index] as T); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
function same(left: unknown, right: unknown): boolean { return stable(left ?? null) === stable(right ?? null); }
function assertSame(left: unknown, right: unknown): void { if (!same(left, right)) { throw new MailError('verification_failed'); } }
function setSame(left: readonly string[], right: readonly string[]): void { assertSame([...left].sort(), [...right].sort()); }
interface OutboundEnvelope { from: string; to: string[] }
function outbound(envelope: MimeEnvelope): OutboundEnvelope {
    const senders = envelope.from; const recipients = [...new Set([...envelope.to, ...envelope.cc, ...envelope.bcc].map(item => item.address))];
    if (senders.length !== 1 || !senders[0] || !isEmailValid(senders[0].address, API_EMAIL_OPTIONS) || recipients.length > 100 || recipients.some(address => !isEmailValid(address, API_EMAIL_OPTIONS))) { throw new MailError('unsupported_content'); }
    return { from: senders[0].address, to: recipients };
}
interface SnapshotState { accountId: string; raw: Json; authored?: { digest: string; bytes: Buffer } }
interface PreparationState { accountId: string; envelope: OutboundEnvelope; flags: string[]; labels: string[]; metadata: Json; receivedAt: string; reference?: Json; files: Json[] }
function addresses(value: unknown, depth = 0): MailAddress[] {
    if (depth > 8) { return fail(); }
    if (value === undefined || value === null) { return []; }
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap(item => {
        if (typeof item === 'string') { return [{ address: item }]; }
        if (object(item) && Array.isArray(item['group']) && item['address'] === undefined) { return addresses(item['group'], depth + 1); }
        if (!object(item) || typeof item['address'] !== 'string' || item['name'] !== undefined && typeof item['name'] !== 'string') { return fail(); }
        return [{ address: item['address'], ...(typeof item['name'] === 'string' ? { name: item['name'] } : {}) }];
    });
}
const headerFilterKeys = ['from', 'to', 'subject'] as const;
type HeaderFilters = Pick<MailInput<'search_messages'>, typeof headerFilterKeys[number]>;
function headerCandidateQuery(terms: readonly string[]): string | undefined {
    const joined = terms.map(term => term.trim()).join(' ');
    if (joined.length > MAX_SEARCH_TEXT_CHARACTERS || !joined.isWellFormed()) { return undefined; }
    // Structured filters treat quotes and leading hyphens as literals. Do not
    // let them turn a candidate query into a MongoDB phrase or negation.
    const query = joined.replaceAll('"', ' ').replace(/(^|\s)-+/gu, '$1 ').trim();
    return /[\p{L}\p{N}]/u.test(query) ? query : undefined;
}
function addressHeaderMatches(value: unknown, filter: RegExp, depth = 0): boolean {
    if (!Array.isArray(value) || depth > 8) { return false; }
    return value.some(item => {
        if (!object(item)) { return false; }
        if (Array.isArray(item['group']) && item['address'] === undefined) { return addressHeaderMatches(item['group'], filter, depth + 1); }
        return typeof item['address'] === 'string' && (filter.test(item['address']) || typeof item['name'] === 'string' && filter.test(item['name']));
    });
}
function subjectHeaderMatches(value: unknown, filter: RegExp): boolean {
    const values = Array.isArray(value) ? value : [value];
    return values.some(item => {
        if (typeof item !== 'string') { return false; }
        // Match the header as indexed by WildDuck's generateIndexedHeaders.
        // The top-level summary collapses whitespace and uses the last Subject.
        let subject = item.trim().replace(/(?<!\s)\s*\n\s*/gu, ' ');
        try { subject = libmime.decodeWords(subject); } catch { /* WildDuck keeps the undecoded value on decoder failure. */ }
        subject = subject.toLowerCase();
        const indexed = Buffer.from(subject);
        if (indexed.length >= 880) { subject = indexed.subarray(0, 880).toString().slice(0, -4); }
        return filter.test(subject);
    });
}
function headerMatcher(filters: HeaderFilters): (row: Json) => boolean {
    const literal = (value: string | undefined) => value === undefined ? undefined : new RegExp(RegExp.escape(value.trim()), 'iu');
    const from = literal(filters.from); const to = literal(filters.to); const subject = literal(filters.subject);
    return row => {
        const headers = object(row['headers']) ? row['headers'] : undefined;
        // WildDuck's summary From falls back to Sender or the SMTP envelope.
        return (from === undefined || addressHeaderMatches(headers?.['from'], from)) &&
            (to === undefined || addressHeaderMatches(row['to'], to) || addressHeaderMatches(row['cc'], to)) &&
            (subject === undefined || subjectHeaderMatches(headers?.['subject'], subject));
    };
}
function date(value: unknown): string | null {
    if (value === undefined || value === null) { return null; }
    if (typeof value !== 'string') { return fail(); }
    const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function summary(raw: Json, mailbox?: string): MessageSummary {
    const mailboxId = id(raw['mailbox']); if (mailbox !== undefined && mailboxId !== mailbox) { return fail(); }
    if (raw['flags'] !== undefined && (!Array.isArray(raw['flags']) || raw['flags'].some(flag => typeof flag !== 'string'))) { return fail(); }
    return {
        mailboxId, uid: uid(raw['id']), snippet: typeof raw['intro'] === 'string' ? truncate(raw['intro'], MAX_SNIPPET_BYTES).text : typeof raw['text'] === 'string' ? truncate(raw['text'].replace(/\s+/gu, ' ').trim(), MAX_SNIPPET_BYTES).text : null, threadId: raw['thread'] === undefined || raw['thread'] === null ? null : id(raw['thread']), subject: string(raw['subject']), from: addresses(raw['from']), to: addresses(raw['to']),
        date: date(raw['date']), receivedAt: date(raw['idate']), imapFlags: strings(raw['flags']), labels: strings(raw['labels']),
        flags: { seen: bool(raw['seen']), flagged: bool(raw['flagged']), draft: bool(raw['draft']), answered: bool(raw['answered']), deleted: bool(raw['deleted']), forwarded: bool(raw['forwarded']) },
        hasAttachments: Array.isArray(raw['attachments']) ? raw['attachments'].length > 0 : bool(raw['attachments']),
        ...(raw['size'] === undefined ? {} : { size: count(raw['size']) })
    };
}
function attachment(raw: unknown): AttachmentMetadata {
    if (!object(raw)) { return fail(); }
    // WildDuck stores attachments[].size as the transfer-encoded MIME body
    // length. Its attachment endpoint decodes base64/quoted-printable, so that
    // stored count is exact for a download only under a known identity encoding.
    const storedBytes = raw['size'] === undefined ? undefined : count(raw['size']);
    const encoding = typeof raw['transferEncoding'] === 'string' ? raw['transferEncoding'].trim().toLowerCase() : undefined;
    const exact = storedBytes !== undefined && (encoding === '7bit' || encoding === '8bit' || encoding === 'binary');
    const estimate = typeof raw['sizeKb'] === 'number' && Number.isFinite(raw['sizeKb']) && raw['sizeKb'] >= 0 ? Math.ceil(raw['sizeKb'] * 1024) : storedBytes;
    const bytes = exact ? storedBytes : estimate;
    if (raw['related'] !== undefined && typeof raw['related'] !== 'boolean') { return fail(); }
    return { attachmentId: string(raw['id']), filename: raw['filename'] === undefined || raw['filename'] === null ? null : string(raw['filename']), contentType: string(raw['contentType']), size: bytes === undefined ? null : count(bytes), sizeIsApproximate: bytes !== undefined && !exact, inline: raw['related'] === true || raw['disposition'] === 'inline', cid: raw['cid'] === undefined || raw['cid'] === null ? null : string(raw['cid']) };
}
/** Preserve missing versus null, exact strings/array ordering and recursively sorted keys. */
function stable(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
    if (object(value)) { return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; }
    return JSON.stringify(value);
}
const VERSION_FIELDS = ['envelope', 'forwarded', 'labels', 'from', 'replyTo', 'to', 'cc', 'bcc', 'subject', 'messageId', 'references', 'date', 'idate', 'text', 'html', 'attachments', 'files', 'draft', 'flags', 'seen', 'flagged', 'answered', 'deleted', 'contentType', 'reference', 'metaData', 'expires', 'verificationResults', 'outbound', 'forwardTargets'] as const;
function supportedDraftState(raw: Json): boolean {
    return same(raw['envelope'], { from: '', rcpt: [] }) && raw['expires'] === undefined && raw['verificationResults'] === undefined && raw['outbound'] === undefined &&
        (raw['forwardTargets'] === undefined || same(raw['forwardTargets'], []));
}
function version(session: BackendMailSession, target: MessageKey, raw: Json): string {
    const snapshot: Json = {}; for (const key of VERSION_FIELDS) { snapshot[key] = { present: Object.hasOwn(raw, key), value: raw[key] ?? null }; }
    return createHash('sha256').update(stable({ accountId: session.accountId, mailboxId: target.mailboxId, uid: target.uid, snapshot })).digest('base64url');
}
function truncate(text: string, maximum = MAX_READ_TEXT_BYTES): { text: string; textTruncated: boolean } {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maximum) { return { text, textTruncated: false }; }
    let end = maximum;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) { end--; }
    return { text: bytes.subarray(0, end).toString('utf8'), textTruncated: true };
}
function cursor(value: unknown): string | undefined {
    if (value === undefined || value === false || value === null) { return undefined; }
    if (typeof value !== 'string' || !value.trim() || value.length > 1024) { return fail(); }
    return value;
}
function normalizeMailbox(raw: unknown): Mailbox {
    if (!object(raw)) { return fail(); }
    return { mailboxId: id(raw['id']), path: string(raw['path']), ...(raw['name'] === undefined ? {} : { name: string(raw['name']) }),
        specialUse: raw['specialUse'] === undefined || raw['specialUse'] === null || raw['specialUse'] === false ? null : string(raw['specialUse']),
        ...(raw['total'] === undefined ? {} : { total: count(raw['total']) }), ...(raw['unseen'] === undefined ? {} : { unseen: count(raw['unseen']) }) };
}
class MailBackend implements MailBackendReader, MailBackendWriter {
    private readonly downloadStager: AttachmentDownloadStager | undefined;
    private readonly uploadStore: AttachmentUploadStore | undefined;
    private readonly uploadStager: AttachmentUploadStager | undefined;
    private readonly fetcher: typeof globalThis.fetch;
    private readonly timeoutMs: number;
    private readonly searchTimeoutMs: number;
    private readonly dotAsPlus: boolean;
    private readonly stripReplySuffix: boolean;
    private readonly onSearchDiagnostic: (diagnostic: SearchDiagnostic) => void;
    private readonly onDraftVerificationDiagnostic: (diagnostic: DraftVerificationDiagnostic) => void;
    private readonly snapshots = new WeakMap<MessageSnapshot, SnapshotState>();
    private readonly preparations = new WeakMap<PreparedDraft, PreparationState>();
    constructor(options: MailBackendOptions) {
        this.downloadStager = options.downloadStager;
        this.uploadStore = options.uploadStore; this.uploadStager = options.uploadStager;
        this.fetcher = options.fetch ?? globalThis.fetch; this.timeoutMs = options.timeoutMs ?? 10_000;
        this.searchTimeoutMs = options.searchTimeoutMs ?? options.timeoutMs ?? 45_000;
        this.dotAsPlus = options.dotAsPlus ?? false;
        this.stripReplySuffix = options.stripReplySuffix ?? true;
        if (typeof this.dotAsPlus !== 'boolean' || typeof this.stripReplySuffix !== 'boolean') { throw new MailError('invalid_input'); }
        this.onSearchDiagnostic = options.onSearchDiagnostic ?? (diagnostic => {
            // eslint-disable-next-line no-console -- Deliberate structured, privacy-allowlisted operational diagnostic.
            if (diagnostic.outcome === 'success') { console.info(JSON.stringify(diagnostic)); } else { console.warn(JSON.stringify(diagnostic)); }
        });
        this.onDraftVerificationDiagnostic = options.onDraftVerificationDiagnostic ?? (diagnostic => {
            // eslint-disable-next-line no-console -- Deliberate structured, privacy-allowlisted operational diagnostic.
            console.warn(JSON.stringify(diagnostic));
        });
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) { throw new MailError('invalid_input'); }
        if (!Number.isSafeInteger(this.searchTimeoutMs) || this.searchTimeoutMs < 1 || this.searchTimeoutMs > 120_000) { throw new MailError('invalid_input'); }
    }
    private async transport(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Json | MultipartUpload | undefined, cap: number, kind: 'json' | 'source' | 'attachment' = 'json', timing?: SearchTiming, extra: TransportExtra = {}): Promise<{ bytes: Buffer; headers: Headers }> {
        sessionValid(session);
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let deadline = false;
        const started = performance.now();
        const remaining = remainingRequestTimeMs();
        // A large body's time scales with its size (TIMEOUT_BYTES_PER_MS): an upload's from the
        // start, a download's once its length is known. Never past the request's own deadline.
        const base = timing ? this.searchTimeoutMs : this.timeoutMs;
        const ceiling = remaining === undefined ? Infinity : remaining - 2000;
        const within = (bytes: number, elapsed = 0) => Math.max(0, Math.floor(Math.min(base + Math.ceil(bytes / TIMEOUT_BYTES_PER_MS), ceiling - elapsed)));
        const timeoutMs = within(body instanceof MultipartUpload ? body.bytes.length : 0);
        if (timing) { timing.timeoutMs = timeoutMs; }
        if (timeoutMs === 0 || extra.signal?.aborted) { if (timing) { timing.category = 'deadline'; } throw new MailError('upstream_timeout'); }
        let expire: (error: MailError) => void = () => {};
        const expired = new Promise<never>((_, reject) => { expire = reject; });
        const stop = () => { deadline = true; if (timing) { timing.category = 'deadline'; } controller.abort(); expire(new MailError('upstream_timeout')); };
        const arm = (ms: number) => { if (timer !== undefined) { clearTimeout(timer); } timer = setTimeout(stop, ms); };
        extra.signal?.addEventListener('abort', stop, { once: true });
        const operation = async () => {
            const response = await this.fetcher(`${WILDDUCK_ORIGIN}/users/${session.accountId}${path}`, { method, redirect: 'error', signal: controller.signal,
                headers: { Accept: kind === 'json' ? 'application/json' : kind === 'source' ? 'message/rfc822' : '*/*', 'Accept-Encoding': 'identity', 'X-Access-Token': session.accessToken, ...(body === undefined ? {} : { 'Content-Type': body instanceof MultipartUpload ? body.contentType : 'application/json' }) },
                ...(body === undefined ? {} : { body: body instanceof MultipartUpload ? body.bytes : JSON.stringify(body) }) });
            if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new MailError('upstream_timeout'); }
            const headersAt = performance.now();
            if (timing) { timing.headersMs = Math.round(headersAt - started); timing.status = response.status; timing.category = response.status === 200 ? 'invalid_json' : 'http_status'; }
            const discard = () => { void response.body?.cancel().catch(() => {}); };
            if (response.redirected || response.status >= 300 && response.status < 400) { discard(); return fail(); }
            const encoded = response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity';
            if (kind === 'source' && encoded) { discard(); throw new MailError('source_integrity_unavailable'); }
            const contentType = response.headers.get('content-type') ?? '';
            if ((kind === 'json' || response.status !== 200) && !/^application\/json(?:\s*;|$)/iu.test(contentType) || kind === 'source' && response.status === 200 && !/^message\/rfc822(?:\s*;|$)/iu.test(contentType)) { discard(); return fail(); }
            const declared = response.headers.get('content-length');
            if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > cap)) { discard(); throw new MailError('too_large'); }
            if (kind === 'source' && response.status === 200 && declared === null) { discard(); throw new MailError('source_integrity_unavailable'); }
            if (!response.body) { return fail(); }
            const success = response.status === 200;
            if (success && declared !== null) { try { extra.meter?.(Number(declared)); } catch (error) { discard(); throw error; } }
            if (success && kind !== 'json') { arm(within(declared === null ? cap : Number(declared), performance.now() - started)); }
            // A declared identity body is read straight into one buffer of its length: joining the
            // chunks afterwards would hold a second copy of a 25 MiB source at the peak.
            const into = success && kind !== 'json' && declared !== null && !encoded ? Buffer.allocUnsafe(Number(declared)) : undefined;
            const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
            if (timing && success) { timing.category = 'network'; }
            const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) {
                    const chunk = await reader.read(); if (chunk.done) { break; }
                    size += chunk.value.byteLength; if (size > cap) { throw new MailError('too_large'); }
                    if (success) { extra.meter?.(size); }
                    if (into) { if (size > into.length) { return fail(); } into.set(chunk.value, size - chunk.value.byteLength); } else { chunks.push(chunk.value); }
                }
                if (declared !== null && !encoded && size !== Number(declared)) { return fail(); }
                const bytes = into ?? Buffer.concat(chunks);
                if (timing) { timing.bodyMs = Math.round(performance.now() - headersAt); }
                if (response.status === 200) { return { bytes, headers: response.headers }; }
                const result = json(bytes);
                if (response.status === 403 && result['code'] === 'InvalidToken') { throw new MailError('reconnect_required'); }
                if (response.status === 404) { throw new MailError('not_found'); }
                if (response.status === 401 || response.status === 403) { throw new MailError('forbidden'); }
                if (response.status === 400) { throw new MailError('invalid_input'); }
                const retry = response.headers.get('retry-after');
                const retryAfter = retry !== null && /^\d{1,5}$/u.test(retry) && Number(retry) <= 86400 ? Number(retry) : undefined;
                throw new MailError('temporarily_unavailable', retryAfter);
            } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        };
        arm(timeoutMs);
        try { return await Promise.race([operation(), expired]); }
        catch (error) { if (deadline) { throw new MailError('upstream_timeout'); } if (timing && error instanceof MailError && error.code === 'too_large') { timing.category = 'too_large'; } if (error instanceof MailError) { throw error; } return fail(); }
        finally { if (timer !== undefined) { clearTimeout(timer); } extra.signal?.removeEventListener('abort', stop); controller.abort(); }
    }
    private async request(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Json | MultipartUpload, cap = META_BYTES, extra: TransportExtra = {}): Promise<Json> {
        const result = json((await this.transport(session, path, method, body, cap, 'json', undefined, extra)).bytes);
        if (result['success'] !== true || result['error'] !== undefined || result['code'] !== undefined) { return fail(); }
        return result;
    }
    /** Every source this server reads (an authored draft, a read-back, a message before a move) is
     * bounded by the one message cap. */
    private async source(session: BackendMailSession, target: MessageKey, signal?: AbortSignal): Promise<Buffer> {
        sessionValid(session); targetValid(target);
        return (await this.transport(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}/message.eml`, 'GET', undefined, MAX_MESSAGE_BYTES, 'source', undefined, { signal })).bytes;
    }
    async listMailboxes(session: BackendMailSession): Promise<MailOutput<'list_mailboxes'>> { return this.mailboxListing(session, true); }
    private async mailboxListing(session: BackendMailSession, counters: boolean): Promise<MailOutput<'list_mailboxes'>> {
        const raw = await this.request(session, '/mailboxes?showHidden=true' + (counters ? '&counters=true' : ''), 'GET');
        if (!Array.isArray(raw['results']) || raw['results'].length > 1000) { return fail(); }
        const mailboxes = raw['results'].map(normalizeMailbox);
        if (new Set(mailboxes.map(box => box.mailboxId)).size !== mailboxes.length) { return fail(); }
        return { mailboxes };
    }
    private page(raw: Json, limit: number, accountId: string, mailbox?: string): MailOutput<'list_messages'> {
        if (!Array.isArray(raw['results']) || raw['results'].length > limit) { return fail(); }
        const messages = raw['results'].map((item: unknown) => {
            if (!object(item)) { return fail(); }
            const message = summary(item, mailbox); const marker = markerOf(item);
            if (marker && marker.accountId !== accountId) { throw new MailError('verification_failed'); }
            return marker ? { ...message, managedOperation: { operationId: marker.operationId, verification: 'not_checked' as const } } : message;
        });
        if (new Set(messages.map(message => `${message.mailboxId}:${message.uid}`)).size !== messages.length) { return fail(); }
        const next = cursor(raw['nextCursor']); const previous = cursor(raw['previousCursor']);
        return { messages, ...(next === undefined ? {} : { next }), ...(previous === undefined ? {} : { previous }) };
    }
    async getThread(session: BackendMailSession, input: MailInput<'get_thread'>): Promise<MailOutput<'get_thread'>> {
        sessionValid(session); const parsed = mailInputSchemas.get_thread.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        const threadId = data.threadId ?? (data.message ? (await this.readMessage(session, data.message)).message.threadId : null);
        if (!threadId) { throw new MailError('unsupported_content'); }
        const query = new URLSearchParams({ thread: threadId, order: 'asc', limit: String(data.limit), metaData: 'true', includeTotal: 'false' });
        if (data.next !== undefined) { query.set('next', data.next); } if (data.previous !== undefined) { query.set('previous', data.previous); }
        const timing: SearchTiming = { category: 'network' };
        const raw = json((await this.transport(session, '/search?' + query, 'GET', undefined, META_BYTES, 'json', timing)).bytes);

        if (raw['success'] !== true || raw['error'] !== undefined || raw['code'] !== undefined) { return fail(); }
        const page = this.page(raw, data.limit, session.accountId);
        if (page.messages.some(message => message.threadId !== threadId)) { throw new MailError('verification_failed'); }
        return { threadId, ...page };
    }
    async listMessages(session: BackendMailSession, input: MailInput<'list_messages'>): Promise<MailOutput<'list_messages'>> {
        sessionValid(session); const parsed = mailInputSchemas.list_messages.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const query = new URLSearchParams({ order: 'desc', limit: String(parsed.data.limit), metaData: 'true' });
        if (parsed.data.next !== undefined) { query.set('next', parsed.data.next); } if (parsed.data.previous !== undefined) { query.set('previous', parsed.data.previous); }
        return this.page(await this.request(session, `/mailboxes/${parsed.data.mailboxId}/messages?${query}`, 'GET'), parsed.data.limit, session.accountId, parsed.data.mailboxId);
    }
    async searchMessages(session: BackendMailSession, input: MailInputRaw<'search_messages'>): Promise<MailOutput<'search_messages'>> {
        sessionValid(session); const parsed = mailInputSchemas.search_messages.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        if (data.flagged === false || data.hasAttachments === false) { throw new MailError('invalid_input'); }
        // Backend query fulltext has a 255-character limit; reject rather than silently narrow/truncate the requested search.
        if (data.text !== undefined && data.text.length > MAX_SEARCH_TEXT_CHARACTERS) { throw new MailError('invalid_input'); }
        const headerTerms = headerFilterKeys.flatMap(key => data[key] === undefined ? [] : [data[key]]);
        const wantsPrefilter = data.searchMode === 'fast' && headerTerms.length > 0;
        const candidateQuery = wantsPrefilter ? data.text ?? headerCandidateQuery(headerTerms) : undefined;
        const search: MailOutput<'search_messages'>['search'] = candidateQuery !== undefined
            ? { mode: 'fast', strategy: 'fulltext_prefilter', complete: false, verified: true, retryWith: { searchMode: 'exhaustive' } }
            : { mode: wantsPrefilter ? 'exhaustive' : data.searchMode, strategy: data.text !== undefined && headerTerms.length === 0 ? 'fulltext' : 'structured', complete: true, verified: false };
        const query = new URLSearchParams({ order: 'desc', limit: String(data.limit), metaData: 'true', includeTotal: 'false' });
        const fields = { mailboxId: 'mailbox', from: 'from', to: 'to', subject: 'subject', text: 'query', receivedSince: 'datestart', receivedUntil: 'dateend', flagged: 'flagged', hasAttachments: 'attachments', next: 'next', previous: 'previous' } as const;
        for (const [key, field] of Object.entries(fields)) {
            if (candidateQuery !== undefined && (key === 'from' || key === 'to' || key === 'subject')) { continue; }
            const value = data[key as keyof typeof fields]; if (value !== undefined) { query.set(field, String(value)); }
        }
        if (candidateQuery !== undefined) {
            query.set('query', candidateQuery);
            if (data.from !== undefined || data.subject !== undefined) { query.set('includeHeaders', 'true'); }
        }
        if (data.seen !== undefined) { query.set(data.seen ? 'seen' : 'unseen', 'true'); }
        const started = performance.now(); const timing: SearchTiming = { category: 'network' }; let validationStarted: number | undefined; let outcome: 'success' | 'failure' = 'failure';
        try {
            const response = await this.transport(session, `/search?${query}`, 'GET', undefined, META_BYTES, 'json', timing);
            validationStarted = performance.now(); timing.category = 'invalid_json'; const raw = json(response.bytes);
            timing.category = 'invalid_shape';
            if (raw['success'] !== true || raw['error'] !== undefined || raw['code'] !== undefined) { return fail(); }
            // A mismatch proves the response violates the requested mailbox, not why.
            if (data.mailboxId !== undefined && Array.isArray(raw['results']) && raw['results'].some(row => object(row) && typeof row['mailbox'] === 'string' && ACCOUNT.test(row['mailbox']) && row['mailbox'] !== data.mailboxId)) { timing.category = 'mailbox_scope_mismatch'; return fail(); }
            const result = { ...this.page(raw, data.limit, session.accountId, data.mailboxId), search };
            if (!mailOutputSchemas.search_messages.safeParse(result).success) { return fail(); }
            // Verify only after checking the entire candidate page. Filtering
            // cannot hide malformed rows or change the upstream cursor bounds.
            const rows = raw['results'];
            if (candidateQuery !== undefined && Array.isArray(rows)) {
                const matches = headerMatcher(data);
                result.messages = result.messages.filter((_, index) => {
                    const row: unknown = rows[index];
                    return object(row) && matches(row);
                });
            }
            outcome = 'success'; return result;
        } catch (error) {
            if (error instanceof MailError && (error.code === 'temporarily_unavailable' || error.code === 'upstream_timeout' || error.code === 'too_large')) { throw new MailError(error.code, error.retryAfter, { cause: timing.category, status: timing.status }); }
            throw error;
        } finally {
            // Construct only allowlisted primitives. Never log queries, identity, URLs,
            // response values, caller headers or thrown errors. Late fetches cannot emit.
            const requestId = currentRequestId();
            const diagnostic: SearchDiagnostic = { ...(requestId === undefined ? {} : { requestId }), event: 'wildduck_search', outcome, scope: data.mailboxId === undefined ? 'global' : 'mailbox', durationMs: Math.round(performance.now() - started),
                ...(outcome === 'failure' ? { category: timing.category } : {}),
                ...(timing.headersMs === undefined ? {} : { headersMs: timing.headersMs }), ...(timing.bodyMs === undefined ? {} : { bodyMs: timing.bodyMs }),
                ...(validationStarted === undefined ? {} : { validationMs: Math.round(performance.now() - validationStarted) }),
                ...(timing.status === undefined ? {} : { status: timing.status }), ...(timing.timeoutMs === undefined ? {} : { timeoutMs: timing.timeoutMs }) };
            try { this.onSearchDiagnostic(diagnostic); } catch { /* Diagnostics must not alter mail results. */ }
        }
    }
    private async rawMessage(session: BackendMailSession, target: MessageKey, signal?: AbortSignal): Promise<{ raw: Json; version: string }> {
        sessionValid(session); targetValid(target);
        const raw = await this.request(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}?markAsSeen=false&replaceCidLinks=false`, 'GET', undefined, MESSAGE_BYTES, { signal });
        if (id(raw['user']) !== session.accountId || id(raw['mailbox']) !== target.mailboxId || uid(raw['id']) !== target.uid) { return fail(); }
        // Validate the full shape before authorizing a draft operation; never digest only public/truncated fields.
        if (raw['text'] !== undefined && typeof raw['text'] !== 'string' || raw['html'] !== undefined && (!Array.isArray(raw['html']) || raw['html'].some(html => typeof html !== 'string')) ||
            !Array.isArray(raw['attachments']) || raw['attachments'].length > 1000 || !Array.isArray(raw['flags']) || raw['flags'].some(flag => typeof flag !== 'string') ||
            !object(raw['envelope']) || !Array.isArray(raw['envelope']['rcpt']) || raw['envelope']['rcpt'].some(rcpt => !object(rcpt) || typeof rcpt['value'] !== 'string')) { return fail(); }
        summary(raw, target.mailboxId); addresses(raw['replyTo']); addresses(raw['cc']); addresses(raw['bcc']); raw['attachments'].map(attachment);
        if (raw['references'] !== undefined && (!Array.isArray(raw['references']) || raw['references'].some(ref => typeof ref !== 'string'))) { return fail(); }
        if (raw['messageId'] !== undefined && raw['messageId'] !== null && typeof raw['messageId'] !== 'string') { return fail(); }
        if (raw['contentType'] !== undefined && (!object(raw['contentType']) || typeof raw['contentType']['value'] !== 'string')) { return fail(); }
        const marker = markerOf(raw); if (marker && marker.accountId !== session.accountId) { throw new MailError('verification_failed'); }
        return { raw, version: version(session, target, raw) };
    }
    async readMessage(session: BackendMailSession, input: MessageKey) {
        return this.projectMessage(await this.rawMessage(session, input), input);
    }
    private projectMessage(snapshot: { raw: Json; version: string }, input: MessageKey) {
        const raw = snapshot.raw;
        // The API caps stored text in UTF-16 characters and HTML in UTF-8 bytes.
        // Reaching its ceiling is conservatively incomplete, even below our own cap.
        const html: string[] = []; let remaining = MAX_HTML_BYTES; let htmlTruncated = ((raw['html'] ?? []) as string[]).reduce((total, item) => total + Buffer.byteLength(item), 0) >= 640 * 1024;
        for (const item of (raw['html'] ?? []) as string[]) { const part = truncate(item, remaining); html.push(part.text); remaining -= Buffer.byteLength(part.text); htmlTruncated ||= part.textTruncated; }
        const text = truncate(typeof raw['text'] === 'string' ? raw['text'] : '');
        const message = { ...summary(raw, input.mailboxId), replyTo: addresses(raw['replyTo']), cc: addresses(raw['cc']), bcc: addresses(raw['bcc']),
            messageId: typeof raw['messageId'] === 'string' ? raw['messageId'] : null, references: (raw['references'] ?? []) as string[],
            ...text, textTruncated: text.textTruncated || typeof raw['text'] === 'string' && raw['text'].length >= 100 * 1024, html, htmlTruncated, htmlRepresentation: 'wildduck_normalized' as const,
            attachments: (raw['attachments'] as unknown[]).map(attachment), version: snapshot.version };
        if (!canonicalReadMessageOutputSchema.safeParse(message).success) { return fail(); }
        const marker = markerOf(raw); return { message, ...(marker ? { marker } : {}) };
    }
    async getAttachmentDownload(session: BackendMailSession, input: MailInput<'get_attachment_download'>): Promise<AttachmentDownloadLink> {
        sessionValid(session); const parsed = mailInputSchemas.get_attachment_download.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const stager = this.downloadStager; if (!stager) { throw new MailError('temporarily_unavailable'); }
        const inherited = remainingRequestTimeMs(); const deadline = performance.now() + Math.min(inherited ?? DOWNLOAD_TIMEOUT_MS + 2000, DOWNLOAD_TIMEOUT_MS + 2000);
        return withRequestBudget(() => Math.max(0, deadline - performance.now()), async () => {
            const { raw } = await this.rawMessage(session, parsed.data);
            const rawAttachment = (raw['attachments'] as unknown[]).find(item => object(item) && item['id'] === parsed.data.attachmentId);
            if (!object(rawAttachment)) { throw new MailError('not_found'); }
            const metadata = attachment(rawAttachment);
            if (metadata.size !== null && !metadata.sizeIsApproximate && metadata.size > MAX_DOWNLOAD_BYTES) { throw new MailError('too_large'); }
            const bodyHash = rawAttachment['hash'];
            if (typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(bodyHash)) { throw new MailError('unsupported_content'); }
            // The backend hash identifies immutable transfer-encoded attachment bytes,
            // not the decoded download checksum. Flags, versions and OAuth clients
            // deliberately do not affect this private account-scoped cache identity.
            const cacheIdentity = createHash('sha256').update(JSON.stringify(['wildduck-mcp/attachment-cache/v1', session.accountId, parsed.data.mailboxId, parsed.data.uid, parsed.data.attachmentId, bodyHash])).digest('hex');
            const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let response: Response | undefined;
            const budget = Math.max(0, deadline - performance.now() - 2000); if (budget === 0) { throw new MailError('upstream_timeout'); }
            const open = async (signal: AbortSignal) => {
                if (controller.signal.aborted || signal.aborted) { throw new MailError('upstream_timeout'); }
                response = await this.fetcher(WILDDUCK_ORIGIN + '/users/' + session.accountId + '/mailboxes/' + parsed.data.mailboxId + '/messages/' + parsed.data.uid + '/attachments/' + parsed.data.attachmentId, { method: 'GET', redirect: 'error', signal, headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'X-Access-Token': session.accessToken } });
                if (controller.signal.aborted || signal.aborted) { void response.body?.cancel().catch(() => {}); throw new MailError('upstream_timeout'); }
                if (response.redirected || response.status >= 300 && response.status < 400) { throw new MailError('temporarily_unavailable'); }
                if (response.status !== 200) {
                    // Read a bounded error body only to distinguish expired tokens.
                    const bytes: Uint8Array[] = []; let length = 0;
                    if (response.body) { const reader = response.body.getReader(); try { while (true) { const part = await reader.read(); if (part.done) { break; } length += part.value.byteLength; if (length > 8192) { throw new MailError('temporarily_unavailable'); } bytes.push(part.value); } } finally { void reader.cancel().catch(() => {}); } }
                    let invalidToken = false; try { invalidToken = json(Buffer.concat(bytes))['code'] === 'InvalidToken'; } catch { /* Never expose error bodies. */ }
                    if (response.status === 403 && invalidToken) { throw new MailError('reconnect_required'); }
                    if (response.status === 404) { throw new MailError('not_found'); }
                    if (response.status === 401 || response.status === 403) { throw new MailError('forbidden'); }
                    const retry = response.headers.get('retry-after'); const retryAfter = retry !== null && /^\d{1,5}$/u.test(retry) && Number(retry) <= 86400 ? Number(retry) : undefined;
                    throw new MailError('temporarily_unavailable', retryAfter);
                }
                const declared = response.headers.get('content-length');
                if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_DOWNLOAD_BYTES)) { throw new MailError('too_large'); }
                if (!response.body || response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') { throw new MailError('temporarily_unavailable'); }
                if (declared !== null && metadata.size !== null && !metadata.sizeIsApproximate && Number(declared) !== metadata.size) { throw new MailError('verification_failed'); }
                const expectedSize = declared === null ? metadata.size !== null && !metadata.sizeIsApproximate ? metadata.size : undefined : Number(declared);
                return { body: response.body, ...(expectedSize === undefined ? {} : { expectedSize }) };
            };
            const operation = async () => {
                const staged = await stager.stage({ cacheIdentity, metadata, open }, controller.signal);
                if (controller.signal.aborted) { throw new MailError('upstream_timeout'); }
                if (metadata.size !== null && !metadata.sizeIsApproximate && metadata.size !== staged.size) { throw new MailError('verification_failed'); }
                const result = { metadata: { ...parsed.data, filename: metadata.filename, contentType: metadata.contentType, size: staged.size, expiresAt: staged.expiresAt }, url: staged.url };
                if (!attachmentDownloadLinkSchema.safeParse(result).success) { throw new MailError('verification_failed'); }
                return result;
            };
            try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MailError('upstream_timeout')); }, budget); })]); }
            catch (error) { if (error instanceof MailError) { throw error; } throw new MailError('temporarily_unavailable'); }
            finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); if (response && !response.bodyUsed) { void response.body?.cancel().catch(() => {}); } }
        });
    }
    /** A message has no immutable upstream content hash, unlike an attachment, and S3 fixes an object's metadata
     * before its bytes are sent. So the source is read first, through the bounded source() path every other
     * source read uses (at most MAX_MESSAGE_BYTES, a declared exact length, identity encoding), and hashed; the
     * cache identity binds that SHA-256, so the object key is content-addressed. The stager uploads the bytes with
     * that SHA-256 as S3's checksum, and serves a new or cached object only if S3 reports the same full-object
     * SHA-256, so the returned sha256 is bound by S3 to the bytes the URL serves; a cache hit skips only the upload.
     * WildDuck itself refuses another account's message (404, not_found). The buffer is the one copy held and is
     * the upload's body as it is. One deadline (SOURCE_DOWNLOAD_TIMEOUT_MS, within the request) covers the fetch,
     * the staging and the signing. */
    async getMessageSourceDownload(session: BackendMailSession, input: MailInput<'get_message_source_download'>): Promise<MessageSourceDownloadLink> {
        sessionValid(session); const parsed = mailInputSchemas.get_message_source_download.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const stager = this.downloadStager; if (!stager) { throw new MailError('temporarily_unavailable'); }
        const ceiling = SOURCE_DOWNLOAD_TIMEOUT_MS + 2000;
        const inherited = remainingRequestTimeMs(); const deadline = performance.now() + Math.min(inherited ?? ceiling, ceiling);
        return withRequestBudget(() => Math.max(0, deadline - performance.now()), async () => {
            const target = parsed.data; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
            const budget = Math.max(0, deadline - performance.now() - 2000); if (budget === 0) { throw new MailError('upstream_timeout'); }
            const operation = async () => {
                const bytes = await this.source(session, target, controller.signal);
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                // Flags, versions and OAuth clients deliberately do not affect this private account-scoped identity.
                const cacheIdentity = createHash('sha256').update(JSON.stringify(['wildduck-mcp/message-source-cache/v2', session.accountId, target.mailboxId, target.uid, sha256])).digest('hex');
                const staged = await stager.stage({ cacheIdentity, metadata: { filename: `message-${target.uid}.eml`, contentType: 'message/rfc822' }, bytes, sha256 }, controller.signal);
                if (controller.signal.aborted) { throw new MailError('upstream_timeout'); }
                if (staged.size !== bytes.length) { throw new MailError('verification_failed'); }
                const result = { metadata: { mailboxId: target.mailboxId, uid: target.uid, size: staged.size, sha256, expiresAt: staged.expiresAt }, url: staged.url };
                if (!messageSourceDownloadLinkSchema.safeParse(result).success) { throw new MailError('verification_failed'); }
                return result;
            };
            try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MailError('upstream_timeout')); }, budget); })]); }
            catch (error) { if (controller.signal.aborted) { throw new MailError('upstream_timeout'); } if (error instanceof MailError) { throw error; } throw new MailError('temporarily_unavailable'); }
            finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); }
        });
    }
    async readAttachment(session: BackendMailSession, input: MailInput<'read_attachment'>): Promise<AttachmentDownload> {
        sessionValid(session); const parsed = mailInputSchemas.read_attachment.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const { raw } = await this.rawMessage(session, parsed.data);
        const found = (raw['attachments'] as unknown[]).map(attachment).find(item => item.attachmentId === input.attachmentId);
        if (!found) { throw new MailError('not_found'); }
        if (found.size !== null && !found.sizeIsApproximate && found.size > MAX_ATTACHMENT_BYTES) { throw new MailError('too_large'); }
        const { bytes } = await this.transport(session, `/mailboxes/${input.mailboxId}/messages/${input.uid}/attachments/${input.attachmentId}`, 'GET', undefined, MAX_ATTACHMENT_BYTES, 'attachment');
        return { metadata: { ...input, filename: found.filename, contentType: found.contentType, size: bytes.length, resourceUri: `wildduck://${session.accountId}/${input.mailboxId}/${input.uid}/${input.attachmentId}` }, bytes };
    }
    async resolveDraftMailbox(session: BackendMailSession): Promise<Mailbox> {
        const boxes = (await this.mailboxListing(session, false)).mailboxes.filter(box => box.specialUse === '\\Drafts');
        if (boxes.length !== 1) { throw new MailError(boxes.length === 0 ? 'not_found' : 'temporarily_unavailable'); }
        return boxes[0] ?? fail();
    }
    async inspectMessage(session: BackendMailSession, target: MessageKey): Promise<MessageSnapshot> {
        const { raw, version: digest } = await this.rawMessage(session, target);
        const mime = object(raw['contentType']) ? string(raw['contentType']['value']).toLowerCase() : 'text/plain';
        const hasRecipients = [...addresses(raw['to']), ...addresses(raw['cc']), ...addresses(raw['bcc'])].some(address => address.address.trim().length > 0);
        const marker = markerOf(raw);
        const snapshot: MessageSnapshot = { message: { ...target, version: digest }, isDraft: bool(raw['draft']), hasHtml: mime !== 'text/plain' && (mime === 'text/html' || (raw['html'] as unknown[] | undefined)?.length !== 0 && raw['html'] !== undefined), hasAttachments: (raw['attachments'] as unknown[]).length > 0 || Array.isArray(raw['files']) && raw['files'].length > 0, hasRecipients, ...(marker ? { marker } : {}) };
        this.snapshots.set(snapshot, { accountId: session.accountId, raw }); return snapshot;
    }
    private state(session: BackendMailSession, snapshot: MessageSnapshot): SnapshotState {
        sessionValid(session); const state = this.snapshots.get(snapshot);
        if (!state || state.accountId !== session.accountId || version(session, snapshot.message, state.raw) !== snapshot.message.version) { throw new MailError('invalid_input'); }
        return state;
    }
    async verifyAuthoredSource(session: BackendMailSession, snapshot: MessageSnapshot, source: AuthoredSourceDescriptor): Promise<void> {
        const state = this.state(session, snapshot);
        if (!source) { throw new MailError('unsupported_content'); }
        if (source.grade !== 'mcp_authored' || source.accountId !== session.accountId || source.mailboxId !== snapshot.message.mailboxId || source.uid !== snapshot.message.uid || !/^[a-f0-9]{64}$/u.test(source.contentDigest)) { throw new MailError('verification_failed'); }
        if (state.authored?.digest === source.contentDigest) { return; }
        // Legacy source rebuilds may pad missing external parts. Only a digest from
        // a previously verified MCP upload establishes authority; observing bytes cannot.
        const bytes = await this.source(session, snapshot.message);
        if (createHash('sha256').update(bytes).digest('hex') !== source.contentDigest) { throw new MailError('verification_failed'); }
        state.authored = { digest: source.contentDigest, bytes };
    }
    private async authoredBytes(session: BackendMailSession, snapshot: MessageSnapshot, source: AuthoredSourceDescriptor): Promise<Buffer> {
        await this.verifyAuthoredSource(session, snapshot, source);
        return this.state(session, snapshot).authored?.bytes ?? fail();
    }
    private checkMarker(session: BackendMailSession, marker: MailOperationMarker): void {
        if (!mailOperationMarkerSchema.safeParse(marker).success || marker.accountId !== session.accountId) { throw new MailError('invalid_input'); }
    }
    private marked(raw: Json, marker: MailOperationMarker): Json { return { ...metadata(raw), [MAIL_OPERATION_METADATA_KEY]: marker }; }
    private async ownedIdentities(session: BackendMailSession) {
        const [user, aliases] = await Promise.all([this.request(session, '', 'GET'), this.request(session, '/addresses', 'GET')]);
        if (id(user['id']) !== session.accountId || typeof user['address'] !== 'string' || !isEmailValid(user['address'], API_EMAIL_OPTIONS)) { return fail(); }
        if (!Array.isArray(aliases['results']) || aliases['results'].length > 1000 || aliases['results'].some(item => !object(item) || typeof item['address'] !== 'string')) { return fail(); }
        const ownedAddresses = [user['address'], ...(aliases['results'] as Json[]).map(item => string(item['address'])).filter(address => !address.includes('*'))];
        const match = ownedIdentityMatcher(ownedAddresses, this.dotAsPlus, user['address']);
        // The account's display name is backend data, so it is held to the schema's rules like a reply-derived name.
        const name = typeof user['name'] === 'string' ? sanitizeHeaderText(user['name'], AUTHORED_LIMITS.nameBytes) : '';
        return { primary: user['address'], ownedAddresses, match, ...(name ? { name } : {}) };
    }
    private selectFrom(identities: Awaited<ReturnType<MailBackend['ownedIdentities']>>, desired?: { address: string; name?: string | undefined }) {
        if (desired && !isEmailValid(desired.address, API_EMAIL_OPTIONS)) { throw new MailError('invalid_input'); }
        if (desired && !identities.match(desired.address)) { throw new MailError('forbidden'); }
        return desired ?? namedAddress(identities.primary, identities.name);
    }
    private async ownedFrom(session: BackendMailSession, desired?: { address: string; name?: string | undefined }) {
        return this.selectFrom(await this.ownedIdentities(session), desired);
    }
    /** Sorts the request's attachments by source without I/O, and refuses what can never resolve:
     * upload records are bound to account AND client, so without the service's verified client
     * digest there is no owner to look them up for. That digest is server wiring, not the caller's
     * input, so its absence fails closed like a missing upload store: temporarily_unavailable. */
    private planAttachments(session: DraftMailSession, items: readonly NewAttachment[] = []): AttachmentPlan {
        const inline = new Map<number, Buffer>(); const uploadIds = new Set<string>(); const messages = new Map<string, { target: MessageKey; indices: number[] }>();
        items.forEach((item, index) => {
            if ('contentBase64' in item) { inline.set(index, Buffer.from(item.contentBase64, 'base64')); }
            else if ('uploadId' in item) { uploadIds.add(item.uploadId); }
            else {
                const key = messageKeyOf(item.source); const entry = messages.get(key) ?? { target: { mailboxId: item.source.mailboxId, uid: item.source.uid }, indices: [] };
                entry.indices.push(index); messages.set(key, entry);
            }
        });
        if (uploadIds.size) {
            if (typeof session.clientIdHash !== 'string' || !CLIENT_ID_HASH.test(session.clientIdHash) || !this.uploadStore || !this.uploadStager) { throw new MailError('temporarily_unavailable'); }
        }
        return { items, inline, uploadIds: [...uploadIds], messages };
    }
    /** Every attachment as final bytes, name and type, in preflight (before the service marks the
     * operation dispatched). Batch-first: one getUploads for all upload ids, one metadata read per
     * distinct source message (`known` holds the SourceFiles of items whose message was already read,
     * such as a reply's original), each reduced to its SourceFiles inside the read so at most
     * RESOLVE_CONCURRENCY message JSONs are alive at once, and each distinct file fetched once however
     * often it is attached. One deadline, one byte budget
     * (`fixedBytes`, what the message keeps besides these, plus every encoded attachment within
     * MAX_MESSAGE_BYTES, checked at declared sizes before any fetch and on actual bytes as they
     * arrive) and RESOLVE_CONCURRENCY bound the whole phase; the first failure cancels the rest.
     * Request-local: nothing is logged, cached or persisted. */
    private async resolveAttachments(session: DraftMailSession, plan: AttachmentPlan, fixedBytes: number, known: ReadonlyMap<number, SourceFile> = new Map()): Promise<ResolvedAttachment[]> {
        const { items } = plan;
        const finish = (index: number, bytes: Uint8Array, final: { filename: string; contentType: string }): ResolvedAttachment => {
            const item = items[index] ?? fail();
            return { ...final, bytes, disposition: item.disposition, ...(item.cid === undefined ? {} : { cid: item.cid }) };
        };
        const inlineFinal = (index: number) => { const item = items[index]; return item && 'contentBase64' in item ? { filename: item.filename, contentType: item.contentType } : fail(); };
        // Inline bytes alone need no I/O, so no deadline; the MIME layer applies the size cap.
        if (!plan.uploadIds.length && !plan.messages.size) { return items.map((_, index) => finish(index, plan.inline.get(index) ?? fail(), inlineFinal(index))); }
        const remaining = remainingRequestTimeMs();
        const budgetMs = Math.min(RESOLVE_MAX_MS, remaining === undefined ? RESOLVE_MAX_MS : remaining - RESOLVE_RESERVE_MS);
        if (budgetMs <= 0) { throw new MailError('upstream_timeout'); }
        const deadline = performance.now() + budgetMs;
        const controller = new AbortController(); const { signal } = controller; let failure: MailError | undefined;
        const halted = new Promise<never>((_, reject) => { signal.addEventListener('abort', () => { reject(failure ?? new MailError('upstream_timeout')); }, { once: true }); });
        halted.catch(() => {});
        const timer = setTimeout(() => { failure ??= new MailError('upstream_timeout'); controller.abort(); }, budgetMs);
        const store = this.uploadStore, stager = this.uploadStager;
        const owner = { accountId: session.accountId, clientIdHash: session.clientIdHash };
        const work = async (): Promise<ResolvedAttachment[]> => {
            // Metadata first: the upload batch and the distinct source messages, all bounded together.
            let records: ReadonlyMap<string, AttachmentUploadRecord> = new Map();
            const files = new Map(known);
            // The message JSON is dropped as soon as its SourceFiles are taken: nothing else of it is kept.
            const reads: Array<() => Promise<void>> = [...plan.messages.values()].filter(({ indices }) => !indices.every(index => files.has(index)))
                .map(({ target, indices }) => async () => { sourceFiles(items, indices, (await this.rawMessage(session, target, signal)).raw, files); });
            if (plan.uploadIds.length) { reads.unshift(async () => { records = await (store ?? fail()).getUploads(owner, plan.uploadIds); }); }
            await pooled(reads, RESOLVE_CONCURRENCY, signal, read => read());
            if (signal.aborted) { throw failure ?? new MailError('upstream_timeout'); }
            // Every final name, type and size is known before a single byte is fetched.
            const nowSeconds = Date.now() / 1000;
            interface Slot { readonly lower: number; readonly exact: boolean; readonly types: string[]; readonly fetch: (meter: (bytes: number) => void) => Promise<Uint8Array> }
            const slots = new Map<string, Slot>();
            const finals = items.map((item, index): { slot?: string; filename: string; contentType: string } => {
                if ('contentBase64' in item) { return inlineFinal(index); }
                if ('uploadId' in item) {
                    const record = records.get(item.uploadId);
                    // The store already filters by owner and expiry; checked again, so no other record supplies bytes.
                    if (!record || record.uploadId !== item.uploadId || record.accountId !== owner.accountId || record.clientIdHash !== owner.clientIdHash || !(record.expiresAt > nowSeconds) || record.objectKey !== ATTACHMENT_UPLOAD_KEY_PREFIX + record.uploadId) { throw new MailError('not_found'); }
                    if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1) { return fail(); }
                    if (record.sizeBytes > MAX_UPLOAD_BYTES) { throw new MailError('too_large'); }
                    const key = 'upload:' + item.uploadId;
                    const slot: Slot = slots.get(key) ?? { lower: record.sizeBytes, exact: true, types: [], fetch: async () => (stager ?? fail()).readStaged(record, { maxBytes: MAX_UPLOAD_BYTES, signal }) };
                    slot.types.push(item.contentType); slots.set(key, slot);
                    return { slot: key, filename: item.filename, contentType: item.contentType };
                }
                const { source } = item; const file = files.get(index) ?? fail();
                const key = 'source:' + sourceKeyOf(source);
                const path = `/mailboxes/${source.mailboxId}/messages/${source.uid}/attachments/${source.attachmentId}`;
                // WildDuck's attachment hash covers the transfer-encoded body, not these decoded bytes: never compared.
                const slot: Slot = slots.get(key) ?? { lower: file.lower, exact: file.exact, types: [], fetch: async meter => (await this.transport(session, path, 'GET', undefined, MAX_MESSAGE_BYTES, 'attachment', undefined, { signal, meter })).bytes };
                slot.types.push(file.contentType); slots.set(key, slot);
                return { slot: key, filename: file.filename, contentType: file.contentType };
            });
            const budget = new ByteBudget(fixedBytes);
            finals.forEach((final, index) => { const bytes = plan.inline.get(index); if (bytes) { budget.charge(bytes.length, [final.contentType]); } });
            const meters = new Map([...slots].map(([key, slot]) => [key, budget.charge(slot.lower, slot.types)]));
            const fetched = new Map<string, Uint8Array>();
            await pooled([...slots], RESOLVE_CONCURRENCY, signal, async ([key, slot]) => {
                const meter = meters.get(key) ?? fail();
                const bytes = await slot.fetch(meter);
                // The stager verifies an upload's size and SHA-256; its length is checked again here.
                if (!(bytes instanceof Uint8Array) || (slot.exact && bytes.byteLength !== slot.lower)) { throw new MailError('verification_failed'); }
                meter(bytes.byteLength); fetched.set(key, bytes);
            });
            if (signal.aborted) { throw failure ?? new MailError('upstream_timeout'); }
            return finals.map((final, index) => finish(index, final.slot === undefined ? plan.inline.get(index) ?? fail() : fetched.get(final.slot) ?? fail(), { filename: final.filename, contentType: final.contentType }));
        };
        try {
            // The nested budget makes every request of this phase end by its deadline (transport keeps 2 s back).
            return await withRequestBudget(() => Math.max(0, deadline - performance.now() + 2000), () => Promise.race([work(), halted]));
        } catch (error) { throw failure ?? error; }
        finally { clearTimeout(timer); controller.abort(); }
    }
    async prepareReply(session: DraftMailSession, input: MailInput<'create_reply_draft'>, marker: MailOperationMarker): Promise<PreparedDraft> {
        sessionValid(session); this.checkMarker(session, marker);
        const parsed = mailInputSchemas.create_reply_draft.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        try {
            // Render first: a renderer failure stays preflight and needs no upstream I/O.
            // Any quote is appended to the rendered parts by deriveReply, never to Markdown.
            const plan = this.planAttachments(session, data.attachments);
            const body = renderBody(data.body);
            // The original's JSON is reduced inside its read to what the reply uses: the projected message (capped text
            // and HTML), its SMTP recipients and, since its own attachments are the usual source of a reply's, the
            // SourceFiles of those it copies. The raw JSON never reaches attachment resolution.
            const [{ original, delivered, files }, identities, mailbox] = await Promise.all([this.rawMessage(session, data.original).then(snapshot => ({
                original: this.projectMessage(snapshot, data.original), delivered: ((snapshot.raw['envelope'] as Json)['rcpt'] as Json[]).map(item => string(item['value'])),
                files: sourceFiles(plan.items, plan.messages.get(messageKeyOf(data.original))?.indices ?? [], snapshot.raw),
            })), this.ownedIdentities(session), this.resolveDraftMailbox(session)]);
            // Continuing the account's own sent mail keeps the identity that sent it:
            // an owned original From comes first. Otherwise SMTP recipient evidence
            // handles Bcc delivery and takes precedence over untrusted visible
            // recipients. None of it is copied to output.
            const candidates = [...original.message.from.map(item => item.address), ...delivered, ...original.message.to.map(item => item.address), ...original.message.cc.map(item => item.address)];
            // Routing recognition and reply identity are independent. Stripping
            // selects the registered identity behind the tag, never a guessed
            // substring. Skip bases that the resolver cannot use as a sender.
            const selected = candidates.map(address => {
                const owned = identities.match(address);
                return owned === undefined ? undefined : this.stripReplySuffix ? owned : address;
            }).find(address => address !== undefined && identities.match(address) !== undefined);
            const from = this.selectFrom(identities, data.from ?? (selected ? namedAddress(selected, identities.name) : undefined));
            const reply = deriveReply({ original: original.message, ownedAddresses: identities.ownedAddresses, isOwnedAddress: address => identities.match(address) !== undefined, mode: data.mode, body, quoteOriginal: data.quoteOriginal, ...(data.to === undefined && data.cc === undefined ? {} : { recipients: { to: data.to ?? [], cc: data.cc ?? [] } }) });
            const attachments = await this.resolveAttachments(session, plan, 0, files);
            const mime = await createMime({ ...reply, from, attachments });
            const envelope = outbound(mime.envelope); if (envelope.from !== from.address) { throw new MailError('unsupported_content'); }
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            // WildDuck marks the original Answered when submitting this reference,
            // without changing its flags while the reply is only a draft.
            const reference = { mailbox: data.original.mailboxId, id: data.original.uid, action: data.mode === 'reply_all' ? 'replyAll' : 'reply' };
            this.preparations.set(prepared, { accountId: session.accountId, envelope, flags: ['\\Seen', '\\Draft'], labels: [], metadata: { [MAIL_OPERATION_METADATA_KEY]: marker }, receivedAt: new Date().toISOString(), reference, files: [] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    async prepareCreate(session: DraftMailSession, input: DraftContent, marker: MailOperationMarker): Promise<PreparedDraft> {
        sessionValid(session); this.checkMarker(session, marker);
        const parsed = draftContentSchema.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            const plan = this.planAttachments(session, parsed.data.attachments);
            const body = renderBody(parsed.data.body);
            const [mailbox, from] = await Promise.all([this.resolveDraftMailbox(session), this.ownedFrom(session, parsed.data.from)]);
            const attachments = await this.resolveAttachments(session, plan, 0);
            const mime = await createMime({ ...parsed.data, from, body, attachments });
            const envelope = outbound(mime.envelope); if (envelope.from !== from.address) { throw new MailError('unsupported_content'); }
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            this.preparations.set(prepared, { accountId: session.accountId, envelope,
                flags: ['\\Seen', '\\Draft'], labels: [], metadata: { [MAIL_OPERATION_METADATA_KEY]: marker }, receivedAt: new Date().toISOString(), files: [] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    async prepareUpdate(session: DraftMailSession, snapshot: MessageSnapshot, patch: DraftPatch, marker: MailOperationMarker, trusted: AuthoredSourceDescriptor): Promise<PreparedDraft> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        if (!snapshot.isDraft) { throw new MailError('unsupported_draft'); }
        const parsed = mailInputSchemas.update_draft.safeParse({ ...patch, uid: snapshot.message.uid, expectedVersion: snapshot.message.version, operationId: marker.operationId });
        if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            // A body patch replaces the whole body; only the rendered parts are stored.
            const plan = this.planAttachments(session, parsed.data.attachments);
            const body = parsed.data.body === undefined ? undefined : renderBody(parsed.data.body);
            const bytes = await this.authoredBytes(session, snapshot, trusted);
            const mailbox = await this.resolveDraftMailbox(session); if (mailbox.mailboxId !== snapshot.message.mailboxId) { throw new MailError('unsupported_draft'); }
            // Raw upload cannot copy received SMTP provenance, expiration or queue/authentication state.
            // Refuse these legacy cases instead of silently replacing them with upload defaults.
            if (!supportedDraftState(state.raw)) { throw new MailError('unsupported_content'); }
            if (patch.deleteAttachmentIds?.length && Array.isArray(state.raw['files']) && state.raw['files'].length > 0) { throw new MailError('unsupported_content'); }
            const source = await inspectSource(bytes, (state.raw['attachments'] as Json[]).map(item => ({ attachmentId: string(item['id']), hash: string(item['hash']) })));
            // The parsed patch: its names and subject carry the schema's normalisation.
            const { uid: _uid, expectedVersion: _version, operationId: _operation, ...fields } = parsed.data;
            // Resolved only now, so the retained parts count against the message cap before any fetch.
            const attachments = await this.resolveAttachments(session, plan, retainedAttachmentBytes(source, fields.deleteAttachmentIds));
            const mime = await preparePatch(source, { ...fields, body, attachments });
            const envelope = outbound(mime.envelope); await this.ownedFrom(session, { address: envelope.from });
            const flags = strings(state.raw['flags']); const labels = strings(state.raw['labels']);
            if (flags.some(flag => !/^\\(?:draft|deleted)$/iu.test(flag) && !addFlagSchema.safeParse(flag).success) || labels.some(label => !labelSchema.safeParse(label).success)) { throw new MailError('unsupported_content'); }
            const receivedAt = date(state.raw['idate']); if (!receivedAt) { throw new MailError('unsupported_content'); }
            let reference: Json | undefined;
            if (state.raw['reference'] !== undefined) {
                const value = state.raw['reference'];
                if (!object(value) || !['reply', 'replyAll', 'forward'].includes(String(value['action'])) || !ACCOUNT.test(String(value['mailbox'])) || typeof value['id'] !== 'number' || !Number.isSafeInteger(value['id']) || value['id'] < 1 || Object.keys(value).some(key => !['mailbox', 'id', 'action'].includes(key))) { throw new MailError('unsupported_content'); }
                reference = value;
                await this.rawMessage(session, { mailboxId: string(value['mailbox']), uid: uid(value['id']) });
            }
            const files = state.raw['files'] === undefined ? [] : state.raw['files'];
            if (!Array.isArray(files) || files.some(file => !object(file) || !ACCOUNT.test(String(file['id'])))) { throw new MailError('unsupported_content'); }
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            this.preparations.set(prepared, { accountId: session.accountId, envelope, flags, labels, metadata: this.marked(state.raw, marker), receivedAt, ...(reference ? { reference } : {}), files: files as Json[] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    private preparedState(session: BackendMailSession, prepared: PreparedDraft): PreparationState {
        sessionValid(session); const state = this.preparations.get(prepared);
        if (!state || state.accountId !== session.accountId || !mailboxIdSchema.safeParse(prepared.mailboxId).success) { throw new MailError('invalid_input'); }
        try { verifyCandidate(prepared.mime, prepared.mime.raw); } catch (error) { return mimeError(error); }
        return state;
    }
    async uploadPreparedDraft(session: BackendMailSession, prepared: PreparedDraft): Promise<MessageKey> {
        const state = this.preparedState(session, prepared);
        const result = await this.request(session, `/mailboxes/${prepared.mailboxId}/messages`, 'POST', new MultipartUpload(prepared.mime.raw, {
            from: { address: state.envelope.from }, to: state.envelope.to.map(address => ({ address })), cc: [], bcc: [],
            date: state.receivedAt, draft: true, unseen: !state.flags.includes('\\Seen'), flagged: state.flags.includes('\\Flagged'), flags: state.flags, labels: state.labels,
            metaData: state.metadata, files: state.files.map(file => file['id']), ...(state.reference ? { reference: { ...state.reference, attachments: false } } : {})
        }));
        if (!object(result['message']) || id(result['message']['mailbox']) !== prepared.mailboxId) { return fail(); }
        return { mailboxId: prepared.mailboxId, uid: uid(result['message']['id']) };
    }
    async verifyPreparedDraft(session: BackendMailSession, target: MessageKey, prepared: PreparedDraft): Promise<MessageRef> {
        const state = this.preparedState(session, prepared); targetValid(target);
        let check: DraftVerificationCheck = 'target';
        try {
            if (target.mailboxId !== prepared.mailboxId) { throw new MailError('verification_failed'); }
            check = 'message'; const { raw, version: digest } = await this.rawMessage(session, target);
            check = 'mime'; verifyCandidate(prepared.mime, await this.source(session, target));
            check = 'draft_state'; if (!bool(raw['draft']) || !supportedDraftState(raw)) { throw new MailError('verification_failed'); }
            check = 'envelope'; assertSame(raw['envelope'], { from: '', rcpt: [] });
            // The existing API does not expose its private submission envelope. The upload
            // uses exactly the validated final-MIME envelope; do not claim a read-back proof.
            check = 'metadata'; assertSame(metadata(raw), state.metadata);
            check = 'received_at'; assertSame(date(raw['idate']), state.receivedAt);
            check = 'reference'; assertSame(raw['reference'], state.reference);
            check = 'files'; assertSame(raw['files'] ?? [], state.files);
            check = 'flags'; setSame(strings(raw['flags']), state.flags);
            check = 'labels'; setSame(strings(raw['labels']), state.labels);
            return { ...target, version: digest };
        } catch (error) {
            // Check names and codes are fixed literals: never log source, metadata,
            // account/operation identifiers, expected values, or upstream errors.
            try {
                const requestId = currentRequestId();
                this.onDraftVerificationDiagnostic({ event: 'wildduck_draft_verification_failed', ...(requestId ? { requestId } : {}), check,
                    code: error instanceof MimeError && error.code === 'mime_verification_failed' ? 'mime_verification_failed' : error instanceof MailError && error.code === 'verification_failed' ? 'verification_failed' : 'upstream_failure' });
            } catch { /* Diagnostics must not alter verification or its receipt. */ }
            return mimeError(error);
        }
    }
    async deleteDraft(session: BackendMailSession, target: MessageKey): Promise<void> {
        sessionValid(session); targetValid(target);
        const result = await this.request(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}`, 'DELETE');
        if (result['deleted'] !== 1 || result['errors'] !== 0) { return fail(); }
    }
    async submitDraft(session: BackendMailSession, target: MessageKey): Promise<{ queueId: string; sent?: MessageKey }> {
        sessionValid(session); targetValid(target);
        const result = await this.request(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}/submit`, 'POST', {});
        const queueId = result['queueId'];
        if (typeof queueId !== 'string' || !queueId || queueId.length > 256 || !/^\S+$/u.test(queueId)) { return fail(); }
        const sent = result['message'];
        if (sent !== undefined && (!object(sent) || !ACCOUNT.test(String(sent['mailbox'])) || typeof sent['id'] !== 'number' || !Number.isSafeInteger(sent['id']) || sent['id'] < 1 || sent['id'] > 4294967295)) { throw new MailError('verification_failed'); }
        return { queueId, ...(object(sent) ? { sent: { mailboxId: id(sent['mailbox']), uid: uid(sent['id']) } } : {}) };
    }
    private async verifyMutation(session: BackendMailSession, snapshot: MessageSnapshot, target: MessageKey, before: Buffer, expectedMetadata: Json, expectedFlags?: string[], expectedLabels?: string[], source?: AuthoredSourceDescriptor): Promise<VerifiedMessageMutation> {
        const state = this.state(session, snapshot);
        const { raw, version: digest } = await this.rawMessage(session, target);
        const after = await this.source(session, target);
        if (!before.equals(after)) { throw new MailError('verification_failed'); }
        const mutable = new Set(['metaData', ...(expectedFlags ? ['flags', 'seen', 'flagged', 'answered', 'forwarded'] : []), ...(expectedLabels ? ['labels'] : [])]);
        for (const field of VERSION_FIELDS) { if (!mutable.has(field)) { assertSame(raw[field], state.raw[field]); } }
        assertSame(metadata(raw), expectedMetadata);
        if (expectedFlags) { setSame(strings(raw['flags']).map(canonicalFlag), expectedFlags.map(canonicalFlag)); }
        if (expectedFlags) {
            const flags = new Set(expectedFlags.map(canonicalFlag));
            assertSame(raw['seen'], flags.has('\\Seen')); assertSame(raw['flagged'], flags.has('\\Flagged'));
            assertSame(raw['answered'], flags.has('\\Answered') && !flags.has('$Forwarded')); assertSame(raw['forwarded'], flags.has('$Forwarded'));
        }
        if (expectedLabels) { setSame(strings(raw['labels']), expectedLabels); }
        const contentDigest = createHash('sha256').update(after).digest('hex');
        if (source && contentDigest !== source.contentDigest) { throw new MailError('verification_failed'); }
        return { message: { ...target, version: digest }, contentDigest, sourceGrade: source ? 'mcp_authored' : 'observed' };
    }
    async stampSendMarker(session: BackendMailSession, snapshot: MessageSnapshot, marker: MailOperationMarker, source: AuthoredSourceDescriptor): Promise<MessageRef> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        const bytes = await this.authoredBytes(session, snapshot, source); const metaData = this.marked(state.raw, marker);
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', { metaData });
        if (result['updated'] !== 1) { throw new MailError('verification_failed'); }
        return (await this.verifyMutation(session, snapshot, snapshot.message, bytes, metaData, undefined, undefined, source)).message;
    }
    async moveMessage(session: BackendMailSession, snapshot: MessageSnapshot, destinationMailboxId: string, marker: MailOperationMarker, source?: AuthoredSourceDescriptor): Promise<VerifiedMessageMutation> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        if (!mailboxIdSchema.safeParse(destinationMailboxId).success || destinationMailboxId === snapshot.message.mailboxId) { throw new MailError('invalid_input'); }
        const destination = await this.request(session, `/mailboxes/${destinationMailboxId}`, 'GET');
        if (id(destination['id']) !== destinationMailboxId) { throw new MailError('verification_failed'); }
        const bytes = source ? await this.authoredBytes(session, snapshot, source) : await this.source(session, snapshot.message); const metaData = this.marked(state.raw, marker);
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', { moveTo: destinationMailboxId, metaData });
        if (result['mailbox'] !== destinationMailboxId || !Array.isArray(result['id']) || result['id'].length !== 1 || !Array.isArray(result['id'][0]) || result['id'][0].length !== 2 || result['id'][0][0] !== snapshot.message.uid) { throw new MailError('verification_failed'); }
        const target = { mailboxId: destinationMailboxId, uid: uid(result['id'][0][1]) };
        return this.verifyMutation(session, snapshot, target, bytes, metaData, undefined, undefined, source);
    }
    async updateMessageFlags(session: BackendMailSession, snapshot: MessageSnapshot, patch: MailInput<'update_message_flags'>, marker: MailOperationMarker, source?: AuthoredSourceDescriptor): Promise<VerifiedMessageMutation> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        const parsed = mailInputSchemas.update_message_flags.safeParse(patch);
        if (!parsed.success || patch.mailboxId !== snapshot.message.mailboxId || patch.uid !== snapshot.message.uid || patch.expectedVersion !== snapshot.message.version) { throw new MailError('invalid_input'); }
        const flags = new Set(strings(state.raw['flags']).map(canonicalFlag));
        for (const value of patch.removeFlags ?? []) { flags.delete(canonicalFlag(value)); } for (const value of patch.addFlags ?? []) { flags.add(canonicalFlag(value)); }
        for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']] as const) { if (patch[key] === true) { flags.add(flag); } else if (patch[key] === false) { flags.delete(flag); } }
        const labels = new Set(patch.labels ?? strings(state.raw['labels']));
        for (const value of patch.removeLabels ?? []) { labels.delete(value); } for (const value of patch.addLabels ?? []) { labels.add(value); }
        const bytes = source ? await this.authoredBytes(session, snapshot, source) : await this.source(session, snapshot.message); const metaData = this.marked(state.raw, marker); const body: Json = { metaData };
        for (const key of ['seen', 'flagged', 'addFlags', 'removeFlags', 'labels', 'addLabels', 'removeLabels'] as const) { if (patch[key] !== undefined) { body[key] = patch[key]; } }
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', body);
        if (result['updated'] !== 1) { throw new MailError('verification_failed'); }
        const verified = await this.verifyMutation(session, snapshot, snapshot.message, bytes, metaData, [...flags], [...labels], source);
        return verified;
    }
}
function canonicalFlag(value: string): string {
    const known: Record<string, string> = { '\\seen': '\\Seen', '\\flagged': '\\Flagged', '\\answered': '\\Answered', '\\draft': '\\Draft', '\\deleted': '\\Deleted' };
    return known[value.toLowerCase()] ?? value;
}
export function createMailBackend(options: MailBackendOptions = {}): MailBackendReader & MailBackendWriter { return new MailBackend(options); }
