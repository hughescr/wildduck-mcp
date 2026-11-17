import { z } from 'zod';
import { isEmailValid } from '@hapi/address';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { ATTACHMENT_MEDIA, AMBIGUOUS_INLINE, AUTHORED_LIMITS, CONTENT_ID, EMAIL, hasAttachmentReference, hasBareLineFeed } from './mime';
import { MARKDOWN_FLAVOR } from './render';
export const MAX_PAGE_SIZE = 50;
export const MAX_BATCH_MESSAGES = 10;
export const MAX_BATCH_BYTES = 1024 * 1024;
export const BATCH_CONCURRENCY = 3;
export const MAX_SNIPPET_BYTES = 512;
export const MAX_DRAFT_TEXT_BYTES = 128 * 1024;
export const MAX_READ_TEXT_BYTES = 128 * 1024;
export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SUBJECT_BYTES = AUTHORED_LIMITS.subjectBytes;
export const MAX_SEARCH_TEXT_CHARACTERS = 255;
const utf8 = (maximum: number) => (value: string) => Buffer.byteLength(value, 'utf8') <= maximum;
const noHeaderControls = (value: string) => !/[\r\n\0]/u.test(value);
const nonblank = (value: string) => value.trim().length > 0;
const boundedText = (maximum: number) => z.string().max(maximum).refine(utf8(maximum), `At most ${maximum} UTF-8 bytes.`);
// Query filters (search_messages) are not authored headers and keep this weaker rule.
const headerText = (maximum: number) => boundedText(maximum).refine(noHeaderControls, 'CR, LF and NUL are forbidden.');
// Subjects, display names and filenames are written by the mail library (nodemailer), which
// encodes any other text as needed. Up front the schema refuses what the library cannot carry
// (C0 controls, DEL, unpaired surrogates) and a literal "=?", which readers would decode as an
// RFC 2047 encoded-word into different text.
const noC0Controls = (value: string) => { for (const char of value) { const code = char.charCodeAt(0); if (code < 32 || code === 127) { return false; } } return true; };
const wellFormed = (value: string) => value.isWellFormed();
const UNPAIRED_SURROGATE = 'Unpaired UTF-16 surrogates are forbidden.';
const authoredText = (maximum: number) => boundedText(maximum).refine(noC0Controls, { message: 'Control characters are forbidden.', abort: true }).refine(wellFormed, UNPAIRED_SURROGATE).refine(value => !value.includes('=?'), 'The sequence "=?" is not supported in this field.');
/** Leading and trailing whitespace trimmed and every internal run collapsed to one space: WildDuck
 * and mail clients trim these fields and unfold a folded header with one space per fold, so this
 * is the value every reader shows. Applied by the schema, so it is what is authored and digested. */
export const normalizeHeaderText = (value: string) => value.trim().replace(/\s+/gu, ' ');
/** The library writes a plain ASCII Subject unencoded and never breaks a word, so a word must fit
 * one header line (998 characters, measured: "Subject:" CRLF " " word). */
export const MAX_SUBJECT_WORD = 900;
const LONG_SUBJECT_WORD = new RegExp(`[!-~]{${MAX_SUBJECT_WORD + 1}}`, 'u');
const subjectText = (maximum: number) => authoredText(maximum).refine(value => !LONG_SUBJECT_WORD.test(value), `Subject words longer than ${MAX_SUBJECT_WORD} characters are not supported.`).transform(normalizeHeaderText);
const displayName = authoredText(AUTHORED_LIMITS.nameBytes).transform(normalizeHeaderText);
// WildDuck trims file names when it lists attachments, so edge whitespace would not read back,
// and the library may fold a long name inside a whitespace run, which readers unfold to one space.
const filenameText = authoredText(AUTHORED_LIMITS.filenameBytes).min(1).refine(value => !/^\s|\s$/u.test(value), 'File names must not start or end with whitespace.')
    .refine(value => !/\s\s/u.test(value), 'File names must not contain repeated whitespace.');
// Body text has no control-character rule (line breaks and tabs are content), only encodability.
const bodyText = (maximum: number) => boundedText(maximum).refine(wellFormed, UNPAIRED_SURROGATE);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const overlaps = (left: readonly string[], right: readonly string[]) => { const rightSet = new Set(right); return left.some(value => rightSet.has(value)); };
export const mailboxIdSchema = z.string().regex(/^[a-f0-9]{24}$/u);
export const uidSchema = z.number().int().min(1).max(4294967295);
export const attachmentIdSchema = z.string().max(64).regex(/^ATT\d+$/u).describe('Attachment id (ATT followed by digits) from the attachments list of read_message.');
export const versionSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).describe('Version of the message as returned. Pass it as expectedVersion to change this message; any change to the message gives it a new version.');
export const operationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u).describe('New unique id you choose for this action (16-128 letters, digits, - or _; a UUID works). Reuse it only to retry this identical request.');
const digestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const contentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u).describe('SHA-256 of the message source as checked by this server.');
const cursorSchema = z.string().max(1024).refine(nonblank);
const paginationShape = { limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(20).describe('Messages per page, 1 to 50. Default 20.'), next: cursorSchema.optional().describe('The next value of the previous page, to get the following page. Do not combine with previous.'), previous: cursorSchema.optional().describe('The previous value of a page, to go back one page. Do not combine with next.') };
const singleDirection = (input: { next?: string | undefined; previous?: string | undefined }) => input.next === undefined || input.previous === undefined;
export const messageKeySchema = z.strictObject({ mailboxId: mailboxIdSchema.describe('Mailbox id from list_mailboxes.'), uid: uidSchema.describe('Message uid; uids are unique only within their mailbox.') });
export const messageRefSchema = messageKeySchema.extend({ version: versionSchema });
export const draftRefSchema = messageRefSchema;
// Pinned 5.1.1 accepts tlds:false at runtime (the existing API uses it),
// but its bundled declaration omits that boolean option. Keep the cast localized.
const apiEmailOptions = { tlds: false } as unknown as Parameters<typeof isEmailValid>[1];
// The pinned API validator, intersected with the ASCII grammar the MIME layer writes and reads.
const addressText = z.string().max(320).refine(noHeaderControls).refine(value => isEmailValid(value, apiEmailOptions), 'Address must satisfy the existing mail API recipient validator.')
    .refine(value => EMAIL.test(value) && !value.includes('..'), 'Only ASCII email addresses are supported; write an internationalised domain in its xn-- form.');
/** A mailbox with its normalised name, or none: a name that normalises to nothing, or that equals
 * its address ignoring case, is dropped, since nodemailer's address parser (as WildDuck uses it)
 * reads a name equal to the address as no name. */
export function namedAddress(address: string, name: string | undefined): { address: string; name?: string } {
    return name && name.toLowerCase() !== address.toLowerCase() ? { address, name } : { address };
}
export const inputAddressSchema = z.strictObject({ address: addressText.describe('Email address, ASCII only; write an international domain in its xn-- form.'), name: displayName.optional().describe('Display name, optional. No control characters or "=?"; extra whitespace is collapsed.') })
    .transform(({ address, name }) => namedAddress(address, name));
// Malformed incoming MIME addresses remain untrusted data, not outbound validators.
export const outputAddressSchema = z.strictObject({ address: z.string(), name: z.string().optional() });
const recipientsSchema = z.array(inputAddressSchema).max(50);
export const MAX_MARKDOWN_BYTES = MAX_DRAFT_TEXT_BYTES;
// Each branch is strict with one required key, so the advertised JSON Schema
// (anyOf) itself says "exactly one". The server renders it before MIME composition.
export const draftBodySchema = z.union([
    z.strictObject({ markdown: bodyText(MAX_MARKDOWN_BYTES).describe(`Preferred. Sent as HTML plus a plain-text copy. Dialect: ${MARKDOWN_FLAVOR} Inline image: ![alt](cid:ID) with an inline attachment whose cid is ID.`) }),
    z.strictObject({ html: bodyText(MAX_HTML_BYTES).refine(value => !hasAttachmentReference(value), 'HTML must not use attachment:ATTn URLs in tag attributes; reference attached images as cid: URLs.').describe('HTML, sent with a generated plain-text copy. Inline image: src="cid:ID" with an inline attachment whose cid is ID.') }),
    z.strictObject({ text: bodyText(MAX_DRAFT_TEXT_BYTES).describe('Plain text only, no HTML part. Use it only for simple messages you send yourself: some mail apps lose its line breaks when a person edits the draft.') }),
], { error: 'Provide exactly one of body.markdown, body.html or body.text.' }).describe('Message body: exactly one of markdown (preferred), html or text.');
const base64Schema = z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && Buffer.from(value, 'base64').toString('base64') === value && Buffer.byteLength(value, 'base64') <= MAX_ATTACHMENT_BYTES, 'Canonical base64 of at most 2 MiB decoded bytes is required.');
// type/subtype only (case-insensitive; written lower case). multipart/* needs a boundary and other message/*
// subtypes have their own syntax, so only message/rfc822 is accepted of those.
const contentTypeSchema = z.string().max(AUTHORED_LIMITS.contentTypeBytes).regex(ATTACHMENT_MEDIA, 'Content type must be type/subtype without parameters; multipart/* and message/* other than message/rfc822 are not supported.');
// A Content-ID is a msg-id: letters, digits and the RFC 5322 atext punctuation, with "." and "@".
const cidSchema = z.string().min(1).max(AUTHORED_LIMITS.cidBytes).regex(CONTENT_ID, 'CID may contain only letters, digits and ! # $ % & \' * + - . / = ? ^ _ ` { | } ~ @.');
const attachmentFilenameSchema = filenameText.describe('File name shown to recipients. Any text except control characters, "=?", and leading, trailing or repeated whitespace.');
export const newAttachmentSchema = z.strictObject({ filename: attachmentFilenameSchema, contentType: contentTypeSchema.describe('Media type as type/subtype without parameters, e.g. application/pdf or image/png.'), contentBase64: base64Schema.describe('File content in standard padded base64.'), disposition: z.enum(['attachment', 'inline']).default('attachment').describe('attachment (default): a separate file. inline: an image shown in the body; requires cid.'), cid: cidSchema.optional().describe('Content id of an inline image, unique in this request; the body refers to it as cid:<cid>.') })
    .refine(value => value.disposition !== 'inline' || value.cid !== undefined, 'Inline attachments require a CID.')
    .refine(value => !(value.disposition === 'inline' && AMBIGUOUS_INLINE.test(value.contentType)), 'Inline text/plain and text/html attachments cannot be told from the body; use disposition attachment.')
    .refine(value => !(value.contentType.toLowerCase() === 'message/rfc822' && hasBareLineFeed(Buffer.from(value.contentBase64, 'base64'))), 'message/rfc822 content must use CRLF line endings.');
const newAttachmentsSchema = z.array(newAttachmentSchema).max(100).refine(values => values.reduce((sum, item) => sum + Buffer.byteLength(item.contentBase64, 'base64'), 0) <= MAX_ATTACHMENT_BYTES, 'Combined decoded attachments must not exceed 2 MiB.').refine(values => unique(values.flatMap(item => item.cid === undefined ? [] : [item.cid])), 'Attachment CIDs must be unique.');
const draftFields = { from: inputAddressSchema.optional().describe('Sender; must be one of the account\'s own addresses. Default: the account\'s primary address.'), replyTo: recipientsSchema.optional().describe('Reply-To addresses. Default none.'), to: recipientsSchema.default([]).describe('To recipients, up to 50. Default none; send_draft needs at least one recipient in to, cc or bcc.'), cc: recipientsSchema.default([]).describe('Cc recipients, up to 50. Default none.'), bcc: recipientsSchema.default([]).describe('Bcc recipients, up to 50. Default none. At most 100 recipients in total.'), subject: subjectText(MAX_SUBJECT_BYTES).describe('Subject line; may be empty. Extra whitespace is collapsed.'), body: draftBodySchema, attachments: newAttachmentsSchema.default([]).describe('Files to attach, at most 2 MiB decoded in total. Default none.') };
export const draftContentSchema = z.strictObject(draftFields).refine(value => value.to.length + value.cc.length + value.bcc.length <= 100, 'At most 100 recipients in total.');
const writeTargetShape = { uid: uidSchema.describe('uid of the message to change (for draft tools, its uid in the Drafts mailbox), from a list, read or earlier write result.'), expectedVersion: versionSchema.describe('Version from your latest read or write, checked just before the change: if different, version_conflict, nothing changed. Cannot stop another client\'s same-moment change.'), operationId: operationIdSchema };
export const listMailboxesInputSchema = z.strictObject({});
export const listMessagesInputSchema = z.strictObject({ mailboxId: mailboxIdSchema.describe('Mailbox to list, from list_mailboxes.'), ...paginationShape }).refine(singleDirection, 'Specify one cursor direction.');
const searchModeSchema = z.enum(['fast', 'exhaustive']);
const searchFilters = {
    mailboxId: mailboxIdSchema.optional().describe('Search only this mailbox (id from list_mailboxes). Default: the whole account.'),
    from: headerText(320).refine(nonblank).optional().describe('Text the From name or address contains, ignoring case.'),
    to: headerText(320).refine(nonblank).optional().describe('Text a To or Cc name or address contains, ignoring case. Bcc is not searched.'),
    subject: headerText(MAX_SUBJECT_BYTES).refine(nonblank).optional().describe('Text the subject contains, ignoring case.'),
    text: z.string().max(MAX_SEARCH_TEXT_CHARACTERS).refine(utf8(4 * MAX_SEARCH_TEXT_CHARACTERS)).refine(nonblank).optional().describe('Full-text search words (matches whole words, not fragments), at most 255 characters.'),
    receivedSince: z.iso.datetime({ offset: true }).optional().describe('Only messages received since this time, ISO 8601 with offset, e.g. 2026-01-31T00:00:00Z.'), receivedUntil: z.iso.datetime({ offset: true }).optional().describe('Only messages received until this time, ISO 8601 with offset.'),
    seen: z.boolean().optional().describe('true: only read messages. false: only unread messages.'), flagged: z.boolean().optional().describe('true: only flagged messages. false is not supported.'), hasAttachments: z.boolean().optional().describe('true: only messages with attachments. false is not supported.'),
};
export const searchMessagesInputSchema = z.strictObject({
    ...searchFilters, ...paginationShape,
    searchMode: searchModeSchema.default('fast').describe('fast (default) or exhaustive. With from, to or subject, fast can miss matches (see search.complete); exhaustive finds all but is slower. Start it without a cursor.'),
}).refine(singleDirection, 'Specify one cursor direction.').refine(value => Object.keys(searchFilters).some(key => value[key as keyof typeof searchFilters] !== undefined), 'At least one meaningful filter is required.').refine(value => value.receivedSince === undefined || value.receivedUntil === undefined || Date.parse(value.receivedSince) <= Date.parse(value.receivedUntil), 'receivedSince must not follow receivedUntil.');
export const threadIdSchema = mailboxIdSchema.describe('Conversation id shared by the messages of one thread; pass it to get_thread.');
export const getThreadInputSchema = z.strictObject({ message: messageKeySchema.optional().describe('Any message of the thread. Give this or threadId, not both.'), threadId: threadIdSchema.optional().describe('threadId from a message summary. Give this or message, not both.'), ...paginationShape, limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10).describe('Messages per page, 1 to 50. Default 10; at most 10 when includeBodies is true.'), includeBodies: z.boolean().default(false).describe('Also read every message of this page in full, as read_messages does. Requires limit 10 or less. Default false.') }).refine(value => !value.includeBodies || value.limit <= MAX_BATCH_MESSAGES, 'Body pages are capped at 10 messages.').refine(singleDirection, 'Specify one cursor direction.').refine(value => (value.message === undefined) !== (value.threadId === undefined), 'Specify exactly one message reference or threadId.');
const includeHtmlSchema = z.boolean().default(true).describe('Include the HTML body. Default true; false returns text only (smaller) and sets htmlOmitted to true.');
export const readMessagesInputSchema = z.strictObject({ includeHtml: includeHtmlSchema, messages: z.array(messageKeySchema).min(1).max(MAX_BATCH_MESSAGES).refine(values => unique(values.map(value => value.mailboxId + ':' + value.uid)), 'Duplicate message references are forbidden.').describe('1 to 10 different messages to read, in the order wanted.') });
export const readMessageInputSchema = messageKeySchema.extend({ includeHtml: includeHtmlSchema });
export const readAttachmentInputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema });
export const getAttachmentDownloadInputSchema = readAttachmentInputSchema;
export const createReplyDraftInputSchema = z.strictObject({ original: messageKeySchema.describe('The message to reply to.'), mode: z.enum(['reply', 'reply_all']).default('reply').describe('reply (default): to Reply-To or From; if that is you, to the original To recipients. reply_all: also the original To and Cc. Your own addresses are left out.'), body: draftBodySchema.describe('Your reply text: exactly one of markdown (preferred), html or text. The original is not included unless quoteOriginal is true.'), quoteOriginal: z.boolean().default(false).describe('Append the original message\'s plain text below your body as a > quote. Default false. Fails if the original text is too long to quote in full.'), from: inputAddressSchema.optional().describe('Sender; must be one of your own addresses. Default: the address the original was sent to, else your primary address (normally this, for your own sent mail).'), to: recipientsSchema.optional().describe('Use exactly these To recipients. Giving to or cc replaces both automatic lists; the one you omit is empty.'), cc: recipientsSchema.optional().describe('Use exactly these Cc recipients. Giving to or cc replaces both automatic lists; the one you omit is empty.'), attachments: newAttachmentsSchema.default([]).describe('Files to attach, at most 2 MiB decoded in total; the original\'s attachments are never included. Default none.'), operationId: operationIdSchema }).refine(value => (value.to?.length ?? 0) + (value.cc?.length ?? 0) <= 100, 'At most 100 explicit recipients.');
export const createDraftInputSchema = draftContentSchema.safeExtend({ operationId: operationIdSchema });
const patchFields = { from: inputAddressSchema.optional().describe('New sender, one of the account\'s own addresses. Omit to keep the current one.'), replyTo: recipientsSchema.optional().describe('New Reply-To list, replacing the current one; [] removes it. Omit to keep.'), to: recipientsSchema.optional().describe('New To list, replacing the current one; [] removes all. Omit to keep.'), cc: recipientsSchema.optional().describe('New Cc list, replacing the current one; [] removes all. Omit to keep.'), bcc: recipientsSchema.optional().describe('New Bcc list, replacing the current one; [] removes all. Omit to keep.'), subject: subjectText(MAX_SUBJECT_BYTES).optional().describe('New subject. Omit to keep the current one.'), body: draftBodySchema.optional().describe('New body replacing the whole current body, in any one of markdown (preferred), html or text. Omit to keep the body.'), deleteAttachmentIds: z.array(attachmentIdSchema).max(100).refine(unique).optional().describe('Ids of current attachments to remove, from read_message. Other attachments are kept.'), attachments: newAttachmentsSchema.optional().describe('Files to add, at most 2 MiB decoded in total. Current attachments are kept.') };
export const updateDraftInputSchema = z.strictObject({ ...writeTargetShape, ...patchFields }).refine(value => Object.keys(patchFields).some(key => { const field = value[key as keyof typeof patchFields]; return Array.isArray(field) && (key === 'deleteAttachmentIds' || key === 'attachments') ? field.length > 0 : field !== undefined; }), 'At least one explicit patch change is required. Omitted body, headers and files are preserved.').refine(value => (value.to?.length ?? 0) + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <= 100, 'At most 100 explicitly supplied recipients; the backend also checks the preserved total.');
export const deleteDraftInputSchema = z.strictObject(writeTargetShape);
export const sendDraftInputSchema = z.strictObject(writeTargetShape);
const sourceMailboxIdSchema = mailboxIdSchema.describe('Mailbox that holds the message now, from list_mailboxes.');
export const moveMessageInputSchema = z.strictObject({ ...writeTargetShape, mailboxId: sourceMailboxIdSchema, destinationMailboxId: mailboxIdSchema.describe('Mailbox to move the message to, from list_mailboxes; must differ from mailboxId.') }).refine(value => value.mailboxId !== value.destinationMailboxId, 'Source and destination mailbox must differ.');
// Mirror the fork's seven-bit atom rules for additions. Removal also accepts
// historical custom keywords, while forbidding header controls and unsafe systems.
const systemFlag = (value: string) => value.startsWith('\\') ? value.toLowerCase() : value;
const safeSystemFlag = (value: string) => /^\\(?:seen|flagged|answered)$/iu.test(value);
const internalFlag = (value: string) => /^\$wdlabel\$/iu.test(value);
const atom = (value: string) => /^[\x21-\x7e]+$/u.test(value) && !/[(){%*"\\\]]/u.test(value);
export const addFlagSchema = z.string().min(1).max(255).refine(value => !internalFlag(value) && (safeSystemFlag(value) || (!value.startsWith('\\') && atom(value))), 'Unsupported system flag, internal label flag or invalid IMAP atom.');
export const removeFlagSchema = z.string().min(1).max(4096).refine(value => noHeaderControls(value) && !internalFlag(value) && (!value.startsWith('\\') || safeSystemFlag(value)), 'Unsupported system/internal flag or header control.');
export const labelSchema = z.string().min(1).max(256).refine(value => !value.startsWith('$') && !value.startsWith('\\'), 'Labels cannot use reserved system/internal prefixes.');
const flagList = <Schema extends z.ZodType<string>>(schema: Schema) => z.array(schema).max(5000).refine(values => unique(values.map(systemFlag)), 'Duplicate IMAP flags are not allowed.');
const labelList = z.array(labelSchema).max(5000).refine(unique, 'Duplicate labels are not allowed.');
export const updateMessageFlagsInputSchema = z.strictObject({ ...writeTargetShape, mailboxId: sourceMailboxIdSchema, seen: z.boolean().optional().describe('true marks the message read, false unread. Omit to keep.'), flagged: z.boolean().optional().describe('true flags (stars) the message, false removes the flag. Omit to keep.'), addFlags: flagList(addFlagSchema).optional().describe('IMAP keywords to add, e.g. $Forwarded or a custom word; \\Seen, \\Flagged and \\Answered also work. \\Draft and \\Deleted cannot be set.'), removeFlags: flagList(removeFlagSchema).optional().describe('IMAP keywords to remove, as listed in imapFlags.'), labels: labelList.optional().describe('Replace all labels with this list; [] removes all. Cannot be combined with addLabels or removeLabels.'), addLabels: labelList.optional().describe('Labels to add; other labels are kept.'), removeLabels: labelList.optional().describe('Labels to remove; other labels are kept.') })
    .refine(value => value.seen !== undefined || value.flagged !== undefined || value.labels !== undefined || [value.addFlags, value.removeFlags, value.addLabels, value.removeLabels].some(values => (values?.length ?? 0) > 0), 'At least one explicit flag or label change is required.')
    .refine(value => value.labels === undefined || (value.addLabels === undefined && value.removeLabels === undefined), 'Label replacement cannot be combined with label additions/removals.')
    .refine(value => !overlaps((value.addFlags ?? []).map(systemFlag), (value.removeFlags ?? []).map(systemFlag)), 'The same flag cannot be added and removed.')
    .refine(value => !overlaps(value.addLabels ?? [], value.removeLabels ?? []), 'The same label cannot be added and removed.')
    .refine(value => [['\\seen', value.seen], ['\\flagged', value.flagged]].every(([flag, requested]) => requested === undefined || !((requested === false && value.addFlags?.some(item => systemFlag(item) === flag)) || (requested === true && value.removeFlags?.some(item => systemFlag(item) === flag)))), 'Boolean flags contradict an add/remove alias.');

export const mailboxSchema = z.strictObject({ mailboxId: mailboxIdSchema.describe('Mailbox id to pass to other tools.'), path: z.string(), name: z.string().optional(), specialUse: z.string().nullable().describe('Role such as \\Drafts, \\Sent, \\Trash or \\Junk; null for other mailboxes.'), total: z.number().int().nonnegative().optional().describe('Message count, when available.'), unseen: z.number().int().nonnegative().optional().describe('Unread message count, when available. Missing means unknown, not zero.') });
export const messageFlagsSchema = z.strictObject({ seen: z.boolean(), flagged: z.boolean(), draft: z.boolean(), answered: z.boolean(), deleted: z.boolean(), forwarded: z.boolean() });
const dateSchema = z.iso.datetime({ offset: true }).nullable();
export const managedOperationSchema = z.strictObject({ operationId: operationIdSchema.describe('operationId of the request that last created or changed this message through this server.'), verification: z.enum(['not_checked', 'verified', 'pending', 'outcome_unknown', 'unverified']).describe('verified: that change is confirmed. not_checked: lists do not check; read the message. pending: no final result is recorded yet. outcome_unknown, unverified: this server cannot change this message.') }).describe('Present when this message was created or changed through this server.');
export const messageSummarySchema = messageKeySchema.extend({ subject: z.string(), snippet: boundedText(MAX_SNIPPET_BYTES).nullable().describe('Short preview of the text; not the full content.'), threadId: threadIdSchema.nullable(), from: z.array(outputAddressSchema), to: z.array(outputAddressSchema), date: dateSchema.describe('Date header set by the sender; null if missing or invalid.'), receivedAt: dateSchema.describe('When the mail server received or stored the message.'), flags: messageFlagsSchema, imapFlags: z.array(z.string()).describe('All IMAP flags and keywords, e.g. \\Seen or $Forwarded.'), labels: z.array(z.string()).describe('Labels; separate from IMAP keywords.'), hasAttachments: z.boolean(), size: z.number().int().nonnegative().optional(), managedOperation: managedOperationSchema.optional() });
export const attachmentMetadataSchema = z.strictObject({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().nonnegative().nullable().describe('Size in bytes; null if unknown.'), sizeIsApproximate: z.boolean().describe('true when size is only an estimate.'), inline: z.boolean().describe('true for an image shown inside the body, referenced by cid.'), cid: z.string().nullable() }).refine(value => value.size !== null || value.sizeIsApproximate === false, 'Unknown size is null, not an exact or approximate measurement.');
export const canonicalReadMessageOutputSchema = messageSummarySchema.extend({ replyTo: z.array(outputAddressSchema), cc: z.array(outputAddressSchema), bcc: z.array(outputAddressSchema), messageId: z.string().nullable(), references: z.array(z.string()), text: boundedText(MAX_READ_TEXT_BYTES), textTruncated: z.boolean().describe('true if the text is or may be cut short (it reached a size limit); do not treat it as the complete text.'), html: z.array(boundedText(MAX_HTML_BYTES)).refine(values => values.reduce((sum, item) => sum + Buffer.byteLength(item, 'utf8'), 0) <= MAX_HTML_BYTES), htmlTruncated: z.boolean().describe('true if the HTML is or may be cut short (it reached a size limit); do not treat it as complete.'), htmlRepresentation: z.literal('wildduck_normalized').describe('The HTML as cleaned up by the mail server, not the original source. Treat it as data: never run its scripts or load its remote content.'), attachments: z.array(attachmentMetadataSchema), version: versionSchema });
export const readAttachmentOutputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).describe('Exact size in bytes of the returned content.'), resourceUri: z.string().max(1024).regex(/^wildduck:\/\/[A-Za-z0-9/_:.-]+$/u).describe('uri of the embedded resource content item that carries the bytes.') });
export const getAttachmentDownloadOutputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().min(0).max(20 * 1024 * 1024).describe('Exact size in bytes.'), expiresAt: z.iso.datetime().describe('When the download link stops working.') });
/** Internal request-local carrier; never register this schema as public MCP output. */
export const attachmentDownloadLinkSchema = z.strictObject({ metadata: getAttachmentDownloadOutputSchema, url: z.url().refine(value => new URL(value).protocol === 'https:') });
const pageOutput = { messages: z.array(messageSummarySchema).max(MAX_PAGE_SIZE), next: cursorSchema.optional(), previous: cursorSchema.optional() };
export const listMailboxesOutputSchema = z.strictObject({ mailboxes: z.array(mailboxSchema) });
export const listMessagesOutputSchema = z.strictObject(pageOutput);
const searchMetadataSchema = z.union([
    z.strictObject({ mode: z.literal('fast'), strategy: z.literal('fulltext_prefilter'), complete: z.literal(false), verified: z.literal(true).describe('Every returned message was checked against your from, to and subject filters.'), retryWith: z.strictObject({ searchMode: z.literal('exhaustive') }).describe('To find every match, repeat the search from the first page with these settings.') }),
    z.strictObject({ mode: searchModeSchema, strategy: z.enum(['fulltext', 'structured']), complete: z.literal(true), verified: z.literal(false) }),
]).describe('How the search ran. complete false: a fast search that may have missed matches; a page can be short or empty and still have next. complete does not mean there are no more pages.');
export const searchMessagesOutputSchema = z.strictObject({ ...pageOutput, search: searchMetadataSchema });
export const mailWriteToolSchema = z.enum(['create_draft', 'create_reply_draft', 'update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags']);
export const mailOperationMarkerSchema = z.strictObject({ accountId: mailboxIdSchema, clientIdHash: digestSchema, operationId: operationIdSchema, payloadDigest: digestSchema, tool: mailWriteToolSchema });
export const sourceGradeSchema = z.enum(['mcp_authored', 'observed']).describe('mcp_authored: created by this server and unchanged since; such a draft can be edited and sent here. observed: any other message.');
export const activationProofSchema = messageRefSchema.extend({ accountId: mailboxIdSchema.describe('Id of the mail account.'), contentDigest: contentDigestSchema, sourceGrade: sourceGradeSchema }).describe('Confirmed identity and content of the resulting message.');
const authoredActivationProofSchema = activationProofSchema.extend({ sourceGrade: z.literal('mcp_authored') });
export const failureReasonSchema = z.enum(['not_found', 'version_conflict', 'unsupported_draft', 'no_recipients', 'forbidden', 'reconnect_required', 'temporarily_unavailable', 'upstream_timeout', 'invalid_input', 'unsupported_content', 'source_integrity_unavailable', 'too_large', 'verification_failed']);
export const mailErrorOutputSchema = z.strictObject({ code: failureReasonSchema.describe('Why this message could not be read, e.g. not_found (moved or deleted) or too_large (did not fit in this result; read it alone).'), message: z.string().max(1024), retryAfter: z.number().int().min(0).max(86400).optional().describe('Seconds to wait before trying again, when the mail server said so.') });
export const readMessageOutputSchema = z.discriminatedUnion('htmlOmitted', [
    canonicalReadMessageOutputSchema.extend({ htmlOmitted: z.literal(false) }),
    canonicalReadMessageOutputSchema.omit({ html: true, htmlTruncated: true, htmlRepresentation: true }).extend({ htmlOmitted: z.literal(true).describe('The HTML fields were left out because includeHtml was false.') }),
]);
export const batchMessageOutputSchema = readMessageOutputSchema;
export const readMessagesOutputSchema = z.strictObject({ includeHtml: z.boolean(), results: z.array(z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), message: batchMessageOutputSchema }), z.strictObject({ status: z.literal('failed'), ...messageKeySchema.shape, error: mailErrorOutputSchema })])).min(1).max(MAX_BATCH_MESSAGES).describe('One result per requested message, in request order: ok with the message, or failed with an error.'), byteBudget: z.literal(MAX_BATCH_BYTES).describe('Maximum size of this result in bytes (1 MiB).'), bytesReturned: z.number().int().min(0).max(MAX_BATCH_BYTES).describe('Size of this result in bytes.') }).refine(value => value.results.every(item => item.status === 'failed' || item.message.htmlOmitted !== value.includeHtml), 'Batch HTML projection must match includeHtml.');
export const getThreadOutputSchema = z.strictObject({ threadId: threadIdSchema, ...pageOutput, bodies: readMessagesOutputSchema.optional().describe('The full messages of this page, as read_messages returns them, when includeBodies was true.') });
const operationOutput = { operationId: operationIdSchema.describe('The operationId of this request.') };
export const inProgressSchema = z.strictObject({ status: z.literal('in_progress').describe('in_progress: no final result is recorded for this operationId yet, and no change is recorded. Retry the identical request once or twice after a few seconds; if it is still in_progress, stop retrying, read the message\'s current state and tell the user. Never repeat the change under a new operationId.'), ...operationOutput });
export const outcomeUnknownSchema = z.strictObject({ status: z.literal('outcome_unknown').describe('outcome_unknown: the change was started but its result is not known, so it may or may not have happened. Retrying the identical request only looks up the recorded result and never repeats the change; it may then show the real result or stay unknown. Do not repeat the change under a new operationId; check the current state yourself (for a send, the Sent mailbox) and tell the user. While it is unknown, the affected message cannot be changed through this server.'), ...operationOutput, reason: z.literal('dispatch_uncertain').describe('The request may have reached the mail server, but its result could not be confirmed.') });
export const conflictSchema = z.strictObject({ status: z.literal('conflict').describe('conflict: nothing was changed.'), ...operationOutput, reason: z.enum(['operation_conflict', 'draft_fenced']).describe('operation_conflict: this operationId was used before with other arguments; use a new one. draft_fenced: another action on this message is unfinished or uncertain, or the message was already moved, replaced, sent or deleted; list or read again.') });
export const failedSchema = z.strictObject({ status: z.literal('failed').describe('failed: nothing was changed. To try again after fixing the reason, use a new operationId.'), ...operationOutput, reason: failureReasonSchema.describe('Why it failed, e.g. version_conflict (read the message again) or unsupported_content (this server cannot change it; for a draft, create a new one).') });
const matchesProof = (value: { proof: z.output<typeof activationProofSchema>; draft: z.output<typeof messageRefSchema> }) => value.proof.mailboxId === value.draft.mailboxId && value.proof.uid === value.draft.uid && value.proof.version === value.draft.version;
const completedStatus = z.literal('completed').describe('completed: done and confirmed.');
const verifiedSchema = z.literal(true).describe('The result was read back from the mail server and matches.');
const partialStatus = z.literal('partial').describe('partial: only part of the change happened; see reason. Do not repeat it under a new operationId.');
const verifiedDraft = { ...operationOutput, draft: draftRefSchema.describe('The draft; use its uid and version from now on.'), verified: verifiedSchema, proof: authoredActivationProofSchema };
export const createDraftCompletedSchema = z.strictObject({ status: completedStatus, ...verifiedDraft }).refine(matchesProof, 'Proof must bind this exact candidate.');
export const updateDraftCompletedSchema = z.strictObject({ status: completedStatus, ...verifiedDraft, previousDeleted: z.literal(true).describe('The old copy of the draft was deleted.') }).refine(matchesProof, 'Proof must bind this exact candidate.');
export const unverifiedDraftPartialSchema = z.strictObject({ status: partialStatus, ...operationOutput, candidate: messageKeySchema.extend({ version: versionSchema.optional() }).describe('The new draft that was saved but not confirmed.'), candidateVerified: z.literal(false).describe('The new draft could not be confirmed, so this server cannot edit or send it.'), reason: z.literal('candidate_verification_failed').describe('The new draft could not be confirmed; any old draft was kept.'), originalDeletion: z.literal('not_attempted').describe('The old draft, if any, was kept.') });
export const verifiedDraftPartialSchema = z.strictObject({ status: partialStatus, ...operationOutput, candidate: messageRefSchema.describe('The new, confirmed copy of the draft.'), candidateVerified: z.literal(true).describe('The new copy was confirmed.'), proof: authoredActivationProofSchema, reason: z.enum(['original_deletion_failed', 'original_deletion_unconfirmed', 'original_version_changed', 'original_verification_failed']).describe('original_deletion_failed or _unconfirmed: use the new copy; the old one may remain. original_version_changed or _verification_failed: both kept; the new copy cannot be edited or sent here.'), originalDeletion: z.enum(['failed', 'unconfirmed', 'not_attempted']).describe('What happened to the old copy: failed or unconfirmed (it may still exist), or not_attempted (kept).') }).refine(value => matchesProof({ proof: value.proof, draft: value.candidate }), 'Proof must bind the exact candidate.').refine(value => ({ original_deletion_failed: 'failed', original_deletion_unconfirmed: 'unconfirmed', original_version_changed: 'not_attempted', original_verification_failed: 'not_attempted' })[value.reason] === value.originalDeletion, 'Deletion outcome must match the explicit reason.');
export const draftPartialSchema = z.discriminatedUnion('candidateVerified', [unverifiedDraftPartialSchema, verifiedDraftPartialSchema]);
export const deleteDraftCompletedSchema = z.strictObject({ status: completedStatus, ...operationOutput, deleted: messageKeySchema.describe('The deleted draft.') });
export const sendDraftQueuedSchema = z.strictObject({ status: z.literal('queued').describe('queued: the mail server accepted the message for delivery. This does not prove it was delivered.'), ...operationOutput, queueId: z.string().min(1).max(256).regex(/^\S+$/u).describe('Mail server queue id of the submitted message.'), sent: messageKeySchema.optional().describe('The copy in the Sent mailbox, when the mail server reported one.') });
const verifiedMessage = { ...operationOutput, message: messageRefSchema.describe('Where the message is now, with its new version.'), verified: verifiedSchema, proof: activationProofSchema };
const messageProofMatches = (value: { proof: z.output<typeof activationProofSchema>; message: z.output<typeof messageRefSchema> }) => matchesProof({ proof: value.proof, draft: value.message });
export const moveMessageCompletedSchema = z.strictObject({ status: completedStatus, ...verifiedMessage }).refine(messageProofMatches);
export const updateMessageFlagsCompletedSchema = z.strictObject({ status: completedStatus, ...verifiedMessage }).refine(messageProofMatches).describe('Confirms the requested change only. Read the message for its full current flags and labels.');
const incomplete = [inProgressSchema, outcomeUnknownSchema, conflictSchema, failedSchema] as const;
export const createDraftOutputSchema = z.union([createDraftCompletedSchema, unverifiedDraftPartialSchema, ...incomplete]);
export const updateDraftOutputSchema = z.union([updateDraftCompletedSchema, draftPartialSchema, ...incomplete]);
export const deleteDraftOutputSchema = z.discriminatedUnion('status', [deleteDraftCompletedSchema, ...incomplete]);
export const sendDraftOutputSchema = z.discriminatedUnion('status', [sendDraftQueuedSchema, ...incomplete]);
export const moveMessageOutputSchema = z.discriminatedUnion('status', [moveMessageCompletedSchema, ...incomplete]);
export const updateMessageFlagsOutputSchema = z.discriminatedUnion('status', [updateMessageFlagsCompletedSchema, ...incomplete]);
// Native Zod Standard Schema supplies the SDK's runtime validation and JSON Schema.
export const mailInputSchemas = { list_mailboxes: listMailboxesInputSchema, list_messages: listMessagesInputSchema, search_messages: searchMessagesInputSchema, read_message: readMessageInputSchema, get_thread: getThreadInputSchema, read_messages: readMessagesInputSchema, read_attachment: readAttachmentInputSchema, get_attachment_download: getAttachmentDownloadInputSchema, create_draft: createDraftInputSchema, create_reply_draft: createReplyDraftInputSchema, update_draft: updateDraftInputSchema, delete_draft: deleteDraftInputSchema, send_draft: sendDraftInputSchema, move_message: moveMessageInputSchema, update_message_flags: updateMessageFlagsInputSchema } as const satisfies Record<string, StandardSchemaWithJSON>;
export const mailOutputSchemas = { list_mailboxes: listMailboxesOutputSchema, list_messages: listMessagesOutputSchema, search_messages: searchMessagesOutputSchema, read_message: readMessageOutputSchema, get_thread: getThreadOutputSchema, read_messages: readMessagesOutputSchema, read_attachment: readAttachmentOutputSchema, get_attachment_download: getAttachmentDownloadOutputSchema, create_draft: createDraftOutputSchema, create_reply_draft: createDraftOutputSchema, update_draft: updateDraftOutputSchema, delete_draft: deleteDraftOutputSchema, send_draft: sendDraftOutputSchema, move_message: moveMessageOutputSchema, update_message_flags: updateMessageFlagsOutputSchema } as const satisfies Record<keyof typeof mailInputSchemas, StandardSchemaWithJSON>;
export type MailToolName = keyof typeof mailInputSchemas;
export type MailInput<Name extends MailToolName> = z.output<(typeof mailInputSchemas)[Name]>;
export type MailInputRaw<Name extends MailToolName> = z.input<(typeof mailInputSchemas)[Name]>;
export type MailOutput<Name extends MailToolName> = z.output<(typeof mailOutputSchemas)[Name]>;
export type Mailbox = z.output<typeof mailboxSchema>;
export type MessageKey = z.output<typeof messageKeySchema>;
export type MessageRef = z.output<typeof messageRefSchema>;
export type DraftRef = MessageRef;
export type DraftContent = z.output<typeof draftContentSchema>;
export type DraftPatch = Omit<MailInput<'update_draft'>, 'uid' | 'expectedVersion' | 'operationId'>;
export type NewAttachment = z.output<typeof newAttachmentSchema>;
export type FailedReceipt = z.output<typeof failedSchema>;
export type UnknownReceipt = z.output<typeof outcomeUnknownSchema>;
export type PartialReceipt = z.output<typeof draftPartialSchema>;
export type CompletedReceipt = z.output<typeof createDraftCompletedSchema> | z.output<typeof updateDraftCompletedSchema> | z.output<typeof deleteDraftCompletedSchema> | z.output<typeof sendDraftQueuedSchema> | z.output<typeof moveMessageCompletedSchema> | z.output<typeof updateMessageFlagsCompletedSchema>;
export type ConfirmedReceipt = CompletedReceipt | PartialReceipt;
export type MailReceipt = ConfirmedReceipt | FailedReceipt | UnknownReceipt;
export type DraftAddress = z.output<typeof inputAddressSchema>;
export type MailAddress = z.output<typeof outputAddressSchema>;
export type CanonicalReadMessage = z.output<typeof canonicalReadMessageOutputSchema>;
export type MessageSummary = z.output<typeof messageSummarySchema>;
export type MessageFlags = z.output<typeof messageFlagsSchema>;
export type AttachmentMetadata = z.output<typeof attachmentMetadataSchema>;
export type MailFailureCode = z.output<typeof failureReasonSchema>;
export type MailOperationMarker = z.output<typeof mailOperationMarkerSchema>;
export type ActivationProof = z.output<typeof activationProofSchema>;
export type MailWriteTool = z.output<typeof mailWriteToolSchema>;
export type SourceGrade = z.output<typeof sourceGradeSchema>;
