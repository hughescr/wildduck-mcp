import type { ConnectionStatus } from '../auth/contracts';
import type { PreparedMime } from './mime';
import type { ConfirmedReceipt, DraftContent, DraftPatch, FailedReceipt, MailFailureCode, Mailbox, MailInput, MailOperationMarker, MailOutput, MailReceipt, MailToolName, MailWriteTool, MessageKey, MessageRef, UnknownReceipt } from './schemas';
export type { ActivationProof, AttachmentMetadata, CompletedReceipt, ConfirmedReceipt, DraftAddress, DraftContent, DraftPatch, DraftRef, FailedReceipt, MailAddress, Mailbox, MailFailureCode, MailInput, MailInputRaw, MailOperationMarker, MailOutput, MailReceipt, MailToolName, MailWriteTool, MessageFlags, MessageKey, MessageRef, MessageSummary, NewAttachment, PartialReceipt, UnknownReceipt } from './schemas';

/** Catch/map only code. Never expose raw upstream errors, bodies, causes or tokens. */
export class MailError extends Error {
    constructor(public readonly code: MailFailureCode) { super(code); this.name = 'MailError'; }
}
/** Reserved upstream metaData field. Raw marker contents are never public output. */
export const MAIL_OPERATION_METADATA_KEY = 'wildduckMcpOperationV1';
/** Request-local identity; never derive account/token from tool arguments. */
export interface BackendMailSession { readonly accountId: string; readonly accessToken: string }
export interface MailContext extends BackendMailSession {
    readonly clientId: string; readonly scopes: readonly string[]; readonly connectionStatus: ConnectionStatus;
}
export interface ReadMessageResult { readonly message: MailOutput<'read_message'>; readonly marker?: MailOperationMarker }
/** Public metadata contains no duplicate binary. MCP embeds bytes once as resource.blob. */
export interface AttachmentDownload { readonly metadata: MailOutput<'read_attachment'>; readonly bytes: Uint8Array }
export interface MailBackendReader {
    listMailboxes(session: BackendMailSession): Promise<MailOutput<'list_mailboxes'>>;
    listMessages(session: BackendMailSession, input: MailInput<'list_messages'>): Promise<MailOutput<'list_messages'>>;
    searchMessages(session: BackendMailSession, input: MailInput<'search_messages'>): Promise<MailOutput<'search_messages'>>;
    /** No mark-as-seen mutation. HTML and incoming MIME fields are untrusted data.
     * Include private marker in this same GET so service can check one operation,
     * without a second backend GET or N+1 operation lookups on list pages. */
    readMessage(session: BackendMailSession, input: MailInput<'read_message'>): Promise<ReadMessageResult>;
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
/** Backend-verified exact raw-source SHA-256 (64 lowercase hexadecimal characters),
 * distinct from the mutation-relevant snapshot version. Never fabricate this proof. */
export interface VerifiedMessageMutation { readonly message: MessageRef; readonly contentDigest: string }
export interface MailBackendWriter {
    /** Resolve unique specialUse=\\Drafts, never assume a path or caller mailbox. */
    resolveDraftMailbox(session: BackendMailSession): Promise<Mailbox>;
    /** Same digest helper as readMessage: SHA-256 base64url of account/mailbox/UID
     * and FULL UNTRUNCATED raw snapshot: envelope including all Bcc, from/replyTo/
     * to/cc/bcc, subject/messageId/references/date/idate, complete TEXT and HTML,
     * attachment identities/metadata, draft state, raw flags, forwarded, labels,
     * references and custom metadata. Recursively sort JSON keys, preserve array
     * order/exact strings and consistently represent optional missing/null fields.
     * Never hash normalized/truncated public output. No upstream modseq/CAS exists;
     * external webmail/IMAP can still race the inspection and subsequent dispatch. */
    inspectMessage(session: BackendMailSession, target: MessageKey): Promise<MessageSnapshot>;
    /** Read/validate/compose completely BEFORE markDispatched. Pick owned default
     * From when omitted. Patch omissions preserve exact existing MIME and files. */
    prepareCreate(session: BackendMailSession, input: DraftContent, marker: MailOperationMarker): Promise<PreparedDraft>;
    prepareUpdate(session: BackendMailSession, snapshot: MessageSnapshot, patch: DraftPatch, marker: MailOperationMarker): Promise<PreparedDraft>;
    /** Single raw upload WITH marker before visibility; NEVER replacePrevious. */
    uploadPreparedDraft(session: BackendMailSession, prepared: PreparedDraft): Promise<MessageKey>;
    /** Strict source bytes + envelope/flags/labels/references/custom metadata proof. */
    verifyPreparedDraft(session: BackendMailSession, target: MessageKey, prepared: PreparedDraft): Promise<MessageRef>;
    /** Coordinator first checks canonical draft, marker activation, candidate proof
     * where relevant, and fresh original version. No silent delete-after-timeout. */
    deleteDraft(session: BackendMailSession, target: MessageKey): Promise<void>;
    /** After markDispatched: metadata-only PUT, then verify content unchanged.
     * Automatic Sent move inherits this SEND marker. */
    stampSendMarker(session: BackendMailSession, snapshot: MessageSnapshot, marker: MailOperationMarker): Promise<MessageRef>;
    /** Queue acceptance, never delivery. Return Sent key only from actual response. */
    submitDraft(session: BackendMailSession, target: MessageKey): Promise<{ queueId: string; sent?: MessageKey }>;
    /** Move+marker and verify new mapping/content/flags. Never silently relax target. */
    moveMessage(session: BackendMailSession, snapshot: MessageSnapshot, destinationMailboxId: string, marker: MailOperationMarker): Promise<VerifiedMessageMutation>;
    /** PUT requested flags/labels+marker, GET and verify actual requested state. */
    updateMessageFlags(session: BackendMailSession, snapshot: MessageSnapshot, patch: MailInput<'update_message_flags'>, marker: MailOperationMarker): Promise<VerifiedMessageMutation>;
}
export interface OperationKey { readonly accountId: string; readonly clientIdHash: string; readonly operationId: string }
export type WriteIntent = OperationKey & { readonly payloadDigest: string } & (
    | { readonly tool: 'create_draft' }
    | { readonly tool: Exclude<MailWriteTool, 'create_draft'>; readonly target: MessageKey; readonly expectedVersion: string }
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
     * Send's actual receipt.sent key can activate the inherited SEND marker.
     * Flags receipt stays minimal; replay neither refetches nor echoes current sets. */
    complete(claim: OperationClaim<'dispatched'>, receipt: ConfirmedReceipt): Promise<void>;
    /** Any unproved post-dispatch outcome permanently fences the target. */
    markOutcomeUnknown(claim: OperationClaim<'dispatched'>, receipt: UnknownReceipt): Promise<void>;
}
/** Service checks scope + active session BEFORE backend/store: reads mail:read,
 * drafts mail:draft, send mail:send, move/flags mail:modify. Every mutation checks
 * private marker -> durable original operation -> exact target activation proof,
 * except its own staged verification. Unactivated candidates never become sendable.
 * Public writes always pass this coordinator; no raw writer reaches MCP. */
export type MailResult<Name extends MailToolName> = Name extends 'read_attachment' ? AttachmentDownload : MailOutput<Name>;
export type MailService = { [Name in MailToolName]: (context: MailContext, input: MailInput<Name>) => Promise<MailResult<Name>> };
export type BoundMailService = { [Name in MailToolName]: (input: MailInput<Name>) => Promise<MailResult<Name>> };
export type MailWriteCoordinator = Pick<MailService, MailWriteTool>;
export type MailReadService = Omit<MailService, MailWriteTool>;
