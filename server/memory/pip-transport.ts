// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 transport for text-only reflection (P2-ENTITY-DESIGN.md 3.1 and 3.3,
// P2-AMENDMENT-v5.1.md A.1, A.2, A.3, A.5, A.6). Pure host-side pieces: route
// fingerprint, host path preflight (runs before any spawn), route binding over
// applyProviderRoute, the env allowlist, the temp root lifecycle, the NDJSON
// parser for the Messages transport, the per-run gate and the miss map.
// The process work lives in drivers/headless-text-only.ts and memory/pip-reaper.ts.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { findCliCandidates, resolveCliSpawn } from "../env-path.ts";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { applyProviderRoute, type ProviderTurnRoute } from "../provider-routing.ts";
import { ensureGrokInjectSlug } from "../drivers/acp/grok.ts";

export type JsonSchema = Record<string, unknown>;
export type PipEngine = "fuigo" | "grok" | "claude";

// ---------------------------------------------------------------- types ----

/** Local minimal shapes; the reflection state machine (B3) persists these. */
export interface BootEpoch { pid: number; startedAt: number }
export interface TransportIntent {
  runId: string; family: string; attempt: number; tempRoot: string;
  jobName?: string; binaryIdentity?: string | null; bootEpoch: BootEpoch; intentAt: number; deadlineAt: number;
}
export interface TransportChild { pid: number; startTime: string; registeredAt: number }
export interface AttemptTransport {
  /** "http" attempts have no pid: an older epoch goes straight to uncertain-transport (A.5). */
  kind?: "cli" | "http";
  intent: TransportIntent; child?: TransportChild; reaperFailures?: number;
}
export interface TransportHooks {
  /** Usage received before cancellation or another rejection must still reach owner status. */
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void;
  /** Must persist durably before the function returns; called before spawn. */
  onIntent?: (intent: TransportIntent) => void | Promise<void>;
  /** Called right after spawn once pid and start time are known. */
  onChild?: (child: TransportChild) => void | Promise<void>;
}

export interface IsolationReport {
  mcpServers: string[]; tools: string[]; homeNewFiles: string[]; cwdNewFiles: string[];
  stopReason?: string; exited: boolean; initLine: boolean;
}

export interface TextOnlyTurnInput {
  system: string; text: string; model: string; providerRoute?: ProviderTurnRoute;
  outputSchema: JsonSchema; signal: AbortSignal; maxOutputTokens: number; maxOutputBytes: number;
  context: { botId: string; runId: string; family: string; attempt: number };
  /** Optional host-owned transport context (B3 supplies it; absent in plain callers). */
  transport?: {
    bootEpoch?: BootEpoch; deadlineAt?: number; hooks?: TransportHooks;
    /** Prior misses recorded under this route fingerprint (A.6 escalation). */
    history?: MissHistory;
  };
}

/** One terminal state per attempt (A.6 and the section 3.1 table). */
export type Verdict =
  | { state: "validated"; structured: unknown }
  | { state: "unsupported"; reason: "tools" | "managed-config" | "transport" | "login-route" | "auth" | "route"; detail?: string }
  | { state: "refused"; reason: "isolation" | "bad-output" | "transient"; detail: string; counted: boolean; missKey?: string }
  | { state: "uncertain-transport"; reason: string };

export interface TextOnlyTurnResult {
  /** JSON text of the validated body; empty unless verdict is validated. */
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  isolation: IsolationReport;
  verdict: Verdict;
  /** Reported output above the requested limit (A.3); informational. */
  reportedOverLimit?: boolean;
}

export interface MissHistory {
  /** Miss keys already seen on this fingerprint (cwd or home file misses). */
  isolationMissKeys: string[];
  /** Count of earlier no-init-line refusals on this fingerprint. */
  noInitLine: number;
}
export const emptyMissHistory = (): MissHistory => ({ isolationMissKeys: [], noInitLine: 0 });
/** Pure update after a verdict, for the caller to persist under the fingerprint. */
export function recordMiss(history: MissHistory, verdict: Verdict): MissHistory {
  const next: MissHistory = { isolationMissKeys: [...history.isolationMissKeys], noInitLine: history.noInitLine };
  if (verdict.state === "refused" && verdict.reason === "isolation") {
    if (verdict.detail === "no-init-line") next.noInitLine += 1;
    else if (verdict.missKey && !next.isolationMissKeys.includes(verdict.missKey)) next.isolationMissKeys.push(verdict.missKey);
  }
  return next;
}

// Output and time limits (A.3). Reported, not negotiated.
export const MAX_OUTPUT_BYTES = 12 * 1024;
export const FIRST_BYTE_MS = 120_000;
export const RUN_BOUND_MS = 270_000;
export const HELD_PLUGIN_COPY = "Reflection on this engine is held while plugins are installed in its home.";
export const LOGIN_ROUTE_COPY = "Reflection on this engine needs a model connection or FluxRouter.";

const sha = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

// ------------------------------------------------------------ identities ----

export interface BinaryIdentityDeps {
  stat?: (path: string) => { size: number; mtimeMs: number } | null;
  version?: (path: string) => Promise<string>;
}
export async function binaryIdentity(path: string, deps: BinaryIdentityDeps = {}): Promise<string> {
  const stat = deps.stat ?? ((p: string) => { try { const s = lstatSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } });
  const s = stat(path);
  // Hash executable bytes without executing it in the parent's environment. The
  // separately persisted schema probe uses the adapter's isolated, owned runner.
  let identity: string;
  if (deps.version) identity = await deps.version(path);
  else {
    const launch = resolveCliSpawn(path, []), executable = findCliCandidates(launch.command)[0] ?? launch.command;
    const files = [executable, ...launch.args.filter(arg => { try { return lstatSync(arg).isFile(); } catch { return false; } })];
    identity = sha(launch.command, launch.args, files.map(file => [resolve(file), createHash("sha256").update(readFileSync(file)).digest("hex")]));
  }
  return sha("binary", resolve(path), s?.size ?? null, s?.mtimeMs ?? null, identity);
}

export interface RouteFingerprintInputs {
  instanceId: string; model: string; connectionId?: string | null; connectionRevision?: string | null;
  adapterKind: string; binaryIdentity?: string | null; managedConfigIdentity?: string | null;
}
export function routeFingerprint(i: RouteFingerprintInputs): string {
  return sha("route", i.instanceId, i.model, i.connectionId ?? null, i.connectionRevision ?? null, i.adapterKind, i.binaryIdentity ?? null, i.managedConfigIdentity ?? null);
}

// ---------------------------------------------------- host-side preflight ----

export interface PreflightOptions {
  platform?: NodeJS.Platform;
  /** Real $HOME (for ~/.claude/plugins). */
  home?: string;
  /** The ONE parent Grok home for this route: the same value the auth copy reads (default GROK_HOME or ~/.grok). */
  grokHome?: string;
  /** Root of the system config dir; "/etc" on POSIX. Injectable for tests. */
  etcRoot?: string;
  /** Directory scanned for MDM profile files (macOS managed preferences). */
  mdmDir?: string | null;
  /** Full override of the Claude managed-settings path. */
  claudeManagedPath?: string;
  /** Reads whether the forced `ai.x.grok:requirements_toml_base64` preference exists (macOS only by default). */
  readMdm?: () => Presence;
}
export interface PreflightTargets {
  /** Presence of any of these refuses the route: unsupported managed-config. */
  managed: string[];
  /** Plugin sources: identity only (Fuigo) or refusal when non-empty (native Grok, via grokPluginDirs). */
  plugins: string[];
  /** Parent Grok home plugin directories: non-empty refuses native Grok in P2. */
  grokPluginDirs: string[];
}

/** Absence and an inspection failure are different observations: only ENOENT and ENOTDIR mean absent. */
export type Presence = "present" | "absent" | "unknown";

/** The forced MDM domain both the Fuigo and the Grok binaries read (fuigo-config/src/macos_managed.rs). */
export const MDM_DOMAIN = "ai.x.grok";
export const MDM_KEY = "requirements_toml_base64";

/** `defaults read` finds forced and user values alike; a user value only makes the refusal more conservative. */
export function readMdmPreference(): Presence {
  const r = spawnSync("/usr/bin/defaults", ["read", MDM_DOMAIN, MDM_KEY], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (r.error) return "unknown";
  if (r.status === 0) return "present";
  return /does not exist/i.test(String(r.stderr ?? "")) ? "absent" : "unknown";
}

function mdmMatches(dir: string | null | undefined, engine: PipEngine): string[] {
  if (!dir) return [];
  // The Fuigo and Grok binaries read the forced preference domain `ai.x.grok` (profile file ai.x.grok.plist). Both also
  // read Claude's managed settings for compatibility, so a Claude profile counts for every engine.
  const want = engine === "claude" ? /claude/i : /^ai\.x\.grok(\.plist)?$/i;
  const any = /claude/i;
  try { return readdirSync(dir).filter((n) => want.test(n) || any.test(n)).map((n) => join(dir, n)); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return [];
    throw error;
  }
}

export function preflightTargets(engine: PipEngine, o: PreflightOptions = {}): PreflightTargets {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const etc = o.etcRoot ?? "/etc";
  const mdmDir = o.mdmDir === undefined ? (platform === "darwin" ? "/Library/Managed Preferences" : null) : o.mdmDir;
  const claudeManaged = o.claudeManagedPath ?? (platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : platform === "win32" ? "C:\\ProgramData\\ClaudeCode\\managed-settings.json" : join(etc, "claude-code", "managed-settings.json"));
  const managed: string[] = [claudeManaged, ...mdmMatches(mdmDir, engine)];
  const plugins: string[] = [join(home, ".claude", "plugins"), join(home, ".claude", "installed_plugins.json")];
  const grokPluginDirs: string[] = [];
  // Both binaries load `managed_config.toml` and `requirements.toml` (fuigo-config and xai-grok-config loader.rs);
  // the hyphenated spelling an earlier draft used is kept as well, since a stray file of either name is worth refusing.
  const files = (dir: string) => [join(dir, "managed_config.toml"), join(dir, "managed-config.toml"), join(dir, "requirements.toml")];
  if (engine === "fuigo") managed.push(...files(join(etc, "fuigo")));
  if (engine === "grok") {
    const parent = o.grokHome ?? process.env.GROK_HOME ?? join(home, ".grok");
    managed.push(...files(join(etc, "grok")), ...files(parent));
    grokPluginDirs.push(join(parent, "plugins"), join(parent, "installed-plugins"));
  }
  return { managed, plugins, grokPluginDirs };
}

const probe = (p: string): Presence => {
  try { lstatSync(p); return "present"; } catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown"; }
};
/** Non-empty directory or any file; a failed read is unknown, never empty. */
const nonEmptyProbe = (p: string): Presence => {
  const at = probe(p);
  if (at !== "present") return at;
  try { const s = lstatSync(p); return s.isDirectory() ? (readdirSync(p).length > 0 ? "present" : "absent") : "present"; } catch { return "unknown"; }
};
const mtime = (p: string): number | null => { try { return lstatSync(p).mtimeMs; } catch { return null; } };

function mdmState(engine: PipEngine, o: PreflightOptions): Presence {
  if (engine === "claude") return "absent";
  const platform = o.platform ?? process.platform;
  const read = o.readMdm ?? (platform === "darwin" ? readMdmPreference : undefined);
  if (!read) return "absent";
  try { return read(); } catch { return "unknown"; }
}

/** Existence and mtime of every watched path, and the forced preference; a change re-probes the route. */
export function managedConfigIdentity(t: PreflightTargets, mdm: Presence = "absent"): string {
  const all = [...t.managed, ...t.plugins, ...t.grokPluginDirs].sort();
  return sha("managed", all.map((p) => [p, probe(p), mtime(p)]), mdm);
}

export type PreflightResult =
  | { ok: true; identity: string }
  | { ok: false; identity: string; verdict: Extract<Verdict, { state: "unsupported" }>; copy?: string; paths: string[] };

/** Step 1a: path checks, no process. A refusal here means nothing was spawned. An inspection failure refuses too: absence is never assumed. */
export function preflightRoute(engine: PipEngine, o: PreflightOptions = {}): PreflightResult {
  let t: PreflightTargets;
  try { t = preflightTargets(engine, o); }
  catch { return { ok: false, identity: sha("inspection-failed", engine, o.mdmDir), verdict: { state: "unsupported", reason: "managed-config", detail: "inspection-failed: managed preferences" }, paths: [o.mdmDir ?? "/Library/Managed Preferences"] }; }
  const mdm = mdmState(engine, o);
  const identity = managedConfigIdentity(t, mdm);
  const states = t.managed.map((p) => [p, probe(p)] as const);
  const hit = states.filter(([, s]) => s === "present").map(([p]) => p);
  if (mdm === "present") hit.push(`${MDM_DOMAIN}:${MDM_KEY}`);
  if (hit.length) return { ok: false, identity, verdict: { state: "unsupported", reason: "managed-config", detail: hit.join(", ") }, paths: hit };
  const held = t.grokPluginDirs.map((p) => [p, nonEmptyProbe(p)] as const);
  // P2 conservative rule for native Grok until a plugin-bearing host has passed the per-run gate.
  const heldHit = held.filter(([, s]) => s === "present").map(([p]) => p);
  if (heldHit.length) return { ok: false, identity, verdict: { state: "unsupported", reason: "managed-config", detail: heldHit.join(", ") }, copy: HELD_PLUGIN_COPY, paths: heldHit };
  const unknown = [...states, ...held].filter(([, s]) => s === "unknown").map(([p]) => p);
  if (mdm === "unknown") unknown.push(`${MDM_DOMAIN}:${MDM_KEY}`);
  if (unknown.length) return { ok: false, identity, verdict: { state: "unsupported", reason: "managed-config", detail: `inspection-failed: ${unknown.join(", ")}` }, paths: unknown };
  return { ok: true, identity };
}

// ------------------------------------------------------- temp root + env ----

export interface TempRoot { root: string; work: string; home: string; promptFile: string; debugFile: string }
const ROOT_NAME = /^[a-z0-9][a-z0-9-]{0,120}$/;

/** `<base>/<runId>-<attempt>-<rand>`: private, with work/ and home/, and the prompt file unique per attempt. */
export function createTempRoot(base: string, runId: string, attempt: number, prompt: string): TempRoot {
  const name = `${runId}-${attempt}-${randomBytes(4).toString("hex")}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!ROOT_NAME.test(name)) throw new Error("PIP_TEMP_ROOT_NAME");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = resolve(join(base, name));
  mkdirSync(root, { mode: 0o700 });
  const work = join(root, "work"), home = join(root, "home");
  mkdirSync(work, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const promptFile = join(root, "prompt.txt");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  return { root, work, home, promptFile, debugFile: join(root, "debug.log") };
}
/** Only ever called after confirmed exit; refuses a path outside the base. */
export function removeTempRoot(base: string, root: string): boolean {
  const b = resolve(base) + sep, r = resolve(root);
  if (!r.startsWith(b) || r === resolve(base)) return false;
  rmSync(r, { recursive: true, force: true });
  return true;
}

export const FUIGO_OFF_SWITCHES = { FUIGO_TELEMETRY_ENABLED: "0", FUIGO_SUBAGENTS: "0", FUIGO_MEMORY: "0", FUIGO_MANAGED_CONFIG: "0", FUIGO_DISABLE_AUTOUPDATER: "1" } as const;
export const GROK_OFF_SWITCHES = { GROK_TELEMETRY_ENABLED: "0", GROK_SUBAGENTS: "0", GROK_MEMORY: "0", GROK_MANAGED_CONFIG: "0", GROK_DISABLE_AUTOUPDATER: "1" } as const;

/** The whole environment of a reflection child: PATH, HOME=T, what the binding set, the off switches. */
export function buildReflectionEnv(engine: "fuigo" | "grok", pathValue: string, tempHome: string, tempRoot: string, bound: Record<string, string>): Record<string, string> {
  return { PATH: pathValue, HOME: tempRoot, ...bound, ...(engine === "fuigo" ? FUIGO_OFF_SWITCHES : GROK_OFF_SWITCHES), ...(engine === "fuigo" ? { FUIGO_HOME: tempHome } : { GROK_HOME: tempHome }) };
}

// ------------------------------------------------------------ route bind ----

export interface ReflectionBinding {
  ok: true; model: string; env: Record<string, string>; cleanup: () => void;
}
export type ReflectionBindingResult = ReflectionBinding | { ok: false; verdict: Extract<Verdict, { state: "unsupported" }>; copy?: string };

export interface BindOptions {
  driver: "fuigoAgent" | "grokAgent";
  temp: TempRoot; model: string; runId: string;
  providerRoute?: ProviderTurnRoute;
  /** Flux key for native-login Fuigo (FUIGO_API_KEY is the whole mechanism). */
  fluxKey?: string;
  /** Parent Grok home holding auth.json for native Grok. */
  parentGrokHome?: string;
}

/** bindReflectionRoute over applyProviderRoute with the homeRoot field. The returned env holds only what the binding set. */
export function bindReflectionRoute(o: BindOptions): ReflectionBindingResult {
  const scratch: NodeJS.ProcessEnv = {};
  if (o.providerRoute) {
    const bound = applyProviderRoute(o.driver, scratch, o.providerRoute, { threadId: o.runId, homeRoot: o.temp.home });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(scratch)) if (typeof v === "string") env[k] = v;
    return { ok: true, model: bound.model, env, cleanup: () => {} };
  }
  if (o.driver === "fuigoAgent") {
    if (!o.fluxKey) return { ok: false, verdict: { state: "unsupported", reason: "login-route" }, copy: LOGIN_ROUTE_COPY };
    return { ok: true, model: o.model, env: { FUIGO_API_KEY: o.fluxKey }, cleanup: () => {} };
  }
  // Native-login Grok: copy exactly auth.json from the parent home, nothing else.
  const parent = o.parentGrokHome ?? join(homedir(), ".grok"), source = join(parent, "auth.json");
  if (!existsSync(source)) return { ok: false, verdict: { state: "unsupported", reason: "auth" } };
  const target = join(o.temp.home, "auth.json");
  copyFileSync(source, target);
  try { chmodSync(target, 0o600); } catch { /* best effort on Windows */ }
  const model = ensureGrokInjectSlug(o.model, { GROK_HOME: o.temp.home });
  return { ok: true, model, env: {}, cleanup: () => {} };
}

// ------------------------------------------------------- tree snapshots ----

/**
 * Relative file paths under a directory (files only, depth-first, sorted). A directory that cannot be read is an
 * inspection failure and throws: an unreadable tree is never an empty one. A missing top directory is empty.
 * `skipTop` names top-level directories listed separately (the temp root holds home/ and work/).
 */
export function listFiles(dir: string, skipTop: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let names: string[];
    try { names = readdirSync(d); } catch (e) {
      if (!rel && (e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`PIP_INVENTORY:${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    for (const n of names.sort()) {
      if (!rel && skipTop.includes(n)) continue;
      const p = join(d, n), r = rel ? `${rel}/${n}` : n;
      let s;
      try { s = lstatSync(p); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // raced a delete
        throw new Error(`PIP_INVENTORY:${(e as NodeJS.ErrnoException).code ?? "error"}`);
      }
      if (s.isDirectory()) walk(p, r); else out.push(r);
    }
  };
  walk(dir, "");
  return out;
}
export const newFiles = (before: string[], after: string[]): string[] => { const seen = new Set(before); return after.filter((f) => !seen.has(f)); };
/** New files the engine may write in its home: the session file, binding config, copied auth. */
// `logs/` is written by session persistence for MCP loading, which headless cannot disable
// (fuigo-shell/src/session/persistence.rs:2257); the live check records the exact set on the bundled binary.
// Fuigo and Grok also extract the user guide (`docs/user-guide/NN-*.md`, fuigo-pager docs.rs) and keep the crashed
// session registry (`active_sessions.json`, its lock and temp file, fuigo-active-sessions) at every start-up; both are
// inert files the engine writes in its own home, admitted by exact shape rather than by directory.
export const DEFAULT_ALLOWED_HOME_NEW = [
  /^sessions\//, /^logs\//, /^config\.toml$/, /^auth\.json$/,
  /^docs\/user-guide\/[A-Za-z0-9._-]+\.md$/, /^active_sessions\.(json|lock|json\.tmp)$/,
];
/** The temp root itself is $HOME for the child: the only file the engine may add there is its debug log. */
export const DEFAULT_ALLOWED_ROOT_NEW = [/^debug\.log$/];

// --------------------------------------------------------------- parsing ----

export interface ParsedResult {
  subtype: string; isError: boolean; /** false when is_error was missing or not a boolean: never read as "no error". */ isErrorValid: boolean; stopReason?: string; errors: string[];
  usage?: { inputTokens?: number; outputTokens?: number }; structuredOutput?: unknown; text?: string;
}
export interface ParsedRun {
  initCount: number; resultCount: number; malformed: number;
  tools: string[] | null; mcpServers: string[] | null;
  toolCallLines: number; result?: ParsedResult;
  /** Claude's synthetic answer tool (`--json-schema`): its tool_use blocks, and the tool_result blocks that answer one. Neither counts in `toolCallLines`. */
  structuredCalls: { id: string | null; input: unknown }[]; structuredResults: number;
  /** 0-based position among the non-empty lines; null when the line never appeared. Init must precede the result. */
  initSeq: number | null; resultSeq: number | null;
}

const nameOf = (v: unknown): string | null => typeof v === "string" ? v : (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") ? (v as { name: string }).name : null;
// Any tool-shaped event counts, including the backend search forms (`server_tool_use`, `web_search_tool_result`,
// `mcp_tool_use`) Fuigo emits (fuigo-pager headless reducer wire.rs): the type names a tool, or the message carries a tool call list.
const toolType = (v: unknown): boolean => typeof v === "string" && /tool|function_call/i.test(v);
function hasToolBlock(line: Record<string, unknown>): boolean {
  if (toolType(line.type)) return true;
  const holders = [line, line.message].filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && !Array.isArray(h));
  for (const h of holders) {
    if (Array.isArray(h.tool_calls) && h.tool_calls.length) return true;
    if (h.function_call && typeof h.function_call === "object") return true;
    const content = Array.isArray(h.content) ? h.content : [];
    if (content.some((b) => b && typeof b === "object" && toolType((b as { type?: unknown }).type))) return true;
  }
  return false;
}
/** The CLI's own answer tool under `--json-schema`. It is not a capability: its input is the schema object itself. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * Split a line's content blocks into the StructuredOutput tool_use blocks, the tool_result blocks answering a call already
 * seen, and the remainder (returned as a copy of the line with those blocks removed, for the ordinary tool check).
 */
function takeStructuredBlocks(line: Record<string, unknown>, knownIds: Set<string | null>): { calls: { id: string | null; input: unknown }[]; results: number; rest: Record<string, unknown> } {
  const calls: { id: string | null; input: unknown }[] = []; let results = 0;
  const msg = line.message;
  if ((line.type !== "assistant" && line.type !== "user") || !isRec(msg) || !Array.isArray(msg.content)) return { calls, results, rest: line };
  const kept = msg.content.filter((b) => {
    if (!isRec(b)) return true;
    if (line.type === "assistant" && b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL) {
      calls.push({ id: typeof b.id === "string" ? b.id : null, input: b.input }); return false;
    }
    if (line.type === "user" && b.type === "tool_result" && knownIds.has(typeof b.tool_use_id === "string" ? b.tool_use_id : null)) { results++; return false; }
    return true;
  });
  return { calls, results, rest: { ...line, message: { ...msg, content: kept } } };
}
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** NDJSON parser for streaming-messages-json (Fuigo, Grok) and Claude stream-json. */
export function parseHeadlessMessages(stdout: Buffer | string): ParsedRun {
  const run: ParsedRun = { initCount: 0, resultCount: 0, malformed: 0, tools: null, mcpServers: null, toolCallLines: 0, structuredCalls: [], structuredResults: 0, initSeq: null, resultSeq: null };
  const knownIds = new Set<string | null>();
  let seq = -1;
  for (const raw of String(stdout instanceof Buffer ? stdout.toString("utf8") : stdout).split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) continue;
    seq++;
    let line: Record<string, unknown>;
    try { const v = JSON.parse(text); if (!v || typeof v !== "object" || Array.isArray(v)) { run.malformed++; continue; } line = v as Record<string, unknown>; }
    catch { run.malformed++; continue; }
    if (line.type === "system" && line.subtype === "init") {
      run.initCount++;
      if (run.initSeq === null) run.initSeq = seq;
      // A missing or non-array field is never treated as empty.
      run.tools = Array.isArray(line.tools) ? line.tools.map(nameOf).filter((n): n is string => n !== null) : null;
      run.mcpServers = Array.isArray(line.mcp_servers) ? line.mcp_servers.map(nameOf).filter((n): n is string => n !== null) : null;
      if (Array.isArray(line.tools) && run.tools!.length !== line.tools.length) run.tools = [...run.tools!, "<unnamed>"];
      if (Array.isArray(line.mcp_servers) && run.mcpServers!.length !== line.mcp_servers.length) run.mcpServers = [...run.mcpServers!, "<unnamed>"];
      continue;
    }
    if (line.type === "result") {
      run.resultCount++;
      if (run.resultSeq === null) run.resultSeq = seq;
      const u = (line.usage ?? {}) as Record<string, unknown>;
      run.result = {
        subtype: typeof line.subtype === "string" ? line.subtype : "",
        isError: line.is_error === true,
        isErrorValid: typeof line.is_error === "boolean",
        stopReason: typeof line.stop_reason === "string" ? line.stop_reason : undefined,
        errors: Array.isArray(line.errors) ? line.errors.map(String) : [],
        usage: { inputTokens: num(u.input_tokens) ?? num(u.inputTokens), outputTokens: num(u.output_tokens) ?? num(u.outputTokens) },
        structuredOutput: line.structured_output,
        text: typeof line.result === "string" ? line.result : undefined,
      };
      continue;
    }
    const taken = takeStructuredBlocks(line, knownIds);
    for (const c of taken.calls) { run.structuredCalls.push(c); knownIds.add(c.id); }
    run.structuredResults += taken.results;
    if (hasToolBlock(taken.rest)) run.toolCallLines++;
  }
  return run;
}

// ------------------------------------------------------ schema validation ----

/** The keywords validateAgainstSchema enforces. Anything else that constrains a value is refused up front, never skipped. */
const ENFORCED_KEYWORDS = new Set([
  "type", "const", "enum", "anyOf", "oneOf", "allOf", "not", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "minItems", "maxItems", "items", "properties", "required", "additionalProperties",
]);
/** Keywords that carry no constraint. */
const ANNOTATION_KEYWORDS = new Set(["$schema", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);

/** First unsupported keyword anywhere in the schema (as `path: keyword`), or null. Run before dispatch: a constraint the host cannot check must not be silently accepted. */
export function unsupportedSchemaKeyword(schema: unknown, path = "$"): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path}: not-a-schema`;
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!ENFORCED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) return `${path}: ${key}`;
  }
  if (typeof s.pattern === "string") { try { new RegExp(s.pattern, "u"); } catch { return `${path}: pattern`; } } else if (s.pattern !== undefined) return `${path}: pattern`;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = s[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `${path}: ${key}`;
    for (let i = 0; i < list.length; i++) { const e = unsupportedSchemaKeyword(list[i], `${path}.${key}[${i}]`); if (e) return e; }
  }
  if (s.not !== undefined) { const e = unsupportedSchemaKeyword(s.not, `${path}.not`); if (e) return e; }
  if (s.items !== undefined) { const e = unsupportedSchemaKeyword(s.items, `${path}[]`); if (e) return e; }
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) return `${path}: properties`;
    for (const [k, v] of Object.entries(s.properties)) { const e = unsupportedSchemaKeyword(v, `${path}.${k}`); if (e) return e; }
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
    const e = unsupportedSchemaKeyword(s.additionalProperties, `${path}.*`); if (e) return e;
  }
  return null;
}
/** Throws a programmer error before any dispatch when the schema asks for something validateAgainstSchema cannot enforce. */
export function assertSupportedSchema(schema: unknown): void {
  const bad = unsupportedSchemaKeyword(schema);
  if (bad) throw new Error(`PIP_SCHEMA_UNSUPPORTED ${bad}`);
}

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Host-side validation of the schema keywords listed in ENFORCED_KEYWORDS; the binary's own validation is not trusted. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): string | null {
  const unsupported = unsupportedSchemaKeyword(schema, path);
  if (unsupported) return `unsupported:${unsupported}`;
  return validateNode(value, schema, path);
}
function validateNode(value: unknown, schema: JsonSchema, path: string): string | null {
  const s = schema as Record<string, any>;
  const typeOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) return `${path}: const`;
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) return `${path}: enum`;
  if (Array.isArray(s.anyOf)) { if (!s.anyOf.some((sub: JsonSchema) => validateNode(value, sub, path) === null)) return `${path}: anyOf`; }
  if (Array.isArray(s.oneOf)) { if (s.oneOf.filter((sub: JsonSchema) => validateNode(value, sub, path) === null).length !== 1) return `${path}: oneOf`; }
  if (Array.isArray(s.allOf)) { for (const sub of s.allOf as JsonSchema[]) { const e = validateNode(value, sub, path); if (e) return e; } }
  if (s.not !== undefined && validateNode(value, s.not, path) === null) return `${path}: not`;
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === "integer" && typeof value === "number" && Number.isInteger(value)) || (x === "number" && typeof value === "number"));
    if (!ok) return `${path}: type`;
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) return `${path}: minLength`;
    if (typeof s.maxLength === "number" && value.length > s.maxLength) return `${path}: maxLength`;
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) return `${path}: pattern`;
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return `${path}: minimum`;
    if (typeof s.maximum === "number" && value > s.maximum) return `${path}: maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return `${path}: minItems`;
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return `${path}: maxItems`;
    if (s.items && typeof s.items === "object") for (let i = 0; i < value.length; i++) { const e = validateNode(value[i], s.items, `${path}[${i}]`); if (e) return e; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>, props = (s.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of Array.isArray(s.required) ? s.required : []) if (!own(obj, key)) return `${path}.${key}: required`;
    for (const [key, v] of Object.entries(obj)) {
      if (own(props, key)) { const e = validateNode(v, props[key], `${path}.${key}`); if (e) return e; }
      else if (s.additionalProperties === false) return `${path}.${key}: additionalProperties`;
      else if (s.additionalProperties && typeof s.additionalProperties === "object") { const e = validateNode(v, s.additionalProperties, `${path}.${key}`); if (e) return e; }
    }
  }
  return null;
}

// ------------------------------------------------------------- the gate ----

export interface GateObservation {
  parsed: ParsedRun; homeNewFiles: string[]; cwdNewFiles: string[]; exited: boolean;
  /** New files under the temp root outside home/ and work/ ($HOME of the child is the root). */
  rootNewFiles?: string[];
  outputSchema: JsonSchema; history?: MissHistory; overBytes?: boolean; allowedHomeNew?: RegExp[]; allowedRootNew?: RegExp[];
  /** Fuigo and Grok must answer in `structured_output`; only Claude's result text is parsed as a fallback (A.1). */
  engine?: PipEngine;
  /** The request carried `--json-schema` (Claude only): the CLI then lists and calls its synthetic StructuredOutput answer tool. */
  structuredTool?: boolean;
}

/** Claude run that asked for a schema: the one synthetic answer tool is admitted, nothing else. */
const structuredToolAllowed = (o: GateObservation): boolean => o.structuredTool === true && o.engine === "claude";

export function buildIsolationReport(o: GateObservation): IsolationReport {
  return {
    mcpServers: o.parsed.mcpServers ?? [],
    tools: (o.parsed.tools ?? []).filter((t) => !(structuredToolAllowed(o) && t === STRUCTURED_OUTPUT_TOOL && o.parsed.tools!.length === 1)),
    homeNewFiles: [...o.homeNewFiles, ...(o.rootNewFiles ?? []).map((f) => `<root>/${f}`)], cwdNewFiles: o.cwdNewFiles,
    stopReason: o.parsed.result?.stopReason, exited: o.exited, initLine: o.parsed.initCount === 1 && o.parsed.tools !== null && o.parsed.mcpServers !== null,
  };
}

/** Per-run gate (Rule 3) plus the A.6 miss map. Any miss discards the bytes. */
export function gateRun(o: GateObservation): Verdict {
  const h = o.history ?? emptyMissHistory();
  const p = o.parsed;
  if (!o.exited) return { state: "uncertain-transport", reason: "exit-not-confirmed" };
  if (o.overBytes) return { state: "refused", reason: "bad-output", detail: "over-byte-cap", counted: true };
  if (p.initCount !== 1 || p.tools === null || p.mcpServers === null) {
    if (h.noInitLine >= 2) return { state: "unsupported", reason: "transport", detail: "no-init-line" };
    return { state: "refused", reason: "isolation", detail: "no-init-line", counted: true };
  }
  // Under --json-schema Claude's CLI lists exactly [StructuredOutput] and answers through one call to it. Anything else is a tool.
  const so = structuredToolAllowed(o);
  const toolsOk = p.tools.length === 0 || (so && p.tools.length === 1 && p.tools[0] === STRUCTURED_OUTPUT_TOOL);
  if (!toolsOk || p.toolCallLines > 0) return { state: "unsupported", reason: "tools", detail: p.tools.join(",") || "tool-call-line" };
  if (!so && p.structuredCalls.length > 0) return { state: "unsupported", reason: "tools", detail: "tool-call-line" };
  if (p.structuredCalls.length > 1 || p.structuredResults > p.structuredCalls.length) return { state: "unsupported", reason: "tools", detail: "multiple-structured-output" };
  if (p.mcpServers.length > 0) return { state: "unsupported", reason: "managed-config", detail: `mcp:${p.mcpServers.join(",")}` };
  const allowed = o.allowedHomeNew ?? DEFAULT_ALLOWED_HOME_NEW;
  const strayHome = o.homeNewFiles.filter((f) => !allowed.some((re) => re.test(f)));
  const allowedRoot = o.allowedRootNew ?? DEFAULT_ALLOWED_ROOT_NEW;
  const strayRoot = (o.rootNewFiles ?? []).filter((f) => !allowedRoot.some((re) => re.test(f)));
  if (o.cwdNewFiles.length || strayHome.length || strayRoot.length) {
    const key = o.cwdNewFiles.length ? `cwd:${[...o.cwdNewFiles].sort().join(",")}`
      : strayHome.length ? `home:${[...strayHome].sort().join(",")}` : `root:${[...strayRoot].sort().join(",")}`;
    if (h.isolationMissKeys.includes(key)) return { state: "unsupported", reason: "managed-config", detail: key };
    return { state: "refused", reason: "isolation", detail: key, counted: true, missKey: key };
  }
  // A line that is not JSON could be a tool call the parser never saw: no evidence, no admission.
  if (p.malformed > 0) return { state: "refused", reason: "bad-output", detail: "malformed-output", counted: true };
  const r = p.result;
  if (!r || p.resultCount !== 1) return { state: "refused", reason: "bad-output", detail: "no-result-line", counted: true };
  if (p.initSeq === null || p.resultSeq === null || p.resultSeq < p.initSeq) return { state: "refused", reason: "bad-output", detail: "result-before-init", counted: true };
  if (!r.isErrorValid) return { state: "refused", reason: "bad-output", detail: "invalid-is-error", counted: true };
  if (r.subtype !== "success" || r.isError) return { state: "refused", reason: "bad-output", detail: r.errors.includes("cancelled") ? "cancelled" : r.subtype || "error", counted: true };
  if (r.stopReason === "cancelled") return { state: "refused", reason: "bad-output", detail: "cancelled", counted: true };
  let structured: unknown = r.structuredOutput;
  if (structured === undefined && so && p.structuredCalls.length === 1) structured = p.structuredCalls[0].input;
  if (structured === undefined && o.engine === "claude" && r.text !== undefined) { try { structured = JSON.parse(r.text); } catch { structured = undefined; } }
  if (structured === undefined || structured === null || typeof structured !== "object") return { state: "refused", reason: "bad-output", detail: "no-structured-output", counted: true };
  const bad = validateAgainstSchema(structured, o.outputSchema);
  if (bad) return { state: "refused", reason: "bad-output", detail: `schema:${bad}`, counted: true };
  return { state: "validated", structured };
}

/** Socket transports (A.5): no tools field was sent, no pid, no files. */
export function httpVerdict(o: { finishReason: string | null; content: string; outputSchema: JsonSchema; maxOutputBytes: number; exited: boolean }): Verdict {
  if (!o.exited) return { state: "uncertain-transport", reason: "socket-not-closed" };
  if (o.finishReason === "length") return { state: "refused", reason: "bad-output", detail: "truncated", counted: true };
  if (Buffer.byteLength(o.content) > o.maxOutputBytes) return { state: "refused", reason: "bad-output", detail: "over-byte-cap", counted: true };
  let structured: unknown;
  try { structured = JSON.parse(o.content); } catch { return { state: "refused", reason: "bad-output", detail: "not-json", counted: true }; }
  const bad = validateAgainstSchema(structured, o.outputSchema);
  if (bad || structured === null || typeof structured !== "object") return { state: "refused", reason: "bad-output", detail: `schema:${bad ?? "type"}`, counted: true };
  return { state: "validated", structured };
}

export function httpIsolationReport(o: { finishReason: string | null; exited: boolean; aborted?: boolean }): IsolationReport {
  return { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], stopReason: o.aborted ? "cancelled" : (o.finishReason ?? undefined), exited: o.exited, initLine: true };
}

/** Settlement accounting (A.3): reported usage wins; the byte estimate (3.5 bytes per token) otherwise. */
export function settleOutputTokens(reported: number | undefined, bytes: number): number { return reported ?? Math.ceil(bytes / 3.5); }
export const isReportedOverLimit = (reported: number | undefined, maxOutputTokens: number): boolean => reported !== undefined && reported > maxOutputTokens;
