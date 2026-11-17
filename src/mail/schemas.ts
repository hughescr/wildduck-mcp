import { z } from 'zod';
import { isEmailValid } from '@hapi/address';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { ATTACHMENT_MEDIA, AMBIGUOUS_INLINE, AUTHORED_LIMITS, CONTENT_ID, EMAIL, hasAttachmentReference, hasBareLineFeed } from './mime';
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
export const attachmentIdSchema = z.string().max(64).regex(/^ATT\d+$/u);
export const versionSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u).describe('SHA-256 base64url digest of account/mailbox/UID and the full available API response before our local truncation. The provider caps normalized text/HTML and omits hidden envelope data. Preserve available strings and array order, recursively sort object keys. Full authored MIME digest is separate. This is not backend CAS.');
export const operationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u).describe('Stable caller operation ID. Identical retries retrieve durable status; a new ID cannot bypass an uncertain message fence.');
const digestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const contentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u).describe('SHA-256 hexadecimal observation hash for observed grade. Only mcp_authored binds source bytes to trusted prepared MIME provenance; an observation alone does not prove hidden submission-envelope fields.');
const cursorSchema = z.string().max(1024).refine(nonblank);
const paginationShape = { limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(20), next: cursorSchema.optional(), previous: cursorSchema.optional() };
const singleDirection = (input: { next?: string | undefined; previous?: string | undefined }) => input.next === undefined || input.previous === undefined;
export const messageKeySchema = z.strictObject({ mailboxId: mailboxIdSchema, uid: uidSchema });
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
export const inputAddressSchema = z.strictObject({ address: addressText, name: displayName.optional().describe('Display name without control characters or "=?". Edge whitespace is trimmed, internal runs become one space, and a name equal to the address is dropped.') })
    .transform(({ address, name }) => namedAddress(address, name));
// Malformed incoming MIME addresses remain untrusted data, not outbound validators.
export const outputAddressSchema = z.strictObject({ address: z.string(), name: z.string().optional() });
const recipientsSchema = z.array(inputAddressSchema).max(50);
export const MAX_MARKDOWN_BYTES = MAX_DRAFT_TEXT_BYTES;
// Each branch is strict with one required key, so the advertised JSON Schema
// (anyOf) itself says "exactly one". The server renders it before MIME composition.
export const draftBodySchema = z.union([
    z.strictObject({ markdown: bodyText(MAX_MARKDOWN_BYTES).describe('Preferred. Markdown rendered to HTML plus generated plain text (multipart/alternative).') }),
    z.strictObject({ html: bodyText(MAX_HTML_BYTES).refine(value => !hasAttachmentReference(value), 'HTML must not use attachment:ATTn URLs in tag attributes; reference attached images as cid: URLs.').describe('HTML sent with generated plain text (multipart/alternative).') }),
    z.strictObject({ text: bodyText(MAX_DRAFT_TEXT_BYTES).describe('Plain text only (single text/plain part). Some clients drop its line breaks when editing the draft; prefer markdown.') }),
], { error: 'Provide exactly one of body.markdown, body.html or body.text.' }).describe('Exactly one of markdown (preferred), html or text.');
const base64Schema = z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && Buffer.from(value, 'base64').toString('base64') === value && Buffer.byteLength(value, 'base64') <= MAX_ATTACHMENT_BYTES, 'Canonical base64 of at most 2 MiB decoded bytes is required.');
// type/subtype only (case-insensitive; written lower case). multipart/* needs a boundary and other message/*
// subtypes have their own syntax, so only message/rfc822 is accepted of those.
const contentTypeSchema = z.string().max(AUTHORED_LIMITS.contentTypeBytes).regex(ATTACHMENT_MEDIA, 'Content type must be type/subtype without parameters; multipart/* and message/* other than message/rfc822 are not supported.');
// A Content-ID is a msg-id: letters, digits and the RFC 5322 atext punctuation, with "." and "@".
const cidSchema = z.string().min(1).max(AUTHORED_LIMITS.cidBytes).regex(CONTENT_ID, 'CID may contain only letters, digits and ! # $ % & \' * + - . / = ? ^ _ ` { | } ~ @.');
const attachmentFilenameSchema = filenameText.describe('Any text without control characters, "=?", edge whitespace or repeated whitespace, including single spaces, quotes, semicolons, slashes and non-ASCII; mail clients sanitise path separators when saving.');
export const newAttachmentSchema = z.strictObject({ filename: attachmentFilenameSchema, contentType: contentTypeSchema, contentBase64: base64Schema, disposition: z.enum(['attachment', 'inline']).default('attachment'), cid: cidSchema.optional() })
    .refine(value => value.disposition !== 'inline' || value.cid !== undefined, 'Inline attachments require a CID.')
    .refine(value => !(value.disposition === 'inline' && AMBIGUOUS_INLINE.test(value.contentType)), 'Inline text/plain and text/html attachments cannot be told from the body; use disposition attachment.')
    .refine(value => !(value.contentType.toLowerCase() === 'message/rfc822' && hasBareLineFeed(Buffer.from(value.contentBase64, 'base64'))), 'message/rfc822 content must use CRLF line endings.');
const newAttachmentsSchema = z.array(newAttachmentSchema).max(100).refine(values => values.reduce((sum, item) => sum + Buffer.byteLength(item.contentBase64, 'base64'), 0) <= MAX_ATTACHMENT_BYTES, 'Combined decoded attachments must not exceed 2 MiB.').refine(values => unique(values.flatMap(item => item.cid === undefined ? [] : [item.cid])), 'Attachment CIDs must be unique.');
const draftFields = { from: inputAddressSchema.optional(), replyTo: recipientsSchema.optional(), to: recipientsSchema.default([]), cc: recipientsSchema.default([]), bcc: recipientsSchema.default([]), subject: subjectText(MAX_SUBJECT_BYTES), body: draftBodySchema, attachments: newAttachmentsSchema.default([]) };
export const draftContentSchema = z.strictObject(draftFields).refine(value => value.to.length + value.cc.length + value.bcc.length <= 100, 'At most 100 recipients in total.');
const writeTargetShape = { uid: uidSchema, expected_version: versionSchema, operation_id: operationIdSchema };
export const listMailboxesInputSchema = z.strictObject({});
export const listMessagesInputSchema = z.strictObject({ mailboxId: mailboxIdSchema, ...paginationShape }).refine(singleDirection, 'Specify one cursor direction.');
const searchModeSchema = z.enum(['fast', 'exhaustive']);
const searchFilters = {
    mailboxId: mailboxIdSchema.optional(),
    from: headerText(320).refine(nonblank).optional().describe('Case-insensitive From filter. Fast mode verifies the parsed From display name or address.'),
    to: headerText(320).refine(nonblank).optional().describe('Case-insensitive To or Cc filter, excluding Bcc. Fast mode verifies parsed display names and addresses.'),
    subject: headerText(MAX_SUBJECT_BYTES).refine(nonblank).optional().describe('Case-insensitive subject substring.'),
    text: z.string().max(MAX_SEARCH_TEXT_CHARACTERS).refine(utf8(4 * MAX_SEARCH_TEXT_CHARACTERS)).refine(nonblank).optional().describe('Indexed full-text query. With header filters in fast mode, this is the candidate query.'),
    receivedSince: z.iso.datetime({ offset: true }).optional(), receivedUntil: z.iso.datetime({ offset: true }).optional(),
    seen: z.boolean().optional(), flagged: z.boolean().optional(), hasAttachments: z.boolean().optional(),
};
export const searchMessagesInputSchema = z.strictObject({
    ...searchFilters, ...paginationShape,
    searchMode: searchModeSchema.default('fast').describe('Fast is the default. With header filters, fast uses indexed candidates and returns only verified matches, which may be incomplete. Use exhaustive for complete structured-header matching, which may be slower.'),
}).refine(singleDirection, 'Specify one cursor direction.').refine(value => Object.keys(searchFilters).some(key => value[key as keyof typeof searchFilters] !== undefined), 'At least one meaningful filter is required.').refine(value => value.receivedSince === undefined || value.receivedUntil === undefined || Date.parse(value.receivedSince) <= Date.parse(value.receivedUntil), 'receivedSince must not follow receivedUntil.');
export const threadIdSchema = mailboxIdSchema;
export const getThreadInputSchema = z.strictObject({ message: messageKeySchema.optional(), threadId: threadIdSchema.optional(), ...paginationShape, limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10), includeBodies: z.boolean().default(false) }).refine(value => !value.includeBodies || value.limit <= MAX_BATCH_MESSAGES, 'Body pages are capped at 10 messages.').refine(singleDirection, 'Specify one cursor direction.').refine(value => (value.message === undefined) !== (value.threadId === undefined), 'Specify exactly one message reference or threadId.');
export const readMessagesInputSchema = z.strictObject({ includeHtml: z.boolean().default(true), messages: z.array(messageKeySchema).min(1).max(MAX_BATCH_MESSAGES).refine(values => unique(values.map(value => value.mailboxId + ':' + value.uid)), 'Duplicate message references are forbidden.') });
export const readMessageInputSchema = messageKeySchema.extend({ includeHtml: z.boolean().default(true) });
export const readAttachmentInputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema });
export const getAttachmentDownloadInputSchema = readAttachmentInputSchema;
export const createReplyDraftInputSchema = z.strictObject({ original: messageKeySchema, mode: z.enum(['reply', 'reply_all']).default('reply'), body: draftBodySchema, quoteOriginal: z.boolean().default(false), from: inputAddressSchema.optional(), to: recipientsSchema.optional(), cc: recipientsSchema.optional(), attachments: newAttachmentsSchema.default([]), operation_id: operationIdSchema }).refine(value => (value.to?.length ?? 0) + (value.cc?.length ?? 0) <= 100, 'At most 100 explicit recipients.');
export const createDraftInputSchema = draftContentSchema.safeExtend({ operation_id: operationIdSchema });
const patchFields = { from: inputAddressSchema.optional(), replyTo: recipientsSchema.optional(), to: recipientsSchema.optional(), cc: recipientsSchema.optional(), bcc: recipientsSchema.optional(), subject: subjectText(MAX_SUBJECT_BYTES).optional(), body: draftBodySchema.optional(), deleteAttachmentIds: z.array(attachmentIdSchema).max(100).refine(unique).optional(), attachments: newAttachmentsSchema.optional() };
export const updateDraftInputSchema = z.strictObject({ ...writeTargetShape, ...patchFields }).refine(value => Object.keys(patchFields).some(key => { const field = value[key as keyof typeof patchFields]; return Array.isArray(field) && (key === 'deleteAttachmentIds' || key === 'attachments') ? field.length > 0 : field !== undefined; }), 'At least one explicit patch change is required. Omitted body, headers and files are preserved.').refine(value => (value.to?.length ?? 0) + (value.cc?.length ?? 0) + (value.bcc?.length ?? 0) <= 100, 'At most 100 explicitly supplied recipients; the backend also checks the preserved total.');
export const deleteDraftInputSchema = z.strictObject(writeTargetShape);
export const sendDraftInputSchema = z.strictObject(writeTargetShape);
export const moveMessageInputSchema = z.strictObject({ ...writeTargetShape, mailboxId: mailboxIdSchema, destinationMailboxId: mailboxIdSchema }).refine(value => value.mailboxId !== value.destinationMailboxId, 'Source and destination mailbox must differ.');
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
export const updateMessageFlagsInputSchema = z.strictObject({ ...writeTargetShape, mailboxId: mailboxIdSchema, seen: z.boolean().optional(), flagged: z.boolean().optional(), addFlags: flagList(addFlagSchema).optional(), removeFlags: flagList(removeFlagSchema).optional(), labels: labelList.optional(), addLabels: labelList.optional(), removeLabels: labelList.optional() })
    .refine(value => value.seen !== undefined || value.flagged !== undefined || value.labels !== undefined || [value.addFlags, value.removeFlags, value.addLabels, value.removeLabels].some(values => (values?.length ?? 0) > 0), 'At least one explicit flag or label change is required.')
    .refine(value => value.labels === undefined || (value.addLabels === undefined && value.removeLabels === undefined), 'Label replacement cannot be combined with label additions/removals.')
    .refine(value => !overlaps((value.addFlags ?? []).map(systemFlag), (value.removeFlags ?? []).map(systemFlag)), 'The same flag cannot be added and removed.')
    .refine(value => !overlaps(value.addLabels ?? [], value.removeLabels ?? []), 'The same label cannot be added and removed.')
    .refine(value => [['\\seen', value.seen], ['\\flagged', value.flagged]].every(([flag, requested]) => requested === undefined || !((requested === false && value.addFlags?.some(item => systemFlag(item) === flag)) || (requested === true && value.removeFlags?.some(item => systemFlag(item) === flag)))), 'Boolean flags contradict an add/remove alias.');

export const mailboxSchema = z.strictObject({ mailboxId: mailboxIdSchema, path: z.string(), name: z.string().optional(), specialUse: z.string().nullable(), total: z.number().int().nonnegative().optional(), unseen: z.number().int().nonnegative().optional().describe('Unread message count when available. Missing means unavailable, never zero; mailbox counters are not an atomic snapshot.') });
export const messageFlagsSchema = z.strictObject({ seen: z.boolean(), flagged: z.boolean(), draft: z.boolean(), answered: z.boolean(), deleted: z.boolean(), forwarded: z.boolean() });
const dateSchema = z.iso.datetime({ offset: true }).nullable();
export const managedOperationSchema = z.strictObject({ operationId: operationIdSchema, verification: z.enum(['not_checked', 'verified', 'pending', 'outcome_unknown', 'unverified']) });
export const messageSummarySchema = messageKeySchema.extend({ subject: z.string(), snippet: boundedText(MAX_SNIPPET_BYTES).nullable(), threadId: threadIdSchema.nullable(), from: z.array(outputAddressSchema), to: z.array(outputAddressSchema), date: dateSchema.describe('Parsed Date header, null if absent/invalid. Never substitute receivedAt.'), receivedAt: dateSchema.describe('Backend received timestamp (idate), distinct from the sender Date header.'), flags: messageFlagsSchema, imapFlags: z.array(z.string()), labels: z.array(z.string()), hasAttachments: z.boolean(), size: z.number().int().nonnegative().optional(), managedOperation: managedOperationSchema.optional() });
export const attachmentMetadataSchema = z.strictObject({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().nonnegative().nullable(), sizeIsApproximate: z.boolean(), inline: z.boolean(), cid: z.string().nullable() }).refine(value => value.size !== null || value.sizeIsApproximate === false, 'Unknown size is null, not an exact or approximate measurement.');
export const canonicalReadMessageOutputSchema = messageSummarySchema.extend({ replyTo: z.array(outputAddressSchema), cc: z.array(outputAddressSchema), bcc: z.array(outputAddressSchema), messageId: z.string().nullable(), references: z.array(z.string()), text: boundedText(MAX_READ_TEXT_BYTES), textTruncated: z.boolean().describe('Text is truncated locally or potentially truncated upstream; the existing API supplies no authoritative truncation marker.'), html: z.array(boundedText(MAX_HTML_BYTES)).refine(values => values.reduce((sum, item) => sum + Buffer.byteLength(item, 'utf8'), 0) <= MAX_HTML_BYTES), htmlTruncated: z.boolean().describe('HTML is truncated locally or potentially truncated upstream; normalized HTML is not the original MIME.'), htmlRepresentation: z.literal('wildduck_normalized'), attachments: z.array(attachmentMetadataSchema), version: versionSchema });
export const readAttachmentOutputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).describe('Exact decoded bytes returned, not sizeKb estimation.'), resourceUri: z.string().max(1024).regex(/^wildduck:\/\/[A-Za-z0-9/_:.-]+$/u) });
export const getAttachmentDownloadOutputSchema = messageKeySchema.extend({ attachmentId: attachmentIdSchema, filename: z.string().nullable(), contentType: z.string(), size: z.number().int().min(0).max(20 * 1024 * 1024), expiresAt: z.iso.datetime() });
/** Internal request-local carrier; never register this schema as public MCP output. */
export const attachmentDownloadLinkSchema = z.strictObject({ metadata: getAttachmentDownloadOutputSchema, url: z.url().refine(value => new URL(value).protocol === 'https:') });
const pageOutput = { messages: z.array(messageSummarySchema).max(MAX_PAGE_SIZE), next: cursorSchema.optional(), previous: cursorSchema.optional() };
export const listMailboxesOutputSchema = z.strictObject({ mailboxes: z.array(mailboxSchema) });
export const listMessagesOutputSchema = z.strictObject(pageOutput);
const searchMetadataSchema = z.union([
    z.strictObject({ mode: z.literal('fast'), strategy: z.literal('fulltext_prefilter'), complete: z.literal(false), verified: z.literal(true), retryWith: z.strictObject({ searchMode: z.literal('exhaustive') }) }),
    z.strictObject({ mode: searchModeSchema, strategy: z.enum(['fulltext', 'structured']), complete: z.literal(true), verified: z.literal(false) }),
]).describe('Executed mode and strategy. Complete describes the matching strategy, not whether more pages exist. Verified indicates local header verification. For incomplete searches, next and previous page through candidates and retryWith requests a complete search from the first page.');
export const searchMessagesOutputSchema = z.strictObject({ ...pageOutput, search: searchMetadataSchema });
export const mailWriteToolSchema = z.enum(['create_draft', 'create_reply_draft', 'update_draft', 'delete_draft', 'send_draft', 'move_message', 'update_message_flags']);
export const mailOperationMarkerSchema = z.strictObject({ accountId: mailboxIdSchema, clientIdHash: digestSchema, operationId: operationIdSchema, payloadDigest: digestSchema, tool: mailWriteToolSchema });
export const sourceGradeSchema = z.enum(['mcp_authored', 'observed']);
export const activationProofSchema = messageRefSchema.extend({ accountId: mailboxIdSchema, contentDigest: contentDigestSchema, sourceGrade: sourceGradeSchema });
const authoredActivationProofSchema = activationProofSchema.extend({ sourceGrade: z.literal('mcp_authored') });
export const failureReasonSchema = z.enum(['not_found', 'version_conflict', 'unsupported_draft', 'no_recipients', 'forbidden', 'reconnect_required', 'temporarily_unavailable', 'upstream_timeout', 'invalid_input', 'unsupported_content', 'source_integrity_unavailable', 'too_large', 'verification_failed']);
export const mailErrorOutputSchema = z.strictObject({ code: failureReasonSchema, message: z.string().max(1024), retry_after: z.number().int().min(0).max(86400).optional() });
export const readMessageOutputSchema = z.discriminatedUnion('htmlOmitted', [
    canonicalReadMessageOutputSchema.extend({ htmlOmitted: z.literal(false) }),
    canonicalReadMessageOutputSchema.omit({ html: true, htmlTruncated: true, htmlRepresentation: true }).extend({ htmlOmitted: z.literal(true).describe('HTML-related fields were intentionally omitted; textTruncated retains its original meaning.') }),
]);
export const batchMessageOutputSchema = readMessageOutputSchema;
export const readMessagesOutputSchema = z.strictObject({ includeHtml: z.boolean(), results: z.array(z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), message: batchMessageOutputSchema }), z.strictObject({ status: z.literal('failed'), ...messageKeySchema.shape, error: mailErrorOutputSchema })])).min(1).max(MAX_BATCH_MESSAGES), byteBudget: z.literal(MAX_BATCH_BYTES), bytesReturned: z.number().int().min(0).max(MAX_BATCH_BYTES) }).refine(value => value.results.every(item => item.status === 'failed' || item.message.htmlOmitted !== value.includeHtml), 'Batch HTML projection must match includeHtml.');
export const getThreadOutputSchema = z.strictObject({ threadId: threadIdSchema, ...pageOutput, bodies: readMessagesOutputSchema.optional() });
const operationOutput = { operation_id: operationIdSchema };
export const inProgressSchema = z.strictObject({ status: z.literal('in_progress'), ...operationOutput });
export const outcomeUnknownSchema = z.strictObject({ status: z.literal('outcome_unknown'), ...operationOutput, reason: z.literal('dispatch_uncertain') });
export const conflictSchema = z.strictObject({ status: z.literal('conflict'), ...operationOutput, reason: z.enum(['operation_conflict', 'draft_fenced']) });
export const failedSchema = z.strictObject({ status: z.literal('failed'), ...operationOutput, reason: failureReasonSchema });
const matchesProof = (value: { proof: z.output<typeof activationProofSchema>; draft: z.output<typeof messageRefSchema> }) => value.proof.mailboxId === value.draft.mailboxId && value.proof.uid === value.draft.uid && value.proof.version === value.draft.version;
const verifiedDraft = { ...operationOutput, draft: draftRefSchema, verified: z.literal(true), proof: authoredActivationProofSchema };
export const createDraftCompletedSchema = z.strictObject({ status: z.literal('completed'), ...verifiedDraft }).refine(matchesProof, 'Proof must bind this exact candidate.');
export const updateDraftCompletedSchema = z.strictObject({ status: z.literal('completed'), ...verifiedDraft, previousDeleted: z.literal(true) }).refine(matchesProof, 'Proof must bind this exact candidate.');
export const unverifiedDraftPartialSchema = z.strictObject({ status: z.literal('partial'), ...operationOutput, candidate: messageKeySchema.extend({ version: versionSchema.optional() }), candidateVerified: z.literal(false), reason: z.literal('candidate_verification_failed'), originalDeletion: z.literal('not_attempted') });
export const verifiedDraftPartialSchema = z.strictObject({ status: z.literal('partial'), ...operationOutput, candidate: messageRefSchema, candidateVerified: z.literal(true), proof: authoredActivationProofSchema, reason: z.enum(['original_deletion_failed', 'original_deletion_unconfirmed', 'original_version_changed', 'original_verification_failed']), originalDeletion: z.enum(['failed', 'unconfirmed', 'not_attempted']) }).refine(value => matchesProof({ proof: value.proof, draft: value.candidate }), 'Proof must bind the exact candidate.').refine(value => ({ original_deletion_failed: 'failed', original_deletion_unconfirmed: 'unconfirmed', original_version_changed: 'not_attempted', original_verification_failed: 'not_attempted' })[value.reason] === value.originalDeletion, 'Deletion outcome must match the explicit reason.');
export const draftPartialSchema = z.discriminatedUnion('candidateVerified', [unverifiedDraftPartialSchema, verifiedDraftPartialSchema]);
export const deleteDraftCompletedSchema = z.strictObject({ status: z.literal('completed'), ...operationOutput, deleted: messageKeySchema });
export const sendDraftQueuedSchema = z.strictObject({ status: z.literal('queued'), ...operationOutput, queueId: z.string().min(1).max(256).regex(/^\S+$/u), sent: messageKeySchema.optional() });
const verifiedMessage = { ...operationOutput, message: messageRefSchema, verified: z.literal(true), proof: activationProofSchema };
const messageProofMatches = (value: { proof: z.output<typeof activationProofSchema>; message: z.output<typeof messageRefSchema> }) => matchesProof({ proof: value.proof, draft: value.message });
export const moveMessageCompletedSchema = z.strictObject({ status: z.literal('completed'), ...verifiedMessage }).refine(messageProofMatches);
export const updateMessageFlagsCompletedSchema = z.strictObject({ status: z.literal('completed'), ...verifiedMessage }).refine(messageProofMatches).describe('Minimal durable confirmation. Read the message for current full flag/label sets; replay never refetches or mutates.');
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
export type DraftPatch = Omit<MailInput<'update_draft'>, 'uid' | 'expected_version' | 'operation_id'>;
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
