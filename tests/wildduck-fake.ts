/** Test support: an in-memory WildDuck API for one account, with received messages that carry
 * attachments, a Drafts mailbox that stores raw uploads as WildDuck does (final line completed,
 * source served byte for byte), and in-memory upload records and staged objects (issue #2). Shared
 * by the attachment-source tests and the 25 MiB memory child, so it copies as little as it can. */
import { createHash } from 'node:crypto';
import { createMailBackend, type MailBackendOptions } from '../src/mail/backend';
import { MailError, ATTACHMENT_UPLOAD_KEY_PREFIX, type AttachmentUploadRecord, type AttachmentUploadStager, type AttachmentUploadStore, type DraftMailSession, type MailBackendWriter, type MailOperationRecord, type MailOperationStore, type MailReceipt, type OperationClaim, type OperationKey } from '../src/mail/contracts';
import { inspectSource } from '../src/mail/mime';
import { digest } from '../src/auth/crypto';
import { WILDDUCK_ORIGIN } from '../src/wildduck';

type Json = Record<string, unknown>;
export const accountId = 'a'.repeat(24); export const draftsId = 'b'.repeat(24); export const inboxId = 'f'.repeat(24); export const token = 'c'.repeat(40);
/** The OAuth client of the tests, and its digest as the service derives it. */
export const clientId = 'client-one'; export const clientIdHash = digest(clientId);
export const session: DraftMailSession = { accountId, accessToken: token, clientIdHash };
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** One attachment of a received message: its decoded bytes and the metadata WildDuck lists. */
export interface StoredFile { readonly bytes: Uint8Array; readonly filename?: string | null; readonly contentType: string; readonly transferEncoding?: string; readonly size?: number; readonly related?: boolean }
/** How the attachment endpoint serves one file. */
export interface Serving { readonly undeclared?: boolean; readonly hang?: boolean; readonly chunk?: number; readonly pauseMs?: number }
export interface Call { readonly method: string; readonly path: string }
export function received(uid: number, files: Record<string, StoredFile>, extra: Json = {}): { json: Json; files: Record<string, StoredFile> } {
    const attachments = Object.entries(files).map(([id, file]) => ({ id, filename: file.filename === undefined ? 'file.bin' : file.filename, contentType: file.contentType, transferEncoding: file.transferEncoding ?? 'binary', size: file.size ?? file.bytes.byteLength, hash: 'e'.repeat(64), related: file.related ?? false }));
    return { json: { ...message(inboxId, uid, { seen: true, flags: ['\\Seen'], envelope: { from: 'author@example.com', rcpt: [{ value: 'sender@example.com', formatted: 'sender@example.com' }] } }), attachments, ...extra }, files };
}
function message(mailbox: string, uid: number, extra: Json = {}): Json {
    return { success: true, user: accountId, id: uid, mailbox, subject: 'Original', from: { address: 'author@example.com', name: 'Author' }, to: [{ address: 'sender@example.com' }], cc: [], bcc: [], replyTo: [],
        date: '2026-10-26T00:00:00.000Z', idate: '2026-10-26T01:00:00.000Z', seen: false, flagged: false, draft: false, answered: false, deleted: false, forwarded: false, labels: [], metaData: {},
        attachments: [], flags: [], envelope: { from: '', rcpt: [] }, references: [], messageId: '<received@example.com>', text: 'Original text', html: [], contentType: { value: 'multipart/mixed' }, ...extra };
}
/** WildDuck's multipart upload fields (api.js, @fastify/multipart keyValues), parsed over views of the body. */
function upload(init: RequestInit): { raw: Buffer; fields: Json } {
    const boundary = /boundary=(\S+)$/u.exec(new Headers(init.headers).get('content-type') ?? '')?.[1];
    const body = init.body;
    if (!boundary || !(body instanceof Uint8Array)) { throw new Error('upload is not a multipart buffer'); }
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const marker = Buffer.from(`\r\n--${boundary}`); const fields: Json = {}; let raw: Buffer | undefined;
    for (let start = Buffer.byteLength(`--${boundary}\r\n`); ;) {
        const end = bytes.indexOf(marker, start); if (end < 0) { break; }
        const part = bytes.subarray(start, end); const split = part.indexOf('\r\n\r\n');
        const head = part.subarray(0, split).toString('latin1'); const name = /name="([^"]+)"/u.exec(head)?.[1] ?? '';
        if (name === 'raw') { raw = part.subarray(split + 4); } else { fields[name] = JSON.parse(part.subarray(split + 4).toString('utf8')); }
        start = end + marker.length + 2;
    }
    if (!raw) { throw new Error('upload without raw'); }
    return { raw, fields };
}
/** Abort-aware body that delivers `bytes` in chunks, or never finishes when `hang`. */
function served(bytes: Uint8Array, options: Serving, signal: AbortSignal | null | undefined, cancelled: () => void): ReadableStream<Uint8Array> {
    const size = options.chunk ?? 64 * 1024; let offset = 0;
    return new ReadableStream<Uint8Array>({
        pull: async controller => {
            if (options.hang && offset >= Math.min(size, bytes.byteLength)) { await new Promise<void>(resolve => { signal?.addEventListener('abort', () => { resolve(); }, { once: true }); }); controller.error(new DOMException('aborted', 'AbortError')); return; }
            if (offset >= bytes.byteLength) { controller.close(); return; }
            if (options.pauseMs) { await Bun.sleep(options.pauseMs); }
            controller.enqueue(bytes.subarray(offset, offset + size)); offset += size;
        },
        cancel: () => { cancelled(); },
    }, { highWaterMark: 0 });
}
export interface FakeOptions extends Pick<MailBackendOptions, 'timeoutMs'> {
    /** List draft attachments (id and transfer-encoded hash) as WildDuck does; costs an inspection of each stored draft. */
    readonly listAttachments?: boolean;
    /** By `mailbox:uid:ATTn` for attachments, `mailbox:uid` for a draft's source. */
    readonly serving?: Record<string, Serving>;
    /** Milliseconds to wait before answering a call (before its headers). */
    readonly delayMs?: (call: Call) => number;
    readonly uploads?: { readonly store?: AttachmentUploadStore; readonly stager?: AttachmentUploadStager } | false;
}
export function fakeWildduck(messages: Array<{ json: Json; files: Record<string, StoredFile> }> = [], options: FakeOptions = {}) {
    const calls: Call[] = []; const cancelled: string[] = [];
    const store = new Map<string, { json: Json; files: Record<string, StoredFile>; raw?: Buffer }>(messages.map(item => [`${String(item.json['mailbox'])}:${String(item.json['id'])}`, item]));
    let nextUid = 100;
    const staged = stagedUploads();
    const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
        const parsed = new URL(String(url)); const method = init.method ?? 'GET';
        if (parsed.origin !== WILDDUCK_ORIGIN || new Headers(init.headers).get('X-Access-Token') !== token || init.redirect !== 'error') { throw new Error('unexpected request'); }
        const prefix = `/users/${accountId}`; if (!parsed.pathname.startsWith(prefix)) { throw new Error('foreign account'); }
        const path = parsed.pathname.slice(prefix.length); calls.push({ method, path });
        const delay = options.delayMs?.({ method, path }) ?? 0; if (delay) { await Bun.sleep(delay); }
        const missing = () => Response.json({ error: 'missing', code: 'MessageNotFound' }, { status: 404 });
        if (path === '') { return Response.json({ success: true, id: accountId, address: 'sender@example.com', name: 'Sender' }); }
        if (path === '/addresses') { return Response.json({ success: true, results: [] }); }
        if (path === '/mailboxes') { return Response.json({ success: true, results: [{ id: draftsId, path: 'Drafts', specialUse: '\\Drafts' }, { id: inboxId, path: 'INBOX', specialUse: null }] }); }
        if (method === 'POST' && path === `/mailboxes/${draftsId}/messages`) {
            const { raw: uploaded, fields } = upload(init);
            // WildDuck completes a message whose last line lacks LF; its source endpoint rebuilds the stored bytes.
            const raw = uploaded.at(-1) === 10 ? uploaded : Buffer.concat([uploaded, Buffer.from('\r\n')]);
            const uid = nextUid++; const listed = options.listAttachments === false ? [] : (await inspectSource(raw)).attachments.map((part, index) => ({ id: `ATT${String(index + 1).padStart(5, '0')}`, hash: part.encodedBodySha256, contentType: part.contentType, filename: 'file', transferEncoding: 'base64', size: part.rawBytes }));
            const reference = fields['reference'] as Json | undefined;
            const json = message(draftsId, uid, { draft: fields['draft'], idate: fields['date'], metaData: fields['metaData'], flags: fields['flags'], labels: fields['labels'], seen: !fields['unseen'], flagged: fields['flagged'], attachments: listed, to: fields['to'], from: fields['from'], text: '',
                ...(reference ? { reference: { mailbox: reference['mailbox'], id: reference['id'], action: reference['action'] } } : {}) });
            store.set(`${draftsId}:${uid}`, { json, files: {}, raw });
            return Response.json({ success: true, message: { id: uid, mailbox: draftsId } });
        }
        const match = /^\/mailboxes\/([a-f0-9]{24})\/messages\/(\d+)(\/message\.eml|\/attachments\/(ATT\d+))?$/u.exec(path);
        if (!match) { throw new Error('unexpected path ' + path); }
        const key = `${match[1]}:${match[2]}`; const item = store.get(key);
        if (method === 'DELETE') { if (!item) { return missing(); } store.delete(key); return Response.json({ success: true, deleted: 1, errors: 0 }); }
        if (!item) { return missing(); }
        if (match[3] === '/message.eml') {
            const raw = item.raw ?? Buffer.alloc(0); const serving = options.serving?.[key];
            return new Response(serving ? served(raw, serving, init.signal, () => { cancelled.push(key); }) : raw as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'message/rfc822', 'content-length': String(raw.length) } });
        }
        if (match[4] !== undefined) {
            const file = item.files[match[4]]; if (!file) { return missing(); }
            const serving = options.serving?.[`${key}:${match[4]}`] ?? {};
            if (serving.hang && file.bytes.byteLength === 0) { return new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); }, { once: true }); }); }
            return new Response(served(file.bytes, serving, init.signal, () => { cancelled.push(`${key}:${match[4]}`); }), { headers: { 'content-type': file.contentType, ...(serving.undeclared ? {} : { 'content-length': String(file.bytes.byteLength) }) } });
        }
        if (parsed.search !== '?markAsSeen=false&replaceCidLinks=false') { throw new Error('unexpected message query'); }
        return Response.json(item.json);
    }) as typeof fetch;
    const uploads = options.uploads === false ? {} : { uploadStore: options.uploads?.store ?? staged.store, uploadStager: options.uploads?.stager ?? staged.stager };
    // This backend always implements prepareReply.
    const backend = createMailBackend({ fetch: fetcher, timeoutMs: options.timeoutMs ?? 10_000, ...uploads, onDraftVerificationDiagnostic: () => {} }) as ReturnType<typeof createMailBackend> & Required<Pick<MailBackendWriter, 'prepareReply'>>;
    return { backend, calls, cancelled, staged, draft: (uid: number) => store.get(`${draftsId}:${uid}`), source: (uid: number) => store.get(`${draftsId}:${uid}`)?.raw ?? Buffer.alloc(0) };
}
/** The operation ledger in memory, with the store's replay and conflict semantics. */
export function memoryOperations(): MailOperationStore {
    const records = new Map<string, MailOperationRecord>();
    const keyOf = (key: OperationKey) => JSON.stringify([key.accountId, key.clientIdHash, key.operationId]);
    const settle = (state: MailOperationRecord['state']) => async (claim: OperationClaim, receipt?: MailReceipt) => {
        const record = records.get(keyOf(claim.key)); if (!record) { throw new Error('missing'); }
        records.set(keyOf(claim.key), { ...record, revision: record.revision + 1, ...(state === 'settled' ? { state, receipt: receipt as MailReceipt } : { state }) } as MailOperationRecord);
        return { ...claim, state: 'dispatched' as const, revision: record.revision + 1 };
    };
    return {
        getOperation: async key => { const record = records.get(keyOf(key)); return record && structuredClone(record); },
        reserve: async (intent, ownerToken) => {
            const existing = records.get(keyOf(intent)); if (existing) { return JSON.stringify(existing.intent) === JSON.stringify(intent) ? { kind: 'replay', record: structuredClone(existing) } : { kind: 'conflict', reason: 'operation_conflict' }; }
            const key = { accountId: intent.accountId, clientIdHash: intent.clientIdHash, operationId: intent.operationId }; records.set(keyOf(key), { key, intent, ownerToken, revision: 0, state: 'reserved', reservedAt: Math.floor(Date.now() / 1000) });
            return { kind: 'acquired', claim: { key, ownerToken, revision: 0, state: 'reserved' } };
        },
        markDispatched: async claim => settle('dispatched')(claim),
        failPreflight: async (claim, receipt) => { await settle('settled')(claim, receipt); },
        complete: async (claim, receipt) => { await settle('settled')(claim, receipt); },
        markOutcomeUnknown: async (claim, receipt) => { await settle('settled')(claim, receipt); },
        failDispatched: async (claim, receipt) => { await settle('settled')(claim, receipt); },
        // This ledger keeps no guards.
        getGuard: async () => undefined, releaseGuard: async () => false,
        resolveUnknown: async (record, receipt) => { await settle('settled')({ key: record.key, ownerToken: record.ownerToken, revision: record.revision, state: 'dispatched' }, receipt); },
    };
}
/** Upload records bound to account and client, and their staged objects, as the DynamoDB store and
 * S3 stager behave: foreign and expired records are absent; other bytes are verification_failed. */
export function stagedUploads() {
    const records = new Map<string, AttachmentUploadRecord>(); const objects = new Map<string, Uint8Array>();
    const batches: string[][] = []; const reads: string[] = [];
    const add = (uploadId: string, bytes: Uint8Array, over: Partial<AttachmentUploadRecord> = {}, stored: Uint8Array = bytes) => {
        const record: AttachmentUploadRecord = { uploadId, accountId, clientIdHash, sizeBytes: bytes.byteLength, sha256: sha256(bytes), objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + uploadId, expiresAt: Math.floor(Date.now() / 1000) + 900, ...over };
        records.set(uploadId, record); objects.set(record.objectKey, stored); return record;
    };
    const store: AttachmentUploadStore = {
        createUpload: async () => { throw new MailError('temporarily_unavailable'); },
        getUploads: async (owner, ids) => {
            batches.push([...ids]);
            return new Map(ids.flatMap(id => { const record = records.get(id); return record && record.accountId === owner.accountId && record.clientIdHash === owner.clientIdHash && record.expiresAt > Date.now() / 1000 ? [[id, record] as const] : []; }));
        },
    };
    const stager: AttachmentUploadStager = {
        presign: async () => { throw new MailError('temporarily_unavailable'); },
        readStaged: async (record, { maxBytes, signal }) => {
            reads.push(record.uploadId);
            if (signal.aborted) { throw new MailError('upstream_timeout'); }
            if (record.sizeBytes > maxBytes) { throw new MailError('too_large'); }
            const bytes = objects.get(record.objectKey); if (!bytes) { throw new MailError('not_found'); }
            if (bytes.byteLength !== record.sizeBytes || sha256(bytes) !== record.sha256) { throw new MailError('verification_failed'); }
            return bytes;
        },
    };
    return { add, store, stager, batches, reads, records };
}
