import type { ConnectionStatus } from '../auth/contracts';
import type { PreparedMime } from './mime';
import type { AttachmentUploadRequest, CanonicalReadMessage, ConfirmedReceipt, DraftContent, DraftPatch, FailedReceipt, MailFailureCode, Mailbox, MailInput, MailInputRaw, MailOperationMarker, MailOutput, MailReceipt, MailToolName, MailWriteTool, MessageKey, MessageRef, SourceGrade, UnknownReceipt } from './schemas';
export type { ActivationProof, AttachmentMetadata, AttachmentSource, AttachmentUploadRequest, Base64Attachment, CanonicalReadMessage, CompletedReceipt, ConfirmedReceipt, DraftAddress, DraftContent, DraftPatch, DraftRef, FailedReceipt, MailAddress, Mailbox, MailFailureCode, MailInput, MailInputRaw, MailOperationMarker, MailOutput, MailReceipt, MailToolName, MailWriteTool, MessageFlags, MessageKey, MessageRef, MessageSummary, NewAttachment, PartialReceipt, SourceAttachment, SourceGrade, UnknownReceipt, UploadAttachment } from './schemas';

export const searchFailureCauses = ['deadline', 'network', 'http_status', 'invalid_json', 'invalid_shape', 'mailbox_scope_mismatch', 'too_large'] as const;
export type SearchFailureCause = typeof searchFailureCauses[number];
/** Retain only allowlisted diagnostics. Never expose raw upstream errors, bodies or tokens. */
export class MailError extends Error {
    declare readonly retryAfter?: number;
    declare readonly searchCause?: SearchFailureCause;
    declare readonly upstreamStatus?: number;
    constructor(public readonly code: MailFailureCode, retryAfter: number | undefined = undefined, diagnostic: { cause?: SearchFailureCause | undefined; status?: number | undefined } | undefined = undefined) { super(code); this.name = 'MailError'; if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 86400) { this.retryAfter = retryAfter; } if (diagnostic && diagnostic.cause !== undefined && searchFailureCauses.includes(diagnostic.cause)) { this.searchCause = diagnostic.cause; if (typeof diagnostic.status === 'number' && Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599) { this.upstreamStatus = diagnostic.status; } } }
}
/** Reserved upstream metaData field. Raw marker contents are never public output. */
export const MAIL_OPERATION_METADATA_KEY = 'wildduckMcpOperationV1';
/** Request-local identity; never derive account/token from tool arguments. */
export interface BackendMailSession { readonly accountId: string; readonly accessToken: string }
/** The session the service passes to prepareCreate/prepareReply/prepareUpdate. clientIdHash is
 * digest(context.clientId), the same value as OperationKey.clientIdHash, set only by the service
 * from the verified OAuth grant, never from tool arguments. The backend uses it only to look up
 * upload records, which are bound to account AND client; it must refuse uploadId attachments
 * when it is absent or malformed (43 base64url characters). */
export interface DraftMailSession extends BackendMailSession { readonly clientIdHash: string }
export interface MailContext extends BackendMailSession {
    readonly clientId: string; readonly scopes: readonly string[]; readonly connectionStatus: ConnectionStatus;
}
export interface ReadMessageResult { readonly message: CanonicalReadMessage; readonly marker?: MailOperationMarker }
/** Public metadata contains no duplicate binary. MCP embeds bytes once as resource.blob. */
export interface AttachmentDownload { readonly metadata: MailOutput<'read_attachment'>; readonly bytes: Uint8Array }
/** Signed URL travels separately and is serialized only as resource_link.uri. */
export interface AttachmentDownloadLink { readonly metadata: MailOutput<'get_attachment_download'>; readonly url: string }
/** get_message_source_download's service result (messageSourceDownloadLinkSchema): metadata carries no
 * summary, and the signed URL travels separately and is serialized only as resource_link.uri. */
export interface MessageSourceDownloadLink { readonly metadata: Omit<MailOutput<'get_message_source_download'>, 'summary'>; readonly url: string }
/** create_attachment_upload's service result (attachmentUploadLinkSchema). The presigned upload URL
 * travels separately and is serialized only as resource_link.uri; metadata carries no summary. */
export interface AttachmentUploadLink { readonly metadata: Omit<MailOutput<'create_attachment_upload'>, 'summary'>; readonly url: string }
/** One attachment ready for MIME composition, whichever source it came from (contentBase64,
 * uploadId or source). The backend builds it during preflight (prepareCreate/prepareReply/
 * prepareUpdate, before the service marks the operation dispatched): bytes decoded, fetched and
 * verified; filename and contentType final (the caller's, else the source attachment's, and then
 * checked by the same authored rules as the schema, failing with invalid_input); disposition and
 * cid always the caller's. mime.ts composes from this type and enforces the byte rules the schema
 * cannot (message/rfc822 CRLF, MAX_MESSAGE_BYTES). */
export interface ResolvedAttachment { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array; readonly disposition: 'attachment' | 'inline'; readonly cid?: string | undefined }
/** S3 key prefix of staged uploads; objectKey is this prefix plus the uploadId. The key carries no
 * account, client or file name, and the bucket's lifecycle rule for this prefix removes objects. */
export const ATTACHMENT_UPLOAD_KEY_PREFIX = 'uploads/v1/';
/** Who may use an upload: the account AND the OAuth client that staged it. */
export interface AttachmentUploadOwner { readonly accountId: string; readonly clientIdHash: string }
/** Immutable after creation. Digest-pinned: the bytes used are exactly sizeBytes long with this
 * SHA-256 (lowercase hex). Reusable by any number of drafts until expiresAt and never deleted on
 * use; S3 lifecycle and the store's TTL remove it later. */
export interface AttachmentUploadRecord extends AttachmentUploadOwner {
    readonly uploadId: string; readonly sizeBytes: number; readonly sha256: string; readonly objectKey: string;
    /** Epoch seconds: creation + UPLOAD_TTL_SECONDS. */
    readonly expiresAt: number;
}
/** Upload records, beside the operation ledger. Unknown, expired, foreign-account and
 * foreign-client ids are indistinguishable to every caller: all are simply absent (not_found).
 * Ambiguous DB outcomes throw sanitized MailError('temporarily_unavailable'). */
export interface AttachmentUploadStore {
    /** One conditional write that never overwrites (an existing key throws temporarily_unavailable). */
    createUpload(record: AttachmentUploadRecord): Promise<void>;
    /** One strongly consistent batch read of all ids an operation names, keyed by uploadId. Returns
     * only records whose accountId and clientIdHash equal owner and whose expiresAt is still in the
     * future (TTL deletion is lazy, so expired items must be filtered here). */
    getUploads(owner: AttachmentUploadOwner, uploadIds: readonly string[]): Promise<ReadonlyMap<string, AttachmentUploadRecord>>;
}
/** A presigned upload for one record. expiresAt (ISO) is never later than the record's expiry; it
 * is earlier when signing credentials expire first. The URL is a bearer credential: never log or
 * persist it. method/headers follow attachmentUploadRequestSchema. */
export type PresignedAttachmentUpload = AttachmentUploadRequest & { readonly url: string; readonly expiresAt: string };
export interface AttachmentUploadStager {
    /** Sign a transfer of exactly record.sizeBytes bytes with record.sha256 to record.objectKey. */
    presign(record: AttachmentUploadRecord): Promise<PresignedAttachmentUpload>;
    /** The staged object's bytes, read only up to maxBytes (too_large when record.sizeBytes exceeds
     * it) and aborted with signal. Length or SHA-256 different from the record: verification_failed.
     * No object (not uploaded yet, or already removed): not_found. */
    readStaged(record: AttachmentUploadRecord, options: { readonly maxBytes: number; readonly signal: AbortSignal }): Promise<Uint8Array>;
}
export interface MailBackendReader {
    listMailboxes(session: BackendMailSession): Promise<MailOutput<'list_mailboxes'>>;
    listMessages(session: BackendMailSession, input: MailInput<'list_messages'>): Promise<MailOutput<'list_messages'>>;
    getThread(session: BackendMailSession, input: MailInput<'get_thread'>): Promise<MailOutput<'get_thread'>>;
    searchMessages(session: BackendMailSession, input: MailInputRaw<'search_messages'>): Promise<MailOutput<'search_messages'>>;
    /** No mark-as-seen mutation. HTML and incoming MIME fields are untrusted data.
     * Include private marker in this same GET so service can check one operation,
     * without a second backend GET or N+1 operation lookups on list pages. */
    readMessage(session: BackendMailSession, input: MessageKey): Promise<ReadMessageResult>;
    getAttachmentDownload(session: BackendMailSession, input: MailInput<'get_attachment_download'>): Promise<AttachmentDownloadLink>;
    /** The complete stored source of one message, staged as a download; sha256 is of exactly the bytes the URL serves. */
    getMessageSourceDownload(session: BackendMailSession, input: MailInput<'get_message_source_download'>): Promise<MessageSourceDownloadLink>;
    readAttachment(session: BackendMailSession, input: MailInput<'read_attachment'>): Promise<AttachmentDownload>;
}
export interface MessageSnapshot {
    readonly message: MessageRef; readonly isDraft: boolean; readonly hasHtml: boolean; readonly hasAttachments: boolean;
    /** Includes Bcc, not just visible To/Cc. */
    readonly hasRecipients: boolean; readonly marker?: MailOperationMarker;
}
/** Request-local preparation only. Backend may retain private verification state;
 * never serialize/persist MIME, envelope, credentials or this carrier in receipts. */
export interface PreparedDraft {
    readonly mailboxId: string; readonly mime: PreparedMime; readonly marker: MailOperationMarker;
}
/** SHA-256 hex64 observation hash, separate from snapshot version. Authored grade
 * additionally requires trusted prepared-byte provenance plus matching source hashes;
 * observed hashes do not establish hidden submission-envelope equivalence. */
export interface VerifiedMessageMutation { readonly message: MessageRef; readonly contentDigest: string; readonly sourceGrade: SourceGrade }
/** Trusted descriptor derived only from a durable validated receipt for this exact
 * account/mailbox/UID. Never construct from tool arguments, raw upstream markers
 * or an observed source. Digest is exact MCP-authored source SHA-256, hex64. */
export interface AuthoredSourceDescriptor {
    readonly grade: 'mcp_authored'; readonly accountId: string; readonly mailboxId: string; readonly uid: number; readonly contentDigest: string;
}
export interface MailBackendWriter {
    /** Resolve unique specialUse=\\Drafts, never assume a path or caller mailbox. */
    resolveDraftMailbox(session: BackendMailSession): Promise<Mailbox>;
    /** Same snapshot digest helper as readMessage: SHA-256 base64url binds account,
     * mailbox/UID and the full AVAILABLE existing-API response before our local
     * truncation/normalization: addresses, normalized body fields, attachment/file
     * metadata, flags, labels, references and custom metadata. The provider itself
     * caps normalized text/HTML and does not expose a full hidden submission
     * envelope; this snapshot version cannot prove those omitted bytes or fields.
     * Recursively sort JSON keys, preserve exact available strings/array order.
     * Full authored MIME SHA-256 is a separate durable contentDigest, checked against
     * source bytes before edit/send. No upstream modseq/CAS exists; external
     * webmail/IMAP can still race inspection and subsequent dispatch. */
    inspectMessage(session: BackendMailSession, target: MessageKey): Promise<MessageSnapshot>;
    /** Read the existing API source and require exact identity + SHA-256 match to
     * trusted authored bytes BEFORE markDispatched. A failure is preflight, never
     * a reason to reconstruct hidden recipient data. Cache validated bytes only
     * within the request; send stamping must consume this verified source. */
    verifyAuthoredSource(session: BackendMailSession, snapshot: MessageSnapshot, source: AuthoredSourceDescriptor): Promise<void>;
    /** Read/validate/compose completely BEFORE markDispatched. Pick owned default
     * From when omitted. Patch omissions preserve exact existing MIME and files.
     * Attachments: resolve every source to a ResolvedAttachment here, in preflight. uploadId: one
     * getUploads batch for (session.accountId, session.clientIdHash), then readStaged; a missing
     * record is not_found, other bytes verification_failed. source: read that attachment of that
     * account message (the service has already required mail:read). The payload digest covers only
     * the references, which is sound because an upload's bytes are pinned by its record and a
     * message's attachments never change under the same mailbox/uid. */
    prepareReply?(session: DraftMailSession, input: MailInput<'create_reply_draft'>, marker: MailOperationMarker): Promise<PreparedDraft>;
    prepareCreate(session: DraftMailSession, input: DraftContent, marker: MailOperationMarker): Promise<PreparedDraft>;
    prepareUpdate(session: DraftMailSession, snapshot: MessageSnapshot, patch: DraftPatch, marker: MailOperationMarker, source: AuthoredSourceDescriptor): Promise<PreparedDraft>;
    /** Single raw upload WITH marker before visibility; NEVER replacePrevious. */
    uploadPreparedDraft(session: BackendMailSession, prepared: PreparedDraft): Promise<MessageKey>;
    /** Compare source bytes exactly against trusted prepared MIME and verify API-
     * visible flags/labels/references/custom metadata. Recipient preservation relies
     * on the existing raw upload contract using header-derived structured fields,
     * not an independent GET proof of a hidden private submission envelope. */
    verifyPreparedDraft(session: BackendMailSession, target: MessageKey, prepared: PreparedDraft): Promise<MessageRef>;
    /** Coordinator first checks canonical draft, marker activation, candidate proof
     * where relevant, and fresh original version. No silent delete-after-timeout. */
    deleteDraft(session: BackendMailSession, target: MessageKey): Promise<void>;
    /** After markDispatched: metadata-only PUT, then verify content unchanged.
     * Automatic Sent move inherits this SEND marker. */
    stampSendMarker(session: BackendMailSession, snapshot: MessageSnapshot, marker: MailOperationMarker, source: AuthoredSourceDescriptor): Promise<MessageRef>;
    /** Queue acceptance, never delivery. Return Sent key only from actual response. */
    submitDraft(session: BackendMailSession, target: MessageKey): Promise<{ queueId: string; sent?: MessageKey }>;
    /** Move+marker and verify new mapping/content/flags. Carry authored grade only
     * when trusted descriptor matches both pre/post source SHA; otherwise observed. */
    moveMessage(session: BackendMailSession, snapshot: MessageSnapshot, destinationMailboxId: string, marker: MailOperationMarker, source?: AuthoredSourceDescriptor): Promise<VerifiedMessageMutation>;
    /** PUT requested flags/labels+marker, GET and verify requested state. Authored
     * grade requires trusted descriptor and equal pre/post source SHA; never infer
     * it from a marker or newly observed raw source alone. */
    updateMessageFlags(session: BackendMailSession, snapshot: MessageSnapshot, patch: MailInput<'update_message_flags'>, marker: MailOperationMarker, source?: AuthoredSourceDescriptor): Promise<VerifiedMessageMutation>;
}
export interface OperationKey { readonly accountId: string; readonly clientIdHash: string; readonly operationId: string }
export type WriteIntent = OperationKey & { readonly payloadDigest: string } & (
    | { readonly tool: 'create_draft' }
    | { readonly tool: 'create_reply_draft' }
    | { readonly tool: Exclude<MailWriteTool, 'create_draft' | 'create_reply_draft'>; readonly target: MessageKey; readonly expectedVersion: string }
);
export interface OperationClaim<State extends 'reserved' | 'dispatched' = 'reserved' | 'dispatched'> {
    readonly key: OperationKey; readonly ownerToken: string; readonly revision: number; readonly state: State;
}
interface OperationRecordBase { readonly key: OperationKey; readonly ownerToken: string; readonly revision: number; readonly intent: WriteIntent }
export type MailOperationRecord = OperationRecordBase & (
    | { readonly state: 'reserved' | 'dispatched' }
    | { readonly state: 'settled'; readonly receipt: MailReceipt }
);
/** Historical name; the shared guard covers ALL messages, not only drafts.
 * Keys omit client/connection so no new operation/client bypasses an uncertain fence. */
export interface DraftGuardKey extends MessageKey { readonly accountId: string }
export interface DraftGuardRecord {
    readonly key: DraftGuardKey; readonly operation: OperationKey; readonly ownerToken: string; readonly revision: number;
    readonly state: 'reserved' | 'dispatched' | 'retired' | 'queued' | 'outcome_unknown';
}
export type ReservationResult =
    | { readonly kind: 'acquired'; readonly claim: OperationClaim<'reserved'> }
    | { readonly kind: 'replay'; readonly record: MailOperationRecord }
    | { readonly kind: 'conflict'; readonly reason: 'operation_conflict' | 'draft_fenced' };
/** Separate adapter over existing table; auth AtomicStore union is unchanged.
 * Strong reads, owner+revision CAS, atomic associated guard checks. NO TTL and
 * NO reclaim based on elapsed time for pending/unknown/queued/retired states.
 * Store only digests and minimal references/proofs/queue receipts: never bodies,
 * subjects, addresses, tokens, custom flag/label names or complete inputs.
 * Match receipt to tool/operation ID. Ambiguous DB outcomes throw sanitized
 * MailError(temporarily_unavailable), never false failure/conflict/re-dispatch. */
export interface MailOperationStore {
    getOperation(key: OperationKey): Promise<MailOperationRecord | undefined>;
    /** Reserve operation + target guard atomically; create has no target yet.
     * Identical retries replay stored status without network; changed inputs conflict. */
    reserve(intent: WriteIntent, ownerToken: string): Promise<ReservationResult>;
    /** Confirm this transition BEFORE any irreversible call, including marker PUT. */
    markDispatched(claim: OperationClaim<'reserved'>): Promise<OperationClaim<'dispatched'>>;
    /** Durable failed receipt and guard release together, only before dispatch. */
    failPreflight(claim: OperationClaim<'reserved'>, receipt: FailedReceipt): Promise<void>;
    /** Atomic receipt+guard transition. Verified flag completion RELEASES same-UID
     * guard. Move/delete/update retire source; send queues/permanently fences it.
     * Post-dispatch update partial conservatively retires original guard.
     * Verified partial candidate activates only for deletion_failed/unconfirmed
     * after a fresh original-version check; original_version_changed and
     * original_verification_failed NEVER activate.
     * Unverified/unknown/stale candidates remain fenced. Exact activation proof binds
     * account/mailbox/UID; later flag changes do not invalidate historical identity.
     * SourceGrade authored starts only at create/update exact candidate byte proof;
     * move/flags carry it only with trusted prior proof + unchanged raw SHA.
     * Send's actual receipt.sent key activates only as observed, never authored.
     * Flags receipt stays minimal; replay neither refetches nor echoes current sets. */
    complete(claim: OperationClaim<'dispatched'>, receipt: ConfirmedReceipt): Promise<void>;
    /** Any unproved post-dispatch outcome permanently fences the target. */
    markOutcomeUnknown(claim: OperationClaim<'dispatched'>, receipt: UnknownReceipt): Promise<void>;
}
/** Service checks scope + active session BEFORE backend/store: reads mail:read,
 * drafts mail:draft, send mail:send, move/flags mail:modify. Every mutation checks
 * private marker -> durable original operation -> exact target activation proof,
 * except its own staged verification. Unactivated candidates never become sendable.
 * Public writes always pass this coordinator; no raw writer reaches MCP.
 * Drafts whose attachments use source also need mail:read. create_attachment_upload needs
 * mail:draft and is not a write tool: no operationId, no ledger, a new record per call. */
export type MailResult<Name extends MailToolName> = Name extends 'read_attachment' ? AttachmentDownload : Name extends 'get_attachment_download' ? AttachmentDownloadLink : Name extends 'get_message_source_download' ? MessageSourceDownloadLink : Name extends 'create_attachment_upload' ? AttachmentUploadLink : MailOutput<Name>;
export type MailService = { [Name in MailToolName]: (context: MailContext, input: Name extends 'search_messages' ? MailInputRaw<Name> : MailInput<Name>) => Promise<MailResult<Name>> };
export type BoundMailService = { [Name in MailToolName]: (input: MailInput<Name>) => Promise<MailResult<Name>> };
export type MailWriteCoordinator = Pick<MailService, MailWriteTool>;
export type MailReadService = Omit<MailService, MailWriteTool>;
