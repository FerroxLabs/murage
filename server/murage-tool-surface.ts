// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { SendTurnInput } from "./contracts.ts";

export type McpToolSurface =
  | { kind: "direct"; qualify(server: string, tool: string): string; discovery?: string }
  | { kind: "search-then-call"; search: string; call: string; qualify(server: string, tool: string): string }
  | { kind: "neutral" }
  | { kind: "none" };

// Claude documents deferred ToolSearch and mcp__server__tool names:
// https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search
// No discovery hint is emitted without an established deferred-tool spawn.
export const CLAUDE_TOOL_SURFACE: McpToolSurface = { kind: "direct", qualify: (server, tool) => `mcp__${server}__${tool}` };
// codex.ts mounts mcp_servers.<server> and receives the same qualified name
// in its MCP approval events (mcp__<server>__<tool>).
export const CODEX_TOOL_SURFACE: McpToolSurface = { kind: "direct", qualify: (server, tool) => `mcp__${server}__${tool}` };
// Fuigo/Grok upstream: xai-grok-tools implementations/use_tool/mod.rs and
// registry/types.rs::tool_definitions_builtins_only. MCP tools are not native.
export const FUIGO_TOOL_SURFACE: McpToolSurface = { kind: "search-then-call", search: "search_tool", call: "use_tool", qualify: (server, tool) => `${server}__${tool}` };
// pi-mcp-extension.ts::allocateToolName; reserved built-in servers mount first.
export const PI_TOOL_SURFACE: McpToolSurface = { kind: "direct", qualify: (server, tool) => `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) };
// ACP standardizes server transport, not model-visible tool naming. Kimi,
// Qwen, Hermes, OpenCode Go, Cursor, Droid, Gemini, custom ACP and Antigravity
// do not establish an exact callable spelling in their adapter protocol.
export const NEUTRAL_TOOL_SURFACE: McpToolSurface = { kind: "neutral" };
// openai-chat/compat sends no tools; boxagent exposes only its computer loop.
export const NO_TOOL_SURFACE: McpToolSurface = { kind: "none" };

/** Resolve only authored references, never a bare word in an owner's text. */
// A process-private capability marks authored references. Owner text cannot
// collide with the public-looking syntax used by earlier prompt builders.
const referenceKey = randomUUID();
/** Murage's own servers other than agents and memory, each mounted under a
 * name its driver picks: claude and pi mount the phone as "phone", codex as
 * "murage_phone"; the browser is "browser" wherever it is mounted. */
export type MurageToolServer = "phone" | "browser";
/** A tool of the agents or memory server, or with `server`, of that server.
 * `tool` "" names the server itself (its mount name). */
export function murageTool(tool: string, server?: MurageToolServer): string { return `{{murage-tool:${referenceKey}:${server ? `${server}/` : ""}${tool}}}`; }
const referencePattern = () => new RegExp(`\\{\\{murage-tool:${referenceKey}:((?:[a-z]+/)?[a-z_]*)\\}\\}`, "g");
export type MurageToolMounts = { agents?: string; memory?: string; phone?: string; browser?: string; servers?: readonly string[] };
export function renderMurageTool(reference: string, surface: McpToolSurface, mounts: MurageToolMounts): string {
  const slash = reference.indexOf("/");
  const tool = slash < 0 ? reference : reference.slice(slash + 1);
  const named = slash < 0 ? undefined : reference.slice(0, slash);
  const server = named === "phone" ? mounts.phone : named === "browser" ? mounts.browser : named ? undefined
    : tool.startsWith("memory_") ? mounts.memory : mounts.agents;
  if (!server || surface.kind === "none") return "";
  if (!tool) return server;
  if (surface.kind === "neutral") return `the tool "${tool}" on MCP server "${server}"`;
  const name = surface.qualify(server, tool);
  return surface.kind === "search-then-call" ? `${surface.call} with tool_name "${name}"` : name;
}
export function renderMurageTools(text: string, surface: McpToolSurface, mounts: MurageToolMounts): string {
  // A read-more pointer can share a line with quoted content. Remove just
  // the authored pointer when unavailable, preserving the preceding words.
  text = text.replace(/\[[^\]\n]*\]/g, pointer =>
    [...pointer.matchAll(referencePattern())].some(match => !renderMurageTool(match[1], surface, mounts)) ? "" : pointer);
  return text.split(/((?<=[.!?])\s+|\n)/).map(sentence => {
    const refs = [...sentence.matchAll(referencePattern())];
    if (refs.some(match => !renderMurageTool(match[1], surface, mounts))) return "";
    return sentence.replace(referencePattern(), (_match, tool: string) => renderMurageTool(tool, surface, mounts));
  }).join("");
}
export function murageToolHowTo(surface: McpToolSurface, mounts: MurageToolMounts): string {
  if (!mounts.agents && !mounts.memory && !mounts.servers?.length) return "";
  if (surface.kind === "search-then-call") return `Murage tools are MCP tools. Call ${surface.call} with a qualified tool_name, such as "${surface.qualify(mounts.agents ?? mounts.memory ?? "<server>", mounts.agents ? "ask_bot" : mounts.memory ? "memory_search" : "<tool>")}". Before you first use a tool, call ${surface.search} for its inputs and pass them in tool_input. Do not call bare MCP tool names.${mounts.servers?.length ? ` Mounted MCP servers: ${mounts.servers.join(", ")}. These names are internal: never mention them to the person you are helping.` : ""}`;
  return surface.kind === "direct" ? surface.discovery ?? "" : "";
}
/** F4b: a per-turn memory mount name (Fuigo's rotating alias) must not sit in
 * the system stack, or its hash changes every turn and the once-per-session
 * cache never hits. With `stableMemory`, the system stack (rewritten tool
 * references and the how-to) names the memory server by that fixed label, and
 * the concrete name for THIS turn rides in front of the message text, which is
 * always sent. The alias still rotates every turn; only where it is written moved. */
export function renderMurageTurn(turn: SendTurnInput, surface: McpToolSurface, mounts: MurageToolMounts, stableMemory?: string): SendTurnInput {
  const rotating = stableMemory && mounts.memory && mounts.memory !== stableMemory && surface.kind !== "none" && surface.kind !== "neutral" ? mounts.memory : undefined;
  const systemMounts: MurageToolMounts = rotating
    ? { ...mounts, memory: stableMemory, servers: mounts.servers?.map(name => name === rotating ? stableMemory! : name) } : mounts;
  const hint = murageToolHowTo(surface, systemMounts);
  const binding = rotating && !turn.engineCommand
    ? `For this turn only, the memory server is mounted as "${rotating}". Wherever earlier instructions name "${stableMemory}", use "${rotating}" instead.` : "";
  turn.onToolSurface?.(surface, systemMounts, { mounts, binding });
  const body = turn.engineCommand ? turn.text : renderMurageTools(turn.text, surface, mounts);
  return { ...turn, text: binding ? `${binding}\n\n${body}` : body,
    system: [turn.system && renderMurageTools(turn.system, surface, systemMounts), hint && !turn.system?.includes(hint) ? hint : ""].filter(Boolean).join("\n\n") || undefined };
}

/** Tool schemas and their own receipts do not know the client mount alias.
 * Refer to this server rather than guessing a provider's callable spelling. */
export function murageToolOnThisServer(tool: string): string {
  return `MCP tool "${tool}" on this server`;
}
