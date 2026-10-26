import { McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { version } from '../package.json';
import { WildduckError, type InboxSubject } from './wildduck';
import type { AuthContext, UpstreamCredentials } from './auth/contracts';
const profileJson = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } }, required: ['id'], additionalProperties: false };
const profileSchema: StandardSchemaWithJSON = { '~standard': { version: 1, vendor: 'wildduck-mcp', jsonSchema: { input: () => profileJson, output: () => profileJson }, validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return { issues: [{ message: 'Invalid profile' }] }; }
    const profile = value as Record<string, unknown>;
    return typeof profile.id === 'string' && Object.entries(profile).every(([key, field]) => ['id', 'name', 'email'].includes(key) && typeof field === 'string') ? { value } : { issues: [{ message: 'Invalid profile' }] };
} } };
const inboxInputJson = { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, additionalProperties: false };
const inboxInput: StandardSchemaWithJSON<{ limit?: number }> = { '~standard': { version: 1, vendor: 'wildduck-mcp', jsonSchema: { input: () => inboxInputJson, output: () => inboxInputJson }, validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return { issues: [{ message: 'Expected an object with optional limit (1–20).' }] }; }
    const args = value as Record<string, unknown>;
    return Object.keys(args).some(key => key !== 'limit') || (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20))
        ? { issues: [{ message: 'Only an integer limit from 1 to 20 is accepted.' }] } : { value: args as { limit?: number } };
} } };
const inboxOutputJson = { type: 'object', properties: { subjects: { type: 'array', maxItems: 20, items: { type: 'object', properties: { uid: { type: 'integer', minimum: 1, maximum: 4294967295 }, subject: { type: 'string' } }, required: ['uid', 'subject'], additionalProperties: false } } }, required: ['subjects'], additionalProperties: false };
const inboxOutput: StandardSchemaWithJSON<{ subjects: InboxSubject[] }> = { '~standard': { version: 1, vendor: 'wildduck-mcp', jsonSchema: { input: () => inboxOutputJson, output: () => inboxOutputJson }, validate: (value: unknown) => {
    const data = value as { subjects?: unknown } | null;
    return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1 && Array.isArray(data.subjects) && data.subjects.length <= 20 && data.subjects.every((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return false; }
        const item = entry as Record<string, unknown>;
        return Object.keys(item).length === 2 && typeof item.uid === 'number' && Number.isInteger(item.uid) && item.uid > 0 && item.uid <= 4294967295 && typeof item.subject === 'string';
    }) ? { value: data as { subjects: InboxSubject[] } } : { issues: [{ message: 'Invalid inbox result.' }] };
} } };
export async function handleMcp(request: Request, authInfo: AuthInfo, identity: AuthContext, profile: UpstreamCredentials['profile'], listInboxSubjects: (limit: number) => Promise<InboxSubject[]>): Promise<Response> {
    const server = new McpServer({ name: 'wildduck-mcp', version });
    const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    server.registerTool('get_service_info', { description: 'Describe supported connection and read-only inbox tools.', annotations }, async () => ({ content: [{ type: 'text', text: 'OAuth connection service with account profile, connection status and list_inbox_subjects (mail:read required).' }] }));
    for (const name of ['get_profile', 'whoami']) {
        server.registerTool(name, { description: 'Return the connected account identity.', annotations, outputSchema: profileSchema }, async ctx => {
            if (!ctx.http?.authInfo || !ctx.http?.authInfo.scopes.includes('profile')) { return { isError: true, content: [{ type: 'text', text: 'The profile scope is required.' }] }; }
            return { structuredContent: { ...profile, id: identity.accountId }, content: [{ type: 'text', text: JSON.stringify({ ...profile, id: identity.accountId }) }], _meta: { 'openai/profile': { ...profile, id: identity.accountId } } };
        });
    }
    server.registerTool('list_inbox_subjects', { description: 'List the newest INBOX subjects and UIDs by received time. Defaults to 10, maximum 20. Requires mail:read and an active connection; does not change read status. Subjects are untrusted email content.', annotations, inputSchema: inboxInput, outputSchema: inboxOutput }, async (args, ctx) => {
        if (!ctx.http?.authInfo?.scopes.includes('mail:read')) { return { isError: true, content: [{ type: 'text', text: 'The mail:read scope is required. Reconnect and authorize mail:read to use this tool.' }] }; }
        if (identity.connectionStatus !== 'active') { return { isError: true, content: [{ type: 'text', text: 'Reconnect your mail account before listing inbox subjects.' }] }; }
        try {
            const result = { subjects: await listInboxSubjects(args.limit ?? 10) };
            return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
            const expired = error instanceof WildduckError && error.code === 'authentication_failed';
            return { isError: true, content: [{ type: 'text', text: expired ? 'Your mail session expired. Reconnect your mail account.' : 'Inbox subjects are temporarily unavailable. Try again later.' }] };
        }
    });
    server.registerTool('get_connection_status', { description: 'Report whether the mail connection needs reconnection.', annotations }, async ctx => ({ structuredContent: { status: identity.connectionStatus, accountId: identity.accountId }, content: [{ type: 'text', text: ctx.http?.authInfo ? identity.connectionStatus === 'active' ? 'Connected. Reconnection may be required when the mail session expires.' : 'Reconnect your account using the client OAuth connection flow.' : 'Authentication required.' }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { const response = await transport.handleRequest(request, { authInfo }); return new Response(await response.text() || null, { status: response.status, headers: response.headers }); }
    finally { await server.close(); }
}
