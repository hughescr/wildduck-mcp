import { createHash } from 'node:crypto';
import { isEmailValid } from '@hapi/address';
import { WILDDUCK_ORIGIN } from '../wildduck';
import { remainingRequestTimeMs, withRequestBudget } from '../request-budget';
import { MailError, MAIL_OPERATION_METADATA_KEY, type BackendMailSession, type MailBackendReader, type MailBackendWriter, type Mailbox, type MailInput, type MailOutput, type MessageKey, type DraftContent, type DraftPatch, type MessageSnapshot, type PreparedDraft, type MailOperationMarker, type MessageRef, type MessageSummary, type MailAddress, type AttachmentMetadata, type AttachmentDownload, type VerifiedMessageMutation, type AuthoredSourceDescriptor } from './contracts';
import { draftContentSchema, mailboxIdSchema, messageKeySchema, mailInputSchemas, mailOutputSchemas, mailOperationMarkerSchema, addFlagSchema, labelSchema, MAX_READ_TEXT_BYTES, MAX_HTML_BYTES, MAX_ATTACHMENT_BYTES, MAX_SNIPPET_BYTES } from './schemas';
import { MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT_MS, type AttachmentDownloadStager } from './downloads';
import { deriveReply } from './reply';
import { createMime, inspectSource, preparePatch, verifyCandidate, MimeError, MIME_LIMITS, type MimeEnvelope } from './mime';

const META_BYTES = 512 * 1024;
const MESSAGE_BYTES = 4 * 1024 * 1024;
const ACCOUNT = /^[a-f0-9]{24}$/u;
const TOKEN = /^[a-fA-F0-9]{40}$/u;
const API_EMAIL_OPTIONS = { tlds: false } as unknown as Parameters<typeof isEmailValid>[1];
type Json = Record<string, unknown>;
type SearchCategory = 'deadline' | 'network' | 'http_status' | 'invalid_json' | 'invalid_shape' | 'too_large';
export interface SearchDiagnostic { event: 'wildduck_search'; outcome: 'success' | 'failure'; scope: 'global' | 'mailbox'; category?: SearchCategory; durationMs: number; headersMs?: number; bodyMs?: number; validationMs?: number; status?: number; timeoutMs?: number }
interface SearchTiming { category: SearchCategory; headersMs?: number; bodyMs?: number; status?: number; timeoutMs?: number }
export interface MailBackendOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number; searchTimeoutMs?: number; downloadStager?: AttachmentDownloadStager; onSearchDiagnostic?: (diagnostic: SearchDiagnostic) => void }
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
    if (error instanceof MimeError) { throw new MailError(error.code === 'mime_limit' ? 'too_large' : error.code === 'mime_verification_failed' ? 'verification_failed' : 'unsupported_content'); }
    return fail();
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
    private readonly fetcher: typeof globalThis.fetch;
    private readonly timeoutMs: number;
    private readonly searchTimeoutMs: number;
    private readonly onSearchDiagnostic: (diagnostic: SearchDiagnostic) => void;
    private readonly snapshots = new WeakMap<MessageSnapshot, SnapshotState>();
    private readonly preparations = new WeakMap<PreparedDraft, PreparationState>();
    constructor(options: MailBackendOptions) {
        this.downloadStager = options.downloadStager;
        this.fetcher = options.fetch ?? globalThis.fetch; this.timeoutMs = options.timeoutMs ?? 10_000;
        this.searchTimeoutMs = options.searchTimeoutMs ?? options.timeoutMs ?? 45_000;
        this.onSearchDiagnostic = options.onSearchDiagnostic ?? (diagnostic => {
            // eslint-disable-next-line no-console -- Deliberate structured, privacy-allowlisted operational diagnostic.
            if (diagnostic.outcome === 'success') { console.info(JSON.stringify(diagnostic)); } else { console.warn(JSON.stringify(diagnostic)); }
        });
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) { throw new MailError('invalid_input'); }
        if (!Number.isSafeInteger(this.searchTimeoutMs) || this.searchTimeoutMs < 1 || this.searchTimeoutMs > 120_000) { throw new MailError('invalid_input'); }
    }
    private async transport(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Json | undefined, cap: number, kind: 'json' | 'source' | 'attachment' = 'json', timing?: SearchTiming): Promise<{ bytes: Buffer; headers: Headers }> {
        sessionValid(session);
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let deadline = false;
        const started = performance.now();
        const remaining = remainingRequestTimeMs();
        const timeoutMs = Math.max(0, Math.min(timing ? this.searchTimeoutMs : this.timeoutMs, remaining === undefined ? Infinity : remaining - 2000));
        if (timing) { timing.timeoutMs = timeoutMs; }
        if (timeoutMs === 0) { if (timing) { timing.category = 'deadline'; } throw new MailError('upstream_timeout'); }
        const operation = async () => {
            const response = await this.fetcher(`${WILDDUCK_ORIGIN}/users/${session.accountId}${path}`, { method, redirect: 'error', signal: controller.signal,
                headers: { Accept: kind === 'json' ? 'application/json' : kind === 'source' ? 'message/rfc822' : '*/*', 'Accept-Encoding': 'identity', 'X-Access-Token': session.accessToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
            const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
            if (timing && response.status === 200) { timing.category = 'network'; }
            const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) { const chunk = await reader.read(); if (chunk.done) { break; } size += chunk.value.byteLength; if (size > cap) { throw new MailError('too_large'); } chunks.push(chunk.value); }
                if (declared !== null && !encoded && size !== Number(declared)) { return fail(); }
                const bytes = Buffer.concat(chunks);
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
        try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { deadline = true; if (timing) { timing.category = 'deadline'; } controller.abort(); reject(new MailError('upstream_timeout')); }, timeoutMs); })]); }
        catch (error) { if (deadline) { throw new MailError('upstream_timeout'); } if (timing && error instanceof MailError && error.code === 'too_large') { timing.category = 'too_large'; } if (error instanceof MailError) { throw error; } return fail(); }
        finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); }
    }
    private async request(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Json, cap = META_BYTES): Promise<Json> {
        const result = json((await this.transport(session, path, method, body, cap)).bytes);
        if (result['success'] !== true || result['error'] !== undefined || result['code'] !== undefined) { return fail(); }
        return result;
    }
    private async source(session: BackendMailSession, target: MessageKey): Promise<Buffer> {
        sessionValid(session); targetValid(target);
        return (await this.transport(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}/message.eml`, 'GET', undefined, MIME_LIMITS.sourceBytes, 'source')).bytes;
    }
    async listMailboxes(session: BackendMailSession): Promise<MailOutput<'list_mailboxes'>> {
        const raw = await this.request(session, '/mailboxes?showHidden=true', 'GET');
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
        const query = new URLSearchParams({ thread: threadId, order: 'asc', limit: String(data.limit), metaData: 'true' });
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
    async searchMessages(session: BackendMailSession, input: MailInput<'search_messages'>): Promise<MailOutput<'search_messages'>> {
        sessionValid(session); const parsed = mailInputSchemas.search_messages.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        if (data.flagged === false || data.hasAttachments === false) { throw new MailError('invalid_input'); }
        // Backend query fulltext has a 255-character limit; reject rather than silently narrow/truncate the requested search.
        if (data.text !== undefined && data.text.length > 255) { throw new MailError('invalid_input'); }
        const query = new URLSearchParams({ order: 'desc', limit: String(data.limit), metaData: 'true' });
        const fields = { mailboxId: 'mailbox', from: 'from', to: 'to', subject: 'subject', text: 'query', receivedSince: 'datestart', receivedUntil: 'dateend', flagged: 'flagged', hasAttachments: 'attachments', next: 'next', previous: 'previous' } as const;
        for (const [key, field] of Object.entries(fields)) { const value = data[key as keyof typeof fields]; if (value !== undefined) { query.set(field, String(value)); } }
        if (data.seen !== undefined) { query.set(data.seen ? 'seen' : 'unseen', 'true'); }
        const started = performance.now(); const timing: SearchTiming = { category: 'network' }; let validationStarted: number | undefined; let outcome: 'success' | 'failure' = 'failure';
        try {
            const response = await this.transport(session, `/search?${query}`, 'GET', undefined, META_BYTES, 'json', timing);
            validationStarted = performance.now(); timing.category = 'invalid_json'; const raw = json(response.bytes);
            timing.category = 'invalid_shape';
            if (raw['success'] !== true || raw['error'] !== undefined || raw['code'] !== undefined) { return fail(); }
            // Reject mismatched rows: WildDuck's timeout fallback can drop its mailbox filter.
            const result = this.page(raw, data.limit, session.accountId, data.mailboxId);
            if (!mailOutputSchemas.search_messages.safeParse(result).success) { return fail(); }
            outcome = 'success'; return result;
        } finally {
            // Construct only allowlisted primitives. Never log queries, identity, URLs,
            // response values, caller headers or thrown errors. Late fetches cannot emit.
            const diagnostic: SearchDiagnostic = { event: 'wildduck_search', outcome, scope: data.mailboxId === undefined ? 'global' : 'mailbox', durationMs: Math.round(performance.now() - started),
                ...(outcome === 'failure' ? { category: timing.category } : {}),
                ...(timing.headersMs === undefined ? {} : { headersMs: timing.headersMs }), ...(timing.bodyMs === undefined ? {} : { bodyMs: timing.bodyMs }),
                ...(validationStarted === undefined ? {} : { validationMs: Math.round(performance.now() - validationStarted) }),
                ...(timing.status === undefined ? {} : { status: timing.status }), ...(timing.timeoutMs === undefined ? {} : { timeoutMs: timing.timeoutMs }) };
            try { this.onSearchDiagnostic(diagnostic); } catch { /* Diagnostics must not alter mail results. */ }
        }
    }
    private async rawMessage(session: BackendMailSession, target: MessageKey): Promise<{ raw: Json; version: string }> {
        sessionValid(session); targetValid(target);
        const raw = await this.request(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}?markAsSeen=false&replaceCidLinks=false`, 'GET', undefined, MESSAGE_BYTES);
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
    async readMessage(session: BackendMailSession, input: MailInput<'read_message'>) {
        const snapshot = await this.rawMessage(session, input); const raw = snapshot.raw;
        // The API caps stored text in UTF-16 characters and HTML in UTF-8 bytes.
        // Reaching its ceiling is conservatively incomplete, even below our own cap.
        const html: string[] = []; let remaining = MAX_HTML_BYTES; let htmlTruncated = ((raw['html'] ?? []) as string[]).reduce((total, item) => total + Buffer.byteLength(item), 0) >= 640 * 1024;
        for (const item of (raw['html'] ?? []) as string[]) { const part = truncate(item, remaining); html.push(part.text); remaining -= Buffer.byteLength(part.text); htmlTruncated ||= part.textTruncated; }
        const text = truncate(typeof raw['text'] === 'string' ? raw['text'] : '');
        const message = { ...summary(raw, input.mailboxId), replyTo: addresses(raw['replyTo']), cc: addresses(raw['cc']), bcc: addresses(raw['bcc']),
            messageId: typeof raw['messageId'] === 'string' ? raw['messageId'] : null, references: (raw['references'] ?? []) as string[],
            ...text, textTruncated: text.textTruncated || typeof raw['text'] === 'string' && raw['text'].length >= 100 * 1024, html, htmlTruncated, htmlRepresentation: 'wildduck_normalized' as const,
            attachments: (raw['attachments'] as unknown[]).map(attachment), version: snapshot.version };
        if (!mailOutputSchemas.read_message.safeParse(message).success) { return fail(); }
        const marker = markerOf(raw); return { message, ...(marker ? { marker } : {}) };
    }
    async getAttachmentDownload(session: BackendMailSession, input: MailInput<'get_attachment_download'>): Promise<MailOutput<'get_attachment_download'>> {
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
                const result = { ...parsed.data, filename: metadata.filename, contentType: metadata.contentType, ...staged };
                if (!mailOutputSchemas.get_attachment_download.safeParse(result).success) { throw new MailError('verification_failed'); }
                return result;
            };
            try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MailError('upstream_timeout')); }, budget); })]); }
            catch (error) { if (error instanceof MailError) { throw error; } throw new MailError('temporarily_unavailable'); }
            finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); if (response && !response.bodyUsed) { void response.body?.cancel().catch(() => {}); } }
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
        const boxes = (await this.listMailboxes(session)).mailboxes.filter(box => box.specialUse === '\\Drafts');
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
    private async ownedFrom(session: BackendMailSession, desired?: { address: string; name?: string | undefined }): Promise<{ address: string; name?: string | undefined }> {
        if (desired && !isEmailValid(desired.address, API_EMAIL_OPTIONS)) { throw new MailError('invalid_input'); }
        const user = await this.request(session, '', 'GET');
        if (id(user['id']) !== session.accountId || typeof user['address'] !== 'string' || !isEmailValid(user['address'], API_EMAIL_OPTIONS)) { return fail(); }
        const address = desired?.address ?? user['address'];
        if (address !== user['address']) {
            const aliases = await this.request(session, '/addresses', 'GET');
            if (address.includes('*') || !Array.isArray(aliases['results']) || aliases['results'].length > 1000 || !aliases['results'].some(item => object(item) && item['address'] === address && !String(item['address']).includes('*'))) { throw new MailError('forbidden'); }
        }
        return desired ?? { address, ...(typeof user['name'] === 'string' && user['name'] ? { name: user['name'] } : {}) };
    }
    async prepareReply(session: BackendMailSession, input: MailInput<'create_reply_draft'>, marker: MailOperationMarker): Promise<PreparedDraft> {
        sessionValid(session); this.checkMarker(session, marker);
        const parsed = mailInputSchemas.create_reply_draft.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        try {
            const [original, defaultFrom, aliases, mailbox] = await Promise.all([this.readMessage(session, data.original), this.ownedFrom(session), this.request(session, '/addresses', 'GET'), this.resolveDraftMailbox(session)]);
            if (!Array.isArray(aliases['results']) || aliases['results'].length > 1000 || aliases['results'].some(item => !object(item) || typeof item['address'] !== 'string')) { return fail(); }
            const ownedAddresses = [defaultFrom.address, ...(aliases['results'] as Json[]).map(item => string(item['address'])).filter(address => !address.includes('*'))];
            const from = data.from ?? defaultFrom; if (!ownedAddresses.includes(from.address) || from.address.includes('*')) { throw new MailError('forbidden'); }
            const reply = deriveReply({ original: original.message, ownedAddresses, mode: data.mode, body: data.body, quoteOriginal: data.quoteOriginal, ...(data.to === undefined && data.cc === undefined ? {} : { recipients: { to: data.to ?? [], cc: data.cc ?? [] } }) });
            const mime = await createMime({ ...reply, from, attachments: data.attachments });
            const envelope = outbound(mime.envelope); if (envelope.from !== from.address) { throw new MailError('unsupported_content'); }
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            this.preparations.set(prepared, { accountId: session.accountId, envelope, flags: ['\\Seen', '\\Draft'], labels: [], metadata: { [MAIL_OPERATION_METADATA_KEY]: marker }, receivedAt: new Date().toISOString(), files: [] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    async prepareCreate(session: BackendMailSession, input: DraftContent, marker: MailOperationMarker): Promise<PreparedDraft> {
        sessionValid(session); this.checkMarker(session, marker);
        const parsed = draftContentSchema.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            const [mailbox, from] = await Promise.all([this.resolveDraftMailbox(session), this.ownedFrom(session, parsed.data.from)]);
            const mime = await createMime({ ...parsed.data, from });
            const envelope = outbound(mime.envelope); if (envelope.from !== from.address) { throw new MailError('unsupported_content'); }
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            this.preparations.set(prepared, { accountId: session.accountId, envelope,
                flags: ['\\Seen', '\\Draft'], labels: [], metadata: { [MAIL_OPERATION_METADATA_KEY]: marker }, receivedAt: new Date().toISOString(), files: [] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    async prepareUpdate(session: BackendMailSession, snapshot: MessageSnapshot, patch: DraftPatch, marker: MailOperationMarker, trusted: AuthoredSourceDescriptor): Promise<PreparedDraft> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        if (!snapshot.isDraft) { throw new MailError('unsupported_draft'); }
        const parsed = mailInputSchemas.update_draft.safeParse({ ...patch, uid: snapshot.message.uid, expected_version: snapshot.message.version, operation_id: marker.operationId });
        if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            const bytes = await this.authoredBytes(session, snapshot, trusted);
            const mailbox = await this.resolveDraftMailbox(session); if (mailbox.mailboxId !== snapshot.message.mailboxId) { throw new MailError('unsupported_draft'); }
            // Raw upload cannot copy received SMTP provenance, expiration or queue/authentication state.
            // Refuse these legacy cases instead of silently replacing them with upload defaults.
            if (!supportedDraftState(state.raw)) { throw new MailError('unsupported_content'); }
            if (patch.deleteAttachmentIds?.length && Array.isArray(state.raw['files']) && state.raw['files'].length > 0) { throw new MailError('unsupported_content'); }
            const source = await inspectSource(bytes, (state.raw['attachments'] as Json[]).map(item => ({ attachmentId: string(item['id']), hash: string(item['hash']) })));
            const mime = await preparePatch(source, patch);
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
        const result = await this.request(session, `/mailboxes/${prepared.mailboxId}/messages`, 'POST', {
            raw: prepared.mime.raw.toString('base64'), from: { address: state.envelope.from }, to: state.envelope.to.map(address => ({ address })), cc: [], bcc: [],
            date: state.receivedAt, draft: true, unseen: !state.flags.includes('\\Seen'), flagged: state.flags.includes('\\Flagged'), flags: state.flags, labels: state.labels,
            metaData: state.metadata, files: state.files.map(file => file['id']), ...(state.reference ? { reference: { ...state.reference, attachments: false } } : {})
        });
        if (!object(result['message']) || id(result['message']['mailbox']) !== prepared.mailboxId) { return fail(); }
        return { mailboxId: prepared.mailboxId, uid: uid(result['message']['id']) };
    }
    async verifyPreparedDraft(session: BackendMailSession, target: MessageKey, prepared: PreparedDraft): Promise<MessageRef> {
        const state = this.preparedState(session, prepared); targetValid(target);
        if (target.mailboxId !== prepared.mailboxId) { throw new MailError('verification_failed'); }
        const { raw, version: digest } = await this.rawMessage(session, target);
        try { verifyCandidate(prepared.mime, await this.source(session, target)); } catch (error) { return mimeError(error); }
        if (!bool(raw['draft']) || !supportedDraftState(raw)) { throw new MailError('verification_failed'); }
        assertSame(raw['envelope'], { from: '', rcpt: [] });
        // The existing API does not expose its private submission envelope. The upload
        // uses exactly the validated final-MIME envelope; do not claim a read-back proof.
        assertSame(metadata(raw), state.metadata); assertSame(date(raw['idate']), state.receivedAt);
        assertSame(raw['reference'], state.reference); assertSame(raw['files'] ?? [], state.files);
        setSame(strings(raw['flags']), state.flags); setSame(strings(raw['labels']), state.labels);
        return { ...target, version: digest };
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
        if (!parsed.success || patch.mailboxId !== snapshot.message.mailboxId || patch.uid !== snapshot.message.uid || patch.expected_version !== snapshot.message.version) { throw new MailError('invalid_input'); }
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
