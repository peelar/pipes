import { Schema } from 'effect';
import { StepResult } from '../protocol/pipes';

const Request = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const Call = Schema.Struct({
  _meta: Schema.optionalKey(Schema.Unknown),
  arguments: StepResult,
  name: Schema.Literal('report_result'),
});

// Each endpoint authorizes exactly one attempt; it exposes no server control operations.
export function resultMcp(report: (result: typeof StepResult.Type) => Promise<void>) {
  const token = crypto.randomUUID();
  const server = Bun.serve({
    async fetch(request) {
      if (
        request.headers.get('Authorization') !== `Bearer ${token}` ||
        request.headers.has('origin')
      ) {
        return new Response('Forbidden', { status: 403 });
      }
      if (request.method !== 'POST') {
        return new Response(null, { status: 405 });
      }
      let message;
      try {
        message = Schema.decodeUnknownSync(Request)(await request.json());
      } catch {
        return Response.json(
          {
            error: { code: -32_700, message: 'Invalid JSON-RPC request' },
            id: null,
            jsonrpc: '2.0',
          },
          { status: 400 },
        );
      }
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      const reply = (result: unknown) => Response.json({ id: message.id, jsonrpc: '2.0', result });
      switch (message.method) {
        case 'initialize':
          return reply({
            capabilities: { tools: {} },
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'pipes', version: '0.0.1' },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({
            tools: [
              {
                description:
                  'Submit the outcome of your assigned Pipes step exactly once. Completion is applied only after your turn ends successfully.',
                inputSchema: Schema.toJsonSchemaDocument(StepResult).schema,
                name: 'report_result',
              },
            ],
          });
        case 'tools/call':
          try {
            const call = Schema.decodeUnknownSync(Call, { onExcessProperty: 'error' })(
              message.params,
            );
            await report(call.arguments);
            return reply({
              content: [{ text: 'Result recorded. End your turn now.', type: 'text' }],
            });
          } catch (error) {
            return reply({ content: [{ text: String(error), type: 'text' }], isError: true });
          }
        default:
          return Response.json({
            error: { code: -32_601, message: 'Method not found' },
            id: message.id,
            jsonrpc: '2.0',
          });
      }
    },
    hostname: '127.0.0.1',
    maxRequestBodySize: 128 * 1024,
    port: 0,
  });
  return {
    configuration: {
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      name: 'pipes',
      type: 'http' as const,
      url: `http://127.0.0.1:${server.port}/mcp`,
    },
    server,
  };
}
