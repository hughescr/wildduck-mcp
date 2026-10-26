import type { Context } from 'hono';
import type { AuthRuntime } from './runtime';
import { AUTH_FIELDS, authorization, form, required, unique, type Authorization } from './http';
import { connectionAAD, digest, equal, randomId } from './crypto';
import { OAuthError, type Sealed, type UpstreamCredentials } from './contracts';
import { WildduckError, type PendingTotp } from '../wildduck';
const COOKIE = '__Host-wildduck-flow';
interface Flow { deadline: number; csrf: string; flowId: string; binding: string; pending?: PendingTotp; credentials?: UpstreamCredentials }
const now = () => Math.floor(Date.now() / 1000);
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const binding = (auth: Authorization) => digest(JSON.stringify(AUTH_FIELDS.map(key => [key, auth.fields[key] ?? null])));
function cookie(context: Context, runtime: AuthRuntime, flow?: Flow) {
    const value = flow ? Buffer.from(JSON.stringify(runtime.crypto.seal('browser-flow', JSON.stringify([runtime.issuer, 1]), flow))).toString('base64url') : '';
    if (value.length > 3800) { throw new OAuthError('invalid_request'); }
    context.header('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${flow ? Math.max(0, flow.deadline - now()) : 0}`);
}
function read(context: Context, runtime: AuthRuntime): Flow {
    try {
        const entries = (context.req.header('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
        if (entries.length !== 1) { throw new Error(); }
        const sealed = JSON.parse(Buffer.from((entries[0] ?? '').slice(COOKIE.length + 1), 'base64url').toString('utf8')) as Sealed;
        const flow = runtime.crypto.open<Flow>('browser-flow', JSON.stringify([runtime.issuer, 1]), sealed);
        if (!Number.isSafeInteger(flow.deadline) || flow.deadline <= now() || flow.deadline > now() + 600 || typeof flow.csrf !== 'string' || typeof flow.binding !== 'string') { throw new Error(); }
        return flow;
    } catch { throw new OAuthError('invalid_request'); }
}
function page(context: Context, title: string, body: string, callbackOrigin?: string) {
    context.header('Content-Security-Policy', `default-src 'none'; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
    context.header('Referrer-Policy', 'same-origin');
    return context.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><main><h1>${escape(title)}</h1>${body}</main></html>`);
}
function render(context: Context, runtime: AuthRuntime, auth: Authorization, flow: Flow) {
    cookie(context, runtime, flow);
    const hidden = [...Object.entries(auth.fields), ['csrf', flow.csrf]].map(([key, value]) => `<input type="hidden" name="${escape(key ?? '')}" value="${escape(value ?? '')}">`).join('');
    const start = (path: string) => `<form method="post" action="${path}">${hidden}`;
    const cancel = '<button name="decision" value="cancel" formnovalidate>Cancel</button></form>';
    if (flow.pending) { return page(context, 'Verify your account', `${start('/auth/mfa')}<label>Authenticator code <input name="totp" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" required></label><button>Verify</button>${cancel}`, new URL(auth.redirectUri).origin); }
    if (flow.credentials) {
        const profile = flow.credentials.profile;
        const identity = auth.client.clientId.startsWith('https://') ? new URL(auth.client.clientId).hostname : 'Registered OAuth client';
        return page(context, 'Authorize connection', `<p>${escape(auth.client.name)} (${escape(identity)}) requests account ${escape(profile.name ?? profile.id)}.</p><p>Redirect destination: ${escape(new URL(auth.redirectUri).hostname)}</p><p>Keep this connection for up to 180 days. Your mail service may require reconnection sooner.</p>${start('/auth/consent')}<ul>${auth.scopes.map(scope => `<li>${escape(scope)}</li>`).join('')}</ul>${auth.scopes.includes('mail:send') ? '<label><input type="checkbox" name="allow_send" value="yes" required> Allow sending mail when future tools support it</label>' : ''}<button name="decision" value="allow">Allow connection</button>${cancel}`, new URL(auth.redirectUri).origin);
    }
    return page(context, 'Connect your mail account', `<p>Sign in to continue to ${escape(auth.client.name)}. TOTP authenticator codes are supported. Passkey-only accounts must use webmail; this origin cannot use existing webmail passkeys.</p>${start('/auth/login')}<label>Username <input name="username" autocomplete="username" required maxlength="254"></label><label>Password <input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button>Sign in</button>${cancel}`, new URL(auth.redirectUri).origin);
}
function redirect(context: Context, runtime: AuthRuntime, auth: Authorization, values: Record<string, string>) {
    context.header('Referrer-Policy', 'no-referrer');
    cookie(context, runtime); const target = new URL(auth.redirectUri);
    for (const [key, value] of Object.entries({ ...values, iss: runtime.issuer, ...(auth.fields.state === undefined ? {} : { state: auth.fields.state }) })) { target.searchParams.set(key, value); }
    return context.redirect(target.href, 302);
}
export async function beginBrowser(context: Context, runtime: AuthRuntime) {
    const auth = await authorization(runtime, unique(new URL(context.req.url).searchParams));
    return render(context, runtime, auth, { deadline: now() + 600, csrf: randomId(), flowId: randomId(), binding: binding(auth) });
}
export async function postBrowser(context: Context, runtime: AuthRuntime) {
    if (context.req.header('origin') !== runtime.issuer) { throw new OAuthError('invalid_request'); }
    const fields = await form(context.req.raw); const flow = read(context, runtime); const auth = await authorization(runtime, fields);
    if (!equal(flow.csrf, required(fields, 'csrf')) || !equal(flow.binding, binding(auth))) { throw new OAuthError('invalid_request'); }
    if (fields.decision === 'cancel') {
        const token = flow.credentials?.accessToken ?? flow.pending?.provisionalToken;
        if (token) { await runtime.wildduck.logout(token); }
        return redirect(context, runtime, auth, { error: 'access_denied' });
    }
    try {
        if (context.req.path === '/auth/login' && !flow.pending && !flow.credentials) {
            const result = await runtime.wildduck.beginLogin(required(fields, 'username'), required(fields, 'password'), flow.flowId);
            flow.csrf = randomId();
            if (result.kind === 'pendingTotp') { flow.pending = result; } else { flow.credentials = result.credentials; }
            return render(context, runtime, auth, flow);
        }
        if (context.req.path === '/auth/mfa' && flow.pending && !flow.credentials) {
            const credentials = await runtime.wildduck.completeTotp(flow.pending, required(fields, 'totp'), flow.flowId);
            if (credentials.profile.id !== flow.pending.accountId) { throw new OAuthError('invalid_request'); }
            delete flow.pending; flow.credentials = credentials; flow.csrf = randomId(); return render(context, runtime, auth, flow);
        }
        if (context.req.path === '/auth/consent' && flow.credentials && !flow.pending && fields.decision === 'allow') {
            if (auth.scopes.includes('mail:send') && fields.allow_send !== 'yes') { throw new OAuthError('invalid_request'); }
            const accountId = flow.credentials.profile.id;
            const previous = await runtime.store.get('connection', accountId);
            if (previous && (previous.kind !== 'connection' || previous.accountId !== accountId)) { throw new OAuthError('invalid_request'); }
            let stored: UpstreamCredentials | undefined;
            if (previous?.kind === 'connection') {
                // This read only detects duplicate delivery. A retired key or damaged
                // old ciphertext must not prevent newly completed authentication from
                // replacing the credential through engine validation and generation CAS.
                try { stored = runtime.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(previous), previous.credentials); }
                catch { stored = undefined; }
            }

            const identical = stored !== undefined && equal(stored.accessToken, flow.credentials.accessToken) && stored.issuedAt === flow.credentials.issuedAt && stored.profile.id === flow.credentials.profile.id && stored.profile.name === flow.credentials.profile.name && stored.profile.email === flow.credentials.profile.email;
            if (identical && previous && (previous.expiresAt <= now() || previous.status !== 'active')) { throw new OAuthError('invalid_grant'); }
            // Duplicate delivery of this consent must not rotate the canonical credential
            // generation and invalidate an already returned code. issueCode validates the
            // backend session and conditions its write on the unchanged connection.
            const connection = identical && previous ? previous : await runtime.engine.connectOrReconnect({ accountId, credentials: flow.credentials, expiresAt: now() + 180 * 86400, ...(previous?.kind === 'connection' ? { expectedCredentialGeneration: previous.credentialGeneration } : {}) });
            const code = await runtime.engine.issueCode({ client: auth.client, connectionId: connection.id, redirectUri: auth.redirectUri, resource: auth.resource, scopes: auth.scopes, challenge: auth.challenge });
            return redirect(context, runtime, auth, { code });
        }
        throw new OAuthError('invalid_request');
    } catch (error) {
        if (!(error instanceof WildduckError)) { throw error; }
        const message = error.code === 'unsupported_mfa' ? 'This account requires an unsupported passkey method. Use webmail; MFA cannot be bypassed.' : error.code === 'action_required' ? 'Complete your account security setup in webmail, then reconnect.' : error.code === 'temporary' ? 'Mail authentication is temporarily unavailable. Try again later.' : 'Sign-in failed. Start the connection again.';
        cookie(context, runtime);
        context.status(error.code === 'temporary' ? 503 : 400);
        return page(context, 'Connection not completed', `<p>${escape(message)}</p>`);
    }
}
