import "../../shared/win-hide-child-process.mjs";
import {exitWithChildIoReceipt} from "../io-child-receipts.ts";
// Turn-side stdio MCP bridge for the own-server computer on a Cloud home. It
// replaces vps-container-mcp.ts, which needs SSH the turn does not have.
//
// Run with no argument it is the same bridge the desktop uses (mcp-bridge.ts:
// the who-is-driving gate and the tool-list rewrite) around a child of itself
// started with "pipe". That child connects to the home server's relay
// (vps-mcp-relay.ts) with the turn's own control token and pipes
// newline-delimited JSON-RPC both ways: one WebSocket text message per line.
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { runMcpBridge } from "../mcp-bridge.ts";
import { proxyTransportLost } from "../proxy-turn-release.ts";

const PATH = "/api/internal/vps-mcp/v1/stdio";
const MAX_LINE_BYTES = 8 * 1_048_576;

function fail(_message: string, code = 1): never {
  proxyTransportLost("vpsRelayMcp");
  process.stderr.write("vps relay failures=1\n");
  process.exit(code);
}

const controlUrl = process.env.MURAGE_CONTROL_URL ?? "";
const controlToken = process.env.MURAGE_CONTROL_TOKEN ?? "";
let target = "";
try {
  const origin = new URL(controlUrl);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = PATH;
  origin.search = "";
  target = origin.toString();
} catch { /* reported below */ }
if (!target || !controlToken) fail("own-server computer relay unavailable", 2);

if (process.argv[2] !== "pipe") {
  runMcpBridge({
    releaseRole: "vpsRelayMcp",
    command: process.execPath,
    args: [...process.execArgv, fileURLToPath(import.meta.url), "pipe"],
    label: "Own-server Cua Driver",
    gate: { url: controlUrl, token: controlToken },
  });
} else {
  // Raw child transport only. The outer bridge owns raw-intake charging and
  // the final release gate; this child has neither release credentials nor IPC.
  const upstream = new WebSocket(target, { headers: { authorization: `Bearer ${controlToken}` }, maxPayload: MAX_LINE_BYTES, handshakeTimeout: 15_000 });
  let opened = false;
  let finished = false;
  const finish = (code: number, message?: string) => {
    if (finished) return;
    finished = true;
    if (message) process.stderr.write("vps relay failures=1\n");
    process.exitCode = code;
    try { upstream.terminate(); } catch { /* gone */ }
    process.stdin.pause();
    // Let stdout drain before the process ends on its own; backstop in case a handle lingers.
    setTimeout(() => { void exitWithChildIoReceipt(code); }, 2_000).unref();
  };

  upstream.on("error", () => finish(1, opened ? "own-server computer relay lost" : "own-server computer relay unavailable"));
  upstream.on("unexpected-response", () => finish(1, "own-server computer relay unavailable"));
  upstream.on("close", () => finish(opened ? 0 : 1, opened ? undefined : "own-server computer relay unavailable"));
  let received = Promise.resolve();
  upstream.on("message", (data, isBinary) => {
    if (isBinary) { finish(1); return; }
    upstream.pause();
    received = received.then(async () => {
      if (finished) return;
      const line = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString("utf8");
      if (/[\r\n]/.test(line)) { finish(1); return; }
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(line + "\n", error => error ? reject(error) : resolve());
      });
      if (!finished) upstream.resume();
    }).catch(() => finish(1));
  });
  upstream.on("open", () => {
    opened = true;
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at).replace(/\r$/, "");
        buffered = buffered.slice(at + 1);
        if (line) upstream.send(line);
      }
      if (buffered.length > MAX_LINE_BYTES) finish(1, "own-server computer message too large");
    });
    process.stdin.on("end", () => { try { upstream.close(1000, "closed"); } catch { /* gone */ } });
  });
}
