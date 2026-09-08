// HTTP authority fixture only: native protocol/version behavior has its own
// native and unit proofs. The real controller, claims and routes stay loaded.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
const event = `async function event(operation, session) {
  const response = await fetch(process.env.MURAGE_BROWSER_FIXTURE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, session }) });
  if (!response.ok) throw new Error('Browser fixture transport failed');
}`;
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true, source: `${event}
    export function createNativeBrowser(spec) { return {
      request: async (method) => method === 'tools/list' ? { tools: [{ name: 'agent_browser_snapshot', inputSchema: { type: 'object', properties: {} } }] } : { content: [{ type: 'text', text: 'fixture page' }] },
      protected: async () => false, resetStream() {}, input() {}, command: async () => '',
      connect: async () => 'fixture-stream', close: async () => event('close', spec.env.AGENT_BROWSER_SESSION),
    }; }
  ` };
  if (url.endsWith('/browser-engine.ts')) {
    const source = readFileSync(new URL(url), 'utf8');
    const start = source.indexOf('export async function verifyAgentBrowserBinary(');
    const end = source.indexOf('export async function ensureChrome(', start);
    if (start < 0 || end < 0) throw new Error('Browser version fixture anchor changed');
    return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start) + event + `
export async function verifyAgentBrowserBinary(binary, env) { await event('verify', env.AGENT_BROWSER_SESSION); }
` + source.slice(end) };
  }
  return nextLoad(url, context);
} });
