// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-SCOPE-1010: every Fuigo call reaches Murage's key guard.
//
// In `--permission-mode default` Fuigo 1.0.32 runs read_file, list_dir, grep, glob, mkdir, touch and a built-in
// list of "read-only" shell commands (cat, head, wc, ls, ...) with NO session/request_permission (fuigo-workspace
// permission/manager/mod.rs is_safe_command_words_str, the `AccessKind::Read/Grep => SAFE_COMMAND` pre-decision),
// so Murage never saw them. A permission `ask` rule outranks those built-in approvals (deny > ask > allow, rules
// before auto-approvals), and rules load only from files, so a bot's Fuigo runs in a Murage-owned FUIGO_HOME whose
// config.toml Murage writes whole (fuigo-scope.ts): the owner's settings filtered, then the rules below. The owner's
// own ~/.fuigo is never written.
//
// This module is the ONE renderer of that `[permission]` table, used by the bot scope, the provider-routed home
// (provider-routing.ts) and, through a pinned copy, the Cloud launcher (deploy/cloud-home/murage-turn-launch.py).
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SENSITIVE_PATHS } from "../../../shared/sensitive-paths.ts";
import { DATA_DIR } from "../../config.ts";
import { filterTomlPaths, readTomlTables, readTomlValue, scanToml, TomlScanError, type TomlValue } from "./toml-scan.ts";

/** One ask per access class, by Fuigo's own names (permission/rules.rs tool_name_to_filter), which covers every
 *  1.0.32 tool of that class (hub_permission.rs hub_policy_accesses):
 *    Bash      run_terminal_command, run_terminal_cmd, bash, shell (PowerShell on Windows included)
 *    Read(**)  read_file, read (target_file, file_path, filePath, path, files[].path), list_dir, lsp, memory_get
 *    Edit(**)  write, write_file, search_replace, apply_patch per target, hashline_edit
 *    Grep      grep, grep_files, glob
 *  `Read(**)` and `Edit(**)` are path-scoped on purpose: a pattern never matches a call with no path (policy.rs
 *  `None => false`), so a list of the cwd, a to-do update or plan mode never cards. `Grep` is bare (V1): a search
 *  with no path argument searches the cwd, and only grep, grep_files and glob are of that class. A sub-agent task
 *  maps to `Edit("task:...")`, which `**` does not reach: its own calls are judged one by one. web_fetch, MCP tools
 *  and the scheduler, image and workflow tools already ask in default. */
export const FUIGO_CLASS_ASK_RULES = ["Bash", "Read(**)", "Edit(**)", "Grep"] as const;

/** The key-path rows' action. "ask" sends a key read to Murage's hard-stop card, so the owner can allow a key they
 *  handed the bot (house rules 2 and 4). "deny" is the built-in fallback if a path-scoped ask is ever shown not to
 *  prompt on some tool: Fuigo then refuses the read itself. The class rules always ask. */
export const FUIGO_KEY_PATH_ACTION: "ask" | "deny" = "ask";

/** Fuigo reads a leading `~/` in a path pattern as literal text and a bare name as that exact string (user guide
 *  "Read, Edit, and Grep Rules"), so every home or project row becomes a `**` pattern; an absolute row stays. */
export function fuigoPathPattern(rule: string): string {
  if (rule.startsWith("~/")) return `**/${rule.slice(2)}`;
  if (rule.startsWith("/") || rule.startsWith("**/")) return rule;
  return `**/${rule}`;
}

/** Rule content as Fuigo unescapes it (rules.rs unescape_rule_content): backslash first, then the parentheses. */
export function escapeRuleContent(content: string): string {
  return content.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** A Bash text rule is a glob over the command and each segment. Rows are written with `/`; the Windows spelling
 *  (`$HOME\.ssh\id_ed25519`) gets a twin with `?` in its place. */
function bashPatterns(rule: string): string[] {
  return rule.includes("/") ? [rule, rule.replaceAll("/", "?")] : [rule];
}

/** Every SENSITIVE_PATHS row (shared/sensitive-paths.ts) as Fuigo rules: Read/Edit/Grep per path, Bash per text glob. */
export function fuigoSensitiveRules(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rule: string) => { if (!seen.has(rule)) { seen.add(rule); out.push(rule); } };
  for (const row of SENSITIVE_PATHS) {
    for (const read of row.read) {
      const pattern = escapeRuleContent(fuigoPathPattern(read));
      add(`Read(${pattern})`);
      add(`Edit(${pattern})`);
      add(`Grep(${pattern})`);
    }
    for (const bash of row.bash) for (const pattern of bashPatterns(bash)) add(`Bash(${escapeRuleContent(pattern)})`);
  }
  return out;
}

/** The bot's own rules: the class asks, then the key-path rows (ask, or deny under the fallback). */
export function fuigoAskRules(keyAction: "ask" | "deny" = FUIGO_KEY_PATH_ACTION): { ask: string[]; deny: string[] } {
  const sensitive = fuigoSensitiveRules();
  return keyAction === "deny"
    ? { ask: [...FUIGO_CLASS_ASK_RULES], deny: sensitive }
    : { ask: [...FUIGO_CLASS_ASK_RULES, ...sensitive], deny: [] };
}

/** Tool prefixes Fuigo 1.0.32 accepts in a compact rule (permission/rules.rs tool_name_to_filter). */
const TOOL_PREFIXES = new Set([
  "Bash", "Shell", "run_terminal_command", "Read", "read_file", "list_dir", "Edit", "Write", "search_replace", "MCPTool",
  "Grep", "Glob", "grep", "WebFetch", "web_fetch", "WebSearch", "web_search", "AgentMessage", "SendSubagentMessage", "SendAgentMessage",
]);
const UNSUPPORTED = new Set(["EnterWorktree", "NotebookEdit", "NotebookRead"]);

const unescapedAt = (text: string, at: number): boolean => {
  let slashes = 0;
  for (let j = at; j > 0 && text[j - 1] === "\\"; j--) slashes++;
  return slashes % 2 === 0;
};

/** Why Fuigo 1.0.32 would skip this compact rule string (parse_permission_rule), or null when it parses. */
export function fuigoRuleError(rule: string): string | null {
  const text = rule.trim();
  let open = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === "(" && unescapedAt(text, i)) { open = i; break; }
  if (open >= 0) {
    const prefix = text.slice(0, open).trim();
    const rest = text.slice(open + 1);
    let close = -1;
    for (let i = rest.length - 1; i >= 0; i--) if (rest[i] === ")" && unescapedAt(rest, i)) { close = i; break; }
    if (close < 0) return "missing closing parenthesis";
    if (UNSUPPORTED.has(prefix)) return `unsupported tool "${prefix}"`;
    if (!TOOL_PREFIXES.has(prefix)) return `unknown tool "${prefix}"`;
    return null;
  }
  if (UNSUPPORTED.has(text)) return `unsupported tool "${text}"`;
  return null;
}

const VERBOSE_PREFIX: Record<string, string> = {
  bash: "Bash", edit: "Edit", read: "Read", grep: "Grep", mcp: "MCPTool", webfetch: "WebFetch", websearch: "WebSearch",
  agent_message: "AgentMessage", agentmessage: "AgentMessage",
};

/** A verbose `[[permission.rules]]` entry (types.rs PermissionRule: action, tool, pattern, pattern_mode) as the
 *  compact string that means the same, or null when no compact string can carry it exactly. */
export function verboseRuleToCompact(entry: Record<string, TomlValue>): string | null {
  const tool = entry.tool ?? "any", pattern = entry.pattern, mode = entry.pattern_mode ?? "glob";
  if (typeof tool !== "string" || (pattern !== undefined && typeof pattern !== "string") || (mode !== "glob" && mode !== "domain")) return null;
  if (tool === "any") {
    if (pattern === undefined) return "";
    if (mode !== "glob" || pattern === "" || pattern.startsWith("mcp__") || TOOL_PREFIXES.has(pattern) || UNSUPPORTED.has(pattern)) return null;
    for (let i = 0; i < pattern.length; i++) if (pattern[i] === "(" && unescapedAt(pattern, i)) return null;
    return pattern;
  }
  const prefix = VERBOSE_PREFIX[tool];
  if (!prefix) return null;
  if (pattern === undefined) return mode === "glob" ? prefix : null;
  if (pattern === "" || pattern === "*") return null;
  if (mode === "glob" && pattern.startsWith("domain:")) return null;
  if (prefix === "Bash" && pattern.endsWith(":*")) return null;
  return `${prefix}(${escapeRuleContent(mode === "domain" ? `domain:${pattern}` : pattern)})`;
}

export interface OwnerDenies { rules: string[]; dropped: string[] }

/** The owner's own deny rules from their Fuigo (or Grok) config.toml `[permission]` table, as compact strings: every
 *  string in `deny = [...]` and every verbose rule whose action is deny (the serde default). `allow`, `ask` and mode
 *  keys are never carried: Murage's class asks reach every tool, and an owner allow must not undo them. An entry that
 *  is not a valid rule, or cannot be carried exactly, is dropped and named in `dropped` (the caller logs it); the
 *  owner's own engine still enforces it in the owner's home. */
export function ownerDenyRules(ownerConfig: string): OwnerDenies {
  const out: OwnerDenies = { rules: [], dropped: [] };
  if (!ownerConfig.trim()) return out;
  let read: ReturnType<typeof readTomlTables>;
  try { read = readTomlTables(ownerConfig); } catch (error) {
    if (error instanceof TomlScanError) { out.dropped.push("[permission] (config.toml could not be read)"); return out; }
    throw error;
  }
  const { tables, unreadable } = read;
  for (const path of unreadable) if (path === "permission" || path.startsWith("permission.deny") || path.startsWith("permission.rules")) out.dropped.push(path);
  const seen = new Set<string>();
  const compact = (value: TomlValue | undefined, where: string) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) { out.dropped.push(where); return; }
    value.forEach((item, i) => {
      if (typeof item !== "string") { out.dropped.push(`${where}[${i}]`); return; }
      const error = fuigoRuleError(item);
      if (error) { out.dropped.push(`${where}[${i}] "${item}": ${error}`); return; }
      if (!seen.has(item)) { seen.add(item); out.rules.push(item); }
    });
  };
  const verbose = (entry: TomlValue, where: string) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { out.dropped.push(where); return; }
    const action = Object.hasOwn(entry, "action") ? entry.action : "deny"; // A7: never an inherited property
    if (action !== "deny") return;
    const rule = verboseRuleToCompact(entry);
    if (rule === null || fuigoRuleError(rule)) { out.dropped.push(`${where}: ${JSON.stringify(entry)}`); return; }
    if (!seen.has(rule)) { seen.add(rule); out.rules.push(rule); }
  };
  const fromTable = (table: Record<string, TomlValue>, where: string) => {
    for (const [key, value] of Object.entries(table)) {
      if (key === "deny") compact(value, `${where}.deny`);
      else if (key === "rules") {
        if (Array.isArray(value)) value.forEach((entry, i) => verbose(entry, `${where}.rules[${i}]`));
        else out.dropped.push(`${where}.rules`);
      }
    }
  };
  const top = tables.get("")?.[0] ?? {};
  const inline = top.permission;
  if (inline && typeof inline === "object" && !Array.isArray(inline)) fromTable(inline, "permission");
  const dotted: Record<string, TomlValue> = {};
  for (const [key, value] of Object.entries(top)) if (key.startsWith("permission.")) dotted[key.slice("permission.".length)] = value;
  fromTable(dotted, "permission");
  for (const table of tables.get("permission") ?? []) fromTable(table, "permission");
  (tables.get("permission\u0000rules") ?? []).forEach((entry, i) => verbose(entry, `permission.rules[${i}]`));
  return out;
}

const tomlString = (value: string) => JSON.stringify(value);
const tomlList = (items: readonly string[]) => `[\n${items.map((item) => `  ${tomlString(item)},`).join("\n")}\n]`;

/** The memory MCP tools a provider-routed turn allows by their registered ids (never display titles). */
export const FUIGO_MEMORY_TOOLS = ["memory_search", "memory_get", "memory_save", "memory_propose_correction", "thread_search", "thread_list", "thread_read"] as const;
export const fuigoMemoryAllowPatterns = (server = "murage-memory"): string[] => FUIGO_MEMORY_TOOLS.map((tool) => `${server}__${tool}`);

/** The ONE `[permission]` table every Fuigo home Murage writes carries: compact `ask` and `deny` (the bot's rules and
 *  the owner's denies) and the verbose memory allows in the same table (resolution.rs reads verbose beside compact).
 *  Compact entries are skipped one by one if bad, while a bad verbose list drops whole, so only Murage's own fixed
 *  memory entries are ever verbose. */
export function fuigoPermissionToml(input: { ask: readonly string[]; deny?: readonly string[]; memoryAllow?: readonly string[] }): string {
  let out = `[permission]\nask = ${tomlList(input.ask)}\n`;
  if (input.deny?.length) out += `deny = ${tomlList(input.deny)}\n`;
  if (input.memoryAllow?.length) {
    out += `rules = [\n${input.memoryAllow.map((pattern) => `  { action = "allow", tool = "mcp", pattern = ${tomlString(pattern)} },`).join("\n")}\n]\n`;
  }
  return out;
}

/** The whole `[permission]` table for a home Murage owns, with the owner's denies folded in and any that could not be
 *  carried logged once by name. */
export function fuigoHomePermission(ownerConfig: string, memoryAllow?: readonly string[], log: (line: string) => void = (line) => console.warn(line)): string {
  const rules = fuigoAskRules();
  const owner = ownerDenyRules(ownerConfig);
  for (const dropped of owner.dropped) log(`Fuigo: an owner deny rule could not be carried into the bot's settings and is enforced only in the owner's own Fuigo: ${dropped}`);
  return fuigoPermissionToml({ ask: rules.ask, deny: [...owner.rules, ...rules.deny.filter((rule) => !owner.rules.includes(rule))], ...(memoryAllow ? { memoryAllow } : {}) });
}

/** Prefix of every `[model.*]` table Murage owns in a Fuigo config. */
export const FUIGO_LOCAL_PREFIX = "murage-local-";

/** The owner's config.toml as a bot may see it: without the tables and keys that start or run the owner's own servers,
 *  hooks, skills and plugins, without their permission table (only its denies come back, folded into Murage's), without
 *  `[cli]` (Murage writes `use_leader = false`) and without the `[model."murage-local-*"]` tables earlier Murage
 *  versions wrote there (the bot's are appended from Murage's own folder instead). `[endpoints]` stays, so an owner's
 *  `deployment_key` keeps their organisation's policy in force. A file the scanner cannot read gives "". */
export function filterFuigoConfigToml(text: string): string {
  return filterTomlPaths(text, (path) =>
    ["mcp_servers", "hooks", "skills", "plugins", "permission", "cli"].includes(path[0]!)
    || (path[0] === "model" && typeof path[1] === "string" && path[1].startsWith(FUIGO_LOCAL_PREFIX)));
}

/** Murage's own pins in every bot Fuigo config: no leader (a leader carries another process's mode and credential)
 *  and no Claude Code plugin discovery (that switch is config-only, so only a Murage-owned home can turn it off). */
export const FUIGO_SCOPE_PINS = "[cli]\nuse_leader = false\n\n[plugins]\nauto_discover = false\n";

/** Where Murage keeps the `[model."murage-local-…"]` tables a bot's Fuigo config is given: one file per slug. */
export const fuigoLocalModelDir = (): string => join(DATA_DIR, "native", "fuigo-local-models");

/** The keys ensureFuigoLocalModel (fuigo.ts) writes in a local-model table, with the shape each value must have. */
const LOCAL_MODEL_KEYS: Record<string, (value: TomlValue) => boolean> = {
  model: (v) => typeof v === "string",
  base_url: (v) => typeof v === "string" && /^https?:\/\/[^\s"]+$/i.test(v),
  name: (v) => typeof v === "string",
  env_key: (v) => typeof v === "string" && /^MURAGE_LOCAL_[A-Z0-9_]+_API_KEY$/.test(v),
  api_backend: (v) => typeof v === "string" && /^[a-z_]{1,64}$/.test(v),
  context_window: (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
};

/**
 * FUIGO-SCOPE-1010 G3: one file of Murage's local-model folder, as the bot's config may carry it, or null. The file is
 * never pasted: it must be exactly ONE `[model."murage-local-<its own slug>"]` table holding only the keys
 * ensureFuigoLocalModel writes, each of its own shape, and the table is rendered again from the decoded values. Anything
 * else (an `[mcp_servers.x]` or hooks table a bot wrote there, a second table, a key outside the list, a top-level key,
 * an array table) and the whole file is refused.
 */
export function renderFuigoLocalModelFile(fileName: string, text: string): string | null {
  const slug = fileName.endsWith(".toml") ? fileName.slice(0, -".toml".length) : "";
  if (!slug.startsWith(FUIGO_LOCAL_PREFIX) || !/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  let statements;
  try { statements = scanToml(text); } catch { return null; }
  const [header, ...pairs] = statements;
  if (!header || header.kind !== "header" || text[header.start + 1] === "[") return null;
  if (header.path.length !== 2 || header.path[0] !== "model" || header.path[1] !== slug) return null;
  const values = new Map<string, TomlValue>();
  for (const pair of pairs) {
    if (pair.kind !== "pair" || pair.path.length !== 1) return null;
    const key = pair.path[0]!;
    if (!Object.hasOwn(LOCAL_MODEL_KEYS, key) || values.has(key)) return null;
    let value: TomlValue;
    try { value = readTomlValue(text, pair.valueStart!, pair.valueEnd!); } catch { return null; }
    if (!LOCAL_MODEL_KEYS[key]!(value)) return null;
    values.set(key, value);
  }
  for (const key of ["model", "base_url", "env_key"]) if (!values.has(key)) return null;
  const lines = [`[model.${JSON.stringify(slug)}]`];
  for (const key of Object.keys(LOCAL_MODEL_KEYS)) if (values.has(key)) lines.push(`${key} = ${JSON.stringify(values.get(key))}`);
  return `${lines.join("\n")}\n`;
}

/** The organisation policy files Fuigo syncs into its home (fuigo-shell managed_config/store.rs MANAGED_ARTIFACT_FILES)
 *  plus the sync marker that records Fuigo served them (managed_cache.rs MANAGED_CONFIG_CACHE_FILE). */
export const FUIGO_ORG_POLICY_FILES = ["managed_config.toml", "requirements.toml", "managed_config.sig.json", "managed_identity.sig.json", "managed_config_cache.json"] as const;
const MARKER = "managed_config_cache.json";

export class FuigoPolicyUnreadableError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) { super(`Fuigo's organisation settings file ${file} could not be read`, { cause }); this.name = "FuigoPolicyUnreadableError"; this.file = file; }
}
export class FuigoPolicyChangingError extends Error {
  constructor() { super("Fuigo's organisation settings were being updated while the bot's copy was made"); this.name = "FuigoPolicyChangingError"; }
}

function readOwnerPolicy(ownerHome: string): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  for (const name of FUIGO_ORG_POLICY_FILES) {
    try { out.set(name, readFileSync(join(ownerHome, name))); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") out.set(name, null);
      else throw new FuigoPolicyUnreadableError(name, error);
    }
  }
  return out;
}
const sameSnapshot = (a: Map<string, Buffer | null>, b: Map<string, Buffer | null>) =>
  FUIGO_ORG_POLICY_FILES.every((name) => { const x = a.get(name), y = b.get(name); return x === y || (x !== null && y !== null && x !== undefined && y !== undefined && x.equals(y)); });

/** The owner's marker with its rollback floor never below the floor the copy already holds (managed_cache.rs raises it
 *  monotonically between fetches; a reseed must not lower it). See A8 below for a marker that does not parse. */
function markerWithFloor(owner: Buffer, current: Buffer | null): Buffer {
  if (!current) return owner;
  // A8: the copy's floor must be established before it is replaced. A copy that does not parse (or whose floor is not a
  // number) refuses the reseed rather than let an older floor in; an owner marker that does not parse is copied only when
  // the copy holds no floor above zero.
  let theirs: Record<string, unknown>;
  try { theirs = JSON.parse(current.toString("utf8")) as Record<string, unknown>; } catch (error) { throw new FuigoPolicyUnreadableError(MARKER, error); }
  if (!theirs || typeof theirs !== "object" || ("rollback_floor" in theirs && typeof theirs.rollback_floor !== "number")) throw new FuigoPolicyUnreadableError(MARKER, new Error("rollback floor unreadable"));
  const b = typeof theirs.rollback_floor === "number" ? theirs.rollback_floor : 0;
  let mine: Record<string, unknown>;
  try { mine = JSON.parse(owner.toString("utf8")) as Record<string, unknown>; } catch (error) {
    if (b > 0) throw new FuigoPolicyUnreadableError(MARKER, error);
    return owner;
  }
  const a = mine && typeof mine === "object" && typeof mine.rollback_floor === "number" ? mine.rollback_floor : 0;
  if (b <= a || mine.principal !== theirs.principal) return owner;
  return Buffer.from(JSON.stringify({ ...mine, rollback_floor: b }));
}

function replaceFile(path: string, bytes: Buffer): void {
  const temporary = `${path}.murage-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, path); return; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
  } catch (error) { try { unlinkSync(temporary); } catch { /* none */ } throw error; }
}

/**
 * The owner's organisation policy, as Fuigo synced it into their home, copied into a home Murage owns (a bot scope or
 * a provider-routed home) on every spawn. A replaced FUIGO_HOME would otherwise drop the owner's user-tier
 * managed_config.toml and requirements.toml (loader.rs managed_config_layers_at reads /etc/fuigo and $FUIGO_HOME only).
 * Byte copies, never edited (but for the marker's rollback floor, which only ever rises), never written back, no
 * symlink. The five files are read twice and must agree, so a sync in progress in the owner's home is never copied half
 * done (Node has no flock; FuigoPolicyChangingError retries the turn). A present owner file that cannot be read fails
 * the turn (FuigoPolicyUnreadableError). An absent owner file is removed from the copy, with the staged refresh,
 * write temporaries and `.user-*.bak` copies Fuigo may have left in that Murage-owned home (rule 6).
 */
export function copyFuigoOrgPolicy(ownerHome: string, targetHome: string): void {
  let snapshot = readOwnerPolicy(ownerHome);
  for (let attempt = 0; ; attempt++) {
    const again = readOwnerPolicy(ownerHome);
    if (sameSnapshot(snapshot, again)) break;
    if (attempt >= 2) throw new FuigoPolicyChangingError();
    snapshot = again;
  }
  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  // G2 / Astra M9: the copy goes only into a real folder, never through a link a bot put in its place.
  if (!lstatSync(targetHome).isDirectory()) throw new FuigoPolicyUnreadableError(".", new Error("the bot's Fuigo home is not a folder"));
  for (const name of FUIGO_ORG_POLICY_FILES) {
    const path = join(targetHome, name);
    const owner = snapshot.get(name) ?? null;
    let current: Buffer | null = null;
    // A8: absence and a read failure are different things. Only a missing copy counts as none; an existing copy that
    // cannot be read fails the turn (its rollback floor cannot be established). A link at the name is replaced, not read.
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
      else current = readFileSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new FuigoPolicyUnreadableError(name, error);
    }
    if (owner === null) { if (current !== null) rmSync(path, { force: true }); continue; }
    const bytes = name === MARKER ? markerWithFloor(owner, current) : owner;
    if (!current || !current.equals(bytes)) replaceFile(path, bytes);
  }
  let entries: string[] = [];
  try { entries = readdirSync(targetHome); } catch { /* none */ }
  for (const entry of entries) {
    const stale = (entry.endsWith(".tmp") && FUIGO_ORG_POLICY_FILES.some((name) => entry.startsWith(`${name}.`)))
      || ((entry.startsWith("managed_config.toml.user-") || entry.startsWith("requirements.toml.user-")) && entry.endsWith(".bak"));
    if (stale) rmSync(join(targetHome, entry), { force: true });
  }
  // Astra M9: a `staged` that is a link (to the owner's own staged folder) is removed as a link, never traversed.
  const staged = join(targetHome, "staged");
  let stagedStat = null;
  try { stagedStat = lstatSync(staged); } catch { /* none */ }
  if (stagedStat?.isSymbolicLink()) unlinkSync(staged);
  else if (stagedStat?.isDirectory()) rmSync(join(staged, "managed_config_refresh.json"), { force: true });
}
