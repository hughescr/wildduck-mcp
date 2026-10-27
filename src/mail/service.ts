import { digest, randomId } from '../auth/crypto';
import { MailError, type ActivationProof, type AttachmentDownload, type BackendMailSession, type ConfirmedReceipt, type FailedReceipt, type MailBackendReader, type MailBackendWriter, type MailContext, type MailInput, type MailOperationMarker, type MailOperationRecord, type MailOperationStore, type MailOutput, type MailService, type MailToolName, type MailWriteTool, type MessageKey, type MessageRef, type MessageSnapshot, type OperationClaim, type OperationKey, type PreparedDraft, type UnknownReceipt, type WriteIntent } from './contracts';
import { activationProofSchema, draftContentSchema, failureReasonSchema, mailboxSchema, mailInputSchemas, mailOperationMarkerSchema, mailOutputSchemas, messageKeySchema, messageRefSchema } from './schemas';

interface Dependencies { reader: MailBackendReader; writer: MailBackendWriter; operations: MailOperationStore }
type WriteInput = MailInput<MailWriteTool>;
type ReadTool = Exclude<MailToolName, MailWriteTool | 'read_attachment'>;
type Verification = 'verified' | 'pending' | 'outcome_unknown' | 'unverified';
const temporary = () => new MailError('temporarily_unavailable');
function sanitized(error: unknown): MailError {
    const code = error instanceof MailError ? failureReasonSchema.safeParse(error.code) : undefined;
    return code?.success ? new MailError(code.data) : temporary();
}
function stable(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(stable).join(',')}]`; }
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function session(context: MailContext, scope: string): BackendMailSession {
    if (!context || typeof context.accountId !== 'string' || !/^[a-f0-9]{24}$/u.test(context.accountId) || typeof context.accessToken !== 'string' || !/^[a-fA-F0-9]{40}$/u.test(context.accessToken) || typeof context.clientId !== 'string' || context.clientId.length < 1 || context.clientId.length > 16384 || !Array.isArray(context.scopes) || !context.scopes.every(value => typeof value === 'string')) { throw new MailError('forbidden'); }
    if (context.connectionStatus !== 'active') { throw new MailError('reconnect_required'); }
    if (!context.scopes.includes(scope)) { throw new MailError('forbidden'); }
    return { accountId: context.accountId, accessToken: context.accessToken };
}
function input<Name extends MailToolName>(tool: Name, raw: unknown): MailInput<Name> {
    const result = mailInputSchemas[tool].safeParse(raw);
    if (!result.success) { throw new MailError('invalid_input'); }
    return result.data as MailInput<Name>;
}
function output<Name extends MailToolName>(tool: Name, raw: unknown): MailOutput<Name> {
    const result = mailOutputSchemas[tool].safeParse(raw);
    if (!result.success) { throw temporary(); }
    return result.data as MailOutput<Name>;
}
const sameKey = (left: OperationKey, right: OperationKey) => left.accountId === right.accountId && left.clientIdHash === right.clientIdHash && left.operationId === right.operationId;
const sameMessage = (left: MessageKey, right: MessageKey) => left.mailboxId === right.mailboxId && left.uid === right.uid;
function matches(record: MailOperationRecord, key: OperationKey, tool: MailWriteTool, parsed: WriteInput, payloadDigest: string): boolean {
    if (!sameKey(record.key, key) || !sameKey(record.intent, key) || record.intent.tool !== tool || record.intent.payloadDigest !== payloadDigest) { return false; }
    if (tool === 'create_draft') { return record.intent.tool === 'create_draft'; }
    return 'uid' in parsed && record.intent.tool !== 'create_draft' && record.intent.target.uid === parsed.uid && record.intent.expectedVersion === parsed.expected_version && /^[a-f0-9]{24}$/u.test(record.intent.target.mailboxId) && (!('mailboxId' in parsed) || record.intent.target.mailboxId === parsed.mailboxId);
}
function receipt(tool: MailWriteTool, record: MailOperationRecord): MailOutput<MailWriteTool> {
    if (record.state === 'reserved') { return output(tool, { status: 'in_progress', operation_id: record.key.operationId }); }
    if (record.state === 'dispatched') { return output(tool, { status: 'outcome_unknown', operation_id: record.key.operationId, reason: 'dispatch_uncertain' }); }
    if (record.state !== 'settled' || record.receipt.operation_id !== record.key.operationId) { throw temporary(); }
    if (!['completed', 'queued', 'partial', 'failed', 'outcome_unknown'].includes(record.receipt.status)) { throw temporary(); }
    return output(tool, record.receipt);
}
function proof(accountId: string, message: MessageRef, contentDigest: string): ActivationProof {
    const result = activationProofSchema.safeParse({ accountId, ...message, contentDigest });
    if (!result.success) { throw temporary(); }
    return result.data;
}

/** Every mutation has a durable receipt and an account-wide message fence. */
export function createMailService({ reader, writer, operations }: Dependencies): MailService {
    async function verification(bound: BackendMailSession, target: MessageKey, rawMarker: MailOperationMarker): Promise<Verification> {
        const parsed = mailOperationMarkerSchema.safeParse(rawMarker);
        if (!parsed.success || parsed.data.accountId !== bound.accountId) { return 'unverified'; }
        const marker = parsed.data;
        const record = await operations.getOperation({ accountId: marker.accountId, clientIdHash: marker.clientIdHash, operationId: marker.operationId });
        if (!record || !sameKey(record.key, marker) || !sameKey(record.intent, marker) || record.intent.tool !== marker.tool || record.intent.payloadDigest !== marker.payloadDigest) { return 'unverified'; }
        if (record.state === 'reserved') { return 'pending'; }
        if (record.state === 'dispatched') { return 'outcome_unknown'; }
        const result = receipt(marker.tool, record);
        if (result.status === 'outcome_unknown') { return 'outcome_unknown'; }
        if (result.status === 'queued') { return result.sent && sameMessage(result.sent, target) ? 'verified' : 'unverified'; }
        // Identity is historical. Later flag/version changes do not invalidate an
        // activated account/mailbox/UID, nor can fresh expected_version activate it.
        if ('proof' in result && result.proof.accountId === bound.accountId && sameMessage(result.proof, target)) {
            if (result.status === 'completed') { return 'verified'; }
            if (result.status === 'partial' && result.candidateVerified && ['original_deletion_failed', 'original_deletion_unconfirmed'].includes(result.reason)) { return 'verified'; }
        }
        return 'unverified';
    }
    async function activated(bound: BackendMailSession, snapshot: MessageSnapshot): Promise<void> {
        if (snapshot.marker && await verification(bound, snapshot.message, snapshot.marker) !== 'verified') { throw new MailError('verification_failed'); }
    }
    async function inspect(bound: BackendMailSession, target: MessageKey, expectedVersion: string, requireDraft: boolean): Promise<MessageSnapshot> {
        const snapshot = await writer.inspectMessage(bound, target);
        const message = messageRefSchema.parse(snapshot.message);
        if (!sameMessage(message, target) || typeof snapshot.isDraft !== 'boolean' || typeof snapshot.hasHtml !== 'boolean' || typeof snapshot.hasAttachments !== 'boolean' || typeof snapshot.hasRecipients !== 'boolean') { throw temporary(); }
        await activated(bound, snapshot);
        if (message.version !== expectedVersion) { throw new MailError('version_conflict'); }
        if (requireDraft && !snapshot.isDraft) { throw new MailError('unsupported_draft'); }
        return snapshot;
    }
    async function read<Name extends ReadTool>(tool: Name, context: MailContext, raw: MailInput<Name>): Promise<MailOutput<Name>> {
        const bound = session(context, 'mail:read'); const parsed = input(tool, raw);
        try {
            let result: unknown;
            switch (tool) {
                case 'list_mailboxes': result = await reader.listMailboxes(bound); break;
                case 'list_messages': result = await reader.listMessages(bound, parsed as MailInput<'list_messages'>); break;
                case 'search_messages': result = await reader.searchMessages(bound, parsed as MailInput<'search_messages'>); break;
                case 'read_message': {
                    const read = await reader.readMessage(bound, parsed as MailInput<'read_message'>);
                    if (!sameMessage(read.message, parsed as MailInput<'read_message'>)) { throw temporary(); }
                    const { managedOperation: _managedOperation, ...message } = read.message;
                    result = read.marker ? { ...message, managedOperation: { operationId: mailOperationMarkerSchema.parse(read.marker).operationId, verification: await verification(bound, message, read.marker) } } : message;
                    break;
                }
            }
            return output(tool, result);
        } catch (error) { throw sanitized(error); }
    }
    async function attachment(context: MailContext, raw: MailInput<'read_attachment'>): Promise<AttachmentDownload> {
        const bound = session(context, 'mail:read'); const parsed = input('read_attachment', raw);
        try {
            const result = await reader.readAttachment(bound, parsed);
            const metadata = output('read_attachment', result.metadata);
            if (!sameMessage(metadata, parsed) || metadata.attachmentId !== parsed.attachmentId || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== metadata.size) { throw temporary(); }
            return { metadata, bytes: new Uint8Array(result.bytes) };
        } catch (error) { throw sanitized(error); }
    }
    async function write(tool: MailWriteTool, context: MailContext, raw: WriteInput): Promise<MailOutput<MailWriteTool>> {
        const scope = tool === 'send_draft' ? 'mail:send' : tool === 'move_message' || tool === 'update_message_flags' ? 'mail:modify' : 'mail:draft';
        const bound = session(context, scope); const parsed = input(tool, raw);
        const key: OperationKey = { accountId: bound.accountId, clientIdHash: digest(context.clientId), operationId: parsed.operation_id };
        const { operation_id: _operationId, ...payload } = parsed;
        const payloadDigest = digest(stable({ accountId: bound.accountId, tool, input: payload }));
        const marker: MailOperationMarker = { ...key, payloadDigest, tool };
        const conflict = (reason: 'operation_conflict' | 'draft_fenced') => output(tool, { status: 'conflict', operation_id: key.operationId, reason });
        const checkedReplay = (record: MailOperationRecord) => matches(record, key, tool, parsed, payloadDigest) ? receipt(tool, record) : conflict('operation_conflict');
        let existing: MailOperationRecord | undefined;
        try { existing = await operations.getOperation(key); } catch (error) { throw sanitized(error); }
        if (existing) { return checkedReplay(existing); }
        let mailboxId: string;
        try {
            if (tool === 'move_message' || tool === 'update_message_flags') { mailboxId = (parsed as MailInput<'move_message'>).mailboxId; }
            else {
                const mailbox = mailboxSchema.parse(await writer.resolveDraftMailbox(bound));
                if (mailbox.specialUse !== '\\Drafts') { throw new MailError('unsupported_draft'); }
                mailboxId = mailbox.mailboxId;
            }
        } catch (error) { throw sanitized(error); }
        const intent: WriteIntent = tool === 'create_draft' ? { ...key, payloadDigest, tool } : {
            ...key, payloadDigest, tool, target: { mailboxId, uid: (parsed as MailInput<'send_draft'>).uid }, expectedVersion: (parsed as MailInput<'send_draft'>).expected_version,
        };
        const ownerToken = randomId(); let claim: OperationClaim<'reserved'>;
        try {
            const reservation = await operations.reserve(intent, ownerToken);
            if (reservation.kind === 'conflict') { return conflict(reservation.reason); }
            if (reservation.kind === 'replay') { return checkedReplay(reservation.record); }
            claim = reservation.claim;
            if (claim.state !== 'reserved' || !sameKey(claim.key, key) || claim.ownerToken !== ownerToken || !Number.isSafeInteger(claim.revision) || claim.revision < 0) { throw temporary(); }
        } catch (error) { throw sanitized(error); }
        let snapshot: MessageSnapshot | undefined; let prepared: PreparedDraft | undefined;
        try {
            if (intent.tool !== 'create_draft') {
                snapshot = await inspect(bound, intent.target, intent.expectedVersion, tool !== 'move_message' && tool !== 'update_message_flags');
                if (tool === 'send_draft' && !snapshot.hasRecipients) { throw new MailError('no_recipients'); }
            }
            if (tool === 'create_draft') {
                const { operation_id: _id, ...content } = parsed as MailInput<'create_draft'>;
                prepared = await writer.prepareCreate(bound, draftContentSchema.parse(content), marker);
            } else if (tool === 'update_draft' && snapshot) {
                const { operation_id: _id, uid: _uid, expected_version: _version, ...patch } = parsed as MailInput<'update_draft'>;
                prepared = await writer.prepareUpdate(bound, snapshot, patch, marker);
            }
            if ((tool === 'create_draft' || tool === 'update_draft') && !prepared) { throw temporary(); }
            if (prepared && (prepared.mailboxId !== mailboxId || stable(mailOperationMarkerSchema.parse(prepared.marker)) !== stable(marker) || !/^[a-f0-9]{64}$/u.test(prepared.mime.sha256))) { throw temporary(); }
        } catch (error) {
            const failed: FailedReceipt = { status: 'failed', operation_id: key.operationId, reason: sanitized(error).code };
            try { await operations.failPreflight(claim, failed); } catch { throw temporary(); }
            return output(tool, failed);
        }
        const unknown: UnknownReceipt = { status: 'outcome_unknown', operation_id: key.operationId, reason: 'dispatch_uncertain' };
        async function saved(): Promise<MailOutput<MailWriteTool> | undefined> {
            try { const record = await operations.getOperation(key); if (record && record.state === 'settled' && matches(record, key, tool, parsed, payloadDigest)) { return receipt(tool, record); } } catch { /* No durable outcome can be proved. */ }
            return undefined;
        }
        async function uncertain(dispatched?: OperationClaim<'dispatched'>): Promise<MailOutput<MailWriteTool>> {
            const known = await saved(); if (known) { return known; }
            if (dispatched) {
                try { await operations.markOutcomeUnknown(dispatched, unknown); } catch { /* Existing fence remains in place. */ }
                const settled = await saved(); if (settled) { return settled; }
            }
            return output(tool, unknown);
        }
        let dispatched: OperationClaim<'dispatched'>;
        try {
            dispatched = await operations.markDispatched(claim);
            if (dispatched.state !== 'dispatched' || !sameKey(dispatched.key, key) || dispatched.ownerToken !== ownerToken || !Number.isSafeInteger(dispatched.revision) || dispatched.revision <= claim.revision) { return uncertain(); }
        } catch {
            try {
                const record = await operations.getOperation(key);
                if (record && matches(record, key, tool, parsed, payloadDigest)) {
                    if (record.state === 'settled') { return receipt(tool, record); }
                    if (record.state === 'dispatched' && record.ownerToken === ownerToken) { return uncertain({ key, ownerToken, revision: record.revision, state: 'dispatched' }); }
                }
            } catch { /* Explicit uncertainty without dispatching. */ }
            return output(tool, unknown);
        }
        async function finish(result: unknown): Promise<MailOutput<MailWriteTool>> {
            const validated = output(tool, result);
            await operations.complete(dispatched, validated as ConfirmedReceipt);
            return validated;
        }
        try {
            if ((tool === 'create_draft' || tool === 'update_draft') && prepared) {
                const candidate = messageKeySchema.parse(await writer.uploadPreparedDraft(bound, prepared));
                if (candidate.mailboxId !== mailboxId || (intent.tool !== 'create_draft' && sameMessage(candidate, intent.target))) { throw temporary(); }
                let verified: MessageRef;
                try {
                    verified = messageRefSchema.parse(await writer.verifyPreparedDraft(bound, candidate, prepared));
                    if (!sameMessage(candidate, verified)) { throw temporary(); }
                } catch {
                    return await finish({ status: 'partial', operation_id: key.operationId, candidate, candidateVerified: false, reason: 'candidate_verification_failed', originalDeletion: 'not_attempted' });
                }
                const activation = proof(bound.accountId, verified, prepared.mime.sha256);
                if (intent.tool === 'create_draft') { return await finish({ status: 'completed', operation_id: key.operationId, draft: verified, verified: true, proof: activation }); }
                try { await inspect(bound, intent.target, intent.expectedVersion, true); } catch (error) {
                    return await finish({ status: 'partial', operation_id: key.operationId, candidate: verified, candidateVerified: true, proof: activation, reason: error instanceof MailError && error.code === 'version_conflict' ? 'original_version_changed' : 'original_verification_failed', originalDeletion: 'not_attempted' });
                }
                try { await writer.deleteDraft(bound, intent.target); } catch (error) {
                    const confirmedFailure = error instanceof MailError && ['forbidden', 'not_found', 'unsupported_draft'].includes(error.code);
                    return await finish({ status: 'partial', operation_id: key.operationId, candidate: verified, candidateVerified: true, proof: activation, reason: confirmedFailure ? 'original_deletion_failed' : 'original_deletion_unconfirmed', originalDeletion: confirmedFailure ? 'failed' : 'unconfirmed' });
                }
                return await finish({ status: 'completed', operation_id: key.operationId, draft: verified, verified: true, proof: activation, previousDeleted: true });
            }
            if (intent.tool === 'create_draft' || !snapshot) { throw temporary(); }
            if (tool === 'delete_draft') {
                await writer.deleteDraft(bound, intent.target);
                return await finish({ status: 'completed', operation_id: key.operationId, deleted: intent.target });
            }
            if (tool === 'send_draft') {
                const stamped = messageRefSchema.parse(await writer.stampSendMarker(bound, snapshot, marker));
                if (!sameMessage(stamped, intent.target)) { throw temporary(); }
                const result = await writer.submitDraft(bound, intent.target);
                return await finish({ status: 'queued', operation_id: key.operationId, queueId: result.queueId, ...(result.sent === undefined ? {} : { sent: messageKeySchema.parse(result.sent) }) });
            }
            const mutation = tool === 'move_message'
                ? await writer.moveMessage(bound, snapshot, (parsed as MailInput<'move_message'>).destinationMailboxId, marker)
                : await writer.updateMessageFlags(bound, snapshot, parsed as MailInput<'update_message_flags'>, marker);
            const message = messageRefSchema.parse(mutation.message);
            if (tool === 'move_message' ? message.mailboxId !== (parsed as MailInput<'move_message'>).destinationMailboxId : !sameMessage(message, intent.target)) { throw temporary(); }
            return await finish({ status: 'completed', operation_id: key.operationId, message, verified: true, proof: proof(bound.accountId, message, mutation.contentDigest) });
        } catch { return uncertain(dispatched); }
    }
    return {
        list_mailboxes: (context, raw) => read('list_mailboxes', context, raw),
        list_messages: (context, raw) => read('list_messages', context, raw),
        search_messages: (context, raw) => read('search_messages', context, raw),
        read_message: (context, raw) => read('read_message', context, raw),
        read_attachment: attachment,
        create_draft: (context, raw) => write('create_draft', context, raw) as Promise<MailOutput<'create_draft'>>,
        update_draft: (context, raw) => write('update_draft', context, raw) as Promise<MailOutput<'update_draft'>>,
        delete_draft: (context, raw) => write('delete_draft', context, raw) as Promise<MailOutput<'delete_draft'>>,
        send_draft: (context, raw) => write('send_draft', context, raw) as Promise<MailOutput<'send_draft'>>,
        move_message: (context, raw) => write('move_message', context, raw) as Promise<MailOutput<'move_message'>>,
        update_message_flags: (context, raw) => write('update_message_flags', context, raw) as Promise<MailOutput<'update_message_flags'>>,
    };
}
