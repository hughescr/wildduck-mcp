import { McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { version } from '../package.json';
import type { AuthContext, UpstreamCredentials } from './auth/contracts';
const profileJson = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } }, required: ['id'], additionalProperties: false };
const profileSchema: StandardSchemaWithJSON = { '~standard': { version: 1, vendor: 'wildduck-mcp', jsonSchema: { input: () => profileJson, output: () => profileJson }, validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return { issues: [{ message: 'Invalid profile' }] }; }
    const profile = value as Record<string, unknown>;
    return typeof profile.id === 'string' && Object.entries(profile).every(([key, field]) => ['id', 'name', 'email'].includes(key) && typeof field === 'string') ? { value } : { issues: [{ message: 'Invalid profile' }] };
} } };
export async function
 handleMcp(request: Request, authInfo: AuthInfo, identity: AuthContext, profile: UpstreamCredentials['profile']): Promise<Response> {
    const server = new McpServer({ name: 'wildduck-mcp', version });
    const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    server.registerTool('get_service_info', { description: 'Describe supported connection tools. Mail tools are not available.', annotations }, async () => ({ content: [{ type: 'text', text: 'OAuth connection service. Mail tools are not available.' }] }));
    for (const name of ['get_profile', 'whoami']) {
        server.registerTool(name, { description: 'Return the connected account identity.', annotations, outputSchema: profileSchema }, async ctx => {
            if (!ctx.http?.authInfo || !ctx.http?.authInfo.scopes.includes('profile')) { return { isError: true, content: [{ type: 'text', text: 'The profile scope is required.' }] }; }
            return { structuredContent: { ...profile, id: identity.accountId }, content: [{ type: 'text', text: JSON.stringify({ ...profile, id: identity.accountId }) }], _meta: { 'openai/profile': { ...profile, id: identity.accountId } } };
        });
    }
    server.registerTool('get_connection_status', { description: 'Report whether the mail connection needs reconnection.', annotations }, async ctx => ({ structuredContent: { status: identity.connectionStatus, accountId: identity.accountId }, content: [{ type: 'text', text: ctx.http?.authInfo ? identity.connectionStatus === 'active' ? 'Connected. Reconnection may be required when the mail session expires.' : 'Reconnect your account using the client OAuth connection flow.' : 'Authentication required.' }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { const response = await transport.handleRequest(request, { authInfo }); return new Response(await response.text() || null, { status: response.status, headers: response.headers }); }
    finally { await server.close(); }
}
