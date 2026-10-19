// VPS MCP relay: on a Cloud home a turn cannot open SSH, so the own-server
// computer's MCP stream is bridged through this server. The turn script
// (vps-relay-mcp.ts) connects a WebSocket to /api/internal/vps-mcp/v1/stdio with
// its own control token; this module checks the token and that the bot has an
// own-server computer bound for the turn, then spawns
// `docker -H ssh://<alias> exec -i <container> ... mcp` ITSELF and bridges it.
//
// Framing: one WebSocket TEXT message per newline-delimited JSON-RPC line, in
// both directions, without the trailing newline. Binary messages, and messages
// holding a raw line break, close the socket. The token, alias and host are
// never logged and never sent to the turn.
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { augmentedPath } from "../env-path.ts";
import { cloudHomeCopy } from "./copy.ts";
import { ownServerChildEnv } from "./own-server.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import { vpsContainerMcpArgs } from "../vps-computer.ts";

export const VPS_MCP_RELAY_PREFIX = "/api/internal/vps-mcp/v1";
export const VPS_MCP_RELAY_PATH = `${VPS_MCP_RELAY_PREFIX}/stdio`;
export const VPS_MCP_MAX_MESSAGE_BYTES = 8 * 1_048_576;
export const VPS_MCP_PING_MS = 30_000;
const KILL_GRACE_MS = 3_000;
/** Log tokens only; the text a turn sees comes from copy.ts. */
const REASON = { capability: "capability", shape: "shape", unbound: "unbound", binding: "binding" } as const;

export type VpsMcpBinding = { alias: string; container: string };
export type VpsMcpChild = Pick<ChildProcess, "stdin" | "stdout" | "kill" | "on" | "once">;
export type VpsMcpRelayDeps = {
  resolveClaim: (authorization: string | string[] | undefined) => InternalCapability | null;
  isActive: (claim: InternalCapability) => boolean;
  /** The own-server container this bot has bound for its current turn, if any. */
  boundContainer: (botId: string) => VpsMcpBinding | null | undefined;
  /** Spawns docker. argv array only, never a shell. Tests inject a fake. */
  spawn?: (command: string, args: string[]) => VpsMcpChild;
  /** One short line per refusal: bot id and reason only. */
  log?: (line: string) => void;
  maxMessageBytes?: number;
  pingMs?: number;
  killGraceMs?: number;
};

function defaultSpawn(command: string, args: string[]): VpsMcpChild {
  return spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: ownServerChildEnv({ ...process.env, PATH: augmentedPath() }) });
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    const body = JSON.stringify({ error: text });
    socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  } catch { try { socket.destroy(); } catch { /* gone */ } }
}

/** Returns an upgrade handler: true when it took the request (cloud upgrade gate shape). */
export function createVpsMcpRelay(deps: VpsMcpRelayDeps) {
  const maxBytes = deps.maxMessageBytes ?? VPS_MCP_MAX_MESSAGE_BYTES;
  const pingMs = deps.pingMs ?? VPS_MCP_PING_MS;
  const grace = deps.killGraceMs ?? KILL_GRACE_MS;
  const launch = deps.spawn ?? defaultSpawn;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes });
  /** botId -> closer of the live relay. A second connection closes the first. */
  const live = new Map<string, () => void>();

  return async (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> => {
    if (url.pathname !== VPS_MCP_RELAY_PATH && !url.pathname.startsWith(`${VPS_MCP_RELAY_PREFIX}/`)) return false;
    const claim = deps.resolveClaim(req.headers.authorization);
    if (!claim || !deps.isActive(claim)) { reject(socket, 401, cloudHomeCopy.ownServerRelayRefused); return true; }
    const refuse = (status: number, reason: string, text: string): true => {
      deps.log?.(`vps mcp relay refused bot=${claim.botId} reason=${reason}`);
      reject(socket, status, text);
      return true;
    };
    if (claim.kind !== "computer") return refuse(403, REASON.capability, cloudHomeCopy.ownServerRelayRefused);
    if (url.pathname !== VPS_MCP_RELAY_PATH || req.method !== "GET" || url.search
      || String(req.headers.upgrade).toLowerCase() !== "websocket") return refuse(404, REASON.shape, cloudHomeCopy.ownServerRelayNotFound);
    const binding = deps.boundContainer(claim.botId);
    if (!binding) return refuse(404, REASON.unbound, cloudHomeCopy.ownServerRelayNotFound);
    let args: string[];
    try { args = vpsContainerMcpArgs(binding.alias, binding.container); }
    catch { return refuse(404, REASON.binding, cloudHomeCopy.ownServerRelayNotFound); }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (ws.readyState !== ws.OPEN) { try { ws.terminate(); } catch { /* gone */ } return; }
        // One live relay per bot: the newer connection wins.
        live.get(claim.botId)?.();
        let child: VpsMcpChild;
        try { child = launch("docker", args); }
        catch { deps.log?.(`vps mcp relay failed bot=${claim.botId} reason=spawn`); ws.close(1011, "unavailable"); return; }
        bridge(ws, child, claim, binding);
      });
    } catch { try { socket.destroy(); } catch { /* gone */ } }
    return true;
  };

  function bridge(ws: WebSocket, child: VpsMcpChild, claim: InternalCapability, binding: VpsMcpBinding): void {
    let ended = false;
    let awaitingPong = false;
    let killTimer: NodeJS.Timeout | undefined;
    const closeSocket = (code: number, reason: string) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) { try { ws.close(code, reason); } catch { /* gone */ } }
    };
    const end = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      if (live.get(claim.botId) === replace) live.delete(claim.botId);
      try { child.stdin?.end(); } catch { /* gone */ }
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, grace);
      killTimer.unref();
      child.once("exit", () => { if (killTimer) clearTimeout(killTimer); });
      closeSocket(code, reason);
    };
    const replace = () => end(4000, "replaced");
    live.set(claim.botId, replace);

    const ping = setInterval(() => {
      // The turn ended or the binding moved: stop serving it.
      const bound = deps.boundContainer(claim.botId);
      if (!deps.isActive(claim) || !bound || bound.alias !== binding.alias || bound.container !== binding.container) {
        end(1008, "ended"); return;
      }
      if (awaitingPong) { try { ws.terminate(); } catch { /* gone */ } end(1001, "idle"); return; }
      awaitingPong = true;
      try { ws.ping(); } catch { /* closing */ }
    }, pingMs);
    ping.unref();
    ws.on("pong", () => { awaitingPong = false; });

    // child stdout -> one text message per line
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > maxBytes) { end(1009, "too-large"); return; }
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
      if (pending.length > maxBytes) end(1009, "too-large");
    });
    child.stdin?.on("error", () => { /* child gone: the exit handler closes the socket */ });
    child.on("error", () => end(1011, "unavailable"));
    child.on("exit", () => end(1000, "exited"));

    // socket -> child stdin
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) { end(1003, "text-only"); return; }
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString("utf8").replace(/\r?\n$/, "");
      if (!text) return;
      if (/[\r\n]/.test(text)) { end(1008, "one-line"); return; }
      try { child.stdin?.write(`${text}\n`); } catch { end(1011, "unavailable"); }
    });
    ws.on("close", () => end(1000, "closed"));
    ws.on("error", () => end(1011, "error"));
  }
}
