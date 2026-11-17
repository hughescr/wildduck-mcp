import { describe, expect, mock, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import MarkdownIt from 'markdown-it';
import { MailError } from '../src/mail/contracts';
import { renderBody, type BodyInput, type RenderDiagnostic } from '../src/mail/render';

const plain = (html: string): string => renderBody({ html }).text;

describe('email HTML text structure', () => {
    test('layout tables preserve heading, paragraph and list blocks and skip spacer cells', () => {
        const body = '<h1>Newsletter</h1><p>Para one.</p><p>Para two.</p><ul><li>a</li><li>b</li></ul>';
        expect(plain(`<table width=600><tr><td>${body}</td><td>&nbsp;</td></tr></table>`)).toBe('Newsletter\n==========\n\nPara one.\n\nPara two.\n\n - a\n - b');
        expect(plain(`<table><tr><td><table><tr><td>${body}</td></tr></table></td></tr></table>`)).toBe(plain(body));
        expect(plain('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>')).toBe('a\n\nb');
        expect(plain('<table><tr><td><p>a</p></td><td>b</td></tr></table>')).toBe('a\n\nb');
    });
    test('client line containers and Gmail signatures are single-spaced with explicit blank lines', () => {
        expect(plain('<div>Line 1</div><div>Line 2</div><div><br></div><div>Line 4</div>')).toBe('Line 1\nLine 2\n\nLine 4');
        expect(plain('<div>-- </div><div>Name</div>')).toBe('-- \nName');
        for (const tag of ['section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd']) {
            expect(plain(`<${tag}>one</${tag}><${tag}>two</${tag}>`)).toBe('one\ntwo');
        }
        expect(plain('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    });
    test('noscript content, captions and stray table/list text are retained without reparsing entities', () => {
        expect(plain('<noscript><p>Visible</p>&lt;b&gt;literal&lt;/b&gt;</noscript>')).toBe('Visible\n\n<b>literal</b>');
        expect(plain('<table>before<caption>Caption</caption><tr><td>a</td><td>b</td></tr>after</table>')).toBe('before\n\nCaption\n\na   b\n\nafter');
        for (const tag of ['ul', 'ol']) {
            const out = plain(`<${tag}>before<li>item</li>after</${tag}>`);
            expect(out).toContain('before'); expect(out).toContain('item'); expect(out).toEndWith('after');
            expect(out.indexOf('before')).toBeLessThan(out.indexOf('item'));
        }
    });
    test('only the literal initial LF of pre/textarea is ignored', () => {
        expect(plain('<p>before</p><pre>\nfirst\nsecond</pre><p>after</p>')).toBe('before\n\nfirst\nsecond\n\nafter');
        expect(plain('<p>before</p><pre><code>\nfirst</code></pre>')).toBe('before\n\n\nfirst');
        expect(plain('<textarea>\nfirst\nsecond</textarea>')).toBe('first second');
        expect(plain('before<textarea>\nfirst</textarea>')).toBe('beforefirst');
    });
    test('links omit trivial URL duplicates and fragment-only destinations', () => {
        for (const [label, href] of [['https://example.test', 'https://example.test/'], ['www.example.test', 'http://www.example.test/'], ['a@example.test', 'mailto:a@example.test'], ['section', '#section']]) {
            expect(plain(`<a href="${href}">${label}</a>`)).toBe(label ?? '');
        }
        expect(plain('<a href="/path#section">section</a>')).toBe('section [/path#section]');
        expect(plain('<a href="https://example.test/other">https://example.test</a>')).toBe('https://example.test [https://example.test/other]');
    });
    test('important display priority wins, vendor display is visible, visibility does not prune', () => {
        for (const style of ['display:none!important;display:block', 'display:none ! important;display:-webkit-box', 'display:block!important;display:none!important']) {
            expect(plain(`<div style="${style}">hidden</div>`)).toBe('');
        }
        for (const style of ['display:none;display:-webkit-box', 'display:none!important;display:block!important', 'display:block!important;display:none', 'visibility:hidden']) {
            expect(plain(`<div style="${style}">visible</div>`)).toBe('visible');
        }
    });
    test('table columns and heading underlines use the same conservative Unicode widths', () => {
        expect(plain('<h1>中Ａ😀e\u0301</h1>')).toBe('中Ａ😀e\u0301\n=======');
        expect(plain('<h2>👩\u200d💻\ufe0f</h2>')).toBe('👩\u200d💻\ufe0f\n----');
        expect(plain('<table><tr><td>中</td><td>x</td></tr><tr><td>a</td><td>y</td></tr><tr><td>e\u0301</td><td>z</td></tr></table>')).toBe('中   x\na    y\ne\u0301    z');
        expect(plain('<table><tr><td>😀</td><td>x</td></tr><tr><td>Ａ</td><td>y</td></tr></table>')).toBe('😀   x\nＡ   y');
        expect(plain('<table><tr><td>क</td><td>x</td></tr><tr><td>a</td><td>y</td></tr></table>')).toBe('क | x\na | y');
    });
    test('emoji modifiers take no cell, flag pairs take two, text-presentation symbols disable alignment', () => {
        expect(plain('<h1>👍🏽</h1><h2>🇺🇸</h2>')).toBe('👍🏽\n==\n\n🇺🇸\n--');
        expect(plain('<table><tr><td>👍🏽</td><td>x</td></tr><tr><td>ab</td><td>y</td></tr></table>')).toBe('👍🏽   x\nab   y');
        expect(plain('<table><tr><td>🇺🇸🇬🇧</td><td>x</td></tr><tr><td>abcd</td><td>y</td></tr></table>')).toBe('🇺🇸🇬🇧   x\nabcd   y');
        expect(plain('<table><tr><td>🇺</td><td>x</td></tr><tr><td>a</td><td>y</td></tr></table>')).toBe('🇺 | x\na | y');
        for (const symbol of ['©', '®', '™', '↔']) {
            expect(plain(`<table><tr><td>${symbol}</td><td>x</td></tr><tr><td>a</td><td>y</td></tr></table>`)).toBe(`${symbol} | x\na | y`);
        }
    });
    test('an ordered task item keeps its number in the HTML part and the text part', () => {
        const out = renderBody({ markdown: '1. [x] done\n2. [ ] todo\n\n- [x] bullet' });
        expect(out.html).toMatch(/<li style="margin:0 0 \.25em">☒ done<\/li>/);
        expect(out.html).toMatch(/<li style="margin:0 0 \.25em">☐ todo<\/li>/);
        expect(out.html).toMatch(/<tr><td [^>]*>☒<\/td><td [^>]*>bullet<\/td><\/tr>/);
        expect(out.html).not.toContain('list-style');
        expect(out.text).toBe(' 1. [x] done\n 2. [ ] todo\n\n - [x] bullet');
        expect(renderBody({ markdown: '- a\n  1. [x] nested' }).html).toMatch(/<ol [^>]*>\n<li style="margin:0 0 \.25em">☒ nested/);
    });
    test('ordered lists honour zero, reversed and bounded item values while ignoring type', () => {
        expect(plain('<ol start=0><li>a</li><li value=5>b</li><li>c</li></ol>')).toBe(' 0. a\n 5. b\n 6. c');
        expect(plain('<ol reversed type=i><li>a</li><li>b</li><li>c</li></ol>')).toBe(' 3. a\n 2. b\n 1. c');
        expect(plain('<ol reversed start=0><li>a</li><li value=1000000>b</li><li value=1e300>c</li></ol>')).toBe(' 0. a\n 1000000. b\n 999999. c');
    });
});

describe('one Markdown parse and URL policy', () => {
    test('one token stream produces equivalent tasks, links and quote boundaries without leaked markers', () => {
        const parse = spyOn(MarkdownIt.prototype, 'parse');
        try {
            const out = renderBody({ markdown: 'before\n\n> - [x] done [guide](https://example.test)\n> - [ ] later\n\nafter\n\n```\n- ☑ literal\n```\n\n`- ☐ literal`' });
            expect(parse).toHaveBeenCalledTimes(1);
            expect(out.html).not.toMatch(/data-mail-task|<blockquote|<input/);
            expect(out.html).toContain('☒</td><td style="padding:0 0 .25em;vertical-align:top">done <a href="https://example.test">guide</a></td>');
            expect(out.text).toContain('>  - [x] done guide [https://example.test]');
            expect(out.text).toContain('>  - [ ] later');
            expect(out.text).toContain('\n\nafter\n\n- ☑ literal\n\n- ☐ literal');
            expect(out.html).not.toContain('list-style');
        } finally { parse.mockRestore(); }
    });
    test('escaped and entity-written checkbox syntax is literal, not a task item', () => {
        for (const markdown of ['- \\[x] literal', '- &#91;x] literal', '- `[x] code`']) {
            const result = renderBody({ markdown });
            expect(result.html).not.toMatch(/list-style|<table|☐|☒|☑/);
            expect(result.text).toBe(' - [x] ' + (markdown.includes('code') ? 'code' : 'literal'));
        }
    });
    test('allowed destinations are classified once and emitted without URL normalization', () => {
        for (const url of ['cid:logo@example.test', 'https://münich.example/a%20b+c?x=1&region=us', 'mailto:a+b@example.test?subject=A%20B&body=C+D', 'tel:+123456789', '../a%20b?q=a+b', 'https://example.test/?x=&amp;amp;']) {
            const out = renderBody({ markdown: `[label](${url}) ![alt](${url})\n\n[reference][r]\n\n[r]: ${url}` });
            const emitted = url === 'https://example.test/?x=&amp;amp;' ? url : url.replaceAll('&', '&amp;');
            expect(out.html?.split(`href="${emitted}"`)).toHaveLength(3);
            expect(out.html).toContain(`src="${emitted}"`);
        }
        expect(renderBody({ markdown: 'www.example.com and a@example.com' }).html).toContain('href="http://www.example.com"');
        expect(renderBody({ markdown: '<mailto:a@example.com>' }).text).toBe('a@example.com');
        for (const markdown of ['https://münich.example/a%20b+c?x=1&region=us', '<https://münich.example/a%20b+c?x=1&region=us>']) {
            const output = renderBody({ markdown });
            expect(output.html).toContain('href="https://münich.example/a%20b+c?x=1&amp;region=us"');
            expect(output.text).toBe('https://münich.example/a%20b+c?x=1&region=us');
        }
        expect(renderBody({ markdown: '~single~ and ~~double~~' }).html).toContain('~single~ and <del>double</del>');
    });
    test('GitHub-style extended autolinks: scheme, www. and email only; bare domains and file names stay text', () => {
        for (const word of ['setup.py', 'main.rs', 'README.md', 'run.sh', 'example.com', 'node.js', 'v1.2.3', 'e.g.', 'foo.bar/baz', 'a.it', 'notes.io', 'config.so', '//example.com']) {
            const out = renderBody({ markdown: `see ${word} now` });
            expect(out.html).not.toContain('<a');
            expect(out.text).toBe(`see ${word} now`);
        }
        const linked: [string, string, string][] = [
            ['www.example.com', 'http://www.example.com', 'www.example.com'], ['www.example.com/path?x=1', 'http://www.example.com/path?x=1', 'www.example.com/path?x=1'],
            ['https://example.com', 'https://example.com', 'https://example.com'], ['http://example.com/a', 'http://example.com/a', 'http://example.com/a'],
            ['me@example.com', 'mailto:me@example.com', 'me@example.com'], ['WWW.Example.com', 'http://WWW.Example.com', 'WWW.Example.com'],
        ];
        for (const [source, href, label] of linked) {
            const out = renderBody({ markdown: `see ${source} now` });
            expect(out.html).toContain(`<a href="${href}">${label}</a>`);
            expect(out.html?.split('<a ')).toHaveLength(2);
            expect(out.text).toBe(`see ${source} now`);
        }
        // Trailing punctuation and wrapping parentheses stay outside the link.
        expect(renderBody({ markdown: 'Go to www.example.com.' }).html).toContain('<a href="http://www.example.com">www.example.com</a>.</p>');
        expect(renderBody({ markdown: '(https://example.com)' }).html).toContain('(<a href="https://example.com">https://example.com</a>)</p>');
        // Not a www. host: no dotted tail, a longer word, or a port-only host.
        for (const markdown of ['www.localhost', 'xwww.example.com', 'www.']) { expect(renderBody({ markdown }).html).not.toContain('<a'); }
        // Explicit Markdown links and angle autolinks are unaffected.
        const explicit = renderBody({ markdown: '[docs](example.com) <https://a.example>' }).html;
        expect(explicit).toContain('<a href="example.com">docs</a>');
        expect(explicit).toContain('<a href="https://a.example">https://a.example</a>');
    });
    test('header, aggregate cell and nesting guards reject too_large without dropping content', () => {
        for (const markdown of ['a|'.repeat(65) + '\n' + '-|'.repeat(65), 'a|b\n-|-\n' + 'x\n'.repeat(10000), ('a|b\n-|-\n' + 'x\n'.repeat(6000) + '\n').repeat(2), '> '.repeat(40) + 'must not vanish', '1) '.repeat(40) + 'must not vanish']) {
            expect(() => renderBody({ markdown })).toThrow(new MailError('too_large'));
        }
        expect(renderBody({ markdown: 'a|'.repeat(64) + '\n' + '-|'.repeat(64) }).html).toContain('<table');
        expect(() => renderBody({ markdown: '> ' + 'a|'.repeat(65) + '\n> ' + '-|'.repeat(65) })).toThrow(new MailError('too_large'));
        expect(() => renderBody({ markdown: '- item\n\n  ' + 'a|'.repeat(65) + '\n  ' + '-|'.repeat(65) })).toThrow(new MailError('too_large'));
        expect(renderBody({ markdown: '    ' + 'a|'.repeat(65) + '\n    ' + '-|'.repeat(65) }).html).toContain('<pre');
    });
    test('the column guard fires only where the parser confirms a table; look-alikes stay ordinary text', () => {
        for (const markdown of ['Title\n' + '|'.repeat(70), 'Results\n' + '-|'.repeat(70), 'a b\n' + '|-'.repeat(65) + '|', 'a b\n' + '|-'.repeat(200) + '|']) {
            const out = renderBody({ markdown });
            expect(out.html).not.toContain('<table');
            expect(out.html).toContain('<br>');
            expect(out.text).toBe(markdown);
        }
        // A real 65-column table is still rejected, with or without edge pipes, in a quote and in a list too.
        for (const [first, second] of [['', ''], ['> ', '> '], ['- item\n\n  ', '  ']] as const) {
            expect(() => renderBody({ markdown: `${first}${'a|'.repeat(65)}\n${second}${'-|'.repeat(65)}` })).toThrow(new MailError('too_large'));
            expect(() => renderBody({ markdown: `${first}${'a|'.repeat(64)}a\n${second}${'-|'.repeat(64)}-` })).toThrow(new MailError('too_large'));
        }
        expect(renderBody({ markdown: 'a|'.repeat(63) + 'a\n' + '-|'.repeat(63) + '-' }).html).toContain('<table');
    });
});

describe('email autolinks only for ordinary addresses', () => {
    test('code-like text stays literal in both parts', () => {
        for (const word of ['npm i foo@1.2.3', 'pkg@^2.0.0', 'user@1.2.3.4', 'git@github.com:owner/repo.git', 'name@2x.png', 'icon@3x.jpg', '@scope/pkg@1.0.0', 'a@b.md', 'a@b.json', 'x@host.com/path', 'a@b_c.com']) {
            const out = renderBody({ markdown: `run ${word} now` });
            expect(out.html).not.toContain('<a');
            expect(out.text).toBe(`run ${word} now`);
        }
    });
    test('ordinary addresses still link with mailto:', () => {
        for (const address of ['me@example.com', 'first.last+tag@sub.example.co.uk', 'a@b.io', 'me@example.com.']) {
            const bare = address.replace(/\.$/, '');
            const out = renderBody({ markdown: `mail ${address} now` });
            expect(out.html).toContain(`<a href="mailto:${bare}">${bare}</a>`);
            expect(out.text).toBe(`mail ${address} now`);
        }
        expect(renderBody({ markdown: 'x git@github.com:o/r and me@example.com' }).html?.split('<a ')).toHaveLength(2);
        expect(renderBody({ markdown: 'mailto:a@example.com' }).html).toContain('href="mailto:a@example.com"');
    });
});

describe('private render diagnostics', () => {
    test('exactly one allowlisted diagnostic precedes invalid_input and logger exceptions are contained', () => {
        const logs: RenderDiagnostic[] = [];
        const input = { get html(): string { const error = new TypeError('PRIVATE message'); error.name = 'PRIVATE name'; throw error; } };
        expect(() => renderBody(input, { onDiagnostic: diagnostic => { logs.push(diagnostic); throw new Error('PRIVATE logger'); } })).toThrow(new MailError('invalid_input'));
        expect(logs).toEqual([{ event: 'render_internal_error', name: 'TypeError' }]);
        expect(JSON.stringify(logs)).not.toContain('PRIVATE');
        logs.length = 0;
        for (const value of [{}, { text: 'x'.repeat(131073) }]) {
            expect(() => renderBody(value as BodyInput, { onDiagnostic: diagnostic => logs.push(diagnostic) })).toThrow(MailError);
        }
        expect(logs).toEqual([]);
    });
    test('default diagnostic is one structured warning without input, error text or stack', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(() => renderBody({ get text(): string { throw new RangeError('PRIVATE'); } })).toThrow(MailError);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_internal_error', name: 'RangeError' }));
        } finally { warn.mockRestore(); }
    });
});

const LIMIT = 128 * 1024;
const fill = (pattern: string): string => pattern.repeat(Math.ceil(LIMIT / pattern.length)).slice(0, LIMIT);
const pathological: Record<string, string> = {
    'M1 200 columns': 'a|'.repeat(200) + '\n' + '-|'.repeat(200) + '\n' + 'x\n'.repeat((LIMIT - 802) / 2),
    'M1 1000 columns': 'a|'.repeat(1000) + '\n' + '-|'.repeat(1000) + '\n' + 'x\n'.repeat((LIMIT - 4002) / 2),
    'M2 parens': '1) '.repeat(43690) + 'x ', 'M2 dots': '1. '.repeat(43690) + 'x ',
    ...Object.fromEntries(['*_a', '_*a', '_a<', '___a', '__a', '_1', 'a_b', '[', '[a](', '`', '<', '> ', '- ', '*a **a ', '&amp;', 'http://a.', 'www.', 'www.a.', 'a.py ', 'a@b.','a@b.co\n', 'a://', 'mailto:', '\t', ' ',
        '<x> ', 'a@1.2 ', 'a@1.2.3:b/c ', '-- \n', '-- x\n', 'a\n-- \n'].map(pattern => [JSON.stringify(pattern), fill(pattern)])),
    'unknown tag flood in an html block': ('<div>\n' + fill('<x> ')).slice(0, LIMIT), 'unterminated tags in an html block': ('<div>\n' + fill('<a "x ')).slice(0, LIMIT),
    'title and pipes': 'Title\n' + '|'.repeat(LIMIT - 6), 'dash-pipes under a title': 'Results\n' + '-|'.repeat((LIMIT - 8) / 2),
    'unclosed <b> nesting': fill('<b>'), 'unclosed <div> nesting': fill('<div>'), 'unclosed list nesting': fill('<ul><li>'),
    'nested list markers': '- '.repeat(65535) + 'x ',
    'task list flood': fill('- [ ] a\n'), 'empty task list flood': fill('- [ ]\n'), 'loose task list flood': fill('- [x] a\n\n'),
    'nested task list markers': '- '.repeat(65533) + '[ ] x ', 'task items nested by indent': Array.from({ length: 200 }, (_, index) => `${'  '.repeat(index)}- [ ] a\n`).join('').slice(0, LIMIT).padEnd(LIMIT, '\n'),
    'balanced brackets': '['.repeat(65535) + 'x' + ']'.repeat(65535) + ' ',
    'balanced emphasis': '*a **a '.repeat(9362) + 'b ' + ' a** a*'.repeat(9362) + '  ',
    'unclosed links A': fill('[a](<b'), 'unclosed links B': fill('[a](b'),
    'inline backticks': fill('``\\'), 'emphasis closers': fill('a_ '), 'mixed delimiters': fill('*a_ '),
    'fenced newline flood': '```\n' + '\n'.repeat(LIMIT - 9) + 'x\n```',
    'backtick runs': Array.from({ length: 510 }, (_, index) => '`'.repeat(index + 1) + 'a').join('').slice(0, LIMIT).padEnd(LIMIT, 'x'),
    'reference flood': Array.from({ length: 11000 }, (_, index) => `[${index}]: /a\n`).join('').slice(0, LIMIT).padEnd(LIMIT, 'x'),
    'reference unclosed title': '[a]: /u "' + fill('x\n').slice(9), 'reference unclosed label': '[' + fill('a\n').slice(1),
    'long table row': 'a|b\n-|-\n' + fill('a|').slice(8), 'table cell flood': 'a|b\n-|-\n' + fill('x|y\n').slice(8),
    'inline whitespace': 'x' + fill(' ').slice(6) + 'x  \nx',
    ...Object.fromEntries(['<!--', '<?x', '<!A', '<![CDATA[', '<a ', '<a "', '<!-- <a x="'].map(pattern => [`HTML ${pattern}`, 'x ' + fill(pattern).slice(2)])),
};
/** Families whose only legitimate outcome is the documented 64-level DOM depth bound (invalid_input).
 * Every other family must finish, or fail the size guards (too_large). An internal error is
 * mapped to invalid_input by renderBody, so it is detected through the diagnostic callback instead. */
const depthBound = new Set(['unclosed <b> nesting', 'unclosed <div> nesting', 'unclosed list nesting']);

const RSS_LIMIT_KIB = 300 * 1024;
/** Memory figures, all in KiB, reported by the child process itself. */
interface ChildMemory {
    /** process.resourceUsage().maxRSS before rendering. */
    before: number;
    /** process.resourceUsage().maxRSS after rendering. */
    after: number;
    /** process.memoryUsage().rss (current, not peak) after rendering. */
    rss: number;
    /** Linux only: VmHWM from /proc/self/status, the child's own peak RSS. */
    hwm?: number;
}
/**
 * Decide whether a child stayed under RSS_LIMIT_KIB; returns the violated rules (empty = pass).
 *
 * Why not just assert on maxRSS: on Linux ru_maxrss is inherited across fork/exec from the
 * parent's RSS at spawn time (verified: a child of a 377 MB bun parent reports maxRSS 377 MB
 * while its current RSS is 12 MB), so the number can reflect the test runner, not the child.
 * macOS does not inherit it. Units are KiB on both platforms in Bun.
 *
 * Rules, strictest first:
 *  1. Current RSS after rendering must be under the limit; the parent cannot inflate it.
 *  2. If /proc gave the child's own high-water mark (Linux), it must be under the limit. This is
 *     the real peak check and is immune to inheritance (it comes from the new process image).
 *  3. Without that, if maxRSS rose during the child's life (after > before) the rise is the
 *     child's own peak, so it must be under the limit. If it did not rise, the value is either
 *     below the limit (so passes) or an inherited value at or above it. The latter hides the
 *     child's own peak anywhere below the inherited value, so the peak cannot be proven here and
 *     only rule 1 applies; a child that peaked and shrank back inside that window is covered
 *     only by the parent-side ps poll. This gap does not exist where /proc is available.
 */
const memoryViolations = ({ before, after, rss, hwm }: ChildMemory, limit = RSS_LIMIT_KIB): string[] => {
    const violations: string[] = [];
    if (!(rss < limit)) { violations.push(`current rss ${rss} KiB >= ${limit}`); }
    if (hwm !== undefined) {
        if (!(hwm < limit)) { violations.push(`own peak rss ${hwm} KiB >= ${limit}`); }
    } else if (after > before) {
        if (!(after < limit)) { violations.push(`maxRSS rose to ${after} KiB (from ${before}) >= ${limit}`); }
    }
    return violations;
};

describe('child memory decision', () => {
    test.each([
        ['inherited high-water mark, small child', { before: 321116, after: 321116, rss: 60000 }, false],
        ['child grew far past an inherited mark', { before: 321116, after: 900000, rss: 880000 }, true],
        ['ordinary child', { before: 30000, after: 110000, rss: 90000 }, false],
        ['child peaked then shrank, own mark rose', { before: 30000, after: 500000, rss: 100000 }, true],
        ['child current rss over limit despite inherited mark', { before: 321116, after: 321116, rss: 350000 }, true],
        ['own peak from /proc beats an inherited mark', { before: 321116, after: 321116, rss: 60000, hwm: 120000 }, false],
        ['own peak from /proc over the limit is caught under an inherited mark', { before: 321116, after: 321116, rss: 60000, hwm: 310000 }, true],
        ['rss exactly at the limit fails', { before: 30000, after: 30000, rss: RSS_LIMIT_KIB }, true],
        ['a rise from a small start to over the limit fails even with a small current rss', { before: 20000, after: 400000, rss: 20000 }, true],
        ['a rise that stays under the limit passes', { before: 20000, after: 290000, rss: 20000 }, false],
    ] as const)('%s', (_name, memory, fails) => {
        expect(memoryViolations(memory).length > 0).toBe(fails);
    });
});

describe('isolated pathological Markdown, 128 KiB', () => {
    for (const [name, markdown] of Object.entries(pathological)) {
        test(name, async () => {
            expect(Buffer.byteLength(markdown)).toBe(LIMIT);
            // The child reports its own memory before and after rendering (see memoryViolations).
            const script = `
                import { readFileSync } from 'node:fs';
                import { renderBody } from ${JSON.stringify(new URL('../src/mail/render.ts', import.meta.url).pathname)};
                const usage = () => ({ maxRSS: process.resourceUsage().maxRSS, rss: Math.round(process.memoryUsage().rss / 1024) });
                const ownPeak = () => { try { const match = /^VmHWM:\\s+(\\d+) kB/m.exec(readFileSync('/proc/self/status', 'utf8')); return match ? Number(match[1]) : undefined; } catch { return undefined; } };
                const input = await Bun.stdin.text();
                const before = usage(); const start = performance.now();
                let status = 'ok'; let internal = false;
                try { renderBody({markdown:input}, { onDiagnostic: () => { internal = true; } }); } catch(error) { status = error.code ?? 'unexpected'; }
                const ms = performance.now() - start;
                const after = usage();
                console.log(JSON.stringify({status: internal ? 'render_internal_error' : status, ms, before: before.maxRSS, after: after.maxRSS, rss: after.rss, hwm: ownPeak()}));
            `;
            // A heap hint is NOT a hard cap: also poll the child RSS and kill on
            // excess, with an independent deadline even while its parser is busy.
            // The ps poll reads the child's own pid (immune to the inherited high-water mark) but is
            // best effort (ps may be missing or denied); the child's self-reported memory asserted
            // after it exits is the real memory check.
            const child = Bun.spawn([process.execPath, '-e', script], { stdin: new Blob([markdown]), stdout: 'pipe', stderr: 'pipe',
                env: { ...process.env, BUN_JSC_forceRAMSize: String(300 * 1024 * 1024) } });
            let exceeded = false;
            let timedOut = false;
            const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
            const monitor = setInterval(() => {
                try {
                    const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
                    if (rss > 300 * 1024) { exceeded = true; child.kill(); }
                } catch { /* ps can race a normally exiting child. */ }
            }, 20);
            const status = await child.exited;
            clearInterval(monitor); clearTimeout(deadline);
            expect(exceeded).toBe(false); expect(timedOut).toBe(false); expect(status).toBe(0);
            const result = JSON.parse(await new Response(child.stdout).text()) as { status: string; ms: number } & ChildMemory;
            expect(result.status).not.toBe('render_internal_error');
            expect(result.status).toBeOneOf(depthBound.has(name) ? ['invalid_input'] : ['ok', 'too_large']);
            expect(result.ms).toBeLessThan(1500);
            expect(memoryViolations(result)).toEqual([]);
        });
    }
});

describe('ordinary content never raises an internal render error', () => {
    const markdown = [
        '# Title', '', 'Hi **there**, see [the docs](https://example.com/docs), <https://example.com/bare> or me@example.com and www.example.com.', '',
        'Send it to <your manager> and reply <yes> or <no>. A <b>bold</b> <br> move, a & b, 1 < 2, `a < b`.', '',
        '1. one', '   - nested', '2. [x] two', '', '- [ ] todo', '- [x] done', '',
        '| Name | Qty |', '|:---|---:|', '| apple | 1 |', '| watermelon | 22 |', '',
        '> outer', '>', '> > inner', '', '<div style="color:red">raw <i>html</i></div>', '', '<!-- note -->', '',
        '```', 'a  b', '```', '', '![Logo](cid:logo@example.test)', '', '---', '', 'Thanks,', 'Craig', '-- ', 'Craig Smith',
    ].join('\n');
    const snippets = [
        '<p>Hello <b>world</b> &amp; <a href="https://example.com">link</a></p>', '<h1>T</h1><ul><li>a</li><li>b</li></ul>', '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
        '<blockquote><p>quoted</p></blockquote>', '<div>-- <br>Name</div>', '<pre>a  b\n c</pre>', '<img src="cid:x" alt="pic">', '<p>café © 🇺🇸 👍🏽</p>', '',
    ];
    test('sample-style Markdown and ordinary HTML snippets', () => {
        const diagnostic = mock((_event: RenderDiagnostic) => {});
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            renderBody({ markdown }, { onDiagnostic: diagnostic });
            for (const html of snippets) { renderBody({ html }, { onDiagnostic: diagnostic }); renderBody({ markdown: html }, { onDiagnostic: diagnostic }); }
            expect(diagnostic).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
        } finally { warn.mockRestore(); }
    });
});
