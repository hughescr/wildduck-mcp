import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { MailError } from '../src/mail/contracts';
import { MARKDOWN_FLAVOR, renderBody, type BodyInput } from '../src/mail/render';

const PRE_CODE = '<code style="font-family:inherit;font-size:1em">';
const md = (markdown: string) => renderBody({ markdown });
const html = (markdown: string) => md(markdown).html ?? '';
const text = (markdown: string) => md(markdown).text;
function errorCode(input: unknown): string | undefined {
    try { renderBody(input as BodyInput, { onDiagnostic: () => {} }); } catch (error) { return error instanceof MailError ? error.code : `unexpected:${String(error)}`; }
    return undefined;
}

describe('input validation', () => {
    test('requires exactly one well-formed string key', () => {
        for (const input of [{}, { text: 'a', html: 'b' }, { markdown: 'a', text: 'b' }, { text: 5 }, { html: null }, { markdown: ['a'] }, { body: 'a' }, { text: 'a', extra: 'b' }, null, 'text', ['text'], { text: '\ud800' }]) {
            expect(errorCode(input)).toBe('invalid_input');
        }
    });
    test('runtime object failures cannot escape the public MailError contract', () => {
        expect(errorCode({ get html(): string { throw new RangeError('bad getter'); } })).toBe('invalid_input');
        expect(errorCode({ get html(): string { throw new MailError('forbidden'); } })).toBe('invalid_input');
    });
    test('keys holding undefined do not count', () => {
        expect(renderBody({ text: 'a', html: undefined } as unknown as BodyInput)).toEqual({ text: 'a', html: null });
    });
    test('empty strings are valid', () => {
        expect(renderBody({ text: '' })).toEqual({ text: '', html: null });
        expect(md('')).toEqual({ text: '', html: '' });
    });
    test('flavor sentence names the dialect and the line-break rule', () => {
        expect(MARKDOWN_FLAVOR).toMatch(/CommonMark.*GFM.*markdown-it/);
        expect(MARKDOWN_FLAVOR).toMatch(/newline/);
        expect(MARKDOWN_FLAVOR).toMatch(/~~strikethrough~~.*task lists.*scheme URLs, www\. hosts and emails only/);
        expect(MARKDOWN_FLAVOR).toMatch(/recognised HTML tags pass through/);
        expect(MARKDOWN_FLAVOR).toContain('Backslash-escape or put in backticks any literal * _ # < ~ not meant as formatting.');
        expect(MARKDOWN_FLAVOR.split(/(?<=\.) (?=[A-Z])/)).toHaveLength(2);
        expect(MARKDOWN_FLAVOR).toMatch(/write quotes with >, never <blockquote>/);
        expect(MARKDOWN_FLAVOR.length).toBeLessThan(340);
    });
});

describe('text input', () => {
    test('preserves whitespace and literal syntax, normalizing only line endings, with no html part', () => {
        const input = '  Hello <b>not html</b> & *not markdown*\r\n\ttabs and trailing   \n\n\n';
        const out = renderBody({ text: input });
        expect(out.text).toBe(input.replace(/\r\n?/g, '\n'));
        expect(out.html).toBeNull();
    });
});

describe('markdown to html', () => {
    test('paragraphs, emphasis, strikethrough, autolinks and links', () => {
        const out = html('Hi **bold** and *it* and ~~gone~~, see [docs](https://example.com/a?b=1&c=2) or https://example.com/x.');
        expect(out).toContain('<strong>bold</strong>');
        expect(out).toContain('<em>it</em>');
        expect(out).toContain('<del>gone</del>');
        expect(out).toContain('<a href="https://example.com/a?b=1&amp;c=2">docs</a>');
        expect(out).toContain('<a href="https://example.com/x">https://example.com/x</a>');
        expect(out).not.toMatch(/<a [^>]*style=/);
    });
    test('single newlines inside a paragraph become <br>; blank lines split paragraphs', () => {
        const out = html('Thanks,\nCraig\n\nPS: more');
        expect(out).toMatch(/<p [^>]*>Thanks,<br>Craig<\/p>/);
        expect(out).toMatch(/<p [^>]*>PS: more<\/p>/);
    });
    test('ordinary text carries no font-family, font-size or colour; no wrapper element', () => {
        const out = html('Para\n\n- item\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |');
        expect(out.startsWith('<p ')).toBe(true);
        for (const tag of out.match(/<(?:p|li|ul|td|th|blockquote)\b[^>]*>/g) ?? []) { expect(tag).not.toMatch(/font-family|font-size|(?<![-\w])color\s*:/); }
    });
    test('headings get modest inline sizes', () => {
        const out = html('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six');
        expect(out).toMatch(/<h1 style="[^"]*font-size:1\.4em/);
        expect(out).toMatch(/<h2 style="[^"]*font-size:1\.2em/);
        expect(out).toMatch(/<h3 style="[^"]*font-size:1\.1em/);
        expect(out).toMatch(/<h4 style="[^"]*font-size:1em;font-weight:bold/);
        expect(out).toMatch(/<h6 style="[^"]*font-size:1em;font-weight:bold/);
    });
    test('tables are a minimal rule layout that honours GFM alignment', () => {
        const out = html('| Name | Qty | Note |\n|:-----|----:|:----:|\n| a | 1 | x |\n| b | 22 | y |');
        expect(out).toMatch(/<table style="[^"]*border-collapse:collapse[^"]*width:auto/);
        expect(out).not.toMatch(/width:100%/);
        expect(out).toMatch(/<th align="left" style="text-align:left;[^"]*padding:6px 12px[^"]*font-weight:bold[^"]*border-bottom:2px solid/);
        expect(out).toMatch(/<th align="right" style="text-align:right;/);
        expect(out).toMatch(/<th align="center" style="text-align:center;/);
        expect(out).toMatch(/<td align="left" style="text-align:left;/);
        expect(out).toMatch(/<td align="right" style="text-align:right;[^"]*padding:6px 12px[^"]*border-bottom:1px solid #d0d7de/);
        expect(out).toMatch(/<td align="center" style="text-align:center;/);
        expect(out.match(/<t[hd]\b/g)).toHaveLength(out.match(/<t[hd] align="(?:left|right|center)" style="text-align:(?:left|right|center);/g)?.length ?? -1);
        expect(out).not.toMatch(/border-left|border-right|border-top|border="1"/);
        expect(out.match(/<tr>/g)).toHaveLength(3);
        const unaligned = html('| a |\n|---|\n| 1 |');
        expect(unaligned).toMatch(/<td align="left" style="text-align:left;/);
        expect(unaligned).toMatch(/<th align="left" style="text-align:left;/);
    });
    test('inline code is monospace on a faint background without a colour', () => {
        const out = html('Run `a < b` now');
        expect(out).toMatch(/<code style="[^"]*font-family:[^"]*monospace[^"]*background:rgba\(127,127,127,0\.15\)[^"]*padding[^"]*border-radius/);
        expect(out).toContain('a &lt; b</code>');
        expect(out).not.toMatch(/<code style="[^"]*(?<![-\w])color:/);
    });
    test('fenced code wraps long lines, ignores the language and highlights nothing', () => {
        const long = `echo ${'x'.repeat(300)}`;
        const out = html(`\`\`\`typescript\nconst a = 1 < 2;\n${long}\n\`\`\``);
        expect(out).toMatch(/<pre style="[^"]*padding:12px[^"]*border-radius:6px[^"]*white-space:pre-wrap;word-break:break-word/);
        expect(out).toMatch(/<pre [^>]*><code style="[^"]*">const a = 1 &lt; 2;\n/);
        expect(out).not.toMatch(/class=|typescript|<span/);
        expect(out).toContain(long);
        expect(out).not.toMatch(/<pre [^>]*background[^>]*color:/);
        expect(html('```\nplain\n```')).toContain(`${PRE_CODE}plain</code>`);
    });
    test('the code inside a pre inherits the pre font and size so Gmail does not shrink it; inline code is unchanged', () => {
        const pre = 'margin:0 0 1em;padding:12px;border-radius:6px;background:rgba(127,127,127,0.15);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word';
        expect(html('```\nx < y\n```')).toBe(`<pre style="${pre}">${PRE_CODE}x &lt; y</code></pre>`);
        expect(html('    indented\n    code')).toBe(`<pre style="${pre}">${PRE_CODE}indented\ncode</code></pre>`);
        expect(html('`inline`')).toBe('<p style="margin:0 0 1em"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:rgba(127,127,127,0.15);padding:.1em .35em;border-radius:4px">inline</code></p>');
        // A final code block in a quote still drops only its bottom margin.
        expect(html('> ```\n> x\n> ```')).toContain(`;margin-bottom:0">${PRE_CODE}x</code></pre>`);
        expect(text('```\n  a  b\n```')).toBe('  a  b');
    });
    test('block quotes are styled divs (never <blockquote>, which Spark treats as a quoted reply) and nest', () => {
        const out = html('> outer\n>\n> > inner');
        const bar = 'border-left:2px solid #c0c0c0;padding-left:1ex';
        expect(out).not.toMatch(/<\/?blockquote/i);
        expect(out).not.toMatch(/data-/);
        expect(out.split(`<div style="margin:0 0 1em .8ex;${bar}">`)).toHaveLength(2);
        expect(out.split(`<div style="margin:0 0 0 .8ex;${bar}">`)).toHaveLength(2);
        expect(out.split('<div ')).toHaveLength(3);
        expect(out.split('</div>')).toHaveLength(3);
        expect(out.indexOf('inner')).toBeGreaterThan(out.lastIndexOf('<div '));
        expect(out.indexOf('outer')).toBeLessThan(out.indexOf('<div ', 5));
    });
    test('the last paragraph in a quote has no bottom margin; earlier ones keep it', () => {
        const out = html('> one\n>\n> two');
        expect(out).toMatch(/<p style="margin:0 0 1em">one<\/p>/);
        expect(out).toMatch(/<p style="margin:0">two<\/p>/);
        expect(html('after\n\n> q\n\nbefore')).toMatch(/<p style="margin:0">q<\/p>\n<\/div>\n<p style="margin:0 0 1em">before<\/p>$/);
    });
    test('quote followed by more content keeps document order', () => {
        const out = html('intro\n\n> quoted\n\nafter');
        expect(out.indexOf('intro')).toBeLessThan(out.indexOf('quoted'));
        expect(out.indexOf('quoted')).toBeLessThan(out.indexOf('after'));
        expect(out.indexOf('</div>')).toBeLessThan(out.indexOf('after'));
        expect(text('intro\n\n> quoted\n\nafter')).toBe('intro\n\n> quoted\n\nafter');
    });
    test('tables and hidden raw HTML inside a quote behave as outside it', () => {
        const out = md('> | a | b |\n> |---|--:|\n> | 1 | 2 |\n>\n> <div style="display:none">secret</div><p hidden>gone</p>shown');
        expect(out.html).not.toMatch(/<blockquote/);
        expect(out.html).toContain('secret');
        expect(out.text).not.toMatch(/secret|gone/);
        expect(out.text).toMatch(/^> a {3}b$/m);
        expect(out.text).toMatch(/^> 1 {3}2$/m);
        expect(out.text).toMatch(/^> shown$/m);
        const big = md(`> <table><tr><td colspan=1000000>x</td></tr></table>`);
        expect(big.text).toBe('> x');
    });
    test('raw HTML <blockquote> inside Markdown stays a blockquote in both parts', () => {
        const out = md('<blockquote>raw</blockquote>\n\n> md');
        expect(out.html).toContain('<blockquote>raw</blockquote>');
        expect(out.text).toBe('> raw\n\n> md');
    });
    describe('task lists', () => {
        const BOX = 'padding:0 .5em .25em 0;vertical-align:top';
        const CELL = 'padding:0 0 .25em;vertical-align:top';
        const TABLE = 'border-collapse:collapse;margin:0 0 1em 2em';
        const NESTED = 'border-collapse:collapse;margin:.25em 0 0 0';
        const row = (box: string, content: string): string => `<tr><td style="${BOX}">${box}</td><td style="${CELL}">${content}</td></tr>`;
        const clean = (out: string): void => { expect(out).not.toMatch(/class=|<input|data-|list-style|️|︎|☑/); };

        test('a bullet list of only task items is a table with one row per item', () => {
            const out = html('- [ ] todo\n- [x] done');
            expect(out).toBe(`<table style="${TABLE}">\n${row('☐', 'todo')}\n${row('☒', 'done')}\n</table>`);
            expect(out).not.toMatch(/<ul|<ol|<li/);
            clean(out);
        });
        test('inline formatting and links stay in the item cell', () => {
            expect(html('- [x] **b** [l](https://example.com)')).toContain(row('☒', '<strong>b</strong> <a href="https://example.com">l</a>'));
        });
        test('a nested all-task list is a table inside the parent cell, indented by the cell', () => {
            const out = html('- [ ] a\n  - [x] b\n- [x] c');
            expect(out).toBe(`<table style="${TABLE}">\n<tr><td style="${BOX}">☐</td><td style="${CELL}">a<table style="${NESTED}">\n${row('☒', 'b')}\n</table>\n</td></tr>\n${row('☒', 'c')}\n</table>`);
            clean(out);
        });
        test('a nested ordered list inside a task table keeps its numbers', () => {
            const out = html('- [x] a\n  1. [ ] b');
            expect(out).toMatch(/^<table [^>]*>\n<tr><td [^>]*>☒<\/td><td [^>]*>a<ol style="margin:\.25em 0 0;padding-left:2em">\n<li style="margin:0 0 \.25em">☐ b<\/li>\n<\/ol>\n<\/td><\/tr>\n<\/table>$/);
        });
        test('a final task table in a quote drops only its bottom margin and no blockquote appears', () => {
            const out = html('> - [x] q\n> - [ ] r');
            expect(out).toContain(`<table style="${TABLE};margin-bottom:0">\n${row('☒', 'q')}\n${row('☐', 'r')}\n</table>\n</div>`);
            expect(out).not.toMatch(/<blockquote/);
            clean(out);
            expect(html('> - [x] q\n\nafter')).toContain(`<table style="${TABLE};margin-bottom:0">`);
            expect(html('> - [x] q\n>\n> more')).toContain(`<table style="${TABLE}">`);
        });
        test('a task list nested in an ordinary list item is a table spaced like a nested list', () => {
            const out = html('- plain\n  - [ ] t\n  - [x] u');
            expect(out).toBe(`<ul style="margin:0 0 1em;padding-left:2em">\n<li style="margin:0 0 .25em">plain<table style="${NESTED}">\n${row('☐', 't')}\n${row('☒', 'u')}\n</table>\n</li>\n</ul>`);
        });
        test('a loose task list puts each item\'s paragraphs and blocks in the item cell', () => {
            const out = html('- [ ] a\n\n- [x] b\n\n  more\n\n  ```\n  x\n  ```');
            expect(out).toMatch(/^<table style="[^"]*">\n<tr><td style="[^"]*">☐<\/td><td style="[^"]*"><p style="margin:0 0 1em">a<\/p>\n<\/td><\/tr>\n<tr><td style="[^"]*">☒<\/td><td style="[^"]*"><p style="margin:0 0 1em">b<\/p>\n<p style="margin:0 0 1em">more<\/p>\n<pre /);
            expect(out).toMatch(/<\/pre>\n<\/td><\/tr>\n<\/table>$/);
            clean(out);
        });
        test('empty task items keep a well-formed row', () => {
            const out = html('- [ ]\n- [x]');
            expect(out).toBe(`<table style="${TABLE}">\n${row('☐', '')}\n${row('☒', '')}\n</table>`);
            expect(text('- [ ]\n- [x]')).toBe(' - [ ]\n - [x]');
        });
        test('a list mixing task and ordinary items stays a list with the box before each task item', () => {
            const out = html('- [ ] a\n- b\n- [x] c');
            expect(out).toBe('<ul style="margin:0 0 1em;padding-left:2em">\n<li style="margin:0 0 .25em">☐ a</li>\n<li style="margin:0 0 .25em">b</li>\n<li style="margin:0 0 .25em">☒ c</li>\n</ul>');
            clean(out);
            expect(html('- a\n- [x] b')).not.toContain('<table');
        });
        test('an ordered task list stays an ordered list with numbers and boxes', () => {
            const out = html('3. [x] a\n4. [ ] b');
            expect(out).toBe('<ol start="3" style="margin:0 0 1em;padding-left:2em">\n<li style="margin:0 0 .25em">☒ a</li>\n<li style="margin:0 0 .25em">☐ b</li>\n</ol>');
            clean(out);
        });
        test('a checkbox written as literal text is not a task item', () => {
            for (const source of ['- \\[x] a', '- `[x]` a', '- [x]a']) {
                const out = html(source);
                expect(out).toMatch(/^<ul /);
                expect(out).not.toMatch(/<table|☐|☒/);
            }
        });
        test('the plain text is the same for every task list shape (boxes are [x] and [ ], never table rows)', () => {
            expect(text('- [ ] todo\n- [x] done')).toBe(' - [ ] todo\n - [x] done');
            expect(text('- [ ] a\n  - [x] b\n  - [ ] c\n- [x] d')).toBe(' - [ ] a\n    - [x] b\n    - [ ] c\n - [x] d');
            expect(text('> - [x] q\n> - [ ] r')).toBe('>  - [x] q\n>  - [ ] r');
            expect(text('- plain\n  - [ ] t\n  - [x] u')).toBe(' - plain\n    - [ ] t\n    - [x] u');
            expect(text('- [ ] a\n- b\n- [x] c')).toBe(' - [ ] a\n - b\n - [x] c');
            expect(text('1. [x] a\n2. [ ] b')).toBe(' 1. [x] a\n 2. [ ] b');
            expect(text('- [ ] a\n\n- [x] b\n\n  more')).toBe(' - [ ] a\n - [x] b\n   more');
            expect(text('- [x] a\n  1. [ ] b')).toBe(' - [x] a\n    1. [ ] b');
        });
    });
    test('bullet, numbered and nested lists keep their structure', () => {
        const out = html('1. one\n   - nested\n2. two\n\n3. three\n\n5. five');
        expect(out).toMatch(/<ol style="[^"]*">/);
        expect(out).toMatch(/<ul style="[^"]*">/);
        expect(out.indexOf('<ul')).toBeGreaterThan(out.indexOf('<ol'));
        expect(html('3. a\n4. b')).toContain('<ol start="3"');
    });
    test('images are responsive and cid: URLs survive untouched', () => {
        const out = html('![Logo](cid:logo@example.test "Our logo") and ![remote](https://example.com/a.png)');
        expect(out).toContain('src="cid:logo@example.test"');
        expect(out).toContain('alt="Logo"');
        expect(out).toContain('title="Our logo"');
        expect(out.match(/style="max-width:100%;height:auto"/g)).toHaveLength(2);
        expect(html('[inline](cid:abc)')).toContain('href="cid:abc"');
    });
    test('horizontal rules are a single light line', () => {
        expect(html('a\n\n---\n\nb')).toMatch(/<hr style="border:0;border-top:1px solid #d0d7de[^"]*">/);
    });
    test('raw HTML passes through untouched', () => {
        const out = html('<div class="x" onclick="go()">hi <b>there</b></div>\n\nInline <span style="color:red">red</span> text');
        expect(out).toContain('<div class="x" onclick="go()">hi <b>there</b></div>');
        expect(out).toContain('<span style="color:red">red</span>');
    });
    test('unknown angle-bracket words are literal text; known HTML tags and comments still pass through', () => {
        const out = md('Send it to <your manager> and reply <yes> or <no>.');
        expect(out.html).toBe('<p style="margin:0 0 1em">Send it to &lt;your manager&gt; and reply &lt;yes&gt; or &lt;no&gt;.</p>');
        expect(out.text).toBe('Send it to <your manager> and reply <yes> or <no>.');
        const alone = md('<yes>\n\nafter');
        expect(alone.html).toContain('&lt;yes&gt;');
        expect(alone.text).toBe('<yes>\n\nafter');
        expect(html('a <b>bold</b> c')).toBe('<p style="margin:0 0 1em">a <b>bold</b> c</p>');
        expect(html('x<br>y')).toContain('x<br>y');
        for (const raw of ['<br>', '<table><tr><td>cell</td></tr></table>', '<div style="color:red">x</div>', '<!-- note -->', '<DIV class="x">x</DIV>', '<img src="cid:a" alt="b">']) { expect(html(raw)).toBe(raw); }
        expect(html('before <!-- hidden --> after')).toContain('before <!-- hidden --> after');
    });
    test('script-like and form-like tags in Markdown are shown as escaped text, never passed through', () => {
        const script = md('<script>alert(1)</script>');
        expect(script.html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(script.text).toBe('<script>alert(1)</script>');
        for (const tag of ['style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base']) {
            const out = md(`before <${tag} x="1"> mid </${tag}> after`);
            expect(out.html).not.toContain(`<${tag}`);
            expect(out.html).toContain(`&lt;${tag} x=&quot;1&quot;&gt;`);
            expect(out.text).toBe(`before <${tag} x="1"> mid </${tag}> after`);
            expect(html(`<${tag} src="x">\n\ntext`)).not.toContain(`<${tag}`);
        }
    });
    test('an html block mixing known and unknown tags is handled tag by tag', () => {
        const out = md('<div class="a">hi <your name>, 1 < 2 &amp; <b title="a>b">bold</b>\n<![CDATA[x]]>\n<?pi x?></div>');
        expect(out.html).toBe('<div class="a">hi &lt;your name&gt;, 1 < 2 &amp; <b title="a>b">bold</b>\n&lt;![CDATA[x]]&gt;\n&lt;?pi x?&gt;</div>');
        expect(out.text).toBe('hi <your name>, 1 < 2 & bold <![CDATA[x]]> <?pi x?>');
        // An unterminated tag-like sequence escapes its '<' and the rest of the block is escaped the same way.
        expect(html('<div>\n<b title="x\n<i>y</i>\n</div>')).toBe('<div>\n&lt;b title="x\n&lt;i>y&lt;/i>\n&lt;/div>');
    });
    test('{html} input with the same strings is returned byte-identical', () => {
        for (const source of ['Send it to <your manager> and reply <yes> or <no>.', '<script>alert(1)</script>', 'a <b>bold</b> c', '<br>', '<!-- c -->', '<div style="x">x</div>']) {
            expect(renderBody({ html: source }).html).toBe(source);
        }
    });
    test('markdown link and image syntax cannot produce script-bearing URLs', () => {
        const out = html('[a](javascript:alert(1)) [b](JAVASCRIPT:alert(2)) [c](vbscript:x) [d](data:text/html;base64,AAAA) ![e](javascript:alert(3)) ![f](data:image/svg+xml;base64,AAAA) [ok](https://example.com) [rel](/path) [frag](#top) [m](mailto:a@example.com)');
        expect(out).not.toMatch(/javascript:|vbscript:|data:/i);
        expect(out).not.toMatch(/<img [^>]*src="(?!cid:|https?:)/);
        expect(out).toContain('>a ');
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('href="/path"');
        expect(out).toContain('href="#top"');
        expect(out).toContain('href="mailto:a@example.com"');
        expect(out).toContain('d e f');
    });
    test('never adds classes, style blocks, inputs, scripts, event handlers or remote resources of its own', () => {
        const out = html('# H\n\n- [x] a\n\n| a |\n|---|\n| b |\n\n```js\nx\n```\n\n> q\n\n`c` ![i](cid:x) [l](https://example.com)\n\n---');
        expect(out).not.toMatch(/<style|class=|<input|<script|\son\w+=|<link|<img [^>]*src="https?:/i);
    });
    test('output is an HTML fragment', () => {
        expect(html('# Title\n\ntext')).not.toMatch(/<html|<head|<body|<!doctype/i);
    });
    test('special characters are escaped', () => {
        expect(html('Tom & Jerry <3 "q" it\'s')).toContain('Tom &amp; Jerry &lt;3 &quot;q&quot; it&#39;s');
    });
});

describe('email signature delimiter', () => {
    test('"-- " and "--" after paragraph text are literal lines, not a setext heading', () => {
        for (const delimiter of ['-- ', '--']) {
            const out = md(`Cheers,\nBob\n${delimiter}\nBob Smith`);
            expect(out.html).toBe('<p style="margin:0 0 1em">Cheers,<br>Bob<br>-- <br>Bob Smith</p>');
            expect(out.text).toBe('Cheers,\nBob\n-- \nBob Smith');
        }
        expect(md('Cheers,\nBob\n-- ').text).toBe('Cheers,\nBob\n-- ');
        expect(md('Thanks\n\n-- \nBob').text).toBe('Thanks\n\n-- \nBob');
        expect(md('> Cheers\n> -- \n> Bob').text).toBe('> Cheers\n> --\n> Bob');
        expect(md('- Cheers\n  -- \n  Bob').text).toBe(' - Cheers\n   --\n   Bob');
    });
    test('three or more dashes, equals signs and longer runs keep their normal Markdown meaning', () => {
        expect(html('Cheers\n---')).toMatch(/^<h2 [^>]*>Cheers<\/h2>$/);
        expect(html('Cheers\n----  ')).toMatch(/^<h2 /);
        expect(html('Cheers\n=')).toMatch(/^<h1 /);
        expect(html('Cheers\n\n---\n\nBob')).toContain('<hr ');
        expect(html('Cheers\n--  ')).toMatch(/^<h2 /);
        expect(html('Cheers\n -- ')).toMatch(/^<h2 /);
        expect(html('Cheers\n- ')).toMatch(/^<h2 /);
        expect(html('a\n-- \nb\n---')).toMatch(/<p [^>]*>a<br>-- <br>b<\/p>\n<hr /);
    });
    test('code and other text that merely contains dashes is untouched', () => {
        expect(html('```\n-- \nx\n```')).toContain(`${PRE_CODE}-- \nx</code>`);
        expect(text('a -- b\nc')).toBe('a -- b\nc');
        expect(text('x\n--- \ny')).toBe('x\n-\n\ny');
    });
    test('an HTML "-- <br>" or "-- " block keeps the trailing space in the text part, and nothing else gains one', () => {
        expect(renderBody({ html: '<p>Bob<br>-- <br>Smith</p>' }).text).toBe('Bob\n-- \nSmith');
        expect(renderBody({ html: '<div>-- </div><div>Name</div>' }).text).toBe('-- \nName');
        expect(renderBody({ html: '<p>a --<br>b -- <br>-x </p>' }).text).toBe('a --\nb --\n-x');
        expect(renderBody({ html: '<p>--  <br>Smith</p>' }).text).toBe('-- \nSmith');
        expect(renderBody({ html: '<p>Bob<br>--<br>Smith</p>' }).text).toBe('Bob\n--\nSmith');
    });
});

describe('plain text generation', () => {
    const sample = [
        'Hi **there**, see [the docs](https://example.com/docs) or <https://example.com/bare> or <a@example.com> or [mail me](mailto:me@example.com).',
        '', '# Big title', '', '## Section', '', '### Sub', '',
        '1. one', '   - nested', '2. two', '', '- [ ] todo', '- [x] done', '',
        '| Name | Qty |', '|:---|---:|', '| apple | 1 |', '| watermelon | 22 |', '',
        '> outer', '>', '> > inner', '',
        'Use `code` and:', '', '```', 'a  b', '  c', '```', '', '![Logo](cid:logo@example.test) and ![pic](https://example.com/p.png)', '', '---', '', 'Thanks,', 'Craig',
    ].join('\n');
    const out = text(sample);
    const lines = out.split('\n');
    test('has no Markdown markers or markup', () => {
        expect(out).not.toMatch(/\*\*|~~|```|<\w|&\w+;|\]\(/);
        expect(out).not.toContain('`');
        expect(out).not.toMatch(/[☐-☒]/);
    });
    test('links read "text [url]", omit the bracket when identical and drop cid:/mailto: noise', () => {
        expect(out).toContain('the docs [https://example.com/docs]');
        expect(out).toContain('or https://example.com/bare or');
        expect(out).not.toContain('https://example.com/bare [');
        expect(out).toContain('a@example.com or');
        expect(out).toContain('mail me [me@example.com]');
        expect(out).not.toMatch(/mailto:|cid:/);
        expect(text('[x](cid:abc)')).toBe('x');
    });
    test('images become their alt text', () => {
        expect(out).toContain('Logo and pic');
        expect(out).not.toContain('example.com/p.png');
        expect(out).not.toContain('logo@example.test');
    });
    test('headings stand out', () => {
        expect(lines).toContain('Big title');
        expect(lines[lines.indexOf('Big title') + 1]).toBe('='.repeat('Big title'.length));
        expect(lines[lines.indexOf('Section') + 1]).toBe('-------');
        expect(lines).toContain('Sub');
        expect(lines[lines.indexOf('Sub') - 1]).toBe('');
        expect(lines[lines.indexOf('Sub') + 1]).toBe('');
    });
    test('lists keep markers and nesting', () => {
        expect(out).toMatch(/^ 1\. one$/m);
        expect(out).toMatch(/^ 2\. two$/m);
        expect(out).toMatch(/^ {3,}- nested$/m);
    });
    test('task items are [ ] and [x]', () => {
        expect(out).toMatch(/^ - \[ \] todo$/m);
        expect(out).toMatch(/^ - \[x\] done$/m);
    });
    test('tables are aligned columns', () => {
        const header = lines.find(line => line.startsWith('Name')) ?? '';
        const apple = lines.find(line => line.startsWith('apple')) ?? '';
        const melon = lines.find(line => line.startsWith('watermelon')) ?? '';
        expect(header).not.toBe('');
        expect(header.indexOf('Qty')).toBeGreaterThan(0);
        expect(apple.indexOf('1')).toBe(header.indexOf('Qty'));
        expect(melon.indexOf('22')).toBe(header.indexOf('Qty'));
        expect(out).not.toMatch(/\|/);
    });
    test('block quotes are real "> " lines and nest', () => {
        expect(out).toMatch(/^> outer$/m);
        expect(out).toMatch(/^> > inner$/m);
    });
    test('code is kept verbatim, rules are dashes, sign-off stays on its own lines', () => {
        expect(out).toContain('Use code and:');
        expect(out).toMatch(/^a {2}b\n {2}c$/m);
        expect(out).toMatch(/^-{20,}$/m);
        expect(out).toMatch(/Thanks,\nCraig$/);
    });
    test('is not hard-wrapped and has no trailing whitespace', () => {
        const long = `${'word '.repeat(60)}https://example.com/${'p'.repeat(200)}`;
        const wide = text(`${long}\n\n[${'link '.repeat(30)}](https://example.com/q)`);
        expect(wide.split('\n')[0]).toBe(long);
        expect(wide).toContain(`https://example.com/${'p'.repeat(200)}`);
        for (const line of lines) { expect(line).toBe(line.trimEnd()); }
        expect(out).toBe(out.trim());
    });
    test('loose task lists and ordered lists with a start number', () => {
        const loose = text('- [ ] one\n\n- [x] two');
        expect(loose).toMatch(/^ - \[ \] one$/m);
        expect(loose).toMatch(/^ - \[x\] two$/m);
        expect(text('3. a\n4. b')).toMatch(/^ 3\. a\n 4\. b$/);
    });
});

describe('html input', () => {
    const source = '<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Title</h1><p>Hello&nbsp;<b>world</b> &amp; <a href="https://example.com">link</a></p><ul><li>one</li><li>two</li></ul><script>alert(1)</script><blockquote>quoted</blockquote><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><img src="cid:x" alt="pic"></body></html>';
    test('returns the html unchanged and derives text from it', () => {
        const out = renderBody({ html: source });
        expect(out.html).toBe(source);
        expect(out.text).toContain('Title\n=====');
        expect(out.text).toContain('Hello world & link [https://example.com]');
        expect(out.text).toMatch(/^ - one\n - two$/m);
        expect(out.text).toMatch(/^> quoted$/m);
        expect(out.text).toMatch(/^A {3}B\n1 {3}2$/m);
        expect(out.text).toContain('pic');
        expect(out.text).not.toMatch(/alert|color:red|<|T\n/);
    });
    test('captured link labels retain their inline whitespace boundaries', () => {
        expect(renderBody({ html: '<p>I<a><b> agree </b></a>today</p>' }).text).toBe('I agree today');
        expect(renderBody({ html: '<p>one<a> </a>two</p>' }).text).toBe('one two');
    });
    test('fragments without <body> work too', () => {
        const out = renderBody({ html: '<p>one</p><p>two</p>' });
        expect(out.html).toBe('<p>one</p><p>two</p>');
        expect(out.text).toBe('one\n\ntwo');
    });
    test('html text matches the markdown path for the same document', () => {
        const generated = md('# T\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[l](https://example.com)');
        expect(renderBody({ html: generated.html ?? '' }).text).toBe(generated.text);
    });
    test('a hand-written <blockquote> keeps its "> " text, a generated quote div does not (the text part comes from the markdown source)', () => {
        const generated = md('> q');
        expect(generated.text).toBe('> q');
        expect(renderBody({ html: generated.html ?? '' }).text).toBe('q');
        expect(renderBody({ html: '<blockquote><p>q</p></blockquote>' }).text).toBe('> q');
    });
    test('CRLF in html is normalized to LF in both output parts', () => {
        const out = renderBody({ html: '<p>a</p>\r\n<p>b</p>\r\n' });
        expect(out.html).toBe('<p>a</p>\n<p>b</p>\n');
        expect(out.text).not.toContain('\r');
    });
    test('pathological nesting hits the HTML depth or Markdown nesting guard, not a crash', () => {
        expect(errorCode({ html: '<div>'.repeat(50000) })).toBe('invalid_input');
        expect(errorCode({ markdown: `${'>'.repeat(30000)} x` })).toBe('too_large');
    });
});

describe('resource-bounded text conversion', () => {
    const withinBudget = (source: string, markdown = false) => {
        const start = performance.now();
        const out = renderBody(markdown ? { markdown: source } : { html: source });
        expect(performance.now() - start).toBeLessThan(2000);
        if (!markdown) { expect(out.html).toBe(source); }
        return out.text;
    };
    test('million-column and million-row spans fall back before grid allocation, including raw Markdown HTML', () => {
        for (const attribute of ['colspan', 'rowspan']) {
            const source = `<table><tr><td ${attribute}=1000000>x</td></tr></table>`;
            expect(withinBudget(source)).toBe('x');
            expect(withinBudget(source, true)).toBe('x');
        }
    });
    test('non-finite, negative, fractional and huge spans cannot enter the table formatter', () => {
        for (const span of ['Infinity', '1e300', '-1', '0', 'NaN', '1.5', '999999999999999999999999']) {
            expect(withinBudget(`<table><tr><td colspan="${span}" rowspan="${span}">x</td><td>y</td></tr></table>`)).toBe('x   y');
        }
    });
    test('large tables fall back, while span attributes never affect shape', () => {
        const tall = `<table>${'<tr><td>x</td></tr>'.repeat(8000)}</table>`;
        expect(withinBudget(tall).split('\n\n')).toEqual(Array(8000).fill('x'));
        const wide = `<table><tr>${'<td>x</td>'.repeat(20000)}</tr></table>`;
        expect(withinBudget(wide).split(' | ')).toHaveLength(20000);
        const square = `<table>${`<tr>${'<td>x</td>'.repeat(65)}</tr>`.repeat(65)}</table>`;
        expect(withinBudget(square).split('\n')).toHaveLength(65);
        const cellLimit = `<table>${`<tr>${'<td>x</td>'.repeat(33)}</tr>`.repeat(33)}</table>`;
        expect(withinBudget(cellLimit).split('\n')[0]).toBe(Array(33).fill('x').join(' | '));
        const area = `<table>${`<tr>${'<td colspan=16>x</td>'.repeat(4)}</tr>`.repeat(65)}</table>`;
        expect(withinBudget(area).split('\n')[0]).toBe('x   x   x   x');
        const spans = `<table>${`<tr>${'<td colspan=16 rowspan=16>x</td>'.repeat(16)}</tr>`.repeat(16)}</table>`;
        expect(withinBudget(spans)).toContain('x   x');
    });
    test('table text cannot amplify into large padding across otherwise bounded rows', () => {
        const source = `<table><tr><td>${'x'.repeat(5000)}</td><td>z</td></tr>${'<tr><td>a</td><td>b</td></tr>'.repeat(100)}</table>`;
        const lines = withinBudget(source).split('\n');
        expect(lines[0]).toBe('x'.repeat(5000) + ' | z');
        expect(lines.slice(1)).toEqual(Array(100).fill('a | b'));
    });
    test('nested layout tables preserve blocks without multiplying grids and spans are ignored', () => {
        const nested = '<table><tr><td>outer<table><tr><td colspan=1000000>inner</td></tr></table>end</td></tr></table>';
        expect(withinBudget(nested)).toBe('outer\n\ninner\n\nend');
        const small = '<table><tr><td colspan=2>A</td></tr><tr><td>B</td><td>C</td></tr></table>';
        expect(withinBudget(small)).toBe('A\nB   C');
        expect(withinBudget('<table><tr><td rowspan=2>A</td><td>B</td></tr><tr><td>C</td></tr></table>')).toContain('A   B');
    });
    test('whitespace-only lines at the HTML limit are processed linearly', () => {
        expect(withinBudget(`<pre>${' \n'.repeat(131060)}x</pre>`)).toBe('x');
        const source = `<pre>${' \n'.repeat(131066)}x</pre>`;
        expect(source).toHaveLength(256 * 1024);
        expect(withinBudget(source)).toBe('x');
    });
    test('fenced-code newline trimming is linear at the Markdown input limit', () => {
        const source = '```\n' + '\n'.repeat(128 * 1024 - 9) + 'x\n```';
        expect(source).toHaveLength(128 * 1024);
        expect(withinBudget(source, true)).toBe('x');
    });
    test('a long horizontal whitespace run before non-whitespace is processed linearly', () => {
        const source = `<pre>${' '.repeat(128 * 1024 - 1)}x</pre>`;
        expect(withinBudget(source)).toBe(' '.repeat(128 * 1024 - 1) + 'x');
        const tooLong = `<pre>${' '.repeat(256 * 1024 - 12)}x</pre>`;
        const start = performance.now();
        expect(errorCode({ html: tooLong })).toBe('too_large');
        expect(performance.now() - start).toBeLessThan(2000);
    });
    test('task conversion does not consume blank lines and heading line counts do not overflow argument limits', () => {
        expect(withinBudget('<pre> \n\n - ☑ done\n\n - ☐ todo</pre>')).toBe(' - ☑ done\n\n - ☐ todo');
        expect(withinBudget(`<h1>${'<br>'.repeat(60000)}x</h1>`)).toContain('x\n=');
    });
    test('ordered list start/type and nesting cannot cause unbounded allocation or Roman formatter errors', () => {
        for (const start of ['Infinity', '-Infinity', 'NaN', '1e300', '-1', '1.5', '1000000', '3999']) {
            for (const type of ['1', 'a', 'A', 'i', 'I']) {
                expect(withinBudget(`<ol start="${start}" type="${type}"><li>x</li><li>y</li></ol>`)).toContain('x');
            }
        }
        expect(withinBudget('<ul><li>'.repeat(20) + 'x' + '</li></ul>'.repeat(20))).toContain('x');
        expect(errorCode({ html: '<ul><li>'.repeat(100) + 'x' + '</li></ul>'.repeat(100) })).toBe('invalid_input');
    });
    test('hidden attributes and inline hidden styles omit entire subtrees without changing HTML', () => {
        for (const attr of ['hidden', 'hidden="false"', 'style="display:none"', 'style="DISPLAY: none !important; color:red"', 'style="display:block;display:none"', 'style="display:none;display:garbage"']) {
            expect(withinBudget(`<p>I <span ${attr}>NOT </span>agree</p>`)).toBe('I agree');
            expect(withinBudget(`<table><tr ${attr}><td>NOT</td></tr><tr><td>yes</td><td ${attr}>NOT</td></tr></table>`)).toBe('yes');
            expect(withinBudget(`<div ${attr}><table><tr><td colspan=1000000>NOT</td></tr></table></div><p>yes</p>`, true)).toBe('yes');
        }
        expect(withinBudget('<span style="display:inline;visibility:visible">visible</span>')).toBe('visible');
    });
});

describe('decoded Markdown URLs and attributes', () => {
    test('entity-obfuscated disallowed schemes are plain text in inline links, references and images', () => {
        const urls = [
            'javascript&#58;alert(1)', 'javascript&#58alert(1)', 'javascript&#x3a;alert(1)', 'javascript&#x3az(1)',
            'javascript&colon;alert(1)', 'java&#x09;script:alert(1)', 'java&#9script:alert(1)',
            'java&Tab;script:alert(1)', 'java&NewLine;script:alert(1)', 'java&#10;script:alert(1)', 'java&#13;script:alert(1)',
            '&#1;&#32;JaVaScRiPt:alert(1)', 'JAVASCRIPT:alert(1)', 'vbscript&colon;x', 'data&colon;text/html,x',
            'attachment:ATT1', 'attachment&#58;ATT1', 'attachment&#58ATT1', 'attachment&#x3a;ATT1', 'AtTaChMeNt&colon;ATT1',
        ];
        for (const url of urls) {
            for (const markdown of [`[x](${url})`, `![x](${url})`, `[x][a]\n\n[a]: ${url}`, `![x][a]\n\n[a]: ${url}`]) {
                const out = md(markdown);
                expect(out.html).toBe('<p style="margin:0 0 1em">x</p>');
                expect(out.text).toBe('x');
            }
        }
        const tab = md('[x](<java\tscript:alert(1)>)');
        expect(tab.html).toBe('<p style="margin:0 0 1em">x</p>');
        expect(tab.text).toBe('x');
        // Literal LF/CR are not valid Markdown destinations. CommonMark leaves the
        // syntax as text; encoded LF/CR above exercise actual URL classification.
        for (const url of ['java\nscript:alert(1)', 'java\rscript:alert(1)']) {
            const out = md(`[x](<${url}>)`);
            expect(out.html).toBe('<p style="margin:0 0 1em">[x](&lt;java<br>script:alert(1)&gt;)</p>');
            expect(out.text).toBe('[x](<java\nscript:alert(1)>)');
        }
    });
    test('autolinks classify decoded URLs and escape rejected labels as plain text', () => {
        for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'attachment:ATT1', 'attachment:ATT&#49;']) {
            const out = md(`<${url}>`);
            expect(out.html).not.toMatch(/<a |href=|<img /);
            expect(out.text).toBe(url.replace('&#49;', '1'));
        }
        // Encoded scheme delimiters are not autolink syntax; they must stay
        // escaped literal text rather than becoming HTML tags or anchors.
        for (const [url, htmlLabel, textLabel] of [
            ['javascript&#58;alert(1)', 'javascript:alert(1)', 'javascript:alert(1)'],
            ['java&#x09;script:alert(1)', 'java\tscript:alert(1)', 'java script:alert(1)'],
            ['attachment&#58;ATT1', 'attachment:ATT1', 'attachment:ATT1'],
            ['javascript&colon;alert(1)', 'javascript:alert(1)', 'javascript:alert(1)'],
        ]) {
            const out = md(`<${url}>`);
            expect(out.html).toBe(`<p style="margin:0 0 1em">&lt;${htmlLabel}&gt;</p>`);
            expect(out.text).toBe(`<${textLabel}>`);
        }
        const accepted = md('<https://example.test/a?x=1&amp;y=2>');
        expect(accepted.html).toContain('href="https://example.test/a?x=1&amp;y=2"');
        expect(accepted.html).not.toContain('&amp;amp;');
        expect(accepted.text).toBe('https://example.test/a?x=1&y=2');
    });
    test('allowed decoded schemes use exactly the checked value in strictly escaped attributes', () => {
        for (const url of ['https&#58;//example.test', 'hTtPs&colon;//example.test', 'https&#58//example.test']) {
            const out = md(`[x](${url})`);
            expect(out.html).toMatch(/href="https:\/\/example.test"/i);
            expect(out.text.toLowerCase()).toBe('x [https://example.test]');
        }
        const legacyNamed = md('[x](https://example.test/?x=&copy)');
        expect(legacyNamed.html).toContain('href="https://example.test/?x=&amp;copy"');
        expect(legacyNamed.text).toBe('x [https://example.test/?x=&copy]');
        const escaped = md('[x](https://example.test/&quot;&lt;&gt;&#39; "&quot;title&quot;")');
        expect(escaped.html).toContain('href="https://example.test/&quot;&lt;&gt;&#39;" title="&quot;title&quot;"');
        expect(escaped.text).toContain('x [https://example.test/"<>\']');
    });
    test('image source, alt text, titles, link text and CID entities decode once and escape once', () => {
        const image = md('![Tom &amp; Jerry](https://example.test/a?x=1&amp;y=2 "Fish &amp; Chips")');
        expect(image.html).toContain('src="https://example.test/a?x=1&amp;y=2" alt="Tom &amp; Jerry" title="Fish &amp; Chips"');
        expect(image.text).toBe('Tom & Jerry');
        const cid = md('![x](cid:logo&#64;example.test)');
        expect(cid.html).toContain('src="cid:logo@example.test"');
        expect(cid.text).toBe('x');
        const link = md('[Tom &amp; Jerry](https://example.test/a?x=1&amp;y=2 "Fish &amp; Chips")');
        expect(link.html).toContain('href="https://example.test/a?x=1&amp;y=2" title="Fish &amp; Chips">Tom &amp; Jerry</a>');
        expect(link.text).toBe('Tom & Jerry [https://example.test/a?x=1&y=2]');
        const once = md('![&amp;amp;](https://example.test/?x=&amp;amp; "&amp;amp;")');
        expect(once.html).toContain('src="https://example.test/?x=&amp;amp;" alt="&amp;amp;" title="&amp;amp;"');
        expect(once.text).toBe('&amp;');
    });
});

describe('determinism and line endings', () => {
    const sample = '# T\n\nThanks,\nCraig\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```\ncode\n```';
    test('same input twice gives identical output, for every format', () => {
        for (const input of [{ markdown: sample }, { html: '<p>x<br>y</p>' }, { text: sample }] as const) { expect(renderBody(input)).toEqual(renderBody(input)); }
    });
    test('output is LF-only even for CRLF and CR input', () => {
        for (const input of ['a\r\nb\r\n\r\n- x\r\n- y\r\n\r\n```\r\ncode\r\n```\r\n', 'a\rb\r\rc']) {
            const out = md(input);
            expect(out.html).not.toContain('\r');
            expect(out.text).not.toContain('\r');
        }
    });
});

// Keep historical hang/OOM reproductions out of the test runner. A deadline and
// bounded pipe make a reintroduced unbounded formatter fail rather than hang CI.
function isolated(input: BodyInput): { text?: string; error?: string; elapsed: number } {
    const script = `
        import { renderBody } from ${JSON.stringify(new URL('../src/mail/render.ts', import.meta.url).pathname)};
        import { MailError } from ${JSON.stringify(new URL('../src/mail/contracts.ts', import.meta.url).pathname)};
        const input = JSON.parse(await Bun.stdin.text());
        const start = performance.now();
        try { console.log(JSON.stringify({ text: renderBody(input).text, elapsed: performance.now() - start })); }
        catch (error) { console.log(JSON.stringify({ error: error instanceof MailError ? error.code : 'unexpected', elapsed: performance.now() - start })); }
    `;
    const child = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout) as { text?: string; error?: string; elapsed: number };
    expect(result.elapsed).toBeLessThan(2000);
    expect(Buffer.byteLength(result.text ?? '')).toBeLessThanOrEqual(128 * 1024);
    if (result.error) { expect(['too_large', 'invalid_input']).toContain(result.error); }
    return result;
}

describe('single-parse and amplification regressions', () => {
    test('raw-text and RCDATA elements never create nodes through serialization', () => {
        const payload = '&lt;table&gt;&lt;tr&gt;&lt;td colspan=200000&gt;x&lt;/td&gt;&lt;td&gt;y&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;';
        for (const tag of ['iframe', 'noembed', 'noframes', 'template', 'title']) {
            expect(isolated({ html: `<${tag}>${payload}</${tag}>` }).text).toBe('');
            expect(renderBody({ html: `<${tag}>&lt;div hidden&gt;SECRET&lt;/div&gt;</${tag}>` }).text).toBe('');
        }
        expect(isolated({ html: '<noscript>&lt;table&gt;&lt;tr&gt;&lt;td colspan=100000 rowspan=100000&gt;x&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</noscript>' }).text).toBe('<table><tr><td colspan=100000 rowspan=100000>x</td></tr></table>');
        expect(isolated({ html: '<noscript>&lt;ol type=i start=99999999&gt;&lt;li&gt;x&lt;/li&gt;&lt;/ol&gt;</noscript>' }).text).toBe('<ol type=i start=99999999><li>x</li></ol>');
        expect(isolated({ html: `<noscript>${'&lt;div&gt;'.repeat(100)}x${'&lt;/div&gt;'.repeat(100)}</noscript>` }).text).toBe('<div>'.repeat(100) + 'x' + '</div>'.repeat(100));
        expect(renderBody({ html: '<textarea>&lt;x&gt;&amp;lt;y&amp;gt;</textarea>' }).text).toBe('<x>&lt;y&gt;');
        expect(renderBody({ html: '<xmp>&lt;x&gt;<b>literal</b></xmp>' }).text).toBe('&lt;x&gt;<b>literal</b>');
        // htmlparser2 12 treats plaintext as a raw-text element like xmp, as WHATWG does: it never
        // closes, so the rest of the input (the end tag included) is literal text and references
        // stay undecoded. Nothing becomes a node, so the apparent dangerous table stays inert text.
        expect(isolated({ html: `<plaintext>${payload}</plaintext>` }).text).toBe(`${payload}</plaintext>`);
        expect(isolated({ html: `<textarea>${payload}</textarea>` }).text).toBe('<table><tr><td colspan=200000>x</td><td>y</td></tr></table>');
    });
    test('multiline padding attacks emit compact unpadded rows, in HTML and Markdown', () => {
        const source = '<table><tr><td>' + 'x'.repeat(60000) + '</td><td>' + 'y<br>'.repeat(30000) + '</td></tr></table>';
        const out = isolated({ html: source });
        expect(out.error).toBeUndefined();
        expect(out.text).toBe('x'.repeat(60000) + '\n\n' + Array(30000).fill('y').join('\n'));
        const markdown = '| ' + 'x'.repeat(50000) + ' | b |\n|---|---|\n| a | ' + 'y<br>'.repeat(14000) + ' |';
        const mdOut = isolated({ markdown });
        expect(mdOut.error).toBeUndefined();
        expect(mdOut.text).toBe('x'.repeat(50000) + '\n\nb\n\na\n\n' + Array(14000).fill('y').join('\n'));
        const many = '<table><tr>' + ('<td>' + 'x'.repeat(190) + '</td>').repeat(127) + '<td>' + 'y<br>'.repeat(20000) + '</td></tr></table>';
        const manyOut = isolated({ html: many });
        expect(manyOut.error).toBeUndefined();
        expect(manyOut.text).toBe([...Array(127).fill('x'.repeat(190)), Array(20000).fill('y').join('\n')].join('\n\n'));
    });
    test('ordinary 80x4 tables and the sample three-column layout stay aligned', () => {
        const rows = Array.from({ length: 80 }, (_, index) => `| row${index} | ${index} | c | done |`);
        const out = text(['| Name | N | C | State |', '|---|---|---|---|', ...rows].join('\n')).split('\n');
        expect(out).toHaveLength(81);
        expect(out[0]).toBe('Name    N    C   State');
        expect(out[1]).toBe('row0    0    c   done');
        expect(out[80]).toBe('row79   79   c   done');
        expect(text('| Name | Qty | Note |\n|---|---|---|\n| a | 1 | x |\n| long | 22 | y |')).toBe('Name   Qty   Note\na      1     x\nlong   22    y');
    });
    test('alignment is gated on lines, width, dimensions and a padded-byte budget', () => {
        expect(renderBody({ html: '<table><tr><td>a<br>b</td><td>c</td></tr></table>' }).text).toBe('a\nb\n\nc');
        expect(renderBody({ html: `<table><tr><td>${'x'.repeat(61)}</td><td>c</td></tr></table>` }).text).toBe('x'.repeat(61) + ' | c');
        expect(renderBody({ html: `<table>${'<tr><td>a</td><td>b</td></tr>'.repeat(201)}</table>` }).text.split('\n')).toEqual(Array(201).fill('a | b'));
        expect(renderBody({ html: `<table><tr>${'<td>a</td>'.repeat(21)}</tr></table>` }).text).toBe(Array(21).fill('a').join(' | '));
        const budget = `<table><tr>${(`<td>${'x'.repeat(60)}</td>`).repeat(20)}</tr>${`<tr>${'<td>y</td>'.repeat(20)}</tr>`.repeat(199)}</table>`;
        expect(renderBody({ html: budget }).text.split('\n')[1]).toBe(Array(20).fill('y').join(' | '));
        const nested = '<table><tr><td>outer<table><tr><td>a</td><td>bbbb</td></tr><tr><td>cc</td><td>d</td></tr></table>end</td><td>last</td></tr></table>';
        expect(renderBody({ html: nested }).text).toBe('outer\n\na    bbbb\ncc   d\n\nend\n\nlast');
    });
    test('bounded sinks abort expanding headings, quotes, links, tables and UTF-8 output', () => {
        for (const source of [
            `<h1>${'x'.repeat(70000)}</h1>`,
            `<blockquote>${'x<br>'.repeat(45000)}</blockquote>`,
            `<a href="${'x'.repeat(70000)}">${'y'.repeat(70000)}</a>`,
            `<table><tr>${'<td>x'.repeat(35000)}</tr></table>`,
            `<p>${'é'.repeat(65537)}</p>`,
        ]) { expect(isolated({ html: source }).error).toBe('too_large'); }
    });
    test('fixed property corpus returns only bounded text or MailError within a deadline', () => {
        const cases = [
            '', '<p>Hello &amp; world</p>', '<!-- comment -->', '<h1>T</h1><p>x<br>y</p>',
            '<table><tr><td colspan=1e99 rowspan=1e99>x</td><td>y</td></tr></table>',
            '<textarea>&lt;div hidden&gt;literal&lt;/div&gt;</textarea>',
            '<xmp><b>literal</b></xmp>', '<template><h1>hidden</h1></template>',
            '<p hidden="false">hidden</p><p style="display:none;display:block">shown</p>',
            '<ol start=99999999 type=i><li>x</li><li>y</li></ol>',
            '<div>'.repeat(100) + 'x' + '</div>'.repeat(100),
            '<div>'.repeat(20000) + '</unknown>'.repeat(10000),
            `<pre>${' \n'.repeat(100000)}x</pre>`,
            `<span style="display:none;display:${' '.repeat(100000)}invalid">shown</span>`,
        ];
        for (const source of cases) {
            const start = performance.now();
            try { expect(Buffer.byteLength(renderBody({ html: source }).text)).toBeLessThanOrEqual(128 * 1024); }
            catch (error) { expect(error).toBeInstanceOf(MailError); expect(['invalid_input', 'too_large']).toContain((error as MailError).code); }
            expect(performance.now() - start).toBeLessThan(2000);
        }
    });
});

describe('strict references, visibility and quote tails', () => {
    test('unterminated named references stay intact in URLs, autolinks, alt and title', () => {
        const query = '?q=x&region=us&section=2&currency=EUR&notify=1&times=3&copy=4&para=5';
        const url = 'https://example.com/s' + query;
        for (const markdown of [`[s](${url})`, `<${url}>`, url, `![s](${url})`]) {
            const out = md(markdown);
            expect(out.html).toContain(url.replaceAll('&', '&amp;'));
            expect(out.html).not.toMatch(/[®§¤¬×©¶]/);
            if (!markdown.startsWith('!')) { expect(out.text).toContain(url); }
        }
        const label = '&region &section &not &curren &times &copy &para';
        const out = md(`![${label}](https://example.com "${label}")`);
        expect(out.html).toContain(`alt="${label.replaceAll('&', '&amp;')}" title="${label.replaceAll('&', '&amp;')}"`);
        expect(out.text).toBe(label);
        expect(md('![&copy;](https://example.com "&reg;")').html).toContain('alt="©" title="®"');
    });
    test('controls anywhere and leading Unicode whitespace/format characters reject URLs without repair', () => {
        const controls = [1, 9, 10, 13, 31, 127, 129, 141, 143, 144, 157];
        const leading = [32, 160, 0x85, 0x2000, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff];
        const urls = [
            ...controls.flatMap(code => [`https://example.test/a&#${code};b`, `h&#${code};ttps://example.test`]),
            ...leading.map(code => `${String.fromCodePoint(code)}https://example.test`),
            '&#32;hTtPs&colon;//example.test', '﻿javascript:alert(1)',
        ];
        for (const url of urls) {
            for (const prefix of ['', '!']) { expect(html(`${prefix}[x](<${url}>)`)).not.toMatch(/<(?:a|img)\s/); }
        }
    });
    test('last valid inline display declaration wins; visibility does not prune descendants', () => {
        for (const style of ['display:none;display:block', 'display:none !ie', 'visibility:hidden', 'visibility:hidden;display:block', 'display:none;display:inline flex']) {
            expect(renderBody({ html: `<div style="${style}">visible<span style="visibility:visible"> child</span></div>` }).text).toBe('visible child');
        }
        expect(renderBody({ html: '<div style="display:none;display:none !ie">hidden</div>' }).text).toBe('');
        expect(renderBody({ html: '<div hidden="false" style="display:block">hidden</div>' }).text).toBe('');
    });
    test('every final generated quote block suppresses its own bottom margin', () => {
        for (const [markdown, tag] of [['> # Heading', 'h1'], ['> - item', 'ul'], ['> - item\n>\n>', 'ul'], ['> ```\n> code\n> ```', 'pre'], ['> | a |\n> |---|\n> | b |', 'table'], ['> ---', 'hr']]) {
            const out = html(markdown ?? '');
            expect(out).toMatch(new RegExp(`<${tag} style="[^"]*;margin-bottom:0"`));
        }
    });
});

describe('output limits', () => {
    test('text over 128 KiB is too_large; exactly 128 KiB is accepted', () => {
        expect(renderBody({ text: 'a'.repeat(128 * 1024) }).text).toHaveLength(128 * 1024);
        expect(errorCode({ text: 'a'.repeat(128 * 1024 + 1) })).toBe('too_large');
        expect(errorCode({ text: 'é'.repeat(64 * 1024 + 1) })).toBe('too_large');
    });
    test('limits count UTF-8 bytes, not characters', () => {
        expect(renderBody({ text: 'é'.repeat(64 * 1024) }).text).toHaveLength(64 * 1024);
    });
    test('html over 256 KiB is too_large; exactly 256 KiB is accepted', () => {
        const pad = (bytes: number) => `<p>${'a'.repeat(bytes - 7)}</p>`;
        expect(renderBody({ html: `<!--${'a'.repeat(256 * 1024 - 7)}-->` }).html).toHaveLength(256 * 1024);
        expect(errorCode({ html: pad(256 * 1024 + 1) })).toBe('too_large');
    });
    test('generated text over 128 KiB is too_large even when html is within its limit', () => {
        expect(errorCode({ html: `<p>${'a'.repeat(128 * 1024 + 1)}</p>` })).toBe('too_large');
    });
    test('direct Markdown calls enforce the 128 KiB input limit even when rendering would shrink it', () => {
        expect(md(' '.repeat(128 * 1024))).toEqual({ text: '', html: '' });
        expect(errorCode({ markdown: ' '.repeat(128 * 1024 + 1) })).toBe('too_large');
        expect(errorCode({ markdown: `<!--${'é'.repeat(64 * 1024)}-->` })).toBe('too_large');
    });
    test('markdown whose generated html or text is too large fails with too_large', () => {
        expect(errorCode({ markdown: `${'a'.repeat(200 * 1024)}\n\n${'b'.repeat(100 * 1024)}` })).toBe('too_large');
        expect(errorCode({ markdown: 'x\n\n'.repeat(30000) })).toBe('too_large');
        expect(errorCode({ markdown: 'x'.repeat(2 * 1024 * 1024) })).toBe('too_large');
    });
});
