/** Issue #2: a 25 MiB draft (the largest upload, 18 MiB, base64-encoded) must compose, upload and
 * verify, and an update of it must download, patch, upload and verify, within the Lambda's 1024 MB.
 * Each runs in its own child (as in the hostile-input tests), which reports its own memory. */
import { describe, expect, test } from 'bun:test';
import { CHILD_MEMORY_SOURCE, childPeak, memoryViolations, runChild, type ChildMemory } from './child-memory';

/** The Lambda's memory, given to the child's JSC as its RAM size so its heap grows as it would there. */
const LAMBDA_BYTES = 1024 * 1024 * 1024;
/** Peak RSS bound with margin. Measured on macOS arm64 (bun 1.4.4) from a ~70 MiB baseline, with the
 * fake WildDuck's own copies included (each stored draft is a view of its upload body; the staged
 * 18 MiB object stands in for S3): create peaks at 270-295 MiB, create then update at 310-320 MiB.
 * Half the Lambda leaves room for the runtime, the MCP layer and a concurrent read, and still fails
 * if several whole-message copies per step come back. */
const RSS_LIMIT_KIB = 512 * 1024;
const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
const script = (mode: 'create' | 'update') => `
    ${CHILD_MEMORY_SOURCE}
    import { fakeWildduck, session, accountId, clientIdHash } from ${path('./wildduck-fake.ts')};
    import { draftContentSchema, mailInputSchemas, MAX_UPLOAD_BYTES } from ${path('../src/mail/schemas.ts')};
    const marker = tool => ({ accountId, clientIdHash, payloadDigest: 'y'.repeat(43), operationId: 'operation-1234567', tool });
    const uploadId = '00000000-0000-4000-8000-000000000001';
    const f = fakeWildduck([], { listAttachments: false });
    // Bytes without repetition, so nothing downstream can share or compress them.
    const file = Buffer.allocUnsafe(MAX_UPLOAD_BYTES); for (let i = 0; i < file.length; i += 4) { file.writeUInt32LE(Math.imul(i + 1, 2654435761) >>> 0, i); }
    f.staged.add(uploadId, file);
    Bun.gc(true);
    const before = usage(); const start = performance.now();
    let prepared = await f.backend.prepareCreate(session, draftContentSchema.parse({ to: [{ address: 'to@example.com' }], subject: 'Large', body: { text: 'See attached.' }, attachments: [{ uploadId, filename: 'large.bin', contentType: 'application/octet-stream' }] }), marker('create_draft'));
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
    let size = prepared.mime.raw.length; const created = usage().maxRSS;
    if (${JSON.stringify(mode)} === 'update') {
        const contentDigest = prepared.mime.sha256; prepared = undefined; Bun.gc(true);
        const snapshot = await f.backend.inspectMessage(session, key);
        const { uid: _u, expectedVersion: _v, operationId: _o, ...patch } = mailInputSchemas.update_draft.parse({ uid: key.uid, expectedVersion: snapshot.message.version, operationId: 'operation-1234567', subject: 'Renamed', attachments: [{ contentBase64: Buffer.from('small').toString('base64'), filename: 'small.txt', contentType: 'text/plain' }] });
        const updated = await f.backend.prepareUpdate(session, snapshot, patch, marker('update_draft'), { grade: 'mcp_authored', accountId, ...key, contentDigest });
        const next = await f.backend.uploadPreparedDraft(session, updated); await f.backend.verifyPreparedDraft(session, next, updated);
        size = updated.mime.raw.length;
    }
    const ms = performance.now() - start; const after = usage();
    console.log(JSON.stringify({ size, ms, created, before: before.maxRSS, after: after.maxRSS, rss: after.rss, hwm: ownPeak() }));
`;

/** Peak RSS bound for a draft that copies one small file from each of 100 messages, each of whose JSON is just under
 * the 4 MiB message cap because of one large value unrelated to the file (two-byte characters, so each parsed string
 * is 8 MiB). Holding every message's JSON until its files were fetched peaked at 1150-1210 MiB, past the Lambda's
 * 1024 MB; reducing each to its attachment records inside the read leaves RESOLVE_CONCURRENCY JSONs alive at once.
 * Measured on macOS arm64 (bun 1.4.4) from a ~65 MiB baseline: 320-360 MiB, most of it garbage a 1 GiB heap has not
 * yet collected (with a 128 MiB heap hint the same work peaks near 210 MiB). Half the Lambda still fails if the
 * JSONs are kept again. */
const SOURCES_RSS_LIMIT_KIB = 512 * 1024;
const sourcesScript = (field: 'headers' | 'text') => `
    ${CHILD_MEMORY_SOURCE}
    import { createMailBackend } from ${path('../src/mail/backend.ts')};
    import { draftContentSchema } from ${path('../src/mail/schemas.ts')};
    import { received, accountId, draftsId, inboxId, session, clientIdHash } from ${path('./wildduck-fake.ts')};
    const field = ${JSON.stringify(field)}; const MESSAGE_BYTES = 4 * 1024 * 1024;
    const { id: _id, [field]: _replaced, ...rest } = received(1, { ATT00001: { bytes: Buffer.from('x'), filename: 'x.txt', contentType: 'text/plain' } }).json;
    // One shared body middle (built once, served as a view), so the fake costs almost nothing beside the backend's copies.
    const head = (uid) => Buffer.from('{"id":' + uid + ',');
    const prefix = JSON.stringify(rest).slice(1, -1) + ',"' + field + '":' + (field === 'headers' ? '{"x-long":"' : '"');
    const tail = Buffer.from(field === 'headers' ? '"}}' : '"}');
    const middle = Buffer.from(prefix + 'a'.repeat(MESSAGE_BYTES - 1024 - prefix.length) + '\\u0100');
    let metadataCalls = 0;
    const fetcher = async (url) => {
        const path = new URL(url).pathname.slice(('/users/' + accountId).length);
        if (path === '') { return Response.json({ success: true, id: accountId, address: 'sender@example.com' }); }
        if (path === '/addresses') { return Response.json({ success: true, results: [] }); }
        if (path === '/mailboxes') { return Response.json({ success: true, results: [{ id: draftsId, path: 'Drafts', specialUse: '\\\\Drafts' }] }); }
        if (path.endsWith('/attachments/ATT00001')) { return new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': '1' } }); }
        metadataCalls++; const parts = [head(Number(path.split('/').at(-1))), middle, tail];
        const length = parts.reduce((sum, part) => sum + part.length, 0); if (length >= MESSAGE_BYTES) { throw new Error('body over the cap'); }
        return new Response(new ReadableStream({ pull(controller) { const part = parts.shift(); if (part) { controller.enqueue(part); } else { controller.close(); } } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'content-length': String(length) } });
    };
    const backend = createMailBackend({ fetch: fetcher });
    const marker = { accountId, clientIdHash, payloadDigest: 'y'.repeat(43), operationId: 'operation-1234567', tool: 'create_draft' };
    const attachments = Array.from({ length: 100 }, (_, index) => ({ source: { mailboxId: inboxId, uid: index + 1, attachmentId: 'ATT00001' }, filename: 'file-' + index + '.txt' }));
    Bun.gc(true);
    const before = usage(); const start = performance.now();
    const prepared = await backend.prepareCreate(session, draftContentSchema.parse({ to: [{ address: 'to@example.com' }], subject: 'Many sources', body: { text: 'x' }, attachments }), marker);
    const ms = performance.now() - start; const after = usage();
    console.log(JSON.stringify({ metadataCalls, files: (prepared.mime.raw.toString('latin1').match(/filename=/gu) ?? []).length, ms, before: before.maxRSS, after: after.maxRSS, rss: after.rss, hwm: ownPeak() }));
`;

describe('attachments copied from many large messages', () => {
    test.each(['headers', 'text'] as const)('100 source messages whose JSON is near the cap (%s) stay under the RSS bound', async field => {
        const child = await runChild(sourcesScript(field), { ramBytes: LAMBDA_BYTES, killKiB: SOURCES_RSS_LIMIT_KIB, deadlineMs: 20_000 });
        expect(child.stderr).toBe(''); expect(child.exceeded).toBe(false); expect(child.timedOut).toBe(false); expect(child.status).toBe(0);
        const result = JSON.parse(child.stdout) as { metadataCalls: number; files: number; ms: number } & ChildMemory;
        expect(result.metadataCalls).toBe(100); expect(result.files).toBe(100);
        expect(memoryViolations(result, SOURCES_RSS_LIMIT_KIB)).toEqual([]);
        // eslint-disable-next-line no-console -- The measured figures are the point of this test; they go to the report.
        console.info(JSON.stringify({ field, ms: Math.round(result.ms), peakKiB: childPeak(result), beforeKiB: result.before, rssKiB: result.rss }));
    }, 30_000);
});

/** Peak RSS bound for get_message_source_download of a 25 MiB source through the real S3 stager (a fake S3 client that
 * keeps no body). The backend holds the source once and the stager sends that buffer itself as the one PutObject body
 * (the SDK writes a Buffer body without copying it); the fake WildDuck's stored source is one more copy. Measured on
 * macOS arm64 (bun 1.4.4) from a ~73 MiB baseline: 94-95 MiB peak. Half the Lambda still fails if several
 * whole-message copies come back. */
const SOURCE_DOWNLOAD_RSS_LIMIT_KIB = 512 * 1024;
const sourceDownloadScript = `
    ${CHILD_MEMORY_SOURCE}
    import { createHash } from 'node:crypto';
    import { createMailBackend } from ${path('../src/mail/backend.ts')};
    import { createS3AttachmentDownloadStager } from ${path('../src/mail/downloads.ts')};
    import { MAX_MESSAGE_BYTES } from ${path('../src/mail/mime.ts')};
    import { inboxId, session } from ${path('./wildduck-fake.ts')};
    // Bytes without repetition, so nothing downstream can share or compress them.
    const stored = Buffer.allocUnsafe(MAX_MESSAGE_BYTES); for (let i = 0; i < stored.length; i += 4) { stored.writeUInt32LE(Math.imul(i + 1, 2654435761) >>> 0, i); }
    const fetcher = async () => new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < stored.length; offset += 64 * 1024) { controller.enqueue(stored.subarray(offset, offset + 64 * 1024)); } controller.close(); } }), { headers: { 'content-type': 'message/rfc822', 'content-length': String(stored.length) } });
    const objects = new Map(); let puts = 0;
    const client = { config: { credentials: async () => ({ accessKeyId: 'test', secretAccessKey: 'test' }) }, send: async command => {
        const input = command.input; const name = command.constructor.name;
        if (name === 'HeadObjectCommand') { const object = objects.get(input.Key); if (!object) { throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }); } return object; }
        if (name === 'PutObjectCommand') {
            // As S3 does, store the object only if the body matches the sent SHA-256 (hashing reads the body in place).
            puts++; if (createHash('sha256').update(input.Body).digest('base64') !== input.ChecksumSHA256) { throw Object.assign(new Error('BadDigest'), { $metadata: { httpStatusCode: 400 } }); }
            objects.set(input.Key, { ContentLength: input.Body.byteLength, ETag: '"e"', ContentType: input.ContentType, ContentDisposition: input.ContentDisposition, CacheControl: input.CacheControl, ServerSideEncryption: 'AES256', Metadata: input.Metadata, ChecksumSHA256: input.ChecksumSHA256, ChecksumType: 'FULL_OBJECT' }); return {};
        }
        throw new Error('unexpected ' + name);
    } };
    const stager = createS3AttachmentDownloadStager({ bucketName: 'private-test-bucket', client, presign: async (_client, command) => 'https://private-bucket.s3.example/' + command.input.Key });
    const backend = createMailBackend({ fetch: fetcher, downloadStager: stager });
    Bun.gc(true);
    const before = usage(); const start = performance.now();
    const result = await backend.getMessageSourceDownload(session, { mailboxId: inboxId, uid: 1 });
    const ms = performance.now() - start; const after = usage();
    console.log(JSON.stringify({ size: result.metadata.size, puts, ms, before: before.maxRSS, after: after.maxRSS, rss: after.rss, hwm: ownPeak() }));
`;
describe('25 MiB message source download memory', () => {
    test('staging a 25 MiB message source stays under the RSS bound', async () => {
        const child = await runChild(sourceDownloadScript, { ramBytes: LAMBDA_BYTES, killKiB: SOURCE_DOWNLOAD_RSS_LIMIT_KIB, deadlineMs: 20_000 });
        expect(child.stderr).toBe(''); expect(child.exceeded).toBe(false); expect(child.timedOut).toBe(false); expect(child.status).toBe(0);
        const result = JSON.parse(child.stdout) as { size: number; puts: number; ms: number } & ChildMemory;
        expect(result.size).toBe(25 * 1024 * 1024); expect(result.puts).toBe(1);
        expect(memoryViolations(result, SOURCE_DOWNLOAD_RSS_LIMIT_KIB)).toEqual([]);
        // eslint-disable-next-line no-console -- The measured figures are the point of this test; they go to the report.
        console.info(JSON.stringify({ mode: 'source_download', sizeBytes: result.size, ms: Math.round(result.ms), peakKiB: childPeak(result), beforeKiB: result.before, rssKiB: result.rss }));
    }, 30_000);
});

describe('25 MiB message memory', () => {
    test.each(['create', 'update'] as const)('%s of a 25 MiB draft stays under the RSS bound', async mode => {
        const child = await runChild(script(mode), { ramBytes: LAMBDA_BYTES, killKiB: RSS_LIMIT_KIB, deadlineMs: 20_000 });
        expect(child.stderr).toBe(''); expect(child.exceeded).toBe(false); expect(child.timedOut).toBe(false); expect(child.status).toBe(0);
        const result = JSON.parse(child.stdout) as { size: number; ms: number; created: number } & ChildMemory;
        expect(result.size).toBeGreaterThan(24 * 1024 * 1024); expect(result.size).toBeLessThanOrEqual(25 * 1024 * 1024);
        expect(memoryViolations(result, RSS_LIMIT_KIB)).toEqual([]);
        // eslint-disable-next-line no-console -- The measured figures are the point of this test; they go to the report.
        console.info(JSON.stringify({ mode, sizeBytes: result.size, ms: Math.round(result.ms), peakKiB: childPeak(result), afterCreateKiB: result.created, beforeKiB: result.before, rssKiB: result.rss }));
    }, 30_000);
});
