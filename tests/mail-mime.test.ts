import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createMime, inspectSource, preparePatch, verifyCandidate, MIME_LIMITS, MimeError, type MimeCreate } from '../src/mail/mime';

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
            { filename: 'Résumé.pdf', contentType: 'application/pdf', contentBase64: pdfBody, disposition: 'attachment' },
            { filename: 'new.png', contentType: 'image/png', contentBase64: 'AAEC', disposition: 'inline', cid: 'new@example.test' },
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
            { filename: 'a.txt', contentType: 'text/plain', contentBase64: '', disposition: 'attachment' },
            { filename: 'a.png', contentType: 'image/png', contentBase64: 'AA==', disposition: 'inline', cid: 'second@example.test' },
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
        const candidate = await createMime({ ...fresh, body: { text: '', html: '<img src="data:image/png;base64,AA=="><img src="https://example.test/a">' }, attachments: [{ filename: 'empty.bin', contentType: 'application/octet-stream', contentBase64: '', disposition: 'attachment' }] });
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
            const attachment = { filename: 'new.eml', contentType: 'message/rfc822', contentBase64: fixture.bytes.toString('base64'), disposition: 'attachment' as const };
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
        const attachment = { filename: 'new.eml', contentType: 'message/rfc822', contentBase64: bytes.toString('base64'), disposition: 'attachment' as const };
        await expect(createMime({ ...fresh, attachments: [attachment] })).rejects.toBeInstanceOf(MimeError);
        const source = await inspectSource(rich());
        await expect(preparePatch(source, { attachments: [attachment] })).rejects.toBeInstanceOf(MimeError);
        const collision = Buffer.from('From: attached@example.test\r\n\r\nbody\r\n--mixed-B\r\nContent-Type: application/octet-stream\r\n\r\nfake sibling');
        await expect(preparePatch(source, { attachments: [{ ...attachment, contentBase64: collision.toString('base64') }] })).rejects.toBeInstanceOf(MimeError);
    });
    test('unsupported new message subtypes reject during create and add preflight', async () => {
        const source = await inspectSource(rich());
        for (const contentType of ['message/partial', 'message/external-body', 'message/global', 'message/delivery-status', 'message/x-unknown', 'MeSsAgE/PaRtIaL']) {
            const attachment = { filename: 'message.dat', contentType, contentBase64: Buffer.from('opaque bytes').toString('base64'), disposition: 'attachment' as const };
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
        await expect(preparePatch(source, { attachments: [{ filename: 'duplicate.png', contentType: 'image/png', contentBase64: 'AA==', disposition: 'inline', cid: 'logo@example.test' }] })).rejects.toBeInstanceOf(MimeError);
        await expect(preparePatch(source, { body: { text: 'new', html: '<img src="cid:logo@example.test">' }, deleteAttachmentIds: ['ATT00001'] })).rejects.toBeInstanceOf(MimeError);
        const authored = await preparePatch(source, { body: { text: 'new', html: '<p>New HTML with no image</p>' }, deleteAttachmentIds: ['ATT00001'] });
        expect(authored.raw.includes(Buffer.from(logo))).toBe(false);
        expect(authored.raw.toString()).toContain('Content-Type: text/html');
        const converted = await preparePatch(source, { body: { text: 'plain', html: null }, deleteAttachmentIds: ['ATT00001'] });
        expect(converted.raw.includes(Buffer.from(logo))).toBe(false);
    });
    test('header injection and noncanonical base64 fail, including nonzero pad bits', async () => {
        const source = await inspectSource(rich());
        for (const patch of [{ subject: 'bad\r\nBcc: evil@example.test' }, { from: { address: 'x@example.test\r\nX: bad' } }, { to: [{ address: 'x@example.test', name: 'bad\nName' }] }]) {await expect(preparePatch(source, patch)).rejects.toBeInstanceOf(MimeError);}
        for (const contentBase64 of ['AA', 'AB==', 'AA==\n', '!!!!', 'AAA=AAAA']) {await expect(createMime({ ...fresh, attachments: [{ filename: 'x', contentType: 'application/octet-stream', contentBase64, disposition: 'attachment' }] })).rejects.toBeInstanceOf(MimeError);}
        await expect(preparePatch(source, { body: { text: 'x', html: '<img src="attachment:ATT00001">' } })).rejects.toBeInstanceOf(MimeError);
    });
    test('source, decoded attachments, header, node and nesting caps', async () => {
        await rejects(Buffer.alloc(MIME_LIMITS.sourceBytes + 1));
        await rejects(rootHeaders + 'X-Long: ' + 'x'.repeat(MIME_LIMITS.headerBytes) + '\r\n' + plain());
        await rejects(rich(Array.from({ length: 130 }, () => pdf())));
        let nested = Buffer.from(plain()); for (let i = 0; i < 14; i++) {nested = multi('mixed', 'deep-' + i, [nested]);}
        await rejects(Buffer.concat([Buffer.from(rootHeaders), nested]));
        const big = Buffer.alloc(MIME_LIMITS.attachmentBytes + 1).toString('base64');
        await expect(createMime({ ...fresh, attachments: [{ filename: 'big', contentType: 'application/octet-stream', contentBase64: big, disposition: 'attachment' }] })).rejects.toBeInstanceOf(MimeError);
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
