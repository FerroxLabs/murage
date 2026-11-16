import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createMcpCatalogWriter } from '../mcp-listed.ts';
if (process.env.FIXTURE_ARGV_DUMP) writeFileSync(process.env.FIXTURE_ARGV_DUMP, JSON.stringify({ name: process.env.FIXTURE_SERVER_NAME, args: process.argv.slice(1) }));
const launches = process.env.FIXTURE_LAUNCHES;
const ordinal = launches && existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).length : 0;
if (launches) appendFileSync(launches, String(process.pid) + '\n');
const variants = process.env.FIXTURE_CATALOGS ? JSON.parse(process.env.FIXTURE_CATALOGS) : [JSON.parse(process.env.FIXTURE_TOOLS)];
const names = variants[Math.min(ordinal, variants.length - 1)];
const resourceVariants = process.env.FIXTURE_RESOURCE_VARIANTS ? JSON.parse(process.env.FIXTURE_RESOURCE_VARIANTS) : [process.env.FIXTURE_RESOURCES === '1'];
const resources = resourceVariants[Math.min(ordinal, resourceVariants.length - 1)];
const unknown = names === null;
const marker = process.env.MURAGE_MCP_LISTED_FILE;
const writer = createMcpCatalogWriter(unknown || process.env.FIXTURE_NO_CATALOG ? { ...process.env, MURAGE_MCP_LISTED_FILE: '' } : process.env);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const req = writer.observeRequest(request);
  await req.published;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) }, serverInfo: { name: 'c11-catalog', version: '1' }, _fixtureMarker: marker };
  else if (request.method === 'fixture/dirty') {
    await writer.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    result = {};
  } else {
    if (unknown && marker) writeFileSync(marker, String(Date.now()));
    const available = names ?? [];
    const offset = Number(request.params?.cursor) || 0;
    result = { tools: available.slice(offset, offset + 7).map(name => ({ name, inputSchema: { type: 'object', properties: {} } })), ...(offset + 7 < available.length ? { nextCursor: String(offset + 7) } : {}) };
  }
  await req.respond({ jsonrpc: '2.0', id: request.id, result });
}
