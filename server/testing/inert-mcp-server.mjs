// Isolated transport fixture. It supports initialization/listing and executes no tools.
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  let request; try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'inert-fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
