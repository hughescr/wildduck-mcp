import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createMailBackend } from '../src/mail/backend';
import { MailError, MAIL_OPERATION_METADATA_KEY, type BackendMailSession, type DraftContent, type MailFailureCode, type MailOperationMarker } from '../src/mail/contracts';
import { mailOutputSchemas, MAX_READ_TEXT_BYTES } from '../src/mail/schemas';
import { WILDDUCK_ORIGIN } from '../src/wildduck';
const accountId = 'a'.repeat(24); const mailboxId = 'b'.repeat(24); const token = 'c'.repeat(40);
const session: BackendMailSession = { accountId, accessToken: token }; const target = { mailboxId, uid: 12 };
const content: DraftContent = { to: [], cc: [], bcc: [{ address: 'bcc@example.com' }], subject: 'A draft', body: { text: 'Body', html: null }, attachments: [] };
const marker: MailOperationMarker = { accountId, clientIdHash: 'x'.repeat(43), payloadDigest: 'y'.repeat(43), operationId: 'operation-1234567', tool: 'create_draft' };
function message(extra: Record<string, unknown> = {}) {
    return { success: true, user: accountId, id: 12, mailbox: mailboxId, subject: '', from: { address: 'invalid MIME address', name: 'Sender' }, to: [], cc: [], bcc: [], replyTo: [],
        date: '2026-10-26T00:00:00.000Z', idate: '2026-10-26T01:00:00.000Z', seen: false, flagged: false, draft: true, answered: false, deleted: false, forwarded: false, labels: [] as string[], metaData: {}, submissionEnvelope: { from: 'sender@example.com', to: [] },
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
function model() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let source: Buffer = originalSource;
    let raw = message({ from: { address: 'sender@example.com', name: 'Sender' }, to: [{ address: 'visible@example.com' }], bcc: [{ address: 'hidden@example.com' }], replyTo: [{ address: 'help@example.com' }], subject: 'Original',
        submissionEnvelope: { from: 'sender@example.com', to: ['visible@example.com', 'hidden@example.com', 'envelope-only@example.com'] }, metaData: { untouched: { nested: ['keep'] } }, labels: ['KeepLabel'], flags: ['\\Draft', 'KeepKeyword'] });
    let capability = true;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(String(url)); calls.push({ url: String(url), init: init ?? {} });
        expect(parsed.origin).toBe(WILDDUCK_ORIGIN); expect(new Headers(init?.headers).get('X-Access-Token')).toBe(token); expect(init?.redirect).toBe('error');
        const prefix = `/users/${accountId}`; const path = parsed.pathname.slice(prefix.length);
        expect(parsed.pathname.startsWith(prefix)).toBe(true);
        if (path === '') { return Response.json({ success: true, id: accountId, address: 'sender@example.com', name: 'Sender', fromWhitelist: ['alias@example.com'] }); }
        if (path === '/mailboxes') { return Response.json({ success: true, results: [{ id: mailboxId, path: 'Server-specific Drafts', specialUse: '\\Drafts' }] }); }
        if (path === `/mailboxes/${'d'.repeat(24)}`) { return Response.json({ success: true, id: 'd'.repeat(24), path: 'Destination' }); }
        if (init?.method === 'POST' && path.endsWith('/submit')) { return Response.json({ success: true, queueId: 'queue-accepted', message: { id: 44, mailbox: 'd'.repeat(24) } }); }
        if (init?.method === 'POST' && path === `/mailboxes/${mailboxId}/messages`) {
            const body = JSON.parse(String(init.body)); source = Buffer.from(body.raw, 'base64');
            raw = message({ ...raw, id: 13, idate: body.date, metaData: body.metaData, flags: body.flags, labels: body.labels, seen: !body.unseen, flagged: body.flagged,
                submissionEnvelope: { from: body.from.address, to: body.to.map((item: { address: string }) => item.address) }, ...(body.reference ? { reference: { mailbox: body.reference.mailbox, id: body.reference.id, action: body.reference.action } } : {}) });
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
            expect(parsed.search).toBe('?strict=true');
            return new Response(new Uint8Array(source), { headers: { 'content-type': 'message/rfc822', 'content-length': String(source.length), ...(capability ? { 'X-Wildduck-Source-Integrity': 'strict' } : {}) } });
        }
        if (path.includes('/messages/')) { expect(parsed.search).toBe('?markAsSeen=false&replaceCidLinks=false'); return Response.json(raw); }
        throw new Error('Unexpected fake path');
    }) as typeof fetch;
    return { backend: createMailBackend({ fetch: fetcher }), calls, patch: (update: Record<string, unknown>) => { raw = message({ ...raw, ...update }); }, setSource: (value: Buffer) => { source = value; }, noCapability: () => { capability = false; }, current: () => raw };
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
test('search maps structured filters with preserved false booleans, dates and previous cursor', async () => {
    const f = fixture([{ success: true, results: [], nextCursor: false, previousCursor: 'back' }]);
    expect(await f.backend.searchMessages(session, { mailboxId, limit: 3, from: 'a+b@example.com', to: 'person', subject: 'A & B', text: 'words', receivedSince: '2026-10-01T00:00:00Z', receivedUntil: '2026-10-26T00:00:00Z', seen: false, flagged: false, hasAttachments: false, previous: 'cursor+/=' })).toEqual({ messages: [], previous: 'back' });
    const url = new URL(f.calls[0]?.url ?? ''); expect(url.pathname).toBe(`/users/${accountId}/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ order: 'desc', limit: '3', metaData: 'true', mailbox: mailboxId, from: 'a+b@example.com', to: 'person', subject: 'A & B', query: 'words', datestart: '2026-10-01T00:00:00Z', dateend: '2026-10-26T00:00:00Z', seen: 'false', flagged: 'false', attachments: 'false', previous: 'cursor+/=' });
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
    const f = fixture([message({ text: '🦊'.repeat(MAX_READ_TEXT_BYTES / 4 + 1), attachments: [{ id: 'ATT00001', filename: 'photo.png', contentType: 'image/png', size: 4, related: true }], date: 'invalid', idate: '2026-10-26T02:00:00Z' })]);
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
    const bcc = await fixture([message({ bcc: [], submissionEnvelope: { from: 'sender@example.com', to: ['bcc@example.com'] } })]).backend.inspectMessage(session, target); expect(bcc.hasRecipients).toBe(true);
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
    for (const change of ['source', 'envelope', 'metadata'] as const) {
        const f = model(); const prepared = await f.backend.prepareCreate(session, content, marker); const candidate = await f.backend.uploadPreparedDraft(session, prepared);
        if (change === 'source') { f.setSource(Buffer.from('changed')); } else { f.patch(change === 'envelope' ? { submissionEnvelope: { from: 'sender@example.com', to: ['other@example.com'] } } : { metaData: {} }); }
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
    await errorCode(slow.submitDraft(session, target), 'temporarily_unavailable'); expect(count).toBe(1); expect(aborted?.aborted).toBe(true);
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } }); const f = fixture([new Response(stream, { headers: { 'content-type': 'application/json' } })], 5);
    await errorCode(f.backend.readMessage(session, target), 'temporarily_unavailable'); expect(cancelled).toBe(true); expect(f.calls).toHaveLength(1);
});
test('rich update preserves original MIME, aliases, hidden envelope-only recipients, flags, labels and received date', async () => {
    const f = model(); const before = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, before, { subject: 'Changed subject' }, { ...marker, tool: 'update_draft' });
    const body = originalSource.subarray(originalSource.indexOf('\r\n\r\n') + 4);
    expect(prepared.mime.raw.subarray(prepared.mime.raw.indexOf('\r\n\r\n') + 4).equals(body)).toBe(true);
    for (const text of ['Bcc: hidden@example.com', 'Reply-To: help@example.com', 'References: <prior@example.com>', 'X-Custom: preserve me']) { expect(prepared.mime.raw.toString()).toContain(text); }
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
    const call = f.calls.find(item => item.init.method === 'POST'); const upload = JSON.parse(String(call?.init.body));
    expect(upload.to.map((item: { address: string }) => item.address)).toEqual(['visible@example.com', 'hidden@example.com', 'envelope-only@example.com']);
    expect(upload.flags).toEqual(['\\Draft', 'KeepKeyword']); expect(upload.labels).toEqual(['KeepLabel']); expect(upload.date).toBe('2026-10-26T01:00:00.000Z'); expect(upload.metaData.untouched).toEqual({ nested: ['keep'] });
    expect(upload).not.toHaveProperty('replacePrevious');
});
test('recipient patch changes only requested address class when all recipients are attributable', async () => {
    const f = model(); f.patch({ submissionEnvelope: { from: 'sender@example.com', to: ['visible@example.com', 'hidden@example.com'] } }); const before = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, before, { to: [{ address: 'new@example.com' }] }, { ...marker, tool: 'update_draft' });
    await f.backend.uploadPreparedDraft(session, prepared);
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body));
    expect(body.to.map((item: { address: string }) => item.address)).toEqual(['hidden@example.com', 'new@example.com']);
    expect(prepared.mime.raw.toString()).toContain('To: new@example.com'); expect(prepared.mime.raw.toString()).toContain('Bcc: hidden@example.com');
});
test('explicit recipient clearing or replacement rejects unattributed hidden recipients but body-only edits preserve them', async () => {
    for (const patch of [{ bcc: [] }, { to: [], cc: [], bcc: [] }, { to: [{ address: 'replacement@example.com' }] }]) {
        const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.prepareUpdate(session, snapshot, patch, { ...marker, tool: 'update_draft' }), 'unsupported_content');
        expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    }
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, snapshot, { body: { text: 'Changed only body', html: null } }, { ...marker, tool: 'update_draft' });
    await f.backend.uploadPreparedDraft(session, prepared);
    expect(JSON.parse(String(f.calls.find(call => call.init.method === 'POST')?.init.body)).to.map((item: { address: string }) => item.address)).toContain('envelope-only@example.com');
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
    await errorCode(f.backend.prepareUpdate(session, snapshot, { deleteAttachmentIds: ['ATT00001'] }, { ...marker, tool: 'update_draft' }), 'unsupported_content');
    expect(f.calls.some(call => call.url.includes('/message.eml'))).toBe(false); expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
});
test('candidate activation rejects observed unsupported expiry, queue, authentication or forwarding state', async () => {
    for (const update of [{ expires: '2026-12-01T00:00:00Z' }, { outbound: [{ queueId: 'already-queued' }] }, { verificationResults: { spf: 'pass' } }, { forwardTargets: ['forwarded'] }]) {
        const f = model(); const prepared = await f.backend.prepareCreate(session, content, marker); const candidate = await f.backend.uploadPreparedDraft(session, prepared); f.patch(update);
        await errorCode(f.backend.verifyPreparedDraft(session, candidate, prepared), 'verification_failed'); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1); expect(f.calls.some(call => call.init.method === 'DELETE')).toBe(false);
    }
});
test('strict source capability and complete byte count are mandatory before update dispatch', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target); f.noCapability();
    await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'new' }, marker), 'source_integrity_unavailable'); expect(f.calls.some(call => call.init.method !== 'GET')).toBe(false);
    const bad = model(); const current = await bad.backend.inspectMessage(session, target); bad.patch({ submissionEnvelope: null });
    const missing = await bad.backend.inspectMessage(session, target);
    await errorCode(bad.backend.prepareUpdate(session, missing, { subject: 'new' }, marker), 'unsupported_content'); expect(current.hasRecipients).toBe(true);
});
test('malformed reserved marker fails closed and empty authoritative envelope does not infer Bcc recipients', async () => {
    const malformed = fixture([message({ metaData: { [MAIL_OPERATION_METADATA_KEY]: { malformed: true } } })]);
    await errorCode(malformed.backend.readMessage(session, target), 'verification_failed');
    const empty = fixture([message({ bcc: [{ address: 'hidden@example.com' }], submissionEnvelope: { from: 'sender@example.com', to: [] } })]);
    expect((await empty.backend.inspectMessage(session, target)).hasRecipients).toBe(false);
    const group = fixture([message({ to: [{ name: 'Friends', group: [{ address: 'a@example.com' }, { address: 'b@example.com' }] }] })]);
    expect((await group.backend.readMessage(session, target)).message.to).toEqual([{ address: 'a@example.com' }, { address: 'b@example.com' }]);
});
test('attachment retrieval returns exact bytes once, preserves unknown metadata sizes and caps decoded bytes', async () => {
    const f = fixture([message({ attachments: [{ id: 'ATT00001', filename: 'x.bin', contentType: 'application/octet-stream', cid: '<cid@example.com>' }] }), new Response(new Uint8Array([0, 1, 255]), { headers: { 'content-type': 'application/octet-stream', 'content-length': '3' } })]);
    const result = await f.backend.readAttachment(session, { ...target, attachmentId: 'ATT00001' });
    expect([...result.bytes]).toEqual([0, 1, 255]); expect(result.metadata.size).toBe(3); expect(result.metadata).not.toHaveProperty('bytes'); expect(result.metadata.resourceUri).toContain(accountId);
    const tooLarge = fixture([message({ attachments: [{ id: 'ATT00001', contentType: 'application/octet-stream', size: 3 * 1024 * 1024 }] })]);
    await errorCode(tooLarge.backend.readAttachment(session, { ...target, attachmentId: 'ATT00001' }), 'too_large'); expect(tooLarge.calls).toHaveLength(1);
});
test('send marker PUT preserves source and metadata then queue response reports actual Sent key', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target); const sendMarker = { ...marker, tool: 'send_draft' as const };
    const stamped = await f.backend.stampSendMarker(session, snapshot, sendMarker); expect(stamped.version).not.toBe(snapshot.message.version);
    expect(f.current().metaData).toEqual({ untouched: { nested: ['keep'] }, [MAIL_OPERATION_METADATA_KEY]: sendMarker });
    expect(await f.backend.submitDraft(session, stamped)).toEqual({ queueId: 'queue-accepted', sent: { mailboxId: 'd'.repeat(24), uid: 44 } });
    expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
});
test('move uses singular UID mapping, atomically carries marker, verifies strict content and returns backend digest', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const moved = await f.backend.moveMessage(session, snapshot, 'd'.repeat(24), { ...marker, tool: 'move_message' });
    expect(moved.message).toMatchObject({ mailboxId: 'd'.repeat(24), uid: 42 }); expect(moved.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'PUT')?.init.body)); expect(Object.keys(body).sort()).toEqual(['metaData', 'moveTo']);
    expect(f.calls.filter(call => call.init.method === 'PUT')).toHaveLength(1);
});
test('flag writes keep IMAP keywords and labels separate, verify actual sets and do not accept reserved draft toggles', async () => {
    const f = model(); const snapshot = await f.backend.inspectMessage(session, target);
    const result = await f.backend.updateMessageFlags(session, snapshot, { ...target, expected_version: snapshot.message.version, operation_id: marker.operationId, seen: true, flagged: true, addFlags: ['\\Answered', 'NewKeyword'], removeFlags: ['KeepKeyword'], addLabels: ['NewLabel'], removeLabels: ['KeepLabel'] }, { ...marker, tool: 'update_message_flags' });
    expect(result.contentDigest).toHaveLength(64); expect(f.current().flags).toEqual(['\\Draft', '\\Answered', 'NewKeyword', '\\Seen', '\\Flagged']); expect(f.current().labels).toEqual(['NewLabel']);
    const body = JSON.parse(String(f.calls.find(call => call.init.method === 'PUT')?.init.body)); expect(body.addFlags).toEqual(['\\Answered', 'NewKeyword']); expect(body.addLabels).toEqual(['NewLabel']); expect(body).not.toHaveProperty('draft'); expect(body).not.toHaveProperty('deleted');
    const bad = model(); const original = await bad.backend.inspectMessage(session, target);
    await errorCode(bad.backend.updateMessageFlags(session, original, { ...target, expected_version: original.message.version, operation_id: marker.operationId, addFlags: ['\\Draft'] }, marker), 'invalid_input'); expect(bad.calls.some(call => call.init.method === 'PUT')).toBe(false);
});
test('strict source rejects missing or inconsistent lengths before any upload', async () => {
    for (const length of [undefined, String(originalSource.length + 1)]) {
        const f = fixture([message(), { success: true, results: [{ id: mailboxId, path: 'Drafts', specialUse: '\\Drafts' }] }, { success: true, id: accountId, address: 'sender@example.com' }, new Response(new Uint8Array(originalSource), { headers: { 'content-type': 'message/rfc822', 'X-Wildduck-Source-Integrity': 'strict', ...(length === undefined ? {} : { 'content-length': length }) } })]);
        const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'changed' }, marker), length === undefined ? 'source_integrity_unavailable' : 'temporarily_unavailable');
        expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
    }
});
test('zero-byte attachment hash binds preserved opaque MIME bytes through raw update', async () => {
    const header = originalSource.subarray(0, originalSource.indexOf('Content-Type:'));
    const source = Buffer.concat([header, Buffer.from('Content-Type: multipart/mixed; boundary="z"\r\n\r\n--z\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody\r\n--z\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="zero.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n--z--\r\n')]);
    const f = model(); f.setSource(source); f.patch({ attachments: [{ id: 'ATT00001', filename: 'zero.bin', contentType: 'application/octet-stream', size: 0, hash: createHash('sha256').update('').digest('hex') }] });
    const snapshot = await f.backend.inspectMessage(session, target);
    const prepared = await f.backend.prepareUpdate(session, snapshot, { subject: 'changed' }, { ...marker, tool: 'update_draft' });
    expect(prepared.mime.retainedAttachments).toHaveLength(1); expect(prepared.mime.raw.toString()).toContain('filename="zero.bin"');
    const key = await f.backend.uploadPreparedDraft(session, prepared); await f.backend.verifyPreparedDraft(session, key, prepared);
});
test('draft updates refuse provenance or expiry fields the raw upload API cannot preserve', async () => {
    for (const update of [{ envelope: { from: 'smtp@example.com', rcpt: [{ value: 'received@example.com' }] } }, { expires: '2026-12-01T00:00:00Z' }, { verificationResults: { spf: 'pass' } }, { outbound: [{ queueId: 'existing' }] }, { forwardTargets: ['prior-target'] }]) {
        const f = model(); f.patch(update); const snapshot = await f.backend.inspectMessage(session, target);
        await errorCode(f.backend.prepareUpdate(session, snapshot, { subject: 'new' }, { ...marker, tool: 'update_draft' }), 'unsupported_content');
        expect(f.calls.some(call => call.init.method !== 'GET')).toBe(false);
    }
});
