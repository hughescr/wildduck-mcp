import { MimeError, validateMessageId, validateThreading, validateMimeAddresses, validateMimeBody, type MimeAddress, type MimeBody, type MimeThreading } from './mime';

/** Request-local projection of a freshly inspected message. Backend identity,
 * ownership, version and operation replay checks belong to the existing pipeline. */
export interface ReplyOriginal {
    readonly from: readonly MimeAddress[];
    readonly replyTo: readonly MimeAddress[];
    readonly to: readonly MimeAddress[];
    readonly cc: readonly MimeAddress[];
    readonly subject: string;
    readonly messageId: string | null;
    readonly references: readonly string[];
    readonly text: string;
    readonly textTruncated: boolean;
}
export interface ReplyRecipients { readonly to: readonly MimeAddress[]; readonly cc: readonly MimeAddress[] }
export interface ReplyInput {
    readonly original: ReplyOriginal;
    readonly ownedAddresses: readonly string[];
    readonly mode: 'reply' | 'reply_all';
    readonly body: MimeBody;
    readonly quoteOriginal?: boolean | undefined;
    /** Replaces BOTH derived lists, retaining explicitly requested owned recipients. */
    readonly recipients?: ReplyRecipients | undefined;
}
export interface DerivedReply extends ReplyRecipients {
    readonly bcc: readonly MimeAddress[];
    readonly subject: string;
    readonly body: MimeBody;
    readonly threading: MimeThreading;
}
function invalid(): never { throw new MimeError('invalid_mime_patch'); }
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
const addressKey = (address: MimeAddress) => address.address.toLowerCase();

/** Derive only allowlisted reply metadata. Incoming HTML, attachments, Bcc and
 * hidden envelopes are never copied. This helper performs no I/O or writes. */
export function deriveReply(input: ReplyInput): DerivedReply {
    const { original } = input;
    if (input.mode !== 'reply' && input.mode !== 'reply_all' || input.quoteOriginal !== undefined && typeof input.quoteOriginal !== 'boolean') { invalid(); }
    if (original.messageId === null) { invalid(); }
    validateMessageId(original.messageId);
    if (!Array.isArray(original.references) || original.references.length > 100) { invalid(); }
    for (const id of original.references) { validateMessageId(id); }
    const threading = { inReplyTo: original.messageId, references: [...new Set(original.references.filter(id => id !== original.messageId)), original.messageId] };
    validateThreading(threading);
    if (typeof original.subject !== 'string' || !original.subject.isWellFormed()) { invalid(); }
    for (const character of original.subject) {
        const code = character.charCodeAt(0);
        if (code < 32 || code === 127) { invalid(); }
    }
    const subject = /^re:/iu.test(original.subject) ? original.subject : 'Re: ' + original.subject;
    if (Buffer.byteLength(subject) > 2048) { invalid(); }

    let to: readonly MimeAddress[], cc: readonly MimeAddress[];
    if (input.recipients !== undefined) {
        ({ to, cc } = input.recipients);
    } else {
        const target = original.replyTo.length ? original.replyTo : original.from;
        to = input.mode === 'reply_all' ? [...target, ...original.to] : target;
        cc = input.mode === 'reply_all' ? original.cc : [];
    }
    validateMimeAddresses(to); validateMimeAddresses(cc);
    // Lowercase keys deliberately prevent duplicate delivery across differently
    // cased mailbox spellings. Never infer alias equivalence from plus/dot syntax.
    const excluded = new Set<string>();
    if (input.recipients === undefined) {
        const identities = [...new Set(input.ownedAddresses.map(address => address.toLowerCase()))];
        if (!identities.length || identities.length > 1000) { invalid(); }
        // Account aliases have their own bound; the 100-recipient MIME bound
        // applies only to outgoing delivery. Validate identities in bounded batches.
        for (let offset = 0; offset < identities.length; offset += 100) {
            validateMimeAddresses(identities.slice(offset, offset + 100).map(address => ({ address })));
        }
        for (const address of identities) { excluded.add(address); }
    }
    const select = (values: readonly MimeAddress[]) => values.filter(value => {
        const key = addressKey(value);
        if (excluded.has(key)) { return false; }
        excluded.add(key); return true;
    }).map(value => ({ ...value }));
    const recipients = { to: select(to), cc: select(cc) };
    // Continuing our own sent message should address its visible external To
    // recipients. An external Reply-To always wins over this sent-mail fallback.
    if (input.recipients === undefined && input.mode === 'reply' && to.length > 0 && recipients.to.length === 0) {
        validateMimeAddresses(original.to);
        recipients.to = select(original.to);
    }
    if (recipients.to.length + recipients.cc.length === 0 || recipients.to.length + recipients.cc.length > 100) { invalid(); }

    validateMimeBody(input.body);
    let body = { ...input.body };
    if (input.quoteOriginal) {
        if (original.textTruncated !== false || typeof original.text !== 'string' || !original.text.isWellFormed()) { invalid(); }
        const normalized = original.text.replace(/\r\n|\r/gu, '\n');
        const quote = normalized.split('\n').map(line => '> ' + line).join('\n');
        body = { text: body.text + '\n\n' + quote, html: body.html === null ? null : body.html + '<blockquote><pre>' + escapeHtml(normalized) + '</pre></blockquote>' };
        validateMimeBody(body);
    }
    return { ...recipients, bcc: [], subject, body, threading };
}
