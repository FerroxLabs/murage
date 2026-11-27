// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { randomUUID } from "node:crypto";
import { ClaudeStdinGate } from "./cli-stdin.ts";
import { parseMcpStatus } from "./mcp-readiness.ts";

type Answer = { subtype?: string; response?: unknown } | null;
type Request = { subtype: "mcp_reconnect" | "mcp_status"; serverName?: string };

/** Outcome-returning S2 barrier. The adapter must register the supplied id in
 * the session's control-response map before sending it via cliStdinWrite.
 * A false result means recycle and submit cold, never refuse the turn.
 * Not enabled until the relay supports retiring a generation without killing
 * its CLI or disposing the process credential path. */
export async function awaitClaudeS2Barrier(
  gate: ClaudeStdinGate,
  names: readonly string[],
  request: (id: string, body: Request, remainingMs: number) => Promise<Answer>,
  timeoutMs: number,
  supported = true,
): Promise<boolean> {
  if (!supported || gate.barrier !== "open" || gate.failure) return false;
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>(resolve => {
    timer = setTimeout(() => { gate.fail("S2 barrier deadline"); resolve(false); }, Math.max(0, timeoutMs));
  });
  const ask = async (body: Request): Promise<Answer> => {
    if (gate.failure || Date.now() >= deadline) return null;
    const id = `murage-s2-${randomUUID()}`;
    gate.own(id, body.subtype);
    return NotModelRequest("Invokes the local retirement callback for an existing MCP request.", request(id, body, Math.max(1, deadline - Date.now())));
  };
  const run = async (): Promise<boolean> => {
    const answers = await Promise.all(names.map(serverName => ask({ subtype: "mcp_reconnect", serverName })));
    if (gate.failure || answers.some(answer => answer?.subtype !== "success")) return false;
    const status = await ask({ subtype: "mcp_status" });
    if (gate.failure || status?.subtype !== "success") return false;
    const states = parseMcpStatus(status.response);
    return Date.now() < deadline && !!states && names.every(name => states.get(name) === "connected");
  };
  try {
    const passed = await Promise.race([run(), expired, gate.failed.then(() => false)]);
    if (!passed) gate.fail("S2 reconnect/status failed");
    return passed;
  } catch {
    gate.fail("S2 control request failed");
    return false;
  } finally { clearTimeout(timer); }
}
