import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, Joiner, type MimeNode, type SplitterChunk } from '@zone-eu/mailsplit';
import AddressParser from 'nodemailer/lib/addressparser';
import Builder from 'nodemailer/lib/mime-node';
import { parseHeaderValue, encodeWord } from 'nodemailer/lib/mime-funcs';

/** Bounded supported subset: CRLF MIME headers/delimiters; UTF-8/ASCII text;
 * one plain, HTML, or direct plain+HTML alternative inside ordinary related/mixed
 * wrappers. Other sibling leaves are opaque attachments (including calendar and
 * message/rfc822). Unsupported structure/semantics fail closed before upload.
 * Request-local only. Never persist/log source, candidates, or inspection handles. */
export const MIME_LIMITS = Object.freeze({ sourceBytes: 4 * 1024 * 1024, attachmentBytes: 2 * 1024 * 1024, headerBytes: 64 * 1024, totalHeaderBytes: 256 * 1024, nodes: 128, depth: 12 });
export class MimeError extends Error {
    constructor(public readonly code: 'unsupported_mime' | 'invalid_mime_patch' | 'mime_limit' | 'mime_verification_failed') { super(code); this.name = 'MimeError'; }
}
export interface MimeAddress { readonly address: string; readonly name?: string | undefined }
export interface MimeEnvelope { readonly from: readonly MimeAddress[]; readonly replyTo: readonly MimeAddress[]; readonly to: readonly MimeAddress[]; readonly cc: readonly MimeAddress[]; readonly bcc: readonly MimeAddress[] }
/** Wildduck attachments[].hash: SHA256 of the original transfer-encoded body, NOT fileContentHash. */
export interface MimeAttachmentBinding { readonly attachmentId: string; readonly hash: string }
export interface MimeAttachment { readonly filename: string; readonly contentType: string; readonly contentBase64: string; readonly disposition: 'attachment' | 'inline'; readonly cid?: string | undefined }
export interface MimeBody { readonly text: string; readonly html: string | null }
export interface MimePatch {
    readonly from?: MimeAddress | undefined; readonly replyTo?: readonly MimeAddress[] | undefined; readonly to?: readonly MimeAddress[] | undefined; readonly cc?: readonly MimeAddress[] | undefined; readonly bcc?: readonly MimeAddress[] | undefined;
    readonly subject?: string | undefined; readonly body?: MimeBody | undefined; readonly deleteAttachmentIds?: readonly string[] | undefined; readonly attachments?: readonly MimeAttachment[] | undefined;
}
export interface MimeCreate extends MimePatch { readonly from: MimeAddress; readonly subject: string; readonly body: MimeBody; readonly to: readonly MimeAddress[]; readonly cc: readonly MimeAddress[]; readonly bcc: readonly MimeAddress[] }
export interface MimePartProof { readonly rawSha256: string; readonly encodedBodySha256: string; readonly contentType: string; readonly cid: string | null; readonly rawBytes: number }
export interface InspectedMime { readonly sha256: string; readonly envelope: MimeEnvelope; readonly attachments: readonly MimePartProof[] }
export interface PreparedMime { readonly raw: Buffer; readonly sha256: string; readonly envelope: MimeEnvelope; readonly retainedAttachments: readonly MimePartProof[] }
interface Header { key: string; raw: Buffer; value: string }
interface Part {
    start: number; end: number; bodyStart: number; headers: Header[]; node: MimeNode; type: string;
    children: Part[]; parent?: Part; segmentStart?: number; segmentEnd?: number; closeStart?: number;
    boundary?: string; params: Record<string, string>; cid: string | null; decoded?: Buffer;
}
interface Source { raw: Buffer; root: Part; core: Part; leaves: Part[]; attachments: Part[]; bindings: Map<string, Part>; envelope: MimeEnvelope }
const inspections = new WeakMap<InspectedMime, Source>();
const preparations = new WeakMap<PreparedMime, Buffer>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: MimeError['code'] = 'unsupported_mime'): never => { throw new MimeError(code); };
const requireMime: (condition: unknown, code?: MimeError['code']) => asserts condition = (condition, code) => { if (!condition) {fail(code);} };
function required<T>(value: T | undefined | null): T { requireMime(value !== undefined && value !== null); return value; }
function headerControls(value: string, folding = false): boolean {
    for (const char of value) { const code = char.charCodeAt(0); if (code === 127 || (code < 32 && !(folding && [9, 10, 13].includes(code)))) { return true; } }
    return false;
}
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const MEDIA = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const SINGLE = new Set(['from', 'sender', 'reply-to', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'mime-version']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeUtf8(bytes: Uint8Array): string { try { return utf8.decode(bytes); } catch { return fail(); } }
function get(part: Part, key: string): string { return part.headers.find(header => header.key === key)?.value ?? ''; }
function safeText(value: unknown, maximum: number): asserts value is string {
    requireMime(typeof value === 'string' && Buffer.byteLength(value) <= maximum && !headerControls(value) && value.isWellFormed(), 'invalid_mime_patch');
}
function headersAt(raw: Buffer, start: number, end: number): { headers: Header[]; bodyStart: number } {
    const separator = raw.indexOf('\r\n\r\n', start);
    requireMime(separator >= start && separator + 4 <= end && separator + 4 - start <= MIME_LIMITS.headerBytes);
    const block = raw.subarray(start, separator + 2);
    const text = decodeUtf8(block);
    requireMime(!headerControls(text, true) && !/(?<!\r)\n|\r(?!\n)/u.test(text));
    const headers: Header[] = [];
    let offset = start;
    for (const line of text.slice(0, -2).split('\r\n')) {
        const length = Buffer.byteLength(line) + 2;
        requireMime(length <= 1000);
        if (/^[ \t]/u.test(line)) {
            const previous = headers.at(-1);
            requireMime(previous);
            previous.raw = raw.subarray(offset - previous.raw.length, offset + length);
            previous.value += ' ' + line.trim();
        } else {
            const colon = line.indexOf(':');
            requireMime(colon > 0 && TOKEN.test(line.slice(0, colon)));
            headers.push({ key: line.slice(0, colon).toLowerCase(), raw: raw.subarray(offset, offset + length), value: line.slice(colon + 1).trim() });
        }
        offset += length;
    }
    const seen = new Set<string>();
    for (const header of headers) {
        if (SINGLE.has(header.key) || header.key.startsWith('content-')) {requireMime(!seen.has(header.key));}
        seen.add(header.key);
        requireMime(!/^(?:dkim-signature|domainkey-signature|arc-.*|resent-.*|content-md5|content-length)$/u.test(header.key));
    }
    return { headers, bodyStart: separator + 4 };
}
/** A restrictive syntax gate, not a second tolerant MIME parser. The maintained parser
 * interprets accepted values; ambiguous/comments/duplicate parameter spellings fail closed. */
function structured(value: string): { value: string; params: Record<string, string> } {
    const pieces: string[] = [];
    let quoted = false, escaped = false, start = 0;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (escaped) { escaped = false; continue; }
        if (quoted && char === '\\') { escaped = true; continue; }
        if (char === '"') {quoted = !quoted;}
        if (!quoted && char === ';') { pieces.push(value.slice(start, i)); start = i + 1; }
        requireMime(quoted || !['(', ')'].includes(char ?? ''));
    }
    requireMime(!quoted && !escaped);
    pieces.push(value.slice(start));
    const names = new Set<string>();
    for (const piece of pieces.slice(1)) {
        const match = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*("(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s;"=]+)\s*$/u.exec(piece);
        requireMime(match?.[1]);
        const name = match[1].toLowerCase();
        requireMime(!names.has(name)); names.add(name);
        const base = name.split('*')[0] ?? name;
        if (base === 'boundary' || base === 'charset' || base === 'start' || base === 'type') {requireMime(name === base);}
    }
    for (const name of names) {
        if (name.includes('*')) {requireMime(!names.has(name.split('*')[0] ?? name));}
    }
    const families = new Map<string, string[]>();
    for (const name of names) {
        const base = name.split('*')[0] ?? name;
        families.set(base, [...(families.get(base) ?? []), name]);
    }
    for (const [base, family] of families) {
        if (!family.some(name => name.includes('*'))) { continue; }
        if (family.includes(base + '*')) { requireMime(family.length === 1); continue; }
        const indices: number[] = [];
        for (const name of family) {
            const suffix = name.slice(base.length);
            requireMime(/^\*(?:0|[1-9][0-9]*)\*?$/u.test(suffix));
            indices.push(Number.parseInt(suffix.slice(1), 10));
        }
        indices.sort((left, right) => left - right);
        requireMime(indices.every((index, position) => index === position));
    }
    const parsed = parseHeaderValue(value);
    return { value: parsed.value.toLowerCase(), params: parsed.params };
}
function proof(source: Source, part: Part): MimePartProof {
    return Object.freeze({ rawSha256: hash(source.raw.subarray(part.start, part.end)), encodedBodySha256: hash(source.raw.subarray(part.bodyStart, part.end)), contentType: part.type, cid: part.cid, rawBytes: part.end - part.start });
}
function canonicalBase64(value: string, patch = false): Buffer {
    const code = patch ? 'invalid_mime_patch' : 'unsupported_mime';
    requireMime(/^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 === 0, code);
    const decoded = Buffer.from(value, 'base64');
    requireMime(decoded.toString('base64') === value, code);
    return decoded;
}
function decodeBody(part: Part, raw: Buffer): Buffer {
    const encoded = raw.subarray(part.bodyStart, part.end);
    const encoding = get(part, 'content-transfer-encoding').toLowerCase() || '7bit';
    requireMime(['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding));
    if (encoding === 'base64') {
        requireMime(!/[^A-Za-z0-9+/=\r\n\t ]/u.test(encoded.toString('latin1')));
        return canonicalBase64(encoded.toString('latin1').replace(/[\r\n\t ]/gu, ''));
    }
    if (encoding === 'quoted-printable') {
        requireMime(!encoded.some(byte => byte > 126 || (byte < 32 && ![9, 10, 13].includes(byte))));
        const result = Buffer.allocUnsafe(encoded.length); let size = 0;
        for (let i = 0; i < encoded.length; i++) {
            const byte = required(encoded[i]);
            if (byte !== 61) { result[size++] = byte; continue; }
            if (encoded[i + 1] === 13 && encoded[i + 2] === 10) { i += 2; continue; }
            const hex = encoded.subarray(i + 1, i + 3).toString('latin1');
            requireMime(/^[0-9a-f]{2}$/iu.test(hex)); result[size++] = Number.parseInt(hex, 16); i += 2;
        }
        return result.subarray(0, size);
    }
    if (encoding === '7bit') {requireMime(!encoded.some(byte => byte > 127));}
    return encoded;
}
/** Reject addressparser recovery: every source mailbox must first match a conservative
 * mailbox/group grammar. Groups stay verbatim in raw headers and flatten only for routing. */
function addresses(value: string): readonly MimeAddress[] {
    if (!value) {return [];}
    const expected: string[] = [];
    let quoted = false, escaped = false, angled = false, group = false, token = '';
    const mailbox = () => {
        const item = token.trim(); token = '';
        requireMime(item);
        const match = /^(.*?)<([^<>]+)>$/u.exec(item);
        const address = match ? required(match[2]) : item;
        if (match) {
            const name = required(match[1]).trim();
            requireMime(!name || /^"(?:[^"\\]|\\.)*"$/u.test(name) || !/[<>(),:;@[\]"\\]/u.test(name));
        }
        requireMime(address.length <= 320 && EMAIL.test(address) && !address.includes('..'));
        expected.push(address);
    };
    for (const char of value) {
        if (escaped) { token += char; escaped = false; continue; }
        if (quoted && char === '\\') { token += char; escaped = true; continue; }
        if (char === '"') { quoted = !quoted; token += char; continue; }
        if (!quoted) {
            if (char === '<') { requireMime(!angled); angled = true; }
            if (char === '>') { requireMime(angled); angled = false; }
            requireMime(!['(', ')', '[', ']'].includes(char));
            if (!angled && char === ':') { requireMime(!group && token.trim() && !/[<>@]/u.test(token)); group = true; token = ''; continue; }
            if (!angled && char === ';') { requireMime(group); if (token.trim()) {mailbox();} group = false; token = ''; continue; }
            if (!angled && char === ',') { if (token.trim()) {mailbox();} else {requireMime(value.includes(';'));} continue; }
        }
        token += char;
    }
    requireMime(!quoted && !angled && !group && !escaped);
    if (token.trim()) {mailbox();}
    const parsed = AddressParser(value, { flatten: true });
    requireMime(parsed.length === expected.length && parsed.every((entry, i) => entry.address === expected[i]));
    return Object.freeze(parsed.map(entry => Object.freeze({ address: entry.address, ...(entry.name ? { name: entry.name } : {}) })));
}
function envelope(root: Part): MimeEnvelope {
    const from = addresses(get(root, 'from'));
    requireMime(from.length === 1);
    const sender = addresses(get(root, 'sender'));
    requireMime(sender.length === 0 || (sender.length === 1 && required(sender[0]).address === required(from[0]).address));
    const result = { from, replyTo: addresses(get(root, 'reply-to')), to: addresses(get(root, 'to')), cc: addresses(get(root, 'cc')), bcc: addresses(get(root, 'bcc')) };
    requireMime(result.to.length + result.cc.length + result.bcc.length <= 100);
    return Object.freeze(result);
}
async function split(raw: Buffer): Promise<Map<number, MimeNode>> {
    const splitter = new Splitter({ ignoreEmbedded: true, maxHeadSize: MIME_LIMITS.headerBytes });
    const joiner = new Joiner();
    const nodes = new Map<number, MimeNode>();
    let offset = 0, outputOffset = 0;
    const observer = new Transform({ objectMode: true, transform(chunk: SplitterChunk, _encoding, callback) {
        try {
            if (chunk.type === "node") { requireMime(nodes.size < MIME_LIMITS.nodes); nodes.set(offset, chunk); offset += chunk.getHeaders().length; }
            else {offset += chunk.value.length;}
            requireMime(offset <= raw.length); callback(null, chunk);
        } catch (error) { callback(error as Error); }
    } });
    const collector = new Writable({ write(chunk: Buffer, _encoding, callback) {
        if (!raw.subarray(outputOffset, outputOffset + chunk.length).equals(chunk)) {return callback(new MimeError("unsupported_mime"));}
        outputOffset += chunk.length; callback();
    } });
    try { await pipeline(Readable.from([raw]), splitter, observer, joiner, collector); }
    catch { fail(); }
    requireMime(offset === raw.length && outputOffset === raw.length);
    return nodes;
}

/** The independently checked delimiter spans must agree with every Splitter node.
 * CRLF headers/delimiters, exact boundary lines, and closed ordinary multiparts only. */
export async function inspectSource(input: Uint8Array, attachmentBindings: readonly MimeAttachmentBinding[] = []): Promise<InspectedMime> {
    requireMime(input.byteLength > 0 && input.byteLength <= MIME_LIMITS.sourceBytes, 'mime_limit');
    const raw = Buffer.from(input);
    const nodes = await split(raw);
    const boundaries = new Set<string>();
    const leaves: Part[] = [];
    const cids = new Set<string>();
    let count = 0, headerBytes = 0;
    const walk = (start: number, end: number, depth: number, parent?: Part): Part => {
        requireMime(depth <= MIME_LIMITS.depth && ++count <= MIME_LIMITS.nodes);
        const node = nodes.get(start); requireMime(node);
        requireMime(node.parentNode === (parent?.node ?? false));
        const parsed = headersAt(raw, start, end);
        headerBytes += parsed.bodyStart - start;
        requireMime(headerBytes <= MIME_LIMITS.totalHeaderBytes);
        requireMime(node.getHeaders().equals(raw.subarray(start, parsed.bodyStart)));
        const part: Part = { start, end, ...parsed, node, type: '', params: {}, children: [], cid: null, ...(parent ? { parent } : {}) };
        const contentType = structured(get(part, 'content-type') || 'text/plain');
        requireMime(MEDIA.test(contentType.value) && contentType.value === node.contentType);
        part.type = contentType.value; part.params = contentType.params;
        const dispositionValue = get(part, 'content-disposition');
        if (dispositionValue) {requireMime(['inline', 'attachment'].includes(structured(dispositionValue).value));}
        requireMime(!/^(?:multipart\/(?:signed|encrypted)|application\/(?:x-)?(?:pkcs7|pgp))/u.test(part.type));
        const cid = get(part, 'content-id');
        if (cid) {
            requireMime(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+>$/u.test(cid));
            part.cid = cid.slice(1, -1); requireMime(!cids.has(part.cid)); cids.add(part.cid);
        }
        if (!part.type.startsWith('multipart/')) { leaves.push(part); part.decoded = decodeBody(part, raw); return part; }
        requireMime(['multipart/mixed', 'multipart/related', 'multipart/alternative'].includes(part.type));
        requireMime(!dispositionValue && !get(part, 'content-transfer-encoding'));
        const boundary = part.params.boundary;
        requireMime(boundary && /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(boundary) && !boundaries.has(boundary));
        requireMime(![...boundaries].some(other => boundary.startsWith(other) || other.startsWith(boundary)));
        boundaries.add(boundary); part.boundary = boundary;
        const marker = Buffer.from('--' + boundary);
        const delimiters: { start: number; after: number; close: boolean }[] = [];
        let position = part.bodyStart;
        while (position < end) {
            const newline = raw.indexOf(10, position);
            const after = newline < 0 || newline >= end ? end : newline + 1;
            let lineEnd = after;
            if (raw[after - 1] === 10) {lineEnd -= raw[after - 2] === 13 ? 2 : 1;}
            const line = raw.subarray(position, lineEnd);
            if (line.subarray(0, marker.length).equals(marker)) {
                requireMime((after === end || raw[after - 2] === 13) && (position === part.bodyStart || raw[position - 2] === 13));
                const suffix = line.subarray(marker.length).toString('latin1');
                requireMime(suffix === '' || suffix === '--');
                delimiters.push({ start: position, after, close: suffix === '--' });
            }
            position = after;
        }
        requireMime(delimiters.length >= 2 && required(delimiters.at(-1)).close && delimiters.slice(0, -1).every(item => !item.close));
        part.closeStart = required(delimiters.at(-1)).start;
        for (let i = 0; i < delimiters.length - 1; i++) {
            const opening = required(delimiters[i]), next = required(delimiters[i + 1]);
            requireMime(raw.subarray(next.start - 2, next.start).equals(Buffer.from('\r\n')));
            const childHeader = nodes.get(opening.after); requireMime(childHeader);
            const childEnd = Math.max(next.start - 2, opening.after + childHeader.getHeaders().length);
            requireMime(childEnd <= next.start);
            const child = walk(opening.after, childEnd, depth + 1, part);
            child.segmentStart = opening.start; child.segmentEnd = next.start;
            part.children.push(child);
        }
        return part;
    };
    const root = walk(0, raw.length, 0);
    requireMime(!get(root, 'mime-version') || get(root, 'mime-version') === '1.0');
    requireMime(count === nodes.size);
    const attachments: Part[] = [];
    const textLeaf = (part: Part) => {
        requireMime(['text/plain', 'text/html'].includes(part.type) && part.node.disposition !== 'attachment' && !part.node.filename);
        requireMime(!part.node.flowed && Object.keys(part.params).every(key => key === 'charset'));
        const charset = (part.params.charset || 'us-ascii').toLowerCase();
        requireMime(['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(charset));
        if (charset === 'us-ascii' || charset === 'ascii') {requireMime(!required(part.decoded).some(byte => byte > 127));}
        decodeUtf8(required(part.decoded));
    };
    const body = (part: Part): Part => {
        if (part.type === 'multipart/alternative') {
            requireMime(part.children.length === 2 && required(part.children[0]).type === 'text/plain' && required(part.children[1]).type === 'text/html');
            requireMime(Object.keys(part.params).every(key => key === 'boundary'));
            part.children.forEach(textLeaf); return part;
        }
        if (part.type === 'multipart/mixed' || part.type === 'multipart/related') {
            requireMime(part.children.length >= 1);
            requireMime(Object.keys(part.params).every(key => ['boundary', ...(part.type === 'multipart/related' ? ['start', 'type'] : [])].includes(key)));
            const first = required(part.children[0]);
            if (part.params.start) {requireMime(part.params.start === `<${first.cid}>`);}
            if (part.params.type) {requireMime(part.params.type.toLowerCase() === first.type);}
            const core = body(first);
            for (const child of part.children.slice(1)) {
                requireMime(child.children.length === 0 && (!['text/plain', 'text/html'].includes(child.type) || child.node.disposition === 'attachment'));
                attachments.push(child);
            }
            return core;
        }
        textLeaf(part); return part;
    };
    const core = body(root);
    const bindings = new Map<string, Part>();
    const byHash = new Map<string, Part[]>();
    for (const part of attachments) {
        const digest = hash(raw.subarray(part.bodyStart, part.end));
        byHash.set(digest, [...(byHash.get(digest) ?? []), part]);
    }
    const bindingIds = new Set<string>();
    const hashCounts = new Map<string, number>();
    for (const binding of attachmentBindings) {hashCounts.set(binding.hash, (hashCounts.get(binding.hash) ?? 0) + 1);}
    for (const binding of attachmentBindings) {
        requireMime(/^ATT[0-9]{5,}$/u.test(binding.attachmentId) && /^[a-f0-9]{64}$/u.test(binding.hash) && !bindingIds.has(binding.attachmentId));
        bindingIds.add(binding.attachmentId);
        const matches = byHash.get(binding.hash);
        // No inferred sequence or filename fallback: embedded messages and oversized
        // inline text also consume backend ATT numbers. Ambiguity prevents removal.
        if (matches?.length === 1 && hashCounts.get(binding.hash) === 1) {bindings.set(binding.attachmentId, required(matches[0]));}
    }
    const source: Source = { raw, root, core, leaves, attachments, bindings, envelope: envelope(root) };
    const result = Object.freeze({ sha256: hash(raw), envelope: source.envelope, attachments: Object.freeze(attachments.map(part => proof(source, part))) });
    inspections.set(result, source); return result;
}

function builder(): Builder { return new Builder(undefined, { keepBcc: true, disableFileAccess: true, disableUrlAccess: true }); }
function generatedHeaders(values: Record<string, string | MimeAddress | readonly MimeAddress[]>): Map<string, Buffer | null> {
    const node = builder();
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') {safeText(value, 2048);}
        else {
            const list = Array.isArray(value) ? value : [value as MimeAddress];
            requireMime(list.length <= 100, 'invalid_mime_patch');
            for (const address of list) {
                safeText(address.address, 320); requireMime(EMAIL.test(address.address) && !address.address.includes('..'), 'invalid_mime_patch');
                if (address.name !== undefined) { safeText(address.name, 320); requireMime(!/=\?[^?]+\?[bq]\?/iu.test(address.name), 'invalid_mime_patch'); }
            }
        }
        node.setHeader(key, typeof value === 'string' ? key === 'Subject' && value ? encodeWord(value, 'B', 52) : value : Array.isArray(value) ? [...value] : value as MimeAddress);
    }
    // Read only requested fields from the library's safe builder. Its generated Date,
    // Message-ID, MIME-Version, and Content-Type must never replace source headers.
    const bytes = Buffer.from(node.buildHeaders() + '\r\n\r\n');
    const parsed = headersAt(bytes, 0, bytes.length).headers;
    return new Map(Object.keys(values).map(key => {
        const header = parsed.find(item => item.key === key.toLowerCase());
        return [key.toLowerCase(), header?.raw ?? null];
    }));
}
function patchHeaders(headers: readonly Header[], updates: ReadonlyMap<string, Buffer | null>): Buffer {
    const pending = new Map(updates), output: Buffer[] = [];
    for (const header of headers) {
        if (!pending.has(header.key)) { output.push(header.raw); continue; }
        const replacement = pending.get(header.key); if (replacement) {output.push(replacement);}
        pending.delete(header.key);
    }
    for (const replacement of pending.values()) {if (replacement) {output.push(replacement);}}
    output.push(Buffer.from('\r\n'));
    return Buffer.concat(output);
}
function encoded(bytes: Buffer): Buffer { return Buffer.from(bytes.toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? ''); }
function newBoundary(chunks: readonly Buffer[]): string {
    // A generated boundary must not even be a substring of retained/new content.
    for (let attempt = 0; attempt < 8; attempt++) {
        const boundary = '=_mcp_' + randomUUID().replaceAll('-', '');
        if (chunks.every(chunk => !chunk.includes(boundary))) {return boundary;}
    }
    return fail('invalid_mime_patch');
}
interface Entity { headers: Buffer; body: Buffer; type: string }
function serialize(entity: Entity): Buffer { return Buffer.concat([entity.headers, entity.body]); }
function textEntity(type: 'text/plain' | 'text/html', text: string): Entity {
    return { headers: Buffer.from(`Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`), body: encoded(Buffer.from(text)), type };
}
function multipart(type: 'multipart/alternative' | 'multipart/mixed' | 'multipart/related', children: readonly Buffer[]): Entity {
    requireMime(children.length > 0);
    const boundary = newBoundary(children);
    return {
        headers: Buffer.from(`Content-Type: ${type}; boundary="${boundary}"\r\n\r\n`),
        body: Buffer.concat([...children.flatMap(child => [Buffer.from(`--${boundary}\r\n`), child, Buffer.from('\r\n')]), Buffer.from(`--${boundary}--\r\n`)]), type,
    };
}
function bodyEntity(body: MimeBody): Entity {
    requireMime(body && typeof body.text === 'string' && (body.html === null || typeof body.html === 'string'), 'invalid_mime_patch');
    requireMime(body.text.isWellFormed() && Buffer.byteLength(body.text) <= 128 * 1024, 'invalid_mime_patch');
    requireMime(body.html === null || (body.html.isWellFormed() && Buffer.byteLength(body.html) <= 256 * 1024 && !/attachment:ATT[0-9]+/iu.test(body.html)), 'invalid_mime_patch');
    const plain = textEntity('text/plain', body.text);
    return body.html === null ? plain : multipart('multipart/alternative', [serialize(plain), serialize(textEntity('text/html', body.html))]);
}
/** RFC 2046 message/rfc822 permits only identity encodings. Preserve supplied
 * file bytes; reject bare LF because Wildduck would normalize it on ingestion. */
function messageEncoding(bytes: Buffer): '7bit' | '8bit' | 'binary' {
    let previous = -1, lineLength = 0, binary = false, eightBit = false;
    for (const byte of bytes) {
        if (previous === 13 && byte !== 10) { binary = true; }
        if (byte === 10) {
            requireMime(previous === 13, 'invalid_mime_patch');
            lineLength = 0;
        } else if (byte !== 13) {
            lineLength++;
            if (lineLength > 998 || byte === 0) { binary = true; }
        }
        if (byte > 127) { eightBit = true; }
        previous = byte;
    }
    if (previous === 13) { binary = true; }
    return binary ? 'binary' : eightBit ? '8bit' : '7bit';
}
function attachmentEntities(attachments: readonly MimeAttachment[]): { inline: Buffer[]; regular: Buffer[]; cids: string[]; bytes: number } {
    requireMime(attachments.length <= MIME_LIMITS.nodes, 'invalid_mime_patch');
    const result: { inline: Buffer[]; regular: Buffer[]; cids: string[]; bytes: number } = { inline: [], regular: [], cids: [], bytes: 0 };
    for (const attachment of attachments) {
        safeText(attachment.filename, 512); requireMime(attachment.filename.length > 0, 'invalid_mime_patch');
        safeText(attachment.contentType, 128);
        const contentType = attachment.contentType.toLowerCase();
        requireMime(MEDIA.test(contentType) && !contentType.startsWith('multipart/'), 'invalid_mime_patch');
        // Other message subtypes have subtype-specific syntax/encoding rules. Only
        // rfc822 has an explicit new-part implementation; existing parts stay opaque.
        requireMime(!contentType.startsWith('message/') || contentType === 'message/rfc822', 'invalid_mime_patch');
        requireMime(attachment.disposition === 'inline' || attachment.disposition === 'attachment', 'invalid_mime_patch');
        requireMime(typeof attachment.contentBase64 === 'string' && attachment.contentBase64.length <= Math.ceil(MIME_LIMITS.attachmentBytes / 3) * 4, 'mime_limit');
        const bytes = canonicalBase64(attachment.contentBase64, true); result.bytes += bytes.length;
        requireMime(result.bytes <= MIME_LIMITS.attachmentBytes, 'mime_limit');
        requireMime(attachment.disposition !== 'inline' || attachment.cid, 'invalid_mime_patch');
        if (attachment.cid !== undefined) {
            safeText(attachment.cid, 200);
            requireMime(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/u.test(attachment.cid), 'invalid_mime_patch');
            requireMime(!result.cids.includes(attachment.cid), 'invalid_mime_patch'); result.cids.push(attachment.cid);
        }
        const isMessage = contentType === 'message/rfc822';
        const transferEncoding = isMessage ? messageEncoding(bytes) : 'base64';
        const node = new Builder(contentType, { filename: attachment.filename, disableFileAccess: true, disableUrlAccess: true });
        node.setHeader('Content-Disposition', attachment.disposition);
        node.setHeader('Content-Transfer-Encoding', transferEncoding);
        if (attachment.cid) {node.setHeader('Content-ID', `<${attachment.cid}>`);}
        const rawHeaders = Buffer.from(node.buildHeaders() + '\r\n\r\n');
        const headers = headersAt(rawHeaders, 0, rawHeaders.length).headers.filter(header => header.key.startsWith('content-'));
        const part = Buffer.concat([...headers.map(header => header.raw), Buffer.from('\r\n'), isMessage ? bytes : encoded(bytes)]);
        result[attachment.disposition === 'inline' ? 'inline' : 'regular'].push(part);
    }
    return result;
}
function mergeEntityHeaders(part: Part, entity: Entity): Buffer {
    const parsed = headersAt(entity.headers, 0, entity.headers.length).headers;
    const updates = new Map<string, Buffer | null>([['content-type', null], ['content-transfer-encoding', null]]);
    for (const header of parsed) {updates.set(header.key, header.raw);}
    return patchHeaders(part.headers, updates);
}
function bodyChangeSafe(core: Part): void {
    const allowed = new Set(['content-type', 'content-transfer-encoding', 'content-disposition', 'content-id']);
    for (const header of core.headers) {if (header.key.startsWith('content-')) {requireMime(allowed.has(header.key));}}
    for (const child of core.children) {
        // A new alternative cannot quietly drop arbitrary old leaf metadata.
        requireMime(child.headers.every(header => ['content-type', 'content-transfer-encoding', 'content-disposition'].includes(header.key)));
    }
}
function contentEntity(source: Source, part: Part, full: Buffer): Buffer {
    if (part !== source.root) {return full;}
    const parsed = headersAt(full, 0, full.length);
    return Buffer.concat([...parsed.headers.filter(header => header.key.startsWith('content-')).map(header => header.raw), Buffer.from('\r\n'), full.subarray(parsed.bodyStart)]);
}
async function prepared(raw: Buffer, retained: readonly MimePartProof[]): Promise<PreparedMime> {
    requireMime(raw.length <= MIME_LIMITS.sourceBytes, 'mime_limit');
    const inspected = await inspectSource(raw);
    // Multiset verification, so equal retained attachments must occur equally often.
    const available = new Map<string, number>();
    for (const part of inspected.attachments) {available.set(part.rawSha256, (available.get(part.rawSha256) ?? 0) + 1);}
    for (const part of retained) {
        const count = available.get(part.rawSha256) ?? 0; requireMime(count > 0, 'mime_verification_failed');
        available.set(part.rawSha256, count - 1);
    }
    const result: PreparedMime = Object.freeze({ raw: Buffer.from(raw), sha256: inspected.sha256, envelope: inspected.envelope, retainedAttachments: Object.freeze([...retained]) });
    preparations.set(result, raw); return result;
}

/** Omitted body/attachments are preserved. Only positively bound attachment IDs may be
 * removed. Patches never flatten an existing MIME tree or re-encode an opaque leaf. */
export async function preparePatch(inspected: InspectedMime, patch: MimePatch): Promise<PreparedMime> {
    const source = inspections.get(inspected); requireMime(source, 'invalid_mime_patch');
    const deletes = patch.deleteAttachmentIds ?? [];
    requireMime(new Set(deletes).size === deletes.length, 'invalid_mime_patch');
    const removed = new Set<Part>();
    for (const id of deletes) { const part = source.bindings.get(id); requireMime(part, 'invalid_mime_patch'); removed.add(part); }
    const additions = attachmentEntities(patch.attachments ?? []);
    // Identity-encoded .eml files can contain delimiter-looking lines. Before
    // appending into an existing tree, rule out collisions with all its boundaries.
    const pending = [source.root];
    const boundaries: string[] = [];
    for (const part of pending) {
        if (part.boundary) { boundaries.push(part.boundary); }
        pending.push(...part.children);
    }
    for (const addition of [...additions.inline, ...additions.regular]) {
        requireMime(boundaries.every(boundary => !addition.includes(boundary)), 'invalid_mime_patch');
    }
    const retained = source.attachments.filter(part => !removed.has(part));
    requireMime(retained.reduce((total, part) => total + required(part.decoded).length, additions.bytes) <= MIME_LIMITS.attachmentBytes, 'mime_limit');
    const allCids = source.leaves.filter(part => !removed.has(part) && part.cid).map(part => required(part.cid));
    for (const cid of additions.cids) { requireMime(!allCids.includes(cid), 'invalid_mime_patch'); allCids.push(cid); }
    // Omitted body is a preservation promise. An explicit new body is authored by
    // the caller; preserve it exactly but reject obvious stale CID references.
    const removedCids = new Set([...removed].flatMap(part => part.cid ? [part.cid] : []));
    if (removedCids.size) {
        requireMime(patch.body !== undefined, 'invalid_mime_patch');
        if (patch.body.html !== null) {
            for (const match of patch.body.html.matchAll(/cid:([^\s"'<>()[\]]+)/giu)) {
                let cid = required(match[1]);
                try { cid = decodeURIComponent(cid); } catch { fail('invalid_mime_patch'); }
                requireMime(!removedCids.has(cid), 'invalid_mime_patch');
            }
        }
    }
    let replacement: Entity | undefined;
    if (patch.body !== undefined) { bodyChangeSafe(source.core); replacement = bodyEntity(patch.body); }
    let related: Part | undefined;
    for (let current = source.core.parent; current; current = current.parent) {if (current.type === 'multipart/related') { related = current; break; }}
    const headerChanges: Record<string, string | MimeAddress | readonly MimeAddress[]> = {};
    if (patch.from !== undefined) {headerChanges.From = patch.from;}
    if (patch.replyTo !== undefined) {headerChanges['Reply-To'] = patch.replyTo;}
    if (patch.to !== undefined) {headerChanges.To = patch.to;}
    if (patch.cc !== undefined) {headerChanges.Cc = patch.cc;}
    if (patch.bcc !== undefined) {headerChanges.Bcc = patch.bcc;}
    if (patch.subject !== undefined) {headerChanges.Subject = patch.subject;}
    const updates = generatedHeaders(headerChanges);
    if (!get(source.root, 'mime-version') && (replacement || deletes.length || patch.attachments?.length)) {updates.set('mime-version', Buffer.from('MIME-Version: 1.0\r\n'));}
    const render = (part: Part): Buffer => {
        let entity: Entity | undefined;
        if (part === source.core && replacement) {entity = replacement;}
        let bytes: Buffer;
        if (entity) {bytes = Buffer.concat([mergeEntityHeaders(part, entity), entity.body]);}
        else if (part.children.length) {
            const chunks: Buffer[] = [];
            let offset = part.start;
            for (const child of part.children) {
                if (removed.has(child)) { chunks.push(source.raw.subarray(offset, child.segmentStart)); offset = required(child.segmentEnd); continue; }
                const rendered = render(child);
                chunks.push(source.raw.subarray(offset, child.start), rendered);
                // For an empty original body the header separator itself can supply
                // the CRLF before the delimiter. A replacement body needs its own.
                if (child.end === child.segmentEnd && !rendered.subarray(-2).equals(Buffer.from('\r\n'))) { chunks.push(Buffer.from('\r\n')); }
                offset = child.end;
            }
            const append = part === related ? additions.inline : part === source.root && part.type === 'multipart/mixed' ? additions.regular : [];
            if (append.length) {
                chunks.push(source.raw.subarray(offset, part.closeStart));
                chunks.push(...append.flatMap(item => [Buffer.from(`--${part.boundary}\r\n`), item, Buffer.from('\r\n')])); offset = required(part.closeStart);
            }
            chunks.push(source.raw.subarray(offset, part.end)); bytes = Buffer.concat(chunks);
            // The related type describes its first child. If that child changed from
            // text to alternative (or back), the parameter must change with it.
            if (part.type === 'multipart/related' && part.params.type && part.children[0] === source.core && replacement && part.params.type.toLowerCase() !== replacement.type) {
                const newType = get(part, 'content-type').replace(/(\btype\s*=\s*)(?:"(?:[^"\\]|\\.)*"|[^;\s]+)/iu, `$1"${replacement.type}"`);
                bytes = Buffer.concat([patchHeaders(part.headers, generatedHeaders({ 'Content-Type': newType })), bytes.subarray(part.bodyStart - part.start)]);
            }
        } else {bytes = source.raw.subarray(part.start, part.end);}
        if (part === source.core && additions.inline.length && !related) {
            const wrapper = multipart('multipart/related', [contentEntity(source, part, bytes), ...additions.inline]);
            const outerHeaders = part === source.root ? Buffer.concat([...part.headers.filter(header => !header.key.startsWith('content-')).map(header => header.raw), wrapper.headers]) : wrapper.headers;
            bytes = Buffer.concat([outerHeaders, wrapper.body]);
        }
        if (part === source.root) {
            if (additions.regular.length && part.type !== 'multipart/mixed') {
                const wrapper = multipart('multipart/mixed', [contentEntity(source, part, bytes), ...additions.regular]);
                const current = headersAt(bytes, 0, bytes.length);
                bytes = Buffer.concat([...current.headers.filter(header => !header.key.startsWith('content-')).map(header => header.raw), wrapper.headers, wrapper.body]);
            }
            const current = headersAt(bytes, 0, bytes.length);
            bytes = Buffer.concat([patchHeaders(current.headers, updates), bytes.subarray(current.bodyStart)]);
        }
        return bytes;
    };
    const raw = render(source.root);
    if (!replacement && !deletes.length && !(patch.attachments?.length)) {requireMime(raw.subarray(headersAt(raw, 0, raw.length).bodyStart).equals(source.raw.subarray(source.root.bodyStart)), 'mime_verification_failed');}
    return prepared(raw, retained.map(part => proof(source, part)));
}

/** New mail uses only caller bytes/strings; no URL, filesystem or remote asset access. */
export async function createMime(input: MimeCreate): Promise<PreparedMime> {
    requireMime(!(input.deleteAttachmentIds?.length), 'invalid_mime_patch');
    let entity = bodyEntity(input.body);
    const additions = attachmentEntities(input.attachments ?? []);
    if (additions.inline.length) {entity = multipart('multipart/related', [serialize(entity), ...additions.inline]);}
    if (additions.regular.length) {entity = multipart('multipart/mixed', [serialize(entity), ...additions.regular]);}
    const generated = generatedHeaders({ From: input.from, To: input.to, Cc: input.cc, Bcc: input.bcc, Subject: input.subject, ...(input.replyTo ? { 'Reply-To': input.replyTo } : {}) });
    const root = builder(); root.setHeader('Date', new Date()); root.setHeader('Message-ID', `<${randomUUID()}@mcp.invalid>`); root.setHeader('MIME-Version', '1.0');
    const required = Buffer.from(root.buildHeaders() + '\r\n\r\n');
    const metadata = headersAt(required, 0, required.length).headers.filter(header => ['date', 'message-id', 'mime-version'].includes(header.key));
    const raw = Buffer.concat([...metadata.map(header => header.raw), ...[...generated.values()].filter((value): value is Buffer => value !== null), entity.headers, entity.body, ...(entity.body.subarray(-2).equals(Buffer.from('\r\n')) ? [] : [Buffer.from('\r\n')])]);
    return prepared(raw, []);
}

/** Verification is exact, including MIME headers, encoded attachments, preamble and
 * tail bytes. The private expected copy also detects mutation of prepared.raw. */
export function verifyCandidate(expected: PreparedMime, actualRaw: Uint8Array): void {
    const raw = preparations.get(expected);
    requireMime(raw && raw.equals(expected.raw) && actualRaw.byteLength === raw.length && raw.equals(Buffer.from(actualRaw)), 'mime_verification_failed');
}
