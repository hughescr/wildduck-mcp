import type { MailFailureCode, MailOutput, MailToolName, MailWriteTool } from './contracts';
import { mailWriteToolSchema } from './schemas';
/** Plain-language text that explains a tool result. Clients show the model either the structured
 * result or the text content, so the sentences are carried in the result's own summary field.
 * Everything here is built only from server-controlled values (ids, versions, statuses, counts),
 * never from message content, subjects, names or addresses. */
const writeTools: readonly string[] = mailWriteToolSchema.options;
export const isWriteTool = (name: MailToolName): name is MailWriteTool => writeTools.includes(name);
const composes = (name: MailToolName) => name === 'create_draft' || name === 'create_reply_draft' || name === 'update_draft';
/** Plain-language meaning of an error code for this tool, and what to do next. */
export function errorText(code: MailFailureCode, name: MailToolName): string {
    const write = isWriteTool(name);
    const messages: Record<MailFailureCode, string> = {
        forbidden: composes(name) ? 'Refused: the from address is not one of the account\'s own addresses, or the mail server refused the request. Use an address the account owns, or omit from.' : 'The mail server refused this request for this account.',
        reconnect_required: 'The mail account connection has expired or was revoked. Ask the user to reconnect the mail account, then try again.',
        not_found: name === 'create_draft' || name === 'create_reply_draft' ? 'Not found: the original message, or the account\'s Drafts mailbox, does not exist.' : 'The mailbox, message or attachment was not found; it may have been moved or deleted. List or search again for current ids.',
        version_conflict: write ? 'The message has changed since you read it, so expectedVersion no longer matches. Read it again, check what changed, and retry with its new version.' : 'The message changed while it was being read. Read it again.',
        unsupported_draft: write ? 'This works only on a draft in the account\'s Drafts mailbox, and this message is not one.' : 'This message cannot be read by this tool.',
        unsupported_content: composes(name) || name === 'send_draft' ? 'This server cannot do this safely. Usually the draft was not created by this server, or was changed elsewhere since; only drafts created by this server and unchanged since can be edited or sent here, so create a new draft instead. Otherwise the message has content this server cannot keep or reply to.'
            : write ? 'This message has content or metadata this server cannot keep unchanged, so it cannot be changed here.'
            : name === 'get_attachment_download' ? 'This attachment cannot be offered as a download link. Use read_attachment instead (up to 2 MiB).'
            : name === 'get_thread' ? 'This message has no thread id, or has content this tool cannot return.' : 'This message or attachment has content this tool cannot return.',
        source_integrity_unavailable: 'The mail server did not return the complete message, so this cannot be done safely. Try again later.',
        too_large: write ? 'The request is larger than allowed, for example more than 2 MiB of attachments in total, or a body or header over its size limit. Make it smaller.'
            : name === 'read_attachment' ? 'The attachment is larger than 2 MiB. Use get_attachment_download instead (up to 20 MiB).'
            : name === 'get_attachment_download' ? 'The attachment is larger than 20 MiB, so this server cannot provide it.'
            : name === 'read_messages' ? 'This message did not fit in this result, which is capped at 1 MiB. Read it alone with read_message.'
            : name === 'list_messages' || name === 'search_messages' || name === 'get_thread' ? 'The result is larger than this tool can return. Use a smaller limit.' : 'The message is larger than this tool can return; nothing was cut short.',
        verification_failed: name === 'create_draft' || name === 'create_reply_draft' ? 'The new message could not be checked: a header did not read back exactly, or the original message could not be confirmed. Simplify the subject, names or file names and try again.'
            : write ? 'The current state of the message could not be confirmed: an earlier change to it may be unfinished or uncertain, or it was changed outside this server. Read it again (see managedOperation) before deciding what to do.' : 'The mail server returned data that could not be checked. Try again later.',
        no_recipients: write ? 'The draft has no recipients in to, cc or bcc. Add one with update_draft, then send it.' : 'The message has no recipient information.',
        invalid_input: 'The request was rejected as invalid. Check the arguments against the tool\'s input schema.',
        upstream_timeout: 'The mail server did not answer in time. Try again later.',
        temporarily_unavailable: name === 'search_messages' ? 'Mail search is temporarily unavailable. Try again later.' : 'The mail service is temporarily unavailable. Try again later.',
    };
    return messages[code] ?? messages.temporarily_unavailable;
}
/** The new copy's uid and version for a partial result, when the copy was confirmed. */
const savedAs = (result: object): string => {
    const saved = 'candidateVerified' in result && result.candidateVerified === true && 'candidate' in result ? result.candidate as { uid?: unknown; version?: unknown } : undefined;
    return saved !== undefined && typeof saved.uid === 'number' && typeof saved.version === 'string' ? `uid ${saved.uid}, version ${saved.version}` : 'its new uid and version';
};
const partialText: Record<string, (saved: string) => string> = {
    candidate_verification_failed: () => 'Partial: a new draft was saved but could not be confirmed, so this server cannot edit or send it; any old draft was kept. Read the Drafts mailbox and tell the user.',
    original_deletion_failed: saved => `Partial: the updated draft was saved (use ${saved}), but the old copy could not be deleted. Tell the user an older copy may remain in Drafts.`,
    original_deletion_unconfirmed: saved => `Partial: the updated draft was saved (use ${saved}), but deleting the old copy is unconfirmed. Tell the user an older copy may remain in Drafts.`,
    original_version_changed: () => 'Partial: a new copy was saved, but the old draft changed meanwhile, so both were kept and the new copy cannot be edited or sent here. Read the Drafts mailbox and tell the user.',
    original_verification_failed: () => 'Partial: a new copy was saved, but the old draft could not be rechecked, so both were kept and the new copy cannot be edited or sent here. Read the Drafts mailbox and tell the user.',
};
const readBack = 'verified (read back from the mail server, matches your request)';
/** The one-sentence summary of a successful write: what happened and what to use next. */
function successText(name: MailWriteTool, result: MailOutput<MailWriteTool>): string | undefined {
    if ('deleted' in result) { return `Draft uid ${result.deleted.uid} permanently deleted: it was not moved to the Trash mailbox and cannot be recovered through this server.`; }
    if ('draft' in result) {
        const { uid, version } = result.draft;
        if ('previousDeleted' in result) { return `Draft replaced by a new copy, ${readBack}: uid ${uid}, version ${version}; the old copy was deleted (previousDeleted), so the old uid no longer exists.`; }
        return name === 'create_reply_draft'
            ? `Reply draft created and ${readBack}: uid ${uid}, version ${version}; read it to see who it will go to, then use these with update_draft or send_draft.`
            : `Draft created and ${readBack}: uid ${uid}, version ${version}; use these with update_draft or send_draft.`;
    }
    if ('message' in result) {
        const { mailboxId, uid, version } = result.message;
        return name === 'move_message'
            ? `Message moved and verified (read back from the mail server): now uid ${uid} in mailbox ${mailboxId}, version ${version}; use these from now on, the old uid no longer exists.`
            : `Flags changed and verified (read back from the mail server): message uid ${uid}, version ${version}; pass the version as expectedVersion for the next change, and read the message to see all its flags.`;
    }
    if ('queueId' in result) {
        return `Draft sent: accepted by the mail server for delivery (queued), which does not confirm it arrived; ${result.sent === undefined ? 'the mail server reported no copy in Sent' : `the copy in Sent is uid ${result.sent.uid} in mailbox ${result.sent.mailboxId}`}.`;
    }
    return undefined;
}
/** What a write result means, and what to do next: a one-sentence summary on success, an explanation otherwise. */
export function receiptSummary(name: MailWriteTool, result: MailOutput<MailWriteTool>): string | undefined {
    switch (result.status) {
        case 'completed': case 'queued': return successText(name, result);
        case 'failed': return `Not done: ${errorText(result.reason, name)} Nothing was changed; to try again, use a new operationId.`;
        case 'conflict': return result.reason === 'operation_conflict'
            ? 'Conflict: this operationId was already used for a request with other arguments. Nothing was changed. Use a new operationId for a new action.'
            : 'Conflict: another change to this message is unfinished or uncertain, or the message was already moved, replaced, sent or deleted. Nothing was changed. List or read again to find the message and its current uid.';
        case 'in_progress': return 'In progress: no final result is recorded for this operationId yet, and no change is recorded. Retry the identical request once or twice after a few seconds. If it is still in_progress, stop retrying, read the message\'s current state and tell the user. Never repeat the change under a new operationId.';
        case 'outcome_unknown': return 'Outcome unknown: the change was started but its result is not known, so it may or may not have happened. Retrying the identical request only looks up the recorded result and never repeats the change; it may then show the real result, or stay unknown. Do not repeat the change under a new operationId. Check the current state yourself (for a send, look in the Sent mailbox) and tell the user. While it is unknown, the affected message cannot be changed through this server.';
        case 'partial': return partialText[result.reason]?.(savedAs(result));
        default: return undefined;
    }
}
type BatchResults = MailOutput<'read_messages'>['results'];
/** Counts of failed and cut-short items in a batch of reads, as a sentence; undefined when all are complete.
 * The mail service measures this sentence into the 1 MiB read_messages result, so it is worked out there. */
export function batchSummary(results: BatchResults): string | undefined {
    const failed = results.filter(item => item.status === 'failed').length;
    const cut = results.filter(item => item.status === 'ok' && (item.message.textTruncated || 'htmlTruncated' in item.message && item.message.htmlTruncated)).length;
    const parts = [...failed ? [`${failed} could not be read (see the error in each failed item)`] : [], ...cut ? [`${cut} ${cut === 1 ? 'is' : 'are'} cut short (textTruncated or htmlTruncated is true), so do not treat ${cut === 1 ? 'it' : 'them'} as complete`] : []];
    return parts.length ? `Of ${results.length} messages, ${parts.join(' and ')}.` : undefined;
}
/** Explains the parts of a successful read result that an agent could misread. */
export function readSummary(name: MailToolName, result: MailOutput<MailToolName>): string | undefined {
    const notes: string[] = [];
    if (name === 'read_message' && 'textTruncated' in result) {
        const cut = [...result.textTruncated ? ['text (textTruncated)'] : [], ...'htmlTruncated' in result && result.htmlTruncated ? ['HTML (htmlTruncated)'] : []];
        if (cut.length) { notes.push(`Incomplete read: the ${cut.join(' and ')} is or may be cut short. Do not treat it as the complete message.`); }
        const verification = 'managedOperation' in result ? result.managedOperation?.verification : undefined;
        if (verification === 'verified') { notes.push('This message was created or last changed through this server and that change is confirmed (managedOperation.verification is verified). If it is a draft created here and no other mail client has changed it since, it can be edited or sent here.'); }
        else if (verification !== undefined) { notes.push(`This server cannot change this message (managedOperation.verification is ${verification}): its last change made here is unfinished, uncertain or could not be confirmed.`); }
    }
    if ((name === 'list_messages' || name === 'search_messages' || name === 'get_thread') && 'messages' in result) {
        const unchecked = result.messages.filter(message => message.managedOperation?.verification === 'not_checked').length;
        if (unchecked) { notes.push(`${unchecked} of these messages ${unchecked === 1 ? 'was' : 'were'} created or changed through this server; managedOperation.verification is not_checked in lists, so read the message to find out whether it can be edited or sent here.`); }
    }
    if (name === 'search_messages' && 'search' in result && !result.search.complete) { notes.push('Fast search returned only confirmed matches and may have missed some. To find every match, repeat the same search from the first page with searchMode: "exhaustive" (slower).'); }
    // read_messages is not handled here: the service supplies its summary, because it counts toward the result's 1 MiB.
    const bodies = name === 'get_thread' && 'bodies' in result ? result.bodies?.results : undefined;
    const bodiesSummary = bodies && batchSummary(bodies);
    if (bodiesSummary) { notes.push(bodiesSummary); }
    return notes.length ? notes.join(' ') : undefined;
}
/** The summary field of a tool result, or undefined when the result needs no explanation.
 * Only read_messages arrives with its summary already in place (measured into its byte count); every other tool's is worked out here. */
export function resultSummary(name: MailToolName, result: MailOutput<MailToolName>): string | undefined {
    if (name === 'read_messages') { return 'summary' in result ? result.summary : undefined; }
    return isWriteTool(name) ? receiptSummary(name, result as MailOutput<MailWriteTool>) : readSummary(name, result);
}
