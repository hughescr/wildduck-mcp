import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createS3AttachmentUploadStager, MIN_UPLOAD_PRESIGN_SECONDS } from '../src/mail/uploads';
import { ATTACHMENT_UPLOAD_KEY_PREFIX, MailError, type AttachmentUploadRecord, type MailFailureCode } from '../src/mail/contracts';
import { attachmentUploadRequestSchema, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS } from '../src/mail/schemas';
import { withRequestBudget } from '../src/request-budget';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const UPLOAD_ID = '12345678-1234-4234-8234-123456789abc';
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const recordFor = (bytes: Uint8Array, patch: Partial<AttachmentUploadRecord> = {}): AttachmentUploadRecord => ({
    accountId: 'account', clientIdHash: 'c'.repeat(64), uploadId: UPLOAD_ID, objectKey: ATTACHMENT_UPLOAD_KEY_PREFIX + UPLOAD_ID,
    sizeBytes: bytes.byteLength, sha256: hex(bytes), expiresAt: NOW / 1000 + UPLOAD_TTL_SECONDS, ...patch });
const s3Error = (httpStatusCode: number, name = 'S3ServiceException') => Object.assign(new Error('private upstream response'), { name, $metadata: { httpStatusCode } });
async function fails(action: Promise<unknown>, code: MailFailureCode) {
    try { await action; throw new Error('Expected error'); } catch (error) {
        expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(code);
        expect((error as Error).message).toBe(code); expect((error as Error).cause).toBeUndefined();
    }
}
const GOOD_URL = (query = 'X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256&X-Amz-Signature=abc') => `https://private-bucket.s3.us-west-2.amazonaws.com/uploads/v1/${UPLOAD_ID}?X-Amz-Expires=900&${query}`;

interface Body { cancelled: boolean; pulls: number; readonly stream: ReadableStream<Uint8Array> }
/** A web stream that records cancellation (only meaningful while still open: a stream read to its
 * end is already closed and needs no cancel) and pulls one chunk per read; `stall` never produces data. */
function body(chunks: Uint8Array[], stall = false): Body {
    const result: Body = { cancelled: false, pulls: 0, stream: undefined as unknown as ReadableStream<Uint8Array> };
    let index = 0;
    (result as { stream: ReadableStream<Uint8Array> }).stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            result.pulls++;
            if (stall) { return new Promise(() => {}); }
            const chunk = chunks[index++]; if (chunk) { controller.enqueue(chunk); } else { controller.close(); }
            return undefined;
        }, cancel() { result.cancelled = true; } }, { highWaterMark: 0 });
    return result;
}
interface Fixture { stager: ReturnType<typeof createS3AttachmentUploadStager>; sent: GetObjectCommand[]; signals: (AbortSignal | undefined)[]; presigned: { command: PutObjectCommand; config: Record<string, unknown> }[] }
function fixture(options: { output?: Record<string, unknown> | undefined; error?: unknown; expiration?: Date; url?: string; timeoutMs?: number } = {}): Fixture {
    const sent: GetObjectCommand[] = []; const signals: (AbortSignal | undefined)[] = []; const presigned: Fixture['presigned'] = [];
    const client = { config: { credentials: async () => ({ accessKeyId: 'test', secretAccessKey: 'test', ...(options.expiration ? { expiration: options.expiration } : {}) }) },
        send: async (command: GetObjectCommand, init?: { abortSignal?: AbortSignal }) => {
            sent.push(command); signals.push(init?.abortSignal);
            if (options.error) { throw options.error; }
            return options.output ?? {};
        } } as unknown as S3Client;
    const presign = (async (_client: S3Client, command: PutObjectCommand, config: Record<string, unknown>) => { presigned.push({ command, config }); return options.url ?? GOOD_URL(); }) as unknown as typeof getSignedUrl;
    const stager = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', client, presign, now: () => NOW, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
    return { stager, sent, signals, presigned };
}
const output = (stream: Body, extra: Record<string, unknown> = {}) => ({ Body: { transformToWebStream: () => stream.stream }, ...extra });
const read = (f: Fixture, record: AttachmentUploadRecord, options: { maxBytes?: number; signal?: AbortSignal } = {}) =>
    f.stager.readStaged(record, { maxBytes: options.maxBytes ?? MAX_UPLOAD_BYTES, signal: options.signal ?? new AbortController().signal });
const DATA = Buffer.from('attachment bytes that are staged');

test('hex digest becomes the exact base64 header: known SHA-256 vector for "abc"', async () => {
    const f = fixture(); const abc = Buffer.from('abc');
    const result = await f.stager.presign(recordFor(abc));
    expect(hex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(result.headers).toEqual({ 'x-amz-checksum-sha256': 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=' });
});
test('presign builds the exact PutObject input and options, and a schema-valid https result', async () => {
    const f = fixture(); const record = recordFor(DATA);
    const result = await f.stager.presign(record);
    expect(f.presigned).toHaveLength(1); const { command, config } = f.presigned[0] as Fixture['presigned'][number];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({ Bucket: 'private-test-bucket', Key: `uploads/v1/${UPLOAD_ID}`, ContentLength: DATA.length, ChecksumSHA256: Buffer.from(hex(DATA), 'hex').toString('base64') });
    expect(config).toEqual({ expiresIn: UPLOAD_TTL_SECONDS, signingDate: new Date(NOW), unhoistableHeaders: new Set(['x-amz-checksum-sha256']) });
    expect(result.url).toBe(GOOD_URL()); expect(new URL(result.url).protocol).toBe('https:');
    expect(result.expiresAt).toBe(new Date(NOW + UPLOAD_TTL_SECONDS * 1000).toISOString());
    expect(attachmentUploadRequestSchema.parse({ method: result.method, headers: result.headers })).toEqual({ method: 'PUT', headers: result.headers });
});
test('expiresIn follows the shortest of record expiry, credential expiry less a margin, and the upload TTL', async () => {
    const byRecord = fixture(); const record = await byRecord.stager.presign(recordFor(DATA, { expiresAt: NOW / 1000 + 120 }));
    expect(byRecord.presigned[0]?.config['expiresIn']).toBe(120); expect(record.expiresAt).toBe(new Date(NOW + 120_000).toISOString());
    const byCredentials = fixture({ expiration: new Date(NOW + 605_000) }); const limited = await byCredentials.stager.presign(recordFor(DATA, { expiresAt: NOW / 1000 + 900 }));
    expect(byCredentials.presigned[0]?.config['expiresIn']).toBe(600); expect(limited.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    const byTtl = fixture(); await byTtl.stager.presign(recordFor(DATA, { expiresAt: NOW / 1000 + 5_000 }));
    expect(byTtl.presigned[0]?.config['expiresIn']).toBe(UPLOAD_TTL_SECONDS);
    const fractional = fixture(); await fractional.stager.presign(recordFor(DATA, { expiresAt: NOW / 1000 + 100.9 - 0.9 }));
    expect(fractional.presigned[0]?.config['expiresIn']).toBe(100);
});
test('a link that would live under the minimum is refused without signing', async () => {
    expect(MIN_UPLOAD_PRESIGN_SECONDS).toBe(30);
    for (const options of [{ record: { expiresAt: NOW / 1000 + 29 } }, { record: {}, expiration: new Date(NOW + 34_000) }, { record: { expiresAt: NOW / 1000 - 5 } }]) {
        const f = fixture(options.expiration ? { expiration: options.expiration } : {});
        await fails(f.stager.presign(recordFor(DATA, options.record)), 'temporarily_unavailable'); expect(f.presigned).toHaveLength(0);
    }
    const ok = fixture(); await ok.stager.presign(recordFor(DATA, { expiresAt: NOW / 1000 + 30 })); expect(ok.presigned[0]?.config['expiresIn']).toBe(30);
});
test('fails closed unless the signed URL enforces content-length and the checksum header exactly', async () => {
    const bad = [
        GOOD_URL('X-Amz-SignedHeaders=host&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-SignedHeaders=content-length%3Bhost&x-amz-checksum-sha256=ungWv48Bz%2BpBQUDeXa4iI7ADYaOWF3qctBD%2FYfIAFa0%3D&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256&X-Amz-Checksum-Sha256=abc&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256%3Bx-amz-server-side-encryption&X-Amz-Signature=abc'),
        GOOD_URL('X-Amz-Signature=abc'),
        GOOD_URL().replace('https:', 'http:'), 'not a url',
    ];
    for (const url of bad) { const f = fixture({ url }); await fails(f.stager.presign(recordFor(DATA)), 'temporarily_unavailable'); }
});
test('presigner and credential failures are sanitized', async () => {
    const failing = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', now: () => NOW,
        client: { config: { credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }) } } as unknown as S3Client,
        presign: (async () => { throw new Error('secret https://signed.example/?token=private'); }) as unknown as typeof getSignedUrl });
    await fails(failing.presign(recordFor(DATA)), 'temporarily_unavailable');
    const noCredentials = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', now: () => NOW,
        client: { config: { credentials: async () => { throw new Error('secret credential'); } } } as unknown as S3Client });
    await fails(noCredentials.presign(recordFor(DATA)), 'temporarily_unavailable');
});
test('malformed options and records are refused before any signing or S3 call', async () => {
    for (const bucketName of ['', 'UPPER', 'a', 'bad_bucket']) { expect(() => createS3AttachmentUploadStager({ bucketName })).toThrow('invalid_input'); }
    for (const timeoutMs of [0, 1.5, 30_001]) { expect(() => createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', timeoutMs })).toThrow('invalid_input'); }
    const good = recordFor(DATA);
    const bad: Partial<AttachmentUploadRecord>[] = [
        { uploadId: 'not-a-uuid' }, { objectKey: 'uploads/v1/other' }, { objectKey: `other/${UPLOAD_ID}` }, { objectKey: `uploads/v1/${UPLOAD_ID}/../x` },
        { sizeBytes: 0 }, { sizeBytes: -1 }, { sizeBytes: 1.5 }, { sizeBytes: MAX_UPLOAD_BYTES + 1 }, { sizeBytes: Number.NaN },
        { sha256: good.sha256.toUpperCase() }, { sha256: good.sha256.slice(1) }, { sha256: `${good.sha256}0` }, { sha256: 'g'.repeat(64) },
        { expiresAt: 0 }, { expiresAt: Number.NaN }, { expiresAt: 1.5 }, { expiresAt: undefined as unknown as number },
    ];
    for (const patch of bad) {
        const f = fixture({ output: output(body([DATA])) });
        await fails(f.stager.presign({ ...good, ...patch }), 'invalid_input'); await fails(read(f, { ...good, ...patch }), 'invalid_input');
        expect(f.presigned).toHaveLength(0); expect(f.sent).toHaveLength(0);
    }
    await fails(read(fixture(), good, { maxBytes: -1 }), 'invalid_input'); await fails(read(fixture(), good, { maxBytes: 1.5 }), 'invalid_input');
});

test('readStaged returns exactly the object bytes, asks S3 for the stored checksum, and releases the stream', async () => {
    const stream = body([DATA.subarray(0, 5), DATA.subarray(5, 6), DATA.subarray(6)]);
    const f = fixture({ output: output(stream, { ContentLength: DATA.length, ChecksumSHA256: Buffer.from(hex(DATA), 'hex').toString('base64') }) });
    const result = await read(f, recordFor(DATA));
    expect(Buffer.from(result)).toEqual(DATA); expect(result.byteLength).toBe(DATA.length); expect(result.buffer.byteLength).toBe(DATA.length);
    const command = f.sent[0] as GetObjectCommand; expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'private-test-bucket', Key: `uploads/v1/${UPLOAD_ID}`, ChecksumMode: 'ENABLED' });
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
});
test('readStaged tolerates an object without ContentLength or stored checksum (the digest still decides)', async () => {
    const f = fixture({ output: output(body([DATA])) });
    expect(Buffer.from(await read(f, recordFor(DATA)))).toEqual(DATA);
});
test('too_large is decided from the record before any S3 call', async () => {
    const f = fixture({ output: output(body([DATA])) });
    await fails(read(f, recordFor(DATA), { maxBytes: DATA.length - 1 }), 'too_large'); expect(f.sent).toHaveLength(0);
    expect(Buffer.from(await read(f, recordFor(DATA), { maxBytes: DATA.length }))).toEqual(DATA);
});
test('a missing object is not_found, whether S3 says 404 or NoSuchKey', async () => {
    await fails(read(fixture({ error: s3Error(404) }), recordFor(DATA)), 'not_found');
    await fails(read(fixture({ error: s3Error(0, 'NoSuchKey') }), recordFor(DATA)), 'not_found');
});
test('other S3 errors are sanitized to temporarily_unavailable and MailErrors pass through', async () => {
    for (const error of [s3Error(500), s3Error(403, 'AccessDenied'), new Error('secret https://signed.example/?token=private'), 'plain string']) {
        await fails(read(fixture({ error }), recordFor(DATA)), 'temporarily_unavailable');
    }
    await fails(read(fixture({ error: new MailError('upstream_timeout') }), recordFor(DATA)), 'upstream_timeout');
    const noBody = fixture({ output: { ContentLength: DATA.length } }); await fails(read(noBody, recordFor(DATA)), 'temporarily_unavailable');
});
test('a different ContentLength or stored checksum fails verification without reading the body', async () => {
    for (const extra of [{ ContentLength: DATA.length + 1 }, { ContentLength: DATA.length - 1 }, { ContentLength: 0 }, { ChecksumSHA256: Buffer.alloc(32, 1).toString('base64') }, { ChecksumSHA256: 'abc-2' }]) {
        const stream = body([DATA]); const f = fixture({ output: output(stream, extra) });
        await fails(read(f, recordFor(DATA)), 'verification_failed'); expect(stream.pulls).toBe(0); expect(stream.cancelled).toBe(true);
    }
});
test('a body longer than declared stops at the first excess chunk', async () => {
    const stream = body([DATA, Buffer.from('x'), Buffer.from('never read')]);
    await fails(read(fixture({ output: output(stream) }), recordFor(DATA)), 'verification_failed');
    expect(stream.pulls).toBeLessThanOrEqual(2); expect(stream.cancelled).toBe(true);
    const single = body([Buffer.concat([DATA, Buffer.from('trailing')])]);
    await fails(read(fixture({ output: output(single) }), recordFor(DATA)), 'verification_failed'); expect(single.cancelled).toBe(true);
});
test('a shorter body and a same-length wrong body fail verification', async () => {
    const short = body([DATA.subarray(0, DATA.length - 1)]);
    await fails(read(fixture({ output: output(short) }), recordFor(DATA)), 'verification_failed');
    await fails(read(fixture({ output: output(body([])) }), recordFor(DATA)), 'verification_failed');
    const wrong = Buffer.from(DATA); wrong[3] = (wrong[3] ?? 0) ^ 1;
    await fails(read(fixture({ output: output(body([wrong])) }), recordFor(DATA)), 'verification_failed');
});
test('a non-byte chunk is refused and the stream cancelled', async () => {
    const stream = body(['text' as unknown as Uint8Array]);
    await fails(read(fixture({ output: output(stream) }), recordFor(DATA)), 'temporarily_unavailable'); expect(stream.cancelled).toBe(true);
});
test('caller abort before and during the read, and an exhausted Lambda budget, are upstream_timeout', async () => {
    const early = new AbortController(); early.abort(); const untouched = fixture({ output: output(body([DATA])) });
    await fails(read(untouched, recordFor(DATA), { signal: early.signal }), 'upstream_timeout'); expect(untouched.sent).toHaveLength(0);
    const exhausted = fixture({ output: output(body([DATA])) });
    await fails(withRequestBudget(() => 1_999, () => read(exhausted, recordFor(DATA))), 'upstream_timeout'); expect(exhausted.sent).toHaveLength(0);
    const controller = new AbortController(); const stalled = body([], true); const f = fixture({ output: output(stalled) });
    const pending = read(f, recordFor(DATA), { signal: controller.signal }); setTimeout(() => controller.abort(), 10);
    await fails(pending, 'upstream_timeout'); expect(stalled.cancelled).toBe(true); expect(f.signals[0]?.aborted).toBe(true);
});
test('abort while the S3 request is outstanding reaches the client and is upstream_timeout', async () => {
    const controller = new AbortController();
    const client = { config: { credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }) },
        send: (_command: unknown, init: { abortSignal: AbortSignal }) => new Promise((_, reject) => init.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } as unknown as S3Client;
    const stager = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', client });
    const pending = stager.readStaged(recordFor(DATA), { maxBytes: MAX_UPLOAD_BYTES, signal: controller.signal }); setTimeout(() => controller.abort(), 10);
    await fails(pending, 'upstream_timeout');
});
test('a stalled body times out against the stager budget and cancels the stream', async () => {
    const stalled = body([], true); const f = fixture({ output: output(stalled), timeoutMs: 20 });
    await fails(read(f, recordFor(DATA)), 'upstream_timeout'); expect(stalled.cancelled).toBe(true);
    const slowHeaders = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', timeoutMs: 20,
        client: { send: (_c: unknown, init: { abortSignal: AbortSignal }) => new Promise((_, reject) => init.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))) } as unknown as S3Client });
    await fails(slowHeaders.readStaged(recordFor(DATA), { maxBytes: MAX_UPLOAD_BYTES, signal: new AbortController().signal }), 'upstream_timeout');
});
test('an 18 MiB object streams into one exactly-sized buffer in many chunks', async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES, 0x5a); big.writeUInt32BE(0xdeadbeef, 1_000_000);
    const chunks: Uint8Array[] = []; for (let offset = 0; offset < big.length; offset += 65_536) { chunks.push(big.subarray(offset, offset + 65_536)); }
    const result = await read(fixture({ output: output(body(chunks), { ContentLength: big.length }) }), recordFor(big));
    expect(result.byteLength).toBe(MAX_UPLOAD_BYTES); expect(result.buffer.byteLength).toBe(MAX_UPLOAD_BYTES); expect(Buffer.from(result).equals(big)).toBe(true);
});
test('the real S3 client body stream (loopback server, no AWS) is read and bounded', async () => {
    const served = Buffer.alloc(300_000, 7); let sent = served;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Response(sent, { headers: { 'x-amz-checksum-sha256': createHash('sha256').update(served).digest('base64') } }); } });
    try {
        const client = new S3Client({ region: 'us-west-2', endpoint: `http://127.0.0.1:${server.port}`, forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
        const stager = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', client });
        const record = recordFor(served); const options = { maxBytes: MAX_UPLOAD_BYTES, signal: new AbortController().signal };
        expect(Buffer.from(await stager.readStaged(record, options)).equals(served)).toBe(true);
        sent = Buffer.concat([served, Buffer.from('extra')]);
        await fails(stager.readStaged(record, options), 'verification_failed');
    } finally { void server.stop(true); }
});

test('the installed SDK signs content-length and the checksum header and does not hoist the checksum', async () => {
    const client = new S3Client({ region: 'us-west-2', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
    const record = recordFor(DATA); const real = createS3AttachmentUploadStager({ bucketName: 'private-test-bucket', client, now: () => NOW });
    const result = await real.presign(record);
    const url = new URL(result.url);
    expect(url.protocol).toBe('https:'); expect(url.pathname).toContain(`/uploads/v1/${UPLOAD_ID}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256');
    expect([...url.searchParams.keys()].map(name => name.toLowerCase())).not.toContain('x-amz-checksum-sha256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_TTL_SECONDS)); expect(url.searchParams.get('X-Amz-Date')).toBe('20300101T000000Z');
    expect(result.headers).toEqual({ 'x-amz-checksum-sha256': Buffer.from(record.sha256, 'hex').toString('base64') });
    expect([...url.searchParams.keys()].filter(name => /server-side-encryption|content-type|acl|tagging/iu.test(name))).toEqual([]);
});
