/** Every caller-supplied authored field of create_draft, create_reply_draft and update_draft:
 * what the public schema accepts (after its documented normalisation) must be written by the mail
 * library, accepted by the MIME layer and read back exactly by independent parsers (nodemailer's
 * address parser, libmime and mailsplit), and what the library cannot carry must be rejected by
 * the schema, with a specific message, before any work. */
import { describe, expect, test } from 'bun:test';
import { isEmailValid } from '@hapi/address';
import libmime from 'libmime';
import { createMime, inspectSource, preparePatch, hasAttachmentReference, MIME_LIMITS, type MimeAddress, type MimeAttachment, type MimeCreate } from '../src/mail/mime';
import { mailInputSchemas, draftContentSchema, createReplyDraftInputSchema, updateDraftInputSchema, inputAddressSchema, base64AttachmentSchema, draftBodySchema, type NewAttachment } from '../src/mail/schemas';
import { decodedAddresses, partViews, rawParameters, rootHeaderLines, unfold, xorshift, type PartView } from './mime-fields';

const operationId = 'operation-id-0123456789';
const target = { uid: 1, expectedVersion: 'a'.repeat(43), operationId };
const body = { text: 'Body' };
const fresh = (over: Partial<MimeCreate> = {}): MimeCreate => ({ from: { address: 'sender@example.test' }, to: [{ address: 'to@example.test' }], cc: [], bcc: [], subject: 'S', body: { text: 'Body', html: null }, ...over });
/** A contentBase64 attachment as the schema takes it. */
interface SchemaAttachment { filename: string; contentType: string; contentBase64: string; disposition: 'attachment' | 'inline'; cid?: string | undefined }
const attach = (over: Partial<SchemaAttachment> = {}): SchemaAttachment => ({ filename: 'a.bin', contentType: 'application/octet-stream', contentBase64: 'aGk=', disposition: 'attachment', ...over });
/** The same attachment as the MIME layer takes it: its bytes decoded once, as the backend does. */
const toMime = ({ contentBase64, ...rest }: SchemaAttachment): MimeAttachment => ({ ...rest, bytes: Buffer.from(contentBase64, 'base64') });
/** These cases use only contentBase64, the source that needs no I/O to resolve. */
const inline = (values: readonly NewAttachment[] | undefined): MimeAttachment[] | undefined => values?.map(item => { if (!('contentBase64' in item)) { throw new Error('contentBase64 attachments only'); } return toMime(item); });
const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) => [...new Set(result.error?.issues.map(issue => issue.message) ?? [])];
const headerNames = (raw: Buffer) => raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1').split('\r\n').filter(line => !/^[ \t]/u.test(line)).map(line => line.slice(0, line.indexOf(':')));
const rootLines = (raw: Buffer) => raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1').split('\r\n');
/** The library folds at whitespace to 76 characters: a longer line is one unbreakable token. */
function foldedWell(lines: readonly string[]): void {
    for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(998);
        if (line.length > 78) { expect(line.slice(1).replace(/^[^:\s]+:/u, '')).not.toMatch(/\s/u); }
    }
}
const ADDRESS_KEYS = ['from', 'replyTo', 'to', 'cc', 'bcc'] as const;
const HEADER_OF = { from: 'From', replyTo: 'Reply-To', to: 'To', cc: 'Cc', bcc: 'Bcc' } as const;
const BASE_HEADERS = ['Content-Transfer-Encoding', 'Content-Type', 'Date', 'From', 'MIME-Version', 'Message-ID', 'Subject', 'To'];
const EXTRA_HEADERS = { from: [], replyTo: ['Reply-To'], to: [], cc: ['Cc'], bcc: ['Bcc'] } as const;
const withEntry = (key: (typeof ADDRESS_KEYS)[number], entry: MimeAddress): MimeCreate => fresh(key === 'from' ? { from: entry } : { [key]: [entry] });
/** The schema's view of one mailbox: what is authored. */
const accepted = (name: string, address = 'person@example.test') => inputAddressSchema.parse({ address, name });

/** Display names the schema accepts; each reads back as its normalised value. */
const NAMES = [
    'Plain Name', 'Smith, John', 'John "Johnny" Smith', "O'Brien", 'Dr. J. R. R. Tolkien', 'A (b) <c@d.e>', 'person@example.test', 'someone@else.test', 'back\\slash', 'a;b:c', '[bracket]', '<angle>', 'x, y; z: "q" (r) <s> [t] \\',
    '>,<evil@x>', '", "x" <evil@example.test>, "', 'Bcc: hidden@example.test', '"; filename="evil.exe', 'Group: a@b.c, d@e.f;', 'under_score', '?=', 'a?=b', '=', '= ?',
    'Café', 'Zoë Müller', '日本語のお名前', '😀 emoji 🎉', 'שלום עולם', 'مرحبا بالعالم', '\u200fRTL\u200e mark', 'a\u202eb', 'cafe\u0301', 'zero\u200dwidth', 'nbsp\u00a0here', 'line\u2028sep', '\ufeffbom', 'c1\u0085\u009f',
    ' leading', 'trailing ', ' both ', 'double  space', '   ', ' ', 'a  b c   d', '',
    'a'.repeat(320), 'Smith, ' + 'a'.repeat(313), 'é'.repeat(160), '日'.repeat(106), '😀'.repeat(80), 'word '.repeat(64), ('a, ').repeat(106), 'x'.repeat(100) + ' ' + 'y'.repeat(100), '"'.repeat(320), 'é' + 'a='.repeat(159),
];
describe('display names', () => {
    test('the schema trims, collapses whitespace runs and turns an empty name into no name', () => {
        expect(accepted(' both ')).toEqual({ address: 'person@example.test', name: 'both' });
        expect(accepted('a  b c   d')).toEqual({ address: 'person@example.test', name: 'a b c d' });
        expect(accepted('nbsp\u00a0 here')).toEqual({ address: 'person@example.test', name: 'nbsp here' });
        for (const name of ['', ' ', '   ', '\u00a0']) { expect(accepted(name)).toEqual({ address: 'person@example.test' }); }
        // A name equal to its address carries nothing, and readers drop it.
        for (const name of ['person@example.test', ' PERSON@Example.TEST ']) { expect(accepted(name)).toEqual({ address: 'person@example.test' }); }
        expect(accepted('someone@example.test')).toEqual({ address: 'person@example.test', name: 'someone@example.test' });
        // Idempotent: the backend parses the same input again.
        for (const name of NAMES) { const once = accepted(name); expect(inputAddressSchema.parse(once)).toEqual(once); }
    });
    for (const key of ADDRESS_KEYS) {
        test(`${key}: every accepted name is written as one header that reads back exactly and cannot add anything`, async () => {
            for (const name of NAMES) {
                const entry = accepted(name);
                const raw = (await createMime(withEntry(key, entry))).raw;
                expect(decodedAddresses(raw, HEADER_OF[key])).toEqual([{ address: entry.address, name: entry.name ?? '' }]);
                // Exactly the expected header fields exist, each once: the name added nothing.
                expect(headerNames(raw).sort()).toEqual([...BASE_HEADERS, ...EXTRA_HEADERS[key]].sort());
                foldedWell(rootLines(raw));
            }
        });
    }
    test('library examples: plain words, quoted printable ASCII and RFC 2047 words, with the domain lowered', async () => {
        const line = async (entry: MimeAddress) => rootLines((await createMime(fresh({ to: [entry] }))).raw).find(item => item.startsWith('To:'));
        expect(await line({ address: 'a@Example.TEST', name: 'Plain Name' })).toBe('To: Plain Name <a@example.test>');
        expect(await line({ address: 'a@example.test', name: 'Smith, John' })).toBe('To: "Smith, John" <a@example.test>');
        expect(await line({ address: 'a@example.test', name: 'John "Johnny" Smith' })).toBe('To: "John \\"Johnny\\" Smith" <a@example.test>');
        expect(await line({ address: 'a@example.test', name: 'someone@else.test' })).toBe('To: "someone@else.test" <a@example.test>');
        expect(await line({ address: 'a@example.test', name: 'Zoë Müller' })).toBe('To: =?UTF-8?Q?Zo=C3=AB_M=C3=BCller?= <a@example.test>');
        expect(await line({ address: 'a@example.test', name: '日本語' })).toBe('To: =?UTF-8?B?5pel5pys6Kqe?= <a@example.test>');
        expect(await line({ address: 'a@example.test' })).toBe('To: a@example.test');
    });
    test('a long recipient list folds at whitespace, never above 998 characters, and reads back', async () => {
        const list = Array.from({ length: 100 }, (_unused, index) => accepted(NAMES[index % NAMES.length] ?? '', `person-${index}@example.test`));
        const raw = (await createMime(fresh({ to: list.slice(0, 50), cc: list.slice(50) }))).raw;
        foldedWell(rootLines(raw));
        const expected = (entries: readonly MimeAddress[]) => entries.map(entry => ({ address: entry.address, name: entry.name ?? '' }));
        expect(decodedAddresses(raw, 'To')).toEqual(expected(list.slice(0, 50)));
        expect(decodedAddresses(raw, 'Cc')).toEqual(expected(list.slice(50)));
    });
    test('the schema rejects what the library cannot carry, with specific messages, in every address field of every draft tool', () => {
        const wrap = (name: string) => ({
            create_draft: ADDRESS_KEYS.map(key => draftContentSchema.safeParse({ to: [], body, subject: 'S', ...(key === 'from' ? { from: { address: 'a@example.test', name } } : { [key]: [{ address: 'a@example.test', name }] }) })),
            reply: ADDRESS_KEYS.filter(key => key === 'from' || key === 'to' || key === 'cc').map(key => createReplyDraftInputSchema.safeParse({ original: { mailboxId: 'a'.repeat(24), uid: 1 }, body, operationId, ...(key === 'from' ? { from: { address: 'a@example.test', name } } : { [key]: [{ address: 'a@example.test', name }] }) })),
            update: ADDRESS_KEYS.map(key => updateDraftInputSchema.safeParse({ ...target, ...(key === 'from' ? { from: { address: 'a@example.test', name } } : { [key]: [{ address: 'a@example.test', name }] }) })),
        });
        const rejected = [
            [['\t', '\u0001', '\u001f', '\u007f', '\n', '\r', '\0', 'bad\r\nBcc: evil@example.test'], 'Control characters are forbidden.'],
            [['\ud800', 'a\udc00b', 'x\ud83d'], 'Unpaired UTF-16 surrogates are forbidden.'],
            [['=?', '=?utf-8?q?x?=', '=?UTF-8?B?DQpCY2M6IGV2aWxAZXhhbXBsZS50ZXN0?=', 'x =? y', 'Zoë =?'], 'The sequence "=?" is not supported in this field.'],
        ] as const;
        for (const [values, message] of rejected) {
            for (const name of values) {
                for (const results of Object.values(wrap(name))) {
                    for (const result of results) { expect(result.success).toBe(false); expect(messages(result)).toEqual([message]); }
                }
            }
        }
        expect(messages(inputAddressSchema.safeParse({ address: 'a@example.test', name: 'é'.repeat(161) }))).toEqual(['At most 320 UTF-8 bytes.']);
        for (const result of Object.values(wrap('Zoë, "Z" 😀 ?= =')).flat()) { expect(result.success).toBe(true); }
        for (const result of Object.values(wrap('é'.repeat(160))).flat()) { expect(result.success).toBe(true); }
    });
    test('MIME-layer checks stay as defence in depth and are never stricter than the schema', async () => {
        for (const name of ['\t', 'a\u0001b', '\u007f', 'x\nBcc: y@example.test', '\ud800', 'é'.repeat(161)]) {
            await expect(createMime(withEntry('to', { address: 'a@example.test', name }))).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
        // A value that would not read back as given (an encoded-word look-alike, edge or repeated
        // whitespace the schema normalises away) fails closed at the read-back check.
        for (const name of ['=?utf-8?q?x?=', ' padded', 'padded ', 'a  b'.repeat(30)]) {
            await expect(createMime(withEntry('to', { address: 'a@example.test', name }))).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
    });
    test('property: seeded random schema-valid names never fail and always read back as normalised', async () => {
        const next = xorshift(0x2f6e2b1d);
        const ascii = Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index));
        const specials = ['?=', ', ', '"', '\\', '(', ')', '<', '>', '@', ';', ':', '[', ']', '  ', ' ', 'a@b.c', '<x@y.z>', '\\"', '", "', '"; filename="x', '_', '='];
        const unicode = ['é', 'ü', '日', '本', '😀', '👨‍👩‍👧', 'שלום', 'مرحبا', '\u200f', '\u202e', '\u00a0', '\u2028', '\ufeff', '\u0301', '\u0085', '\u009f', '\uffff', '\u{10ffff}'];
        const pools = [ascii, [...ascii, ...specials], [...ascii.filter(char => /[A-Za-z0-9 ]/u.test(char)), ...unicode], [...ascii, ...specials, ...unicode], [...'ab ,"'], ['é', ' ', '日'], ['x', ' '], ['é', 'a', '=', '"']];
        let read = 0, rejected = 0;
        for (let round = 0; round < 600; round++) {
            const pool = pools[next() % pools.length] ?? ascii;
            let name = '';
            for (let count = next() % 70; count > 0; count--) { name += pool[next() % pool.length]; }
            // One round in twenty-five plants a forbidden character or sequence, which the schema must refuse.
            if (next() % 25 === 0) { const at = next() % (name.length + 1); name = name.slice(0, at) + (['\t', '\u0001', '\u007f', '\ud800', '=?'][next() % 5] ?? '\t') + name.slice(at); }
            const key = ADDRESS_KEYS[next() % ADDRESS_KEYS.length] ?? 'to';
            const parsed = inputAddressSchema.safeParse({ address: 'p@example.test', name });
            if (!parsed.success) { rejected++; continue; }
            const raw = (await createMime(withEntry(key, parsed.data))).raw;
            expect(decodedAddresses(raw, HEADER_OF[key])).toEqual([{ address: 'p@example.test', name: parsed.data.name ?? '' }]);
            foldedWell(rootLines(raw));
            read++;
        }
        expect(read).toBeGreaterThan(450); expect(rejected).toBeGreaterThan(0);
    });
});

/** Attachment filenames the schema accepts; each reads back exactly. */
const FILENAMES = [
    'report.pdf', 'my report (final).pdf', 'q"uote.txt', 'semi;colon.txt', 'résumé.pdf', 'résumé_final.pdf', '日本語.txt', '😀.png', 'שלום.docx', 'a/b\\c.txt', '../../etc/passwd', 'C:\\Users\\x\\y.txt', '/absolute/path',
    'sin gle.txt', "it's.txt", '100%.txt', '50%25.txt', 'a,b.txt', '-x', '..', '.', 'x\\', '"', '\\', "'", '*', 'a*b', 'n=v', 'a=b.txt', 'x"; filename="evil.exe', 'x"\\"', 'a\u200fb.txt', 'nbsp\u00a0.txt', 'a\u2028b', 'x?=y', '=', '?',
    'x'.repeat(255), 'é'.repeat(127), '日'.repeat(85), '😀'.repeat(63), 'my report '.repeat(25).trim(), 'Q"'.repeat(127), '%'.repeat(255), '\\'.repeat(255), 'a_b '.repeat(60).trim(), 'x'.repeat(80) + '=41_?y',
];
async function onlyAttachment(filename: string, over: Partial<SchemaAttachment> = {}): Promise<{ raw: Buffer; view: PartView }> {
    const raw = (await createMime(fresh({ attachments: [toMime(attach({ filename, ...over }))] }))).raw;
    const views = await partViews(raw);
    const view = views.find(item => item.contentType === (over.contentType ?? 'application/octet-stream').toLowerCase() && item.disposition === (over.disposition ?? 'attachment'));
    if (view === undefined) { throw new Error('attachment part missing'); }
    return { raw, view };
}
describe('attachment filenames', () => {
    test('every accepted filename reads back exactly through mailsplit and libmime, with only its own parameters', async () => {
        for (const filename of FILENAMES) {
            expect(base64AttachmentSchema.parse(attach({ filename })).filename).toBe(filename);
            const { raw, view } = await onlyAttachment(filename);
            expect(view.filename).toBe(filename);
            // Both the Content-Disposition filename and the Content-Type name decode to the caller's name.
            const parameters = rawParameters(view);
            expect(libmime.decodeWords(parameters.name)).toBe(filename);
            expect(libmime.decodeWords(parameters.filename)).toBe(filename);
            expect(view.headerLines.filter(line => !/^[ \t]/u.test(line)).map(line => line.slice(0, line.indexOf(':')))).toEqual(['Content-Disposition', 'Content-Transfer-Encoding', 'Content-Type']);
            foldedWell(view.headerLines);
            // Nothing escaped the part: one attachment, one body.
            expect((await partViews(raw)).map(item => item.contentType)).toEqual(['multipart/mixed', 'text/plain', 'application/octet-stream']);
        }
    });
    test('the schema rejects controls, unpaired surrogates, "=?", edge whitespace, empty and oversized names with specific messages', () => {
        for (const filename of ['a\tb', 'a\u0001b', 'a\u007fb', 'a\nb', 'a\rb', 'a\0b', '../file\nInjected', 'x"\r\nContent-Type: text/html']) {
            expect(messages(base64AttachmentSchema.safeParse(attach({ filename })))).toEqual(['Control characters are forbidden.']);
        }
        for (const filename of ['\ud800', 'a\udc00']) { expect(messages(base64AttachmentSchema.safeParse(attach({ filename })))).toEqual(['Unpaired UTF-16 surrogates are forbidden.']); }
        for (const filename of ['=?', 'a=?utf-8?q?x?=.txt', '=?UTF-8?B?eA==?=.txt']) { expect(messages(base64AttachmentSchema.safeParse(attach({ filename })))).toEqual(['The sequence "=?" is not supported in this field.']); }
        for (const filename of [' lead.txt', 'trail.txt ', ' ', '\u00a0x', 'x\u2028']) { expect(messages(base64AttachmentSchema.safeParse(attach({ filename })))).toEqual(['File names must not start or end with whitespace.']); }
        // A long name may be folded inside a whitespace run, which every reader unfolds to one space.
        for (const filename of ['dou  ble.txt', 'a \u00a0b', 'x'.repeat(60) + '   y']) { expect(messages(base64AttachmentSchema.safeParse(attach({ filename })))).toEqual(['File names must not contain repeated whitespace.']); }
        expect(messages(base64AttachmentSchema.safeParse(attach({ filename: '   ' })))).toEqual(['File names must not start or end with whitespace.', 'File names must not contain repeated whitespace.']);
        expect(base64AttachmentSchema.safeParse(attach({ filename: '' })).success).toBe(false);
        expect(messages(base64AttachmentSchema.safeParse(attach({ filename: 'é'.repeat(128) })))).toEqual(['At most 255 UTF-8 bytes.']);
        expect(base64AttachmentSchema.safeParse(attach({ filename: 'x'.repeat(255) })).success).toBe(true);
    });
    test('defence in depth rejects the same names in the MIME layer', async () => {
        // The read-back check catches what the schema refuses: an encoded-word look-alike, edge
        // whitespace that readers trim, and a whitespace run that the library folds inside.
        for (const filename of ['', 'a\tb', 'a\nb', '\ud800', 'x'.repeat(256), 'a=?utf-8?q?x?=.txt', 'Tc>FuQ$u:wk😀QéfhB1^  `P  f.😀z&Li[";qtkFnY日<‏&IZvB&E[L Q   ZCyx9']) {
            await expect(createMime(fresh({ attachments: [toMime(attach({ filename }))] }))).rejects.toMatchObject({ code: 'invalid_mime_patch' });
        }
    });
    test('property: seeded random schema-valid filenames never fail and read back exactly', async () => {
        const next = xorshift(0x6d2b79f5);
        const ascii = Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index));
        const pieces = ['?=', '"', '\\', ';', ' ', '  ', '/', '%', "'", '*', '.', '..', '_', '=', '日', 'é', '😀', 'ß', 'שלום', '\u200f', '\u00a0', '\u2028'];
        const pools = [ascii, [...ascii, ...pieces], [...'ab._-'], [...ascii.filter(char => /[A-Za-z0-9 ]/u.test(char)), ...pieces], ['é', ' ', '日'], ['x', ' ', '"']];
        let read = 0, rejected = 0;
        for (let round = 0; round < 500; round++) {
            const pool = pools[next() % pools.length] ?? ascii;
            let filename = '';
            for (let count = next() % 120; count > 0; count--) { filename += pool[next() % pool.length]; }
            if (next() % 25 === 0) { const at = next() % (filename.length + 1); filename = filename.slice(0, at) + (['\t', '\u0001', '\u007f', '\ud800', '=?'][next() % 5] ?? '\t') + filename.slice(at); }
            if (!base64AttachmentSchema.safeParse(attach({ filename })).success) { rejected++; continue; }
            const { view } = await onlyAttachment(filename);
            expect(view.filename).toBe(filename);
            expect(libmime.decodeWords(rawParameters(view).name)).toBe(filename);
            foldedWell(view.headerLines);
            read++;
        }
        expect(read).toBeGreaterThan(200); expect(rejected).toBeGreaterThan(0);
    });
});

const CONTENT_TYPES = ['application/pdf', 'APPLICATION/PDF', 'Image/PNG', 'image/svg+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel.sheet.macroEnabled.12', 'application/pgp-keys', 'application/pgp-signature', 'application/pkcs7-signature', 'application/x-pkcs7-mime', 'application/pkcs7-mime', 'application/octet-stream', "x/y'z", 'a/b', '!#$%&*+.^_`|~-/!#$%&*+.^_`|~-', 'text/plain', 'text/calendar', 'text/html', 'message/rfc822', 'MESSAGE/RFC822', 'application/' + 'x'.repeat(243)];
describe('content types', () => {
    test('every accepted type is written lower case and read back; PGP and S/MIME files attach like any other', async () => {
        for (const contentType of CONTENT_TYPES) {
            expect(base64AttachmentSchema.safeParse(attach({ contentType })).success).toBe(true);
            const { raw, view } = await onlyAttachment('f.bin', { contentType });
            expect(view.contentType).toBe(contentType.toLowerCase());
            foldedWell(view.headerLines);
            // The written message is an ordinary draft: it inspects and keeps its attachment.
            expect((await inspectSource(raw)).attachments).toHaveLength(1);
        }
    });
    test('the schema rejects what has no safe single-part form, with one message', () => {
        const message = 'Content type must be type/subtype without parameters; multipart/* and message/* other than message/rfc822 are not supported.';
        for (const contentType of ['multipart/mixed', 'MULTIPART/related', 'message/partial', 'message/external-body', 'message/delivery-status', 'Message/Global', 'text/plain; charset=utf-8', 'text', 'a/b/c', '/b', 'a/', 'a b/c', 'application/pdf\r\nX: y', 'é/x', '']) {
            expect(messages(base64AttachmentSchema.safeParse(attach({ contentType })))).toEqual([message]);
        }
        expect(messages(base64AttachmentSchema.safeParse(attach({ contentType: 'a/' + 'b'.repeat(254) })))).toContain('Too big: expected string to have <=255 characters');
        for (const disposition of ['', 'Attachment', 'form-data', 'attachment; filename=x']) { expect(base64AttachmentSchema.safeParse(attach({ disposition: disposition as 'inline' })).success).toBe(false); }
        expect(base64AttachmentSchema.parse({ filename: 'a', contentType: 'a/b', contentBase64: '' }).disposition).toBe('attachment');
    });
    test('text/plain and text/html inline parts are rejected up front because readers take them for the body', async () => {
        const message = 'Inline text/plain and text/html attachments cannot be told from the body; use disposition attachment.';
        for (const contentType of ['text/plain', 'TEXT/HTML']) {
            expect(messages(base64AttachmentSchema.safeParse(attach({ contentType, disposition: 'inline', cid: 'x@y' })))).toEqual([message]);
            await expect(createMime(fresh({ attachments: [toMime(attach({ contentType, disposition: 'inline', cid: 'x@y' }))] }))).rejects.toMatchObject({ code: 'invalid_mime_patch' });
            expect(base64AttachmentSchema.safeParse(attach({ contentType, disposition: 'attachment', cid: 'x@y' })).success).toBe(true);
        }
        expect(base64AttachmentSchema.safeParse(attach({ contentType: 'text/calendar', disposition: 'inline', cid: 'x@y' })).success).toBe(true);
    });
    test('message/rfc822 needs CRLF line endings because it is stored with an identity encoding', async () => {
        const message = 'message/rfc822 content must use CRLF line endings.';
        const eml = (text: string) => Buffer.from(text).toString('base64');
        for (const content of ['From: a@b.c\nSubject: x\n\nbody\n', 'a\r\nb\n', '\n']) { expect(messages(base64AttachmentSchema.safeParse(attach({ contentType: 'message/rfc822', contentBase64: eml(content) })))).toEqual([message]); }
        for (const content of ['From: a@b.c\r\nSubject: x\r\n\r\nbody\r\n', '', 'no line breaks', 'a\r\nb\r\n']) {
            expect(base64AttachmentSchema.safeParse(attach({ contentType: 'message/rfc822', contentBase64: eml(content) })).success).toBe(true);
            await createMime(fresh({ attachments: [toMime(attach({ contentType: 'message/rfc822', contentBase64: eml(content) }))] }));
        }
        // The MIME layer applies the same rule to bytes from any source, as the caller's error.
        for (const content of ['From: a@b.c\nSubject: x\n\nbody\n', 'a\r\nb\n', '\n']) {
            await expect(createMime(fresh({ attachments: [toMime(attach({ contentType: 'message/rfc822', contentBase64: eml(content) }))] }))).rejects.toMatchObject({ code: 'invalid_attachment' });
        }
        expect(base64AttachmentSchema.safeParse(attach({ contentType: 'application/octet-stream', contentBase64: eml('a\nb\n') })).success).toBe(true);
    });
});

const CIDS = ['x', 'logo@example.test', 'a.b.c', 'a..b', '!#$%&\'*+-/=?^_`{|}~', 'A-Z_0-9', '1', '@', '.', 'part1.123@host.example', 'x'.repeat(255), 'a@' + 'b'.repeat(253)];
describe('content ids', () => {
    test('every accepted cid is written as one Content-ID and read back, long ones on a continuation line', async () => {
        for (const cid of CIDS) {
            expect(base64AttachmentSchema.safeParse(attach({ contentType: 'image/png', disposition: 'inline', cid })).success).toBe(true);
            const { raw, view } = await onlyAttachment('i.png', { contentType: 'image/png', disposition: 'inline', cid });
            expect(view.contentId).toBe(`<${cid}>`);
            expect(view.headerLines.join('\r\n')).toContain(`<${cid}>`);
            expect((await inspectSource(raw)).attachments.map(part => part.cid)).toEqual([cid]);
        }
    });
    test('the schema rejects every character a Content-ID cannot carry, with one message', () => {
        const message = 'CID may contain only letters, digits and ! # $ % & \' * + - . / = ? ^ _ ` { | } ~ @.';
        for (const cid of ['a b', 'a<b>', '<x>', 'a"b', 'a(b)', 'a,b', 'a:b', 'a;b', 'a[b]', 'a\\b', 'é', '日本', '😀', 'a\tb', 'a\nb', 'a\r\nX: y', 'a\0b', 'a\u007fb', 'a\u00a0b', '\ud800']) {
            expect(messages(base64AttachmentSchema.safeParse(attach({ contentType: 'image/png', disposition: 'inline', cid })))).toContain(message);
        }
        expect(base64AttachmentSchema.safeParse(attach({ cid: '' })).success).toBe(false);
        expect(base64AttachmentSchema.safeParse(attach({ cid: 'x'.repeat(256) })).success).toBe(false);
        expect(messages(base64AttachmentSchema.safeParse(attach({ disposition: 'inline' })))).toEqual(['Inline attachments require a CID.']);
    });
    test('property: seeded random cids from the accepted alphabet never fail and read back exactly', async () => {
        const next = xorshift(0x1234abcd);
        const alphabet = [...'ABCabc019.!#$%&\'*+/=?^_`{|}~@-'];
        for (let round = 0; round < 200; round++) {
            let cid = '';
            for (let count = 1 + next() % 255; count > 0; count--) { cid += alphabet[next() % alphabet.length]; }
            expect(base64AttachmentSchema.safeParse(attach({ contentType: 'image/png', disposition: 'inline', cid })).success).toBe(true);
            expect((await onlyAttachment('i.png', { contentType: 'image/png', disposition: 'inline', cid })).view.contentId).toBe(`<${cid}>`);
        }
    });
});

describe('body text', () => {
    test('unpaired surrogates are rejected up front; prose about attachment:ATT ids and all other text is accepted', () => {
        for (const kind of ['markdown', 'html', 'text'] as const) {
            expect(messages(draftBodySchema.safeParse({ [kind]: 'a\ud800b' }))).toContain('Unpaired UTF-16 surrogates are forbidden.');
            expect(draftBodySchema.safeParse({ [kind]: 'tab\tNUL\0 CR\r LF\n 日本 😀 attachment:ATT00001 and attachment:ATT2 =?utf-8?q?x?=' }).success).toBe(true);
        }
        const message = 'HTML must not use attachment:ATTn URLs in tag attributes; reference attached images as cid: URLs.';
        for (const html of ['<img src="attachment:ATT00001">', "<img src = 'attachment:ATT1'>", '<a href=attachment:ATT9>x</a>', '<img alt="x" src=" ATTACHMENT:att1">'.replace('att1', 'ATT1')]) {
            expect(messages(draftBodySchema.safeParse({ html }))).toEqual([message]);
        }
        for (const html of ['<p>see attachment:ATT1</p>', '<p title="a">x = attachment:ATT1</p>', '<a href="https://example.test/attachment:ATT1">x</a>', '<img src="cid:logo">']) { expect(draftBodySchema.safeParse({ html }).success).toBe(true); }
    });
    test('the attachment reference scan is linear on hostile input', () => {
        const started = performance.now();
        for (const hostile of ['<'.repeat(250_000), '<a=' + ' '.repeat(250_000), '<' + '='.repeat(250_000), '<a ' + '= '.repeat(100_000) + '>', '<>'.repeat(120_000)]) { expect(hasAttachmentReference(hostile)).toBe(false); }
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

describe('subjects', () => {
    test('controls, unpaired surrogates, "=?" and over-long words are rejected up front with specific messages', () => {
        const cases = [
            [['a\ud800b', '\udc00'], 'Unpaired UTF-16 surrogates are forbidden.'],
            [['=?', 'Price =?UTF-8?B?SGk=?= ok', 'a=?b'], 'The sequence "=?" is not supported in this field.'],
            [['y'.repeat(901), 'Re: ' + 'x'.repeat(1000) + ' end', 'é ' + '!'.repeat(901)], 'Subject words longer than 900 characters are not supported.'],
        ] as const;
        for (const [subjects, message] of cases) {
            for (const subject of subjects) {
                expect(messages(draftContentSchema.safeParse({ to: [], body, subject }))).toEqual([message]);
                expect(messages(updateDraftInputSchema.safeParse({ ...target, subject }))).toEqual([message]);
            }
        }
        for (const subject of ['y'.repeat(900), ('w'.repeat(900) + ' ').repeat(2).trim(), '日'.repeat(682), 'é'.repeat(1024), '?= =']) { expect(draftContentSchema.safeParse({ to: [], body, subject }).success).toBe(true); }
    });
    test('search filters are queries, not authored headers, and keep their own rule', () => {
        for (const filter of ['from', 'to', 'subject'] as const) { expect(mailInputSchemas.search_messages.safeParse({ [filter]: 'a\tb' }).success).toBe(true); }
    });
});

describe('addresses', () => {
    test('every ASCII address the pinned recipient validator accepts is accepted and written with only its domain lowered', async () => {
        const next = xorshift(0x51f15e);
        const atext = [...'abcXYZ019!#$%&\'*+/=?^_`{|}~-'];
        const labels = [...'abcXYZ019-'];
        let accepted = 0;
        for (let round = 0; round < 600; round++) {
            const part = (alphabet: string[], size: number) => Array.from({ length: 1 + next() % size }, () => alphabet[next() % alphabet.length]).join('');
            const local = Array.from({ length: 1 + next() % 3 }, () => part(atext, 12)).join('.');
            const domain = Array.from({ length: 2 + next() % 3 }, () => part(labels, 14)).join('.');
            const address = `${local}@${domain}`;
            expect(inputAddressSchema.safeParse({ address }).success).toBe(isEmailValid(address, { tlds: false } as never));
            if (!inputAddressSchema.safeParse({ address }).success) { continue; }
            accepted++;
            const raw = (await createMime(fresh({ to: [{ address }] }))).raw;
            expect(decodedAddresses(raw, 'To')).toEqual([{ address: `${local}@${domain.toLowerCase()}`, name: '' }]);
        }
        expect(accepted).toBeGreaterThan(200);
    });
    test('non-ASCII addresses that the pinned validator accepts are rejected by the schema with their own message', () => {
        const message = 'Only ASCII email addresses are supported; write an internationalised domain in its xn-- form.';
        for (const address of ['jürgen@example.test', 'a@bücher.example', '用户@例子.广告', 'a@xn--bcher-kva.example'.replace('xn--bcher-kva', 'bücher')]) {
            expect(isEmailValid(address, { tlds: false } as never)).toBe(true);
            expect(messages(inputAddressSchema.safeParse({ address }))).toEqual([message]);
            expect(messages(draftContentSchema.safeParse({ to: [{ address }], body, subject: 'S' }))).toEqual([message]);
        }
        expect(inputAddressSchema.safeParse({ address: 'a@xn--bcher-kva.example' }).success).toBe(true);
    });
    test('the schema keeps header injection out of addresses', () => {
        for (const address of ['a@example.test\r\nBcc: x@example.test', 'a@example.test\n', 'a@example.test, b@example.test', 'Name <a@example.test>', '"a@b"@example.test']) { expect(inputAddressSchema.safeParse({ address }).success).toBe(false); }
        expect(isEmailValid('a@example.test', { tlds: false } as never)).toBe(true);
    });
});

describe('injection', () => {
    test('hostile but legal names and filenames stay inside their own field', async () => {
        const hostile = ['x\\"\r\nBcc: evil@example.test', '>,<evil@example.test>', '", "x" <evil@example.test>, "', 'a" <evil@example.test>; b="', '=?UTF-8?B?DQpCY2M6IGV2aWxAZXhhbXBsZS50ZXN0?=', 'Group: a@b.c, d@e.f;', '"; filename="evil.exe', 'x"\\'];
        for (const name of hostile) {
            const parsed = draftContentSchema.safeParse({ to: [{ address: 'to@example.test', name }], cc: [{ address: 'cc@example.test', name }], subject: name, body, attachments: [attach({ filename: name })] });
            if (/[\r\n]|=\?/u.test(name)) { expect(parsed.success).toBe(false); continue; }
            if (!parsed.success) { throw new Error('schema rejected a legal value'); }
            const raw = (await createMime({ ...parsed.data, attachments: inline(parsed.data.attachments), from: { address: 'sender@example.test' }, body: { text: 'Body', html: null } })).raw;
            expect(decodedAddresses(raw, 'To')).toEqual([{ address: 'to@example.test', name }]);
            expect(decodedAddresses(raw, 'Cc')).toEqual([{ address: 'cc@example.test', name }]);
            expect(headerNames(raw).filter(header => /^bcc$/iu.test(header))).toEqual([]);
            expect(libmime.decodeWords(unfold(rootHeaderLines(raw, 'Subject')))).toBe(name);
            expect((await partViews(raw)).map(item => item.filename)).toEqual(['', '', name]);
            const inspected = await inspectSource(raw);
            expect(inspected.envelope.to.map(item => item.address)).toEqual(['to@example.test']);
            expect(inspected.envelope.cc.map(item => item.address)).toEqual(['cc@example.test']);
            expect(inspected.envelope.bcc).toEqual([]);
        }
    });
});

describe('limits', () => {
    test('a maximal schema-valid draft is accepted by the MIME layer: 151 mailboxes with the largest encodings and 100 attachments with long names', async () => {
        const address = (index: number) => `${'u'.repeat(60)}${String(index).padStart(4, '0')}@${['x'.repeat(63), 'y'.repeat(63), 'z'.repeat(57), 'com'].join('.')}`;
        // Measured worst case: Q-encoding triples each "=" of a mostly-Latin name, B-encoding CJK file names.
        const name = 'é' + 'a='.repeat(159);
        const list = (count: number) => Array.from({ length: count }, (_unused, index) => ({ address: address(index), name }));
        const attachments = Array.from({ length: 100 }, (_unused, index) => ({ filename: '日'.repeat(85), contentType: `application/${'t'.repeat(243)}`, contentBase64: '', disposition: index % 2 ? 'inline' : 'attachment', cid: `${index}${'c'.repeat(252)}` }));
        const parsed = draftContentSchema.safeParse({ from: { address: address(999), name }, replyTo: list(50), to: list(50), cc: list(50), subject: '日'.repeat(682), body: { text: 'x' }, attachments });
        expect(messages(parsed)).toEqual([]);
        const input = parsed.data;
        if (input === undefined) { throw new Error('schema rejected the maximal draft'); }
        const created = await createMime({ ...input, attachments: inline(input.attachments), from: input.from ?? { address: 'a@example.test' }, body: { text: 'x', html: null } });
        const root = created.raw.indexOf('\r\n\r\n') + 4;
        expect(root).toBeGreaterThan(170_000); expect(root).toBeLessThan(MIME_LIMITS.headerBytes);
        const views = await partViews(created.raw);
        const total = views.reduce((sum, view) => sum + view.headerLines.join('\r\n').length + 4, 0);
        expect(total).toBeGreaterThan(380_000); expect(total).toBeLessThan(MIME_LIMITS.totalHeaderBytes);
        expect(created.envelope.to).toHaveLength(50); expect(created.envelope.cc).toHaveLength(50); expect(created.envelope.replyTo).toHaveLength(50);
        expect(created.retainedAttachments).toHaveLength(0);
        expect((await inspectSource(created.raw)).attachments).toHaveLength(100);
    });
});

describe('patches author the same bytes', () => {
    test('update_draft patch writes Unicode names and filenames and preserves everything else', async () => {
        const original = await createMime(fresh({ to: [{ address: 'to@example.test', name: 'Old' }], subject: 'Subject', attachments: [toMime(attach({ filename: 'keep.bin' }))] }));
        const inspected = await inspectSource(original.raw);
        const patch = updateDraftInputSchema.parse({ ...target, to: [{ address: 'new@example.test', name: 'Zoë "Z", 日本 😀' }], from: { address: 'sender@example.test', name: 'a ?= b' }, replyTo: [{ address: 'r@example.test', name: ' padded ' }], attachments: [{ filename: 'résumé "final"; 100%.pdf', contentType: 'application/pdf', contentBase64: 'aGk=' }] });
        const patched = await preparePatch(inspected, { to: patch.to, from: patch.from, replyTo: patch.replyTo, attachments: inline(patch.attachments) });
        expect(decodedAddresses(patched.raw, 'To')).toEqual([{ address: 'new@example.test', name: 'Zoë "Z", 日本 😀' }]);
        expect(decodedAddresses(patched.raw, 'From')).toEqual([{ address: 'sender@example.test', name: 'a ?= b' }]);
        expect(decodedAddresses(patched.raw, 'Reply-To')).toEqual([{ address: 'r@example.test', name: 'padded' }]);
        expect((await partViews(patched.raw)).map(view => view.filename)).toEqual(['', '', 'keep.bin', 'résumé "final"; 100%.pdf']);
        expect(patched.retainedAttachments).toEqual(inspected.attachments);
        // The multipart Content-Type line is this layer's own, not an authored field.
        foldedWell(rootLines(patched.raw).filter(line => !line.startsWith('Content-Type:')));
    });
    test('drafts written by earlier versions still inspect and patch byte-stably', async () => {
        // Names and parameters as earlier versions wrote them, plus PGP and S/MIME file attachments.
        const old = Buffer.from([
            'From: =?UTF-8?Q?Zo=C3=AB?= <sender@example.test>', 'To: "Smith, John" <a@example.test>, plain <b@example.test>', 'Subject: Old', 'Message-ID: <old@example.test>', 'Date: Mon, 26 Oct 2026 00:00:00 +0000', 'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 7bit', '', 'hello', '--B', 'Content-Type: application/pgp-keys', 'Content-Disposition: attachment; filename=key.asc', 'Content-Transfer-Encoding: base64', '', 'aGk=',
            '--B', 'Content-Type: application/pkcs7-signature; name=smime.p7s', 'Content-Disposition: attachment; filename=smime.p7s', 'Content-Transfer-Encoding: base64', '', 'aGk=',
            '--B', 'Content-Type: application/pdf; name="=?UTF-8?Q?r=C3=A9sum=C3=A9=2Epdf?="', "Content-Disposition: attachment; filename*0*=utf-8''r%C3%A9sum%C3%A9.pdf", 'Content-Transfer-Encoding: base64', '', 'aGk=', '--B--', ''].join('\r\n'));
        const inspected = await inspectSource(old);
        expect(inspected.attachments).toHaveLength(3);
        const patched = await preparePatch(inspected, { subject: 'New' });
        expect(patched.raw.subarray(patched.raw.indexOf('\r\n\r\n')).equals(old.subarray(old.indexOf('\r\n\r\n')))).toBe(true);
        expect((await partViews(patched.raw)).map(view => view.filename)).toEqual(['', '', 'key.asc', 'smime.p7s', 'résumé.pdf']);
    });
    test('a root PGP or S/MIME body and signed or encrypted trees are still refused', async () => {
        const headers = 'From: a@example.test\r\nTo: b@example.test\r\nSubject: x\r\nMIME-Version: 1.0\r\n';
        for (const tail of ['Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\nContent-Transfer-Encoding: base64\r\n\r\naGk=\r\n', 'Content-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n',
            'Content-Type: multipart/signed; boundary="S"; protocol="application/pgp-signature"\r\n\r\n--S\r\nContent-Type: text/plain\r\n\r\nhi\r\n--S\r\nContent-Type: application/pgp-signature\r\n\r\nsig\r\n--S--\r\n',
            'Content-Type: multipart/encrypted; boundary="E"; protocol="application/pgp-encrypted"\r\n\r\n--E\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--E\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n--E--\r\n']) {
            await expect(inspectSource(Buffer.from(headers + tail))).rejects.toMatchObject({ code: 'unsupported_mime' });
        }
    });
});
