// tools/flux-stream-sim/server.ts
// A local stand-in for Flux's streaming transcription endpoint (spec D).
//   pnpm flux-stream:sim -- --port 8787 --provider scripted|assemblyai [--faults] [--keys <file>] [--provider-default-turns]
// Keys are never logged. Only known keys are paid keys; magic keys drive the error paths.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { LEASE_MS, PING_EVERY_MS, SESSION_STARTS_PER_MINUTE, STREAM_PATH, SUBPROTOCOL, USAGE_EVERY_MS, fatal, parseConnectQuery, type StreamError } from "../../shared/flux-stream-contract.ts";
import { REJECT_CODE, merge, parseFaults, type Faults } from "./faults.ts";
import type { Provider } from "./provider.ts";
import { SimSession, type LeaseRow } from "./session.ts";

export interface SimOptions {
  port?: number;
  provider: Provider;
  /** Used when a connect carries sim_trace (Task 4). */
  traceProvider?: Provider;
  allowFaults?: boolean;
  pingMs?: number;
  usageEveryMs?: number;
  leaseMs?: number;
  /** key -> account, on top of the built-in sim keys. */
  keys?: Record<string, string>;
  maxConcurrentPerAccount?: number;
  /** Session starts allowed across all accounts in a sliding 60 s window. */
  startsPerMinute?: number;
  log?: (line: string) => void;
}

const PATHS = new Set([`/v1${STREAM_PATH}`, STREAM_PATH]);
const MAGIC: Record<string, string> = {
  sim_bad: "unauthorized",
  sim_free: "premium_locked",
  sim_noCredit: "credit_exhausted",
  sim_nobilling: "billing_unavailable", // a paying key with no usable billing identity (Astra 6 I3)
  sim_forbidden: "forbidden",
  sim_dark: "not_found",
};
const BUILT_IN_KEYS: Record<string, string> = { sim_key: "acct-1", sim_key2: "acct-2", sim_limited: "acct-limited" };

function bearer(req: IncomingMessage): string | null {
  const auth = (req.headers.authorization ?? "").trim();
  if (/^bearer\s+\S+/i.test(auth)) return auth.replace(/^bearer\s+/i, "");
  const xak = String(req.headers["x-api-key"] ?? "").trim();
  return xak || null;
}

export async function createSimServer(options: SimOptions) {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const keys: Record<string, string> = { ...BUILT_IN_KEYS, ...(options.keys ?? {}) };
  let globalFaults: Faults = {};
  const openPerAccount = new Map<string, number>();
  const sessions = new Set<SimSession>();
  const ledger: LeaseRow[] = [];
  let startTimes: number[] = []; // one fleet-wide sliding window, all accounts
  const http = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__sim/faults" && options.allowFaults) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let parsed: { spec?: string; open?: boolean };
        try {
          const value: unknown = JSON.parse(body || "{}");
          if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
          parsed = value as { spec?: string; open?: boolean };
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "body must be a JSON object", type: "invalid_request_error" } }));
          return;
        }
        const faults = parseFaults(parsed.spec ?? "");
        if (parsed.open) {
          for (const s of sessions) s.arm(faults);
          log(`[sim] faults armed on ${sessions.size} open session(s): ${parsed.spec ?? ""}`);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ applied: [...sessions].map((s) => s.id) }));
          return;
        }
        globalFaults = faults;
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
  });
  const wss = new WebSocketServer({
    noServer: true,
    // Called only when the client offered subprotocols. Echo an unknown offer
    // so the handshake completes and the client can read unsupported_protocol.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : ([...protocols][0] ?? false)),
  });

  http.on("upgrade", (req, socket: Socket, head) => {
    const url = new URL(req.url ?? "/", "http://sim");
    if (!PATHS.has(url.pathname)) return void socket.destroy();
    const faults = merge(globalFaults, options.allowFaults ? parseFaults(url.searchParams.get("sim_fault")) : {});
    if (faults.reject === 503) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n" +
        JSON.stringify({ error: { message: "service unavailable", type: "api_error", code: "service_unavailable" } }));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void accept(ws, req, url, faults));
  });

  const refuse = (ws: WebSocket, error: StreamError) => {
    ws.send(JSON.stringify({ type: "error", seq: 1, received_audio_ms: 0, error }));
    ws.close(error.close_code ?? 4500, error.code);
  };

  async function accept(ws: WebSocket, req: IncomingMessage, url: URL, faults: Faults) {
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (offered.length && !offered.includes(SUBPROTOCOL)) return refuse(ws, fatal("unsupported_protocol", `offer ${SUBPROTOCOL}`));
    const parsed = parseConnectQuery(url.searchParams, ["sim_fault", "sim_script", "sim_trace"]);
    if (!parsed.ok && parsed.error.code === "invalid_param" && parsed.error.message.includes("Authorization")) return refuse(ws, parsed.error);
    const key = bearer(req);
    if (!key) return refuse(ws, fatal("unauthorized", "unauthorized"));
    if (MAGIC[key]) return refuse(ws, fatal(MAGIC[key], MAGIC[key] === "premium_locked" ? "streaming transcription requires a paid plan" : MAGIC[key]));
    const account = keys[key];
    if (!account) return refuse(ws, fatal("unauthorized", "unauthorized"));
    if (!parsed.ok) return refuse(ws, parsed.error);
    if (faults.reject) return refuse(ws, fatal(REJECT_CODE[faults.reject], "simulated refusal", faults.reject === 429 ? { retry_after_ms: 5000 } : {}));
    // fleet-wide start rate, checked before concurrency so the two refusals stay distinct
    const now = Date.now();
    startTimes = startTimes.filter((t) => now - t < 60_000);
    if (startTimes.length >= (options.startsPerMinute ?? SESSION_STARTS_PER_MINUTE)) {
      return refuse(ws, fatal("service_unavailable", "too many session starts", { retry_after_ms: Math.max(1, startTimes[0] + 60_000 - now) }));
    }
    // counted once auth and params pass: a start the concurrency check refuses below still uses the window, deliberately
    startTimes.push(now);
    const limit = account === "acct-limited" ? 1 : (options.maxConcurrentPerAccount ?? 4);
    const count = openPerAccount.get(account) ?? 0;
    if (count >= limit) return refuse(ws, fatal("concurrency_limit", "too many open streams for this account", { retry_after_ms: 5000 }));
    openPerAccount.set(account, count + 1);
    const trace = url.searchParams.get("sim_trace") ?? undefined;
    const session = new SimSession({
      ws,
      account,
      config: parsed.config,
      ignored: parsed.ignored,
      provider: trace && options.traceProvider ? options.traceProvider : options.provider,
      faults,
      script: url.searchParams.get("sim_script")?.split("|"),
      trace,
      pingMs: options.pingMs ?? PING_EVERY_MS,
      usageEveryMs: options.usageEveryMs ?? USAGE_EVERY_MS,
      leaseMs: options.leaseMs ?? LEASE_MS,
      ledger,
      log,
      onEnd: () => {
        sessions.delete(session);
        openPerAccount.set(account, Math.max(0, (openPerAccount.get(account) ?? 1) - 1));
      },
    });
    sessions.add(session);
    await session.start();
  }

  await new Promise<void>((resolve) => http.listen(options.port ?? 8787, "127.0.0.1", () => resolve()));
  const port = (http.address() as AddressInfo).port;
  return {
    baseUrl: `ws://127.0.0.1:${port}/v1`,
    setFaults(f: Faults) {
      globalFaults = f;
    },
    ledger: () => [...ledger],
    openSessions: () => [...sessions].map((s) => s.id),
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const which = arg("provider") ?? "scripted";
  const provider: Provider =
    which === "assemblyai"
      ? (await import("./providers/assemblyai.ts")).assemblyAIProvider({ keyFile: arg("key-file"), omitTurnKnobs: process.argv.includes("--provider-default-turns") })
      : (await import("./providers/scripted.ts")).scriptedProvider();
  const traceProvider = (await import("./providers/trace.ts")).traceProvider();
  const keys: Record<string, string> = {};
  if (arg("keys")) for (const line of readFileSync(arg("keys")!, "utf8").split("\n")) {
    const [k, a] = line.trim().split("=");
    if (k && a) keys[k] = a;
  }
  const sim = await createSimServer({ port: Number(arg("port") ?? 8787), provider, traceProvider, keys, allowFaults: process.argv.includes("--faults") });
  process.stdout.write(`flux-stream-sim: ${sim.baseUrl} provider=${provider.name} faults=${process.argv.includes("--faults")}\n`);
}
