// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../../contracts.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject, type LocalHost } from "../local-inject.ts";
import { readTomlConfigForEdit, removeTomlTables } from "./kimi.ts";
import { DATA_DIR } from "../../config.ts";
import { headlessTextOnlyTurn } from "../headless-text-only.ts";
import { fuigoConfigOverlay } from "../../flux-memory-headers.ts";
import { listDir, memoDeps, pathExists, readText } from "../isolation-cache.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { fuigoToolResultDirs, sessionFolders } from "../../own-tool-results.ts";
import { scopeGrokHome } from "./grok-scope.ts";
import { engineFolderUnavailable } from "../scoped-cli-home.ts";
import { AskStopRefusal, ASK_STOP_GROK_OLD_NOTE } from "../ask-stop.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.6",
  options: [
    // Upstream #1632: without a window the memory budget falls back to
    // 20,480 tokens (index.ts) for a model that takes 500k.
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function grokHome(env: Record<string, string | undefined>): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, plus the two cloud defaults.
 *  `grok -m <slug>` already accepts these; the picker just didn't list them. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next);
  return slug;
}

/** `key = "value"` inside one TOML table body, unescaped; null when absent. */
function tomlBodyString(body: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(body);
  return match ? match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : null;
}

/** Spec A3: drop the `[model.*]` blocks Murage wrote for a removed server. */
export function removeGrokLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const path = join(grokHome(env), "config.toml");
  const text = readTomlConfigForEdit(path, env.HOME || env.USERPROFILE || homedir());
  if (text === null) return "absent";
  const { text: next, removed } = removeTomlTables(
    text,
    (name, body) => name.startsWith("model.") && tomlBodyString(body, "base_url") === host.baseUrl,
  );
  if (!removed) return "absent";
  writeFileSync(path, next);
  return "removed";
}

/**
 * A Murage bot must load only Murage's own MCP mounts, never the owner's
 * personal setup. Found live (2026-10-10, Sean's Sable on grok 1.0.50): each
 * turn mounted 20 servers / 278 tools, 16 of them the owner's own (imported
 * from ~/.claude.json and ~/.claude/plugins), plus ~/.claude/CLAUDE.md in the
 * prompt and the owner's Claude plugin hooks. Same principles as the Claude
 * engine's design B (claude.ts claudeIsolation): Murage's servers stay, the
 * owner's personal MCP, hooks, plugins, skills and instructions are off for
 * this process only, the grok.com login is untouched, chat is never blocked.
 *
 * 1. Compat cells (docs 05-configuration.md "Harness compatibility",
 *    26-config-reference.md `compat.*`): grok imports the owner's Claude Code
 *    and Cursor setup (~/.claude.json MCP, ~/.claude/settings.json hooks,
 *    ~/.claude/CLAUDE.md, skills, rules, agents; ~/.cursor likewise), each
 *    behind a cell that resolves env > config.toml > default on. Same 18 cells
 *    as Fuigo (the same shell under another brand, fuigo.ts
 *    FUIGO_EXTERNAL_MCP_GATES). An explicit value already in the environment
 *    wins, so an owner who wants an import can set it to 1.
 * 2. Memory: `--no-memory` (outranks env, docs 13-memory.md) plus a
 *    `GROK_MEMORY=0` default; Murage owns persistent memory.
 * 3. Plugins: Claude Code plugins (~/.claude/plugins, enabled in
 *    ~/.claude/settings.json) and grok's own user plugins load with their MCP
 *    servers, hooks and skills, and NO cell, env or overlay turns them off
 *    (the GROK_CONFIG overlay allowlist drops `plugins`; verified on the rig).
 *    `--plugin-dir` is the highest-priority plugin scope and a same-named
 *    plugin shadows lower scopes (docs 09-plugins.md "Where Grok looks for
 *    plugins"), so each personal plugin is shadowed by an empty Murage stub of
 *    the same name. `--no-leader` keeps it a local agent (`--plugin-dir` is
 *    ignored by a shared leader, which would also carry the owner's setup).
 *
 * Rig (build host, grok 1.0.0 / 1.0.6 / 1.0.20 / 1.0.35 / 1.0.45-1.0.50,
 * synthetic owner home with 8 ~/.claude.json servers, a Cursor server, a
 * Claude plugin with 2 MCP servers + hooks + a skill, CLAUDE.md, rules,
 * skills, hooks): the cells and `--no-leader`/`--plugin-dir` are accepted from
 * 1.0.0 up, but the stub shadows the personal plugin only from 1.0.50
 * (GROK_PLUGIN_SHADOW_MIN). 1.0.50 before = 15 servers / 349 tools / 5 hooks
 * fired / 5 personal markers in the prompt; after = Murage's 3 servers + the
 * native config.toml server below, 1 (native) hook.
 *
 * 4. grok's NATIVE personal config in ~/.grok (config.toml [mcp_servers] and
 *    hooks, AGENTS.md, rules/, skills/, hooks/, plugins/): a scoped GROK_HOME
 *    from 1.0.50 (grok-scope.ts), whose auth.json is a link grok refreshes
 *    through (rig-proved: the token is never forked). Below 1.0.50 (or an
 *    unreadable version) the bot's turn is rejected with an update notice;
 *    Windows is scoped the same way; where symlinks are not allowed the turn is rejected with guidance (grok renames over auth.json, so a hardlink cannot share it).
 */
export const GROK_EXTERNAL_COMPAT_GATES = [
  "GROK_CLAUDE_SKILLS_ENABLED", "GROK_CLAUDE_RULES_ENABLED", "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED", "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED", "GROK_CURSOR_RULES_ENABLED", "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED", "GROK_CURSOR_HOOKS_ENABLED", "GROK_CURSOR_SESSIONS_ENABLED",
  "GROK_CODEX_SKILLS_ENABLED", "GROK_CODEX_RULES_ENABLED", "GROK_CODEX_AGENTS_ENABLED",
  "GROK_CODEX_MCPS_ENABLED", "GROK_CODEX_HOOKS_ENABLED", "GROK_CODEX_SESSIONS_ENABLED",
] as const;

export function isolateGrokFromPersonalSetup(env: Record<string, string | undefined>): void {
  const present = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  for (const name of GROK_EXTERNAL_COMPAT_GATES) if (!present.has(name)) env[name] = "0";
  // Murage owns memory. --no-memory on argv already outranks GROK_MEMORY
  // (docs 13-memory.md); the env default covers a build that drops the flag.
  if (!present.has("GROK_MEMORY")) env.GROK_MEMORY = "0";
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_SHADOWED_PLUGINS = 256;

function readJson(path: string): unknown {
  try { return JSON.parse(readText(path)); } catch { return null; }
}

function manifestName(dir: string): string | null {
  for (const sub of [".grok-plugin", ".claude-plugin"]) {
    const name = (readJson(join(dir, sub, "plugin.json")) as { name?: unknown } | null)?.name;
    if (typeof name === "string") return name;
  }
  return null;
}

/** `[plugins] enabled = [...]` in grok's own config.toml (names or `<scope>/<hash>/<name>` ids). */
function grokEnabledPluginIds(text: string): string[] {
  const table = /^\s*\[plugins\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const list = /^\s*enabled\s*=\s*\[([\s\S]*?)\]/m.exec(table)?.[1] ?? "";
  return [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

/** Names of every plugin of the owner's that grok would load into a bot's
 *  session: Claude Code plugins (enabled or installed, plus loose ones under
 *  ~/.claude/plugins) and grok's own user plugins. Read only; any unreadable
 *  source contributes nothing. */
export function grokPersonalPluginNames(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const claude = join(home, ".claude");
  const names = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const name = raw.split("@")[0]!.split("/").pop()!;
    if (PLUGIN_NAME.test(name)) names.add(name);
  };
  for (const file of ["settings.json", "settings.local.json"]) {
    const enabled = (readJson(join(claude, file)) as { enabledPlugins?: unknown } | null)?.enabledPlugins;
    if (enabled && typeof enabled === "object" && !Array.isArray(enabled)) for (const id of Object.keys(enabled)) add(id);
  }
  const installed = (readJson(join(claude, "plugins", "installed_plugins.json")) as { plugins?: unknown } | null)?.plugins;
  if (installed && typeof installed === "object" && !Array.isArray(installed)) {
    for (const [id, entries] of Object.entries(installed as Record<string, unknown>)) {
      add(id);
      if (Array.isArray(entries)) for (const entry of entries) {
        const path = (entry as { installPath?: unknown } | null)?.installPath;
        if (typeof path === "string") add(manifestName(path));
      }
    }
  }
  const pluginDirs: string[] = [join(claude, "plugins"), join(grokHome(env), "plugins")];
  for (const root of pluginDirs) {
    let entries: string[] = [];
    try { entries = listDir(root); } catch { entries = []; }
    for (const entry of entries) {
      const name = manifestName(join(root, entry));
      if (name) add(name);
    }
  }
  try { for (const id of grokEnabledPluginIds(readText(join(grokHome(env), "config.toml")))) add(id); } catch { /* no config */ }
  return [...names].sort().slice(0, MAX_SHADOWED_PLUGINS);
}

let stubRoot: string | null = null;
/** An empty plugin of this name, Murage's own, in a 0700 folder made for this
 *  process and removed when the server exits. */
function grokPluginStub(name: string): string {
  if (!stubRoot || !existsSync(stubRoot)) {
    stubRoot = mkdtempSync(join(tmpdir(), "murage-grok-isolation-"));
    const dir = stubRoot;
    process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  const dir = join(stubRoot, name);
  const manifest = join(dir, ".grok-plugin", "plugin.json");
  if (!pathExists(manifest)) {
    mkdirSync(join(dir, ".grok-plugin"), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name, version: "0.0.0", description: "Murage: the owner's personal plugin of this name is off for bot turns." }));
  }
  return dir;
}

/** First grok whose `--plugin-dir` shadows a same-named personal plugin (rig:
 *  1.0.45-1.0.49 accept the flag but still load the owner's plugin). */
export const GROK_PLUGIN_SHADOW_MIN = [1, 0, 50] as const;

function semver(text: string | undefined): [number, number, number] | null {
  const m = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const atLeast = (v: readonly number[], min: readonly number[]) => v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= min[2]!;

/** The first grok proven to send session/request_permission for every shell command, edit and write under the
 *  scoped config's `[permission] ask` rules (grok-scope.ts GROK_ASK_RULES), its own read-only commands included
 *  (live, grok 1.0.62 on the Linux gate box). At Ask a grok below it, or one whose version cannot be read, is refused
 *  before it runs (ASK_STOP_GROK_OLD_NOTE): it could run echo, touch or mkdir with no card. Auto and Full access run. */
export const GROK_ASK_HOLD_MIN = [1, 0, 62] as const;

/** Throws the Ask refusal for a grok that cannot be held at Ask (GROK_ASK_HOLD_MIN). */
export function requireGrokAskHold(askLevel: boolean | undefined, cliVersion: string | undefined): void {
  if (!askLevel) return;
  const version = semver(cliVersion);
  if (!version || !atLeast(version, GROK_ASK_HOLD_MIN)) throw new AskStopRefusal(ASK_STOP_GROK_OLD_NOTE);
}

/** `--no-leader` (every 1.x) and `--plugin-dir <stub>` per personal plugin
 *  (1.0.50+, where it shadows). A CLI whose version is unknown or below 1.0.0
 *  gets neither: fail open, the turn runs rather than meet a flag it rejects. */
export function grokIsolationArgs(env: Record<string, string | undefined>, cliVersion: string | undefined): string[] {
  const version = semver(cliVersion);
  if (!version || version[0] < 1) return [];
  if (!atLeast(version, GROK_PLUGIN_SHADOW_MIN)) return ["--no-leader"];
  try {
    // Worked out once per owner setup: re-read only when a file it read changed.
    const key = JSON.stringify([env.HOME || env.USERPROFILE || homedir(), grokHome(env), version]);
    return memoDeps("grok-isolation-args", key, () => ["--no-leader", ...grokPersonalPluginNames(env).flatMap((name) => ["--plugin-dir", grokPluginStub(name)])]);
  } catch (error) {
    // Fails closed: without the shadows the owner's personal plugins would load into the bot, so the turn is rejected.
    throw engineFolderUnavailable("Grok", error);
  }
}

const support: AcpSupport = {
  driverKind: "grokAgent",
  displayName: "Grok",
  // A cut MCP result is saved in this session's own `mcp/` folder; reading it
  // back is the bot reading its own output (server/own-tool-results.ts).
  toolResultDirs: ({ env, cwd, sessionId }) => fuigoToolResultDirs(grokHome(env), sessionFolders(cwd), sessionId),
  images: false,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's accepted levels vary by model and the CLI validates lazily — a
  // rejected level only logs and falls back. Offer the intersection shared
  // by every model in this driver's picker; notably, grok-4.5 rejects xhigh.
  effortLevels: ["low", "medium", "high"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  // Grok Build stamps `_meta["x.ai/tool"]` (namespace grok_build) where Fuigo
  // stamps `fuigo/tool` (fuigo_build): the same CanonicalToolMeta in both
  // binaries (grok 1.0.62, fuigo 1.0.31). Without this every Grok ask was
  // unstamped kind "other", so Murage's own tools could not be proven and
  // held a card at Auto.
  toolStamp: { key: "x.ai/tool", namespaces: { grok_build: "fuigo_build", grok_build_concise: "fuigo_build_concise", grok_build_hashline: "fuigo_build_hashline" } },
  loginNote: "Grok CLI is not signed in: run `grok login` in a terminal",

  // No Windows one-liner: the installer is a POSIX shell script, and offering
  // `curl … | bash` there would be advice that cannot run. Windows falls back
  // to docsUrl, which is honest rather than broken.
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
  },

  // Write the [model.slug] block with the instance HOME/GROK_HOME, then pass
  // the slug on argv. spawnArgs must not call ensureGrokInjectSlug itself —
  // that helper defaults to process.env and would miss the instance override.
  resolveTurnModel: (model, env) => (model ? ensureGrokInjectSlug(model, env) : model),

  // --permission-mode is a global grok flag. -m and --reasoning-effort are
  // agent flags: Grok 1.0.6 only applies them when they sit AFTER `agent`
  // and BEFORE `stdio` (`grok agent -m slug stdio`). Putting -m first is
  // accepted as a TUI option and then ignored, so ACP session/new keeps
  // [models].default (grok-4.6) and oMLX never sees a request.
  // Grok Build is the code Fuigo is built from (crates/codegen/xai-grok-shell
  // session/acp_session_impl/mcp_init.rs, in the 1.0.50 binary): it too answers
  // session/new before its MCP servers are connected, then announces them, and
  // answers the same per-server list. The same gate as Fuigo, under x.ai names.
  mcpReadyNotification: "_x.ai/mcp_initialized",
  mcpProgressNotification: "_x.ai/mcp/init_progress",
  mcpListMethod: "_x.ai/mcp/list",

  spawnArgs: (config, turn, ctx) => {
    // Fails closed at Ask on a grok its ask rules are not proven on (GROK_ASK_HOLD_MIN).
    requireGrokAskHold(turn.askLevel, ctx?.cliVersion);
    return [
      "--permission-mode",
      // `default` still runs grok's own read-only shell commands unasked; the scoped config's `[permission] ask`
      // rules (grok-scope.ts GROK_ASK_RULES) send every shell command, edit and write to Murage instead.
      config.fullAuto ? "bypassPermissions" : "default",
      // Murage owns persistent memory (same flag Fuigo and the headless reflection argv pass).
      "--no-memory",
      "agent",
      // The owner's personal plugins off for this process (see grokIsolationArgs).
      ...grokIsolationArgs(ctx?.env ?? process.env, ctx?.cliVersion),
      ...(turn.model ? ["-m", turn.model] : []),
      // long form on purpose: `--effort` is documented as an alias, and an
      // alias is the part a CLI is free to rename
      ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
      "stdio",
    ];
  },
  spawnNeedsCliVersion: true,

  // -m on argv is necessary but not sufficient: session/new still starts on
  // [models].default. Pin the slug over the wire, same as Hermes/Droid.
  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (e) {
      throw new Error(
        `Grok rejected model "${turn.model}" via session/set_model: ${(e as Error).message}. ` +
          `Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.`,
      );
    }
  },

  /** Flux Memory headers: Grok Build shares Fuigo's shell, so the inline `GROK_CONFIG` overlay
   *  (xai-grok-shell config GROK_CONFIG_ENV) carries `[models].extra_headers` the same way. */
  applyFluxMemory: (env, { decision }) => {
    env.GROK_CONFIG = fuigoConfigOverlay(decision.headers, env.GROK_CONFIG);
  },
  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  // grok's native personal config (~/.grok MCP servers, hooks, skills, rules,
  // AGENTS.md, plugins): a scoped GROK_HOME on a proven version (grok-scope.ts).
  // After resolveTurnModel, so a local-model slug is written to the real config
  // first and arrives in the scoped copy.
  scopeKind: "grok",
  applyMountEnv: (env, { cliVersion, botId }) => scopeGrokHome(env, cliVersion, botId),
  scopeRoot: (env) => env.GROK_HOME,
  transformEnv: (env) => {
    isolateGrokFromPersonalSetup(env);
    delete env.XAI_API_KEY;
    delete env.GROK_CODE_XAI_API_KEY;
    delete env.GROK_API_KEY;
    delete env.MURAGE_GROK_PROVIDER_API_KEY;
    delete env.GROK_MODELS_BASE_URL;
    delete env.GROK_MODELS_LIST_URL;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: (env) => existsSync(join(grokHome(env), "auth.json")),

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  // PIP reflection: a dedicated headless spawn; the credential is the copied auth.json of the parent Grok home.
  textOnlyTurn: (turn, config) => headlessTextOnlyTurn(turn, { engine: "grok", cli: config.cli, tmpBase: join(DATA_DIR, "pip-tmp"), parentGrokHome: grokHome(process.env) }),
};

export const GrokAgentDriver = createAcpDriver(support);
