/** Authored drafts through the real WildDuck parser and rebuilder, in process: WildDuck stores a
 * message as the tree imap-core's indexer parses and serves the bytes it rebuilds from that tree,
 * so rebuilt bytes must equal the prepared bytes exactly. Needs a WildDuck checkout with its
 * dependencies installed (no network or database); set WILDDUCK_CHECKOUT, or keep one beside this
 * repository. Without a checkout these tests are skipped, as in CI, but a WILDDUCK_CHECKOUT that is set
 * and unusable fails the run. */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { Readable } from 'node:stream';
import libmime from 'libmime';
import { createMime, inspectSource, preparePatch, type MimeAttachment, type MimeCreate } from '../src/mail/mime';
import { authoredParts } from './mime-text';

// An empty WILDDUCK_CHECKOUT counts as unset, so a CI variable that expands to nothing still skips.
const requested = process.env['WILDDUCK_CHECKOUT'] ?? '';
const explicit = requested !== '';
const checkout = explicit ? requested : resolve(import.meta.dir, '../../wildduck');
const indexerPath = join(checkout, 'imap-core/lib/indexer/indexer.js');
const available = existsSync(indexerPath) && existsSync(join(checkout, 'node_modules/libmime'));
interface Tree { parsedHeader: Record<string, unknown> }
interface Indexer { parseMimeTree(raw: Buffer): Tree; rebuild(tree: Tree, textOnly: boolean, options: object): { value: Readable }; getMaildata(tree: Tree): { text: string; attachments: { filename: string }[] } }
const indexer = (): Indexer => {
    const Constructor = createRequire(join(checkout, 'package.json'))('./imap-core/lib/indexer/indexer.js') as new (options: object) => Indexer;
    return new Constructor({});
};
/** What WildDuck stores and serves back for an uploaded message. */
async function stored(raw: Buffer): Promise<{ rebuilt: Buffer; subject: string; text: string; filenames: string[] }> {
    const wildduck = indexer();
    const rebuilt = await buffer(wildduck.rebuild(wildduck.parseMimeTree(raw), false, {}).value);
    // A fresh tree: getMaildata moves attachment bodies out of the one it reads.
    const tree = wildduck.parseMimeTree(raw);
    const subject = libmime.decodeWords(String([tree.parsedHeader['subject'] ?? ''].flat().pop() ?? '').trim());
    const maildata = wildduck.getMaildata(tree);
    return { rebuilt, subject, text: maildata.text, filenames: maildata.attachments.map(item => item.filename) };
}

const base: MimeCreate = { from: { address: 'sender@example.test', name: 'Zoë Sender' }, to: [{ address: 'to@example.test', name: '日本語のお名前' }], cc: [{ address: 'cc@example.test', name: 'Smith, John "JJ"' }], bcc: [], subject: 'Plain subject', body: { text: 'Hello\n', html: null } };
const file = (filename: string, over: Partial<MimeAttachment> = {}): MimeAttachment => ({ filename, contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.7 ' + filename).toString('base64'), disposition: 'attachment', ...over });
const SUBJECTS = { plain: 'Plain subject', latin: 'Résumé café, déjà vu', cjk: '新しい件名です', folded: 'A long subject that the library folds at the spaces between its words '.repeat(4).trim() };
const BODIES = {
    '7bit': 'Hello there,\nplain ASCII text.\n',
    'quoted-printable': 'Résumé attached; see the café notes for details.\nThanks!\n',
    'quoted-printable without a final line break': 'Résumé attached; see the café notes for details. Thanks!',
    base64: '新しい本文です。\n二行目です。\n',
};
const STRUCTURES = {
    single: {},
    alternative: { html: true },
    mixed: { attachments: [file('résumé final.pdf')] },
    related: { html: true, attachments: [file('logo.png', { contentType: 'image/png', disposition: 'inline', cid: 'logo@example.test' })] },
} as const;

// A set WILDDUCK_CHECKOUT that cannot be used fails here rather than silently skipping every case below.
if (explicit) {
    test(`WILDDUCK_CHECKOUT is a usable WildDuck checkout: ${checkout}`, () => {
        if (!available) { throw new Error(`WILDDUCK_CHECKOUT=${checkout} is not a usable WildDuck checkout: ${indexerPath} and ${join(checkout, 'node_modules/libmime')} must both exist`); }
        try { indexer(); } catch (error) { throw new Error(`WILDDUCK_CHECKOUT=${checkout} is not a usable WildDuck checkout: ${indexerPath} cannot be required: ${error instanceof Error ? error.message : String(error)}`); }
    });
}
describe.skipIf(!available)(`WildDuck stores authored drafts byte for byte (skipped without a WildDuck checkout at ${checkout})`, () => {
    for (const [structure, shape] of Object.entries(STRUCTURES)) {
        for (const [encoding, text] of Object.entries(BODIES)) {
            for (const [form, subject] of Object.entries(SUBJECTS)) {
                test(`${structure}, ${encoding} text, ${form} subject`, async () => {
                    const html = 'html' in shape ? `<p>${text}</p>` : null;
                    const input: MimeCreate = { ...base, subject, body: { text, html }, attachments: 'attachments' in shape ? shape.attachments : [] };
                    const created = await createMime(input);
                    // The selection rule picked the encoding under test for the plain-text part.
                    expect(authoredParts(created.raw)[0]?.encoding).toBe(encoding.startsWith('quoted') ? 'quoted-printable' : encoding as 'base64');
                    const result = await stored(created.raw);
                    expect(result.rebuilt.equals(created.raw)).toBe(true);
                    expect(result.subject).toBe(subject);
                    expect(result.text).toBe(text.replaceAll('\n', '\r\n').trim());
                    if ('attachments' in shape && structure === 'mixed') { expect(result.filenames).toEqual(['résumé final.pdf']); }
                    // A header patch and a body patch of the stored draft are stored byte for byte too.
                    const inspected = await inspectSource(result.rebuilt);
                    for (const patch of [{ subject: SUBJECTS.cjk, to: [{ address: 'new@example.test', name: 'Jürgen Müller' }] }, { body: { text: text + '\nedited', html } }]) {
                        const patched = await preparePatch(inspected, patch);
                        expect((await stored(patched.raw)).rebuilt.equals(patched.raw)).toBe(true);
                    }
                });
            }
        }
    }
    test('Unicode display names and file names, and new attachments on a single-part draft', async () => {
        const created = await createMime({ ...base, body: { text: 'Body', html: null }, attachments: [file('日本語の資料.pdf'), file('😀 emoji.png'), file('my report (final) "v2"; 100%.pdf'), file('x'.repeat(200) + '.bin')] });
        const result = await stored(created.raw);
        expect(result.rebuilt.equals(created.raw)).toBe(true);
        expect(result.filenames).toEqual(['日本語の資料.pdf', '😀 emoji.png', 'my report (final) "v2"; 100%.pdf', 'x'.repeat(200) + '.bin']);
        const single = await createMime({ ...base, subject: SUBJECTS.folded, body: { text: 'No final line break', html: null } });
        expect((await stored(single.raw)).rebuilt.equals(single.raw)).toBe(true);
        const wrapped = await preparePatch(await inspectSource(single.raw), { attachments: [file('résumé.pdf')], body: { text: 'é without a final line break', html: null } });
        expect((await stored(wrapped.raw)).rebuilt.equals(wrapped.raw)).toBe(true);
    });
});
