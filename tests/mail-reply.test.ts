import { describe, expect, test } from 'bun:test';
import { deriveReply, type ReplyInput, type ReplyOriginal } from '../src/mail/reply';
import { createMime, inspectSource, preparePatch, MimeError } from '../src/mail/mime';

const original: ReplyOriginal = {
    from: [{ address: 'author@example.test', name: 'Author' }], replyTo: [{ address: 'help@example.test', name: 'Help' }],
    to: [{ address: 'me@example.test' }, { address: 'alias@example.test' }, { address: 'reader@example.test' }],
    cc: [{ address: 'READER@example.test' }, { address: 'other@example.test' }, { address: 'ME@example.test' }],
    subject: 'Original subject', messageId: '<original@example.test>', references: ['<first@example.test>', '<prior@example.test>'],
    text: 'Original <script>alert("x")</script> & text\r\nSecond line', textTruncated: false,
};
const input: ReplyInput = { original, ownedAddresses: ['me@example.test', 'alias@example.test'], mode: 'reply', body: { text: 'My response', html: '<p>My response</p>' } };
const list = (values: readonly { address: string }[]) => values.map(value => value.address);
const quoteOpen = '<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #c0c0c0;padding-left:1ex">';

describe('reply derivation', () => {
    test('reply prefers Reply-To, copies no body or Bcc, and derives bounded threading', () => {
        const result = deriveReply({ ...input, original: { ...original, bcc: [{ address: 'hidden@example.test' }] } as ReplyOriginal });
        expect(result.to).toEqual(original.replyTo);
        expect(result.cc).toEqual([]); expect(result.bcc).toEqual([]);
        expect(result.subject).toBe('Re: Original subject');
        expect(result.body).toEqual(input.body);
        expect(result.threading).toEqual({ inReplyTo: '<original@example.test>', references: ['<first@example.test>', '<prior@example.test>', '<original@example.test>'] });
        const fallback = deriveReply({ ...input, original: { ...original, replyTo: [], references: [] } });
        expect(fallback.to).toEqual(original.from);
        expect(fallback.threading.references).toEqual(['<original@example.test>']);
    });
    test('reply-all excludes every owned identity and duplicates across To/Cc but never guesses aliases', () => {
        const result = deriveReply({ ...input, mode: 'reply_all', original: { ...original, to: [...original.to, { address: 'me+list@example.test' }], bcc: [{ address: 'hidden@example.test' }] } as ReplyOriginal });
        expect(list(result.to)).toEqual(['help@example.test', 'reader@example.test', 'me+list@example.test']);
        expect(list(result.cc)).toEqual(['other@example.test']); expect(result.bcc).toEqual([]);
        expect(() => deriveReply({ ...input, mode: 'reply_all', ownedAddresses: [] })).toThrow(MimeError);
    });
    test('owned identities have a separate 1000-unique-address bound from outgoing recipients', () => {
        const ownedAddresses = ['me@example.test', 'alias@example.test', ...Array.from({ length: 998 }, (_, index) => 'owned-' + index + '@example.test')];
        const result = deriveReply({ ...input, mode: 'reply_all', ownedAddresses: [...ownedAddresses, 'ME@example.test', 'ALIAS@example.test'] });
        expect(list(result.to)).toEqual(['help@example.test', 'reader@example.test']);
        expect(list(result.cc)).toEqual(['other@example.test']);
        expect(() => deriveReply({ ...input, mode: 'reply_all', ownedAddresses: [...ownedAddresses, 'one-more@example.test'] })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, mode: 'reply_all', ownedAddresses: [...ownedAddresses.slice(0, 999), 'bad\r\nX: injected'] })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, ownedAddresses, recipients: { to: Array.from({ length: 101 }, (_, index) => ({ address: 'recipient-' + index + '@example.test' })), cc: [] } })).toThrow(MimeError);
    });
    test('simple replies to owned sent messages use external To recipients without adding Cc', () => {
        const sent = { ...original, from: [{ address: 'ME@example.test' }], replyTo: [], to: [...original.to, { address: 'READER@example.test' }, { address: 'second@example.test' }] };
        const reply = deriveReply({ ...input, original: sent });
        expect(list(reply.to)).toEqual(['reader@example.test', 'second@example.test']);
        expect(reply.cc).toEqual([]);
        expect(list(deriveReply({ ...input, mode: 'reply_all', original: sent }).to)).toEqual(['reader@example.test', 'second@example.test']);
        expect(list(deriveReply({ ...input, original: { ...sent, replyTo: [{ address: 'alias@example.test' }] } }).to)).toEqual(['reader@example.test', 'second@example.test']);
        expect(() => deriveReply({ ...input, original: { ...sent, to: [{ address: 'alias@example.test' }] } })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, original: sent, ownedAddresses: [] })).toThrow(MimeError);
    });
    test('external Reply-To wins for owned senders while explicit self recipients remain intact', () => {
        const sent = { ...original, from: [{ address: 'me@example.test' }] };
        expect(list(deriveReply({ ...input, original: sent }).to)).toEqual(['help@example.test']);
        expect(list(deriveReply({ ...input, original: { ...sent, replyTo: [{ address: 'alias@example.test' }, ...original.replyTo] } }).to)).toEqual(['help@example.test']);
        expect(list(deriveReply({ ...input, original: sent, recipients: { to: [{ address: 'me@example.test' }], cc: [] } }).to)).toEqual(['me@example.test']);
    });
    test('explicit recipients replace both lists, deduplicate and preserve deliberately requested self delivery', () => {
        const result = deriveReply({ ...input, mode: 'reply_all', recipients: { to: [{ address: 'me@example.test' }, { address: 'new@example.test' }], cc: [{ address: 'NEW@example.test' }] } });
        expect(list(result.to)).toEqual(['me@example.test', 'new@example.test']); expect(result.cc).toEqual([]);
        expect(() => deriveReply({ ...input, recipients: { to: [], cc: [] } })).toThrow(MimeError);
        const ccOnly = deriveReply({ ...input, recipients: { to: [], cc: [{ address: 'cc@example.test' }] } });
        expect(ccOnly.to).toEqual([]); expect(list(ccOnly.cc)).toEqual(['cc@example.test']);
    });
    test('deduplicates references while appending the original exactly once; preserves existing Re prefix', () => {
        const result = deriveReply({ ...input, original: { ...original, subject: 'rE: Thread', references: ['<first@example.test>', '<original@example.test>', '<first@example.test>'] } });
        expect(result.subject).toBe('rE: Thread');
        expect(result.threading.references).toEqual(['<first@example.test>', '<original@example.test>']);
    });
    test('quotes only when requested and escapes source text into an email-style HTML quote without including normalized source HTML', () => {
        const result = deriveReply({ ...input, quoteOriginal: true });
        expect(result.body.text).toBe('My response\n\n> Original <script>alert("x")</script> & text\n> Second line');
        expect(result.body.html).toBe(`<p>My response</p>${quoteOpen}Original &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; text<br>Second line</blockquote>`);
        expect(result.body.html).not.toContain('<pre>');
        const blank = deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: 'one\n\n\ntwo\n' } });
        expect(blank.body.text).toBe('My response\n\n> one\n> \n> \n> two\n> ');
        expect(blank.body.html).toBe(`<p>My response</p>${quoteOpen}one<br><br><br>two<br></blockquote>`);
        const plain = deriveReply({ ...input, quoteOriginal: true, body: { text: '', html: null } });
        expect(plain.body.html).toBe(null);
        expect(() => deriveReply({ ...input, quoteOriginal: true, original: { ...original, textTruncated: true } })).toThrow(MimeError);
        expect(deriveReply({ ...input, original: { ...original, textTruncated: true } }).body).toEqual(input.body);
    });
    test('quote indentation, aligned columns, tabs and blank lines survive HTML and MIME without doubled breaks', async () => {
        const source = '  name    count\r\n  alpha   12\n\n\tindented & <literal>\r';
        const reply = deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: source } });
        const expected = `<p>My response</p>${quoteOpen}  name    count<br>  alpha   12<br><br>    indented &amp; &lt;literal&gt;<br></blockquote>`;
        expect(reply.body.html).toBe(expected);
        expect(reply.body.html).not.toMatch(/white-space|<pre|font-family/);
        expect(reply.body.text).toBe('My response\n\n>   name    count\n>   alpha   12\n> \n> \tindented & <literal>\n> ');
        const created = await createMime({ from: { address: 'me@example.test' }, ...reply });
        const encoded = /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]*)/u.exec(created.raw.toString('latin1'))?.[1];
        expect(encoded).toBeDefined();
        const storedHtml = Buffer.from(encoded ?? '', 'base64').toString('utf8');
        expect(storedHtml).toBe(expected.replaceAll('\n', '\r\n'));
        // Explicit breaks do not depend on client white-space CSS support.
        expect(storedHtml.match(/<br>/g)).toHaveLength(4);
    });
    test('rejects quote expansion beyond paired body bounds instead of silently cutting original', () => {
        expect(() => deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: 'x'.repeat(128 * 1024) } })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: '<'.repeat(70 * 1024) } })).toThrow(MimeError);
        expect(deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: ' '.repeat(50000) } }).body.html).toContain(' '.repeat(50000));
        for (const source of ['\t'.repeat(40000), '<'.repeat(70 * 1024), 'x'.repeat(128 * 1024)]) {
            try { deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: source } }); throw new Error('Expected limit'); }
            catch (error) { expect(error).toBeInstanceOf(MimeError); expect((error as MimeError).code).toBe('mime_limit'); }
        }
        const indented = '\t' + 'x'.repeat(95) + '\n';
        const large = deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: indented.repeat(1000) } });
        expect(large.body.html).not.toContain('&nbsp;');
        expect(large.body.html).toContain(' '.repeat(4));
        expect(Buffer.byteLength(large.body.html ?? '')).toBeLessThan(256 * 1024);
        const literal = deriveReply({ ...input, quoteOriginal: true, original: { ...original, text: `&nbsp; <br> "double" 'single'` } });
        expect(literal.body.html).toEndWith(`${quoteOpen}&amp;nbsp; &lt;br&gt; &quot;double&quot; &#39;single&#39;</blockquote>`);
    });
    test('rejects malformed and injected inspected headers or derived recipients', () => {
        for (const messageId of [null, '', '<a@example.test>\r\nBcc: evil@example.test', '<a@example.test> <b@example.test>', '<a..b@example.test>', 'bare@example.test', '<a@exa mple.test>', '<a@example.test>\0']) {
            expect(() => deriveReply({ ...input, original: { ...original, messageId } })).toThrow(MimeError);
        }
        for (const id of ['<a@example.test>\nX-Evil: 1', 'not-an-id', '<a@example.test> <b@example.test>']) {
            expect(() => deriveReply({ ...input, original: { ...original, references: [id] } })).toThrow(MimeError);
        }
        for (const subject of ['Injected\r\nBcc: bad@example.test', 'control\u0001']) {
            expect(() => deriveReply({ ...input, original: { ...original, subject } })).toThrow(MimeError);
        }
        for (const recipient of [{ address: 'bad@example.test\r\nX: injected' }, { address: 'good@example.test', name: 'bad\nname' }, { address: 'not-an-email' }]) {
            expect(() => deriveReply({ ...input, recipients: { to: [recipient], cc: [] } })).toThrow(MimeError);
            expect(() => deriveReply({ ...input, original: { ...original, replyTo: [recipient] } })).toThrow(MimeError);
        }
    });
    test('rejects too many or oversized references without silently breaking threading', () => {
        const references = Array.from({ length: 100 }, (_, index) => `<ref-${index}@example.test>`);
        expect(() => deriveReply({ ...input, original: { ...original, references } })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, original: { ...original, references: [`<${'a'.repeat(321)}@example.test>`] } })).toThrow(MimeError);
        expect(() => deriveReply({ ...input, original: { ...original, references: Array.from({ length: 20 }, (_, i) => `<${i}${'a'.repeat(100)}@example.test>`) } })).toThrow(MimeError);
    });
    test('creates a new thread identity and retains derived threading through header, body and attachment edits', async () => {
        const reply = deriveReply(input);
        const created = await createMime({ from: { address: 'me@example.test' }, ...reply });
        const raw = created.raw.toString();
        expect(raw).toContain('In-Reply-To: <original@example.test>\r\n');
        expect(raw).toContain('References: <first@example.test> <prior@example.test>\r\n <original@example.test>\r\n');
        expect(raw).not.toContain('Message-ID: <original@example.test>');
        expect(raw).not.toContain('Bcc:');
        const patched = await preparePatch(await inspectSource(created.raw), {
            subject: 'Edited reply', body: { text: 'Edited body', html: null },
            to: [{ address: 'new@example.test' }], attachments: [{ filename: 'new.txt', contentType: 'text/plain', contentBase64: 'bmV3', disposition: 'attachment' }],
        });
        expect(patched.raw.toString()).toContain('In-Reply-To: <original@example.test>\r\n');
        expect(patched.raw.toString()).toContain('References: <first@example.test> <prior@example.test>\r\n <original@example.test>\r\n');
        expect((await inspectSource(patched.raw)).attachments).toHaveLength(1);
    });
    test('quoted replies reach the stored MIME with CRLF-only text and HTML, whatever line endings were supplied', async () => {
        const decode = (raw: Buffer, type: string) => [...raw.toString('latin1').matchAll(new RegExp(`Content-Type: ${type.replace('/', '\\/')}; charset=utf-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]*)`, 'gu'))]
            .map(match => Buffer.from((match[1] ?? '').replaceAll('\r\n', ''), 'base64').toString('utf8'));
        const mixedOriginal = { ...original, text: 'first\r\nsecond\nthird\rfourth' };
        for (const body of [{ text: 'My\nresponse', html: '<p>My\nresponse</p>' }, { text: 'My\r\nresponse', html: '<p>My\rresponse</p>' }]) {
            const reply = deriveReply({ ...input, original: mixedOriginal, body, quoteOriginal: true });
            const created = await createMime({ from: { address: 'me@example.test' }, ...reply });
            expect(decode(created.raw, 'text/plain')).toEqual(['My\r\nresponse\r\n\r\n> first\r\n> second\r\n> third\r\n> fourth']);
            expect(decode(created.raw, 'text/html')).toEqual([`<p>My\r\nresponse</p>${quoteOpen}first<br>second<br>third<br>fourth</blockquote>`]);
        }
        const unquoted = await createMime({ from: { address: 'me@example.test' }, ...deriveReply({ ...input, body: { text: 'a\nb', html: '<p>a\nb</p>' } }) });
        expect(decode(unquoted.raw, 'text/plain')).toEqual(['a\r\nb']); expect(decode(unquoted.raw, 'text/html')).toEqual(['<p>a\r\nb</p>']);
    });
    test('a trailing bare CR in the reply text cannot fuse with the separator before the quote', () => {
        const result = deriveReply({ ...input, body: { text: 'My response\r', html: null }, quoteOriginal: true });
        expect(result.body.text).toBe('My response\n\n\n> Original <script>alert("x")</script> & text\n> Second line');
    });
});
