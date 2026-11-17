import { isAscii } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, Joiner, type MimeNode, type SplitterChunk } from '@zone-eu/mailsplit';
import AddressParser from 'nodemailer/lib/addressparser';
import Builder from 'nodemailer/lib/mime-node';
import { parseHeaderValue } from 'nodemailer/lib/mime-funcs';
import { encode as qpEncode, wrap as qpWrap } from 'nodemailer/lib/qp';
import { encode as base64Encode, wrap as base64Wrap } from 'nodemailer/lib/base64';
import libmime from 'libmime';
import type { ResolvedAttachment } from './contracts';

/** Bounded supported subset: CRLF MIME headers/delimiters; UTF-8/ASCII text;
 * one plain, HTML, or direct plain+HTML alternative inside ordinary related/mixed
 * wrappers. Other sibling leaves are opaque attachments (including calendar and
 * message/rfc822). Unsupported structure/semantics fail closed before upload.
 * Request-local only. Never persist/log source, candidates, or inspection handles. */
// The header limits admit every schema-valid draft as the library writes it (measured): 151
// mailboxes (From, 50 Reply-To, 100 recipients) with 320-byte names that Q-encode at their
// largest and 254-character addresses fill about 179 KB of root headers, and 100 attachments
// with 255-byte names, types and CIDs about 217 KB of part headers.
/** The one size cap on a finished composed message (issue #2), whatever its attachment sources.
 * Defined here, not in schemas.ts, because schemas.ts imports this module: mime.ts must never
 * import schemas.ts. It bounds every source this layer reads or writes: a new message, a patched
 * one (retained plus added parts) and an existing authored draft that is inspected for an update. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
// nodes, depth and the header limits bound structure, not size: none grows with a larger file,
// so a 25 MiB message needs no more of them, and they stay the hostile-input bounds they were.
export const MIME_LIMITS = Object.freeze({ messageBytes: MAX_MESSAGE_BYTES, headerBytes: 192 * 1024, totalHeaderBytes: 448 * 1024, nodes: 128, depth: 12 });
export class MimeError extends Error {
    /** invalid_attachment: a new attachment's own bytes break a rule (message/rfc822 with a bare LF),
     * which is the caller's input, as the schema reports the same rule for contentBase64. */
    constructor(public readonly code: 'unsupported_mime' | 'invalid_mime_patch' | 'invalid_attachment' | 'mime_limit' | 'mime_verification_failed') { super(code); this.name = 'MimeError'; }
}
export interface MimeAddress { readonly address: string; readonly name?: string | undefined }
export interface MimeEnvelope { readonly from: readonly MimeAddress[]; readonly replyTo: readonly MimeAddress[]; readonly to: readonly MimeAddress[]; readonly cc: readonly MimeAddress[]; readonly bcc: readonly MimeAddress[] }
/** Wildduck attachments[].hash: SHA256 of the original transfer-encoded body, NOT fileContentHash. */
export interface MimeAttachmentBinding { readonly attachmentId: string; readonly hash: string }
/** One new attachment, from whichever source, with its bytes final. This layer only reads the bytes
 * (never modifies them), so one array may back several parts, and it applies every byte rule here,
 * the same for every source. */
export type MimeAttachment = ResolvedAttachment;
export interface MimeBody { readonly text: string; readonly html: string | null }
export interface MimePatch {
    readonly from?: MimeAddress | undefined; readonly replyTo?: readonly MimeAddress[] | undefined; readonly to?: readonly MimeAddress[] | undefined; readonly cc?: readonly MimeAddress[] | undefined; readonly bcc?: readonly MimeAddress[] | undefined;
    readonly subject?: string | undefined; readonly body?: MimeBody | undefined; readonly deleteAttachmentIds?: readonly string[] | undefined; readonly attachments?: readonly MimeAttachment[] | undefined;
}
export interface MimeThreading { readonly inReplyTo: string; readonly references: readonly string[] }
export interface MimeCreate extends MimePatch { readonly threading?: MimeThreading | undefined; readonly from: MimeAddress; readonly subject: string; readonly body: MimeBody; readonly to: readonly MimeAddress[]; readonly cc: readonly MimeAddress[]; readonly bcc: readonly MimeAddress[] }
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
// The SHA-256 of each prepared raw, not a private second copy: at 25 MiB a copy costs as much
// memory as the message, and the digest detects a later change to prepared.raw just the same.
const preparations = new WeakMap<PreparedMime, string>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** A Buffer over the same memory, never a copy. */
const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const fail = (code: MimeError['code'] = 'unsupported_mime'): never => { throw new MimeError(code); };
const requireMime: (condition: unknown, code?: MimeError['code']) => asserts condition = (condition, code) => { if (!condition) {fail(code);} };
function required<T>(value: T | undefined | null): T { requireMime(value !== undefined && value !== null); return value; }
function headerControls(value: string, folding = false): boolean {
    for (const char of value) { const code = char.charCodeAt(0); if (code === 127 || (code < 32 && !(folding && [9, 10, 13].includes(code)))) { return true; } }
    return false;
}
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const MEDIA = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
/** The ASCII addresses this layer writes and reads: dot-atom local part, ASCII domain. */
export const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
/** Bounds and syntax of caller-supplied fields, shared with the public schemas (schemas.ts) so
 * a schema can accept nothing this layer rejects: every byte bound counts UTF-8; a Content-ID
 * is the dot-atom/atext set (plus "@") that inspectSource also reads. */
export const AUTHORED_LIMITS = Object.freeze({ addressBytes: 320, nameBytes: 320, subjectBytes: 2048, filenameBytes: 255, contentTypeBytes: 255, cidBytes: 255 });
export const CONTENT_ID = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/u;
/** type/subtype of an attachment: no parameters, and the types this layer has no safe
 * single-part representation for are excluded (multipart needs a boundary; only message/rfc822
 * has an identity-encoded implementation). */
export const ATTACHMENT_MEDIA = /^(?!multipart\/)(?!message\/(?!rfc822$))[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/iu;
/** A text/plain or text/html part inside multipart/related is read back as the body, so an
 * inline one is ambiguous. */
export const AMBIGUOUS_INLINE = /^text\/(?:plain|html)$/iu;
/** True when an HTML tag has an attribute value that starts with an attachment:ATTn URL, the
 * WildDuck JSON API's reference syntax. A raw upload resolves nothing, so such an image or
 * link would stay broken; prose that merely mentions "attachment:ATT1" is ordinary text.
 * One linear pass: tag by tag, no backtracking pattern. */
export function hasAttachmentReference(html: string): boolean {
    for (let open = html.indexOf('<'); open >= 0;) {
        const close = html.indexOf('>', open + 1);
        const end = close < 0 ? html.length : close;
        for (let equals = html.indexOf('=', open + 1); equals >= 0 && equals < end; equals = html.indexOf('=', equals + 1)) {
            let at = equals + 1;
            while (at < end && /\s/u.test(html[at] ?? '')) { at++; }
            if (html[at] === '"' || html[at] === "'") { at++; while (at < end && /\s/u.test(html[at] ?? '')) { at++; } }
            if (/^attachment:ATT[0-9]/iu.test(html.slice(at, at + 15))) { return true; }
        }
        open = close < 0 ? -1 : html.indexOf('<', close + 1);
    }
    return false;
}
/** message/rfc822 uses identity encodings, so its bytes must be CRLF-canonical already. */
export function hasBareLineFeed(bytes: Uint8Array): boolean {
    for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 10 && (i === 0 || bytes[i - 1] !== 13)) { return true; } }
    return false;
}
// Deliberately bounded dot-atom subset of RFC message-id; no comments, folding or recovery.
const MESSAGE_ID = /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/u;
export function validateMessageId(value: string): void {
    requireMime(typeof value === 'string' && value.length <= 320 && MESSAGE_ID.test(value) && !value.includes('..'), 'invalid_mime_patch');
}
export function validateThreading(value: MimeThreading): void {
    validateMessageId(value.inReplyTo);
    requireMime(Array.isArray(value.references) && value.references.length > 0 && value.references.length <= 100, 'invalid_mime_patch');
    for (const id of value.references) { validateMessageId(id); }
    requireMime(new Set(value.references).size === value.references.length && value.references.at(-1) === value.inReplyTo && Buffer.byteLength(value.references.join(' ')) <= 2048, 'invalid_mime_patch');
}
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
            // One space per fold, as WildDuck unfolds; trimmed, since the library starts a long
            // first word on a continuation line ("Subject:" CRLF " word").
            previous.value = (previous.value + ' ' + line.trim()).trim();
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
function canonicalBase64(value: string): Buffer {
    requireMime(/^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 === 0);
    const decoded = Buffer.from(value, 'base64');
    requireMime(decoded.toString('base64') === value);
    return decoded;
}
/** Encoded bytes per slice of a base64 body. A whole 25 MiB body as one string, its stripped copy,
 * its decoding and the re-encoding that proves it canonical would be four transient copies. */
const BASE64_SLICE = 1024 * 1024;
/** A canonical base64 body (whitespace between characters allowed), checked slice by slice; the
 * decoded bytes are kept only when wanted, so a large attachment is checked without a decoded copy.
 * Every slice but the last holds whole 4-character quanta without padding, so the slices are
 * canonical together exactly when each is. */
function decodeBase64(encoded: Buffer, keep: boolean): Buffer | undefined {
    const pieces: Buffer[] = []; let carry = '';
    // Trailing whitespace is skipped, so the final slice ends with the final character.
    let end = encoded.length; while (end > 0 && [9, 10, 13, 32].includes(encoded[end - 1] ?? 0)) { end--; }
    for (let start = 0; start === 0 || start < end; start += BASE64_SLICE) {
        const last = start + BASE64_SLICE >= end;
        const text = carry + encoded.toString('latin1', start, Math.min(start + BASE64_SLICE, end));
        requireMime(!/[^A-Za-z0-9+/=\r\n\t ]/u.test(text));
        const data = text.replace(/[\r\n\t ]/gu, '');
        const whole = last ? data.length : data.length - data.length % 4;
        // Padding only ends the body: before the final slice, only a carried partial quantum may hold "=".
        const pad = data.indexOf('='); requireMime(last || pad < 0 || pad >= whole);
        carry = data.slice(whole);
        // Unpadded whole quanta of valid characters are canonical as they stand: only the final
        // slice (its pad bits) needs the decode and re-encode, unless the bytes are kept anyway.
        if (keep || last) { const decoded = canonicalBase64(whole === data.length ? data : data.slice(0, whole)); if (keep) { pieces.push(decoded); } }
    }
    return keep ? Buffer.concat(pieces) : undefined;
}
/** Checks the transfer encoding of every leaf; returns the decoded bytes only when `keep` (the text
 * leaves that can be a body, which textLeaf reads). Other leaves are opaque and copied verbatim, so
 * holding their decoded bytes would only double the memory of a large attachment. */
function decodeBody(part: Part, raw: Buffer, keep: boolean): Buffer | undefined {
    const encoded = raw.subarray(part.bodyStart, part.end);
    const encoding = get(part, 'content-transfer-encoding').toLowerCase() || '7bit';
    requireMime(['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding));
    if (encoding === 'base64') { return decodeBase64(encoded, keep); }
    if (encoding === 'quoted-printable') {
        requireMime(!/[^\t\r\n\x20-\x7e]/u.test(encoded.toString('latin1')));
        const result = Buffer.allocUnsafe(encoded.length); let size = 0;
        for (let i = 0; i < encoded.length; i++) {
            const byte = required(encoded[i]);
            if (byte !== 61) { result[size++] = byte; continue; }
            if (encoded[i + 1] === 13 && encoded[i + 2] === 10) { i += 2; continue; }
            const hex = encoded.subarray(i + 1, i + 3).toString('latin1');
            requireMime(/^[0-9a-f]{2}$/iu.test(hex)); result[size++] = Number.parseInt(hex, 16); i += 2;
        }
        return keep ? result.subarray(0, size) : undefined;
    }
    if (encoding === '7bit') { requireMime(isAscii(encoded)); }
    return keep ? encoded : undefined;
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
    // mailsplit >= 5.4.25 charges every header line at least 64 bytes against maxHeadSize, so it is
    // a cost bound, not a byte count: the largest schema-valid draft (about 175 KB of folded headers)
    // costs ~195 KB. headersAt() enforces the real byte limit (MIME_LIMITS.headerBytes); this only
    // has to stay a finite memory bound that never rejects what that policy accepts for our own output.
    const splitter = new Splitter({ ignoreEmbedded: true, maxHeadSize: MIME_LIMITS.headerBytes * 2 });
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
    requireMime(input.byteLength > 0 && input.byteLength <= MIME_LIMITS.messageBytes, 'mime_limit');
    // A private copy: the inspection keeps these bytes for preparePatch, out of the caller's reach.
    return inspect(Buffer.from(input), attachmentBindings);
}
/** inspectSource over bytes this module owns (its own composed output), without that copy. */
async function inspect(raw: Buffer, attachmentBindings: readonly MimeAttachmentBinding[] = []): Promise<InspectedMime> {
    requireMime(raw.length > 0 && raw.length <= MIME_LIMITS.messageBytes, 'mime_limit');
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
        // Signed and encrypted trees cannot be patched. A PGP key or S/MIME signature file
        // attached to an ordinary message is an opaque leaf; as the body it fails the text check.
        requireMime(!/^multipart\/(?:signed|encrypted)/u.test(part.type));
        const cid = get(part, 'content-id');
        if (cid) {
            requireMime(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+>$/u.test(cid));
            part.cid = cid.slice(1, -1); requireMime(!cids.has(part.cid)); cids.add(part.cid);
        }
        if (!part.type.startsWith('multipart/')) {
            leaves.push(part);
            const decoded = decodeBody(part, raw, ['text/plain', 'text/html'].includes(part.type) && node.disposition !== 'attachment' && !node.filename);
            if (decoded) { part.decoded = decoded; }
            return part;
        }
        requireMime(['multipart/mixed', 'multipart/related', 'multipart/alternative'].includes(part.type));
        requireMime(!dispositionValue && !get(part, 'content-transfer-encoding'));
        const boundary = part.params.boundary;
        requireMime(boundary && /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(boundary) && !boundaries.has(boundary));
        requireMime(![...boundaries].some(other => boundary.startsWith(other) || other.startsWith(boundary)));
        boundaries.add(boundary); part.boundary = boundary;
        const marker = Buffer.from('--' + boundary);
        const delimiters: { start: number; after: number; close: boolean }[] = [];
        // Every line (split at LF) that starts with the marker is a delimiter. Jump between marker
        // occurrences instead of visiting each of the ~330,000 lines of a 25 MiB base64 body.
        for (let position = raw.indexOf(marker, part.bodyStart); position >= 0 && position < end;) {
            if (position !== part.bodyStart && raw[position - 1] !== 10) { position = raw.indexOf(marker, position + 1); continue; }
            const newline = raw.indexOf(10, position);
            const after = newline < 0 || newline >= end ? end : newline + 1;
            let lineEnd = after;
            if (raw[after - 1] === 10) {lineEnd -= raw[after - 2] === 13 ? 2 : 1;}
            if (position + marker.length <= lineEnd) {
                requireMime((after === end || raw[after - 2] === 13) && (position === part.bodyStart || raw[position - 2] === 13));
                const suffix = raw.subarray(position + marker.length, lineEnd).toString('latin1');
                requireMime(suffix === '' || suffix === '--');
                delimiters.push({ start: position, after, close: suffix === '--' });
            }
            position = raw.indexOf(marker, after);
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
/** Apply the same outbound address gate to reply-derived recipients and MIME headers. */
export function validateMimeAddresses(list: readonly MimeAddress[]): void {
    requireMime(Array.isArray(list) && list.length <= 100, 'invalid_mime_patch');
    for (const address of list) {
        safeText(address.address, AUTHORED_LIMITS.addressBytes); requireMime(EMAIL.test(address.address) && !address.address.includes('..'), 'invalid_mime_patch');
        if (address.name !== undefined) { safeText(address.name, AUTHORED_LIMITS.nameBytes); }
    }
}
/** The library lowers the domain of the ASCII addresses this layer admits and changes nothing else. */
const lowerDomain = (address: string) => address.slice(0, address.lastIndexOf('@') + 1) + address.slice(address.lastIndexOf('@') + 1).toLowerCase();
/** Read-back safety net, not an encoder: a Subject or address header the library wrote must
 * decode, as WildDuck and mail clients read it (unfolded, then nodemailer's address parser and
 * libmime's RFC 2047 decoder), to exactly the requested value. No header for an empty value. */
function readsBack(header: Header | undefined, value: string | MimeAddress | readonly MimeAddress[]): boolean {
    if (typeof value === 'string') { return value ? libmime.decodeWords(header?.value ?? '') === value : header === undefined; }
    const list: readonly MimeAddress[] = Array.isArray(value) ? value : [value as MimeAddress];
    if (list.length === 0) { return header === undefined; }
    const read = AddressParser(header?.value ?? '');
    return read.length === list.length && read.every((entry, index) => entry.address === lowerDomain(list[index]?.address ?? '') && libmime.decodeWords(entry.name ?? '') === (list[index]?.name ?? ''));
}
const CHECKED_HEADERS = new Set(['subject', 'from', 'reply-to', 'to', 'cc', 'bcc']);
function generatedHeaders(values: Record<string, string | MimeAddress | readonly MimeAddress[]>): Map<string, Buffer | null> {
    const node = builder();
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') {safeText(value, AUTHORED_LIMITS.subjectBytes);}
        else {
            const list = Array.isArray(value) ? value : [value as MimeAddress];
            validateMimeAddresses(list);
        }
        node.setHeader(key, typeof value === 'string' ? value : Array.isArray(value) ? [...value] : value as MimeAddress);
    }
    // Read only requested fields from the library's safe builder. Its generated Date,
    // Message-ID, MIME-Version, and Content-Type must never replace source headers.
    const bytes = Buffer.from(node.buildHeaders() + '\r\n\r\n');
    const parsed = headersAt(bytes, 0, bytes.length).headers;
    return new Map(Object.entries(values).map(([key, value]) => {
        const header = parsed.find(item => item.key === key.toLowerCase());
        if (CHECKED_HEADERS.has(key.toLowerCase())) { requireMime(readsBack(header, value), 'invalid_mime_patch'); }
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
/** Stored size of a base64 body as this layer writes it: 76-character lines joined by CRLF. */
export function base64Bytes(bytes: number): number { const characters = Math.ceil(bytes / 3) * 4; return characters + 2 * Math.max(Math.ceil(characters / 76) - 1, 0); }
/** The encoded body of a new attachment of `bytes` bytes: message/rfc822 keeps an identity
 * encoding, every other type is base64. A lower bound on what the attachment adds to a message
 * (its headers and delimiter come on top), for budgeting sizes before any bytes are encoded. */
export function attachmentBodyBytes(bytes: number, contentType: string): number { return contentType.toLowerCase() === 'message/rfc822' ? bytes : base64Bytes(bytes); }
// Input bytes per base64 slice: whole 76-character lines (57 bytes each), so the library's wrapped
// slices joined by CRLF are exactly its wrapping of the whole, without a whole-file string.
const ENCODE_SLICE = 57 * 16 * 1024;
/** As chunks (see Chunks): joining them here would be one more copy of a 25 MiB attachment. */
function encoded(bytes: Uint8Array): Buffer[] {
    const source = view(bytes); const lines: Buffer[] = [];
    for (let start = 0; start < source.length; start += ENCODE_SLICE) {
        if (start) { lines.push(CRLF); }
        lines.push(Buffer.from(base64Wrap(base64Encode(source.subarray(start, start + ENCODE_SLICE)), 76), 'latin1'));
    }
    return lines;
}
/** A part as the list of its bytes, joined once when the whole message is written instead of
 * once per enclosing multipart: at 25 MiB each join would be another copy of the message. Every
 * join this layer makes has CR or LF on one side (headers and delimiter lines end with CRLF, and
 * a CRLF follows every body), and neither occurs in a boundary, so a boundary inside the joined
 * bytes always lies inside one chunk. */
type Chunks = readonly Buffer[];
const chunksBytes = (chunks: Chunks) => chunks.reduce((total, chunk) => total + chunk.length, 0);
function newBoundary(chunks: Chunks): string {
    // A generated boundary must not even be a substring of retained/new content.
    for (let attempt = 0; attempt < 8; attempt++) {
        const boundary = '=_mcp_' + randomUUID().replaceAll('-', '');
        if (chunks.every(chunk => !chunk.includes(boundary))) {return boundary;}
    }
    return fail('invalid_mime_patch');
}
interface Entity { headers: Buffer; body: Chunks; type: string }
function serialize(entity: Entity): Chunks { return [entity.headers, ...entity.body]; }
const CRLF = Buffer.from('\r\n');
const endsWithCrlf = (bytes: Buffer) => bytes.length >= 2 && bytes[bytes.length - 2] === 13 && bytes[bytes.length - 1] === 10;
/** Where an authored text part sits. A top-level part ends the message, and WildDuck
 * appends CRLF to a message whose last byte is not LF (imap-core parse-mime-tree.js),
 * so such a part must end with CRLF itself; a nested part's final line break belongs
 * to the next delimiter. `avoid` lists delimiter lines of enclosing retained
 * multiparts that a visible (7bit or quoted-printable) body must not contain. */
export interface TextPlacement { readonly topLevel: boolean; readonly avoid: readonly Buffer[] }
/** 7bit only for CRLF-canonical printable ASCII (plus tab) whose lines are at most
 * 76 characters, without trailing whitespace that a relay could strip. */
function sevenBitSafe(content: Buffer): boolean {
    for (let start = 0; start < content.length;) {
        let end = content.indexOf(CRLF, start);
        const next = end < 0 ? content.length : end + 2;
        if (end < 0) { end = content.length; }
        if (end - start > 76) { return false; }
        for (let i = start; i < end; i++) {
            const byte = content[i] ?? 0;
            if ((byte < 32 && byte !== 9) || byte > 126) { return false; }
        }
        const last = content[end - 1];
        if (end > start && (last === 32 || last === 9)) { return false; }
        start = next;
    }
    return true;
}
const SOFT_BREAK = Buffer.from('=\r\n');
/** Choose the transfer encoding of one CRLF-canonical UTF-8 text body: 7bit when
 * safe, else the library's quoted-printable when no larger than base64, else base64. */
export function textTransfer(content: Buffer, placement: TextPlacement): { encoding: '7bit' | 'quoted-printable' | 'base64'; body: Buffer } {
    const visible = (body: Buffer) => placement.avoid.every(marker => !body.includes(marker));
    const complete = content.length === 0 || endsWithCrlf(content);
    if ((complete || !placement.topLevel) && sevenBitSafe(content) && visible(content)) { return { encoding: '7bit', body: content }; }
    // Compare stored sizes: a top-level base64 body also gets its final CRLF appended.
    const base64Stored = base64Bytes(content.length) + (placement.topLevel && content.length > 0 ? 2 : 0);
    // A top-level part ends the message, and a message must end in LF (see TextPlacement), so
    // text without a final line break ends with a soft line break "=" CRLF, which decodes to
    // nothing. Wrapping at 75 leaves the last line room for that "=" within 76 columns.
    const softEnd = placement.topLevel && !complete;
    const wrapped = Buffer.from(qpWrap(qpEncode(content), softEnd ? 75 : 76), 'latin1');
    const qp = softEnd ? Buffer.concat([wrapped, SOFT_BREAK]) : wrapped;
    if (qp.length <= base64Stored && visible(qp)) { return { encoding: 'quoted-printable', body: qp }; }
    return { encoding: 'base64', body: Buffer.concat(encoded(content)) };
}
/** Single choke point for every authored text/plain and text/html part (create,
 * reply with or without quote, and update body patches all pass through here).
 * RFC 2046 section 4.1.1 makes CRLF the canonical line break of text/* before
 * transfer encoding, so LF, CR, CRLF and mixed input all decode as CRLF. Size
 * limits were already enforced on the caller's string by validateMimeBody. */
function textEntity(type: 'text/plain' | 'text/html', text: string, placement: TextPlacement): Entity {
    const { encoding, body } = textTransfer(Buffer.from(text.replace(/\r\n|\r|\n/gu, '\r\n')), placement);
    return { headers: Buffer.from(`Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`), body: [body], type };
}
function multipart(type: 'multipart/alternative' | 'multipart/mixed' | 'multipart/related', children: readonly Chunks[]): Entity {
    requireMime(children.length > 0);
    const boundary = newBoundary(children.flat());
    return {
        headers: Buffer.from(`Content-Type: ${type}; boundary="${boundary}"\r\n\r\n`),
        body: [...children.flatMap(child => [Buffer.from(`--${boundary}\r\n`), ...child, CRLF]), Buffer.from(`--${boundary}--\r\n`)], type,
    };
}
export function validateMimeBody(body: MimeBody): void {
    requireMime(body && typeof body.text === 'string' && (body.html === null || typeof body.html === 'string'), 'invalid_mime_patch');
    requireMime(body.text.isWellFormed() && Buffer.byteLength(body.text) <= 128 * 1024, 'invalid_mime_patch');
    requireMime(body.html === null || (body.html.isWellFormed() && Buffer.byteLength(body.html) <= 256 * 1024 && !hasAttachmentReference(body.html)), 'invalid_mime_patch');
}
/** `topLevel`: the body will be the whole message, unwrapped by any multipart. */
function bodyEntity(body: MimeBody, topLevel: boolean, avoid: readonly Buffer[] = []): Entity {
    validateMimeBody(body);
    const nested: TextPlacement = { topLevel: false, avoid };
    const plain = textEntity('text/plain', body.text, body.html === null ? { topLevel, avoid } : nested);
    return body.html === null ? plain : multipart('multipart/alternative', [serialize(plain), serialize(textEntity('text/html', body.html, nested))]);
}
/** WildDuck completes a top-level message whose last line lacks its break. Authored
 * 7bit and quoted-printable top-level bodies already end in CRLF (or are empty, so
 * the header separator ends the message); only base64 still needs one here. */
function messageEnding(body: Chunks): Buffer { const last = body.findLast(chunk => chunk.length > 0); return last && !endsWithCrlf(last) ? CRLF : Buffer.alloc(0); }
/** RFC 2046 message/rfc822 permits only identity encodings. Preserve supplied
 * file bytes; reject bare LF because Wildduck would normalize it on ingestion. */
function messageEncoding(bytes: Uint8Array): '7bit' | '8bit' | 'binary' {
    let previous = -1, lineLength = 0, binary = false, eightBit = false;
    for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index] ?? 0;
        if (previous === 13 && byte !== 10) { binary = true; }
        if (byte === 10) {
            requireMime(previous === 13, 'invalid_attachment');
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
/** The content headers of one attachment, written by the library. Read-back safety net, not
 * an encoder: libmime, which mailsplit uses, must read the caller's file name back from both
 * the Content-Disposition filename and the Content-Type name, plus the type, disposition and
 * Content-ID. */
function attachmentHeaders(filename: string, contentType: string, disposition: 'attachment' | 'inline', transferEncoding: string, cid: string | undefined): Header[] {
    const node = new Builder(contentType, { filename, disableFileAccess: true, disableUrlAccess: true });
    node.setHeader('Content-Disposition', disposition);
    node.setHeader('Content-Transfer-Encoding', transferEncoding);
    if (cid) {node.setHeader('Content-ID', `<${cid}>`);}
    const rawHeaders = Buffer.from(node.buildHeaders() + '\r\n\r\n');
    const headers = headersAt(rawHeaders, 0, rawHeaders.length).headers.filter(header => header.key.startsWith('content-'));
    const value = (key: string) => headers.find(header => header.key === key)?.value ?? '';
    const type = libmime.parseHeaderValue(value('content-type')), placement = libmime.parseHeaderValue(value('content-disposition'));
    requireMime(headers.length === (cid ? 4 : 3) && type.value === contentType && placement.value === disposition && (cid === undefined || value('content-id') === `<${cid}>`)
        && libmime.decodeWords(placement.params.filename ?? '') === filename && libmime.decodeWords(type.params.name ?? '') === filename, 'invalid_mime_patch');
    return headers;
}
/** Every new attachment's rules first, its sizes included, and only then any encoding: `fixedBytes`
 * (what the message holds besides these attachments, at least) plus every encoded body must fit
 * MAX_MESSAGE_BYTES, so an oversized request fails before a single file is base64-encoded. The
 * exact cap is applied again to the finished message (prepared). */
function attachmentEntities(attachments: readonly MimeAttachment[], fixedBytes: number): { inline: Chunks[]; regular: Chunks[]; cids: string[] } {
    requireMime(attachments.length <= MIME_LIMITS.nodes, 'invalid_mime_patch');
    const result: { inline: Chunks[]; regular: Chunks[]; cids: string[] } = { inline: [], regular: [], cids: [] };
    let total = fixedBytes;
    for (const attachment of attachments) {
        safeText(attachment.filename, AUTHORED_LIMITS.filenameBytes); requireMime(attachment.filename.length > 0, 'invalid_mime_patch');
        safeText(attachment.contentType, AUTHORED_LIMITS.contentTypeBytes);
        const contentType = attachment.contentType.toLowerCase();
        // Multipart needs a boundary, and other message subtypes have subtype-specific
        // syntax/encoding rules. Only rfc822 has an explicit new-part implementation;
        // existing parts stay opaque.
        requireMime(ATTACHMENT_MEDIA.test(contentType), 'invalid_mime_patch');
        requireMime(attachment.disposition === 'inline' || attachment.disposition === 'attachment', 'invalid_mime_patch');
        requireMime(!(attachment.disposition === 'inline' && AMBIGUOUS_INLINE.test(contentType)), 'invalid_mime_patch');
        requireMime(attachment.bytes instanceof Uint8Array, 'invalid_mime_patch');
        total += attachmentBodyBytes(attachment.bytes.byteLength, contentType);
        requireMime(total <= MIME_LIMITS.messageBytes, 'mime_limit');
        requireMime(attachment.disposition !== 'inline' || attachment.cid, 'invalid_mime_patch');
        if (attachment.cid !== undefined) {
            safeText(attachment.cid, AUTHORED_LIMITS.cidBytes);
            requireMime(CONTENT_ID.test(attachment.cid), 'invalid_mime_patch');
            requireMime(!result.cids.includes(attachment.cid), 'invalid_mime_patch'); result.cids.push(attachment.cid);
        }
    }
    for (const attachment of attachments) {
        const contentType = attachment.contentType.toLowerCase();
        const isMessage = contentType === 'message/rfc822';
        const transferEncoding = isMessage ? messageEncoding(attachment.bytes) : 'base64';
        const headers = attachmentHeaders(attachment.filename, contentType, attachment.disposition, transferEncoding, attachment.cid);
        // The bytes themselves go into the chunks (a view, not a copy) until the message is joined.
        const part: Chunks = [Buffer.concat(headers.map(header => header.raw)), CRLF, ...isMessage ? [view(attachment.bytes)] : encoded(attachment.bytes)];
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
/** A rendered part's first chunk always holds its whole header block (see preparePatch's render). */
function leadingHeaders(chunks: Chunks): { first: Buffer; headers: Header[]; bodyStart: number } {
    const first = required(chunks[0]); return { first, ...headersAt(first, 0, first.length) };
}
function chunksEndWithCrlf(chunks: Chunks): boolean {
    const bytes: number[] = [];
    for (let index = chunks.length - 1; index >= 0 && bytes.length < 2; index--) { const chunk = required(chunks[index]); for (let at = chunk.length - 1; at >= 0 && bytes.length < 2; at--) { bytes.unshift(required(chunk[at])); } }
    return bytes[0] === 13 && bytes[1] === 10;
}
function contentEntity(source: Source, part: Part, full: Chunks): Chunks {
    if (part !== source.root) {return full;}
    const { first, headers, bodyStart } = leadingHeaders(full);
    return [Buffer.concat([...headers.filter(header => header.key.startsWith('content-')).map(header => header.raw), CRLF]), first.subarray(bodyStart), ...full.slice(1)];
}
/** `raw` is this module's own freshly joined output, so it is inspected and exposed without a copy. */
async function prepared(raw: Buffer, retained: readonly MimePartProof[]): Promise<PreparedMime> {
    requireMime(raw.length <= MIME_LIMITS.messageBytes, 'mime_limit');
    const inspected = await inspect(raw);
    // Multiset verification, so equal retained attachments must occur equally often.
    const available = new Map<string, number>();
    for (const part of inspected.attachments) {available.set(part.rawSha256, (available.get(part.rawSha256) ?? 0) + 1);}
    for (const part of retained) {
        const count = available.get(part.rawSha256) ?? 0; requireMime(count > 0, 'mime_verification_failed');
        available.set(part.rawSha256, count - 1);
    }
    const result: PreparedMime = Object.freeze({ raw, sha256: inspected.sha256, envelope: inspected.envelope, retainedAttachments: Object.freeze([...retained]) });
    preparations.set(result, inspected.sha256); return result;
}
/** Bytes of the attachment parts an update keeps (all but deleteAttachmentIds): a lower bound on
 * the patched message, so new attachments can be budgeted before their bytes are fetched. Unbound
 * ids fail as preparePatch would. */
export function retainedAttachmentBytes(inspected: InspectedMime, deleteAttachmentIds: readonly string[] = []): number {
    const source = inspections.get(inspected); requireMime(source, 'invalid_mime_patch');
    const removed = new Set(deleteAttachmentIds.map(id => { const part = source.bindings.get(id); requireMime(part, 'invalid_mime_patch'); return part; }));
    return source.attachments.reduce((total, part) => removed.has(part) ? total : total + part.end - part.start, 0);
}

/** Omitted body/attachments are preserved. Only positively bound attachment IDs may be
 * removed. Patches never flatten an existing MIME tree or re-encode an opaque leaf. */
export async function preparePatch(inspected: InspectedMime, patch: MimePatch): Promise<PreparedMime> {
    const source = inspections.get(inspected); requireMime(source, 'invalid_mime_patch');
    const deletes = patch.deleteAttachmentIds ?? [];
    requireMime(new Set(deletes).size === deletes.length, 'invalid_mime_patch');
    const removed = new Set<Part>();
    for (const id of deletes) { const part = source.bindings.get(id); requireMime(part, 'invalid_mime_patch'); removed.add(part); }
    const retained = source.attachments.filter(part => !removed.has(part));
    const additions = attachmentEntities(patch.attachments ?? [], retained.reduce((total, part) => total + part.end - part.start, 0));
    // Identity-encoded .eml files can contain delimiter-looking lines. Before
    // appending into an existing tree, rule out collisions with all its boundaries
    // (chunk by chunk, which is exact: a boundary has no CR or LF; see Chunks).
    const pending = [source.root];
    const boundaries: string[] = [];
    for (const part of pending) {
        if (part.boundary) { boundaries.push(part.boundary); }
        pending.push(...part.children);
    }
    for (const addition of [...additions.inline, ...additions.regular]) {
        requireMime(boundaries.every(boundary => addition.every(chunk => !chunk.includes(boundary))), 'invalid_mime_patch');
    }
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
    let related: Part | undefined;
    for (let current = source.core.parent; current; current = current.parent) {if (current.type === 'multipart/related') { related = current; break; }}
    // A replacement body ends the message only when it replaces the root and no
    // added attachment wraps it. Visible text bodies must not contain a delimiter
    // line of any retained multipart.
    const wrapsCore = additions.inline.length > 0 && !related;
    const topLevel = source.core === source.root && !additions.inline.length && !additions.regular.length;
    let replacement: Entity | undefined;
    if (patch.body !== undefined) { bodyChangeSafe(source.core); replacement = bodyEntity(patch.body, topLevel, boundaries.map(boundary => Buffer.from('--' + boundary))); }
    const headerChanges: Record<string, string | MimeAddress | readonly MimeAddress[]> = {};
    if (patch.from !== undefined) {headerChanges.From = patch.from;}
    if (patch.replyTo !== undefined) {headerChanges['Reply-To'] = patch.replyTo;}
    if (patch.to !== undefined) {headerChanges.To = patch.to;}
    if (patch.cc !== undefined) {headerChanges.Cc = patch.cc;}
    if (patch.bcc !== undefined) {headerChanges.Bcc = patch.bcc;}
    if (patch.subject !== undefined) {headerChanges.Subject = patch.subject;}
    const updates = generatedHeaders(headerChanges);
    if (!get(source.root, 'mime-version') && (replacement || deletes.length || patch.attachments?.length)) {updates.set('mime-version', Buffer.from('MIME-Version: 1.0\r\n'));}
    // A rendered part is a list of chunks (see Chunks), joined once for the whole message. Its
    // first chunk always holds the part's whole header block: retained bytes start at part.start
    // and run at least to its first child, and every new or patched header block is one chunk.
    const render = (part: Part): Chunks => {
        let entity: Entity | undefined;
        if (part === source.core && replacement) {entity = replacement;}
        let chunks: Buffer[];
        if (entity) {
            // WildDuck completes the last line of top-level messages on ingestion.
            // Author that CRLF now so exact read-back verification agrees. Nested
            // entities (including a root wrapped by new attachments) use their
            // enclosing delimiter's CRLF; retained bytes and omitted bodies must
            // remain untouched.
            chunks = [mergeEntityHeaders(part, entity), ...entity.body, topLevel ? messageEnding(entity.body) : Buffer.alloc(0)];
        }
        else if (part.children.length) {
            chunks = [];
            let offset = part.start;
            for (const child of part.children) {
                if (removed.has(child)) { chunks.push(source.raw.subarray(offset, child.segmentStart)); offset = required(child.segmentEnd); continue; }
                const rendered = render(child);
                chunks.push(source.raw.subarray(offset, child.start), ...rendered);
                // For an empty original body the header separator itself can supply
                // the CRLF before the delimiter. A replacement body needs its own,
                // even when its visible text already ends with a line break.
                const textBody = child === source.core && !wrapsCore && replacement?.type.startsWith('text/') === true && chunksBytes(replacement.body) > 0;
                if (child.end === child.segmentEnd && (textBody || !chunksEndWithCrlf(rendered))) { chunks.push(CRLF); }
                offset = child.end;
            }
            const append = part === related ? additions.inline : part === source.root && part.type === 'multipart/mixed' ? additions.regular : [];
            if (append.length) {
                chunks.push(source.raw.subarray(offset, part.closeStart));
                chunks.push(...append.flatMap(item => [Buffer.from(`--${part.boundary}\r\n`), ...item, CRLF])); offset = required(part.closeStart);
            }
            chunks.push(source.raw.subarray(offset, part.end));
            // The related type describes its first child. If that child changed from
            // text to alternative (or back), the parameter must change with it.
            if (part.type === 'multipart/related' && part.params.type && part.children[0] === source.core && replacement && part.params.type.toLowerCase() !== replacement.type) {
                const newType = get(part, 'content-type').replace(/(\btype\s*=\s*)(?:"(?:[^"\\]|\\.)*"|[^;\s]+)/iu, `$1"${replacement.type}"`);
                chunks = [patchHeaders(part.headers, generatedHeaders({ 'Content-Type': newType })), required(chunks[0]).subarray(part.bodyStart - part.start), ...chunks.slice(1)];
            }
        } else {chunks = [source.raw.subarray(part.start, part.end)];}
        if (part === source.core && additions.inline.length && !related) {
            const wrapper = multipart('multipart/related', [contentEntity(source, part, chunks), ...additions.inline]);
            const outerHeaders = part === source.root ? Buffer.concat([...part.headers.filter(header => !header.key.startsWith('content-')).map(header => header.raw), wrapper.headers]) : wrapper.headers;
            chunks = [outerHeaders, ...wrapper.body];
        }
        if (part === source.root) {
            if (additions.regular.length && part.type !== 'multipart/mixed') {
                const wrapper = multipart('multipart/mixed', [contentEntity(source, part, chunks), ...additions.regular]);
                const current = leadingHeaders(chunks);
                chunks = [Buffer.concat([...current.headers.filter(header => !header.key.startsWith('content-')).map(header => header.raw), wrapper.headers]), ...wrapper.body];
            }
            const current = leadingHeaders(chunks);
            chunks = [patchHeaders(current.headers, updates), current.first.subarray(current.bodyStart), ...chunks.slice(1)];
        }
        return chunks;
    };
    const raw = Buffer.concat(render(source.root));
    if (!replacement && !deletes.length && !(patch.attachments?.length)) {requireMime(raw.subarray(headersAt(raw, 0, raw.length).bodyStart).equals(source.raw.subarray(source.root.bodyStart)), 'mime_verification_failed');}
    return prepared(raw, retained.map(part => proof(source, part)));
}

/** New mail uses only caller bytes/strings; no URL, filesystem or remote asset access. */
export async function createMime(input: MimeCreate): Promise<PreparedMime> {
    requireMime(!(input.deleteAttachmentIds?.length), 'invalid_mime_patch');
    let entity = bodyEntity(input.body, !(input.attachments?.length));
    const additions = attachmentEntities(input.attachments ?? [], entity.headers.length + chunksBytes(entity.body));
    if (additions.inline.length) {entity = multipart('multipart/related', [serialize(entity), ...additions.inline]);}
    if (additions.regular.length) {entity = multipart('multipart/mixed', [serialize(entity), ...additions.regular]);}
    if (input.threading !== undefined) { validateThreading(input.threading); }
    const generated = generatedHeaders({ From: input.from, To: input.to, Cc: input.cc, Bcc: input.bcc, Subject: input.subject, ...(input.replyTo ? { 'Reply-To': input.replyTo } : {}),
        ...(input.threading ? { 'In-Reply-To': input.threading.inReplyTo, References: input.threading.references.join(' ') } : {}) });
    // Match WildDuck's UUID@sender-domain convention. From has passed the MIME
    // address gate above; backend callers also verify ownership before creation.
    const messageId = `<${randomUUID()}@${input.from.address.slice(input.from.address.lastIndexOf('@') + 1).toLowerCase()}>`;
    validateMessageId(messageId);
    const root = builder(); root.setHeader('Date', new Date()); root.setHeader('Message-ID', messageId); root.setHeader('MIME-Version', '1.0');
    const required = Buffer.from(root.buildHeaders() + '\r\n\r\n');
    const metadata = headersAt(required, 0, required.length).headers.filter(header => ['date', 'message-id', 'mime-version'].includes(header.key));
    // The one join of the whole message (see Chunks).
    const raw = Buffer.concat([...metadata.map(header => header.raw), ...[...generated.values()].filter((value): value is Buffer => value !== null), entity.headers, ...entity.body, messageEnding(entity.body)]);
    return prepared(raw, []);
}

/** Verification is exact, including MIME headers, encoded attachments, preamble and
 * tail bytes. The private digest of the prepared raw also detects mutation of prepared.raw. */
export function verifyCandidate(expected: PreparedMime, actualRaw: Uint8Array): void {
    const digest = preparations.get(expected);
    requireMime(digest !== undefined && actualRaw instanceof Uint8Array && actualRaw.byteLength === expected.raw.length && hash(expected.raw) === digest && expected.raw.equals(view(actualRaw)), 'mime_verification_failed');
}
