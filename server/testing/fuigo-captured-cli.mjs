// Fixture process: replay captured Fuigo stdout through the real ACP driver.
// Only the response id is rebound to the live request; payloads stay byte-equal.
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const source = process.argv[2];
if (process.argv.includes('--version')) { console.log('fuigo 1.0.41 (capture replay)'); process.exit(0); }
if (process.argv.includes('models')) { console.log('Default model: flux-auto\nAvailable models:\n  * flux-auto (default)'); process.exit(0); }
const records = readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse);
const promptIndex = records.findIndex(r => r.direction === 'stdin' && JSON.parse(r.line).method === 'session/prompt');
const prompt = JSON.parse(records[promptIndex].line);
const initial = records.find(r => r.direction === 'stdout' && JSON.parse(r.line).id === 1);
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (process.env.FUIGO_REPLAY_REQUESTS) appendFileSync(process.env.FUIGO_REPLAY_REQUESTS, JSON.stringify({ method: m.method }) + '\n');
  const ok = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') ok(JSON.parse(initial.line).result);
  else if (m.method === 'session/new' || m.method === 'session/load') {
    ok({ sessionId: prompt.params.sessionId, _meta: { 'fuigo/permissionPolicy': { sha256: m.params?._meta?.['fuigo/permissionPolicySha256'] } } });
    send({ jsonrpc: '2.0', method: '_fuigo/mcp_initialized', params: { sessionId: prompt.params.sessionId, mcpToolCount: 0, elapsedMs: 1 } });
  }
  else if (m.method === 'session/prompt') {
    for (const r of records.slice(promptIndex + 1)) {
      if (r.direction !== 'stdout') continue;
      const frame = JSON.parse(r.line);
      if (frame.id === prompt.id && !frame.method) {
        // Replace only the numeric routing id; never reserialize error payloads.
        process.stdout.write(r.line.replace(/"id":\s*3(?=,)/, '"id":' + JSON.stringify(m.id)) + '\n');
        break;
      }
      process.stdout.write(r.line + '\n');
    }
  } else if (m.id !== undefined) ok({});
});
