import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { version } from '../package.json';

/** Called only after an authentication implementation has verified this request. */
export async function handleMcp(request: Request): Promise<Response> {
    const server = new McpServer({ name: 'wildduck-mcp', version });
    server.registerTool('get_service_info', {
        description: 'Describe the service implementation status. No mailbox data is returned.',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async () => ({ content: [{ type: 'text', text: 'wildduck-mcp scaffold: mailbox tools are not implemented.' }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
        const response = await transport.handleRequest(request);
        const body = await response.text();
        return new Response(body || null, { status: response.status, headers: response.headers });
    } finally {
        await server.close();
    }
}
