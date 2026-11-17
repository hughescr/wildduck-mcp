/** Issue #2: attachments from a staged upload (uploadId) or from a message of the same account
 * (source), resolved in preflight by create_draft, create_reply_draft and update_draft, composed by
 * the MIME layer from bytes, and verified on read-back exactly like contentBase64 attachments. */
import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, Streamer } from '@zone-eu/mailsplit';
import { MailError, type MailFailureCode, type MailOperationMarker, type MailWriteTool, type PreparedDraft } from '../src/mail/contracts';
import { draftContentSchema, mailInputSchemas, MAX_UPLOAD_BYTES } from '../src/mail/schemas';
import { createMailService, PREFLIGHT_RESERVE_MS, RESERVE_ADMISSION_MS } from '../src/mail/service';
import { withRequestBudget } from '../src/request-budget';
import { steppedClock } from './dynamo-virtual';
import { accountId, clientId, clientIdHash, draftsId, fakeWildduck, inboxId, memoryOperations, received, session, sha256, stagedUploads, type FakeOptions, type StoredFile } from './wildduck-fake';

type Fake = ReturnType<typeof fakeWildduck>;
type Tool = 'create' | 'reply' | 'update';
const tools: Tool[] = ['create', 'reply', 'update'];
const original = { mailboxId: inboxId, uid: 7 };
const marker = (tool: MailWriteTool): MailOperationMarker => ({ accountId, clientIdHash, payloadDigest: 'y'.repeat(43), operationId: 'operation-1234567', tool });
const uploadId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const pdf = Buffer.from('%PDF-1.7\n' + 'report bytes '.repeat(40));
const eml = Buffer.from('From: someone@example.com\r\nSubject: forwarded\r\n\r\nForwarded body\r\n');
const bareLf = Buffer.from('From: someone@example.com\nSubject: forwarded\n\nForwarded body\n');
/** The original message every fake holds: a reply's original and a source of mailbox attachments. */
const files: Record<string, StoredFile> = {
    ATT00001: { bytes: pdf, filename: 'report.pdf', contentType: 'application/pdf' },
    ATT00002: { bytes: Buffer.from('<p>received page</p>'), filename: 'page.html', contentType: 'text/html' },
    ATT00003: { bytes: Buffer.from('x'), filename: 'bad\u0001name.txt', contentType: 'text/plain' },
    ATT00004: { bytes: Buffer.from('x'), filename: 'encoded =?utf-8?q?x?= name.txt', contentType: 'text/plain' },
    ATT00005: { bytes: Buffer.from('x'), filename: ' padded.txt', contentType: 'text/plain' },
    ATT00006: { bytes: bareLf, filename: 'forward.eml', contentType: 'message/rfc822' },
    ATT00007: { bytes: eml, filename: 'forward.eml', contentType: 'message/rfc822' },
    ATT00008: { bytes: Buffer.from('x'), filename: null, contentType: 'application/octet-stream' },
    ATT00009: { bytes: Buffer.from('x'), filename: 'odd.bin', contentType: 'multipart/mixed' },
};
const fake = (options: FakeOptions = {}, extra: Array<ReturnType<typeof received>> = []) => fakeWildduck([received(7, files), ...extra], options);
async function errorCode(action: Promise<unknown>, expected: MailFailureCode) {
    try { await action; throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(expected); }
}
/** Every attachment of a stored message as a reader decodes it. */
async function attachments(raw: Buffer): Promise<Array<{ filename: string; contentType: string; disposition: string; cid: string; bytes: Buffer }>> {
    const found: Array<{ filename: string; contentType: string; disposition: string; cid: string; bytes: Buffer }> = [];
    const streamer = new Streamer(node => Boolean(node.filename) || node.disposition === 'attachment');
    streamer.on('node', ({ node, decoder, done }) => {
        const chunks: Buffer[] = [];
        decoder.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        decoder.on('end', () => { found.push({ filename: node.filename || '', contentType: node.contentType || '', disposition: node.disposition || '', cid: node.headers ? node.headers.getFirst('content-id') : '', bytes: Buffer.concat(chunks) }); done(); });
    });
    await pipeline(Readable.from([raw]), new Splitter({ ignoreEmbedded: true }), streamer, new Writable({ objectMode: true, write(_chunk, _encoding, callback) { callback(); } }));
    return found;
}
/** A verified authored draft without attachments, as the base of an update. */
async function authoredDraft(f: Fake) {
    const created = await f.backend.prepareCreate(session, draftContentSchema.parse({ to: [{ address: 'to@example.com' }], subject: 'Base', body: { text: 'Base body' } }), marker('create_draft'));
    const key = await f.backend.uploadPreparedDraft(session, created); await f.backend.verifyPreparedDraft(session, key, created);
    return { key, created };
}
/** Prepares the same attachments through one of the three tools; for update, on a fresh authored draft. */
async function prepare(f: Fake, tool: Tool, items: unknown[], options: { deleteAttachmentIds?: string[] } = {}): Promise<PreparedDraft> {
    if (tool === 'create') { return f.backend.prepareCreate(session, draftContentSchema.parse({ to: [{ address: 'to@example.com' }], subject: 'Files', body: { text: 'See attached.' }, attachments: items }), marker('create_draft')); }
    if (tool === 'reply') { return f.backend.prepareReply(session, mailInputSchemas.create_reply_draft.parse({ original, body: { text: 'Reply' }, attachments: items, operationId: 'operation-1234567' }), marker('create_reply_draft')); }
    const { key, created } = await authoredDraft(f);
    const snapshot = await f.backend.inspectMessage(session, key);
    const { uid: _uid, expectedVersion: _version, operationId: _operation, ...patch } = mailInputSchemas.update_draft.parse({ uid: key.uid, expectedVersion: snapshot.message.version, operationId: 'operation-1234567', attachments: items, ...options });
    return f.backend.prepareUpdate(session, snapshot, patch, marker('update_draft'), { grade: 'mcp_authored', accountId, ...key, contentDigest: created.mime.sha256 });
}
/** Uploads and verifies a prepared draft exactly as the service does, and returns its stored attachments. */
async function stored(f: Fake, prepared: PreparedDraft) {
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
    expect(sha256(f.source(key.uid))).toBe(prepared.mime.sha256);
    return attachments(f.source(key.uid));
}
/** A service input attachment, as the MCP layer passes it once parsed. */
const file = <Item extends object>(item: Item) => ({ disposition: 'attachment' as const, ...item });
const since = (f: Fake, start: number) => f.calls.slice(start);
const attachmentGets = (f: Fake, start = 0) => since(f, start).filter(call => call.path.includes('/attachments/'));
const messageGets = (f: Fake, key: { mailboxId: string; uid: number }, start = 0) => since(f, start).filter(call => call.method === 'GET' && call.path === `/mailboxes/${key.mailboxId}/messages/${key.uid}`);

describe('uploadId attachments', () => {
    test.each(tools)('%s: one batch read, the staged bytes attached exactly, and the draft verified on read-back', async tool => {
        const f = fake(); f.staged.add(uploadId(1), pdf); f.staged.add(uploadId(2), eml);
        const prepared = await prepare(f, tool, [{ uploadId: uploadId(1), filename: 'report.pdf', contentType: 'application/pdf' }, { uploadId: uploadId(2), filename: 'mail.eml', contentType: 'message/rfc822' }, { uploadId: uploadId(1), filename: 'logo.png', contentType: 'image/png', disposition: 'inline', cid: 'logo@example.com' }]);
        // Identical references are read once; one batch names every distinct id.
        expect(f.staged.batches).toEqual([[uploadId(1), uploadId(2)]]); expect(f.staged.reads.toSorted()).toEqual([uploadId(1), uploadId(2)]);
        const found = await stored(f, prepared);
        expect(found.map(item => [item.filename, item.contentType, item.disposition])).toEqual([['logo.png', 'image/png', 'inline'], ['report.pdf', 'application/pdf', 'attachment'], ['mail.eml', 'message/rfc822', 'attachment']]);
        expect(found[0]?.bytes.equals(pdf)).toBe(true); expect(found[1]?.bytes.equals(pdf)).toBe(true); expect(found[2]?.bytes.equals(eml)).toBe(true);
        expect(found[0]?.cid).toBe('<logo@example.com>');
    });
    test.each(tools)('%s: absent, foreign-account, foreign-client and expired upload ids are all not_found', async tool => {
        for (const over of [undefined, { accountId: 'd'.repeat(24) }, { clientIdHash: 'z'.repeat(43) }, { expiresAt: Math.floor(Date.now() / 1000) - 1 }]) {
            const f = fake(); if (over) { f.staged.add(uploadId(3), pdf, over); }
            await errorCode(prepare(f, tool, [{ uploadId: uploadId(3), filename: 'a.pdf', contentType: 'application/pdf' }]), 'not_found');
            expect(f.staged.reads).toEqual([]);
        }
    });
    test.each(tools)('%s: bytes other than the record pins are verification_failed, from the stager or past it', async tool => {
        const f = fake(); f.staged.add(uploadId(4), pdf, {}, Buffer.concat([pdf.subarray(0, -1), Buffer.from('!')]));
        await errorCode(prepare(f, tool, [{ uploadId: uploadId(4), filename: 'a.pdf', contentType: 'application/pdf' }]), 'verification_failed');
        // A stager that returns the wrong length anyway is caught by the backend's own length check.
        const staged = stagedUploads(); const record = staged.add(uploadId(5), pdf);
        const lying = fake({ uploads: { store: staged.store, stager: { presign: staged.stager.presign, readStaged: async () => pdf.subarray(0, record.sizeBytes - 1) } } });
        await errorCode(prepare(lying, tool, [{ uploadId: uploadId(5), filename: 'a.pdf', contentType: 'application/pdf' }]), 'verification_failed');
    });
    test.each(tools)('%s: without a well-formed client digest or a configured store, uploads are refused before any upload I/O', async tool => {
        for (const bad of ['', 'short', 'h'.repeat(42) + '=', undefined]) {
            const f = fake(); f.staged.add(uploadId(6), pdf);
            const badSession = { accountId, accessToken: session.accessToken, ...(bad === undefined ? {} : { clientIdHash: bad }) } as typeof session;
            const item = { uploadId: uploadId(6), filename: 'a.pdf', contentType: 'application/pdf', disposition: 'attachment' as const };
            const action = tool === 'create' ? f.backend.prepareCreate(badSession, draftContentSchema.parse({ subject: 'x', body: { text: 'x' }, attachments: [item] }), marker('create_draft'))
                : tool === 'reply' ? f.backend.prepareReply(badSession, mailInputSchemas.create_reply_draft.parse({ original, body: { text: 'x' }, attachments: [item], operationId: 'operation-1234567' }), marker('create_reply_draft'))
                    : (async () => { const { key, created } = await authoredDraft(f); const snapshot = await f.backend.inspectMessage(badSession, key); return f.backend.prepareUpdate(badSession, snapshot, { attachments: [item] }, marker('update_draft'), { grade: 'mcp_authored', accountId, ...key, contentDigest: created.mime.sha256 }); })();
            const before = f.calls.length;
            // Server wiring, not the caller's input: it fails closed as unavailable.
            await errorCode(action, 'temporarily_unavailable');
            expect(f.staged.batches).toEqual([]); if (tool !== 'update') { expect(f.calls.length).toBe(before); }
        }
        const unconfigured = fake({ uploads: false });
        await errorCode(prepare(unconfigured, tool, [{ uploadId: uploadId(6), filename: 'a.pdf', contentType: 'application/pdf' }]), 'temporarily_unavailable');
        // Only uploads need the client digest and the store: the other sources resolve without them.
        expect(await stored(unconfigured, await prepare(unconfigured, tool, [{ source: { ...original, attachmentId: 'ATT00001' } }, { contentBase64: pdf.toString('base64'), filename: 'inline.pdf', contentType: 'application/pdf' }]))).toHaveLength(2);
    });
});

describe('source attachments', () => {
    test.each(tools)('%s: the source\'s name and type by default, the caller\'s when given; disposition and cid always the caller\'s', async tool => {
        const f = fake();
        const prepared = await prepare(f, tool, [{ source: { ...original, attachmentId: 'ATT00001' } }, { source: { ...original, attachmentId: 'ATT00001' }, filename: 'renamed.bin', contentType: 'application/octet-stream', disposition: 'inline', cid: 'pdf@example.com' }, { source: { ...original, attachmentId: 'ATT00007' } }]);
        const found = await stored(f, prepared);
        expect(found.map(item => [item.filename, item.contentType, item.disposition, item.cid])).toEqual([['renamed.bin', 'application/octet-stream', 'inline', '<pdf@example.com>'], ['report.pdf', 'application/pdf', 'attachment', ''], ['forward.eml', 'message/rfc822', 'attachment', '']]);
        expect(found[0]?.bytes.equals(pdf)).toBe(true); expect(found[1]?.bytes.equals(pdf)).toBe(true); expect(found[2]?.bytes.equals(eml)).toBe(true);
    });
    test('the same file is fetched once and each source message read once; a reply reuses its original', async () => {
        const second = received(8, { ATT00001: { bytes: eml, filename: 'other.eml', contentType: 'message/rfc822' } });
        for (const tool of tools) {
            const f = fake({}, [second]);
            const prepared = await prepare(f, tool, [{ source: { ...original, attachmentId: 'ATT00001' } }, { source: { ...original, attachmentId: 'ATT00001' }, filename: 'copy.pdf' }, { source: { ...original, attachmentId: 'ATT00007' } }, { source: { mailboxId: inboxId, uid: 8, attachmentId: 'ATT00001' } }, { source: { mailboxId: inboxId, uid: 8, attachmentId: 'ATT00001' } }]);
            expect(attachmentGets(f).map(call => call.path).toSorted()).toEqual([`/mailboxes/${inboxId}/messages/7/attachments/ATT00001`, `/mailboxes/${inboxId}/messages/7/attachments/ATT00007`, `/mailboxes/${inboxId}/messages/8/attachments/ATT00001`]);
            expect(messageGets(f, original)).toHaveLength(1); expect(messageGets(f, { mailboxId: inboxId, uid: 8 })).toHaveLength(1);
            expect(await stored(f, prepared)).toHaveLength(5);
        }
    });
    test.each(tools)('%s: a missing message or attachment is not_found', async tool => {
        await errorCode(prepare(fake(), tool, [{ source: { ...original, attachmentId: 'ATT00099' } }]), 'not_found');
        await errorCode(prepare(fake(), tool, [{ source: { mailboxId: inboxId, uid: 99, attachmentId: 'ATT00001' } }]), 'not_found');
    });
    test.each(tools)('%s: a source name or type the schema would refuse is invalid_input before any bytes are fetched, unless the caller overrides it', async tool => {
        for (const attachmentId of ['ATT00003', 'ATT00004', 'ATT00005', 'ATT00008', 'ATT00009']) {
            const f = fake();
            await errorCode(prepare(f, tool, [{ source: { ...original, attachmentId } }]), 'invalid_input');
            expect(attachmentGets(f)).toEqual([]);
        }
        const f = fake();
        const found = await stored(f, await prepare(f, tool, [{ source: { ...original, attachmentId: 'ATT00003' }, filename: 'clean.txt' }, { source: { ...original, attachmentId: 'ATT00009' }, filename: 'odd.bin', contentType: 'application/octet-stream' }]));
        expect(found.map(item => item.filename)).toEqual(['clean.txt', 'odd.bin']);
    });
    test.each(tools)('%s: a received text/html attached inline is refused by the final type, whatever its source', async tool => {
        const f = fake(); f.staged.add(uploadId(7), Buffer.from('<p>x</p>'));
        await errorCode(prepare(f, tool, [{ source: { ...original, attachmentId: 'ATT00002' }, disposition: 'inline', cid: 'page@example.com' }]), 'invalid_input');
        expect(attachmentGets(f)).toEqual([]);
        // As a regular attachment it is an ordinary file.
        expect((await stored(f, await prepare(f, tool, [{ source: { ...original, attachmentId: 'ATT00002' } }]))).map(item => item.contentType)).toEqual(['text/html']);
    });
    test.each(tools)('%s: a bare-LF .eml is refused, from a mailbox or an upload, and its bytes are never rewritten', async tool => {
        await errorCode(prepare(fake(), tool, [{ source: { ...original, attachmentId: 'ATT00006' } }]), 'invalid_input');
        const f = fake(); f.staged.add(uploadId(8), bareLf);
        await errorCode(prepare(f, tool, [{ uploadId: uploadId(8), filename: 'mail.eml', contentType: 'message/rfc822' }]), 'invalid_input');
        // The same bytes under any other type are an opaque file.
        expect((await stored(f, await prepare(f, tool, [{ uploadId: uploadId(8), filename: 'mail.txt', contentType: 'application/octet-stream' }])))[0]?.bytes.equals(bareLf)).toBe(true);
    });
});

describe('one size budget and one deadline for the whole resolution', () => {
    const big = Buffer.alloc(10 * 1024 * 1024, 0x41);
    test.each(tools)('%s: declared sizes over the message cap are too_large before a single byte is read', async tool => {
        const f = fake({}, [received(9, { ATT00001: { bytes: big, filename: 'big.bin', contentType: 'application/octet-stream' } })]);
        f.staged.add(uploadId(9), big); f.staged.add(uploadId(10), big);
        await errorCode(prepare(f, tool, [{ uploadId: uploadId(9), filename: 'a.bin', contentType: 'application/octet-stream' }, { uploadId: uploadId(10), filename: 'b.bin', contentType: 'application/octet-stream' }]), 'too_large');
        expect(f.staged.reads).toEqual([]);
        // Exact source sizes count the same way, and an upload together with a source.
        await errorCode(prepare(f, tool, [{ uploadId: uploadId(9), filename: 'a.bin', contentType: 'application/octet-stream' }, { source: { mailboxId: inboxId, uid: 9, attachmentId: 'ATT00001' } }]), 'too_large');
        expect(f.staged.reads).toEqual([]); expect(attachmentGets(f)).toEqual([]);
        // The same 10 MiB twice is one fetch, but two encoded parts: still too large.
        await errorCode(prepare(f, tool, [{ uploadId: uploadId(9), filename: 'a.bin', contentType: 'application/octet-stream' }, { uploadId: uploadId(9), filename: 'b.bin', contentType: 'application/octet-stream' }]), 'too_large');
        expect(f.staged.reads).toEqual([]);
    });
    test('an update counts the parts it keeps, and the parts it deletes free their room', async () => {
        const f = fake(); f.staged.add(uploadId(11), big); f.staged.add(uploadId(12), Buffer.alloc(9 * 1024 * 1024, 0x42));
        const first = await prepare(f, 'update', [{ uploadId: uploadId(11), filename: 'a.bin', contentType: 'application/octet-stream' }]);
        const key = await f.backend.uploadPreparedDraft(session, first); await f.backend.verifyPreparedDraft(session, key, first);
        const snapshot = await f.backend.inspectMessage(session, key);
        const update = (patch: Record<string, unknown>) => { const { uid: _u, expectedVersion: _v, operationId: _o, ...parsed } = mailInputSchemas.update_draft.parse({ uid: key.uid, expectedVersion: snapshot.message.version, operationId: 'operation-1234567', ...patch }); return f.backend.prepareUpdate(session, snapshot, parsed, marker('update_draft'), { grade: 'mcp_authored', accountId, ...key, contentDigest: first.mime.sha256 }); };
        const reads = f.staged.reads.length;
        await errorCode(update({ attachments: [{ uploadId: uploadId(12), filename: 'b.bin', contentType: 'application/octet-stream' }] }), 'too_large');
        expect(f.staged.reads.length).toBe(reads);
        const replaced = await update({ deleteAttachmentIds: ['ATT00001'], attachments: [{ uploadId: uploadId(12), filename: 'b.bin', contentType: 'application/octet-stream' }] });
        expect(replaced.mime.retainedAttachments).toHaveLength(0);
    });
    test('an undeclared source size is metered as it arrives: the read stops once the total cannot fit, and the other reads are cancelled', async () => {
        const huge = Buffer.alloc(20 * 1024 * 1024, 0x43);
        const f = fake({ serving: { [`${inboxId}:9:ATT00001`]: { undeclared: true, chunk: 1024 * 1024 }, [`${inboxId}:9:ATT00002`]: { hang: true } } }, [received(9, {
            ATT00001: { bytes: huge, filename: 'huge.bin', contentType: 'application/octet-stream', transferEncoding: 'base64', size: 1024 },
            ATT00002: { bytes: Buffer.alloc(4096, 0x44), filename: 'slow.bin', contentType: 'application/octet-stream', transferEncoding: 'base64', size: 1024 },
        })]);
        await errorCode(prepare(f, 'create', [{ source: { mailboxId: inboxId, uid: 9, attachmentId: 'ATT00002' } }, { source: { mailboxId: inboxId, uid: 9, attachmentId: 'ATT00001' } }]), 'too_large');
        await Bun.sleep(10);
        expect(f.cancelled.toSorted()).toEqual([`${inboxId}:9:ATT00001`, `${inboxId}:9:ATT00002`]);
    });
    test.each(tools)('%s: too little request time left fails upstream_timeout before any attachment I/O', async tool => {
        const f = fake(); f.staged.add(uploadId(13), pdf);
        // 4 s left is less than the 5 s kept for composing after resolution (a write's preflight window, which is
        // what the backend sees as its request, already keeps the upload, read-back and ledger time).
        await withRequestBudget(() => 4000, () => errorCode(prepare(f, tool, [{ uploadId: uploadId(13), filename: 'a.pdf', contentType: 'application/pdf' }, { source: { ...original, attachmentId: 'ATT00001' } }]), 'upstream_timeout'));
        expect(f.staged.batches).toEqual([]); expect(attachmentGets(f)).toEqual([]);
    });
    test('a stalled fetch ends at the phase deadline with upstream_timeout, and the service uploads no draft', async () => {
        const f = fake({ serving: { [`${inboxId}:7:ATT00001`]: { hang: true } } });
        // A reservation that takes 5 s (the clock is moved on, not waited for).
        const clock = steppedClock(); const operations = memoryOperations();
        const service = createMailService({ reader: f.backend, writer: f.backend, operations: { ...operations, reserve: async (intent, owner) => { const result = await operations.reserve(intent, owner); clock.state.skew += 5000; return result; } } });
        const context = { ...session, clientId, scopes: ['mail:read', 'mail:draft'], connectionStatus: 'active' } as const;
        // The preflight window ends 20 s before the request and resolution 5 s before the window. 10.4 s of window admit
        // the reservation; after it, 5.4 s of window are left: 0.4 s for the fetch.
        let remaining = PREFLIGHT_RESERVE_MS + RESERVE_ADMISSION_MS + 400; const started = performance.now(); const real = Date.now();
        const result = await withRequestBudget(() => remaining - (performance.now() - started), () => service.create_draft(context, { to: [{ address: 'to@example.com' }], cc: [], bcc: [], subject: 'x', body: { text: 'x' }, attachments: [file({ source: { ...original, attachmentId: 'ATT00001' } })], operationId: 'stalled-source-01' })).finally(() => { clock.restore(); });
        remaining = 0;
        expect(result).toMatchObject({ status: 'failed', reason: 'upstream_timeout' });
        expect(Date.now() - real).toBeLessThan(3000);
        expect(f.calls.filter(call => call.method === 'POST')).toEqual([]);
        await Bun.sleep(10); expect(f.cancelled).toEqual([`${inboxId}:7:ATT00001`]);
    });
});

describe('WildDuck request timeouts scale with the body', () => {
    test('a large upload and a large source read get time in proportion to their size; small requests keep the base timeout', async () => {
        const file = Buffer.alloc(1024 * 1024, 0x46);
        // Base 100 ms; the 1.4 MB upload answers after 400 ms, its source arrives over ~460 ms.
        const f = fake({ timeoutMs: 100, delayMs: call => call.method === 'POST' ? 400 : 0, serving: { [`${draftsId}:100`]: { chunk: 64 * 1024, pauseMs: 20 } } });
        f.staged.add(uploadId(40), file);
        const prepared = await prepare(f, 'create', [{ uploadId: uploadId(40), filename: 'a.bin', contentType: 'application/octet-stream' }]);
        const key = await f.backend.uploadPreparedDraft(session, prepared); expect(key.uid).toBe(100);
        await f.backend.verifyPreparedDraft(session, key, prepared);
        const slow = fake({ timeoutMs: 100, delayMs: call => call.path === '/mailboxes' ? 400 : 0 });
        await errorCode(slow.backend.resolveDraftMailbox(session), 'upstream_timeout');
        // The request's own deadline still bounds the scaled time.
        const late = fake({ timeoutMs: 100, delayMs: call => call.method === 'POST' ? 400 : 0 }); late.staged.add(uploadId(41), file);
        const again = await prepare(late, 'create', [{ uploadId: uploadId(41), filename: 'a.bin', contentType: 'application/octet-stream' }]);
        await withRequestBudget(() => 2300, () => errorCode(late.backend.uploadPreparedDraft(session, again), 'upstream_timeout'));
    });
});

describe('mcp_authored proof through the service', () => {
    test('drafts from an upload and from a mailbox attachment verify, and later updates that add and remove attachments keep the proof', async () => {
        const f = fake(); f.staged.add(uploadId(20), pdf); f.staged.add(uploadId(21), eml);
        const service = createMailService({ reader: f.backend, writer: f.backend, operations: memoryOperations() });
        const context = { ...session, clientId, scopes: ['mail:read', 'mail:draft'], connectionStatus: 'active' } as const;
        const proved = (result: { status: string; proof?: { contentDigest: string; sourceGrade: string; uid: number; version: string } }) => {
            expect(result.status).toBe('completed'); expect(result.proof?.sourceGrade).toBe('mcp_authored');
            expect(result.proof?.contentDigest).toBe(sha256(f.source(result.proof?.uid ?? 0)));
            return result.proof ?? { uid: 0, version: '' };
        };
        const fromUpload = proved(await service.create_draft(context, { to: [{ address: 'to@example.com' }], cc: [], bcc: [], subject: 'Upload', body: { markdown: 'See **attached**.' }, attachments: [file({ uploadId: uploadId(20), filename: 'report.pdf', contentType: 'application/pdf' })], operationId: 'upload-create-0001' }));
        const fromMailbox = proved(await service.create_reply_draft(context, { original, mode: 'reply', body: { text: 'Forwarding the report.' }, quoteOriginal: false, attachments: [file({ source: { ...original, attachmentId: 'ATT00001' } })], operationId: 'source-reply-00001' }));
        for (const proof of [fromUpload, fromMailbox]) { expect((await attachments(f.source(proof.uid)))[0]?.bytes.equals(pdf)).toBe(true); }
        // Add a mailbox attachment and an upload, then remove the first file: each step is a verified, authored candidate.
        const added = proved(await service.update_draft(context, { uid: fromUpload.uid, expectedVersion: fromUpload.version, attachments: [file({ source: { ...original, attachmentId: 'ATT00007' } }), file({ uploadId: uploadId(21), filename: 'copy.eml', contentType: 'message/rfc822' })], operationId: 'upload-update-0001' }));
        expect((await attachments(f.source(added.uid))).map(item => item.filename)).toEqual(['report.pdf', 'forward.eml', 'copy.eml']);
        expect(f.draft(fromUpload.uid)).toBeUndefined();
        const snapshot = await f.backend.readMessage(session, { mailboxId: draftsId, uid: added.uid });
        const removed = proved(await service.update_draft(context, { uid: added.uid, expectedVersion: snapshot.message.version, deleteAttachmentIds: [snapshot.message.attachments[0]?.attachmentId ?? ''], attachments: [file({ uploadId: uploadId(20), filename: 'again.pdf', contentType: 'application/pdf' })], operationId: 'upload-update-0002' }));
        const final = await attachments(f.source(removed.uid));
        expect(final.map(item => item.filename)).toEqual(['forward.eml', 'copy.eml', 'again.pdf']);
        expect(final[0]?.bytes.equals(eml)).toBe(true); expect(final[1]?.bytes.equals(eml)).toBe(true); expect(final[2]?.bytes.equals(pdf)).toBe(true);
        // A source copy needs mail:read as well; the service refuses it before any backend work.
        await expect(service.create_draft({ ...context, scopes: ['mail:draft'] }, { to: [], cc: [], bcc: [], subject: 'x', body: { text: 'x' }, attachments: [file({ source: { ...original, attachmentId: 'ATT00001' } })], operationId: 'no-read-scope-0001' })).rejects.toMatchObject({ code: 'forbidden' });
    });
    test('the largest upload alone fits the message cap and verifies', async () => {
        const f = fake({ listAttachments: false }); const file = Buffer.alloc(MAX_UPLOAD_BYTES, 0x45); f.staged.add(uploadId(30), file);
        const prepared = await prepare(f, 'create', [{ uploadId: uploadId(30), filename: 'big.bin', contentType: 'application/octet-stream' }]);
        const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
        expect(f.source(key.uid).length).toBe(prepared.mime.raw.length);
    });
});
