import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createMailBackend, type SearchDiagnostic } from '../src/mail/backend';
import { withRequestBudget } from '../src/request-budget';
import { MailError, MAIL_OPERATION_METADATA_KEY, type BackendMailSession, type DraftContent, type DraftPatch, type MailFailureCode, type MailOperationMarker, type AuthoredSourceDescriptor } from '../src/mail/contracts';
import { mailOutputSchemas, MAX_READ_TEXT_BYTES } from '../src/mail/schemas';
import { WILDDUCK_ORIGIN } from '../src/wildduck';
const accountId = 'a'.repeat(24); const mailboxId = 'b'.repeat(24); const token = 'c'.repeat(40);
const session: BackendMailSession = { accountId, accessToken: token }; const target = { mailboxId, uid: 12 };
const content: DraftContent = { to: [], cc: [], bcc: [{ address: 'bcc@example.com' }], subject: 'A draft', body: { text: 'Body', html: null }, attachments: [] };
const marker: MailOperationMarker = { accountId, clientIdHash: 'x'.repeat(43), payloadDigest: 'y'.repeat(43), operationId: 'operation-1234567', tool: 'create_draft' };
function message(extra: Record<string, unknown> = {}) {
    return { success: true, user: accountId, id: 12, mailbox: mailboxId, subject: '', from: { address: 'invalid MIME address', name: 'Sender' }, to: [], cc: [], bcc: [], replyTo: [],
        date: '2026-10-26T00:00:00.000Z', idate: '2026-10-26T01:00:00.000Z', seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false, labels: [] as string[], metaData: {},
        attachments: [], flags: ['\\Draft'], envelope: { from: '', rcpt: [] }, references: [], messageId: '<test@example.com>', text: '', html: ['<p>display HTML from plain text</p>'], contentType: { value: 'text/plain' }, ...extra };
}
function fixture(responses: Array<unknown | Response>, timeoutMs = 100) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} }); const value = responses.shift();
        if (value === undefined) { throw new Error('Unexpected fake request'); }
        return value instanceof Response ? value : Response.json(value);
    }) as typeof fetch;
    return { backend: createMailBackend({ fetch: fetcher, timeoutMs }), calls };
}
async function errorCode(action: Promise<unknown>, expected: MailFailureCode) {
    try { await action; throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(expected); expect((error as Error).message).toBe(expected); }
}
const originalSource = Buffer.from('From: Sender <sender@example.com>\r\nTo: visible@example.com\r\nBcc: hidden@example.com\r\nReply-To: help@example.com\r\nSubject: Original\r\nMessage-ID: <original@example.com>\r\nReferences: <prior@example.com>\r\nDate: Mon, 26 Oct 2026 00:00:00 +0000\r\nX-Custom: preserve me\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nOriginal body\r\n');
const authored = (raw: Buffer = originalSource): AuthoredSourceDescriptor => ({ grade: 'mcp_authored', accountId, ...target, contentDigest: createHash('sha256').update(raw).digest('hex') });
function model(aliases: string[] = []) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let source: Buffer = originalSource;
    let raw = message({ from: { address: 'sender@example.com', name: 'Sender' }, to: [{ address: 'visible@example.com' }], bcc: [{ address: 'hidden@example.com' }], replyTo: [{ address: 'help@example.com' }], subject: 'Original',
        metaData: { untouched: { nested: ['keep'] } }, labels: ['KeepLabel'], flags: ['\\Draft', 'KeepKeyword'] });
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url)); calls.push({ url: String(url), init: init ?? {} });
        expect(parsed.origin).toBe(WILDDUCK_ORIGIN); expect(new Headers(init?.headers).get('X-Access-Token')).toBe(token); expect(init?.redirect).toBe('error');
        const prefix = `/users/${accountId}`; const path = parsed.pathname.slice(prefix.length);
        expect(parsed.pathname.startsWith(prefix)).toBe(true);
        if (path === '') { return Response.json({ success: true, id: accountId, address: 'sender@example.com', name: 'Sender', fromWhitelist: ['alias@example.com'] }); }
        if (path === '/addresses') { return Response.json({ success: true, results: aliases.map(address => ({ id: 'e'.repeat(24), address })) }); }
        if (path === '/mailboxes') { return Response.json({ success: true, results: [{ id: mailboxId, path: 'Server-specific Drafts', specialUse: '\\Drafts' }] }); }
        if (path === `/mailboxes/${'d'.repeat(24)}`) { return Response.json({ success: true, id: 'd'.repeat(24), path: 'Destination' }); }
        if (init?.method === 'POST' && path.endsWith('/submit')) { return Response.json({ success: true, queueId: 'queue-accepted', message: { id: 44, mailbox: 'd'.repeat(24) } }); }
        if (init?.method === 'POST' && path === `/mailboxes/${mailboxId}/messages`) {
            const body = JSON.parse(String(init.body)); source = Buffer.from(body.raw, 'base64');
            raw = message({ ...raw, id: 13, idate: body.date, metaData: body.metaData, flags: body.flags, labels: body.labels, seen: !body.unseen, flagged: body.flagged,
                ...(body.reference ? { reference: { mailbox: body.reference.mailbox, id: body.reference.id, action: body.reference.action } } : {}) });
            return Response.json({ success: true, message: { id: 13, mailbox: mailboxId } });
        }
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)); const flags = new Set(raw.flags);
            const canonical = (value: string) => value.toLowerCase() === '\\answered' ? '\\Answered' : value;
            for (const value of body.removeFlags ?? []) { flags.delete(canonical(value)); } for (const value of body.addFlags ?? []) { flags.add(canonical(value)); }
            for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']] as const) { if (body[key] === true) { flags.add(flag); } else if (body[key] === false) { flags.delete(flag); } }
            const labels = new Set<string>(body.labels ?? raw.labels); for (const value of body.removeLabels ?? []) { labels.delete(value); } for (const value of body.addLabels ?? []) { labels.add(value); }
            raw = message({ ...raw, metaData: body.metaData, flags: [...flags], labels: [...labels], seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered') && !flags.has('$Forwarded'), forwarded: flags.has('$Forwarded'), ...(body.moveTo ? { mailbox: body.moveTo, id: 42 } : {}) });
            return Response.json(body.moveTo ? { success: true, mailbox: body.moveTo, id: [[12, 42]] } : { success: true, updated: 1 });
        }
        if (path.endsWith('/message.eml')) {
            expect(parsed.search).toBe('');
            return new Response(new Uint8Array(source), { headers: { 'content-type': 'message/rfc822', 'content-length': String(source.length) } });
        }
        if (path.includes('/messages/')) { expect(parsed.search).toBe('?markAsSeen=false&replaceCidLinks=false'); return Response.json(raw); }
        throw new Error('Unexpected fake path');
    }) as typeof fetch;
    return { backend: createMailBackend({ fetch: fetcher }), calls, patch: (update: Record<string, unknown>) => { raw = message({ ...raw, ...update }); }, setSource: (value: Buffer) => { source = value; }, current: () => raw };
}
test('mailbox listing is bounded, uses explicit user token and resolves unique special-use Drafts independent of path', async () => {
    const boxes = { success: true, results: [{ id: mailboxId, path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts', total: 0, unseen: 0 }] };
    const f = fixture([boxes, boxes]); expect((await f.backend.listMailboxes(session)).mailboxes[0]).toEqual({ mailboxId, path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts', total: 0, unseen: 0 });
    expect((await f.backend.resolveDraftMailbox(session)).mailboxId).toBe(mailboxId);
    for (const call of f.calls) { expect(call.url).toBe(`${WILDDUCK_ORIGIN}/users/${accountId}/mailboxes?showHidden=true`); expect(call.init.method).toBe('GET'); expect(call.init.redirect).toBe('error'); expect(new Headers(call.init.headers).get('X-Access-Token')).toBe(token); }
    const none = fixture([{ success: true, results: [] }]); await errorCode(none.backend.resolveDraftMailbox(session), 'not_found');
    const ambiguous = fixture([{ success: true, results: [boxes.results[0], { ...boxes.results[0], id: 'd'.repeat(24) }] }]); await errorCode(ambiguous.backend.resolveDraftMailbox(session), 'temporarily_unavailable');
});
test('list uses one fixed descending page, encoded opaque cursor and no unseen or mutation parameters', async () => {
    const f = fixture([{ success: true, results: [message({ attachments: true })], nextCursor: 'next+/=', previousCursor: false }]);
    const result = await f.backend.listMessages(session, { mailboxId, limit: 2, next: 'opaque+/=' });
    expect(result.next).toBe('next+/='); expect(result).not.toHaveProperty('previous'); expect(result.messages[0]?.from[0]?.address).toBe('invalid MIME address');
    expect(f.calls[0]?.url).toBe(`${WILDDUCK_ORIGIN}/users/${accountId}/mailboxes/${mailboxId}/messages?order=desc&limit=2&metaData=true&next=opaque%2B%2F%3D`);
    expect(mailOutputSchemas.list_messages.safeParse(result).success).toBe(true);
});
test('search maps supported structured predicates, dates and previous cursor', async () => {
    const f = fixture([{ success: true, results: [], nextCursor: false, previousCursor: 'back' }]);
    expect(await f.backend.searchMessages(session, { mailboxId, limit: 3, from: 'a+b@example.com', to: 'person', subject: 'A & B', text: 'words', receivedSince: '2026-10-01T00:00:00Z', receivedUntil: '2026-10-26T00:00:00Z', seen: false, flagged: true, hasAttachments: true, previous: 'cursor+/=' })).toEqual({ messages: [], previous: 'back' });
    const url = new URL(f.calls[0]?.url ?? ''); expect(url.pathname).toBe(`/users/${accountId}/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ order: 'desc', limit: '3', metaData: 'true', mailbox: mailboxId, from: 'a+b@example.com', to: 'person', subject: 'A & B', query: 'words', datestart: '2026-10-01T00:00:00Z', dateend: '2026-10-26T00:00:00Z', flagged: 'true', attachments: 'true', previous: 'cursor+/=', unseen: 'true' });
    const wrong = fixture([{ success: true, results: [message({ mailbox: 'd'.repeat(24) })] }]); await errorCode(wrong.backend.searchMessages(session, { mailboxId, limit: 20 }), 'temporarily_unavailable');
});
test('all adapter entry points reject missing token and invalid account before any request', async () => {
    const f = fixture([]);
    for (const bad of [{ accountId, accessToken: '' }, { accountId: '../escape', accessToken: token }, { accountId, accessToken: token + '\n' }]) {
        for (const action of [() => f.backend.listMailboxes(bad), () => f.backend.listMessages(bad, { mailboxId, limit: 20 }), () => f.backend.searchMessages(bad, { subject: 'x', limit: 20 }), () => f.backend.readMessage(bad, target), () => f.backend.resolveDraftMailbox(bad), () => f.backend.inspectMessage(bad, target), () => f.backend.prepareCreate(bad, content, marker), () => f.backend.deleteDraft(bad, target), () => f.backend.submitDraft(bad, target), () => f.backend.readAttachment(bad, { ...target, attachmentId: 'ATT00001' })]) { await errorCode(action(), 'invalid_input'); }
    }
    expect(f.calls).toHaveLength(0);
});
test('invalid pagination and target inputs fail before network and no endpoint accepts arbitrary URL/account', async () => {
    const f = fixture([]);
    for (const input of [{ mailboxId, limit: 0 }, { mailboxId, limit: 51 }, { mailboxId, limit: 1, next: 'x', previous: 'y' }, { mailboxId: '../escape', limit: 1 }, { mailboxId, limit: 1, url: 'https://evil.example' }]) { await errorCode(f.backend.listMessages(session, input), 'invalid_input'); }
    await errorCode(f.backend.readMessage(session, { mailboxId, uid: 0 }), 'invalid_input');
    await errorCode(f.backend.searchMessages(session, { text: 'x'.repeat(256), limit: 20 }), 'invalid_input'); expect(f.calls).toHaveLength(0);
});
test('read returns plain bounded text and normalized metadata without changing Seen or fetching bytes', async () => {
    const f = fixture([message({ text: '🦊'.repeat(MAX_READ_TEXT_BYTES / 4 + 1), attachments: [{ id: 'ATT00001', filename: 'photo.png', contentType: 'image/png', transferEncoding: 'binary', size: 4, related: true }], date: 'invalid', idate: '2026-10-26T02:00:00Z' })]);
    const { message: result } = await f.backend.readMessage(session, target);
    expect(result.textTruncated).toBe(true); expect(Buffer.byteLength(result.text)).toBe(MAX_READ_TEXT_BYTES); expect(result.text.endsWith('🦊')).toBe(true); expect(result.date).toBe(null); expect(result.receivedAt).toBe('2026-10-26T02:00:00.000Z');
    expect(result.attachments).toEqual([{ attachmentId: 'ATT00001', filename: 'photo.png', contentType: 'image/png', size: 4, sizeIsApproximate: false, inline: true, cid: null }]); expect(result.htmlRepresentation).toBe('wildduck_normalized'); expect(result.version).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]?.url).toEndWith(`/messages/12?markAsSeen=false&replaceCidLinks=false`); expect(f.calls[0]?.init.method).toBe('GET');
});
test('read and inspect share full stable raw version including Bcc, envelope recipients, body tail, HTML and attachment identity', async () => {
    const raw = message({ text: 'a'.repeat(MAX_READ_TEXT_BYTES + 10) }); const base = fixture([raw, raw]);
    const { message: read } = await base.backend.readMessage(session, target); const inspected = await base.backend.inspectMessage(session, target); expect(read.version).toBe(inspected.message.version); expect(inspected.hasHtml).toBe(false);
    const reordered = Object.fromEntries(Object.entries(raw).reverse()); expect((await fixture([reordered]).backend.readMessage(session, target)).message.version).toBe(read.version);
    for (const changed of [message({ ...raw, text: raw.text + 'tail' }), message({ ...raw, bcc: [{ address: 'hidden@example.com' }] }), message({ ...raw, envelope: { from: '', rcpt: [{ value: 'bcc@example.com', formatted: 'bcc@example.com' }] } }), message({ ...raw, html: ['different HTML'] }), message({ ...raw, attachments: [{ id: 'ATT00001', contentType: 'text/plain', filename: 'x', size: 0 }] }), message({ ...raw, flags: ['\\Draft', '\\Seen'] })]) {
        expect((await fixture([changed]).backend.readMessage(session, target)).message.version).not.toBe(read.version);
    }
    const bcc = await fixture([message({ bcc: [{ address: 'bcc@example.com' }] })]).backend.inspectMessage(session, target); expect(bcc.hasRecipients).toBe(true);
    const html = await fixture([message({ contentType: { value: 'multipart/alternative' } })]).backend.inspectMessage(session, target); expect(html.hasHtml).toBe(true);
});
test('staged raw upload carries marker atomically, never replaces/deletes old mail, and verifies candidate source and envelope', async () => {
    const f = model(); const prepared = await f.backend.prepareCreate(session, content, marker);
    const candidate = await f.backend.uploadPreparedDraft(session, prepared);
    const verified = await f.backend.verifyPreparedDraft(session, candidate, prepared);
    expect(verified.uid).toBe(13); expect(verified.version).toHaveLength(43);
    const uploads = f.calls.filter(call => call.init.method === 'POST'); expect(uploads).toHaveLength(1);
    const body = JSON.parse(String(uploads[0]?.init.body)); expect(body).not.toHaveProperty('replacePrevious'); expect(body.metaData[MAIL_OPERATION_METADATA_KEY]).toEqual(marker);
    expect(Buffer.from(body.raw, 'base64').equals(prepared.mime.raw)).toBe(true); expect(body.to).toEqual([{ address: 'bcc@example.com' }]);
    expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
});
test('post-upload proof rejects changed MIME/recipients/metadata without retries or old-draft deletion', async () => {
    for (const change of ['source', 'flags', 'metadata'] as const) {
        const f = model(); const prepared = await f.backend.prepareCreate(session, content, marker); const candidate = await f.backend.uploadPreparedDraft(session, prepared);
        if (change === 'source') { f.setSource(Buffer.from('changed')); } else { f.patch(change === 'flags' ? { flags: ['\\Draft'] } : { metaData: {} }); }
        await errorCode(f.backend.verifyPreparedDraft(session, candidate, prepared), 'verification_failed'); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1); expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
    }
});
test('delete requires exactly one deletion and no errors; submit requires real queue ID and never retries', async () => {
    const f = fixture([{ success: true, deleted: 1, errors: 0 }, { success: true, queueId: '1234567890ab' }]); await f.backend.deleteDraft(session, target); expect(await f.backend.submitDraft(session, target)).toEqual({ queueId: '1234567890ab' });
    expect(f.calls.map(call => call.init.method)).toEqual(['DELETE', 'POST']); expect(f.calls[1]?.url).toEndWith('/messages/12/submit'); expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({});
    for (const response of [{ success: true }, { success: true, queueId: '' }, { success: true, queueId: 'bad queue' }, { success: true, queueId: 12 }]) { const bad = fixture([response]); await errorCode(bad.backend.submitDraft(session, target), 'temporarily_unavailable'); expect(bad.calls).toHaveLength(1); }
    const badDelete = fixture([{ success: true, deleted: 0, errors: 0 }]); await errorCode(badDelete.backend.deleteDraft(session, target), 'temporarily_unavailable');
});
test('status errors are sanitized and distinguish token expiry, permissions, absent resources and outages', async () => {
    for (const [status, code, expected] of [[403, 'InvalidToken', 'reconnect_required'], [403, 'AccessDenied', 'forbidden'], [404, 'MessageNotFound', 'not_found'], [400, 'InputValidationError', 'invalid_input'], [429, 'RateLimited', 'temporarily_unavailable'], [500, 'InvalidToken', 'temporarily_unavailable']] as const) {
        const f = fixture([Response.json({ code, error: `private ${token}` }, { status })]); await errorCode(f.backend.readMessage(session, target), expected); expect(f.calls).toHaveLength(1);
    }
});
test('metadata/full-message caps, malformed JSON, fatal UTF8, redirects and malformed owned shapes fail closed', async () => {
    const responses = [new Response('', { status: 302, headers: { location: 'https://evil.example' } }), new Response('{', { headers: { 'content-type': 'application/json' } }), new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }), Response.json({ success: true, results: [], extra: 'x'.repeat(512 * 1024) }), new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9999999' } })];
    for (const response of responses) { await expect(fixture([response]).backend.listMailboxes(session)).rejects.toBeInstanceOf(MailError); }
    await errorCode(fixture([message({ text: 'x'.repeat(4 * 1024 * 1024) })]).backend.readMessage(session, target), 'too_large');
    await errorCode(fixture([{ success: true, results: Array.from({ length: 1001 }, () => ({ id: mailboxId, path: 'x' })) }]).backend.listMailboxes(session), 'temporarily_unavailable');
    for (const changed of [{ user: 'd'.repeat(24) }, { id: 13 }, { flags: [3] }, { draft: 'true' }, { envelope: { rcpt: ['bad'] } }]) { await errorCode(fixture([message(changed)]).backend.readMessage(session, target), 'temporarily_unavailable'); }
    await errorCode(fixture([{ success: true, results: [message({ attachments: false }), message({ id: 13, attachments: false })] }]).backend.listMessages(session, { mailboxId, limit: 1 }), 'temporarily_unavailable');
});
test('deadline bounds stalled headers, stalled bodies and uncertain writes with one dispatch', async () => {
    let count = 0; let aborted: AbortSignal | null | undefined;
    const slow = createMailBackend({ timeoutMs: 5, fetch: (async (_url, init) => { count++; aborted = init?.signal; return await new Promise<Response>(() => {}); }) as typeof fetch });
    await errorCode(slow.submitDraft(session, target), 'upstream_timeout'); expect(count).toBe(1); expect(aborted?.aborted).toBe(true);
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } }); const f = fixture([new Response(stream, { headers: { 'content-type': 'application/json' } })], 5);
    await errorCode(f.backend.readMessage(session, target), 'upstream_timeout'); expect(cancelled).toBe(true); expect(f.calls).toHaveLength(1);
});
test('authored update preserves original MIME, Bcc, flags, labels and received date on the existing API', async () => {
    const f = model(); const before = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, before, { subject: 'Changed subject' }, { ...marker, tool: 'update_draft' }, authored());
    const body = originalSource.subarray(originalSource.indexOf('\r\n\r\n') + 4);
    expect(prepared.mime.raw.subarray(prepared.mime.raw.indexOf('\r\n\r\n') + 4).equals(body)).toBe(true);
    for (const text of ['Bcc: hidden@example.com', 'Reply-To: help@example.com', 'References: <prior@example.com>', 'X-Custom: preserve me']) { expect(prepared.mime.raw.toString()).toContain(text); }
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
    const call = f.calls.find(item => item.init.method === 'POST'); const upload = JSON.parse(String(call?.init.body));
    expect(upload.to.map((item: { address: string }) => item.address)).toEqual(['visible@example.com', 'hidden@example.com']);
    expect(upload.flags).toEqual(['\\Draft', 'KeepKeyword']); expect(upload.labels).toEqual(['KeepLabel']); expect(upload.date).toBe('2026-10-26T01:00:00.000Z'); expect(upload.metaData.untouched).toEqual({ nested: ['keep'] });
    expect(upload).not.toHaveProperty('replacePrevious');
});
test('recipient patch changes only requested address class when all recipients are attributable', async () => {
    const f = model(); const before = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, before, { to: [{ address: 'new@example.com' }] }, { ...marker, tool: 'update_draft' }, authored());
    await f.backend.uploadPreparedDraft(session, prepared);
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body));
    expect(body.to.map((item: { address: string }) => item.address)).toEqual(['new@example.com', 'hidden@example.com']);
    expect(prepared.mime.raw.toString()).toContain('To: new@example.com'); expect(prepared.mime.raw.toString()).toContain('Bcc: hidden@example.com');
});
test('authored explicit recipient clearing uses exactly final MIME recipients and body edits preserve Bcc', async () => {
    const cases: Array<[DraftPatch, string[]]> = [[{ bcc: [] }, ['visible@example.com']], [{ to: [], cc: [], bcc: [] }, []], [{ to: [{ address: 'replacement@example.com' }] }, ['replacement@example.com', 'hidden@example.com']]];
    for (const [patch, recipients] of cases) {
        const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
        const prepared = await f.backend.prepareUpdate(session, snapshot, structuredClone(patch), { ...marker, tool: 'update_draft' }, authored());
        await f.backend.uploadPreparedDraft(session, prepared);
        expect(JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body)).to.map((item: { address: string }) => item.address)).toEqual(recipients);
    }
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, snapshot, { body: { text: 'Changed only body', html: null } }, { ...marker, tool: 'update_draft' }, authored());
    await f.backend.uploadPreparedDraft(session, prepared);
    expect(JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body)).to.map((item: { address: string }) => item.address)).toEqual(['visible@example.com', 'hidden@example.com']);
});
test('version binds expiry, authentication results, queued submissions and forward targets independently', async () => {
    const original = (await fixture([message()]).backend.readMessage(session, target)).message.version;
    for (const changed of [{ expires: '2026-12-01T00:00:00Z' }, { verificationResults: { spf: 'pass' } }, { outbound: [{ queueId: 'queued' }] }, { forwardTargets: ['forwarded'] }]) {
        expect((await fixture([message(changed)]).backend.readMessage(session, target)).message.version).not.toBe(original);
    }
});
test('list and search expose validated managed-operation visibility with one metadata-bearing call and no private marker', async () => {
    for (const search of [false, true]) {
        const f = fixture([{ success: true, results: [message({ metaData: { [MAIL_OPERATION_METADATA_KEY]: marker } }), message({ id: 13 })] }]);
        const result = search ? await f.backend.searchMessages(session, { mailboxId, limit: 20 }) : await f.backend.listMessages(session, { mailboxId, limit: 20 });
        expect(result.messages[0]?.managedOperation).toEqual({ operationId: marker.operationId, verification: 'not_checked' }); expect(result.messages[1]).not.toHaveProperty('managedOperation');
        expect(f.calls).toHaveLength(1); expect(new URL(f.calls[0]?.url ?? '').searchParams.get('metaData')).toBe('true');
        expect(JSON.stringify(result)).not.toContain(MAIL_OPERATION_METADATA_KEY); expect(JSON.stringify(result)).not.toContain(marker.payloadDigest);
        for (const badMarker of [{ malformed: true }, { ...marker, accountId: 'd'.repeat(24) }]) {
            const bad = fixture([{ success: true, results: [message({ metaData: { [MAIL_OPERATION_METADATA_KEY]: badMarker } })] }]);
            await errorCode(search ? bad.backend.searchMessages(session, { mailboxId, limit: 20 }) : bad.backend.listMessages(session, { mailboxId, limit: 20 }), 'verification_failed'); expect(bad.calls).toHaveLength(1);
        }
    }
});
test('legacy file associations cannot be silently reintroduced after an attachment deletion', async () => {
    const f = model(); f.patch({ files: [{ id: 'd'.repeat(24), filename: 'legacy.bin' }] }); const snapshot = await f.backend.inspectMessage(session, target);
    await errorCode(f.backend.prepareUpdate(session, snapshot, { deleteAttachmentIds: ['ATT00001'] }, { ...marker, tool: 'update_draft' }, authored()), 'unsupported_content');
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
});
test('candidate activation rejects observed unsupported expiry, queue, authentication or forwarding state', async () => {
    for (const update of [{ expires: '2026-12-01T00:00:00Z' }, { outbound: [{ queueId: 'already-queued' }] }, { verificationResults: { spf: 'pass' } }, { forwardTargets: ['forwarded'] }]) {
        const f = model(); const prepared = await f.backend.prepareCreate(session, content, marker); const candidate = await f.backend.uploadPreparedDraft(session, prepared); f.patch(update);
        await errorCode(f.backend.verifyPreparedDraft(session, candidate, prepared), 'verification_failed'); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1); expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
    }
});
test('trusted full-source digest catches padded hidden text before any mutation', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    f.setSource(Buffer.concat([originalSource.subarray(0, -10), Buffer.alloc(10, 10)]));
    await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'new' }, marker, authored()), 'verification_failed');
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
});
test('authored descriptor identity is bound before fetching source or mutating and missing authority is unsupported', async () => {
    for (const changed of [{ accountId: 'd'.repeat(24) }, { mailboxId: 'd'.repeat(24) }, { uid: 13 }, { contentDigest: 'bad' }]) {
        const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.verifyAuthoredSource(session, snapshot, { ...authored(), ...changed }), 'verification_failed');
        expect(f.calls).toHaveLength(1);
    }
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'new' }, marker, undefined as unknown as AuthoredSourceDescriptor), 'unsupported_content');
    expect(f.calls).toHaveLength(1);
});
test('malformed reserved marker fails closed and parsed Bcc works without private submission envelope', async () => {
    const malformed = fixture([message({ metaData: { [MAIL_OPERATION_METADATA_KEY]: { malformed: true } } })]);
    await errorCode(malformed.backend.readMessage(session, target), 'verification_failed');
    const empty = fixture([message({ bcc: [{ address: 'hidden@example.com' }] })]);
    expect((await empty.backend.inspectMessage(session, target)).hasRecipients).toBe(true);
    const group = fixture([message({ to: [{ name: 'Friends', group: [{ address: 'a@example.com' }, { address: 'b@example.com' }] }] })]);
    expect((await group.backend.readMessage(session, target)).message.to).toEqual([{ address: 'a@example.com' }, { address: 'b@example.com' }]);
});
test('attachment retrieval returns exact bytes once, preserves unknown metadata sizes and caps decoded bytes', async () => {
    const f = fixture([message({ attachments: [{ id: 'ATT00001', filename: 'x.bin', contentType: 'application/octet-stream', cid: '<cid@example.com>' }] }), new Response(new Uint8Array([0, 1, 255]), { headers: { 'content-type': 'application/octet-stream', 'content-length': '3' } })]);
    const result = await f.backend.readAttachment(session, { ...target, attachmentId: 'ATT00001' });
    expect([...result.bytes]).toEqual([0, 1, 255]); expect(result.metadata.size).toBe(3); expect(result.metadata).not.toHaveProperty('bytes'); expect(result.metadata.resourceUri).toContain(accountId);
    const tooLarge = fixture([message({ attachments: [{ id: 'ATT00001', contentType: 'application/octet-stream', transferEncoding: 'binary', size: 3 * 1024 * 1024 }] })]);
    await errorCode(tooLarge.backend.readAttachment(session, { ...target, attachmentId: 'ATT00001' }), 'too_large'); expect(tooLarge.calls).toHaveLength(1);
});
test('send marker PUT preserves source and metadata then queue response reports actual Sent key', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target); const sendMarker = { ...marker, tool: 'send_draft' as const };
    const stamped = await f.backend.stampSendMarker(session, snapshot, sendMarker, authored()); expect(stamped.version).not.toBe(snapshot.message.version);
    expect(f.current().metaData).toEqual({ untouched: { nested: ['keep'] }, [MAIL_OPERATION_METADATA_KEY]: sendMarker });
    expect(await f.backend.submitDraft(session, stamped)).toEqual({ queueId: 'queue-accepted', sent: { mailboxId: 'd'.repeat(24), uid: 44 } });
    expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
});
test('move uses singular UID mapping, atomically carries marker, compares observed bytes and returns backend digest', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const moved = await f.backend.moveMessage(session, snapshot, 'd'.repeat(24), { ...marker, tool: 'move_message' });
    expect(moved.message).toMatchObject({ mailboxId: 'd'.repeat(24), uid: 42 }); expect(moved.contentDigest).toMatch(/^[a-f0-9]{64}$/u); expect(moved.sourceGrade).toBe('observed');
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'PUT')?.init.body)); expect(Object.keys(body).sort()).toEqual(['metaData', 'moveTo']);
    expect(f.calls.filter(call => call.init.method === 'PUT')).toHaveLength(1);
});
test('flag writes keep IMAP keywords and labels separate, verify actual sets and do not accept reserved draft toggles', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const result = await f.backend.updateMessageFlags(session, snapshot, { ...target, expected_version: snapshot.message.version, operation_id: marker.operationId, seen: true, flagged: true, addFlags: ['\\Answered', 'NewKeyword'], removeFlags: ['KeepKeyword'], addLabels: ['NewLabel'], removeLabels: ['KeepLabel'] }, { ...marker, tool: 'update_message_flags' });
    expect(result.contentDigest).toHaveLength(64); expect(result.sourceGrade).toBe('observed'); expect(f.current().flags).toEqual(['\\Draft', '\\Answered', 'NewKeyword', '\\Seen', '\\Flagged']); expect(f.current().labels).toEqual(['NewLabel']);
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'PUT')?.init.body)); expect(body.addFlags).toEqual(['\\Answered', 'NewKeyword']); expect(body.addLabels).toEqual(['NewLabel']); expect(body).not.toHaveProperty('draft'); expect(body).not.toHaveProperty('deleted');
    const bad = model(); const original = await bad.backend.inspectMessage(session, target);
    await errorCode(bad.backend.updateMessageFlags(session, original, { ...target, expected_version: original.message.version, operation_id: marker.operationId, addFlags: ['\\Draft'] }, marker), 'invalid_input'); expect(bad.calls.some(call => call.init.method === 'PUT')).toBe(false);
});
test('source rejects missing or inconsistent lengths before any upload without a new header contract', async () => {
    for (const length of [undefined, String(originalSource.length + 1)]) {
        const f = fixture([message(), new Response(new Uint8Array(originalSource), { headers: { 'content-type': 'message/rfc822', ...(length === undefined ? {} : { 'content-length': length }) } })]);
        const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.verifyAuthoredSource(session, snapshot, authored()), length === undefined ? 'source_integrity_unavailable' : 'temporarily_unavailable');
        expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    }
});
test('zero-byte attachment hash binds preserved opaque MIME bytes through raw update', async () => {
    const header = originalSource.subarray(0, originalSource.indexOf('Content-Type:'));
    const source = Buffer.concat([header, Buffer.from('Content-Type: multipart/mixed; boundary="z"\r\n\r\n--z\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody\r\n--z\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="zero.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n--z--\r\n')]);
    const f = model(); f.setSource(source); f.patch({ attachments: [{ id: 'ATT00001', filename: 'zero.bin', contentType: 'application/octet-stream', size: 0, hash: createHash('sha256').update('').digest('hex') }] });
    const snapshot = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, snapshot, { subject: 'changed' }, { ...marker, tool: 'update_draft' }, authored(source));
    expect(prepared.mime.retainedAttachments).toHaveLength(1); expect(prepared.mime.raw.toString()).toContain('filename="zero.bin"');
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
});
test('draft updates refuse provenance or expiry fields the raw upload API cannot preserve', async () => {
    for (const update of [{ envelope: { from: 'smtp@example.com', rcpt: [{ value: 'received@example.com' }] } }, { expires: '2026-12-01T00:00:00Z' }, { verificationResults: { spf: 'pass' } }, { outbound: [{ queueId: 'existing' }] }, { forwardTargets: ['prior-target'] }]) {
        const f = model(); f.patch(update); const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'new' }, { ...marker, tool: 'update_draft' }, authored()), 'unsupported_content');
        expect(f.calls.some(call => call.init.method !== 'GET')).toBe(false);
    }
});
test('provider text and HTML ceilings are reported conservatively even without local truncation', async () => {
    for (const length of [102399, 102400]) {
        const f = fixture([message({ text: 'x'.repeat(length) })]);
        const result = (await f.backend.readMessage(session, target)).message;
        expect(result.text).toHaveLength(length); expect(result.textTruncated).toBe(length === 102400);
    }
    const result = (await fixture([message({ html: ['x'.repeat(655360)] })]).backend.readMessage(session, target)).message;
    expect(result.htmlTruncated).toBe(true); expect(result.htmlRepresentation).toBe('wildduck_normalized');
});
test('moves and flag changes carry authored grade only with a matching trusted descriptor', async () => {
    for (const useMove of [true, false]) {
        for (const trusted of [undefined, authored()]) {
            const f = model(); f.patch({ metaData: { [MAIL_OPERATION_METADATA_KEY]: marker } }); const snapshot = await f.backend.inspectMessage(session, target);
            const result = useMove
                ? await f.backend.moveMessage(session, snapshot, 'd'.repeat(24), { ...marker, tool: 'move_message' }, trusted)
                : await f.backend.updateMessageFlags(session, snapshot, { ...target, expected_version: snapshot.message.version, operation_id: marker.operationId, seen: true }, { ...marker, tool: 'update_message_flags' }, trusted);
            expect(result.sourceGrade).toBe(trusted ? 'mcp_authored' : 'observed');
            expect(result.contentDigest).toBe(authored().contentDigest);
        }
    }
});
test('sender requires exact primary or registered alias and never trusts whitelist or wildcard fallback', async () => {
    for (const aliases of [[], ['*@example.com'], ['someone@example.com']]) {
        const f = model(aliases);
        await errorCode(f.backend.prepareCreate(session, { ...content, from: { address: 'alias@example.com' } }, marker), 'forbidden');
        expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    }
    const f = model(['alias@example.com']); const prepared = await f.backend.prepareCreate(session, { ...content, from: { address: 'alias@example.com' } }, marker);
    await f.backend.uploadPreparedDraft(session, prepared);
    expect(JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body)).from).toEqual({ address: 'alias@example.com' });
    const invalid = fixture([]);
    await errorCode(invalid.backend.prepareCreate(session, { ...content, to: [{ address: 'invalid recipient' }] }, marker), 'invalid_input');
    expect(invalid.calls).toHaveLength(0);
});
const pause = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); };
test('search alone gets the longer internal deadline and preserves query semantics', async () => {
    const logs: SearchDiagnostic[] = []; const urls: string[] = [];
    const backend = createMailBackend({ timeoutMs: 5, searchTimeoutMs: 60, onSearchDiagnostic: value => { logs.push(value); }, fetch: (async url => { urls.push(String(url)); await pause(15); return Response.json({ success: true, results: [] }); }) as typeof fetch });
    expect(await backend.searchMessages(session, { from: 'synthetic@example.test', receivedSince: '2026-10-20T00:00:00Z', limit: 10 })).toEqual({ messages: [] });
    expect(Object.fromEntries(new URL(urls[0] ?? '').searchParams)).toEqual({ order: 'desc', limit: '10', metaData: 'true', from: 'synthetic@example.test', datestart: '2026-10-20T00:00:00Z' });
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ event: 'wildduck_search', outcome: 'success', scope: 'global', timeoutMs: 60, status: 200 });
    expect(logs[0]?.headersMs).toBeGreaterThanOrEqual(10); expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(logs[0]?.headersMs ?? 0); expect(logs[0]).not.toHaveProperty('category');
    await errorCode(backend.submitDraft(session, target), 'upstream_timeout'); expect(urls).toHaveLength(2);
});
test('default search budget is 45 seconds, override fallback remains compatible and live request remainder clamps it', async () => {
    for (const [options, expected] of [[{}, 45000], [{ timeoutMs: 17 }, 17], [{ searchTimeoutMs: 120000 }, 120000]] as const) {
        const logs: SearchDiagnostic[] = []; const backend = createMailBackend({ ...options, onSearchDiagnostic: value => { logs.push(value); }, fetch: (async _url => Response.json({ success: true, results: [] })) as typeof fetch });
        await backend.searchMessages(session, { subject: 'synthetic', limit: 1 }); expect(logs[0]?.timeoutMs).toBe(expected);
    }
    const logs: SearchDiagnostic[] = []; let calls = 0; let remaining = 60000;
    const backend = createMailBackend({ onSearchDiagnostic: value => { logs.push(value); }, fetch: (async _url => { calls++; return Response.json({ success: true, results: [] }); }) as typeof fetch });
    await withRequestBudget(() => remaining, async () => { remaining = 2007; await backend.searchMessages(session, { mailboxId, subject: 'synthetic', limit: 1 }); });
    expect(logs[0]).toMatchObject({ timeoutMs: 7, scope: 'mailbox', outcome: 'success' });
    for (const exhausted of [2000, 0]) {
        await withRequestBudget(() => exhausted, async () => { await errorCode(backend.searchMessages(session, { subject: 'synthetic', limit: 1 }), 'upstream_timeout'); });
    }
    expect(calls).toBe(1); expect(logs).toHaveLength(3); expect(logs[1]).toMatchObject({ category: 'deadline', timeoutMs: 0 });
    for (const bad of [0, 120001, NaN]) { expect(() => createMailBackend({ searchTimeoutMs: bad })).toThrow(MailError); }
});
test('one sanitized diagnostic distinguishes deadline, network, HTTP, JSON, shape and response cap failures', async () => {
    const cases: Array<{ category: string; code: MailFailureCode; fetcher: typeof fetch }> = [
        { category: 'deadline', code: 'upstream_timeout', fetcher: (async (_url, init) => await new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error(`hostile ${token}`)); }); })) as typeof fetch },
        { category: 'network', code: 'temporarily_unavailable', fetcher: (async (_url): Promise<Response> => { throw Object.assign(new Error(`hostile ${token}`), { url: `private-${accountId}`, query: 'private-query' }); }) as typeof fetch },
        { category: 'http_status', code: 'temporarily_unavailable', fetcher: (async _url => new Response(`private ${token}`, { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch },
        { category: 'invalid_json', code: 'temporarily_unavailable', fetcher: (async _url => new Response(`{private ${token}`, { headers: { 'content-type': 'application/json' } })) as typeof fetch },
        { category: 'invalid_shape', code: 'temporarily_unavailable', fetcher: (async _url => Response.json({ success: true, results: [message({ flagged: undefined })] })) as typeof fetch },
        { category: 'too_large', code: 'too_large', fetcher: (async _url => Response.json({ success: true, results: [], private: token, extra: 'x'.repeat(512 * 1024) })) as typeof fetch },
    ];
    for (const value of cases) {
        const logs: SearchDiagnostic[] = []; const backend = createMailBackend({ timeoutMs: 5, fetch: value.fetcher, onSearchDiagnostic: diagnostic => { logs.push(diagnostic); } });
        await errorCode(backend.searchMessages(session, { from: 'private-query', limit: 1 }), value.code);
        expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ event: 'wildduck_search', outcome: 'failure', scope: 'global', category: value.category });
        const serialized = JSON.stringify(logs); for (const secret of [token, accountId, mailboxId, 'private-query', 'hostile']) { expect(serialized).not.toContain(secret); }
        expect(Object.keys(logs[0] ?? {}).every(key => ['event', 'outcome', 'scope', 'category', 'durationMs', 'headersMs', 'bodyMs', 'validationMs', 'status', 'timeoutMs'].includes(key))).toBe(true);
    }
});
test('body and validation timings are retained and throwing logger or late fetch cannot change results or log twice', async () => {
    const logs: SearchDiagnostic[] = [];
    const backend = createMailBackend({ timeoutMs: 100, onSearchDiagnostic: value => { logs.push(value); throw new Error('logger failure'); }, fetch: (async _url => new Response(new ReadableStream({ async start(controller) { await pause(8); controller.enqueue(new TextEncoder().encode('{"success":true,"results":[]}')); controller.close(); } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
    expect(await backend.searchMessages(session, { subject: 'synthetic', limit: 1 })).toEqual({ messages: [] });
    expect(logs[0]?.bodyMs).toBeGreaterThanOrEqual(5); expect(logs[0]?.validationMs).toBeGreaterThanOrEqual(0);
    const late: SearchDiagnostic[] = [];
    const slow = createMailBackend({ timeoutMs: 5, onSearchDiagnostic: value => { late.push(value); }, fetch: (async _url => { await pause(20); return Response.json({ success: true, results: [] }); }) as typeof fetch });
    await errorCode(slow.searchMessages(session, { subject: 'synthetic', limit: 1 }), 'upstream_timeout');
    const first = JSON.stringify(late); await pause(30); expect(late).toHaveLength(1); expect(JSON.stringify(late)).toBe(first);
});

test('search false predicates never become silently ignored broad queries', async () => {
    for (const predicate of [{ flagged: false }, { hasAttachments: false }]) {
        const f = fixture([]); await errorCode(f.backend.searchMessages(session, { ...predicate, limit: 20 }), 'invalid_input'); expect(f.calls).toHaveLength(0);
    }
    for (const seen of [true, false]) {
        const f = fixture([{ success: true, results: [] }]); await f.backend.searchMessages(session, { seen, limit: 20 });
        const query = new URL((f.calls[0]?.url ?? '')).searchParams; expect(query.get(seen ? 'seen' : 'unseen')).toBe('true'); expect(query.has(seen ? 'unseen' : 'seen')).toBe(false);
    }
});
test('thread pages search the entire account including Sent, preserve identities and cursors, and reject a dropped filter', async () => {
    const threadId = 'e'.repeat(24); const sent = 'f'.repeat(24);
    const f = fixture([message({ thread: threadId }), { success: true, results: [message({ thread: threadId, attachments: false }), message({ thread: threadId, mailbox: sent, id: 12, attachments: false })], nextCursor: 'next-thread' }]);
    const page = await f.backend.getThread(session, { message: target, limit: 2, includeBodies: false });
    expect(page.threadId).toBe(threadId); expect(page.messages.map(item => [item.mailboxId, item.uid])).toEqual([[mailboxId, 12], [sent, 12]]); expect(page.next).toBe('next-thread');
    const query = new URL((f.calls[1]?.url ?? '')).searchParams; expect(query.get('thread')).toBe(threadId); expect(query.has('mailbox')).toBe(false); expect(query.get('order')).toBe('asc');
    const mismatch = fixture([{ success: true, results: [message({ thread: 'a'.repeat(24), attachments: false })] }]);
    await errorCode(mismatch.backend.getThread(session, { threadId, limit: 20, previous: 'back', includeBodies: false }), 'verification_failed');
    expect(new URL((mismatch.calls[0]?.url ?? '')).searchParams.get('previous')).toBe('back');
});
test('message previews preserve explicit missing data and bound multibyte snippets', async () => {
    const f = fixture([{ success: true, results: [message({ intro: 'é'.repeat(400), thread: 'e'.repeat(24), attachments: false })] }, message()]);
    const listed = (await f.backend.listMessages(session, { mailboxId, limit: 20 })).messages[0]; if (!listed) { throw new Error('missing result'); }
    expect(Buffer.byteLength(listed.snippet ?? '')).toBe(512); expect(listed.threadId).toBe('e'.repeat(24));
    const read = (await f.backend.readMessage(session, target)).message; expect(read.threadId).toBeNull(); expect(read.snippet).toBe(read.text.replace(/\s+/gu, ' ').trim());
});
test('only bounded valid Retry-After seconds are retained from unavailable responses', async () => {
    for (const [value, expected] of [['30', 30], ['0', 0], ['-1', undefined], ['1.5', undefined], ['90000', undefined], ['private token', undefined]] as const) {
        const f = fixture([Response.json({ code: 'RateLimited', error: 'private' }, { status: 429, headers: { 'Retry-After': value } })]);
        try { await f.backend.readMessage(session, target); throw new Error('expected failure'); } catch (error) { expect(error).toBeInstanceOf(MailError); expect((error as MailError).retryAfter).toBe(expected); }
    }
});

test('reply preparation derives recipients and MIME threading without changing the original', async () => {
    const f = model(['alias@example.com']); f.patch({ from: [{ address: 'author@example.com' }], replyTo: [{ address: 'help@example.com' }], to: [{ address: 'sender@example.com' }, { address: 'alias@example.com' }, { address: 'visible@example.com' }], cc: [{ address: 'copy@example.com' }], bcc: [{ address: 'blind@example.com' }], text: 'Original <text>', references: ['<ancestor@example.com>'] });
    const prepared = await f.backend.prepareReply?.(session, { original: target, mode: 'reply_all', body: { text: 'Response', html: '<p>Response</p>' }, quoteOriginal: true, attachments: [], operation_id: marker.operationId }, { ...marker, tool: 'create_reply_draft' });
    expect(prepared?.mime.envelope.to.map(item => item.address)).toEqual(['help@example.com', 'visible@example.com']); expect(prepared?.mime.envelope.cc.map(item => item.address)).toEqual(['copy@example.com']); expect(prepared?.mime.envelope.bcc).toEqual([]);
    const mime = prepared?.mime.raw.toString() ?? ''; expect(mime).toContain('In-Reply-To: <test@example.com>'); expect(mime).toContain('References: <ancestor@example.com> <test@example.com>'); expect(mime).not.toContain('blind@example.com'); expect(mime).not.toContain('Bcc:'); expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    const invalid = model(); invalid.patch({ messageId: null }); await errorCode(invalid.backend.prepareReply?.(session, { original: target, mode: 'reply', body: { text: 'Response', html: null }, quoteOriginal: false, attachments: [], operation_id: marker.operationId }, { ...marker, tool: 'create_reply_draft' }) ?? Promise.resolve(), 'unsupported_content'); expect(invalid.calls.every(call => call.init.method === 'GET')).toBe(true);
});
test('staged download streams only the validated attachment and returns binary-free bounded metadata', async () => {
    const calls: { url: string; init: RequestInit }[] = []; let staged = 0; let bytes = 0;
    const backend = createMailBackend({ fetch: (async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return calls.length === 1 ? Response.json(message({ attachments: [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', filename: 'file.bin', contentType: 'application/octet-stream', size: 3 }] })) : new Response(new Uint8Array([0,1,255]), { headers: { 'content-length': '3' } }); }) as typeof fetch, downloadStager: { stage: async source => { staged++; const opened = await source.open(new AbortController().signal); expect(opened.expectedSize).toBe(3); const reader = opened.body.getReader(); while (true) { const part = await reader.read(); if (part.done) { break; } bytes += part.value.byteLength; } return { url: 'https://bucket.s3.amazonaws.com/downloads/opaque?signature=temporary', size: bytes, expiresAt: '2026-10-26T10:00:00.000Z' }; } } });
    const result = await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }); expect(staged).toBe(1); expect(bytes).toBe(3); expect(result.size).toBe(3); expect(result.attachmentId).toBe('ATT1'); expect(result).not.toHaveProperty('blob'); expect(result).not.toHaveProperty('bytes'); expect(calls).toHaveLength(2); expect(calls[0]?.url).toEndWith('?markAsSeen=false&replaceCidLinks=false'); expect(calls[1]?.url).toEndWith('/attachments/ATT1'); expect(calls.every(call => call.init.method === 'GET' && new Headers(call.init.headers).get('X-Access-Token') === token)).toBe(true);
});
test('staged download rejects absent or oversized metadata before fetching bytes and fails closed on mismatch', async () => {
    for (const attachments of [[], [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', contentType: 'text/plain', size: 20 * 1024 * 1024 + 1 }]]) {
        let calls = 0; const backend = createMailBackend({ fetch: (async (_url: string | URL | Request) => { calls++; return Response.json(message({ attachments })); }) as typeof fetch, downloadStager: { stage: async () => { throw new Error('must not stage'); } } });
        await errorCode(backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }), attachments.length ? 'too_large' : 'not_found'); expect(calls).toBe(1);
    }
    let calls = 0; const backend = createMailBackend({ fetch: (async (_url: string | URL | Request) => ++calls === 1 ? Response.json(message({ attachments: [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', contentType: 'text/plain', size: 3 }] })) : new Response('abc', { headers: { 'content-length': '3' } })) as typeof fetch, downloadStager: { stage: async source => { const opened = await source.open(new AbortController().signal); await opened.body.cancel(); return { url: 'https://bucket.s3.amazonaws.com/file', size: 2, expiresAt: '2026-10-26T10:00:00.000Z' }; } } });
    await errorCode(backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }), 'verification_failed');
});

test('conflicting exact attachment lengths fail before staging and cancel the body', async () => {
    let calls = 0; let stages = 0; let cancelled = false;
    const backend = createMailBackend({ fetch: (async (_url: string | URL | Request) => ++calls === 1 ? Response.json(message({ attachments: [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', contentType: 'text/plain', size: 3 }] })) : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '4' } })) as typeof fetch, downloadStager: { stage: async source => { stages++; await source.open(new AbortController().signal); throw new Error('must not complete staging'); } } });
    await errorCode(backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }), 'verification_failed'); expect(stages).toBe(1); expect(cancelled).toBe(true);
});

test('cached attachment links revalidate message access and reuse identity across flag changes without fetching bytes again', async () => {
    const identities: string[] = []; let metadataReads = 0; let byteReads = 0; let stages = 0; let removed = false;
    const cached = new Map<string, number>();
    const backend = createMailBackend({ fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/attachments/ATT1')) { byteReads++; return new Response('abc', { headers: { 'content-length': '3' } }); }
        metadataReads++; if (removed) { return Response.json({ error: 'Gone' }, { status: 404 }); }
        return Response.json(message({ seen: metadataReads > 1, flags: metadataReads > 1 ? ['\\Seen'] : [], attachments: [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', contentType: 'text/plain', filename: 'same.txt', size: 3 }] }));
    }) as typeof fetch, downloadStager: { stage: async source => {
        stages++; identities.push(source.cacheIdentity); let size = cached.get(source.cacheIdentity);
        if (size === undefined) { const opened = await source.open(new AbortController().signal); const bytes = await new Response(opened.body).arrayBuffer(); size = bytes.byteLength; cached.set(source.cacheIdentity, size); }
        return { url: 'https://bucket.s3.amazonaws.com/downloads/' + source.cacheIdentity + '?signature=' + stages, size, expiresAt: new Date(Date.now() + 300000).toISOString() };
    } } });
    const first = await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' });
    const renewed = await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' });
    expect(metadataReads).toBe(2); expect(byteReads).toBe(1); expect(identities[0]).toBe(identities[1]); expect(identities[0]).toMatch(/^[a-f0-9]{64}$/u); expect(first.url).not.toBe(renewed.url); expect(first.size).toBe(renewed.size);
    removed = true; await errorCode(backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }), 'not_found'); expect(stages).toBe(2); expect(byteReads).toBe(1);
});
test('cached attachment identity is account and message scoped and changes with immutable attachment hash', async () => {
    const identities: string[] = []; let hash = 'e'.repeat(64);
    const backend = createMailBackend({ fetch: (async (url: string | URL | Request) => {
        const parts = new URL(String(url)).pathname.split('/');
        return Response.json(message({ user: parts[2], mailbox: parts[4], id: Number(parts[6]), attachments: [{ id: 'ATT1', hash, transferEncoding: 'binary', contentType: 'text/plain', size: 3 }] }));
    }) as typeof fetch, downloadStager: { stage: async source => { identities.push(source.cacheIdentity); return { url: 'https://bucket.s3.amazonaws.com/file', size: 3, expiresAt: new Date(Date.now() + 300000).toISOString() }; } } });
    await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' });
    await backend.getAttachmentDownload({ ...session, accountId: 'f'.repeat(24) }, { ...target, attachmentId: 'ATT1' });
    await backend.getAttachmentDownload(session, { mailboxId: 'd'.repeat(24), uid: target.uid, attachmentId: 'ATT1' });
    await backend.getAttachmentDownload(session, { ...target, uid: target.uid + 1, attachmentId: 'ATT1' });
    hash = 'f'.repeat(64); await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' });
    expect(new Set(identities).size).toBe(5); expect(identities.every(identity => /^[a-f0-9]{64}$/u.test(identity))).toBe(true);
});
test('missing or invalid immutable hashes fail before cache lookup or upstream byte download', async () => {
    for (const hash of [undefined, null, '', 'x'.repeat(64), 'e'.repeat(63), 'E'.repeat(64)]) {
        let requests = 0; let stages = 0;
        const backend = createMailBackend({ fetch: (async (_url: string | URL | Request) => { requests++; return Response.json(message({ attachments: [{ id: 'ATT1', hash, contentType: 'text/plain', size: 3 }] })); }) as typeof fetch, downloadStager: { stage: async () => { stages++; throw new Error('must not stage'); } } });
        await errorCode(backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }), 'unsupported_content'); expect(requests).toBe(1); expect(stages).toBe(0);
    }
});

test('lazy cache miss fetch preserves sanitized attachment status errors and supplied retry hints', async () => {
    for (const [status, code, expected] of [[403, 'InvalidToken', 'reconnect_required'], [403, 'AccessDenied', 'forbidden'], [404, 'MessageNotFound', 'not_found'], [429, 'RateLimited', 'temporarily_unavailable']] as const) {
        let requests = 0;
        const backend = createMailBackend({ fetch: (async (_url: string | URL | Request) => ++requests === 1 ? Response.json(message({ attachments: [{ id: 'ATT1', hash: 'e'.repeat(64), transferEncoding: 'binary', contentType: 'text/plain', size: 3 }] })) : Response.json({ code, error: 'private upstream response' }, { status, headers: { 'Retry-After': '20' } })) as typeof fetch, downloadStager: { stage: async source => { await source.open(new AbortController().signal); throw new Error('must not complete'); } } });
        try { await backend.getAttachmentDownload(session, { ...target, attachmentId: 'ATT1' }); throw new Error('Expected failure'); } catch (error) {
            expect(error).toBeInstanceOf(MailError); expect((error as MailError).code).toBe(expected); expect((error as MailError).retryAfter).toBe(status === 429 ? 20 : undefined); expect(JSON.stringify(error)).not.toContain('private');
        }
        expect(requests).toBe(2);
    }
});

test('attachment sizes describe decoded bytes honestly for encoded, identity and unknown transfer encodings', async () => {
    const cases = [
        { raw: { size: 828924, sizeKb: 592, transferEncoding: 'base64' }, size: 606208, approximate: true },
        { raw: { size: 828924, transferEncoding: 'base64' }, size: 828924, approximate: true },
        { raw: { size: 24, sizeKb: 1, transferEncoding: 'quoted-printable' }, size: 1024, approximate: true },
        { raw: { size: 4, sizeKb: 1, transferEncoding: '7bit' }, size: 4, approximate: false },
        { raw: { size: 4, transferEncoding: '8bit' }, size: 4, approximate: false },
        { raw: { size: 4, transferEncoding: 'binary' }, size: 4, approximate: false },
        { raw: { size: 4, transferEncoding: ' BASE64 ' }, size: 4, approximate: true },
        { raw: { size: 4, transferEncoding: 'unknown' }, size: 4, approximate: true },
        { raw: { size: 4 }, size: 4, approximate: true },
        { raw: { size: 4, transferEncoding: null }, size: 4, approximate: true },
        { raw: { size: 4, transferEncoding: 7 }, size: 4, approximate: true },
        { raw: { sizeKb: 1, transferEncoding: 'binary' }, size: 1024, approximate: true },
    ];
    for (const value of cases) {
        const f = fixture([message({ attachments: [{ id: 'ATT1', contentType: 'application/octet-stream', ...value.raw }] })]);
        const metadata = (await f.backend.readMessage(session, target)).message.attachments[0];
        expect(metadata?.size).toBe(value.size); expect(metadata?.sizeIsApproximate).toBe(value.approximate);
    }
});
test('inline attachment decoded cap does not reject an oversized transfer-encoded metadata size', async () => {
    const decoded = Buffer.alloc(1600 * 1024, 13);
    const f = fixture([message({ attachments: [{ id: 'ATT1', contentType: 'application/octet-stream', transferEncoding: 'base64', size: 2242010, sizeKb: 1600 }] }), new Response(decoded, { headers: { 'content-length': String(decoded.byteLength) } })]);
    const result = await f.backend.readAttachment(session, { ...target, attachmentId: 'ATT1' }); expect(result.bytes).toEqual(decoded); expect(result.metadata.size).toBe(decoded.byteLength); expect(f.calls).toHaveLength(2);
});
