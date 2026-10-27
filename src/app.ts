import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { version } from '../package.json';
import { handleMcp } from './mcp';
import type { BoundMailService, MailContext } from './mail/contracts';
import { loadConfig, type Config } from './config';
import { createRuntimeProvider, type RuntimeProvider } from './auth/runtime';
import { authenticate, authorization, boundedText, challenge, form, metadata, required, scopes, unique, SCOPES } from './auth/http';
import { beginBrowser, postBrowser } from './auth/browser';
import { OAuthError, type UpstreamCredentials } from './auth/contracts';
import { ClientError } from './auth/clients';
import { connectionAAD } from './auth/crypto';
export interface AppOptions { config?: Config; runtime?: RuntimeProvider }
export function createApp(options: AppOptions = {}) {
    const config = options.config ?? loadConfig(); const runtime = options.runtime ?? createRuntimeProvider(config);
    const app = new Hono();
    app.use('*', secureHeaders({ referrerPolicy: false }));
    app.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); context.header('Referrer-Policy', 'no-referrer'); await next(); });
    app.use('/mcp', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: context => context.json({ error: 'payload_too_large' }, 413) }));
    app.use('*', async (context, next) => {
        if (context.req.method === 'OPTIONS') { context.header('Access-Control-Allow-Origin', '*'); context.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version'); context.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); return context.body(null, 204); }
        if (['/register', '/token', '/revoke', '/mcp'].includes(context.req.path) || context.req.path.startsWith('/.well-known/')) { context.header('Access-Control-Allow-Origin', '*'); context.header('Access-Control-Expose-Headers', 'WWW-Authenticate'); }
        await next();
    });
    app.get('/healthz', context => context.json({ service: 'wildduck-mcp', version, status: 'oauth' }));
    app.get('/readyz', async context => { const ready = Boolean(await runtime()); return context.json({ ready }, ready ? 200 : 503); });
    app.get('/.well-known/oauth-authorization-server', context => config.publicBaseUrl ? context.json(metadata(config.publicBaseUrl)) : context.json({ error: 'service_not_ready' }, 503));
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        app.get(path, context => config.publicBaseUrl ? context.json({ resource: `${config.publicBaseUrl}/mcp`, authorization_servers: [config.publicBaseUrl], bearer_methods_supported: ['header'], scopes_supported: SCOPES }) : context.json({ error: 'service_not_ready' }, 503));
    }
    app.get('/authorize', async context => { const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } return beginBrowser(context, auth); });
    app.post('/auth/:step', async context => { if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); } const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } return postBrowser(context, auth); });
    app.post('/register', async context => {
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        if (!/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') ?? '')) { throw new OAuthError('invalid_request'); }
        let raw: unknown; try { raw = JSON.parse(await boundedText(context.req.raw)); } catch { throw new OAuthError('invalid_request'); }
        return context.json(auth.clients.register(raw), 201);
    });
    app.post('/token', async context => {
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        unique(new URL(context.req.url).searchParams);
        if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); }
        const fields = await form(context.req.raw); const client = await authenticate(auth, context.req.raw, fields);
        const resource = required(fields, 'resource');
        if (fields.grant_type === 'authorization_code') {
            const request = await authorization(auth, { client_id: client.clientId, redirect_uri: required(fields, 'redirect_uri'), resource, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'x'.repeat(43) });
            return context.json(await auth.engine.exchange({ client: request.client, code: required(fields, 'code'), verifier: required(fields, 'code_verifier'), redirectUri: request.redirectUri, resource }));
        }
        if (fields.grant_type === 'refresh_token') { return context.json(await auth.engine.refresh({ client, refreshToken: required(fields, 'refresh_token'), resource, ...(fields.scope === undefined ? {} : { scopes: scopes(fields.scope) }) })); }
        return context.json({ error: 'unsupported_grant_type' }, 400);
    });
    app.post('/revoke', async context => { if (new URL(context.req.url).search) { throw new OAuthError('invalid_request'); } const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); } const fields = await form(context.req.raw); const client = await authenticate(auth, context.req.raw, fields); await auth.engine.revoke(required(fields, 'token'), client); return context.body(null, 200); });
    app.all('/mcp', async context => {
        if (!config.publicBaseUrl) { return context.json({ error: 'service_not_ready' }, 503); }
        const header = context.req.header('authorization');
        const unauthorized = () => { const value = challenge(config.publicBaseUrl ?? ''); context.header('WWW-Authenticate', value); return context.json({ error: 'invalid_token', _meta: { 'mcp/www_authenticate': [value] } }, 401); };
        if (!header || !/^Bearer [A-Za-z0-9._~-]+$/i.test(header)) { return unauthorized(); }
        const auth = await runtime(); if (!auth) { return context.json({ error: 'service_not_ready' }, 503); }
        try {
            const token = header.slice(7); const identity = await auth.engine.verifyAccess(token);
            const [grant, record] = await Promise.all([auth.store.get('grant', identity.grantId), auth.store.get('connection', identity.connectionId)]);
            if (grant?.kind !== 'grant' || record?.kind !== 'connection') { return unauthorized(); }
            const credentials = auth.crypto.open<UpstreamCredentials>('upstream-credentials', connectionAAD(record), record.credentials);
            if (record.accountId !== identity.accountId || record.id !== identity.connectionId || credentials.profile?.id !== identity.accountId) { return unauthorized(); }
            if (identity.connectionStatus === 'active') {
                const state = await auth.wildduck.validateCredentials(credentials);
                if (state === 'temporary') { return context.json({ error: 'temporarily_unavailable' }, 503); }
                if (state === 'expired') { return unauthorized(); }
            }
            const mailContext: MailContext = Object.freeze({ accountId: identity.accountId, accessToken: credentials.accessToken, clientId: grant.clientId, scopes: Object.freeze([...identity.scopes]), connectionStatus: record.expiresAt <= Math.floor(Date.now() / 1000) ? 'reconnect_required' : record.status });
            const mail: BoundMailService = {
                list_mailboxes: input => auth.mail.list_mailboxes(mailContext, input),
                list_messages: input => auth.mail.list_messages(mailContext, input),
                search_messages: input => auth.mail.search_messages(mailContext, input),
                read_message: input => auth.mail.read_message(mailContext, input),
                get_thread: input => auth.mail.get_thread(mailContext, input),
                read_messages: input => auth.mail.read_messages(mailContext, input),
                get_attachment_download: input => auth.mail.get_attachment_download(mailContext, input),
                read_attachment: input => auth.mail.read_attachment(mailContext, input),
                move_message: input => auth.mail.move_message(mailContext, input),
                update_message_flags: input => auth.mail.update_message_flags(mailContext, input),
                create_reply_draft: input => auth.mail.create_reply_draft(mailContext, input),
                create_draft: input => auth.mail.create_draft(mailContext, input),
                update_draft: input => auth.mail.update_draft(mailContext, input),
                delete_draft: input => auth.mail.delete_draft(mailContext, input),
                send_draft: input => auth.mail.send_draft(mailContext, input),
            };
            return handleMcp(context.req.raw, { token, clientId: grant.clientId, scopes: identity.scopes, resource: new URL(auth.engine.resource) }, mail);

        } catch (error) { if (error instanceof OAuthError && error.error !== 'temporarily_unavailable') { return unauthorized(); } throw error; }
    });
    app.notFound(context => context.json({ error: 'not_found' }, 404));
    app.onError((error, context) => {
        if (error instanceof OAuthError || error instanceof ClientError) {
            const temporary = error.error === 'temporarily_unavailable';
            if (error.error === 'invalid_client') { context.header('WWW-Authenticate', 'Basic realm="oauth"'); }
            return context.json({ error: error.error, ...(error.error === 'invalid_grant' ? { error_description: 'Reconnect your mail account and authorize this client again.' } : {}) }, temporary ? 503 : error.error === 'invalid_client' ? 401 : 400);
        }
        return context.json({ error: 'temporarily_unavailable' }, 503);
    });
    return app;
}
