import type { BackendSessionValidator, Connection, UpstreamCredentials } from './auth/contracts';
import { AuthCrypto, connectionAAD } from './auth/crypto';

export const WILDDUCK_ORIGIN = 'https://wildduck-api.rungie.com';
const ACCOUNT = /^[a-f0-9]{24}$/;
const TOKEN = /^[a-fA-F0-9]{40}$/;
const MAX_BODY = 64 * 1024;
type Profile = UpstreamCredentials['profile'];
export interface PendingTotp {
    kind: 'pendingTotp'; accountId: string; profile: Profile; nonce: string;
    provisionalToken?: string; issuedAt: number;
}
export type LoginResult = { kind: 'authenticated'; credentials: UpstreamCredentials } | PendingTotp;
export interface InboxSubject { uid: number; subject: string }
export type WildduckErrorCode = 'invalid_input' | 'authentication_failed' | 'action_required' | 'unsupported_mfa' | 'temporary';
/** Messages deliberately contain neither upstream bodies nor credentials. */
export class WildduckError extends Error {
    constructor(public readonly code: WildduckErrorCode) { super(code); }
}
export interface WildduckOptions {
    issuer: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; now?: () => number;
}
type Json = Record<string, unknown>;
function object(value: unknown): value is Json { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
function profileValid(value: unknown, accountId: string): value is Profile {
    return object(value) && value['id'] === accountId && (value['name'] === undefined || typeof value['name'] === 'string') &&
        (value['email'] === undefined || (typeof value['email'] === 'string' && email(value['email'])));
}
function email(value: string): boolean { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function flow(flowId?: string): Json {
    if (flowId === undefined) { return {}; }
    if (!flowId || flowId.length > 255) { throw new WildduckError('invalid_input'); }
    return { sess: flowId };
}

export class WildduckClient {
    private readonly fetcher: typeof globalThis.fetch;
    private readonly issuer: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    constructor(options: WildduckOptions) {
        const issuer = new URL(options.issuer);
        if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.pathname !== '/' || issuer.search || issuer.hash) {
            throw new WildduckError('invalid_input');
        }
        this.issuer = issuer.origin;
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) { throw new WildduckError('invalid_input'); }
        this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    }
    private async request(path: string, method: 'GET' | 'POST' | 'DELETE', body?: Json, accessToken?: string): Promise<{ status: number; body: Json }> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = async () => {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (body) { headers['Content-Type'] = 'application/json'; }
            if (accessToken !== undefined) { headers['X-Access-Token'] = accessToken; }
            const response = await this.fetcher(`${WILDDUCK_ORIGIN}${path}`, {
                method, headers, redirect: 'error', signal: controller.signal,
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
            if (response.redirected || response.status >= 300 && response.status < 400 ||
                !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { throw new WildduckError('temporary'); }
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) { throw new WildduckError('temporary'); }
            if (!response.body) { throw new WildduckError('temporary'); }
            const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
            const cancel = () => { void reader.cancel().catch(() => {}); };
            controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) {
                    const chunk = await reader.read(); if (chunk.done) { break; }
                    size += chunk.value.byteLength;
                    if (size > MAX_BODY) { throw new WildduckError('temporary'); }
                    chunks.push(chunk.value);
                }
                const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                if (!object(parsed)) { throw new WildduckError('temporary'); }
                return { status: response.status, body: parsed };
            } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        };
        try {
            return await Promise.race([operation(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new WildduckError('temporary')); }, this.timeoutMs);
            })]);
        } catch { throw new WildduckError('temporary'); }
        finally { if (timer !== undefined) { clearTimeout(timer); } controller.abort(); }
    }
    /** Sole bootstrap paths: intentionally omit X-Access-Token so the verified nginx
     * tokenAuth fallback can authenticate/issue tokens. Never use this path for user APIs. */
    async beginLogin(username: string, password: string, flowId?: string): Promise<LoginResult> {
        if (typeof username !== 'string' || !username || username.length > 254 || typeof password !== 'string' || !password || password.length > 256) {
            throw new WildduckError('invalid_input');
        }
        const issuedAt = this.now();
        const result = await this.request('/authenticate', 'POST', { username, password, scope: 'master', token: true, protocol: 'wildduck-mcp', appId: this.issuer, ...flow(flowId) });
        if (result.status !== 200) { throw new WildduckError(result.status === 403 && result.body['code'] === 'AuthFailed' ? 'authentication_failed' : 'temporary'); }
        const value = result.body;
        if (value['success'] !== true || value['error'] !== undefined || value['code'] !== undefined || typeof value['id'] !== 'string' || !ACCOUNT.test(value['id']) ||
            typeof value['username'] !== 'string' || !value['username'] || value['scope'] !== 'master' ||
            (value['requirePasswordChange'] !== undefined && typeof value['requirePasswordChange'] !== 'boolean') ||
            (value['require2faEnabled'] !== undefined && typeof value['require2faEnabled'] !== 'boolean') ||
            (value['token'] !== undefined && !validToken(value['token']))) { throw new WildduckError('temporary'); }
        if (value['requirePasswordChange'] === true) { throw new WildduckError('action_required'); }
        // Backend echoes the enrollment policy flag even for enrolled users. Existing
        // methods still require a verified challenge; only missing enrollment needs webmail.
        if (value['require2faEnabled'] === true && (value['require2fa'] === false || Array.isArray(value['require2fa']) && value['require2fa'].length === 0)) { throw new WildduckError('action_required'); }
        const accountId = value['id'];
        if (value['address'] !== undefined && (typeof value['address'] !== 'string' || !email(value['address']))) { throw new WildduckError('temporary'); }
        const profile: Profile = { id: accountId, name: value['username'], ...(typeof value['address'] === 'string' ? { email: value['address'] } : {}) };
        if (value['require2fa'] === false) {
            if (!validToken(value['token'])) { throw new WildduckError('temporary'); }
            return { kind: 'authenticated', credentials: { accessToken: value['token'], profile, issuedAt } };
        }
        const methods = value['require2fa'];
        if (!Array.isArray(methods) || !methods.length || methods.some(method => typeof method !== 'string')) { throw new WildduckError('temporary'); }
        if (!methods.includes('totp') || methods.some(method => method !== 'totp' && method !== 'webauthn')) { throw new WildduckError('unsupported_mfa'); }
        const nonce = value['totpNonce'] ?? value['twoFactorNonce'];
        if (!validToken(nonce) || value['totpNonce'] !== undefined && value['twoFactorNonce'] !== undefined && value['totpNonce'] !== value['twoFactorNonce']) { throw new WildduckError('temporary'); }
        // The provisional token is only returned inside pending state, which the browser must encrypt.
        return { kind: 'pendingTotp', accountId, profile, nonce, issuedAt, ...(validToken(value['token']) ? { provisionalToken: value['token'] } : {}) };
    }
    async completeTotp(pending: PendingTotp, totp: string, flowId?: string): Promise<UpstreamCredentials> {
        if (!pending || pending.kind !== 'pendingTotp' || !ACCOUNT.test(pending.accountId) || !profileValid(pending.profile, pending.accountId) ||
            !validToken(pending.nonce) || !Number.isSafeInteger(pending.issuedAt) || pending.issuedAt > this.now() || this.now() - pending.issuedAt >= 600 ||
            pending.provisionalToken !== undefined && !validToken(pending.provisionalToken) || typeof totp !== 'string' || !/^\d{6}$/.test(totp)) { throw new WildduckError('invalid_input'); }
        // Second and final bootstrap method; nonce binds the challenge to the validated account.
        const result = await this.request(`/users/${pending.accountId}/2fa/totp/check`, 'POST', { token: totp, totpNonce: pending.nonce, ...flow(flowId) });
        if (result.status === 403 && result.body['code'] === 'InvalidToken') { throw new WildduckError('authentication_failed'); }
        if (result.status !== 200 || result.body['success'] !== true || result.body['error'] !== undefined || result.body['code'] !== undefined || (result.body['token'] !== undefined && !validToken(result.body['token']))) { throw new WildduckError('temporary'); }
        const accessToken = result.body['token'] ?? pending.provisionalToken;
        if (!validToken(accessToken)) { throw new WildduckError('temporary'); }
        return { accessToken, profile: pending.profile, issuedAt: pending.issuedAt };
    }
    async validateCredentials(credentials: UpstreamCredentials): Promise<'valid' | 'expired' | 'temporary'> {
        // Fail before fetch: no omitted/empty header may reach nginx's bootstrap fallback.
        if (!credentials || !validToken(credentials.accessToken) || !credentials.profile || !ACCOUNT.test(credentials.profile.id) ||
            !profileValid(credentials.profile, credentials.profile.id) || !Number.isSafeInteger(credentials.issuedAt)) { return 'temporary'; }
        try {
            const result = await this.request('/authenticated', 'GET', undefined, credentials.accessToken);
            if (result.status === 403 && result.body['code'] === 'InvalidToken') { return 'expired'; }
            return result.status === 200 && result.body['success'] === true && result.body['error'] === undefined && result.body['code'] === undefined ? 'valid' : 'temporary';
        } catch { return 'temporary'; }
    }
    /** Resolve only this account's canonical INBOX, then batch-list newest received mail.
     * The backend summary includes extra metadata; discard it without fetching messages. */
    async listInboxSubjects(accountId: string, credentials: UpstreamCredentials, limit = 10): Promise<InboxSubject[]> {
        if (!ACCOUNT.test(accountId) || !credentials || !validToken(credentials.accessToken) ||
            !profileValid(credentials.profile, accountId) || !Number.isSafeInteger(credentials.issuedAt) ||
            !Number.isInteger(limit) || limit < 1 || limit > 20) { throw new WildduckError('invalid_input'); }
        const get = async (path: string) => {
            const response = await this.request(path, 'GET', undefined, credentials.accessToken);
            if (response.status === 403 && response.body['code'] === 'InvalidToken') { throw new WildduckError('authentication_failed'); }
            if (response.status !== 200 || response.body['success'] !== true || response.body['error'] !== undefined || response.body['code'] !== undefined) { throw new WildduckError('temporary'); }
            return response.body;
        };
        const mailbox = await get(`/users/${accountId}/mailboxes/resolve?path=INBOX`);
        if (mailbox['path'] !== 'INBOX' || typeof mailbox['id'] !== 'string' || !ACCOUNT.test(mailbox['id'])) { throw new WildduckError('temporary'); }
        // Omit unseen entirely: false would restrict results to already-seen messages.
        const listing = await get(`/users/${accountId}/mailboxes/${mailbox['id']}/messages?limit=${limit}&order=desc`);
        const messages = listing['results'];
        if (!Array.isArray(messages) || messages.length > limit) { throw new WildduckError('temporary'); }
        const seen = new Set<number>();
        return messages.map((message: unknown) => {
            if (!object(message) || !Number.isSafeInteger(message['id']) || typeof message['id'] !== 'number' || message['id'] < 1 || message['id'] > 4294967295 ||
                typeof message['subject'] !== 'string' || seen.has(message['id']) || message['mailbox'] !== mailbox['id']) { throw new WildduckError('temporary'); }
            seen.add(message['id']);
            return { uid: message['id'], subject: message['subject'] };
        });
    }
    /** Best effort only: upstream may report success despite a Redis revocation failure. */
    async logout(accessToken: string): Promise<boolean> {
        if (!validToken(accessToken)) { return false; }
        try { const result = await this.request('/authenticate', 'DELETE', undefined, accessToken); return result.status === 200 && result.body['success'] === true; }
        catch { return false; }
    }
}
export class WildduckSessionValidator implements BackendSessionValidator {
    constructor(private readonly client: WildduckClient, private readonly crypto: AuthCrypto) {}
    async validate(connection: Connection): Promise<'valid' | 'expired' | 'temporary'> {
        try {
            if (connection.id !== connection.accountId || !ACCOUNT.test(connection.accountId) || connection.status !== 'active') { return 'temporary'; }
            const credentials = this.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(connection), connection.credentials);
            if (credentials.profile?.id !== connection.accountId) { return 'temporary'; }
            return await this.client.validateCredentials(credentials);
        } catch { return 'temporary'; }
    }
}
