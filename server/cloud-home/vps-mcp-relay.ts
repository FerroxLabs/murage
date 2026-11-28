import { cloudHomeCopy } from "./copy.ts";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
// VPS MCP relay: on a Cloud home a turn cannot open SSH, so the own-server
// computer's MCP stream is bridged through this server. The turn script
// (vps-relay-mcp.ts) connects a WebSocket to /api/internal/vps-mcp/v1/stdio with
// its own control token; this module checks the token and that the bot has an
// own-server computer bound for the turn, then spawns
// `docker -H ssh://<alias> exec -i <container> ... mcp` ITSELF and bridges it.
//
// Framing: one WebSocket TEXT message per newline-delimited JSON-RPC line, in
// both directions, without the trailing newline. A malformed message (binary, a
// raw line break, not one JSON-RPC frame) gets a JSON-RPC error and the relay
// lives; a malformed line from the child is dropped. The token, alias and host
// are never logged and never sent to the turn.
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Exact-generation VPS relay. A bot id or a successful upgrade is never frame authority.
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { augmentedPath } from "../env-path.ts";
import { ownServerChildEnv } from "./own-server.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import { vpsContainerMcpArgs } from "../vps-computer.ts";
import { createConsumingIngress, decodeProxyFrame, validProtocolId } from "../consuming-turn-ingress.ts";
import { createLineSplitter } from "../mcp-bridge.ts";
import { emitConsumingTurnResponse, registerConsumingDescriptor, type ConsumingTurnBinding } from "../consuming-turn-response.ts";
import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";

export const VPS_MCP_RELAY_PREFIX = "/api/internal/vps-mcp/v1";
export const VPS_MCP_RELAY_PATH = `${VPS_MCP_RELAY_PREFIX}/stdio`;
export const VPS_MCP_PING_MS = 30_000;
export type VpsMcpBinding = { alias: string; container: string };
export type VpsMcpChild = Pick<ChildProcess, "stdin" | "stdout" | "kill" | "on" | "once">;
export type VpsMcpAdmission = Readonly<{ binding: ConsumingTurnBinding; instanceId: string; container: VpsMcpBinding;
  /** Issued only by a server-owned downstream ingress, not a boolean from a URL. */
  downstream: ReturnType<typeof createConsumingIngress> }>;
export type VpsMcpRelayDeps = {
  resolveClaim: (authorization: string | string[] | undefined) => InternalCapability | null;
  isActive: (claim: InternalCapability) => boolean;
  boundContainer: (botId: string) => VpsMcpBinding | null | undefined;
  /** Captures the exact generation, lease and registered downstream before upgrade. */
  admit?: (claim: InternalCapability) => VpsMcpAdmission | undefined;
  spawn?: (command: string, args: string[]) => VpsMcpChild;
  log?: (line: string) => void;
  pingMs?: number;
  killGraceMs?: number;
};
const admissionDescriptor = registerConsumingDescriptor("upgrade:vps-mcp:admission", "request");
const frameDescriptor = registerConsumingDescriptor("upgrade:vps-mcp:frame", "chunk");

function defaultSpawn(command: string, args: string[]): VpsMcpChild {
  return spawn(command, [...args], withHideInherit({ stdio: ["pipe", "pipe", "ignore"], env: ownServerChildEnv({ ...process.env, PATH: augmentedPath() }) }));
}
/** Both directions end at a synchronous acceptance gate. The downstream still
 * needs its own permit; the WebSocket check is not an engine delivery permit. */
export function createVpsFrameFence(binding: ConsumingTurnBinding, instanceId: string) {
  const ingress = createConsumingIngress(binding, instanceId);
  let sequence = 0;
  return Object.freeze({ ingress,
    request(frame: string, write: () => void) { ingress.request(frame, write); },
    response(frame: string, write: (frame: string) => void) {
      const envelope = ingress.issue({ instanceId, sequence: ++sequence, frame, descriptor: frameDescriptor, refs: [] });
      ingress.deliver(envelope, write);
    },
    lost: () => ingress.seal(),
  });
}
/** MAIN-RULING cause22-no-transport-caps: "a malformed line still gets a JSON-RPC error and the hop lives". The answer for a message
 * that is not one JSON-RPC frame (-32700 / -32600, the sender's id when it has a valid one), or undefined for a well-formed frame. It
 * carries only the fixed text and the engine's own id, never remembered content. */
export function malformedFrameAnswer(text: string | undefined): string | undefined {
  if (text !== undefined) try { decodeProxyFrame(text); return undefined; } catch { /* answered below */ }
  let value: unknown;
  try { value = text === undefined ? undefined : JSON.parse(text); } catch { /* parse error */ }
  const id = value && typeof value === "object" && validProtocolId((value as { id?: unknown }).id) ? (value as { id: unknown }).id : null;
  return JSON.stringify({ jsonrpc: "2.0", id, error: value === undefined ? { code: -32700, message: "Parse error" } : { code: -32600, message: "Invalid Request" } });
}
/** The id of a call a malformed tool-server line was meant to answer (a JSON object with a valid id that carries a result or an error,
 * or is not a request: no non-empty string method), else undefined. */
function malformedReplyId(line: string): unknown {
  try { const value = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) && ("result" in value || "error" in value || !(typeof value.method === "string" && value.method.length > 0)) && validProtocolId(value.id) ? value.id : undefined; }
  catch { return undefined; }
}
function reject(socket: Duplex): void {
  const body = LEDGER_REFUSAL_LINE;
  try { socket.end(`HTTP/1.1 409 Refused\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`); }
  catch { socket.destroy(); }
}
export function createVpsMcpRelay(deps: VpsMcpRelayDeps) {
  // MAIN-RULING cause22-no-transport-caps: no message or line size cap in either direction (maxPayload 0 = none).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });
  const live = new Set<string>();
  return async (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> => {
    if (url.pathname !== VPS_MCP_RELAY_PREFIX && !url.pathname.startsWith(`${VPS_MCP_RELAY_PREFIX}/`)) return false;
    const claim = deps.resolveClaim(req.headers.authorization);
    let candidate: VpsMcpAdmission | undefined;
    try { candidate = claim ? deps.admit?.(claim) : undefined; } catch { reject(socket); return true; }
    const admission = candidate;
    const refuse = () => { admission?.downstream.seal();
      try { admission?.binding.onLedgerRefused({ state: "checking", reason: "not-built" }); } catch { /* stop remains terminal */ }
      deps.log?.("vps relay refusals=1"); reject(socket); return true; };
    if (!claim || !admission || !deps.isActive(claim) || claim.kind !== "computer" || req.method !== "GET"
      || url.pathname !== VPS_MCP_RELAY_PATH || url.search || String(req.headers.upgrade).toLowerCase() !== "websocket") return refuse();
    const identity = admission.binding.identity;
    if (claim.botId !== identity.botId || claim.threadId !== identity.threadId || claim.generation !== identity.dispatchGeneration
      || admission.downstream.identity.adapterLeaseId !== identity.adapterLeaseId
      || admission.downstream.identity.dispatchGeneration !== identity.dispatchGeneration
      || admission.downstream.identity.botId !== identity.botId || admission.downstream.identity.threadId !== identity.threadId
      || JSON.stringify(admission.downstream.identity.lineageTurnIds) !== JSON.stringify(identity.lineageTurnIds)
      || admission.downstream.sealed) return refuse();
    const key = JSON.stringify([identity.botId, identity.threadId, identity.dispatchGeneration, identity.adapterLeaseId, admission.instanceId]);
    if (live.has(key)) return refuse();
    const captured = Object.freeze({ ...admission.container });
    const containerNow = deps.boundContainer(claim.botId);
    if (!containerNow || containerNow.alias !== captured.alias || containerNow.container !== captured.container) return refuse();
    const fence = createVpsFrameFence(admission.binding, admission.instanceId);
    let args: string[];
    try {
      args = vpsContainerMcpArgs(captured.alias, captured.container);
      emitConsumingTurnResponse(admission.binding, admissionDescriptor, { bytes: 0, refs: [], write: () => {
        live.add(key);
        wss.handleUpgrade(req, socket, head, ws => {
          let child: VpsMcpChild;
          try { child = (deps.spawn ?? defaultSpawn)("docker", args); }
          catch { fence.lost(); admission.downstream.seal(); live.delete(key); ws.close(1008, LEDGER_REFUSAL_LINE); return; }
          bridge(ws, child);
        });
      } });
    } catch { fence.lost(); live.delete(key); return refuse(); }
    return true;

    function bridge(ws: WebSocket, child: VpsMcpChild): void {
      let ended = false, awaitingPong = false;
      const current = () => {
        const container = deps.boundContainer(claim!.botId);
        return deps.isActive(claim!) && admission!.binding.isCurrent() && !admission!.downstream.sealed
          && container?.alias === captured.alias && container?.container === captured.container;
      };
      const end = () => {
        if (ended) return;
        ended = true;
        fence.lost(); admission!.downstream.seal();
        clearInterval(ping); live.delete(key);
        try { child.stdin?.end(); child.kill("SIGTERM"); } catch { /* already sealed */ }
        const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* C owns quarantine */ } }, deps.killGraceMs ?? 3000); kill.unref?.();
        child.once("exit", () => clearTimeout(kill));
        try { ws.close(1008, LEDGER_REFUSAL_LINE); } catch { ws.terminate(); }
      };
      const ping = setInterval(() => {
        const container = deps.boundContainer(claim!.botId);
        if (!deps.isActive(claim!) || !admission!.binding.isCurrent() || admission!.downstream.sealed
          || !container || container.alias !== captured.alias || container.container !== captured.container) { end(); return; }
        // MAIN-RULING cause22-no-transport-caps (ASTRA a0604a605a): a pong that has not come back is no reason to end the relay. Its ping may
        // still be queued behind data a slow turn has not read (in ws or in the kernel). The relay lives as long as its turn, container and
        // binding do (above); a second ping is not queued behind the first.
        if (awaitingPong) return;
        awaitingPong = true;
        try { ws.ping(); } catch { end(); }
      }, deps.pingMs ?? VPS_MCP_PING_MS); ping.unref?.();
      ws.on("pong", () => { awaitingPong = false; });
      const splitter = createLineSplitter(line => {
        if (ended) return;
        try {
          // MAIN-RULING cause22-no-transport-caps: a frame still being sent is no reason to end the relay (ws queues the next one).
          if (!current() || ws.readyState !== ws.OPEN) throw new Error(cloudHomeCopy.memoryContextRevoked);
          // A malformed line from the tool server is never a frame. A reply to a call still in flight becomes a JSON-RPC error for that call
          // (released like any reply); any other malformed line is dropped (counted). The relay lives.
          let frame = line;
          if (malformedFrameAnswer(line)) {
            deps.log?.("vps relay malformed=1");
            const id = malformedReplyId(line);
            if (!fence.ingress.pendingCall(id)) return;
            frame = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "The tool server sent a malformed reply" } });
          }
          fence.response(frame, out => { ws.send(out, error => { if (error) end(); }); });
        } catch { end(); }
      }, Number.POSITIVE_INFINITY);
      child.stdout?.on("data", (chunk: Buffer) => { if (ended) return; try { fence.ingress.upstream(chunk.byteLength); splitter.push(chunk); } catch { end(); } });
      child.stdout?.on("end", end); child.stdout?.on("error", end); child.stdin?.on("error", end);
      child.on("error", end); child.on("exit", end);
      ws.on("message", (data: RawData, binary: boolean) => {
        if (ended) return;
        try {
          const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
          // MAIN-RULING cause22-no-transport-caps: a child stdin still draining is no reason to end the relay (the pipe queues the write).
          if (!current() || !child.stdin) throw new Error(cloudHomeCopy.memoryContextRevoked);
          fence.ingress.upstream(size);
          const text = binary ? undefined : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString("utf8");
          const fault = malformedFrameAnswer(text);
          if (fault) { ws.send(fault, error => { if (error) end(); }); return; }
          fence.request(text!, () => { child.stdin!.write(text + "\n"); });
        } catch { end(); }
      });
      ws.on("close", end); ws.on("error", end);
    }
  };
}
