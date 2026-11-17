/** Test support: read back what src/mail/mime.ts authored in address, attachment and
 * Content-ID headers with independent maintained parsers (nodemailer's address parser,
 * libmime and mailsplit), exactly as WildDuck and mail clients interpret the bytes. */
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Splitter, type MimeNode } from '@zone-eu/mailsplit';
import AddressParser from 'nodemailer/lib/addressparser';
import libmime from 'libmime';

/** xorshift32: exact 32-bit integer arithmetic, nonzero seed. */
export function xorshift(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state = (state ^ (state << 13)) >>> 0;
        state = (state ^ (state >>> 17)) >>> 0;
        state = (state ^ (state << 5)) >>> 0;
        return state;
    };
}

/** Raw lines of one root header field (continuation lines included), CRLF-terminated. */
export function rootHeaderLines(raw: Buffer, key: string): string[] {
    const head = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1').split('\r\n');
    const lines: string[] = [];
    let inside = false;
    for (const line of head) {
        if (/^[ \t]/u.test(line)) { if (inside) { lines.push(line); } continue; }
        inside = line.toLowerCase().startsWith(key.toLowerCase() + ':');
        if (inside) { lines.push(line); }
    }
    return lines;
}
/** RFC 5322 unfolding (remove CRLF before folding whitespace) of the value after "Key:". */
export function unfold(lines: readonly string[]): string { return lines.join('').slice(lines[0]?.indexOf(':') === undefined ? 0 : lines[0].indexOf(':') + 1).replace(/^ /u, ''); }
/** Addresses of one root header as a reader decodes them: parse, then decode encoded-words. */
export function decodedAddresses(raw: Buffer, key: string): { address: string; name: string }[] {
    const lines = rootHeaderLines(raw, key);
    if (lines.length === 0) { return []; }
    return AddressParser(unfold(lines)).map(entry => ({ address: entry.address ?? '', name: libmime.decodeWords(entry.name ?? '') }));
}
export interface PartView { readonly contentType: string; readonly disposition: string; readonly filename: string; readonly contentId: string; readonly headerLines: readonly string[] }
/** Every MIME node as mailsplit reports it (its filename is libmime's, with encoded-words decoded). */
export async function partViews(raw: Buffer): Promise<PartView[]> {
    const nodes: MimeNode[] = [];
    const splitter = new Splitter({ ignoreEmbedded: true });
    const sink = new Writable({ objectMode: true, write(chunk: { type: string }, _encoding, callback) { if (chunk.type === 'node') { nodes.push(chunk as MimeNode); } callback(); } });
    await pipeline(Readable.from([raw]), splitter, sink);
    return nodes.map(node => ({
        contentType: node.contentType || '', disposition: node.disposition || '', filename: node.filename || '',
        contentId: node.headers ? node.headers.getFirst('content-id') : '',
        headerLines: node.getHeaders().toString('latin1').split('\r\n').filter(line => line !== ''),
    }));
}
/** What an RFC 2231/5987-only reader sees: the Content-Disposition filename without any
 * encoded-word decoding, and the Content-Type name parameter likewise. */
export function rawParameters(view: PartView): { filename: string; name: string } {
    const unfolded = view.headerLines.join('\r\n').replace(/\r\n(?=[ \t])/gu, '');
    const find = (key: string) => unfolded.split('\r\n').find(line => line.toLowerCase().startsWith(key + ':')) ?? '';
    const parameters = (line: string) => libmime.parseHeaderValue(line.slice(line.indexOf(':') + 1)).params;
    return { filename: parameters(find('content-disposition')).filename ?? '', name: parameters(find('content-type')).name ?? '' };
}
export function maxLineLength(lines: readonly string[]): number { return Math.max(0, ...lines.map(line => line.length)); }
