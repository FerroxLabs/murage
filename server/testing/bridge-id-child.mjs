// A scripted MCP child for the bridge id namespace tests (mcp-bridge-namespace.test.ts).
// It records every raw line it receives to CHILD_RECORD, answers a request at once (or holds it with params.hold until
// told), and obeys notifications the engine side sends through the bridge: x/release, x/dup, x/raw, x/closestdin.
import { appendFileSync } from "node:fs";

const record = process.env.CHILD_RECORD;
const held = new Map();
const answered = new Map();
const out = (line) => process.stdout.write(line + "\n");
const resultFor = (m) => (m.method === "tools/list" ? { tools: [{ name: `t${m.params?.n}` }] } : { n: m.params?.n });
const answer = (m, n) => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: m.id, result: resultFor(m) });
  answered.set(n, line);
  out(line);
};

function handle(raw) {
  appendFileSync(record, raw + "\n");
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.method === "x/release") { const h = held.get(m.params.n); if (h) { held.delete(m.params.n); answer(h, m.params.n); } return; }
  if (m.method === "x/dup") { const line = answered.get(m.params.n); if (line) out(line); return; }
  if (m.method === "x/raw") { out(m.params.line); return; }
  if (m.method === "x/closestdin") { process.stdin.destroy(); setTimeout(() => process.exit(0), 1500); return; }
  if (typeof m.method !== "string" || m.id === undefined) return;
  if (m.method === "x/big") { out(`{"jsonrpc":"2.0","id":${JSON.stringify(m.id)},"result":{"big":98765432109876543210}}`); return; }
  const n = m.params?.n;
  if (m.params?.hold) held.set(n, m);
  else answer(m, n);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) handle(line); }
});
