import { expect, spyOn, test } from 'bun:test';
import { S3Client, type HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { type getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { attachmentDisposition, createS3AttachmentDownloadStager, MAX_DOWNLOAD_BYTES, type AttachmentDownloadSource } from '../src/mail/downloads';
import { withRequestBudget } from '../src/request-budget';
import { createMailBackend } from '../src/mail/backend';
import { MailError, type AttachmentMetadata, type MailFailureCode } from '../src/mail/contracts';

type Command = { constructor: { name: string }; input: Record<string, unknown> };
const s3Error = (httpStatusCode: number) => Object.assign(new Error('private upstream response'), { $metadata: { httpStatusCode } });
function fixture(options: { fail?: string; expiration?: Date; timeoutMs?: number; onCommand?: (command: Command) => void; presignFail?: boolean; headStatus?: number; lifecycleExpiry?: Date } = {}) {
    const calls: Command[] = []; const uploaded: Buffer[] = []; const signed: { key: string; expiresIn: number }[] = [];
    const objects = new Map<string, HeadObjectCommandOutput>();
    const uploads = new Map<string, { create: Command['input']; parts: Buffer[] }>();
    let counter = 0; let presignFail = options.presignFail;
    const client = { config: { credentials: async () => ({ accessKeyId: 'test', secretAccessKey: 'test', ...(options.expiration ? { expiration: options.expiration } : {}) }) },
        send: async (command: Command) => {
            calls.push(command); options.onCommand?.(command); const key = String(command.input.Key);
            if (options.fail === command.constructor.name) { throw new Error('secret https://signed.example/?token=private upstream credential'); }
            switch (command.constructor.name) {
                case 'HeadObjectCommand': {
                    if (options.headStatus) { throw s3Error(options.headStatus); }
                    const object = objects.get(key); if (!object) { throw s3Error(404); } return { ...object };
                }
                case 'CreateMultipartUploadCommand': {
                    const id = `upload-${++counter}`; uploads.set(id, { create: command.input, parts: [] }); return { UploadId: id };
                }
                case 'UploadPartCommand': {
                    const upload = uploads.get(String(command.input.UploadId)); if (!upload) { throw new Error('Unexpected upload'); }
                    const bytes = Buffer.from(command.input.Body as Uint8Array); upload.parts.push(bytes); uploaded.push(bytes); return { ETag: `part-${upload.parts.length}` };
                }
                case 'CompleteMultipartUploadCommand': {
                    expect(command.input.IfNoneMatch).toBe('*');
                    const id = String(command.input.UploadId); const upload = uploads.get(id); if (!upload) { throw new Error('Unexpected upload'); }
                    if (objects.has(key)) { throw s3Error(412); }
                    objects.set(key, { $metadata: { httpStatusCode: 200 }, ContentLength: Buffer.concat(upload.parts).byteLength, ETag: `"${id}"`,
                        ContentType: String(upload.create.ContentType), ContentDisposition: String(upload.create.ContentDisposition), CacheControl: String(upload.create.CacheControl),
                        ServerSideEncryption: 'AES256', Metadata: upload.create.Metadata as Record<string, string>,
                        ...(options.lifecycleExpiry ? { Expiration: `expiry-date="${options.lifecycleExpiry.toUTCString()}", rule-id="ExpirePrivateDownloads"` } : {}) });
                    uploads.delete(id); return {};
                }
                case 'AbortMultipartUploadCommand': uploads.delete(String(command.input.UploadId)); return {};
                default: throw new Error('Unexpected S3 command');
            }
        } } as unknown as S3Client;
    const presign = (async (_client: S3Client, command: Command, config: { expiresIn: number }) => {
        const key = String(command.input.Key); expect(objects.has(key)).toBe(true);
        signed.push({ key, expiresIn: config.expiresIn });
        if (presignFail) { throw new Error('secret presigned URL'); }
        return `https://private-bucket.s3.example/${key}?bearer=test-${signed.length}`;
    }) as unknown as typeof getSignedUrl;
    return { stager: createS3AttachmentDownloadStager({ bucketName: 'private-test-bucket', client, presign, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }),
        calls, uploaded, signed, objects, uploads, allowSigning: () => { presignFail = false; } };
}
interface Source extends AttachmentDownloadSource { opened: number; cancelled: boolean }
function source(chunks: Uint8Array[], options: { cacheIdentity?: string; metadata?: Partial<AttachmentMetadata>; expectedSize?: number; stall?: boolean } = {}): Source {
    const result: Source = { cacheIdentity: options.cacheIdentity ?? 'a'.repeat(64), opened: 0, cancelled: false,
        metadata: { attachmentId: 'ATT00001', filename: 'report.bin', contentType: 'application/octet-stream', size: null, sizeIsApproximate: false, inline: false, cid: null, ...options.metadata },
        async open() {
            result.opened++;
            const body = options.stall ? new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => { result.cancelled = true; } })
                : new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) { controller.enqueue(chunk); } controller.close(); }, cancel: () => { result.cancelled = true; } });
            return { body, ...(options.expectedSize === undefined ? {} : { expectedSize: options.expectedSize }) };
        } };
    return result;
}
async function fails(action: Promise<unknown>, code: MailFailureCode) {
    try { await action; throw new Error('Expected error'); } catch (error) {
        expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(code);
        expect((error as Error).message).toBe(code); expect((error as Error).cause).toBeUndefined();
    }
}
const names = (calls: Command[]) => calls.map(call => call.constructor.name);
test('streams exact bytes through bounded parts and signs only after verifying the completed private object', async () => {
    const f = fixture(); const bytes = Buffer.alloc(11 * 1024 * 1024 + 7, 19); const input = source([bytes.subarray(0, 3), bytes.subarray(3)]);
    const before = Date.now(); const result = await f.stager.stage(input);
    expect(Buffer.concat(f.uploaded)).toEqual(bytes); expect(f.uploaded.map(part => part.length)).toEqual([5 * 1024 * 1024, 5 * 1024 * 1024, 1024 * 1024 + 7]);
    expect(result.size).toBe(bytes.length); expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(before + 300_000);
    expect(f.signed[0]?.expiresIn).toBe(300); expect(input.opened).toBe(1);
    const create = f.calls.find(call => call.constructor.name === 'CreateMultipartUploadCommand')?.input;
    expect(create).toMatchObject({ Bucket: 'private-test-bucket', CacheControl: 'private, no-store', ServerSideEncryption: 'AES256', ContentType: 'application/octet-stream' });
    expect(create?.ACL).toBeUndefined(); expect(create?.Key).toMatch(/^downloads\/v1\/[a-f0-9]{64}$/u);
    expect(create?.Metadata).toEqual({ binding: String(create?.Key).split('/').at(-1), descriptor: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(names(f.calls)).toEqual(['HeadObjectCommand', 'CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand', 'HeadObjectCommand']);
});
test('after the URL expires a cache hit signs the same object for five more minutes without opening or rewriting it', async () => {
    const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now);
    try {
        const f = fixture(); const input = source([Buffer.from('data')]); const first = await f.stager.stage(input);
        const stored = [...f.objects.values()][0]; const calls = f.calls.length;
        clock.mockReturnValue(now + 301_000); const second = await f.stager.stage(input);
        expect(input.opened).toBe(1); expect(f.objects.size).toBe(1); expect([...f.objects.values()][0]).toBe(stored);
        expect(f.signed[0]?.key).toBe(f.signed[1]?.key); expect(first.url).not.toBe(second.url);
        expect(Date.parse(second.expiresAt)).toBe(now + 601_000); expect(names(f.calls.slice(calls))).toEqual(['HeadObjectCommand']);
    } finally { clock.mockRestore(); }
});
test('lifecycle removal restages the same stable object key and account/body/descriptor changes isolate keys', async () => {
    const f = fixture(); const input = source([Buffer.from('data')]); await f.stager.stage(input); const key = f.signed[0]?.key;
    f.objects.clear(); await f.stager.stage(input); expect(f.signed[1]?.key).toBe(key); expect(input.opened).toBe(2);
    for (const next of [source([Buffer.from('data')], { cacheIdentity: 'b'.repeat(64) }), source([Buffer.from('data')], { metadata: { filename: 'different.pdf' } }), source([Buffer.from('data')], { metadata: { contentType: 'application/pdf' } })]) { await f.stager.stage(next); }
    expect(new Set(f.signed.map(value => value.key)).size).toBe(4);
    for (const value of f.signed) { expect(value.key).toMatch(/^downloads\/v1\/[a-f0-9]{64}$/u); expect(value.key).not.toContain('report'); }
});
test('concurrent misses conditionally complete one shared object and loser aborts only its own multipart upload', async () => {
    const f = fixture(); const first = source([Buffer.from('same bytes')]); const second = source([Buffer.from('same bytes')]);
    const results = await Promise.all([f.stager.stage(first), f.stager.stage(second)]);
    expect(f.objects.size).toBe(1); expect(f.uploads.size).toBe(0); expect(f.signed).toHaveLength(2); expect(f.signed[0]?.key).toBe(f.signed[1]?.key);
    expect(results.map(result => result.size)).toEqual([10, 10]);
    expect(names(f.calls).filter(name => name === 'AbortMultipartUploadCommand')).toHaveLength(1);
    expect(names(f.calls)).not.toContain('DeleteObjectCommand');
});
test('HEAD access denial and network failure fail closed without upstream fetch or speculative upload', async () => {
    for (const options of [{ headStatus: 403 }, { fail: 'HeadObjectCommand' }]) {
        const f = fixture(options); const input = source([]); await fails(f.stager.stage(input), 'temporarily_unavailable');
        expect(input.opened).toBe(0); expect(names(f.calls)).toEqual(['HeadObjectCommand']); expect(f.signed).toHaveLength(0);
    }
});
test('cache HEAD must verify binding, descriptor, actual size, response headers and private encryption', async () => {
    for (const patch of [{ Metadata: {} }, { ContentLength: -1 }, { ContentLength: MAX_DOWNLOAD_BYTES + 1 }, { ContentType: 'text/html' }, { ContentDisposition: 'inline' }, { CacheControl: 'public' }, { ServerSideEncryption: undefined }, { ETag: undefined }, { StorageClass: 'GLACIER' }, { Expiration: 'invalid' }]) {
        const f = fixture(); const input = source([Buffer.from('data')]); await f.stager.stage(input);
        const key = f.signed[0]?.key ?? ''; const object = f.objects.get(key); if (!object) { throw new Error('Missing fixture object'); }
        f.objects.set(key, { ...object, ...patch } as HeadObjectCommandOutput);
        await fails(f.stager.stage(input), 'verification_failed'); expect(input.opened).toBe(1); expect(f.signed).toHaveLength(1); expect(f.objects.size).toBe(1);
    }
});
test('cache HEAD verifies exact metadata size before issuing another URL', async () => {
    const f = fixture(); const input = source([Buffer.from('data')], { metadata: { size: 4, sizeIsApproximate: false } }); await f.stager.stage(input);
    const key = f.signed[0]?.key ?? ''; const object = f.objects.get(key); if (!object) { throw new Error('Missing fixture object'); }
    f.objects.set(key, { ...object, ContentLength: 5 }); await fails(f.stager.stage(input), 'verification_failed'); expect(f.signed).toHaveLength(1);
});
test('counts actual unknown-length bytes and aborts oversize staging without completion, signing or deletion', async () => {
    const f = fixture(); await fails(f.stager.stage(source([Buffer.alloc(MAX_DOWNLOAD_BYTES), Buffer.from([1])])), 'too_large');
    expect(f.signed).toHaveLength(0); expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand'); expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand');
    expect(f.objects.size).toBe(0); expect(f.uploads.size).toBe(0); expect(f.uploaded.every(part => part.length <= 5 * 1024 * 1024)).toBe(true);
});
test('unknown size, approximate metadata and empty bytes use actual decoded length', async () => {
    for (const chunks of [[], [Buffer.alloc(MAX_DOWNLOAD_BYTES)]]) {
        const f = fixture(); const result = await f.stager.stage(source(chunks, { metadata: { size: 999, sizeIsApproximate: true } }));
        expect(result.size).toBe(chunks[0]?.byteLength ?? 0); expect(f.signed).toHaveLength(1); expect(f.uploaded).toHaveLength(chunks.length ? 4 : 1);
    }
});
test('S3 upload errors are sanitized and only the failing request multipart upload is cleaned', async () => {
    for (const fail of ['UploadPartCommand', 'CompleteMultipartUploadCommand']) {
        const f = fixture({ fail }); await fails(f.stager.stage(source([Buffer.from('private bytes')])), 'temporarily_unavailable');
        expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand'); expect(f.objects.size).toBe(0); expect(f.uploads.size).toBe(0);
    }
});
test('sign failure keeps the verified complete object for a later retry', async () => {
    const f = fixture({ presignFail: true }); const input = source([Buffer.from('data')]);
    await fails(f.stager.stage(input), 'temporarily_unavailable'); expect(f.objects.size).toBe(1); expect(f.uploads.size).toBe(0);
    f.allowSigning(); const result = await f.stager.stage(input); expect(result.size).toBe(4); expect(input.opened).toBe(1);
    expect(names(f.calls)).not.toContain('DeleteObjectCommand');
});
test('timeout cancels a stalled body and prevents completion/signing', async () => {
    const f = fixture({ timeoutMs: 10 }); const input = source([], { stall: true });
    await fails(f.stager.stage(input), 'upstream_timeout'); expect(input.cancelled).toBe(true); expect(f.signed).toHaveLength(0);
    expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand'); expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand');
});
test('caller abort and exhausted Lambda budget cancel before any cache or upstream request', async () => {
    for (const exhausted of [false, true]) {
        const f = fixture(); const controller = new AbortController(); controller.abort(); const input = source([]);
        const action = exhausted ? withRequestBudget(() => 1_999, () => f.stager.stage(input)) : f.stager.stage(input, controller.signal);
        await fails(action, 'upstream_timeout'); expect(input.opened).toBe(0); expect(f.calls).toHaveLength(0); expect(f.signed).toHaveLength(0);
    }
});
test('caller abort during part upload prevents complete/sign and cleans only its multipart upload', async () => {
    const controller = new AbortController(); const f = fixture({ onCommand(command) { if (command.constructor.name === 'UploadPartCommand') { controller.abort(); } } });
    await fails(f.stager.stage(source([Buffer.from('data')]), controller.signal), 'upstream_timeout');
    expect(f.signed).toHaveLength(0); expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand'); expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand');
});
test('URL expiration is bounded by role credentials and existing object lifecycle with a safety margin', async () => {
    const now = Date.now();
    for (const options of [{ expiration: new Date(now + 80_000) }, { lifecycleExpiry: new Date(now + 80_000) }]) {
        const f = fixture(options); const result = await f.stager.stage(source([Buffer.from('data')]));
        expect(f.signed[0]?.expiresIn).toBeLessThanOrEqual(75); expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(now + 75_000);
    }
    for (const options of [{ expiration: new Date(now + 4_000) }, { lifecycleExpiry: new Date(now + 4_000) }]) {
        const f = fixture(options); await fails(f.stager.stage(source([])), 'temporarily_unavailable'); expect(f.signed).toHaveLength(0); expect(f.objects.size).toBe(1);
    }
});
test('download response headers force attachment disposition and reject executable header syntax', async () => {
    const disposition = attachmentDisposition('../../evil\r\nContent-Type: text/html;"\\é.pdf');
    expect(disposition.startsWith('attachment; filename="')).toBe(true); expect(disposition).not.toMatch(/[\r\n]/u); expect(disposition).not.toContain('../');
    expect(disposition).toContain("filename*=UTF-8''"); expect(attachmentDisposition(null)).toContain('filename="attachment"');
    const f = fixture(); await f.stager.stage(source([Buffer.from('x')], { metadata: { contentType: 'text/html\r\nX-Injected: yes' } }));
    expect([...f.objects.values()][0]?.ContentType).toBe('application/octet-stream');
});
test('exact expected or metadata byte mismatch aborts staging before completion/signing', async () => {
    for (const expectedSize of [0, 2, 5 * 1024 * 1024 + 1]) {
        const f = fixture(); await fails(f.stager.stage(source([Buffer.alloc(expectedSize > 2 ? 5 * 1024 * 1024 : 1)], { expectedSize })), 'verification_failed');
        expect(f.signed).toHaveLength(0); expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand'); expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand');
    }
    const f = fixture(); await fails(f.stager.stage(source([Buffer.from('data')], { metadata: { size: 5, sizeIsApproximate: false } })), 'verification_failed');
    expect(f.signed).toHaveLength(0); expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand');
});
test('invalid identities and exact declarations fail before upload; zero-byte exact matches succeed', async () => {
    for (const [expectedSize, code] of [[-1, 'invalid_input'], [0.5, 'invalid_input'], [NaN, 'invalid_input'], [MAX_DOWNLOAD_BYTES + 1, 'too_large']] as const) {
        const f = fixture(); await fails(f.stager.stage(source([], { expectedSize })), code); expect(names(f.calls)).toEqual(['HeadObjectCommand']);
    }
    const invalid = fixture(); await fails(invalid.stager.stage(source([], { cacheIdentity: 'arbitrary caller key' })), 'invalid_input'); expect(invalid.calls).toHaveLength(0);
    const conflict = fixture(); await fails(conflict.stager.stage(source([Buffer.from('data')], { expectedSize: 4, metadata: { size: 5, sizeIsApproximate: false } })), 'verification_failed'); expect(names(conflict.calls)).toEqual(['HeadObjectCommand']);
    const empty = fixture(); expect((await empty.stager.stage(source([], { expectedSize: 0, metadata: { size: 0, sizeIsApproximate: false } }))).size).toBe(0); expect(empty.signed).toHaveLength(1);
});

test('lazy opener preserves sanitized upstream mail failures and Retry-After without leaking raw exceptions', async () => {
    for (const code of ['reconnect_required', 'forbidden', 'not_found', 'temporarily_unavailable'] as const) {
        const f = fixture(); const input = source([]);
        input.open = async () => { throw new MailError(code, code === 'temporarily_unavailable' ? 12 : undefined); };
        try { await f.stager.stage(input); throw new Error('Expected failure'); } catch (error) {
            expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(code);
            expect((error as MailError).retryAfter).toBe(code === 'temporarily_unavailable' ? 12 : undefined);
        }
        expect(names(f.calls)).toEqual(['HeadObjectCommand']); expect(f.signed).toHaveLength(0);
    }
    const f = fixture(); const input = source([]); input.open = async () => { throw new Error('token-private upstream body'); };
    await fails(f.stager.stage(input), 'temporarily_unavailable');
});

function decodedAttachmentBackend(stager: ReturnType<typeof fixture>['stager'], attachment: { transferEncoding: string; encodedSize: number; decodedSize: number }, declaredSize?: number) {
    const session = { accountId: 'a'.repeat(24), accessToken: 'c'.repeat(40) }; const target = { mailboxId: 'b'.repeat(24), uid: 12, attachmentId: 'ATT1' };
    const decoded = Buffer.alloc(attachment.decodedSize, 19); let metadataReads = 0; let attachmentReads = 0;
    const backend = createMailBackend({ downloadStager: stager, fetch: (async (url, init) => {
        expect(init?.method).toBe('GET'); expect(new Headers(init?.headers).get('X-Access-Token')).toBe(session.accessToken);
        if (String(url).endsWith('/attachments/ATT1')) {
            attachmentReads++;
            return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(decoded); controller.close(); } }), {
                headers: { 'content-type': 'application/pdf', ...(declaredSize === undefined ? {} : { 'content-length': String(declaredSize) }) },
            });
        }
        metadataReads++; expect(String(url)).toEndWith('?markAsSeen=false&replaceCidLinks=false');
        return Response.json({ success: true, user: session.accountId, id: target.uid, mailbox: target.mailboxId, subject: '', from: [], to: [], replyTo: [], cc: [], bcc: [],
            date: '2026-10-26T00:00:00.000Z', idate: '2026-10-26T00:00:00.000Z', flags: [], labels: [], seen: false, flagged: false, draft: false, answered: false, deleted: false, forwarded: false,
            text: '', html: [], envelope: { from: '', rcpt: [] }, metaData: {}, references: [], contentType: { value: 'multipart/mixed' },
            attachments: [{ id: target.attachmentId, hash: 'e'.repeat(64), filename: 'synthetic.pdf', contentType: 'application/pdf', size: attachment.encodedSize, transferEncoding: attachment.transferEncoding }],
        });
    }) as typeof fetch });
    return { backend, session, target, decoded, reads: () => ({ metadata: metadataReads, attachment: attachmentReads }) };
}

test('backend and real stager accept encoded attachment metadata but measure decoded bytes and reuse the cached object', async () => {
    for (const attachment of [
        { transferEncoding: 'base64', encodedSize: 828924, decodedSize: 605750 },
        { transferEncoding: 'quoted-printable', encodedSize: 1800, decodedSize: 600 },
    ]) {
        for (const withContentLength of [true, false]) {
            const f = fixture(); const upstream = decodedAttachmentBackend(f.stager, attachment, withContentLength ? attachment.decodedSize : undefined);
            const first = await upstream.backend.getAttachmentDownload(upstream.session, upstream.target);
            expect(first.metadata.size).toBe(attachment.decodedSize); expect(Buffer.concat(f.uploaded)).toEqual(upstream.decoded);
            const calls = f.calls.length;
            const second = await upstream.backend.getAttachmentDownload(upstream.session, upstream.target);
            expect(second.metadata.size).toBe(attachment.decodedSize); expect(second.url).not.toBe(first.url);
            expect(upstream.reads()).toEqual({ metadata: 2, attachment: 1 });
            expect(f.objects.size).toBe(1); expect(f.signed[1]?.key).toBe(f.signed[0]?.key); expect(names(f.calls.slice(calls))).toEqual(['HeadObjectCommand']);
        }
    }
});

test('encoded metadata does not weaken authoritative decoded Content-Length verification in the real stager', async () => {
    const attachment = { transferEncoding: 'base64', encodedSize: 828924, decodedSize: 605750 };
    for (const declaredSize of [attachment.decodedSize - 1, attachment.decodedSize + 1]) {
        const f = fixture(); const upstream = decodedAttachmentBackend(f.stager, attachment, declaredSize);
        await fails(upstream.backend.getAttachmentDownload(upstream.session, upstream.target), 'verification_failed');
        expect(upstream.reads()).toEqual({ metadata: 1, attachment: 1 }); expect(f.signed).toHaveLength(0);
        expect(f.objects.size).toBe(0); expect(f.uploads.size).toBe(0); expect(names(f.calls)).not.toContain('CompleteMultipartUploadCommand');
        expect(names(f.calls).at(-1)).toBe('AbortMultipartUploadCommand');
    }
});
