import { createInterface } from 'node:readline';
import { createMcpCatalogWriter } from '../mcp-listed.ts';
const writer = createMcpCatalogWriter();
const names = JSON.parse(process.env.FIXTURE_TOOLS);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const req = writer.observeRequest(request);
  await req.published;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, ...(process.env.FIXTURE_RESOURCES === '1' ? { resources: {} } : {}) }, serverInfo: { name: 'c11-catalog', version: '1' } };
  else if (request.method === 'fixture/dirty') {
    await writer.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    result = {};
  } else {
    const offset = Number(request.params?.cursor) || 0;
    result = { tools: names.slice(offset, offset + 7).map(name => ({ name, inputSchema: { type: 'object', properties: {} } })), ...(offset + 7 < names.length ? { nextCursor: String(offset + 7) } : {}) };
  }
  await req.respond({ jsonrpc: '2.0', id: request.id, result });
}
