import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { version } from '../package.json';
import { handleMcp } from './mcp';

export interface VerifiedConnection {
    readonly connectionId: string;
    readonly accountId: string;
}

export type AuthenticationResult =
    | { readonly status: 'unavailable' }
    | { readonly status: 'invalid' }
    | { readonly status: 'verified'; readonly connection: VerifiedConnection };

/** Integration seam; production has no verifier until the OAuth implementation lands. */
export interface Authenticator {
    verify(request: Request): Promise<AuthenticationResult>;
}

const unavailableAuthenticator: Authenticator = { verify: async () => ({ status: 'unavailable' }) };

export function createApp(authenticator: Authenticator = unavailableAuthenticator) {
    const app = new Hono();
    app.use('*', secureHeaders());
    app.use('*', async (context, next) => {
        context.header('Cache-Control', 'no-store');
        await next();
    });
    app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: (context) => context.json({ error: 'payload_too_large' }, 413) }));
    app.get('/healthz', (context) => context.json({ service: 'wildduck-mcp', version, status: 'scaffold' }));
    app.get('/readyz', (context) => context.json({ ready: false, reason: 'oauth_not_implemented' }, 503));
    app.all('/mcp', async (context) => {
        // A supplied bearer/header is never itself proof of authentication.
        const result = await authenticator.verify(context.req.raw);
        if (result.status === 'unavailable') {
            return context.json({ error: 'service_not_ready', message: 'OAuth and mailbox access are not implemented.' }, 503);
        }
        if (result.status === 'invalid') {
            context.header('WWW-Authenticate', 'Bearer realm="wildduck-mcp", error="invalid_token"');
            return context.json({ error: 'invalid_token' }, 401);
        }
        // Never retain connection identity or backend credentials in shared globals.
        return handleMcp(context.req.raw);
    });
    app.notFound((context) => context.json({ error: 'not_found' }, 404));
    app.onError((_error, context) => context.json({ error: 'internal_error' }, 500));
    return app;
}
