import MarkdownIt from 'markdown-it';
import { decodeHTML, decodeHTMLStrict } from 'entities';
import { DomHandler, ElementType, Parser } from 'htmlparser2';
import { MailError } from './contracts';
import type { MimeBody } from './mime';

/** Exactly one key; the value is the body in that format. */
export type BodyInput = { readonly markdown: string } | { readonly html: string } | { readonly text: string };

/** Two short sentences for tool descriptions. Keep in step with createMarkdown() below. */
export const MARKDOWN_FLAVOR = 'CommonMark with GFM-style tables, ~~strikethrough~~, task lists and autolinks for scheme URLs, www. hosts and emails only (markdown-it); single newlines are line breaks and recognised HTML tags pass through (write quotes with >, never <blockquote>). Backslash-escape or put in backticks any literal * _ # < ~ not meant as formatting.';

// Local copies of the schema limits: importing schemas.ts would create a cycle with the callers.
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
/** Cheap guard before parsing; generated output limits still apply afterwards. */
const MAX_MARKDOWN_BYTES = MAX_TEXT_BYTES;

const FORMATS = ['markdown', 'html', 'text'] as const;
type Format = typeof FORMATS[number];

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const invalid = (): never => { throw new MailError('invalid_input'); };
const tooLarge = (): never => { throw new MailError('too_large'); };

function parseInput(input: unknown): { readonly format: Format; readonly value: string } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) { return invalid(); }
    const entries = Object.entries(input).filter(([, value]) => value !== undefined);
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (entry === undefined) { return invalid(); }
    const [key, value] = entry;
    const format = FORMATS.find(candidate => candidate === key);
    if (format === undefined || typeof value !== 'string' || !value.isWellFormed()) { return invalid(); }
    return { format, value };
}

// ---------------------------------------------------------------------------
// Markdown -> HTML fragment. All styling is inline: mail clients strip stylesheets.
// No font-family/size/colour on ordinary text so the reader's client defaults (and dark mode) apply.
// ---------------------------------------------------------------------------

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const FAINT = 'rgba(127,127,127,0.15)';
const RULE = '#d0d7de';
const HEADING_STYLES: Readonly<Record<number, string>> = {
    1: 'font-size:1.4em;font-weight:bold;margin:1em 0 .4em;line-height:1.25',
    2: 'font-size:1.2em;font-weight:bold;margin:1em 0 .4em;line-height:1.25',
    3: 'font-size:1.1em;font-weight:bold;margin:1em 0 .4em;line-height:1.25',
};
const HEADING_DEFAULT = 'font-size:1em;font-weight:bold;margin:1em 0 .4em;line-height:1.25';
/** A true reply quote (reply.ts, at the end of the message), rendered as a real <blockquote>. */
export const BLOCKQUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:2px solid #c0c0c0;padding-left:1ex';
/** Markdown `>` quotes are a styled <div>: some clients (Spark) treat the first top-level <blockquote> as the start of a quoted reply and hide the rest. */
const QUOTE_DIV_STYLE = 'margin:0 0 1em .8ex;border-left:2px solid #c0c0c0;padding-left:1ex';
const STYLE = Object.freeze({
    paragraph: 'margin:0 0 1em',
    list: 'margin:0 0 1em;padding-left:2em',
    nestedList: 'margin:.25em 0 0;padding-left:2em',
    item: 'margin:0 0 .25em',
    // Bullet lists made only of task items are tables: clients ignore list-style:none (Spark) and draw
    // the checked-box character U+2611 as a colour emoji (Gmail), so the box is a cell, not a bullet.
    taskTable: 'border-collapse:collapse;margin:0 0 1em 2em',
    nestedTaskTable: 'border-collapse:collapse;margin:.25em 0 0 0',
    taskBox: 'padding:0 .5em .25em 0;vertical-align:top',
    taskCell: 'padding:0 0 .25em;vertical-align:top',
    quote: QUOTE_DIV_STYLE,
    quoteTail: 'margin:0 0 0 .8ex;border-left:2px solid #c0c0c0;padding-left:1ex',
    tailParagraph: 'margin:0',
    pre: `margin:0 0 1em;padding:12px;border-radius:6px;background:${FAINT};font-family:${MONO};font-size:.9em;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word`,
    // Browsers give a bare <code> inside <pre> their own smaller monospace size (Gmail); inherit the pre's instead.
    preCode: 'font-family:inherit;font-size:1em',
    code: `font-family:${MONO};font-size:.9em;background:${FAINT};padding:.1em .35em;border-radius:4px`,
    hr: `border:0;border-top:1px solid ${RULE};margin:1em 0`,
    table: 'border-collapse:collapse;width:auto;margin:0 0 1em',
    th: 'padding:6px 12px;font-weight:bold;vertical-align:bottom;border-bottom:2px solid #8c959f',
    td: `padding:6px 12px;vertical-align:top;border-bottom:1px solid ${RULE}`,
    image: 'max-width:100%;height:auto',
});

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);

/** Allowed URL schemes for links/images the Markdown syntax produces. Scheme-less (relative, #fragment) is fine. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'cid']);
/** Named references require ';'; numeric references may omit it. Each source reference
 * is decoded once (never decode the result again). entities' strict mode itself
 * requires ';' on numerics too, so supply it only to a matched numeric reference. */
function decodeReferences(value: string): string {
    return value.replace(/&#(?:x[\da-f]+|\d+);?|&[a-z][a-z\d]+;/gi,
        reference => decodeHTMLStrict(reference.endsWith(';') ? reference : `${reference};`));
}
function safeUrl(href: string): string | null {
    const url = decodeReferences(href);
    const forbiddenScheme = (value: string): boolean => {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
        return scheme !== undefined && !SAFE_SCHEMES.has(scheme.toLowerCase());
    };
    // Do not repair controls or invisible leading characters into an accepted URL.
    // The exact strictly decoded value classified here is escaped and emitted.
    // eslint-disable-next-line no-control-regex -- URL policy explicitly forbids C0/C1 and DEL.
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(url) || /^[\p{White_Space}\p{Cf}]/u.test(url)
        || forbiddenScheme(url)) { return null; }
    // eslint-disable-next-line no-control-regex -- Belt-and-braces classification of legacy-decoded schemes.
    const legacy = decodeHTML(href).replace(/[\u0000- \u007f-\u009f\p{Cf}]/gu, '').trimStart();
    if (forbiddenScheme(legacy)) { return null; }
    return url;
}

/**
 * 'html' emits quotes as styled divs (the HTML part). 'text' emits plain <blockquote> so the
 * plain-text conversion prints "> " lines; that variant is never returned to callers, so no
 * marker attribute can leak into (or be forged through) the HTML part.
 */
type Variant = 'html' | 'text';

/** Ballot boxes without variation selectors: U+2611 is drawn as a large colour emoji by Gmail. */
const CHECKED = '☒';
const UNCHECKED = '☐';

type MarkdownToken = InstanceType<typeof MarkdownIt.Token>;
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 20_000;

/** Common file extensions that an "email-looking" name@2x.png is really a file name with. */
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'txt', 'md', 'json', 'yaml', 'yml', 'js', 'ts', 'css', 'html', 'zip', 'gz']);
/** A fuzzy email link only for ordinary addresses: letter/digit/hyphen host labels, an alphabetic
 * last label of two or more letters that is not a file extension, and no `:` or `/` right after
 * (git@github.com:o/r, user@host/path). Linear in the (library-bounded) match length. */
function plausibleEmail(address: string, following: string): boolean {
    if (/^[:/]/.test(following)) { return false; }
    const labels = address.slice(address.lastIndexOf('@') + 1).split('.');
    const last = labels.at(-1) ?? '';
    return labels.every(label => /^[\p{L}\p{M}\p{N}-]+$/u.test(label)) && /^[\p{L}\p{M}]{2,}$/u.test(last) && !FILE_EXTENSIONS.has(last.toLowerCase());
}

/** Standard HTML element names that Markdown raw HTML may pass through. Anything else
 * (<your manager>, <yes>) is the author's literal text; script-like and form-like elements
 * (script, style, iframe, object, embed, form, input, link, meta, base) are deliberately absent. */
const RAW_HTML_TAGS = new Set([
    'a', 'abbr', 'acronym', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
    'data', 'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
    'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'menu', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);
const isTagSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
const isAsciiLetter = (code: number): boolean => code >= 65 && code <= 90 || code >= 97 && code <= 122;
/** Index just past the `>` closing a tag whose name ends at `from`, or -1. Quoted attribute
 * values (a quote right after `=`) may contain `>`. One forward pass; indexOf only jumps ahead. */
function tagClose(source: string, from: number): number {
    let afterEquals = false;
    for (let index = from; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        if (code === 62) { return index + 1; }
        if ((code === 34 || code === 39) && afterEquals) {
            const close = source.indexOf(source[index] ?? '"', index + 1);
            if (close < 0) { return -1; }
            index = close; afterEquals = false;
        } else if (code === 61) { afterEquals = true; }
        else if (!isTagSpace(code)) { afterEquals = false; }
    }
    return -1;
}
/** The tag-like construct starting at `<`: its end (-1 when unterminated) and whether it may pass through. */
function rawTagAt(source: string, start: number): { end: number; pass: boolean } | undefined {
    const after = source.charCodeAt(start + 1);
    const through = (marker: string, from: number, pass: boolean): { end: number; pass: boolean } => {
        const close = source.indexOf(marker, from);
        return { end: close < 0 ? -1 : close + marker.length, pass };
    };
    if (after === 33) {
        if (source.startsWith('<!--', start)) { return through('-->', start + 2, true); }
        return source.startsWith('<![CDATA[', start) ? through(']]>', start + 9, false) : through('>', start + 2, false);
    }
    if (after === 63) { return through('>', start + 2, false); }
    const nameStart = start + 1 + Number(after === 47);
    if (!isAsciiLetter(source.charCodeAt(nameStart))) { return undefined; }
    let nameEnd = nameStart;
    while (nameEnd < source.length && !isTagSpace(source.charCodeAt(nameEnd)) && source[nameEnd] !== '/' && source[nameEnd] !== '>') { nameEnd += 1; }
    return { end: tagClose(source, nameEnd), pass: RAW_HTML_TAGS.has(source.slice(nameStart, nameEnd).toLowerCase()) };
}
/** Markdown raw HTML (an html_inline tag or an html_block of text and tags): known element
 * tags and comments pass through untouched; every other `<...>` is escaped to literal text.
 * One left-to-right scan; after an unterminated construct no further tag is scanned for its end
 * (the rest is escaped), so hostile input stays linear. */
function passThroughHtml(source: string): string {
    const chunks: string[] = [];
    let emitted = 0;
    let broken = false;
    for (let start = source.indexOf('<'); start >= 0;) {
        const tag = broken ? undefined : rawTagAt(source, start);
        if (tag && tag.end >= 0) {
            if (!tag.pass) { chunks.push(source.slice(emitted, start), escapeHtml(source.slice(start, tag.end))); emitted = tag.end; }
            start = source.indexOf('<', tag.end);
            continue;
        }
        const after = source.charCodeAt(start + 1);
        if (tag || broken && (isAsciiLetter(after) || after === 33 || after === 63 || after === 47 && isAsciiLetter(source.charCodeAt(start + 2)))) {
            // Unterminated: escape only the `<`, and stop looking for tag ends.
            broken = true;
            chunks.push(source.slice(emitted, start), '&lt;'); emitted = start + 1;
        }
        start = source.indexOf('<', start + 1);
    }
    if (emitted === 0) { return source; }
    chunks.push(source.slice(emitted));
    return chunks.join('');
}

function createMarkdown() {
    const md = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: false, maxNesting: 32 });
    // The only URL policy is safeUrl below. In particular do not percent-encode
    // existing escapes, punycode IDNs, or let the parser reject cid:/tel: links.
    md.validateLink = () => true;
    md.normalizeLink = value => value;
    md.normalizeLinkText = value => value;
    // GitHub-style extended autolinks: only an explicit scheme, a www. host or an email address
    // is linked. Bare domains (fuzzyLink) and scheme-relative // hosts would link file names and
    // identifiers such as setup.py or main.rs; fuzzyEmail stays at its default (on).
    md.linkify.set({ fuzzyLink: false }).add('//', null);
    // linkify-it offers no hook for its fuzzy email matches, so code-like text (foo@1.2.3,
    // name@2x.png, git@github.com:o/r) is turned back into plain text after the core linkify rule.
    md.core.ruler.after('linkify', 'email_code_like', state => {
        for (const block of state.tokens) {
            const children = block.type === 'inline' ? block.children : null;
            if (!children?.some(child => child.type === 'link_open' && child.markup === 'linkify')) { continue; }
            const kept: MarkdownToken[] = [];
            for (let index = 0; index < children.length; index += 1) {
                const [open, label, close, after] = [children[index], children[index + 1], children[index + 2], children[index + 3]];
                if (open?.type === 'link_open' && open.markup === 'linkify' && label?.type === 'text' && close?.type === 'link_close'
                    && /^mailto:/i.test(String(open.attrGet('href'))) && !/^mailto:/i.test(label.content)
                    && !plausibleEmail(label.content, after?.type === 'text' ? after.content : '')) {
                    label.level = open.level;
                    kept.push(label);
                    index += 2;
                } else if (open) { kept.push(open); }
            }
            block.children = kept;
        }
    });
    let wwwHost: RegExp | undefined;
    md.linkify.add('www.', {
        // Tail after the prefix: dotted host (at least one dot, library domain pieces), optional
        // port, host terminator and path, all linkify-it's own linear sub-patterns.
        validate(text, pos, self) {
            const re = self.re;
            wwwHost ??= new RegExp(`(?:(?:${re.get_domain().source})[.]){1,10}${re.get_domain_root().source}${re.get_port().source}${re.get_host_terminator().source}${re.get_path().source}`, 'iy');
            wwwHost.lastIndex = pos;
            return wwwHost.exec(text)?.[0].length ?? 0;
        },
        normalize(match) { match.url = `http://${match.url}`; },
    });
    const tokenize = md.block.tokenize.bind(md.block);
    md.block.tokenize = (state, start, end) => {
        // Upstream stops silently at its nesting cap. Reject instead of dropping
        // mail content, before the recursion exceeds the DOM walk's depth budget.
        if (state.level >= md.options.maxNesting) { tooLarge(); }
        tokenize(state, start, end);
    };
    const destination = md.helpers.parseLinkDestination;
    md.helpers = { ...md.helpers, parseLinkDestination(source, start, max) {
        const result = destination(source, start, max);
        if (result.ok) {
            const angle = source[start] === '<';
            // Keep entity references for OUR strict/legacy classification, decoding
            // once only. Markdown backslash escapes still have their usual meaning.
            result.str = md.utils.unescapeMd(source.slice(start + Number(angle), result.pos - Number(angle)));
        }
        return result;
    } };
    // Select the named rule through the public ruler API, not Function.name
    // (minification renames it) or a dependency-internal array position.
    const namedRule = (name: string) => {
        const all = md.block.ruler.getRules('');
        md.block.ruler.disable(name);
        const others = new Set(md.block.ruler.getRules(''));
        md.block.ruler.enable(name);
        const rule = all.find(candidate => !others.has(candidate));
        if (rule === undefined) { throw new Error(`Missing ${name} rule`); }
        return rule;
    };
    const table = namedRule('table');
    const lheading = namedRule('lheading');
    // The conventional email signature delimiter ("-- " or "--" alone on a line) is literal text,
    // never a setext underline: undo upstream's heading when its underline is exactly that line.
    md.block.ruler.at('lheading', (state, start, end, silent) => {
        const before = state.tokens.length;
        if (!lheading(state, start, end, silent)) { return false; }
        const underline = state.line - 1;
        const text = state.src.slice((state.bMarks[underline] ?? 0) + (state.tShift[underline] ?? 0), state.eMarks[underline]);
        if (state.sCount[underline] !== state.blkIndent || text !== '--' && text !== '-- ') { return true; }
        state.tokens.length = before;
        state.line = start;
        return false;
    });
    const tableBudgets = new WeakMap<object, number>();
    md.block.ruler.at('table', (state, start, end, silent) => {
        // Preserve the upstream cheap indentation/line eligibility checks, so
        // pipe-heavy indented code is not mistaken for a guarded table header.
        const headerIndent = (state.sCount[start] ?? Infinity) - state.blkIndent;
        const separatorIndent = (state.sCount[start + 1] ?? Infinity) - state.blkIndent;
        if (start + 2 > end || headerIndent >= 4 || separatorIndent < 0 || separatorIndent >= 4) { return false; }
        const separator = state.src.slice(state.bMarks[start + 1], state.eMarks[start + 1]);
        if (separator && /^[\t :|-]+$/.test(separator)) {
            // Only a position the upstream rule confirms as a table (its silent pass allocates
            // nothing per row) is subject to the guards; look-alikes stay ordinary text.
            if (!table(state, start, end, true)) { return false; }
            const trimmed = separator.trim();
            let columns = 1 - Number(trimmed.startsWith('|')) - Number(trimmed.endsWith('|'));
            for (const char of trimmed) { if (char === '|') { columns += 1; } }
            if (columns > MAX_TABLE_COLUMNS) { tooLarge(); }
            // Conservative nonblank-block bound; includes header and potential
            // body rows even if a later block terminates the actual table.
            let rows = 1;
            for (let line = start + 2; line < end && !state.isEmpty(line); line += 1) {
                rows += 1;
                if (rows * columns > MAX_TABLE_CELLS) { tooLarge(); }
            }
            if (silent) { return true; }
            const cells = (tableBudgets.get(state.env) ?? 0) + rows * columns;
            if (cells > MAX_TABLE_CELLS) { tooLarge(); }
            tableBudgets.set(state.env, cells);
        }
        return table(state, start, end, silent);
    }, { alt: ['paragraph', 'reference'] });
    return md;
}

const markdownParser = createMarkdown();
interface MarkdownParts {
    tokens: MarkdownToken[];
    tails: WeakSet<MarkdownToken>;
    tasks: WeakMap<MarkdownToken, boolean>;
    /** Opening tokens of bullet lists in which every direct item is a task item (rendered as tables in the HTML part only). */
    taskTables: WeakSet<MarkdownToken>;
}
function parseMarkdown(markdown: string): MarkdownParts {
    const tokens = markdownParser.parse(markdown, {});
    const tails = new WeakSet<MarkdownToken>();
    const tasks = new WeakMap<MarkdownToken, boolean>();
    const taskTables = new WeakSet<MarkdownToken>();
    const lists: { token: MarkdownToken; items: number; allTasks: boolean }[] = [];
    const stack: { token: MarkdownToken; last?: MarkdownToken }[] = [];
    for (const [index, token] of tokens.entries()) {
        if (token.nesting === -1) {
            const parent = stack.pop();
            if (parent?.token.type === 'blockquote_open' && parent.last) { tails.add(parent.last); }
        } else {
            const parent = stack.at(-1);
            if (parent) { parent.last = token; }
            if (token.nesting === 1) { stack.push({ token }); }
        }
        if (token.type === 'list_item_open' && tokens[index + 1]?.type === 'paragraph_open') {
            const inline = tokens[index + 2];
            const first = inline?.children?.[0];
            const marker = first?.type === 'text' && /^\[[ xX]\](?:[ \t]+|$)/.test(inline?.content ?? '')
                ? /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content) : null;
            if (marker && first) {
                tasks.set(token, marker[1] !== ' ');
                tasks.set(first, marker[1] !== ' ');
                first.content = first.content.slice(marker[0].length);
            }
        }
        if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') { lists.push({ token, items: 0, allTasks: token.type === 'bullet_list_open' }); }
        else if (token.type === 'list_item_open') {
            const list = lists.at(-1);
            if (list) { list.items += 1; list.allTasks &&= tasks.has(token); }
        } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
            const list = lists.pop();
            if (list?.allTasks && list.items > 0) { taskTables.add(list.token); }
        }
    }
    return { tokens, tails, tasks, taskTables };
}

/** Both variants consume these SAME tokens; no reparse, token mutation or HTML
 * reserialization. Bound generated bytes as chunks are emitted, not after a join. */
function markdownToHtml(parts: MarkdownParts, variant: Variant): string {
    const chunks: string[] = [];
    let bytes = 0;
    const lists: string[] = [];
    const links: boolean[] = [];
    const append = (value: string): void => {
        bytes += byteLength(value);
        if (bytes > MAX_HTML_BYTES) { tooLarge(); }
        chunks.push(value);
    };
    const style = (token: MarkdownToken, base: string): string => parts.tails.has(token) ? `${base};margin-bottom:0` : base;
    const render = (tokens: MarkdownToken[]): void => {
        for (const [index, token] of tokens.entries()) {
            if (token.hidden) { continue; }
            const tag = token.tag;
            switch (token.type) {
                case 'inline': render(token.children ?? []); break;
                case 'text': {
                    const task = parts.tasks.get(token);
                    // In a task table the box was already emitted as its own cell.
                    if (task !== undefined && lists.at(-1) !== 'table') {
                        const marker = task ? `${CHECKED} ` : `${UNCHECKED} `;
                        append(variant === 'html' ? marker : `<span data-mail-task="${task ? 'checked' : 'unchecked'}">${marker}</span>`);
                    }
                    const previous = tokens[index - 1];
                    const lineBreak = (candidate: MarkdownToken | undefined): boolean => candidate === undefined || candidate.type === 'softbreak' || candidate.type === 'hardbreak';
                    // A line that is just "--" is the email signature delimiter "-- ": its trailing space is
                    // significant (the inline parser strips it) and the text conversion keeps it.
                    const content = previous?.type === 'link_open' && previous.info === 'auto'
                        ? decodeReferences(token.content).replace(/^mailto:/i, '')
                        : token.content === '--' && lineBreak(previous) && lineBreak(tokens[index + 1]) ? '-- ' : token.content;
                    append(escapeHtml(content)); break;
                }
                case 'html_inline': case 'html_block': append(passThroughHtml(token.content)); break;
                case 'softbreak': case 'hardbreak': append('<br>'); break;
                case 'code_inline': append(`<code style="${STYLE.code}">${escapeHtml(token.content)}</code>`); break;
                case 'fence': case 'code_block': {
                    let end = token.content.length;
                    while (end > 0 && token.content[end - 1] === '\n') { end -= 1; }
                    append(`<pre style="${style(token, STYLE.pre)}"><code style="${STYLE.preCode}">${escapeHtml(token.content.slice(0, end))}</code></pre>\n`); break;
                }
                case 'heading_open': append(`<${tag} style="${style(token, HEADING_STYLES[Number(tag.slice(1))] ?? HEADING_DEFAULT)}">`); break;
                case 'paragraph_open': append(`<p style="${parts.tails.has(token) ? STYLE.tailParagraph : STYLE.paragraph}">`); break;
                case 'blockquote_open': append(variant === 'text' ? '<blockquote>\n' : `<div style="${parts.tails.has(token) ? STYLE.quoteTail : STYLE.quote}">\n`); break;
                case 'blockquote_close': append(variant === 'text' ? '</blockquote>\n' : '</div>\n'); break;
                case 'bullet_list_open': case 'ordered_list_open': {
                    // Only the HTML part gets the table form; the text variant keeps the list
                    // (with its private task markers) so the plain text is identical either way.
                    if (variant === 'html' && parts.taskTables.has(token)) {
                        append(`<table style="${style(token, lists.length === 0 ? STYLE.taskTable : STYLE.nestedTaskTable)}">\n`);
                        lists.push('table'); break;
                    }
                    const start = token.attrGet('start');
                    append(`<${tag}${start === null ? '' : ` start="${escapeHtml(String(start))}"`} style="${style(token, lists.length === 0 ? STYLE.list : STYLE.nestedList)}">\n`);
                    lists.push(tag); break;
                }
                case 'bullet_list_close': case 'ordered_list_close': append(lists.pop() === 'table' ? '</table>\n' : `</${tag}>\n`); break;
                case 'list_item_open':
                    // Dropping generated item style in the internal variant also
                    // pays for its task marker: it cannot exceed the HTML budget
                    // merely because of our private bookkeeping markup.
                    if (lists.at(-1) === 'table') {
                        append(`<tr><td style="${STYLE.taskBox}">${parts.tasks.get(token) ? CHECKED : UNCHECKED}</td><td style="${STYLE.taskCell}">`);
                    } else { append(variant === 'text' ? '<li>' : `<li style="${STYLE.item}">`); }
                    break;
                case 'list_item_close': append(lists.at(-1) === 'table' ? '</td></tr>\n' : '</li>\n'); break;
                case 'hr': append(`<hr style="${style(token, STYLE.hr)}">\n`); break;
                case 'table_open': append(`<table style="${style(token, STYLE.table)}">\n`); break;
                case 'th_open': case 'td_open': {
                    const align = String(token.attrGet('style') ?? '').slice('text-align:'.length) || 'left';
                    append(`<${tag} align="${align}" style="text-align:${align};${tag === 'th' ? STYLE.th : STYLE.td}">`); break;
                }
                case 'link_open': {
                    const url = safeUrl(String(token.attrGet('href') ?? ''));
                    links.push(url !== null);
                    const title = token.attrGet('title');
                    if (url !== null) { append(`<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(String(title))}"` : ''}>`); }
                    break;
                }
                case 'link_close': if (links.pop()) { append('</a>'); } break;
                case 'image': {
                    const alt = escapeHtml(markdownParser.renderer.renderInlineAsText(token.children ?? [], markdownParser.options, {}));
                    const src = safeUrl(String(token.attrGet('src') ?? ''));
                    const title = token.attrGet('title');
                    append(src === null ? alt : `<img src="${escapeHtml(src)}" alt="${alt}"${title ? ` title="${escapeHtml(String(title))}"` : ''} style="${STYLE.image}">`); break;
                }
                default: append(`<${token.nesting === -1 ? '/' : ''}${tag === 's' ? 'del' : tag}>${token.block && token.nesting !== 1 ? '\n' : ''}`);
            }
        }
    };
    render(parts.tokens);
    return chunks.join('').trim();
}

// ---------------------------------------------------------------------------
// HTML -> plain text (single path for the markdown and html inputs).
// ---------------------------------------------------------------------------

const MAX_DOM_DEPTH = 64;
const TABLE_ALIGNMENT_BUDGET = 32 * 1024;
type HtmlNode = DomHandler['dom'][number];
/** Bound the parser's own open-tag stack too, before malformed closing tags can
 * make it search an input-sized stack. This is the only HTML parse. */
class BoundedDom extends DomHandler {
    override onopentag(name: string, attribs: Record<string, string>): void {
        if (this.tagStack.length > MAX_DOM_DEPTH) { invalid(); }
        super.onopentag(name, attribs);
    }
}
type HtmlElement = Extract<HtmlNode, { attribs: unknown }>;
const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'iframe', 'noembed', 'noframes']);
const BLOCK = new Set(['p']);
const LINE_BLOCK = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd']);

/** Conservative terminal-style widths, linear in code points. Uncertain scripts
 * still get a width for headings but disable table padding. No grapheme expansion. */
function displayWidth(value: string): { width: number; confident: boolean } {
    let width = 0;
    let confident = true;
    let flagHalves = 0;
    for (const char of value) {
        const point = char.codePointAt(0) ?? 0;
        // Emoji skin-tone modifiers join the preceding emoji; they take no cell of their own.
        if (/\p{Mark}/u.test(char) || point === 0x200d || point >= 0xfe00 && point <= 0xfe0f || point >= 0xe0100 && point <= 0xe01ef || point >= 0x1f3fb && point <= 0x1f3ff) { continue; }
        // Regional indicators pair into one two-cell flag, so each half is one cell; an odd run is unsure.
        if (point >= 0x1f1e6 && point <= 0x1f1ff) { width += 1; flagHalves += 1; continue; }
        confident &&= flagHalves % 2 === 0; flagHalves = 0;
        // Text-presentation symbols (© ® ™ ↔ ...) are pictographic but one or two cells depending on the font.
        if (/\p{Extended_Pictographic}/u.test(char) && !/\p{Emoji_Presentation}/u.test(char)) { width += 1; confident = false; continue; }
        if (/\p{Emoji_Presentation}/u.test(char)
            || point >= 0x1100 && point <= 0x115f || point >= 0x2329 && point <= 0x232a
            || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
            || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe19
            || point >= 0xfe30 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60
            || point >= 0xffe0 && point <= 0xffe6 || point >= 0x20000 && point <= 0x3fffd) { width += 2; }
        else {
            width += 1;
            if (!(point >= 0x20 && point <= 0x7e || point >= 0xa0 && point <= 0x52f || point >= 0x2000 && point <= 0x206f)) { confident = false; }
        }
    }
    return { width, confident: confident && flagHalves % 2 === 0 };
}
// Deliberately a small inline-display parser, not a cascade/stylesheet engine.
const DISPLAY_VALUES = new Set(['none', 'block', 'inline', 'run-in', 'inline-block', 'flow', 'flow-root', 'flex', 'inline-flex', 'grid', 'inline-grid', 'ruby', 'math', 'table', 'inline-table', 'table-row', 'table-cell', 'table-caption', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-column', 'table-column-group', 'ruby-base', 'ruby-text', 'ruby-base-container', 'ruby-text-container', 'list-item', 'contents', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
function validDisplay(value: string): boolean {
    if (DISPLAY_VALUES.has(value) || /^-[a-z][a-z0-9-]*$/.test(value)) { return true; }
    const words = value.split(/\s+/);
    if (words.length < 2 || words.length > 3 || new Set(words).size !== words.length) { return false; }
    const outside = words.filter(word => /^(block|inline|run-in)$/.test(word)).length;
    const inside = words.filter(word => /^(flow|flow-root|table|flex|grid|ruby|math)$/.test(word)).length;
    const list = words.includes('list-item');
    return outside <= 1 && inside <= 1 && outside + inside + Number(list) === words.length
        && (!list || words.every(word => /^(block|inline|run-in|flow|flow-root|list-item)$/.test(word)));
}
function hiddenElement(element: HtmlElement): boolean {
    if (Object.hasOwn(element.attribs, 'hidden')) { return true; }
    let display = '';
    let important = false;
    for (const declaration of (element.attribs.style ?? '').split(';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== 'display') { continue; }
        const raw = declaration.slice(colon + 1).trim().toLowerCase();
        const priority = /!\s*important$/.test(raw);
        const value = raw.replace(/!\s*important$/, '').trim();
        // Invalid declarations (notably !ie) do not override valid ones; vendor
        // values are visible, but never defeat an earlier !important declaration.
        if (validDisplay(value) && (priority || !important)) { display = value; important = priority; }
    }
    return display === 'none';
}

/** A chunked, byte-bounded sink. Trailing spaces/newlines are deferred rather than
 * allocated, so a whitespace-only pre block costs input-linear work but no output.
 * Every append checks the complete addition BEFORE allocating padding or joining.
 */
class TextSink {
    constructor(private readonly inlineEdges = false) {}
    private readonly chunks: string[] = [];
    private bytes = 0;
    private spaces: string[] = [];
    private spaceBytes = 0;
    private breaks = 0;
    /** Index in `chunks` where the current output line begins. */
    private lineStart = 0;
    break(count = 1, additive = false): void {
        // The email signature delimiter is exactly "-- ": keep the one trailing space
        // that is otherwise deferred and dropped.
        if (this.breaks === 0 && this.spaces.length === 1 && this.spaces[0] === ' ' && this.chunks.length - this.lineStart === 1 && this.chunks[this.lineStart] === '--') {
            if (this.bytes + 1 > MAX_TEXT_BYTES) { tooLarge(); }
            this.chunks.push(' '); this.bytes += 1;
        }
        this.spaces = []; this.spaceBytes = 0;
        if (this.bytes > 0) { this.breaks = additive ? this.breaks + count : Math.max(this.breaks, count); }
    }
    write(value: string, pre = false): void {
        const normalized = value.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
        // Process runs, not characters, and never concatenate growing prefixes.
        for (const match of normalized.matchAll(/[ \t\n]+|[^ \t\n]+/g)) {
            const run = match[0];
            if (/^[ \t\n]/.test(run)) {
                if (!pre) {
                    if ((this.bytes > 0 || this.inlineEdges) && this.breaks === 0) { this.spaces = [' ']; this.spaceBytes = 1; }
                } else {
                    const lastBreak = run.lastIndexOf('\n');
                    if (lastBreak >= 0) {
                        this.break(run.split('\n').length - 1, true);
                        const tail = run.slice(lastBreak + 1);
                        if (tail) { this.spaces.push(tail); this.spaceBytes += tail.length; }
                    } else { this.spaces.push(run); this.spaceBytes += run.length; }
                }
                continue;
            }
            const addition = this.breaks + this.spaceBytes + byteLength(run);
            if (this.bytes + addition > MAX_TEXT_BYTES) { tooLarge(); }
            if (this.breaks) { this.chunks.push('\n'.repeat(this.breaks)); this.lineStart = this.chunks.length; }
            if (this.spaces.length) { this.chunks.push(this.spaces.join('')); }
            this.chunks.push(run);
            this.bytes += addition;
            this.spaces = []; this.spaceBytes = 0; this.breaks = 0;
        }
    }
    value(): string {
        const tailBytes = this.inlineEdges && this.breaks === 0 ? this.spaceBytes : 0;
        if (this.bytes + tailBytes > MAX_TEXT_BYTES) { tooLarge(); }
        return this.chunks.join('') + (tailBytes ? this.spaces.join('') : '');
    }
}

interface WalkContext { depth: number; pre?: boolean; code?: boolean; skipInitialLf?: boolean; inTable?: boolean; nestedTable?: () => void }
// domutils 4 no longer re-exports domhandler's node guards; ElementType (re-exported by htmlparser2) is the same test.
const isElement = (node: HtmlNode): node is HtmlElement => ElementType.isTag(node);
const isTextNode = (node: HtmlNode): node is Extract<HtmlNode, { type: typeof ElementType.Text }> => node.type === ElementType.Text;
function visible(node: HtmlNode): node is HtmlElement {
    return isElement(node) && !SKIP.has(node.name) && !hiddenElement(node);
}
function capture(nodes: HtmlNode[], context: WalkContext, inlineEdges = false): string {
    const sink = new TextSink(inlineEdges);
    walk(nodes, sink, context);
    return sink.value();
}

/** No grid, span expansion, or multiline padding. The only padded path has a
 * fixed 32 KiB padding bound, checked from dimensions before emitting anything.
 * Cell captures and fallback emission are bounded and visit each cell once.
 */
function tableText(element: HtmlElement, sink: TextSink, context: WalkContext): void {
    const rows: string[][] = [];
    const standalone = new WeakSet<string[]>();
    let layout = false;
    let totalBytes = 0;
    const add = (cell: string, row?: string[]): void => {
        totalBytes += byteLength(cell);
        if (totalBytes > MAX_TEXT_BYTES) { tooLarge(); }
        if (row) { row.push(cell); }
        else if (cell.trim()) { const entry = [cell]; rows.push(entry); standalone.add(entry); }
    };
    const hasBlocks = (nodes: HtmlNode[]): boolean => nodes.some(node => visible(node)
        && (BLOCK.has(node.name) || LINE_BLOCK.has(node.name) || /^(h[1-6]|ul|ol|pre|blockquote|table|hr|br)$/.test(node.name) || hasBlocks(node.children)));
    const collect = (nodes: HtmlNode[], depth: number, row?: string[]): void => {
        if (depth > MAX_DOM_DEPTH) { invalid(); }
        for (const node of nodes) {
            if (isTextNode(node)) { const stray = capture([node], { depth }); if (stray.trim()) { add(stray, row); } continue; }
            if (!visible(node)) { continue; }
            if (node.name === 'tr') {
                const cells: string[] = []; rows.push(cells);
                collect(node.children, depth + 1, cells);
            } else if (node.name === 'td' || node.name === 'th') {
                layout ||= hasBlocks(node.children);
                add(capture(node.children, { ...context, depth: depth + 1, inTable: true, nestedTable: () => { layout = true; } }), row);
            } else if (node.name === 'thead' || node.name === 'tbody' || node.name === 'tfoot') { collect(node.children, depth + 1, row); }
            else { add(capture([node], { ...context, depth }), row); }
        }
    };
    collect(element.children, context.depth + 1);
    const widths: number[] = [];
    let align = rows.length <= 200;
    for (const row of rows) {
        if (standalone.has(row)) { continue; }
        if (row.length > 20) { align = false; }
        for (const [column, cell] of row.entries()) {
            const measured = displayWidth(cell);
            if (cell.includes('\n')) { layout = true; }
            if (!measured.confident || measured.width > 60) { align = false; }
            if (column < 20) { widths[column] = Math.max(widths[column] ?? 0, measured.width); }
        }
    }
    layout ||= rows.every(row => standalone.has(row) || row.length <= 1);
    const paddedWidth = widths.reduce((sum, width) => sum + width + 3, 0);
    align &&= !layout && rows.length * paddedWidth <= TABLE_ALIGNMENT_BUDGET;
    sink.break(2);
    for (const [index, row] of rows.entries()) {
        if (standalone.has(row)) { sink.break(2); sink.write(row[0] ?? '', true); sink.break(2); continue; }
        if (layout) {
            for (const cell of row) { if (cell.trim()) { sink.write(cell, true); sink.break(2); } }
            continue;
        }
        if (index > 0) { sink.break(); }
        for (const [column, cell] of row.entries()) {
            if (column > 0) { sink.write(align ? '   ' : ' | ', true); }
            sink.write(cell, true);
            if (align && column < row.length - 1) { sink.write(' '.repeat((widths[column] ?? 0) - displayWidth(cell).width), true); }
        }
    }
    sink.break(2);
}

function walk(nodes: HtmlNode[], sink: TextSink, context: WalkContext): void {
    if (context.depth > MAX_DOM_DEPTH) { invalid(); }
    for (const [nodeIndex, node] of nodes.entries()) {
        // htmlparser2 12 decodes textarea RCDATA references itself (like title), so
        // text nodes are already decoded exactly once; never decode them again. HTML ignores exactly
        // one initial LF after pre/textarea, not one after their first child tag.
        if (isTextNode(node)) {
            let text = node.data;
            if (nodeIndex === 0 && context.skipInitialLf) { text = text.replace(/^(?:\r\n?|\n)/, ''); }
            sink.write(text, context.pre); continue;
        }
        if (!visible(node)) { continue; }
        const childContext = { ...context, depth: context.depth + 1, skipInitialLf: false };
        const tag = node.name;
        if (tag === 'span' && node.attribs['data-mail-task'] && !context.pre && !context.code) {
            sink.write(node.attribs['data-mail-task'] === 'checked' ? '[x] ' : '[ ] ');
        } else if (tag === 'br') { sink.break(1, true); }
        else if (tag === 'hr') { sink.break(2); sink.write('-'.repeat(40)); sink.break(2); }
        else if (tag === 'img') { sink.write(node.attribs.alt ?? ''); }
        else if (tag === 'table') { context.nestedTable?.(); tableText(node, sink, context); }
        else if (tag === 'a') {
            const label = capture(node.children, childContext, true);
            const href = (node.attribs.href ?? '').replace(/^mailto:/i, '');
            sink.write(label, context.pre);
            const comparable = (value: string): string => value.trim().replace(/^mailto:/i, '').replace(/^https?:\/\/(?=www\.)/i, '').replace(/\/$/, '');
            if (href && !/^(?:cid:|#)/i.test(href) && comparable(href) !== comparable(label)) {
                sink.write(' ['); sink.write(href); sink.write(']');
            }
        } else if (/^h[1-6]$/.test(tag)) {
            const value = capture(node.children, childContext);
            sink.break(2); sink.write(value, true);
            if (tag === 'h1' || tag === 'h2') {
                const width = value.split('\n').reduce((max, line) => Math.max(max, displayWidth(line).width), 0);
                sink.break(); sink.write((tag === 'h1' ? '=' : '-').repeat(width));
            }
            sink.break(2);
        } else if (tag === 'blockquote') {
            const value = capture(node.children, childContext);
            sink.break(2);
            for (const line of value.split('\n')) { sink.write('> ', true); sink.write(line, true); sink.break(); }
            sink.break(2);
        } else if (tag === 'ol' || tag === 'ul') {
            const reversed = tag === 'ol' && Object.hasOwn(node.attribs, 'reversed');
            const fallback = reversed ? node.children.filter(child => visible(child) && child.name === 'li').length : 1;
            const ordinal = (value: string | undefined, defaultValue: number): number => {
                const number = value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
                return Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000 ? number : defaultValue;
            };
            let index = ordinal(node.attribs.start, fallback);
            sink.break(2);
            for (const child of node.children) {
                if (!visible(child) || child.name !== 'li') { walk([child], sink, childContext); continue; }
                sink.break();
                const value = capture(child.children, { ...childContext, depth: childContext.depth + 1 });
                index = ordinal(child.attribs.value, index);
                const prefix = tag === 'ol' ? ` ${index}. ` : ' - ';
                index += reversed ? -1 : 1;
                for (const [lineIndex, line] of value.split('\n').entries()) {
                    sink.write(lineIndex === 0 ? prefix : ' '.repeat(prefix.length), true);
                    sink.write(line, true); sink.break();
                }
            }
            sink.break(2);
        } else {
            const breaks = BLOCK.has(tag) || tag === 'pre' ? 2 : LINE_BLOCK.has(tag) ? 1 : 0;
            if (breaks) { sink.break(breaks); }
            walk(node.children, sink, { ...childContext, pre: context.pre === true || tag === 'pre', code: context.code === true || tag === 'code', skipInitialLf: tag === 'pre' || tag === 'textarea' });
            if (breaks) { sink.break(breaks); }
        }
    }
}

/** Single parse, no serialization/reparse boundary. The DOM is O(input size).
 * The walk is bounded to 64 levels; each node is visited O(1) times, and captured
 * text flows through at most 64 ancestor buffers (each a constant number of scans).
 * Sinks check UTF-8 bytes before appending; tables only pad within a fixed budget,
 * ignore spans, and emit layout/multiline cells without padding. Thus text production is
 * O(input size) time and O(input size + output limit) memory, not width × height.
 * html-to-text's unbounded builders/table printer cannot provide this guarantee.
 */
function htmlToPlainText(html: string): string {
    const document = new BoundedDom();
    new Parser(document).end(html);
    return capture(document.dom, { depth: 1 });
}

// ---------------------------------------------------------------------------

/** Synchronous and deterministic. Throws MailError('invalid_input') when not exactly one key is present
 *  or the value is not a well-formed string; MailError('too_large') when input or a generated part exceeds its limit. */
export interface RenderDiagnostic { event: 'render_internal_error'; name: 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'ReferenceError' | 'URIError' | 'EvalError' | 'UnknownError' }
export interface RenderOptions { onDiagnostic?: (diagnostic: RenderDiagnostic) => void }
export function renderBody(input: BodyInput, options: RenderOptions = {}): MimeBody {
    try {
        const { format, value } = parseInput(input);
        if (format === 'text') {
            if (byteLength(value) > MAX_TEXT_BYTES) { tooLarge(); }
            return { text: value.replace(/\r\n?/g, '\n'), html: null };
        }
        if (format === 'html' && byteLength(value) > MAX_HTML_BYTES) { tooLarge(); }
        if (format === 'markdown' && byteLength(value) > MAX_MARKDOWN_BYTES) { tooLarge(); }
        const parts = format === 'markdown' ? parseMarkdown(value) : null;
        const html = parts === null ? value.replace(/\r\n?/g, '\n') : markdownToHtml(parts, 'html');
        if (byteLength(html) > MAX_HTML_BYTES) { tooLarge(); }
        // The two renderers share one parse. Internal task markers and real quote
        // tags occur only in the text variant, never in the returned HTML part.
        const text = htmlToPlainText(parts === null ? html : markdownToHtml(parts, 'text'));
        return { text, html };
    } catch (error) {
        // Even malformed runtime objects and library failures obey the public
        // error contract. No other MailError code or raw exception may escape.
        let contract: MailError | undefined;
        try { if (error instanceof MailError && (error.code === 'invalid_input' || error.code === 'too_large')) { contract = error; } }
        catch { /* A hostile thrown value (throwing prototype trap or getter) is an internal error. */ }
        if (contract) { throw contract; }
        // Fixed literal names only: custom error.name/message/stack may contain
        // message data. Diagnostic callbacks cannot alter the public error contract.
        try {
            const name = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof SyntaxError ? 'SyntaxError'
                : error instanceof ReferenceError ? 'ReferenceError' : error instanceof URIError ? 'URIError' : error instanceof EvalError ? 'EvalError' : error instanceof Error ? 'Error' : 'UnknownError';
            const diagnostic: RenderDiagnostic = { event: 'render_internal_error', name };
            if (options.onDiagnostic) { options.onDiagnostic(diagnostic); }
            // eslint-disable-next-line no-console -- Deliberate fixed-literal, privacy-allowlisted operational diagnostic.
            else { console.warn(JSON.stringify(diagnostic)); }
        } catch { /* Diagnostics must not change mail results. */ }
        throw new MailError('invalid_input');
    }
}
