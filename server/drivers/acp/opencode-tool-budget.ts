import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { syncParentDirectory, writeFileAtomic } from "../../atomic.ts";

const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Only provider cardinality sentences, never an arbitrary number in an error. */
export function readToolLimit(error: unknown): number | undefined {
  const e = object(error); if (e?.acpMethod !== "session/prompt") return;
  const data = object(e.data);
  const kind = data?.errorName ?? e.errorName;
  if (kind !== undefined && kind !== "APIError") return;
  function message(v: unknown, depth = 0): string | undefined {
    if (depth > 5) return;
    if (typeof v === "string") {
      if (/^\s*[\[{]/.test(v)) { try { return message(JSON.parse(v), depth + 1); } catch { return; } }
      return v;
    }
    const o = object(v);
    if (o?.errorName !== undefined && o.errorName !== "APIError") return;
    return o ? message(o.message ?? o.details ?? o.error, depth + 1) : undefined;
  }
  const text = message(e.data === undefined || (data && data.message === undefined && data.details === undefined && data.error === undefined) ? e.message : e.data);
  if (!text || /\b(context|tokens?|rate|quota|auth|key|billing|credit|unavailable|overloaded|timeout|timed out)\b/i.test(text) || /\b(name|description|arguments?|schema|properties|nesting|depth|function)\b/i.test(text)) return;
  const forms = [
    /\btools:\s*array too long\.\s*Expected an array with maximum length (\d+),?\s*but (?:got|received|found) \d+\.?/gi,
    /\b(?:tools array|array of tools)[^.;\d]*?\b(?:maximum length|max length|at most) (\d+)(?: items)?/gi,
    /\bmaximum number of tools is (\d+)\b/gi,
    /\btool count exceeds (?:the )?maximum (?:of )?(\d+)\b/gi,
    /\b(?:at most|no more than) (\d+) tools\b/gi,
    /\btoo many tools[^.\d]*?\b(?:maximum|limit) (?:of )?(\d+) tools\b/gi,
  ];
  const matches = forms.flatMap(re => [...text.matchAll(re)]);
  if (matches.length !== 1) return;
  const match = matches[0]!; const limit = Number(match[1]);
  if (limit < 8 || limit > 1024) return;
  // Any other integer must belong solely to an explicit actual-count clause.
  if ([...text.matchAll(/\b(?:got|received|found) \d+\b/gi)].length > 1) return;
  const rest = text.slice(0, match.index) + text.slice(match.index! + match[0].length);
  if (/\d/.test(rest.replace(/\b(?:got|received|found) \d+\b/i, ""))) return;
  return limit;
}

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const ROUTE_ENV = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"] as const;
export function routeKey(input: { executable: string; version: string; model: string; env: Record<string, string | undefined>; auth?: Uint8Array }): string | undefined {
  if (!input.version.trim()) return;
  return hash(JSON.stringify([input.executable, input.version, input.model, ...ROUTE_ENV.map(k => input.env[k] ?? null), ...["OPENCODE_API_KEY", "OPENCODE_AUTH_CONTENT"].map(k => input.env[k] === undefined ? null : hash(input.env[k]!)), input.auth ? hash(input.auth) : null]));
}

export interface LimitRecord { limit: number; margin: number; learnedAt: number; updatedAt: number; model: string; engine: string }
const TTL = 7 * 86400000;
// Shared by all driver/store instances, including reads. Rejected operations do
// not poison the queue. Disk is authoritative only after the durable boundary.
const pendingDirectorySync = new Set<string>();
let storeQueue: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => T | Promise<T>): Promise<T> {
  const next = storeQueue.then(run); storeQueue = next.catch(() => {}); return next;
}
export function toolLimitFile(dataDir: string): string { return join(dataDir, "native", "opencode-tool-limits.json"); }
export class ToolLimitStore {
  private readonly now: () => number;
  readonly file: string;
  private readonly io: { now?: () => number; write?: typeof writeFileAtomic; syncParent?: typeof syncParentDirectory };
  constructor(file: string, io: { now?: () => number; write?: typeof writeFileAtomic; syncParent?: typeof syncParentDirectory } = {}) { this.file = file; this.io = io; this.now = io.now ?? Date.now; }
  private read(): Record<string, LimitRecord> {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    const doc = object(raw); if (doc?.v !== 1) return {};
    const routes: Record<string, LimitRecord> = {};
    for (const [key, value] of Object.entries(object(doc.routes) ?? {})) {
      const r = object(value);
      if (!/^[a-f0-9]{64}$/.test(key) || !r || !Number.isInteger(r.limit) || Number(r.limit) < 8 || Number(r.limit) > 1024 || !Number.isInteger(r.margin) || Number(r.margin) < 4 || Number(r.margin) > 64 || typeof r.learnedAt !== "number" || !Number.isFinite(r.learnedAt) || typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt) || typeof r.model !== "string" || r.engine !== "opencode" || this.now() - r.learnedAt >= TTL) continue;
      routes[key] = r as unknown as LimitRecord;
    }
    return routes;
  }
  get(key: string): Promise<LimitRecord | undefined> { return serial(() => this.read()[key]); }
  private save(routes: Record<string, LimitRecord>): void {
    const directory = dirname(resolve(this.file));
    for (const path of pendingDirectorySync) {
      if (directory !== path && !directory.startsWith(path + sep)) continue;
      (this.io.syncParent ?? syncParentDirectory)(path);
      pendingDirectorySync.delete(path);
    }
    const missing: string[] = [];
    for (let path = dirname(resolve(this.file)); !existsSync(path); path = dirname(path)) missing.unshift(path);
    for (const path of missing) {
      mkdirSync(path, { mode: 0o700 });
      pendingDirectorySync.add(path);
      (this.io.syncParent ?? syncParentDirectory)(path);
      pendingDirectorySync.delete(path);
    }
    const ordered = Object.keys(routes).sort((a, b) => routes[a]!.updatedAt - routes[b]!.updatedAt || a.localeCompare(b));
    while (ordered.length > 64) delete routes[ordered.shift()!];
    (this.io.write ?? writeFileAtomic)(this.file, JSON.stringify({ v: 1, routes }), { mode: 0o600, syncDir: true });
  }
  learn(key: string, limit: number, model: string): Promise<LimitRecord> {
    return serial(() => {
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isInteger(limit) || limit < 8 || limit > 1024) throw new Error("Invalid tool limit record");
      const routes = this.read(), old = routes[key], now = this.now();
      const record: LimitRecord = { limit: Math.min(old?.limit ?? limit, limit), margin: old?.margin ?? 4, learnedAt: old?.learnedAt ?? now, updatedAt: now, model, engine: "opencode" };
      routes[key] = record; this.save(routes); return { ...record };
    });
  }
  increaseMargin(key: string): Promise<LimitRecord> {
    return serial(() => {
      const routes = this.read(), old = routes[key]; if (!old) throw new Error("Missing tool limit record");
      const record = { ...old, margin: Math.min(64, old.margin + 8), updatedAt: this.now() };
      routes[key] = record; this.save(routes); return { ...record };
    });
  }
}

export const NATIVE_PROTECTED = new Set(["bash", "read", "glob", "grep", "task", "webfetch", "todowrite", "skill", "edit", "write", "apply_patch", "websearch", "codesearch", "question", "invalid", "lsp", "execute", "plan_enter", "plan_exit", "external_directory", "doom_loop", "list", "todoread", "list_resources", "read_resource", "list_resource_templates", "list_mcp_resources", "read_mcp_resource", "list_mcp_resource_templates"]);
export const REQUIRED_CONTROLS = ["murage_help", "tool_result_read", "allow_for_task", "ask_user", "show_widget", "update_widget", "request_credential", "list_bots", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "get_permission_status", "propose_outcome", "get_bot", "project_propose"];
export type ToolRole = "agents" | "memory" | "connected" | "browser" | "computer" | "phoneJobs" | "custom";
export interface ToolMount { name: string; role: ToolRole; tools?: readonly string[]; resources: boolean | "unknown"; required?: readonly string[] }
export type Restriction = readonly [string, "deny" | "ask"];
export const sanitizeToolName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");
export const openCodeToolId = (mount: string, name: string) => `${sanitizeToolName(mount)}_${sanitizeToolName(name)}`;
/** ACP sets its client identity to acp, so CLI-only plan tools do not register. */
export function nativeExtras(env: Record<string, string | undefined>) {
  const enabled = (key: string) => /^(true|1|yes|on)$/i.test(env[key] ?? "");
  const experimental = (key: string) => env[key] === undefined ? enabled("OPENCODE_EXPERIMENTAL") : enabled(key);
  return { search: ["OPENCODE_EXPERIMENTAL", "OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL_EXA", "OPENCODE_ENABLE_PARALLEL", "OPENCODE_EXPERIMENTAL_PARALLEL"].some(enabled), question: enabled("OPENCODE_ENABLE_QUESTION_TOOL"), lsp: experimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"), execute: experimental("OPENCODE_EXPERIMENTAL_CODE_MODE"), plan: false };
}
export function nativeCount(model: string, mounts: readonly ToolMount[], extras: { search?: boolean; question?: boolean; lsp?: boolean; execute?: boolean; plan?: boolean } = {}): number {
  const [provider, ...rest] = model.split("/"); const id = rest.join("/");
  return 8 + (id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4") ? 1 : 2) + (provider === "opencode" || provider === "opencode-go" || extras.search ? 1 : 0) + (mounts.some(m => m.resources !== false) ? 3 : 0) + (extras.question ? 1 : 0) + (extras.lsp ? 1 : 0) + (extras.execute ? 1 : 0) + (extras.plan ? 2 : 0);
}
export function permissionMatches(pattern: string, id: string): boolean {
  return new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(id);
}
export function effectivePermission(permission: Record<string, unknown>, id: string): unknown {
  let value: unknown;
  for (const [key, action] of Object.entries(permission)) if (permissionMatches(key, id)) value = action;
  return value;
}
export function applyCatalogRestrictions(base: Record<string, unknown>, restrictions: readonly Restriction[]): Record<string, unknown> {
  const result = structuredClone(base);
  const append = (permission: unknown) => {
    const p = { ...(object(permission) ?? {}) };
    if (p["*"] !== "ask") throw new Error("Missing baseline ask permission");
    for (const [key, action] of restrictions) {
      if (!/^[A-Za-z0-9_*-]{1,128}$/.test(key) || [...NATIVE_PROTECTED].some(id => permissionMatches(key, id))) throw new Error("Catalog restriction is not allowed");
      if (action === "ask" && effectivePermission(object(permission) ?? {}, key) !== "ask") throw new Error("Catalog ask would override policy");
      delete p[key]; p[key] = action;
    }
    if (Object.keys(p).length > 1024) throw new Error("Catalog permission key bound");
    return p;
  };
  result.permission = append(result.permission);
  const agents = { ...(object(result.agent) ?? {}) };
  for (const name of ["build", "plan", "general", "explore"]) {
    const agent = { ...(object(agents[name]) ?? {}) }; agent.permission = append(agent.permission ?? base.permission); agents[name] = agent;
  }
  result.agent = agents;
  if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) throw new Error("Catalog overlay byte bound");
  return result;
}
export type Reduction = { kind: "noRoom" | "catalogUnknown" } | { kind: "ok"; restrictions: Restriction[]; overlay: Record<string, unknown>; kept: string[]; hidden: Record<string, string[]>; unknown: string[] };
export function reduceCatalog(mounts: readonly ToolMount[], budget: number, base: Record<string, unknown>): Reduction {
  const priorities: ToolRole[] = ["agents", "memory", "connected", "browser", "computer", "phoneJobs", "custom"];
  const ordered = mounts.map((m, i) => ({ ...m, index: i, ids: m.tools?.map(n => openCodeToolId(m.name, n)) })).sort((a, b) => priorities.indexOf(a.role) - priorities.indexOf(b.role) || a.index - b.index);
  const required = new Set<string>();
  for (const m of ordered.filter(m => m.role === "agents")) {
    if (!m.tools || !m.required?.length || m.required.some(n => !m.tools!.includes(n))) return { kind: "catalogUnknown" };
    m.required.forEach(n => required.add(openCodeToolId(m.name, n)));
  }
  if (budget < required.size) return { kind: "noRoom" };
  const dropped = new Set<number>();
  for (;;) {
    const kept = new Set(required); let partial = false;
    const selections = ordered.map(m => {
      const selected = new Set((m.ids ?? []).filter(id => required.has(id)));
      if (m.ids && !partial && !dropped.has(m.index)) {
        for (const id of m.ids) {
          if (kept.has(id)) selected.add(id);
          else if (kept.size < budget) { selected.add(id); kept.add(id); }
          else partial = true;
        }
      }
      return { m, selected };
    });
    const restrictions: Restriction[] = [], hidden: Record<string, string[]> = {}, unknown: string[] = [];
    let unsafe = false;
    for (const { m, selected } of selections) {
      const omitted = m.ids?.filter(id => !selected.has(id));
      if (m.ids && !omitted!.length) continue;
      if (!m.ids) unknown.push(m.name); else hidden[m.name] = omitted!;
      if (m.role === "agents") { for (const id of omitted ?? []) restrictions.push([id, "deny"]); }
      else {
        const pattern = `${sanitizeToolName(m.name)}_*`;
        if ([...required].some(id => permissionMatches(pattern, id)) || selections.some(other => other.m.index !== m.index && [...other.selected].some(id => permissionMatches(pattern, id)))) { unsafe = true; break; }
        restrictions.push([pattern, "deny"]);
        selected.forEach(id => restrictions.push([id, "ask"]));
      }
    }
    if (unsafe) return { kind: "noRoom" };
    try {
      const overlay = applyCatalogRestrictions(base, restrictions);
      const permission = object(overlay.permission)!;
      if ([...required].some(id => effectivePermission(permission, id) === "deny")) return { kind: "noRoom" };
      const visible = new Set(ordered.flatMap(m => m.ids ?? []).filter(id => effectivePermission(permission, id) !== "deny"));
      if (visible.size > budget) return { kind: "noRoom" };
      return { kind: "ok", restrictions, overlay, kept: [...visible], hidden, unknown };
    } catch {
      const optional = [...selections].reverse().find(({ m, selected }) => m.role !== "agents" && selected.size && !dropped.has(m.index));
      if (!optional) return { kind: "noRoom" };
      dropped.add(optional.m.index);
    }
  }
}

/** The persisted provider budget is app-owned state, separate from approval path resolution. */
export function openCodeToolLimitStore(dataDir: string): ToolLimitStore {
  return new ToolLimitStore(join(dataDir, "native", "opencode-tool-limits.json"));
}
