// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { canonicalJson } from "./canonical-json.ts";
import { ACP_IDENTIFYING_KINDS, mountOf } from "./app-action-grant.ts";
import { isGenericTool } from "./app-action-words.ts";
import { WRAP_DEPTH } from "./scan-limits.ts";
import type { McpMountRecord } from "./mount-identity.ts";

export { canonicalJson } from "./canonical-json.ts";
const IDENTITY: unique symbol = Symbol("ToolIdentity");
export type Provenance = "stamp" | "hermes-hook" | "hermes-title" | "hermes-edit-ask" | "hermes-native-cmd" | "acp-kind" | "claude-native" | "codex-native";
export interface ToolIdentity {
  readonly [IDENTITY]: true;
  readonly engine: string;
  readonly provenance: Provenance;
  readonly proven: boolean;
  readonly namespace: string;
  readonly name: string;
  readonly kind?: string;
  readonly key: string;
  readonly why?: string;
  readonly dispatch?: { readonly target: string; readonly targetInput: unknown; readonly proven: boolean };
}
/** Engine-owned envelope, passed whole. For Claude pass permission args or
 * the tool_use block; for Codex pass a hook delivery or the item itself.
 * Arguments nested in input/rawInput/tool_input never name the outer call. */
export interface EngineFrame {
  readonly title?: unknown;
  readonly kind?: unknown;
  readonly _meta?: unknown;
  readonly rawInput?: unknown;
  readonly toolCallId?: unknown;
  readonly sessionUpdate?: unknown;
  readonly type?: unknown;
  readonly name?: unknown;
  readonly tool_name?: unknown;
  readonly input?: unknown;
  readonly tool_input?: unknown;
  readonly server?: unknown;
  readonly tool?: unknown;
  readonly command?: unknown;
  readonly id?: unknown;
  readonly tool_use_id?: unknown;
}
export interface IdentityCtx {
  readonly codexHook?: EngineFrame;
  readonly hermesVersion?: string;
  /** Full install-stamp source commit; version alone is insufficient (R1). */
  readonly hermesInstallSha?: string;
  readonly mounts?: readonly McpMountRecord[];
  /** S2/S3 own the turn classes and execution bindings. S1 does not accept
   * caller-supplied claims of proof from this slot. */
  readonly turnClasses?: unknown;
}
export type ToolIdentityWire = Omit<ToolIdentity, typeof IDENTITY> & { readonly v: 1 };

/** S0b G4 must add captured hook names here. Never infer them from argument
 * names or the existing policy router's aliases. */
export const CODEX_HOOK_NAMES: Readonly<Record<string, string>> = Object.freeze({ Bash: "shell" });
export const HERMES_VERSION_PIN = Object.freeze({ "0.22.2": "d923a5eb487a17c0a68801bba9ef0f56c81040a8" });

function object(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype ? v as Record<string, unknown> : undefined;
}
const part = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/^\p{White_Space}|\p{White_Space}$|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/]/u.test(v);
function freezeTree<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freezeTree(child); Object.freeze(v); }
  return v;
}

/** r1.2 hermes_fsm.py identity functions. Version-only classification is used
 * by the correlation machine; the public wire constructor additionally gates
 * on the verified install stamp (R1). Neither classifier proves a state binding. */
export const HERMES_VERSION = "0.22.2";
export const PINNED_KIND: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries({
    read: ["read_file", "skill_view", "skills_list", "browser_snapshot", "browser_vision", "browser_get_images", "vision_analyze"],
    edit: ["write_file", "patch", "skill_manage"], search: ["search_files"],
    execute: ["terminal", "process", "execute_code", "browser_click", "browser_type", "browser_scroll", "browser_press", "browser_back", "delegate_task", "image_generate", "text_to_speech"],
    fetch: ["web_search", "web_extract", "browser_navigate"], other: ["todo"], think: ["_thinking"],
  }).flatMap(([kind, names]) => names.map(name => [name, kind])),
));
export const C1_DEFAULT = Object.freeze(["read_file", "search_files", "skills_list", "skill_view", "vision_analyze", "web_search", "web_extract"] as const);
export const HERMES_C2 = Object.freeze(["write_file", "patch"] as const);
export const HERMES_TITLE = /^([A-Za-z0-9_-]+)(?:: |$)/;
export type HermesAsk =
  | { type: "unproven" }
  | { type: "hook"; key: string; name: string; input: Record<string, unknown> }
  | { type: "cmd"; key: string; command: string }
  | { type: "edit"; key: string; name: string; arguments: Record<string, unknown> };
export function classifyAsk(tc: EngineFrame, version: unknown): HermesAsk {
  const ri = object(tc.rawInput);
  if (version !== HERMES_VERSION || !ri) return { type: "unproven" };
  const keys = Object.keys(ri).sort().join(",");
  if (keys === "command,description") {
    const match = typeof ri.command === "string" ? /^<([A-Za-z0-9_-]+)> \(plugin approval rule\)$/.exec(ri.command) : null;
    if (match) {
      let msg: Record<string, unknown> | undefined;
      try { msg = typeof ri.description === "string" ? object(JSON.parse(ri.description)) : undefined; } catch { /* unproven */ }
      if (msg && (msg.murage === 1 || msg.murage === true) && (msg.v === 1 || msg.v === true) && msg.tool === match[1] && msg.truncated === false && object(msg.input)) {
        return { type: "hook", key: "hermes/hermes/" + match[1], name: match[1]!, input: msg.input as Record<string, unknown> };
      }
      return { type: "unproven" };
    }
    if (tc.kind === "execute" && typeof ri.command === "string" && typeof ri.description === "string") return { type: "cmd", key: "hermes/hermes/terminal", command: ri.command };
    return { type: "unproven" };
  }
  if (keys === "arguments,tool" && tc.kind === "edit" && typeof tc.toolCallId === "string" && /^edit-approval-[0-9]+$/.test(tc.toolCallId) && (ri.tool === "write_file" || ri.tool === "patch") && object(ri.arguments)) {
    return { type: "edit", key: "hermes/hermes/" + ri.tool, name: ri.tool, arguments: ri.arguments as Record<string, unknown> };
  }
  return { type: "unproven" };
}
export function startIdentity(u: EngineFrame, version: unknown): string | null {
  if (version !== HERMES_VERSION || typeof u.title !== "string") return null;
  const match = HERMES_TITLE.exec(u.title);
  const name = match?.[1];
  if (!name || name === "tool" || u.kind !== (Object.hasOwn(PINNED_KIND, name) ? PINNED_KIND[name] : "other")) return null;
  return name;
}

/** Immutable driver-owned request evidence. binding is private driver state,
 * never a field on ToolIdentityWire or a claim supplied by the server. */
export interface DriverAskRecord<B = unknown> {
  readonly frame: EngineFrame;
  readonly identity: ToolIdentity;
  readonly binding: B;
  readonly canonicalFrame: string | undefined;
}
export function driverAskRecord<B>(frame: EngineFrame, identity: ToolIdentity, binding: B): DriverAskRecord<B> {
  const encoded = canonicalJson(frame);
  return Object.freeze({ frame: freezeTree(encoded === undefined ? {} : JSON.parse(encoded)), identity, binding, canonicalFrame: encoded });
}
export function matchesDriverAsk(record: DriverAskRecord, frame: unknown, wire?: unknown): boolean {
  const encoded = canonicalJson(frame);
  return encoded !== undefined && encoded === record.canonicalFrame &&
    (wire === undefined || canonicalJson(wire) === canonicalJson(toolIdentityWire(record.identity)));
}

/** The only constructor. Unknown and malformed producer facts are closed;
 * errors are value-free and never include an argument or a command. */
export function toolIdentity(engine: string, frame: EngineFrame, ctx: IdentityCtx = {}): ToolIdentity {
  let provenance: Provenance = engine === "claude" ? "claude-native" : engine === "codex" ? "codex-native" : engine === "hermes" ? "hermes-hook" : "acp-kind";
  const finish = (namespace: string, name: string, why?: string, dispatch?: ToolIdentity["dispatch"]): ToolIdentity => {
    const proven = why === undefined;
    const value = {
      engine, provenance, namespace, name, proven, key: proven ? `${engine}/${namespace}/${name}` : "",
      ...(typeof frame?.kind === "string" ? { kind: frame.kind } : {}),
      ...(why === undefined ? {} : { why }), ...(dispatch ? { dispatch } : {}),
    };
    Object.defineProperty(value, IDENTITY, { value: true });
    return freezeTree(value) as ToolIdentity;
  };
  const bad = (why: string) => finish("", "", why);
  const mounted = (qualified: string): { server: string; tool: string } | undefined => {
    const mount = mountOf(qualified, ctx.mounts);
    if (typeof mount === "string" || mount.record.mountId === "own:muragebox" || !part(mount.record.engineName) || !part(mount.tool)) return undefined;
    return { server: mount.record.engineName, tool: mount.tool };
  };
  const native = (name: unknown): ToolIdentity => {
    if (!part(name)) return bad("invalid native tool name");
    if (name.startsWith("mcp__")) {
      const mount = mounted(name.slice(5));
      return mount ? finish(`mcp:${mount.server}`, mount.tool) : bad("unproven MCP mount");
    }
    return finish(engine, name);
  };
  try {
    if (!part(engine) || !object(frame) || canonicalJson(frame) === undefined) return bad("unreadable engine frame");
    if (engine === "claude") {
      if (frame.type === "tool_use") return native(frame.name);
      // A prompt envelope with an unrelated type is not a permission prompt.
      return frame.type === undefined ? native(frame.tool_name) : bad("unknown Claude frame");
    }
    if (engine === "codex") {
      if (frame.type === "commandExecution") return finish("codex", "shell");
      if (frame.type === "fileChange") {
        const hook = ctx.codexHook;
        const cmd = object(hook?.tool_input)?.command;
        return finish("codex", hook?.tool_name === "Bash" && typeof cmd === "string" && /^apply_patch(\s|$)/.test(cmd) && frame.id != null && hook.tool_use_id === frame.id ? "shell" : "edit");
      }
      if (frame.type === "webSearch") return finish("codex", "web_search");
      if (frame.type === "mcpToolCall") {
        if (!part(frame.server) || !part(frame.tool) || frame.server.includes("__")) return bad("invalid Codex MCP item");
        const mount = mounted(`${frame.server}__${frame.tool}`);
        return mount ? finish(`mcp:${mount.server}`, mount.tool) : bad("unproven MCP mount");
      }
      if (frame.type === undefined && typeof frame.tool_name === "string" && /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.test(frame.tool_name)) return native(frame.tool_name);
      const name = frame.type === undefined && typeof frame.tool_name === "string" && Object.hasOwn(CODEX_HOOK_NAMES, frame.tool_name) ? CODEX_HOOK_NAMES[frame.tool_name] : undefined;
      return name ? native(name) : bad("unpinned Codex hook or item");
    }
    if (engine === "hermes") {
      if (ctx.hermesVersion !== "0.22.2" || ctx.hermesInstallSha !== HERMES_VERSION_PIN["0.22.2"]) return bad("unpinned Hermes build");
      if (frame.sessionUpdate === "tool_call") {
        provenance = "hermes-title";
        const name = startIdentity(frame, ctx.hermesVersion);
        return name ? finish("hermes", name) : bad("unproven Hermes start");
      }
      if (frame.sessionUpdate !== undefined) return bad("Hermes update requires frozen identity");
      const ask = classifyAsk(frame, ctx.hermesVersion);
      if (ask.type === "hook") return finish("hermes", ask.name);
      // Native edit and command classification alone cannot prove a binding.
      if (ask.type === "edit") provenance = "hermes-edit-ask";
      if (ask.type === "cmd") provenance = "hermes-native-cmd";
      return bad(ask.type === "unproven" ? "unproven Hermes ask" : "Hermes ask requires driver binding");
    }
    const meta = object(frame._meta);
    if (meta && Object.hasOwn(meta, "fuigo/tool")) {
      provenance = "stamp";
      const stamp = object(meta["fuigo/tool"]);
      if (!stamp || stamp.version !== 1 || !part(stamp.namespace) || !part(stamp.name) || !part(stamp.kind) || stamp.kind !== frame.kind) return bad("unreadable or mismatched stamp");
      const { namespace, name } = stamp;
      if (namespace === "mcp") return mounted(name) ? finish(namespace, name) : bad("unproven MCP mount");
      if (namespace === "opencode" || namespace === "codex") {
        return stamp.kind === "edit" && name === (namespace === "opencode" ? "write" : "apply_patch") ? finish(namespace, name) : bad("unknown stamped tool");
      }
      if (namespace !== "fuigo_build") return bad("unknown stamp namespace");
      if (name !== "use_tool") return isGenericTool(name) ? bad("stamp names no tool") : finish(namespace, name);
      let body = frame.rawInput;
      for (let depth = 0; depth < WRAP_DEPTH; depth++) {
        const input = object(body);
        if (!input) return bad("unreadable dispatcher");
        const names = ["tool_name", "toolName"].filter((key) => input[key] !== undefined);
        const inputs = ["tool_input", "toolInput"].filter((key) => input[key] !== undefined);
        const target = names.length === 1 ? input[names[0]!] : undefined;
        const targetInput = inputs.length === 1 ? object(input[inputs[0]!]) : undefined;
        if (!part(target) || !targetInput || Object.keys(input).some((key) => ![...names, ...inputs, "variant"].includes(key))) return bad("unreadable dispatcher");
        if (target.toLowerCase() === "use_tool") { body = targetInput; continue; }
        if (isGenericTool(target) || (target.includes("__") && !mounted(target.replace(/^mcp__/, "")))) return bad("unproven dispatch target");
        const encoded = canonicalJson(targetInput);
        if (encoded === undefined) return bad("unreadable dispatch input");
        return finish(namespace, name, undefined, { target, targetInput: JSON.parse(encoded), proven: true });
      }
      return bad("dispatcher depth exceeded");
    }
    return typeof frame.kind === "string" && ACP_IDENTIFYING_KINDS.includes(frame.kind)
      ? finish("acp-kind", frame.kind) : bad("non-identifying ACP kind");
  } catch { return bad("unreadable engine frame"); }
}

/** Explicit wire projection: never serialize the brand, and never omit dispatch. */
export function toolIdentityWire(id: ToolIdentity): ToolIdentityWire {
  return { v: 1, engine: id.engine, provenance: id.provenance, namespace: id.namespace, name: id.name,
    key: id.key, proven: id.proven, ...(id.kind === undefined ? {} : { kind: id.kind }),
    ...(id.why === undefined ? {} : { why: id.why }), ...(id.dispatch ? { dispatch: id.dispatch } : {}) };
}

/** Receive-side entry, also used on stored-card reload. The frame and context
 * must come from the engine envelope and this turn's recorded facts, never
 * from the wire identity. S3 must re-check execution bindings before adding
 * their profiles; S1 accepts no binding claim. */
export function parseToolIdentity(wire: unknown, frame: EngineFrame, engine: string, ctx: IdentityCtx = {}): ToolIdentity {
  const derived = toolIdentity(engine, frame, ctx);
  const received = canonicalJson(wire);
  if (received !== undefined && received === canonicalJson(toolIdentityWire(derived))) return derived;
  // Construct through the one brand owner, then replace only a value-free
  // failure reason; never copy a key, dispatch or proof from the wire.
  const unproven = toolIdentity(engine, {}, ctx);
  const value = { ...toolIdentityWire(unproven), why: "identity did not re-derive" };
  const { v: _version, ...fields } = value;
  Object.defineProperty(fields, IDENTITY, { value: true });
  return Object.freeze(fields) as ToolIdentity;
}
