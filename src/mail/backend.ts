import { createHash } from 'node:crypto';
import { WILDDUCK_ORIGIN } from '../wildduck';
import { MailError, MAIL_OPERATION_METADATA_KEY, type BackendMailSession, type MailBackendReader, type MailBackendWriter, type Mailbox, type MailInput, type MailOutput, type MessageKey, type DraftContent, type DraftPatch, type MessageSnapshot, type PreparedDraft, type MailOperationMarker, type MessageRef, type MessageSummary, type MailAddress, type AttachmentMetadata, type AttachmentDownload, type VerifiedMessageMutation } from './contracts';
import { draftContentSchema, mailboxIdSchema, messageKeySchema, mailInputSchemas, mailOutputSchemas, mailOperationMarkerSchema, addFlagSchema, labelSchema, MAX_READ_TEXT_BYTES, MAX_HTML_BYTES, MAX_ATTACHMENT_BYTES } from './schemas';
import { createMime, inspectSource, preparePatch, verifyCandidate, MimeError, MIME_LIMITS } from './mime';

const META_BYTES = 512 * 1024;
const MESSAGE_BYTES = 4 * 1024 * 1024;
const ACCOUNT = /^[a-f0-9]{24}$/u;
const TOKEN = /^[a-fA-F0-9]{40}$/u;
type Json = Record<string, unknown>;
export interface MailBackendOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number }
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
function outbound(raw: Json): OutboundEnvelope | null {
    if (!Object.hasOwn(raw, 'submissionEnvelope')) { throw new MailError('source_integrity_unavailable'); }
    const value = raw['submissionEnvelope']; if (value === null) { return null; }
    if (!object(value) || typeof value['from'] !== 'string') { throw new MailError('unsupported_content'); }
    return { from: value['from'], to: strings(value['to']) };
}
interface SnapshotState { accountId: string; raw: Json }
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
        mailboxId, uid: uid(raw['id']), subject: string(raw['subject']), from: addresses(raw['from']), to: addresses(raw['to']),
        date: date(raw['date']), receivedAt: date(raw['idate']), imapFlags: strings(raw['flags']), labels: strings(raw['labels']),
        flags: { seen: bool(raw['seen']), flagged: bool(raw['flagged']), draft: bool(raw['draft']), answered: bool(raw['answered']), deleted: bool(raw['deleted']), forwarded: bool(raw['forwarded']) },
        hasAttachments: Array.isArray(raw['attachments']) ? raw['attachments'].length > 0 : bool(raw['attachments']),
        ...(raw['size'] === undefined ? {} : { size: count(raw['size']) })
    };
}
function attachment(raw: unknown): AttachmentMetadata {
    if (!object(raw)) { return fail(); }
    const bytes = raw['size'] === undefined && typeof raw['sizeKb'] === 'number' && Number.isFinite(raw['sizeKb']) && raw['sizeKb'] >= 0 ? Math.ceil(raw['sizeKb'] * 1024) : raw['size'];
    if (raw['related'] !== undefined && typeof raw['related'] !== 'boolean') { return fail(); }
    return { attachmentId: string(raw['id']), filename: raw['filename'] === undefined || raw['filename'] === null ? null : string(raw['filename']), contentType: string(raw['contentType']), size: bytes === undefined ? null : count(bytes), sizeIsApproximate: bytes !== undefined && raw['size'] === undefined, inline: raw['related'] === true || raw['disposition'] === 'inline', cid: raw['cid'] === undefined || raw['cid'] === null ? null : string(raw['cid']) };
}
/** Preserve missing versus null, exact strings/array ordering and recursively sorted keys. */
function stable(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
    if (object(value)) { return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; }
    return JSON.stringify(value);
}
const VERSION_FIELDS = ['envelope', 'submissionEnvelope', 'forwarded', 'labels', 'from', 'replyTo', 'to', 'cc', 'bcc', 'subject', 'messageId', 'references', 'date', 'idate', 'text', 'html', 'attachments', 'files', 'draft', 'flags', 'seen', 'flagged', 'answered', 'deleted', 'contentType', 'reference', 'metaData', 'expires', 'verificationResults', 'outbound', 'forwardTargets'] as const;
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
    private readonly fetcher: typeof globalThis.fetch;
    private readonly timeoutMs: number;
    private readonly snapshots = new WeakMap<MessageSnapshot, SnapshotState>();
    private readonly preparations = new WeakMap<PreparedDraft, PreparationState>();
    constructor(options: MailBackendOptions) {
        this.fetcher = options.fetch ?? globalThis.fetch; this.timeoutMs = options.timeoutMs ?? 10_000;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) { throw new MailError('invalid_input'); }
    }
    private async transport(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body: Json | undefined, cap: number, kind: 'json' | 'source' | 'attachment' = 'json'): Promise<{ bytes: Buffer; headers: Headers }> {
        sessionValid(session);
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = async () => {
            const response = await this.fetcher(`${WILDDUCK_ORIGIN}/users/${session.accountId}${path}`, { method, redirect: 'error', signal: controller.signal,
                headers: { Accept: kind === 'json' ? 'application/json' : kind === 'source' ? 'message/rfc822' : '*/*', 'Accept-Encoding': 'identity', 'X-Access-Token': session.accessToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const discard = () => { void response.body?.cancel().catch(() => {}); };
            if (response.redirected || response.status >= 300 && response.status < 400) { discard(); return fail(); }
            if (kind === 'source' && response.status === 200 && response.headers.get('X-Wildduck-Source-Integrity') !== 'strict') { discard(); throw new MailError('source_integrity_unavailable'); }
            const encoded = response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity';
            if (kind === 'source' && encoded) { discard(); throw new MailError('source_integrity_unavailable'); }
            const contentType = response.headers.get('content-type') ?? '';
            if ((kind === 'json' || response.status !== 200) && !/^application\/json(?:\s*;|$)/iu.test(contentType) || kind === 'source' && response.status === 200 && !/^message\/rfc822(?:\s*;|$)/iu.test(contentType)) { discard(); return fail(); }
            const declared = response.headers.get('content-length');
            if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > cap)) { discard(); throw new MailError('too_large'); }
            if (kind === 'source' && response.status === 200 && declared === null) { discard(); throw new MailError('source_integrity_unavailable'); }
            if (!response.body) { return fail(); }
            const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
            const cancel = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) { const chunk = await reader.read(); if (chunk.done) { break; } size += chunk.value.byteLength; if (size > cap) { throw new MailError('too_large'); } chunks.push(chunk.value); }
                if (declared !== null && !encoded && size !== Number(declared)) { return fail(); }
                const bytes = Buffer.concat(chunks);
                if (response.status === 200) { return { bytes, headers: response.headers }; }
                const result = json(bytes);
                if (response.status === 403 && result['code'] === 'InvalidToken') { throw new MailError('reconnect_required'); }
                if (response.status === 404) { throw new MailError('not_found'); }
                if (response.status === 401 || response.status === 403) { throw new MailError('forbidden'); }
                if (response.status === 400) { throw new MailError('invalid_input'); }
                return fail();
            } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        };
        try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MailError('temporarily_unavailable')); }, this.timeoutMs); })]); }
        catch (error) { if (error instanceof MailError) { throw error; } return fail(); }
        finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); }
    }
    private async request(session: BackendMailSession, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: Json, cap = META_BYTES): Promise<Json> {
        const result = json((await this.transport(session, path, method, body, cap)).bytes);
        if (result['success'] !== true || result['error'] !== undefined || result['code'] !== undefined) { return fail(); }
        return result;
    }
    private async source(session: BackendMailSession, target: MessageKey): Promise<Buffer> {
        sessionValid(session); targetValid(target);
        return (await this.transport(session, `/mailboxes/${target.mailboxId}/messages/${target.uid}/message.eml?strict=true`, 'GET', undefined, MIME_LIMITS.sourceBytes, 'source')).bytes;
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
    async listMessages(session: BackendMailSession, input: MailInput<'list_messages'>): Promise<MailOutput<'list_messages'>> {
        sessionValid(session); const parsed = mailInputSchemas.list_messages.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const query = new URLSearchParams({ order: 'desc', limit: String(parsed.data.limit), metaData: 'true' });
        if (parsed.data.next !== undefined) { query.set('next', parsed.data.next); } if (parsed.data.previous !== undefined) { query.set('previous', parsed.data.previous); }
        return this.page(await this.request(session, `/mailboxes/${parsed.data.mailboxId}/messages?${query}`, 'GET'), parsed.data.limit, session.accountId, parsed.data.mailboxId);
    }
    async searchMessages(session: BackendMailSession, input: MailInput<'search_messages'>): Promise<MailOutput<'search_messages'>> {
        sessionValid(session); const parsed = mailInputSchemas.search_messages.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        const data = parsed.data;
        // Backend query fulltext has a 255-character limit; reject rather than silently narrow/truncate the requested search.
        if (data.text !== undefined && data.text.length > 255) { throw new MailError('invalid_input'); }
        const query = new URLSearchParams({ order: 'desc', limit: String(data.limit), metaData: 'true' });
        const fields = { mailboxId: 'mailbox', from: 'from', to: 'to', subject: 'subject', text: 'query', receivedSince: 'datestart', receivedUntil: 'dateend', seen: 'seen', flagged: 'flagged', hasAttachments: 'attachments', next: 'next', previous: 'previous' } as const;
        for (const [key, field] of Object.entries(fields)) { const value = data[key as keyof typeof fields]; if (value !== undefined) { query.set(field, String(value)); } }
        // Reject mismatched rows: WildDuck's timeout fallback can drop its mailbox filter.
        return this.page(await this.request(session, `/search?${query}`, 'GET'), data.limit, session.accountId, data.mailboxId);
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
        const html: string[] = []; let remaining = MAX_HTML_BYTES; let htmlTruncated = false;
        for (const item of (raw['html'] ?? []) as string[]) { const part = truncate(item, remaining); html.push(part.text); remaining -= Buffer.byteLength(part.text); htmlTruncated ||= part.textTruncated; }
        const message = { ...summary(raw, input.mailboxId), replyTo: addresses(raw['replyTo']), cc: addresses(raw['cc']), bcc: addresses(raw['bcc']),
            messageId: typeof raw['messageId'] === 'string' ? raw['messageId'] : null, references: (raw['references'] ?? []) as string[],
            ...truncate(typeof raw['text'] === 'string' ? raw['text'] : ''), html, htmlTruncated, htmlRepresentation: 'wildduck_normalized' as const,
            attachments: (raw['attachments'] as unknown[]).map(attachment), version: snapshot.version };
        if (!mailOutputSchemas.read_message.safeParse(message).success) { return fail(); }
        const marker = markerOf(raw); return { message, ...(marker ? { marker } : {}) };
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
        const envelope = outbound(raw);
        const hasRecipients = envelope === null ? [...addresses(raw['to']), ...addresses(raw['cc']), ...addresses(raw['bcc'])].some(address => address.address.trim().length > 0) : envelope.to.some(address => address.trim().length > 0);
        const marker = markerOf(raw);
        const snapshot: MessageSnapshot = { message: { ...target, version: digest }, isDraft: bool(raw['draft']), hasHtml: mime !== 'text/plain' && (mime === 'text/html' || (raw['html'] as unknown[] | undefined)?.length !== 0 && raw['html'] !== undefined), hasAttachments: (raw['attachments'] as unknown[]).length > 0 || Array.isArray(raw['files']) && raw['files'].length > 0, hasRecipients, ...(marker ? { marker } : {}) };
        this.snapshots.set(snapshot, { accountId: session.accountId, raw }); return snapshot;
    }
    private state(session: BackendMailSession, snapshot: MessageSnapshot): SnapshotState {
        sessionValid(session); const state = this.snapshots.get(snapshot);
        if (!state || state.accountId !== session.accountId || version(session, snapshot.message, state.raw) !== snapshot.message.version) { throw new MailError('invalid_input'); }
        return state;
    }
    private checkMarker(session: BackendMailSession, marker: MailOperationMarker): void {
        if (!mailOperationMarkerSchema.safeParse(marker).success || marker.accountId !== session.accountId) { throw new MailError('invalid_input'); }
    }
    private marked(raw: Json, marker: MailOperationMarker): Json { return { ...metadata(raw), [MAIL_OPERATION_METADATA_KEY]: marker }; }
    private async ownedFrom(session: BackendMailSession, desired?: { address: string; name?: string | undefined }): Promise<{ address: string; name?: string | undefined }> {
        const user = await this.request(session, '', 'GET');
        if (id(user['id']) !== session.accountId || typeof user['address'] !== 'string' || !user['address']) { return fail(); }
        const address = desired?.address ?? user['address'];
        if (address !== user['address']) {
            const whitelist = strings(user['fromWhitelist'] ?? []);
            const allowed = whitelist.some(item => item === address || item.startsWith('*') && address.endsWith(item.slice(1)) || item.endsWith('*') && address.startsWith(item.slice(0, -1)));
            if (!allowed) {
                const aliases = await this.request(session, '/addresses', 'GET');
                if (!Array.isArray(aliases['results']) || aliases['results'].length > 1000 || !aliases['results'].some(item => object(item) && item['address'] === address)) { throw new MailError('forbidden'); }
            }
        }
        return desired ?? { address, ...(typeof user['name'] === 'string' && user['name'] ? { name: user['name'] } : {}) };
    }
    async prepareCreate(session: BackendMailSession, input: DraftContent, marker: MailOperationMarker): Promise<PreparedDraft> {
        sessionValid(session); this.checkMarker(session, marker);
        const parsed = draftContentSchema.safeParse(input); if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            const [mailbox, from] = await Promise.all([this.resolveDraftMailbox(session), this.ownedFrom(session, parsed.data.from)]);
            const mime = await createMime({ ...parsed.data, from });
            const prepared: PreparedDraft = { mailboxId: mailbox.mailboxId, mime, marker };
            this.preparations.set(prepared, { accountId: session.accountId, envelope: { from: from.address, to: [...new Set([...mime.envelope.to, ...mime.envelope.cc, ...mime.envelope.bcc].map(item => item.address))] },
                flags: ['\\Seen', '\\Draft'], labels: [], metadata: { [MAIL_OPERATION_METADATA_KEY]: marker }, receivedAt: new Date().toISOString(), files: [] });
            return prepared;
        } catch (error) { return mimeError(error); }
    }
    async prepareUpdate(session: BackendMailSession, snapshot: MessageSnapshot, patch: DraftPatch, marker: MailOperationMarker): Promise<PreparedDraft> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        if (!snapshot.isDraft) { throw new MailError('unsupported_draft'); }
        const parsed = mailInputSchemas.update_draft.safeParse({ ...patch, uid: snapshot.message.uid, expected_version: snapshot.message.version, operation_id: marker.operationId });
        if (!parsed.success) { throw new MailError('invalid_input'); }
        try {
            const mailbox = await this.resolveDraftMailbox(session); if (mailbox.mailboxId !== snapshot.message.mailboxId) { throw new MailError('unsupported_draft'); }
            // Raw upload cannot copy received SMTP provenance, expiration or queue/authentication state.
            // Refuse these legacy cases instead of silently replacing them with upload defaults.
            if (!supportedDraftState(state.raw)) { throw new MailError('unsupported_content'); }
            const envelope = outbound(state.raw);
            // Upload always materializes an envelope; absence cannot be preserved faithfully.
            if (!envelope || !envelope.from || !same(Object.keys(state.raw['submissionEnvelope'] as Json).sort(), ['from', 'to'])) { throw new MailError('unsupported_content'); }
            if (['to', 'cc', 'bcc'].some(key => patch[key as 'to' | 'cc' | 'bcc'] !== undefined)) {
                const represented = new Set(['to', 'cc', 'bcc'].flatMap(key => addresses(state.raw[key]).map(item => item.address)));
                if (envelope.to.some(address => !represented.has(address))) { throw new MailError('unsupported_content'); }
            }
            if (patch.deleteAttachmentIds?.length && Array.isArray(state.raw['files']) && state.raw['files'].length > 0) { throw new MailError('unsupported_content'); }
            const from = await this.ownedFrom(session, { address: patch.from?.address ?? envelope.from, ...(patch.from?.name === undefined ? {} : { name: patch.from.name }) });
            const source = await inspectSource(await this.source(session, snapshot.message), (state.raw['attachments'] as Json[]).map(item => ({ attachmentId: string(item['id']), hash: string(item['hash']) })));
            const mime = await preparePatch(source, patch);
            const recipients = new Set(envelope.to);
            const untouched = new Set((['to', 'cc', 'bcc'] as const).filter(key => patch[key] === undefined).flatMap(key => source.envelope[key].map(item => item.address)));
            for (const key of ['to', 'cc', 'bcc'] as const) {
                if (patch[key] === undefined) { continue; }
                for (const old of source.envelope[key]) { if (!untouched.has(old.address)) { recipients.delete(old.address); } }
                for (const added of patch[key]) { recipients.add(added.address); }
            }
            if (recipients.size > 100) { throw new MailError('unsupported_content'); }
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
            this.preparations.set(prepared, { accountId: session.accountId, envelope: { from: from.address, to: [...recipients] }, flags, labels, metadata: this.marked(state.raw, marker), receivedAt, ...(reference ? { reference } : {}), files: files as Json[] });
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
        assertSame(outbound(raw), state.envelope); assertSame(metadata(raw), state.metadata); assertSame(date(raw['idate']), state.receivedAt);
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
    private async verifyMutation(session: BackendMailSession, snapshot: MessageSnapshot, target: MessageKey, before: Buffer, expectedMetadata: Json, expectedFlags?: string[], expectedLabels?: string[]): Promise<VerifiedMessageMutation> {
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
        return { message: { ...target, version: digest }, contentDigest: createHash('sha256').update(after).digest('hex') };
    }
    async stampSendMarker(session: BackendMailSession, snapshot: MessageSnapshot, marker: MailOperationMarker): Promise<MessageRef> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        const bytes = await this.source(session, snapshot.message); const metaData = this.marked(state.raw, marker);
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', { metaData });
        if (result['updated'] !== 1) { throw new MailError('verification_failed'); }
        return (await this.verifyMutation(session, snapshot, snapshot.message, bytes, metaData)).message;
    }
    async moveMessage(session: BackendMailSession, snapshot: MessageSnapshot, destinationMailboxId: string, marker: MailOperationMarker): Promise<VerifiedMessageMutation> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        if (!mailboxIdSchema.safeParse(destinationMailboxId).success || destinationMailboxId === snapshot.message.mailboxId) { throw new MailError('invalid_input'); }
        const destination = await this.request(session, `/mailboxes/${destinationMailboxId}`, 'GET');
        if (id(destination['id']) !== destinationMailboxId) { throw new MailError('verification_failed'); }
        const bytes = await this.source(session, snapshot.message); const metaData = this.marked(state.raw, marker);
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', { moveTo: destinationMailboxId, metaData });
        if (result['mailbox'] !== destinationMailboxId || !Array.isArray(result['id']) || result['id'].length !== 1 || !Array.isArray(result['id'][0]) || result['id'][0].length !== 2 || result['id'][0][0] !== snapshot.message.uid) { throw new MailError('verification_failed'); }
        const target = { mailboxId: destinationMailboxId, uid: uid(result['id'][0][1]) };
        return this.verifyMutation(session, snapshot, target, bytes, metaData);
    }
    async updateMessageFlags(session: BackendMailSession, snapshot: MessageSnapshot, patch: MailInput<'update_message_flags'>, marker: MailOperationMarker): Promise<VerifiedMessageMutation> {
        const state = this.state(session, snapshot); this.checkMarker(session, marker);
        const parsed = mailInputSchemas.update_message_flags.safeParse(patch);
        if (!parsed.success || patch.mailboxId !== snapshot.message.mailboxId || patch.uid !== snapshot.message.uid || patch.expected_version !== snapshot.message.version) { throw new MailError('invalid_input'); }
        const flags = new Set(strings(state.raw['flags']).map(canonicalFlag));
        for (const value of patch.removeFlags ?? []) { flags.delete(canonicalFlag(value)); } for (const value of patch.addFlags ?? []) { flags.add(canonicalFlag(value)); }
        for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']] as const) { if (patch[key] === true) { flags.add(flag); } else if (patch[key] === false) { flags.delete(flag); } }
        const labels = new Set(patch.labels ?? strings(state.raw['labels']));
        for (const value of patch.removeLabels ?? []) { labels.delete(value); } for (const value of patch.addLabels ?? []) { labels.add(value); }
        const bytes = await this.source(session, snapshot.message); const metaData = this.marked(state.raw, marker); const body: Json = { metaData };
        for (const key of ['seen', 'flagged', 'addFlags', 'removeFlags', 'labels', 'addLabels', 'removeLabels'] as const) { if (patch[key] !== undefined) { body[key] = patch[key]; } }
        const result = await this.request(session, `/mailboxes/${snapshot.message.mailboxId}/messages/${snapshot.message.uid}`, 'PUT', body);
        if (result['updated'] !== 1) { throw new MailError('verification_failed'); }
        const verified = await this.verifyMutation(session, snapshot, snapshot.message, bytes, metaData, [...flags], [...labels]);
        return verified;
    }
}
function canonicalFlag(value: string): string {
    const known: Record<string, string> = { '\\seen': '\\Seen', '\\flagged': '\\Flagged', '\\answered': '\\Answered', '\\draft': '\\Draft', '\\deleted': '\\Deleted' };
    return known[value.toLowerCase()] ?? value;
}
export function createMailBackend(options: MailBackendOptions = {}): MailBackendReader & MailBackendWriter { return new MailBackend(options); }
