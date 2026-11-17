import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import libmime from 'libmime';
import Builder from 'nodemailer/lib/mime-node';
import { encode as qpEncode, wrap as qpWrap } from 'nodemailer/lib/qp';
import { createMime, inspectSource, preparePatch, verifyCandidate, textTransfer, retainedAttachmentBytes, attachmentBodyBytes, base64Bytes, MAX_MESSAGE_BYTES, MIME_LIMITS, MimeError, type MimeCreate } from '../src/mail/mime';
import { draftContentSchema, MAX_INLINE_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES } from '../src/mail/schemas';
import { authoredParts, authoredText, decodeTransfer } from './mime-text';
import { xorshift } from './mime-fields';

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const rootHeaders = 'From: Alias <alias@example.test>\r\nReply-To: Help <help@example.test>\r\nTo: Friends: Alice <alice@example.test>, Bob <bob@example.test>;\r\nCc: Carol <carol@example.test>\r\nBcc: Hidden <hidden@example.test>\r\nSubject: Old\r\nMessage-ID: <original@example.test>\r\nIn-Reply-To: <prior@example.test>\r\nReferences: <first@example.test>\r\n\t<prior@example.test>\r\nDate: Mon, 26 Oct 2026 12:00:00 +0000\r\nX-Custom:  Preserve\r\n\tthis spacing\r\nMIME-Version: 1.0\r\n';
const plain = (text = 'old plain') => `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${text}`;
const html = (text = '<p>old</p><img src="cid:logo@example.test">') => `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}`;
const multi = (subtype: string, boundary: string, parts: readonly (string | Buffer)[], extra = '', preamble = '', tail = '') => Buffer.concat([
    Buffer.from(`Content-Type: multipart/${subtype}; boundary="${boundary}"${extra}\r\n\r\n${preamble}`),
    ...parts.flatMap(part => [Buffer.from(`--${boundary}\r\n`), Buffer.from(part), Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n${tail}`),
]);
const pdfBody = Buffer.from('%PDF-1.7\nopaque bytes\0\xff', 'latin1').toString('base64');
const pdf = (body = pdfBody) => `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="duplicate.pdf"\r\nContent-Transfer-Encoding: base64\r\nX-Part: Keep exactly\r\n\r\n${body}`;
const logo = 'Content-Type: image/png\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo@example.test>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=';
const calendar = 'Content-Type: text/calendar; charset=iso-8859-1; method=REQUEST\r\nContent-Disposition: attachment; filename="meeting.ics"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBEGIN:VCALENDAR\r\nDESCRIPTION:caf=E9\r\nEND:VCALENDAR';
const eml = 'Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forward.eml"\r\nContent-Transfer-Encoding: 8bit\r\n\r\nFrom: embedded@example.test\r\nSubject: embedded\r\nContent-Type: text/plain\r\n\r\nopaque forwarded body';
function rich(extra: readonly (string | Buffer)[] = []): Buffer {
    const alternative = multi('alternative', 'alt-B', [plain(), html()]);
    const related = multi('related', 'related-B', [alternative, logo], '; type="multipart/alternative"', 'related preamble\r\n', 'related tail');
    return Buffer.concat([Buffer.from(rootHeaders), multi('mixed', 'mixed-B', [related, pdf(), calendar, eml, ...extra], '', 'outer preamble\r\n', 'outer tail\r\n')]);
}
const fresh: MimeCreate = { from: { address: 'alias@example.test', name: 'Zoë Sender' }, to: [{ address: 'to@example.test', name: 'Recipient' }], cc: [], bcc: [{ address: 'hidden@example.test' }], subject: 'Résumé', body: { text: 'Hello ✓', html: '<p>Hello ✓</p>' } };
function bodyOf(raw: Buffer): Buffer { return raw.subarray(raw.indexOf('\r\n\r\n') + 4); }
async function rejects(raw: Buffer | string): Promise<void> { await expect(inspectSource(Buffer.from(raw))).rejects.toBeInstanceOf(MimeError); }

describe('MIME lossless supported subset', () => {
    test('new Message-IDs are unique UUIDs at the selected From domain', async () => {
        const ids = new Set<string>();
        for (const domain of ['example.test', 'Aliases.Example.ORG', 'xn--bcher-kva.example']) {
            for (let attempt = 0; attempt < 2; attempt++) {
                const candidate = await createMime({ ...fresh, from: { address: `sender+tag@${domain}`, name: 'Display @ other.invalid' } });
                const id = /^Message-ID: (<[^\r\n]+>)\r$/mu.exec(candidate.raw.toString())?.[1];
                expect(id).toMatch(new RegExp(`^<[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}@${domain.toLowerCase().replaceAll('.', '\\.')}>$`, 'u'));
                expect(ids.has(id ?? '')).toBe(false); ids.add(id ?? '');
                expect(candidate.raw.toString()).not.toContain('@mcp.invalid');
            }
        }
    });
    test('changing sender and body preserves the original Message-ID, including historical domains', async () => {
        for (const original of ['<original@example.test>', '<historical@mcp.invalid>']) {
            const raw = Buffer.from(rootHeaders.replace('<original@example.test>', original) + plain());
            const candidate = await preparePatch(await inspectSource(raw), { from: { address: 'changed@other.example' }, body: { text: 'Changed', html: null } });
            expect(candidate.raw.toString()).toContain(`Message-ID: ${original}\r\n`);
            expect(candidate.envelope.from[0]?.address).toBe('changed@other.example');
        }
    });
    test('header-only patch preserves entire body, root folding, groups, aliases and thread identity', async () => {
        const raw = rich(); const inspected = await inspectSource(raw);
        expect(inspected.attachments).toHaveLength(4);
        expect(inspected.envelope.to.map(item => item.address)).toEqual(['alice@example.test', 'bob@example.test']);
        const prepared = await preparePatch(inspected, { subject: 'New ü subject' });
        expect(bodyOf(prepared.raw).equals(bodyOf(raw))).toBe(true);
        for (const header of rootHeaders.split('Subject: Old\r\n')) {expect(prepared.raw.toString()).toContain(header);}
        expect(prepared.retainedAttachments).toEqual(inspected.attachments);
        expect(prepared.envelope.from[0]?.address).toBe('alias@example.test');
        expect(prepared.envelope.replyTo[0]?.address).toBe('help@example.test');
        verifyCandidate(prepared, prepared.raw);
    });
    test('body replacement keeps related grouping and full opaque encoded parts', async () => {
        const raw = rich(); const source = await inspectSource(raw);
        const candidate = await preparePatch(source, { body: { text: 'Changed\ntext', html: '<strong>Changed</strong><img src="cid:logo@example.test">' } });
        expect(candidate.raw.includes(Buffer.from(logo))).toBe(true);
        for (const part of [pdf(), calendar, eml]) {expect(candidate.raw.includes(Buffer.from(part))).toBe(true);}
        expect(candidate.raw.toString()).toContain('boundary="related-B"');
        expect(candidate.raw.toString()).toContain('outer tail\r\n');
        expect(candidate.retainedAttachments).toEqual(source.attachments);
        expect(candidate.raw.includes(Buffer.from('old plain'))).toBe(false);
    });
    test('explicit plaintext conversion preserves attachments and adjusts related type', async () => {
        const candidate = await preparePatch(await inspectSource(rich()), { body: { text: '', html: null } });
        expect(candidate.raw.toString()).not.toContain('Content-Type: text/html');
        expect(candidate.raw.toString()).toContain('type="text/plain"');
        expect(candidate.raw.includes(Buffer.from(logo))).toBe(true);
    });
    test('strict encoded hashes remove exactly one of duplicate filenames', async () => {
        const other = pdf(Buffer.from('different pdf').toString('base64'));
        const source = await inspectSource(rich([other]), [{ attachmentId: 'ATT00002', hash: digest(pdfBody) }]);
        const candidate = await preparePatch(source, { deleteAttachmentIds: ['ATT00002'] });
        expect(candidate.raw.includes(Buffer.from(pdf()))).toBe(false);
        expect(candidate.raw.includes(Buffer.from(other))).toBe(true);
        expect(candidate.raw.includes(Buffer.from(calendar))).toBe(true);
        expect(candidate.retainedAttachments).toHaveLength(4);
    });
    test('identical attachment hashes preserve safely and cannot select a removal', async () => {
        const source = await inspectSource(rich([pdf()]), [{ attachmentId: 'ATT00002', hash: digest(pdfBody) }, { attachmentId: 'ATT00005', hash: digest(pdfBody) }]);
        expect((await preparePatch(source, { subject: 'safe' })).retainedAttachments).toHaveLength(5);
        await expect(preparePatch(source, { deleteAttachmentIds: ['ATT00002'] })).rejects.toBeInstanceOf(MimeError);
    });
    test('no fallback from filename, wrong hash, duplicate ID, or decoded hash', async () => {
        for (const hash of [digest('wrong'), digest(Buffer.from(pdfBody, 'base64'))]) {
            const source = await inspectSource(rich(), [{ attachmentId: 'ATT00002', hash }]);
            await expect(preparePatch(source, { deleteAttachmentIds: ['ATT00002'] })).rejects.toBeInstanceOf(MimeError);
        }
        await expect(inspectSource(rich(), [{ attachmentId: 'ATT00002', hash: digest(pdfBody) }, { attachmentId: 'ATT00002', hash: digest(pdfBody) }])).rejects.toBeInstanceOf(MimeError);
    });
    test('zero-byte parts and binary bytes are preserved verbatim', async () => {
        const empty = pdf('');
        const binary = Buffer.concat([Buffer.from('Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="binary"\r\nContent-Transfer-Encoding: binary\r\n\r\n'), Buffer.from([0, 255, 13, 10, 1, 200, 10, 3])]);
        const raw = rich([empty, binary]);
        const source = await inspectSource(raw);
        const candidate = await preparePatch(source, { subject: 'Keep bytes' });
        expect(bodyOf(candidate.raw).equals(bodyOf(raw))).toBe(true);
        expect(candidate.raw.includes(binary)).toBe(true);
        expect(candidate.raw.includes(Buffer.from(empty))).toBe(true);
    });
    test('empty leaf adjacent to delimiter is supported and remains exact', async () => {
        const raw = Buffer.from(rootHeaders + 'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\n' + plain() + '\r\n--x\r\n' + pdf('') + '--x--\r\n');
        const candidate = await preparePatch(await inspectSource(raw), { subject: 'empty' });
        expect(bodyOf(candidate.raw).equals(bodyOf(raw))).toBe(true);
    });
    test('empty source body gains a delimiter CRLF when replaced with nonempty content', async () => {
        const raw = Buffer.from(rootHeaders + 'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\n' + plain('') + '--x\r\n' + pdf() + '\r\n--x--\r\n');
        const candidate = await preparePatch(await inspectSource(raw), { body: { text: 'now nonempty', html: null } });
        expect((await inspectSource(candidate.raw)).attachments).toHaveLength(1);
        expect(candidate.raw.includes(Buffer.from(pdf()))).toBe(true);
    });
    test('no-op preserves every byte of HTML-only and plain sources', async () => {
        for (const part of [plain('tail without newline'), html('<p>HTML only</p>')]) {
            const raw = Buffer.from(rootHeaders + part);
            expect((await preparePatch(await inspectSource(raw), {})).raw.equals(raw)).toBe(true);
        }
    });
    test('additions preserve existing parts and introduce inline related and regular mixed wrappers', async () => {
        const source = await inspectSource(Buffer.from(rootHeaders + plain('hello')));
        const candidate = await preparePatch(source, { body: { text: 'hello', html: '<img src="cid:new@example.test">' }, attachments: [
            { filename: 'Résumé.pdf', contentType: 'application/pdf', bytes: Buffer.from(pdfBody, 'base64'), disposition: 'attachment' },
            { filename: 'new.png', contentType: 'image/png', bytes: Buffer.from('AAEC', 'base64'), disposition: 'inline', cid: 'new@example.test' },
        ] });
        const checked = await inspectSource(candidate.raw);
        expect(checked.attachments).toHaveLength(2);
        expect(candidate.raw.toString()).toContain('multipart/related');
        expect(candidate.raw.toString()).toContain('multipart/mixed');
        expect(candidate.raw.toString()).toContain('Content-ID: <new@example.test>');
        expect(candidate.envelope.bcc[0]?.address).toBe('hidden@example.test');
    });
    test('additions append within an existing related group and mixed container', async () => {
        const candidate = await preparePatch(await inspectSource(rich()), { attachments: [
            { filename: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array(0), disposition: 'attachment' },
            { filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array([0]), disposition: 'inline', cid: 'second@example.test' },
        ] });
        const text = candidate.raw.toString();
        expect(text.indexOf('Content-ID: <second@example.test>')).toBeLessThan(text.indexOf('--related-B--'));
        expect(text.indexOf('filename=a.txt')).toBeGreaterThan(text.indexOf('--related-B--'));
        expect(candidate.retainedAttachments).toHaveLength(4);
    });
    test('clear recipients and safely encode Unicode names and subject', async () => {
        const source = await inspectSource(rich());
        const candidate = await preparePatch(source, { to: [], cc: [], bcc: [{ address: 'new@example.test', name: 'Zoë, Reader' }], replyTo: [], subject: '新 subject' });
        expect(candidate.envelope.to).toEqual([]); expect(candidate.envelope.cc).toEqual([]); expect(candidate.envelope.replyTo).toEqual([]);
        expect(candidate.envelope.bcc.map(item => item.address)).toEqual(['new@example.test']);
        expect(bodyOf(candidate.raw).equals(bodyOf(rich()))).toBe(true);
    });
    test('create explicit HTML, empty plaintext and zero-byte attachment; no auto-text/asset extraction', async () => {
        const candidate = await createMime({ ...fresh, body: { text: '', html: '<img src="data:image/png;base64,AA=="><img src="https://example.test/a">' }, attachments: [{ filename: 'empty.bin', contentType: 'application/octet-stream', bytes: new Uint8Array(0), disposition: 'attachment' }] });
        expect((await inspectSource(candidate.raw)).attachments).toHaveLength(1);
        expect(candidate.envelope.bcc).toHaveLength(1);
        verifyCandidate(candidate, Buffer.from(candidate.raw));
    });
    test('create and add .eml attachments use identity encodings and preserve exact file bytes', async () => {
        const embeddedHeaders = Buffer.from('From: attached@example.test\r\nDate: Mon, 26 Oct 2026 12:00:00 +0000\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n');
        const fixtures = [
            { bytes: Buffer.concat([embeddedHeaders, Buffer.from('ASCII body')]), encoding: '7bit' },
            { bytes: Buffer.concat([embeddedHeaders, Buffer.from('Unicode body ✓\r\n')]), encoding: '8bit' },
            { bytes: Buffer.concat([embeddedHeaders, Buffer.from([0, 255, 128])]), encoding: 'binary' },
            { bytes: Buffer.concat([embeddedHeaders, Buffer.alloc(1000, 65)]), encoding: 'binary' },
        ];
        for (const fixture of fixtures) {
            const attachment = { filename: 'new.eml', contentType: 'message/rfc822', bytes: fixture.bytes, disposition: 'attachment' as const };
            const added = await preparePatch(await inspectSource(rich()), { attachments: [attachment] });
            const created = await createMime({ ...fresh, attachments: [attachment] });
            for (const candidate of [created, added]) {
                const filename = candidate.raw.indexOf('filename=new.eml');
                expect(filename).toBeGreaterThan(0);
                const separator = candidate.raw.indexOf('\r\n\r\n', filename);
                expect(candidate.raw.subarray(filename, separator).toString()).toContain('Content-Transfer-Encoding: ' + fixture.encoding);
                expect(candidate.raw.subarray(separator + 4, separator + 4 + fixture.bytes.length).equals(fixture.bytes)).toBe(true);
                const inspection = await inspectSource(candidate.raw);
                expect(inspection.attachments.some(part => part.contentType === 'message/rfc822' && part.encodedBodySha256 === digest(fixture.bytes))).toBe(true);
            }
            expect(added.raw.includes(Buffer.from(eml))).toBe(true);
            expect(added.retainedAttachments.some(part => part.rawSha256 === digest(eml))).toBe(true);
        }
    });
    test('new .eml rejects line-ending normalization and existing-boundary collisions before upload', async () => {
        const bytes = Buffer.from('From: attached@example.test\n\nbody');
        const attachment = { filename: 'new.eml', contentType: 'message/rfc822', bytes, disposition: 'attachment' as const };
        // The caller's own bytes break the rule (as the schema reports for contentBase64), whatever their source.
        await expect(createMime({ ...fresh, attachments: [attachment] })).rejects.toMatchObject({ code: 'invalid_attachment' });
        const source = await inspectSource(rich());
        await expect(preparePatch(source, { attachments: [attachment] })).rejects.toMatchObject({ code: 'invalid_attachment' });
        const collision = Buffer.from('From: attached@example.test\r\n\r\nbody\r\n--mixed-B\r\nContent-Type: application/octet-stream\r\n\r\nfake sibling');
        await expect(preparePatch(source, { attachments: [{ ...attachment, bytes: collision }] })).rejects.toBeInstanceOf(MimeError);
        // Bytes are never rewritten: the rejected file is unchanged afterwards.
        expect(bytes.equals(Buffer.from('From: attached@example.test\n\nbody'))).toBe(true);
    });
    test('unsupported new message subtypes reject during create and add preflight', async () => {
        const source = await inspectSource(rich());
        for (const contentType of ['message/partial', 'message/external-body', 'message/global', 'message/delivery-status', 'message/x-unknown', 'MeSsAgE/PaRtIaL']) {
            const attachment = { filename: 'message.dat', contentType, bytes: Buffer.from('opaque bytes'), disposition: 'attachment' as const };
            await expect(createMime({ ...fresh, attachments: [attachment] })).rejects.toMatchObject({ code: 'invalid_mime_patch' });
            await expect(preparePatch(source, { attachments: [attachment] })).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
    });
    test('existing opaque message subtypes retain exact headers and bytes', async () => {
        const types = ['message/partial; id="part-id"; number=1; total=2', 'message/external-body; access-type="URL"; URL="https://example.invalid/opaque"', 'message/global', 'message/x-unknown'];
        const parts = types.map(type => 'Content-Type: ' + type + '\r\nContent-Disposition: attachment; filename="opaque.dat"\r\nContent-Transfer-Encoding: 7bit\r\n\r\nContent-Type: text/plain\r\n\r\nopaque content');
        const raw = rich(parts);
        const inspected = await inspectSource(raw);
        const headerPatch = await preparePatch(inspected, { subject: 'Keep all opaque parts' });
        expect(bodyOf(headerPatch.raw).equals(bodyOf(raw))).toBe(true);
        const bodyPatch = await preparePatch(inspected, { body: { text: 'new body', html: null } });
        for (const part of parts) {
            expect(bodyPatch.raw.includes(Buffer.from(part))).toBe(true);
            expect(bodyPatch.retainedAttachments.some(proof => proof.rawSha256 === digest(part))).toBe(true);
        }
    });
    test('exact verification rejects every byte change, truncation, suffix, and mutable candidate tampering', async () => {
        const candidate = await createMime(fresh);
        for (const bytes of [candidate.raw.subarray(0, -1), Buffer.concat([candidate.raw, Buffer.from('x')]), Buffer.from(candidate.raw.toString().replace('Content-Type:', 'Content-type:'))]) {expect(() => verifyCandidate(candidate, bytes)).toThrow(MimeError);}
        const different = Buffer.from(candidate.raw); different.writeUInt8(different.readUInt8(different.length - 3) ^ 1, different.length - 3);
        expect(() => verifyCandidate(candidate, different)).toThrow(MimeError);
        candidate.raw.writeUInt8(candidate.raw.readUInt8(0) ^ 1, 0);
        expect(() => verifyCandidate(candidate, candidate.raw)).toThrow(MimeError);
    });
});

describe('MIME rejects ambiguous or unsupported semantics before any candidate', () => {
    test('duplicate singleton and structured parameters', async () => {
        for (const addition of ['Subject: another\r\n', 'From: other@example.test\r\n', 'Content-Type: text/html\r\n']) {await rejects(rootHeaders + addition + plain());}
        await rejects(rootHeaders + 'Content-Type: text/plain; charset=utf-8; charset=us-ascii\r\n\r\nbody');
        await rejects(rootHeaders + 'Content-Type: multipart/mixed; boundary="a"; boundary="b"\r\n\r\n--a--\r\n');
        await rejects(rootHeaders + 'Content-Type: text/plain; charset*=utf-8\'\'utf-8\r\n\r\nbody');
    });
    test('malformed headers, parser recovery, unknown charset/flowed and ambiguous body layouts', async () => {
        for (const content of [plain().replace('charset=utf-8', 'charset=iso-8859-1'), plain().replace('charset=utf-8', 'charset=utf-8; format=flowed'), 'Content-Type: text/calendar\r\n\r\nbody', 'Content-Type: text/plain\r\nBroken header\r\n\r\nbody', 'Content-Type: text/plain\n\nbody']) {await rejects(rootHeaders + content);}
        await rejects(Buffer.concat([Buffer.from(rootHeaders), multi('mixed', 'x', [plain(), html()])]));
        await rejects(Buffer.concat([Buffer.from(rootHeaders), multi('alternative', 'x', [plain(), plain()])]));
        await rejects(Buffer.from(rootHeaders.replace('Friends: Alice <alice@example.test>, Bob <bob@example.test>;', 'alice@example.test bob@example.test') + plain()));
    });
    test('reject signatures, encrypted containers and semantic integrity headers', async () => {
        for (const header of ['DKIM-Signature: v=1; x=1\r\n', 'ARC-Seal: v=1\r\n', 'Resent-To: other@example.test\r\n', 'Content-MD5: aaa\r\n', 'Sender: other@example.test\r\n']) {await rejects(rootHeaders + header + plain());}
        for (const subtype of ['signed', 'encrypted', 'digest']) {await rejects(Buffer.concat([Buffer.from(rootHeaders), multi(subtype, 'x', [plain()])]));}
    });
    test('reject missing, premature, duplicate, padded and prefix-colliding boundaries', async () => {
        const original = rich().toString();
        for (const value of [original.replace('--related-B--', '--broken--'), original.replace('--alt-B--', '--mixed-B--'), original.replace('--mixed-B--', '--mixed-B--\r\n--mixed-B--'), original.replace('--mixed-B\r\n', '--mixed-B \r\n'), original.replaceAll('related-B', 'mixed-B-child')]) {await rejects(value);}
    });
    test('reject duplicate CIDs and removals that cannot prove CID references absent', async () => {
        await rejects(rich([logo]));
        const source = await inspectSource(rich(), [{ attachmentId: 'ATT00001', hash: digest('iVBORw0KGgo=') }]);
        await expect(preparePatch(source, { deleteAttachmentIds: ['ATT00001'] })).rejects.toBeInstanceOf(MimeError);
        await expect(preparePatch(source, { attachments: [{ filename: 'duplicate.png', contentType: 'image/png', bytes: new Uint8Array([0]), disposition: 'inline', cid: 'logo@example.test' }] })).rejects.toBeInstanceOf(MimeError);
        await expect(preparePatch(source, { body: { text: 'new', html: '<img src="cid:logo@example.test">' }, deleteAttachmentIds: ['ATT00001'] })).rejects.toBeInstanceOf(MimeError);
        const authored = await preparePatch(source, { body: { text: 'new', html: '<p>New HTML with no image</p>' }, deleteAttachmentIds: ['ATT00001'] });
        expect(authored.raw.includes(Buffer.from(logo))).toBe(false);
        expect(authored.raw.toString()).toContain('Content-Type: text/html');
        const converted = await preparePatch(source, { body: { text: 'plain', html: null }, deleteAttachmentIds: ['ATT00001'] });
        expect(converted.raw.includes(Buffer.from(logo))).toBe(false);
    });
    test('new threading rejects injection and malformed reference chains before MIME preparation', async () => {
        for (const threading of [
            { inReplyTo: '<parent@example.test>\r\nBcc: injected@example.test', references: ['<parent@example.test>'] },
            { inReplyTo: '<parent@example.test>', references: ['<parent@example.test>\nX: injected'] },
            { inReplyTo: '<parent@example.test>', references: [] },
            { inReplyTo: '<parent@example.test>', references: ['<other@example.test>'] },
            { inReplyTo: '<parent@example.test>', references: ['<parent@example.test>', '<parent@example.test>'] },
        ]) { await expect(createMime({ ...fresh, threading })).rejects.toMatchObject({ code: 'invalid_mime_patch' }); }
    });
    test('header injection and non-byte attachment content fail', async () => {
        const source = await inspectSource(rich());
        for (const patch of [{ subject: 'bad\r\nBcc: evil@example.test' }, { from: { address: 'x@example.test\r\nX: bad' } }, { to: [{ address: 'x@example.test', name: 'bad\nName' }] }]) {await expect(preparePatch(source, patch)).rejects.toBeInstanceOf(MimeError);}
        // The layer takes bytes, never text to decode: base64 is the schema's to check (and decode, once).
        for (const bytes of ['AA==', [0, 1], null, undefined]) {await expect(createMime({ ...fresh, attachments: [{ filename: 'x', contentType: 'application/octet-stream', bytes: bytes as unknown as Uint8Array, disposition: 'attachment' }] })).rejects.toMatchObject({ code: 'invalid_mime_patch' });}
        await expect(preparePatch(source, { body: { text: 'x', html: '<img src="attachment:ATT00001">' } })).rejects.toBeInstanceOf(MimeError);
    });
    test('unsupported From syntax fails closed instead of generating a fallback Message-ID', async () => {
        for (const address of ['sender@example.test\r\nMessage-ID: <injected@evil.test>', 'sender@example..test', 'sender@[127.0.0.1]', 'sender@bücher.example', '"sender@quoted"@example.test']) {
            await expect(createMime({ ...fresh, from: { address } })).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
    });
    test('message, encoded attachments, header, node and nesting caps', async () => {
        expect(MIME_LIMITS.messageBytes).toBe(MAX_MESSAGE_BYTES);
        await expect(inspectSource(Buffer.alloc(MIME_LIMITS.messageBytes + 1))).rejects.toMatchObject({ code: 'mime_limit' });
        await rejects(rootHeaders + 'X-Long: ' + 'x'.repeat(MIME_LIMITS.headerBytes) + '\r\n' + plain());
        await rejects(rich(Array.from({ length: 130 }, () => pdf())));
        let nested = Buffer.from(plain()); for (let i = 0; i < 14; i++) {nested = multi('mixed', 'deep-' + i, [nested]);}
        await rejects(Buffer.concat([Buffer.from(rootHeaders), nested]));
        // The one cap is on the encoded message: a file whose base64 cannot fit fails before it is
        // encoded, while the same bytes as an identity-encoded message/rfc822 still fit.
        const big = Buffer.alloc(MIME_LIMITS.messageBytes * 3 / 4, 65);
        await expect(createMime({ ...fresh, attachments: [{ filename: 'big', contentType: 'application/octet-stream', bytes: big, disposition: 'attachment' }] })).rejects.toMatchObject({ code: 'mime_limit' });
        const half = big.subarray(0, big.length / 2);
        await expect(createMime({ ...fresh, attachments: [{ filename: 'a', contentType: 'application/octet-stream', bytes: half, disposition: 'attachment' }, { filename: 'b', contentType: 'application/octet-stream', bytes: half, disposition: 'attachment' }] })).rejects.toMatchObject({ code: 'mime_limit' });
        const eml = await createMime({ ...fresh, attachments: [{ filename: 'big.eml', contentType: 'message/rfc822', bytes: big, disposition: 'attachment' }] });
        expect(eml.raw.length).toBeLessThanOrEqual(MIME_LIMITS.messageBytes);
        // An update counts its retained parts: the same file cannot be added a second time.
        await expect(preparePatch(await inspectSource(eml.raw), { attachments: [{ filename: 'again.eml', contentType: 'message/rfc822', bytes: big, disposition: 'attachment' }] })).rejects.toMatchObject({ code: 'mime_limit' });
    });
    test('body replacement rejects loss of unrecognized body metadata', async () => {
        const raw = Buffer.concat([Buffer.from(rootHeaders), multi('alternative', 'a', [plain().replace('Content-Transfer-Encoding', 'X-Body-Meaning: special\r\nContent-Transfer-Encoding'), html('no image')])]);
        const source = await inspectSource(raw);
        await expect(preparePatch(source, { body: { text: 'replacement', html: null } })).rejects.toBeInstanceOf(MimeError);
        expect(bodyOf((await preparePatch(source, { subject: 'still safe' })).raw).equals(bodyOf(raw))).toBe(true);
    });
});

describe('MIME address-parser security regressions', () => {
    // Published PoCs: https://github.com/nodemailer/nodemailer/security/advisories/<id>
    const unsupported = [
        { id: 'GHSA-85x2-q946-cp5h', address: '<"a@evil.com>"@good.com>' },
        { id: 'GHSA-m943-m63m-w62w comment', address: 'G: (a; <evil@evil.com>) <v@victim.com>;' },
        { id: 'GHSA-m943-m63m-w62w quoted words', address: 'G: "a;" "<evil@evil.com>" <v@victim.com>;' },
        { id: 'GHSA-8c8m-p3m8-cjg8', address: 'Victim (x(y) <evil@evil.com>) <v@victim.com>' },
    ];
    test.each(unsupported)('$id rejects unsupported source syntax before preparing an upload', async ({ address }) => {
        for (const header of ['From', 'Reply-To', 'To', 'Cc', 'Bcc']) {
            const rawHeaders = rootHeaders.replace(new RegExp(`^${header}:[^\r\n]*`, 'mu'), `${header}: ${address}`);
            await expect(inspectSource(Buffer.from(rawHeaders + plain()))).rejects.toMatchObject({ code: 'unsupported_mime' });
        }
    });
    test('supported quoted display punctuation inside a group names only its explicit mailbox', async () => {
        const header = 'To: G: "a; <evil@evil.com>" <v@victim.com>;\r\n';
        const raw = Buffer.from(rootHeaders.replace(/^To:[^\r\n]*\r\n/mu, header) + plain());
        const inspected = await inspectSource(raw);
        expect(inspected.envelope.to.map(entry => entry.address)).toEqual(['v@victim.com']);
        const candidate = await preparePatch(inspected, { subject: 'Preserve the supported group' });
        expect(candidate.envelope.to.map(entry => entry.address)).toEqual(['v@victim.com']);
        expect(candidate.raw.includes(Buffer.from(header))).toBe(true);
        expect(bodyOf(candidate.raw).equals(bodyOf(raw))).toBe(true);
    });
    test('structured display punctuation cannot change create or patch mailbox sets', async () => {
        const inspected = await inspectSource(rich());
        const expected = { from: ['alias@example.test'], replyTo: ['reply@example.test'], to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'] };
        for (const name of ['a; <evil@evil.com>', 'Victim (x(y) <evil@evil.com>)', 'a@evil.com>']) {
            const fields = {
                from: { address: 'alias@example.test', name }, replyTo: [{ address: 'reply@example.test', name }],
                to: [{ address: 'to@example.test', name }], cc: [{ address: 'cc@example.test', name }], bcc: [{ address: 'bcc@example.test', name }],
            };
            const created = await createMime({ ...fresh, ...fields });
            const patched = await preparePatch(inspected, fields);
            for (const candidate of [created, patched]) {
                for (const field of ['from', 'replyTo', 'to', 'cc', 'bcc'] as const) {
                    expect(candidate.envelope[field].map(entry => entry.address)).toEqual(expected[field]);
                }
            }
            expect(bodyOf(patched.raw).equals(bodyOf(rich()))).toBe(true);
        }
    });
});

const bareBreak = /\r(?!\n)|(?<!\r)\n/u;

describe('authored text parts use canonical CRLF line breaks', () => {
    const variants: ReadonlyArray<readonly [string, string, string]> = [
        ['LF', 'one\ntwo\n\nthree\n', '<p>one\ntwo\n\nthree</p>\n'],
        ['CRLF', 'one\r\ntwo\r\n\r\nthree\r\n', '<p>one\r\ntwo\r\n\r\nthree</p>\r\n'],
        ['bare CR', 'one\rtwo\r\rthree\r', '<p>one\rtwo\r\rthree</p>\r'],
        ['mixed', 'one\ntwo\r\n\rthree\r\n', '<p>one\r\ntwo\n\rthree</p>\n'],
    ];
    const canonicalText = 'one\r\ntwo\r\n\r\nthree\r\n', canonicalHtml = '<p>one\r\ntwo\r\n\r\nthree</p>\r\n';
    test.each(variants)('createMime stores %s input as CRLF-only text and HTML with identical decoded bytes', async (_name, text, htmlText) => {
        const alternative = await createMime({ ...fresh, body: { text, html: htmlText } });
        const altText = authoredText(alternative.raw, 'text/plain'), altHtml = authoredText(alternative.raw, 'text/html');
        expect(altText).toEqual([canonicalText]);
        expect(altHtml).toEqual([canonicalHtml]);
        const plainOnly = await createMime({ ...fresh, body: { text, html: null } });
        const plainText = authoredText(plainOnly.raw, 'text/plain');
        expect(plainText).toEqual([canonicalText]);
        for (const decoded of [...altText, ...altHtml, ...plainText]) { expect(bareBreak.test(decoded)).toBe(false); }
        verifyCandidate(alternative, alternative.raw);
    });
    test.each(variants)('preparePatch stores %s body replacement as CRLF-only and keeps the top-level final CRLF', async (_name, text, htmlText) => {
        for (const raw of [Buffer.from(rootHeaders + plain()), rich()]) {
            const patched = await preparePatch(await inspectSource(raw), { body: { text, html: htmlText } });
            expect(authoredText(patched.raw, 'text/plain')).toEqual([canonicalText]);
            expect(authoredText(patched.raw, 'text/html')).toEqual([canonicalHtml]);
            verifyCandidate(patched, patched.raw);
        }
        const bare = await preparePatch(await inspectSource(Buffer.from(rootHeaders + plain())), { body: { text, html: null } });
        expect(authoredText(bare.raw, 'text/plain')).toEqual([canonicalText]);
        expect(bare.raw.subarray(-2).equals(Buffer.from('\r\n'))).toBe(true);
    });
    test('body without final newline still gains the top-level CRLF after conversion', async () => {
        const created = await createMime({ ...fresh, body: { text: 'a\nb', html: null } });
        expect(authoredText(created.raw, 'text/plain')).toEqual(['a\r\nb']);
        expect(created.raw.subarray(-2).equals(Buffer.from('\r\n'))).toBe(true);
        const patched = await preparePatch(await inspectSource(Buffer.from(rootHeaders + plain())), { body: { text: 'a\nb', html: null } });
        expect(patched.raw.subarray(-2).equals(Buffer.from('\r\n'))).toBe(true);
    });
    test('size limits apply to caller input before conversion', async () => {
        const text = '\n'.repeat(128 * 1024), htmlText = '\n'.repeat(256 * 1024);
        const created = await createMime({ ...fresh, body: { text, html: htmlText } });
        expect(authoredText(created.raw, 'text/plain')[0]?.length).toBe(256 * 1024);
        expect(authoredText(created.raw, 'text/html')[0]?.length).toBe(512 * 1024);
        await expect(createMime({ ...fresh, body: { text: text + '\n', html: null } })).rejects.toBeInstanceOf(MimeError);
        await expect(createMime({ ...fresh, body: { text: 'x', html: htmlText + '\n' } })).rejects.toBeInstanceOf(MimeError);
    });
    test.each([
        ['LF-only', '\n', '7bit'],
        ['CJK (base64 worst case)', '你', 'base64'],
        ['mostly ASCII Latin (quoted-printable)', 'é' + 'a'.repeat(20), 'quoted-printable'],
        ['8-bit-free controls', '\u0001', 'base64'],
    ] as const)('maximal %s bodies plus all inline attachment bytes stay inside the message cap; the largest upload needs a smaller body', async (_name, unit, encoding) => {
        const fill = (bytes: number) => unit.repeat(Math.floor(bytes / Buffer.byteLength(unit)));
        const body = { text: fill(128 * 1024), html: fill(256 * 1024) };
        const attachments = [{ filename: 'inline.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(MAX_INLINE_ATTACHMENT_BYTES, 0x0a), disposition: 'attachment' as const }];
        const created = await createMime({ ...fresh, body, attachments });
        expect(created.raw.length).toBeLessThan(MIME_LIMITS.messageBytes);
        expect(authoredParts(created.raw).map(part => part.encoding)).toEqual([encoding, encoding]);
        const patched = await preparePatch(await inspectSource(Buffer.from(rootHeaders + plain())), { body, attachments });
        expect(patched.raw.length).toBeLessThan(MIME_LIMITS.messageBytes);
        // An 18 MiB upload's base64 leaves about 377 KiB, less than a maximal body takes once encoded.
        const upload = [{ filename: 'big.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(MAX_UPLOAD_BYTES, 0x0a), disposition: 'attachment' as const }];
        await expect(createMime({ ...fresh, body, attachments: upload })).rejects.toMatchObject({ code: 'mime_limit' });
        expect((await createMime({ ...fresh, attachments: upload })).raw.length).toBeLessThan(MIME_LIMITS.messageBytes);
    });
    test('attachments, including text attachments with bare LF or CR, keep their exact bytes', async () => {
        const bytes = Buffer.from('line one\nline two\rline three\r\nlast\n');
        const wrapped = bytes.toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? '';
        const created = await createMime({ ...fresh, body: { text: 'x\ny', html: null }, attachments: [{ filename: 'notes.txt', contentType: 'text/plain', bytes, disposition: 'attachment' }] });
        expect(created.raw.includes(Buffer.from(wrapped))).toBe(true);
        expect(authoredText(created.raw, 'text/plain').filter(text => text === 'x\r\ny')).toHaveLength(1);
        const stored = await inspectSource(created.raw);
        expect(stored.attachments).toHaveLength(1);
    });
    test('retained text attachments with bare LF stay byte-identical when the body is replaced', async () => {
        const attachmentBody = Buffer.from('keep\nbare\nLF\rand CR\n').toString('base64');
        const textAttachment = `Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename="notes.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachmentBody}`;
        const raw = Buffer.concat([Buffer.from(rootHeaders), multi('mixed', 'mixed-B', [plain(), textAttachment])]);
        const source = await inspectSource(raw);
        const patched = await preparePatch(source, { body: { text: 'new\nbody', html: '<p>new\nbody</p>' } });
        expect(patched.raw.includes(Buffer.from(textAttachment))).toBe(true);
        expect(patched.retainedAttachments).toEqual(source.attachments);
        expect(authoredText(patched.raw, 'text/plain')).toEqual(['new\r\nbody']);
        expect(authoredText(patched.raw, 'text/html')).toEqual(['<p>new\r\nbody</p>']);
    });
});

/** RFC 5322 unfolding of an authored Subject field, and WildDuck's own view of it
 * (imap-core parse-mime-tree.js joins folds with one space, message-handler.js trims), each
 * RFC 2047 decoded. */
const unfoldSubject = (header: Buffer) => header.toString('latin1').slice('Subject:'.length, -2);
const subjectReadings = (header: Buffer) => [libmime.decodeWords(unfoldSubject(header).replaceAll('\r\n', '').trim()), libmime.decodeWords(unfoldSubject(header).replace(/\s*\r?\n\s*/gu, ' ').trim())];
/** One root header field, with its folds. */
const fieldOf = (raw: Buffer, name: string) => {
    const headers = raw.subarray(0, raw.indexOf('\r\n\r\n') + 2).toString('latin1');
    const match = new RegExp(`^${name}:.*\\r\\n(?:[ \\t].*\\r\\n)*`, 'mu').exec(headers);
    return match ? Buffer.from(match[0], 'latin1') : undefined;
};

describe('authored Subject fields', () => {
    // The library writes plain ASCII unencoded (a double quote makes it encode the whole value),
    // and otherwise picks Q when Latin letters outnumber other characters, else B.
    const cases: ReadonlyArray<readonly [string, string, 'plain' | 'Q' | 'B']> = [
        ['short ASCII', 'Hello world', 'plain'],
        ['ASCII filling a 76-character line', 'a'.repeat(67), 'plain'],
        ['ASCII of 80 characters without a fold point', 'a'.repeat(71), 'plain'],
        ['long ASCII with fold points', 'word '.repeat(400).trim(), 'plain'],
        ['the longest accepted word', 'x'.repeat(900), 'plain'],
        ['two longest words', 'x'.repeat(900) + ' ' + 'y'.repeat(900), 'plain'],
        ['ASCII punctuation', "Re: Bob's update (v2) - 50% done; ok? a=b, c?=d [x] <y> _z_", 'plain'],
        ['ASCII with a double quote', 'The "big" plan', 'Q'],
        ['non-ASCII Latin', 'Résumé café, déjà vu', 'Q'],
        ['long mostly-ASCII Latin', 'Café '.repeat(341).trim(), 'Q'],
        ['CJK', '新しい件名です', 'B'],
        ['emoji', '🌍🎉✓', 'B'],
        ['mixed reply', 'Re: Résumé — 你好 🌍', 'B'],
        ['2048 bytes of emoji', '🌍'.repeat(512), 'B'],
        ['2046 bytes of CJK', '你'.repeat(682), 'B'],
        ['long Latin', 'é'.repeat(1024), 'B'],
    ];
    test.each(cases)('%s', async (_name, subject, form) => {
        // Every case is already in the schema's normalised form.
        expect(draftContentSchema.parse({ subject, body: { text: 'x' } }).subject).toBe(subject);
        const created = await createMime({ ...fresh, subject });
        const header = fieldOf(created.raw, 'Subject');
        if (header === undefined) { throw new Error('no Subject'); }
        const text = header.toString('latin1');
        const lines = text.slice(0, -2).split('\r\n');
        expect(subjectReadings(header)).toEqual([subject, subject]);
        if (form === 'plain') {
            expect(text).not.toContain('=?');
            for (const line of lines) { expect(line.length).toBeLessThanOrEqual(998); }
        } else {
            const words = text.slice(8, -2).trim().split(/\r\n | /u);
            for (const word of words) { expect(word).toMatch(form === 'Q' ? /^=\?UTF-8\?Q\?[^?\s]*\?=$/u : /^=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=$/u); }
            for (const line of lines) { expect(line.length).toBeLessThanOrEqual(76); }
        }
        // The same bytes are authored on create and patch, and pass the source gate.
        const patched = await preparePatch(await inspectSource(rich()), { subject });
        expect(fieldOf(patched.raw, 'Subject')?.equals(header)).toBe(true);
        expect(bodyOf(patched.raw).equals(bodyOf(rich()))).toBe(true);
    });
    test('a plain English subject is written unencoded, as rspamd prefers', async () => {
        expect(fieldOf((await createMime({ ...fresh, subject: 'Lunch on Friday?' })).raw, 'Subject')?.toString()).toBe('Subject: Lunch on Friday?\r\n');
    });
    test('a long subject with a double space at the library fold point round-trips after the schema normalises it', async () => {
        const subject = 'a'.repeat(60) + '  ' + 'b'.repeat(20) + '  ' + 'c'.repeat(40);
        // As given, the library folds before the double space and every reader unfolds it to one.
        const library = new Builder(undefined, {}); library.setHeader('Subject', subject);
        expect(library.buildHeaders()).toStartWith(`Subject: ${'a'.repeat(60)}\r\n  ${'b'.repeat(20)}`);
        await expect(createMime({ ...fresh, subject })).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        const normalised = draftContentSchema.parse({ subject, body: { text: 'x' } }).subject;
        expect(normalised).toBe('a'.repeat(60) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(40));
        const header = fieldOf((await createMime({ ...fresh, subject: normalised })).raw, 'Subject');
        expect(header && subjectReadings(header)).toEqual([normalised, normalised]);
    });
    test('an empty subject is omitted on create and removed by a patch', async () => {
        expect(fieldOf((await createMime({ ...fresh, subject: '' })).raw, 'Subject')).toBeUndefined();
        expect(fieldOf((await preparePatch(await inspectSource(rich()), { subject: '' })).raw, 'Subject')).toBeUndefined();
    });
    test('the MIME layer refuses what the schema refuses or normalises away', async () => {
        for (const subject of ['a\r\nBcc: x@example.test', 'nul\0', 'z'.repeat(2049), 'é'.repeat(1025), ' padded', 'padded ', 'Price =?UTF-8?B?SGk=?= ok']) {
            await expect(createMime({ ...fresh, subject })).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
        // A word too long for one header line fails the header gate.
        await expect(createMime({ ...fresh, subject: 'y'.repeat(2048) })).rejects.toBeInstanceOf(MimeError);
    });
});

describe('authored text transfer encodings', () => {
    const top = { topLevel: true, avoid: [] }, nested = { topLevel: false, avoid: [] };
    const choices: ReadonlyArray<readonly [string, string, typeof top, '7bit' | 'quoted-printable' | 'base64']> = [
        ['ASCII ending with a line break', 'Hello\r\nworld\r\n', top, '7bit'],
        ['nested ASCII without a final break', 'Hello\r\nworld', nested, '7bit'],
        ['top-level ASCII without a final break', 'Hello\r\nworld', top, 'quoted-printable'],
        ['empty top-level body', '', top, '7bit'],
        ['empty nested body', '', nested, '7bit'],
        ['line of exactly 76 characters', 'a'.repeat(76) + '\r\n', top, '7bit'],
        ['line of 77 characters', 'a'.repeat(77) + '\r\n', top, 'quoted-printable'],
        ['top-level line of 76 characters without a final break', 'a'.repeat(76), top, 'quoted-printable'],
        // No mbox or SMTP special case: dot-stuffing is transparent and "From " is ordinary text.
        ['line starting with From', 'Hi\r\nFrom me\r\n', top, '7bit'],
        ['lone dot line', 'Hi\r\n.\r\nBye', nested, '7bit'],
        ['line starting with a dot', '.hidden\r\n', top, '7bit'],
        ['From without a space', 'Fromage\r\n', top, '7bit'],
        ['trailing space', 'Hi \r\nthere\r\n', top, 'quoted-printable'],
        ['trailing tab', 'Hi\t\r\n', nested, 'quoted-printable'],
        ['inner tab', 'a\tb\r\n', top, '7bit'],
        ['control character', 'bell\u0007 rings\r\n', top, 'quoted-printable'],
        ['NUL', 'a\0b\r\n', top, 'quoted-printable'],
        ['equals sign', 'a = b\r\n', top, '7bit'],
        ['mostly ASCII Latin text', 'Résumé attached; see the café notes for details\r\n', top, 'quoted-printable'],
        ['dense Latin text, where base64 is smaller', 'Résumé café, déjà vu — naïve coöperation\r\n', top, 'base64'],
        ['mostly ASCII with an emoji', 'Status: all good 🌍 thanks for asking\r\n', top, 'quoted-printable'],
        ['CJK text', '新しい本文です。二行目です。'.repeat(10), top, 'base64'],
        ['emoji text', '🌍🎉'.repeat(20), nested, 'base64'],
    ];
    test.each(choices)('%s', (_name, text, placement, encoding) => {
        const content = Buffer.from(text);
        const result = textTransfer(content, placement);
        expect(result.encoding).toBe(encoding);
        expect(decodeTransfer(result.encoding, result.body).equals(content)).toBe(true);
        expect(textTransfer(Buffer.from(text), placement).body.equals(result.body)).toBe(true);
        if (placement.topLevel && result.encoding !== 'base64') { expect(result.body.length === 0 || result.body.subarray(-2).toString() === '\r\n').toBe(true); }
        // Quoted-printable is the library's encoding; only the top-level soft end is appended.
        if (result.encoding === 'quoted-printable') {
            const softEnd = placement.topLevel && !text.endsWith('\r\n');
            expect(result.body.toString('latin1')).toBe(qpWrap(qpEncode(content), softEnd ? 75 : 76) + (softEnd ? '=\r\n' : ''));
        }
    });
    test('a visible body never carries a delimiter line of a retained multipart', () => {
        const avoid = [Buffer.from('--mixed-B')];
        for (const text of ['x\r\n--mixed-B\r\ny\r\n', 'é\r\n--mixed-B--\r\n']) {
            const content = Buffer.from(text);
            expect(textTransfer(content, { topLevel: false, avoid: [] }).encoding).not.toBe('base64');
            const avoided = textTransfer(content, { topLevel: false, avoid });
            expect(avoided.encoding).toBe('base64');
            expect(decodeTransfer('base64', avoided.body).equals(content)).toBe(true);
        }
    });
    test('property: every selected encoding decodes exactly, stays within 76 columns, and a top-level part ends in CRLF', () => {
        // Deterministic pseudo-random documents over the awkward pieces: every printable
        // ASCII punctuation character, space, tab, CRLF, NUL, non-ASCII and astral text.
        const punctuation = Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index)).filter(char => /[!-/:-@[-`{-~]/u.test(char));
        expect(punctuation).toHaveLength(32);
        const pieces = ['a', 'Z', '0', ' ', '\t', 'F', 'From ', '.', '\r\n', '\r\n\r\n', 'é', '你', '🌍', '\0', 'x'.repeat(70), ' '.repeat(80), ...punctuation];
        const next = xorshift(0x2545f491);
        const documents = new Set<string>(), seen = new Set<string>();
        for (let round = 0; round < 400; round++) {
            let text = '';
            for (let count = next() % 300; count > 0; count--) { text += pieces[next() % pieces.length]; }
            documents.add(text);
            const content = Buffer.from(text);
            for (const topLevel of [false, true]) {
                const { encoding, body } = textTransfer(content, { topLevel, avoid: [] });
                seen.add(encoding);
                expect(decodeTransfer(encoding, body).equals(content)).toBe(true);
                expect(textTransfer(Buffer.from(text), { topLevel, avoid: [] }).body.equals(body)).toBe(true);
                for (const line of body.toString('latin1').split('\r\n')) { expect(line.length).toBeLessThanOrEqual(76); }
                if (topLevel && encoding !== 'base64' && content.length) { expect(body.subarray(-2).toString()).toBe('\r\n'); }
            }
        }
        // Guards the generator itself: a degenerate PRNG would silently shrink coverage.
        expect(documents.size).toBeGreaterThanOrEqual(390);
        expect([...seen].sort()).toEqual(['7bit', 'base64', 'quoted-printable']);
    });
    test('the strict quoted-printable test decoder accepts only a CRLF-terminated soft break', () => {
        const decode = (text: string) => decodeTransfer('quoted-printable', Buffer.from(text, 'latin1')).toString('latin1');
        expect(decode('abc=\r\n')).toBe('abc');
        expect(decode('abc=\r\ndef')).toBe('abcdef');
        expect(decode('a=3D')).toBe('a=');
        for (const dangling of ['abc=', '=', 'abc\r\ndef=', 'abc=\r\ndef=']) { expect(() => decode(dangling)).toThrow(); }
        // Uppercase hexadecimal only, and two digits are required after "=".
        for (const bad of ['=3d', 'a=3', 'a=3\r\nb', 'a=G0', 'a= 0', 'a=\rb']) { expect(() => decode(bad)).toThrow(); }
    });
    test('encoding is linear on the largest bodies', () => {
        const started = performance.now();
        for (const unit of ['é', 'a', '=', ' ', '🌍', 'é a b c d e ']) { textTransfer(Buffer.from(unit.repeat(Math.floor(256 * 1024 / Buffer.byteLength(unit)))), { topLevel: true, avoid: [] }); }
        expect(performance.now() - started).toBeLessThan(5000);
    });
    test.each([
        ['ASCII with a final break', 'Hello\nworld\n', '7bit'],
        ['ASCII without a final break', 'Hello\nworld', 'quoted-printable'],
        ['empty', '', '7bit'],
        ['Latin', 'Résumé attached for review', 'quoted-printable'],
        ['CJK', '新しい本文です。\n二行目です。', 'base64'],
    ] as const)('single-part %s text ends the message with LF and decodes exactly', async (_name, text, encoding) => {
        const created = await createMime({ ...fresh, body: { text, html: null } });
        const patched = await preparePatch(await inspectSource(Buffer.from(rootHeaders + plain())), { body: { text, html: null } });
        for (const candidate of [created, patched]) {
            // WildDuck only appends CRLF to a message whose last byte is not LF.
            expect(candidate.raw.at(-1)).toBe(10);
            const [part] = authoredParts(candidate.raw);
            expect(part?.encoding).toBe(encoding);
            expect(part?.text).toBe(text.replaceAll('\n', '\r\n'));
        }
    });
    test('nested parts decode exactly with and without a final break, including a formerly empty part', async () => {
        for (const text of ['line one\nline two', 'line one\nline two\n', 'é\n', 'x']) {
            const expected = text.replaceAll('\n', '\r\n');
            const alternative = await createMime({ ...fresh, body: { text, html: `<p>${text}</p>` } });
            expect(authoredText(alternative.raw, 'text/plain')).toEqual([expected]);
            const inRich = await preparePatch(await inspectSource(rich()), { body: { text, html: null } });
            expect(authoredText(inRich.raw, 'text/plain')).toEqual([expected]);
            const empty = Buffer.from(rootHeaders + 'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\n' + plain('') + '--x\r\n' + pdf() + '\r\n--x--\r\n');
            const replaced = await preparePatch(await inspectSource(empty), { body: { text, html: null } });
            expect(authoredText(replaced.raw, 'text/plain')).toEqual([expected]);
            expect((await inspectSource(replaced.raw)).attachments).toHaveLength(1);
            const wrapped = await preparePatch(await inspectSource(Buffer.from(rootHeaders + plain())), { body: { text, html: null }, attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', bytes: new Uint8Array([0]), disposition: 'attachment' }] });
            expect(authoredText(wrapped.raw, 'text/plain')).toEqual([expected]);
        }
    });
    test('a replacement body containing a retained delimiter line falls back to base64', async () => {
        const text = 'quoted\n--mixed-B\nnot a delimiter\n';
        const patched = await preparePatch(await inspectSource(rich()), { body: { text, html: '<p>--related-B</p>' } });
        expect(authoredParts(patched.raw).map(part => part.encoding)).toEqual(['base64', 'base64']);
        expect(authoredText(patched.raw, 'text/plain')).toEqual([text.replaceAll('\n', '\r\n')]);
        expect((await inspectSource(patched.raw)).attachments).toHaveLength(4);
    });
});

describe('drafts authored by 0.6.x (base64 text parts, B-encoded subject)', () => {
    const wrap = (text: string) => Buffer.from(text).toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? '';
    const legacySubject = `Subject: =?UTF-8?B?${Buffer.from('Résumé — 你好').toString('base64')}?=\r\n`;
    const legacyHeaders = rootHeaders.replace('Subject: Old\r\n', legacySubject);
    const legacyPart = (type: string, text: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(text)}`;
    const sources = {
        single: Buffer.from(legacyHeaders + legacyPart('text/plain', 'Old plain\r\nbody') + '\r\n'),
        alternative: Buffer.concat([Buffer.from(legacyHeaders), multi('alternative', '=_mcp_0123456789abcdef0123456789abcdef', [legacyPart('text/plain', 'Old plain'), legacyPart('text/html', '<p>Old</p>')])]),
    };
    test.each(Object.entries(sources))('%s source can be inspected, header-patched byte-identically and body-patched', async (_name, raw) => {
        const inspected = await inspectSource(raw);
        const headerOnly = await preparePatch(inspected, { to: [{ address: 'new@example.test' }] });
        expect(bodyOf(headerOnly.raw).equals(bodyOf(raw))).toBe(true);
        expect(headerOnly.raw.includes(Buffer.from(legacySubject))).toBe(true);
        const renamed = await preparePatch(inspected, { subject: 'Plain new subject' });
        expect(bodyOf(renamed.raw).equals(bodyOf(raw))).toBe(true);
        expect(renamed.raw.toString()).toContain('Subject: Plain new subject\r\n');
        const body = await preparePatch(inspected, { body: { text: 'New plain\nbody', html: '<p>New</p>' } });
        expect(authoredParts(body.raw).map(part => [part.type, part.encoding, part.text])).toEqual([['text/plain', '7bit', 'New plain\r\nbody'], ['text/html', '7bit', '<p>New</p>']]);
        expect(body.raw.includes(Buffer.from(legacySubject))).toBe(true);
        expect(body.raw.at(-1)).toBe(10);
        // The patched draft is itself a supported source for the next edit.
        const again = await preparePatch(await inspectSource(body.raw), { body: { text: 'Third', html: null } });
        expect(authoredText(again.raw, 'text/plain')).toEqual(['Third']);
        for (const candidate of [headerOnly, renamed, body, again]) { verifyCandidate(candidate, Buffer.from(candidate.raw)); }
    });
});

describe('MIME attachments from bytes at the 25 MiB message size', () => {
    const lines = (bytes: Buffer) => Buffer.from(bytes.toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? '');
    const partBody = (raw: Buffer, filename: string) => { const at = raw.indexOf(`filename=${filename}`); const start = raw.indexOf('\r\n\r\n', at) + 4; return raw.subarray(start, raw.indexOf('\r\n--', start)); };
    test('base64 bodies are 76-character CRLF lines across encoder slices, and their size is predicted exactly', async () => {
        const slice = 57 * 16 * 1024;
        for (const size of [0, 1, 56, 57, 58, slice - 1, slice, slice + 1, 2 * slice + 3]) {
            const bytes = Buffer.from(Array.from({ length: size }, (_, index) => (index * 7919) & 255));
            const created = await createMime({ ...fresh, attachments: [{ filename: 'file.bin', contentType: 'application/octet-stream', bytes, disposition: 'attachment' }] });
            const body = partBody(created.raw, 'file.bin');
            expect(body.equals(lines(bytes))).toBe(true);
            expect(body.length).toBe(base64Bytes(size)); expect(attachmentBodyBytes(size, 'application/pdf')).toBe(base64Bytes(size)); expect(attachmentBodyBytes(size, 'Message/RFC822')).toBe(size);
        }
    });
    test('one byte array may back several parts, and a view into a larger buffer is encoded alone', async () => {
        const backing = Buffer.from('xxxxPAYLOADyyyy'); const bytes = backing.subarray(4, 11);
        const created = await createMime({ ...fresh, attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', bytes, disposition: 'attachment' }, { filename: 'b.bin', contentType: 'application/octet-stream', bytes, disposition: 'attachment' }] });
        for (const name of ['a.bin', 'b.bin']) { expect(partBody(created.raw, name).toString()).toBe(Buffer.from('PAYLOAD').toString('base64')); }
        expect(backing.toString()).toBe('xxxxPAYLOADyyyy');
    });
    test('a stored base64 body is checked in slices: canonical across slice boundaries, any padding or pad bits mid-body refused', async () => {
        const header = Buffer.from(rootHeaders + 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n' + plain('x') + '\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="f.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
        const tail = Buffer.from('\r\n--b--\r\n');
        const file = Buffer.alloc(3 * 1024 * 1024 + 2, 0x5a);
        const source = (body: Buffer) => Buffer.concat([header, body, tail]);
        expect((await inspectSource(source(lines(file)))).attachments).toHaveLength(1);
        // Unwrapped, and wrapped at an odd width, the slices still split inside quanta.
        expect((await inspectSource(source(Buffer.from(file.toString('base64'))))).attachments).toHaveLength(1);
        expect((await inspectSource(source(Buffer.from(file.toString('base64').match(/.{1,61}/gu)?.join('\r\n') ?? '')))).attachments).toHaveLength(1);
        const encoded = lines(file).toString('latin1');
        await rejects(source(Buffer.from(encoded.slice(0, 2_000_000) + '=' + encoded.slice(2_000_001), 'latin1')));
        await rejects(source(Buffer.from(encoded.slice(0, -2) + 'b=', 'latin1')));
        await rejects(source(Buffer.from(encoded.slice(0, 1_500_000) + '*' + encoded.slice(1_500_001), 'latin1')));
    });
    test('retained attachment bytes count every kept part and none of the removed ones', async () => {
        const bound = await inspectSource(rich(), [{ attachmentId: 'ATT00002', hash: digest(pdfBody) }]);
        const all = retainedAttachmentBytes(bound);
        expect(all).toBe(bound.attachments.reduce((total, part) => total + part.rawBytes, 0));
        expect(retainedAttachmentBytes(bound, ['ATT00002'])).toBe(all - Buffer.byteLength(pdf()));
        expect(() => retainedAttachmentBytes(bound, ['ATT00009'])).toThrow(MimeError);
    });
    test('a 25 MiB message composes, inspects and verifies within the cap, and its patch keeps every retained byte', async () => {
        const file = Buffer.alloc(MAX_UPLOAD_BYTES, 0x41);
        const created = await createMime({ ...fresh, attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', bytes: file, disposition: 'attachment' }] });
        expect(created.raw.length).toBeGreaterThan(24 * 1024 * 1024); expect(created.raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
        verifyCandidate(created, Buffer.from(created.raw));
        const inspected = await inspectSource(created.raw, [{ attachmentId: 'ATT00001', hash: digest(partBody(created.raw, 'big.bin')) }]);
        const patched = await preparePatch(inspected, { subject: 'Renamed', attachments: [{ filename: 'small.txt', contentType: 'text/plain', bytes: Buffer.from('small'), disposition: 'attachment' }] });
        expect(patched.retainedAttachments).toHaveLength(1);
        expect(patched.raw.includes(lines(file))).toBe(true);
        const replaced = await preparePatch(inspected, { deleteAttachmentIds: ['ATT00001'], attachments: [{ filename: 'other.bin', contentType: 'application/octet-stream', bytes: file, disposition: 'attachment' }] });
        expect(replaced.retainedAttachments).toHaveLength(0);
        await expect(preparePatch(inspected, { attachments: [{ filename: 'other.bin', contentType: 'application/octet-stream', bytes: Buffer.alloc(1024 * 1024), disposition: 'attachment' }] })).rejects.toMatchObject({ code: 'mime_limit' });
    });
});
