/** Test support: strict decoding of the text/plain and text/html parts that
 * src/mail/mime.ts authors, by their declared Content-Transfer-Encoding. */
export type TextEncoding = '7bit' | 'quoted-printable' | 'base64';
export interface AuthoredPart { readonly type: 'text/plain' | 'text/html'; readonly encoding: TextEncoding; readonly encoded: Buffer; readonly text: string }

/** Strict RFC 2045 decoding of one transfer-encoded body. Quoted-printable must use
 * CRLF lines of at most 76 characters, uppercase "=XX" escapes, encoded trailing
 * whitespace and printable ASCII; 7bit must be printable ASCII lines of at most 76. */
export function decodeTransfer(encoding: TextEncoding, body: Buffer): Buffer {
    if (encoding === 'base64') {
        const compact = body.toString('latin1').replaceAll('\r\n', '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) { throw new Error('invalid base64'); }
        return Buffer.from(compact, 'base64');
    }
    const text = body.toString('latin1');
    const lines = text.split('\r\n');
    if (lines.some(line => line.length > 76 || /[\r\n]/u.test(line) || /[^\t\x20-\x7e]/u.test(line))) { throw new Error(`invalid ${encoding} line`); }
    if (encoding === '7bit') { return body; }
    const out: number[] = [];
    for (const [index, line] of lines.entries()) {
        if (/[ \t]$/u.test(line)) { throw new Error('unencoded trailing whitespace'); }
        let soft = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i] ?? '';
            if (char !== '=') { out.push(char.charCodeAt(0)); continue; }
            // A soft break is "=" immediately followed by CRLF, so never on the last line.
            if (i === line.length - 1) {
                if (index === lines.length - 1) { throw new Error('dangling "=" without CRLF'); }
                soft = true; break;
            }
            const hex = line.slice(i + 1, i + 3);
            if (!/^[0-9A-F]{2}$/u.test(hex)) { throw new Error('invalid escape'); }
            out.push(Number.parseInt(hex, 16)); i += 2;
        }
        if (!soft && index < lines.length - 1) { out.push(13, 10); }
    }
    return Buffer.from(out);
}

/** Every authored text part in document order. A part's encoded body runs to the
 * CRLF before the next delimiter of any multipart in the message, or to the end of
 * the message for a single-part message (the final CRLF included, as a reader sees). */
export function authoredParts(raw: Buffer): AuthoredPart[] {
    const source = raw.toString('latin1');
    const boundaries = [...source.matchAll(/boundary=(?:"([^"]+)"|([^\s;"]+))/gu)].map(match => match[1] ?? match[2] ?? '');
    const pattern = /Content-Type: (text\/plain|text\/html); charset=utf-8\r\nContent-Transfer-Encoding: (7bit|quoted-printable|base64)\r\n\r\n/gu;
    return [...source.matchAll(pattern)].map(match => {
        const start = (match.index ?? 0) + match[0].length;
        const ends = boundaries.map(boundary => source.indexOf('\r\n--' + boundary, start - 2)).filter(index => index >= start - 2);
        const end = ends.length ? Math.max(start, Math.min(...ends)) : source.length;
        const encoding = match[2] as TextEncoding;
        const encoded = raw.subarray(start, end);
        return { type: match[1] as AuthoredPart['type'], encoding, encoded, text: decodeTransfer(encoding, encoded).toString('utf8') };
    });
}

/** Decoded contents of the authored parts of one type. */
export function authoredText(raw: Buffer, type: 'text/plain' | 'text/html'): string[] {
    return authoredParts(raw).filter(part => part.type === type).map(part => part.text);
}
