import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { digest } from '../src/auth/crypto';
import { createMailService } from '../src/mail/service';
import { ATTACHMENT_UPLOAD_KEY_PREFIX, MailError, type AttachmentUploadRecord, type AttachmentUploadStager, type AttachmentUploadStore, type MailContext, type PresignedAttachmentUpload } from '../src/mail/contracts';
import { UPLOAD_TTL_SECONDS } from '../src/mail/schemas';

const accountId = 'a'.repeat(24);
const context: MailContext = { accountId, accessToken: 'c'.repeat(40), clientId: 'client-one', scopes: ['mail:draft'], connectionStatus: 'active' };
const request = { sizeBytes: 1234, sha256: 'e'.repeat(64) };
const NOW_MS = Date.UTC(2026, 10, 16, 12, 0, 0);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
afterEach(() => { setSystemTime(); });
/** Stores and a stager that note every call. Nothing else is reachable: the other dependencies throw if touched. */
function fixture(options: { presigned?: Partial<PresignedAttachmentUpload>; storeError?: Error; stagerError?: Error } = {}) {
    const events: string[] = []; const records: AttachmentUploadRecord[] = []; const signed: AttachmentUploadRecord[] = [];
    const store: AttachmentUploadStore = {
        createUpload: async record => { events.push('createUpload'); records.push(record); if (options.storeError) { throw options.storeError; } },
        getUploads: async () => { events.push('getUploads'); return new Map(); },
    };
    const stager: AttachmentUploadStager = {
        presign: async record => {
            events.push('presign'); signed.push(record); if (options.stagerError) { throw options.stagerError; }
            return { url: 'https://bucket.s3.amazonaws.com/uploads/v1/secret?X-Amz-Signature=synthetic-secret', expiresAt: new Date(NOW_MS + 600_000).toISOString(), method: 'PUT', headers: { 'Content-Length': String(record.sizeBytes), 'x-amz-checksum-sha256': 'abc=' }, ...options.presigned };
        },
        readStaged: async () => { events.push('readStaged'); throw new Error('not used'); },
    };
    const forbidden = new Proxy({}, { get: (_target, property) => { throw new Error(`unexpected access to ${String(property)}`); } }) as never;
    const service = createMailService({ reader: forbidden, writer: forbidden, operations: forbidden, uploads: { store, stager } });
    return { service, events, records, signed, store, stager, forbidden };
}

test('a call stages one upload record owned by the verified account and client, with one store write and one signature and nothing else', async () => {
    setSystemTime(new Date(NOW_MS)); const f = fixture();
    const result = await f.service.create_attachment_upload(context, request);
    expect(f.events).toEqual(['createUpload', 'presign']);
    expect(f.records).toHaveLength(1); const [record] = f.records as [AttachmentUploadRecord];
    expect(record).toEqual({ accountId, clientIdHash: digest('client-one'), uploadId: record.uploadId, sizeBytes: 1234, sha256: 'e'.repeat(64), objectKey: `${ATTACHMENT_UPLOAD_KEY_PREFIX}${record.uploadId}`, expiresAt: NOW_MS / 1000 + UPLOAD_TTL_SECONDS });
    expect(record.uploadId).toMatch(UUID_V4); expect(f.signed).toEqual([record]);
    expect(result.metadata).toEqual({ uploadId: record.uploadId, sizeBytes: 1234, sha256: 'e'.repeat(64), expiresAt: new Date(NOW_MS + 600_000).toISOString(), method: 'PUT', headers: { 'Content-Length': '1234', 'x-amz-checksum-sha256': 'abc=' } });
    expect(result.url).toContain('synthetic-secret'); expect(JSON.stringify(result.metadata)).not.toContain('https:'); expect(JSON.stringify(result.metadata)).not.toContain('synthetic-secret');
});
test('every call gets a new upload id, and the arguments can name neither an account nor a client', async () => {
    const f = fixture(); const first = await f.service.create_attachment_upload(context, request); const second = await f.service.create_attachment_upload({ ...context, accountId: 'f'.repeat(24), clientId: 'client-two' }, request);
    expect(first.metadata.uploadId).not.toBe(second.metadata.uploadId);
    expect(f.records.map(record => [record.accountId, record.clientIdHash])).toEqual([[accountId, digest('client-one')], ['f'.repeat(24), digest('client-two')]]);
    for (const extra of [{ accountId: 'b'.repeat(24) }, { clientIdHash: 'x'.repeat(43) }, { uploadId: '0b5e7c1a-3f2d-4c8b-9a6e-1d2c3b4a5f60' }, { expiresAt: 1 }, { objectKey: 'uploads/v1/other' }]) {
        await expect(f.service.create_attachment_upload(context, { ...request, ...extra } as never)).rejects.toThrow('invalid_input');
    }
    expect(f.records).toHaveLength(2);
});
test('invalid sizes and digests are refused before any store or stager call', async () => {
    const f = fixture();
    for (const bad of [{ sizeBytes: 0, sha256: 'e'.repeat(64) }, { sizeBytes: 18 * 1024 * 1024 + 1, sha256: 'e'.repeat(64) }, { sizeBytes: 1.5, sha256: 'e'.repeat(64) }, { sizeBytes: 5, sha256: 'E'.repeat(64) }, { sizeBytes: 5, sha256: 'e'.repeat(63) }, {}]) {
        await expect(f.service.create_attachment_upload(context, bad as never)).rejects.toThrow('invalid_input');
    }
    expect(f.events).toEqual([]);
});
test('it needs an active connection with mail:draft and fails before any store or stager call otherwise', async () => {
    const f = fixture();
    await expect(f.service.create_attachment_upload({ ...context, scopes: ['mail:read', 'mail:send', 'mail:modify'] }, request)).rejects.toThrow('forbidden');
    await expect(f.service.create_attachment_upload({ ...context, scopes: [] }, request)).rejects.toThrow('forbidden');
    await expect(f.service.create_attachment_upload({ ...context, connectionStatus: 'reconnect_required' }, request)).rejects.toThrow('reconnect_required');
    await expect(f.service.create_attachment_upload({ ...context, accountId: 'not-an-account' }, request)).rejects.toThrow('forbidden');
    expect(f.events).toEqual([]);
});
test('without upload stores it fails closed as temporarily_unavailable and reads nothing', async () => {
    const forbidden = fixture().forbidden; const service = createMailService({ reader: forbidden, writer: forbidden, operations: forbidden });
    await expect(service.create_attachment_upload(context, request)).rejects.toThrow('temporarily_unavailable');
    // The other tools of such a deployment are unaffected by the missing dependency: a scope failure still comes first.
    await expect(service.create_attachment_upload({ ...context, scopes: [] }, request)).rejects.toThrow('forbidden');
});
test('store, signature and malformed-result failures become temporarily_unavailable and never expose a link or message', async () => {
    for (const options of [{ storeError: new MailError('too_large') }, { storeError: new Error('secret table failure https://x') }, { stagerError: new Error('secret signing failure') }, { presigned: { url: 'http://insecure.example/x' } }, { presigned: { method: 'POST' as never } }, { presigned: { headers: { 'bad header': 'x' } } }, { presigned: { expiresAt: 'tomorrow' } }, { presigned: { expiresAt: new Date(NOW_MS + 24 * 3600_000).toISOString() } }]) {
        setSystemTime(new Date(NOW_MS)); const f = fixture(options);
        const error = await f.service.create_attachment_upload(context, request).then(() => undefined, (thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(MailError); const code = (error as MailError).code; expect(options.storeError instanceof MailError ? ['too_large'] : ['temporarily_unavailable']).toContain(code);
        expect(JSON.stringify([(error as MailError).message, code])).not.toMatch(/secret|https/u);
        expect(f.events.filter(event => event === 'createUpload')).toHaveLength(1);
    }
});
test('a link that would outlive its record is refused, one that expires sooner is kept', async () => {
    setSystemTime(new Date(NOW_MS)); const sooner = new Date(NOW_MS + 60_000).toISOString();
    expect((await fixture({ presigned: { expiresAt: sooner } }).service.create_attachment_upload(context, request)).metadata.expiresAt).toBe(sooner);
    const exact = new Date(NOW_MS + UPLOAD_TTL_SECONDS * 1000).toISOString();
    expect((await fixture({ presigned: { expiresAt: exact } }).service.create_attachment_upload(context, request)).metadata.expiresAt).toBe(exact);
    await expect(fixture({ presigned: { expiresAt: new Date(NOW_MS + UPLOAD_TTL_SECONDS * 1000 + 1000).toISOString() } }).service.create_attachment_upload(context, request)).rejects.toThrow('temporarily_unavailable');
});
