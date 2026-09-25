// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// pi-permission-gate: Murage's approvals for the pi engine.
//
// Pi has no permission system of its own: its bash, edit and write tools run
// the moment the model calls them. Every other engine sends Murage an ask
// first (Claude's permission tool, Codex approvals, ACP permission requests),
// which is what lets Ask mode ask, and lets Full access stop before deleting
// outside the folder, paying or messaging someone new (server/stop-line.ts).
// Without this file, a pi bot did all three on every mode with nobody asked.
//
// Loaded into the per-turn `pi --mode rpc` process with `-e`, like
// pi-mcp-extension.ts, and shipped verbatim as .ts for the same reason. It
// imports nothing, so it loads under any pi install. Pi calls a `tool_call`
// handler before each tool runs; returning { block: true } stops it, and a
// handler that throws blocks the tool too (pi's documented fail-safe).
//
// The ask travels as a `confirm` dialog (extension_ui_request over RPC). The
// driver tells this gate's asks apart from any other extension's by a secret
// it generates per turn and hands over in MURAGE_PI_GATE; the title carries
// it and the message carries the call as JSON, so the stop line reads the
// real command rather than display text. The secret is removed from this
// process's environment on load so the commands pi runs never inherit it.

/** The title prefix of every gate ask. The driver matches prefix + secret. */
export const PI_GATE_TITLE_PREFIX = "murage-gate:";
/** Longest message the gate sends. A call larger than this is sent without
 *  its input, and the driver raises an ordinary card for it. */
export const PI_GATE_MESSAGE_MAX = 64 * 1024;

interface GateEvent {
  toolName: string;
  input: Record<string, unknown>;
}
interface GateContext {
  cwd: string;
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
}
interface GateApi {
  on(event: "tool_call", handler: (event: GateEvent, ctx: GateContext) => Promise<{ block: true; reason: string } | undefined>): unknown;
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["edit", "write"]);

function inside(path: string, root: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(path), base = norm(root);
  if (!base) return false;
  // Relative paths resolve against the working folder.
  if (!/^([a-zA-Z]:)?\//.test(target)) return !target.split("/").includes("..");
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Whether this call waits for Murage. Read-only tools (read, grep, find, ls)
 * never ask, and neither do Murage's own tools, which Claude pre-allows too.
 * Edits inside the working folder go straight through, as Claude's
 * acceptEdits does; anything outside it asks.
 */
export function piGateAsks(toolName: string, input: Record<string, unknown>, cwd: string, prefixes: readonly string[]): boolean {
  if (SHELL_TOOLS.has(toolName)) return true;
  if (FILE_TOOLS.has(toolName)) {
    const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
    return !path || !inside(path, cwd);
  }
  return prefixes.some((prefix) => toolName.startsWith(prefix));
}

/** The message a gate ask carries: the call, trimmed to what the stop line reads. */
export function piGateMessage(toolName: string, input: Record<string, unknown>): string {
  const slim = FILE_TOOLS.has(toolName)
    ? { path: input.path ?? input.file_path }
    : SHELL_TOOLS.has(toolName)
      ? { command: input.command }
      : input;
  const full = JSON.stringify({ tool: toolName, input: slim });
  return full.length <= PI_GATE_MESSAGE_MAX ? full : JSON.stringify({ tool: toolName });
}

export default function piPermissionGate(pi: GateApi): void {
  const secret = process.env.MURAGE_PI_GATE ?? "";
  let prefixes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.MURAGE_PI_GATE_PREFIXES ?? "[]");
    if (Array.isArray(parsed)) prefixes = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    // no prefixes: only pi's own tools are gated
  }
  delete process.env.MURAGE_PI_GATE;
  delete process.env.MURAGE_PI_GATE_PREFIXES;
  if (!secret) return;
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input && typeof event.input === "object" ? event.input : {};
    if (!piGateAsks(event.toolName, input, ctx.cwd, prefixes)) return undefined;
    if (!ctx.hasUI) return { block: true, reason: "Murage could not ask the owner about this, so it did not run." };
    const allowed = await ctx.ui.confirm(`${PI_GATE_TITLE_PREFIX}${secret}`, piGateMessage(event.toolName, input));
    return allowed ? undefined : { block: true, reason: "The owner did not allow this in Murage." };
  });
}
