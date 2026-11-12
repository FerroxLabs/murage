// Offline ACP peer: launch only the descriptors received over ACP, unchanged.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const children = new Set();
const log = row => appendFileSync(process.env.C11_LOG, JSON.stringify(row) + '\n');
const out = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const wait = async file => { while (!existsSync(file)) await new Promise(r => setTimeout(r, 10)); };
async function mount(descriptor) {
  log({ event: 'launch', descriptor });
  const child = spawn(descriptor.command, descriptor.args, { env: { ...process.env, ...Object.fromEntries(descriptor.env.map(e => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.stderr.on('data', data => process.stderr.write(data));
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line);
    log({ event: 'forward', name: descriptor.name, frame });
    pending.get(frame.id)?.(frame); pending.delete(frame.id);
  });
  const rpc = (id, method) => new Promise(resolve => {
    pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
  });
  await rpc(1, 'initialize');
  await rpc(2, 'tools/list');
  // C-1: a later list, driven once the test releases it, after a refused first publication.
  if (process.env.C11_RELIST) { await wait(process.env.C11_RELIST); await rpc(3, 'tools/list'); }
}
createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line);
  log({ event: 'acp', msg });
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (msg.method === 'session/new' || msg.method === 'session/load') {
    await Promise.all(msg.params.mcpServers.map(mount));
    // A real engine answers session/load only after its mounts have listed; the load gate lets a test hold that answer.
    await wait(msg.method === 'session/load' && process.env.C11_RELEASE_LOAD ? process.env.C11_RELEASE_LOAD : process.env.C11_RELEASE_SESSION);
    out({ id: msg.id, result: { sessionId: msg.params.sessionId ?? 'offline-session' } });
  } else if (msg.method === 'session/prompt') {
    out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Offline chain complete' } } } });
    // Keep the turn and its authenticated publisher alive for lifetime checks.
    await wait(process.env.C11_FINISH);
    out({ id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id !== undefined) out({ id: msg.id, result: {} });
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('close', resolve); child.kill();
  })));
  process.exit();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.stdin.on('end', stop);
