// The maintained OpenCode CLI through its ACP stdio interface. OpenCode is
// the harness; Zen, Go, OpenRouter, and user-configured/local providers are
// models discovered from that harness rather than separate Murage drivers.
import { memoDeps, pathExists, readText } from "../isolation-cache.ts";
import { currentScopeHome, engineConfigInvalid, registerScopeReconstructor, scopedCliHome, scopedCliHomeRoot, type ScopedCliHomeSpec } from "../scoped-cli-home.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { decodeInjectId, hostApiKey, localHost, mergeLocalInject, type LocalHost } from "../local-inject.ts";
import { readNativeJsonConfig } from "../native-config-file.ts";
import { SENSITIVE_PATHS } from "../../../shared/sensitive-paths.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { writeFileAtomic } from "../../atomic.ts";
import { cloudTurnRender } from "../../cloud-home/turn-process.ts";
import { cloudRouteUrl } from "../../cloud-home/engine-render.ts";
import { fluxKey } from "../../flux-config.ts";
import { DATA_DIR } from "../../config.ts";
import { execCli } from "../../procs.ts";
import { FLUX_MODELS, FLUX_OPENAI_BASE, fluxModelId } from "../../flux-routing.ts";
import { opencodeConfigOverlay } from "../../flux-memory-headers.ts";
import { mergeFluxCatalog } from "../../flux-surface.ts";
import {
  OPENCODE_FLUX_PROVIDER,
  openCodeFluxRouted,
  opencodeConfigDir,
  opencodeConfigPath,
  opencodeFluxModelId,
  renderOpenCodeConfig,
  upsertOpenCodeProvider,
} from "../../opencode-config.ts";

const STATIC_MODELS: ModelCatalog = {
  default: "opencode/beam-free",
  options: [
    {
      id: "opencode/beam-free",
      label: "Zen · Beam Free",
    },
  ],
};

let lastSuccessfulCatalog: ModelCatalog | null = null;
const MODEL_PROBE_TTL_MS = 30_000;
const modelProbeCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

export type OpenCodeCatalogLoader = (
  environment: Record<string, string | undefined>,
  cli: string,
) => Promise<ModelCatalog>;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerLabel(id: string): string {
  if (id === "opencode") return "Zen";
  if (id === "opencode-go") return "Go";
  if (id === "openrouter") return "OpenRouter";
  return labelForModel(id);
}

function validModelSlug(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1 || /\s/u.test(value)) return false;
  return [...value].every((character) => (character.codePointAt(0) ?? 0) > 0x1f);
}

function localModelRecord(record: Record<string, unknown>): boolean {
  const api = record.api && typeof record.api === "object" && !Array.isArray(record.api)
    ? record.api as Record<string, unknown>
    : {};
  if (typeof api.url !== "string") return false;
  try {
    const host = new URL(api.url).hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Parse the authoritative inventory printed by the installed OpenCode CLI.
 *
 * `models --verbose` is a sequence of `provider/model` header lines followed
 * by one JSON object. Model IDs can themselves contain `/` (OpenRouter), so
 * only the first separator identifies the provider. Older CLIs may print just
 * the headers; those still produce a usable catalog without metadata. */
export function parseOpenCodeModelsOutput(stdout: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let slug: string | null = null;
  let jsonLines: string[] = [];

  const flush = () => {
    if (!slug || seen.has(slug)) return;
    const separator = slug.indexOf("/");
    const provider = slug.slice(0, separator);
    const model = slug.slice(separator + 1);
    let record: Record<string, unknown> = {};
    const raw = jsonLines.join("\n").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // A header-only/older CLI remains useful; fall back to the model id.
      }
    }
    if (record.status === "deprecated") return;
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : labelForModel(model);
    const limit = record.limit && typeof record.limit === "object" && !Array.isArray(record.limit)
      ? record.limit as Record<string, unknown>
      : {};
    const contextWindow = typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0
      ? Math.floor(limit.context)
      : undefined;
    seen.add(slug);
    options.push({
      id: slug,
      label: `${providerLabel(provider)} · ${name}`,
      ...(localModelRecord(record) ? { custom: true, loaded: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  };

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (line === trimmed && validModelSlug(trimmed)) {
      flush();
      slug = trimmed;
      jsonLines = [];
      continue;
    }
    if (slug) jsonLines.push(line);
  }
  flush();

  if (!options.length) return null;
  const preferred = options.find((option) => option.id === STATIC_MODELS.default);
  return { default: (preferred ?? options[0]!).id, options };
}

function runOpenCodeModels(
  cli: string,
  environment: Record<string, string | undefined>,
  verbose: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execCli(
      cli,
      ["models", ...(verbose ? ["--verbose"] : [])],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: environment },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Ask the same OpenCode binary that will run ACP for its effective catalog.
 * This automatically includes Zen, Go, other connected providers, custom
 * config, and anonymous free models with the exact IDs the session accepts. */
export async function discoverOpenCodeModels(
  environment: Record<string, string | undefined>,
  cli = "opencode",
): Promise<ModelCatalog> {
  try {
    const catalog = parseOpenCodeModelsOutput(await runOpenCodeModels(cli, environment, true));
    if (!catalog) throw new Error("OpenCode returned no usable models");
    lastSuccessfulCatalog = catalog;
    return { ...catalog, source: "live" };
  } catch {
    // A failed probe is never live, even when an earlier list is reused.
    return { ...(lastSuccessfulCatalog ?? STATIC_MODELS), source: "static" };
  }
}

export function resetOpenCodeModelCache() {
  lastSuccessfulCatalog = null;
  modelProbeCache.clear();
}

/** Compatibility export for older tests/imports while the product migrates
 * from the Go-only name. */
export const resetOpenCodeGoModelCache = resetOpenCodeModelCache;

export const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
  if (process.env.MURAGE_CLOUD_ROLE === "home") {
    // The launcher renders the Flux provider table into opencode.json and hands the key to
    // OpenCode only in OPENCODE_AUTH_CONTENT, never in a file (CLOUD-ENGINES-DESIGN.md r2 H1).
    const key = fluxKey();
    if (key) cloudTurnRender(env, "route", { provider: OPENCODE_FLUX_PROVIDER, baseUrl: FLUX_OPENAI_BASE, model: FLUX_MODELS[0].id,
      models: FLUX_MODELS.map(tier => tier.id), apiKey: key, label: "Flux Router" });
  }
};

/** Upsert an openai-compatible provider so OpenCode can select host/model.
 *
 * The merge itself lives in `opencode-config.ts` and is shared verbatim with
 * the Flux connector — one implementation of "how a provider goes into
 * opencode.json", so the two writers cannot drift apart on npm package,
 * camelCase `baseURL`, or what counts as safe to overwrite.
 *
 * This path refuses rather than guesses, like the connector: an existing
 * opencode.json that cannot be read, is not a plain JSON object (OpenCode
 * also accepts JSONC comments and trailing commas, which a rewrite would
 * delete), or holds a non-object where the provider goes throws before
 * anything is written. The file keeps its bytes and the turn fails with
 * repair guidance before the CLI is spawned (0.1.52 A8; this reverses the
 * earlier lenient fresh-object fallback). An apiKey already in the file is
 * still never replaced — the user's own key wins.
 */
export function ensureOpenCodeInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const native = `${inject.host}/${inject.model}`;
  if (process.env.MURAGE_CLOUD_ROLE === "home") {
    // One typed route: the launcher renders provider.<host> and the key rides OPENCODE_AUTH_CONTENT.
    cloudTurnRender(env, "route", { provider: inject.host, baseUrl: cloudRouteUrl(host.baseUrl), model: inject.model, apiKey: hostApiKey(host, env) });
    return native;
  }
  const path = opencodeConfigPath(env);
  const existing = readNativeJsonConfig(path, env.HOME || env.USERPROFILE || homedir());
  const config: Record<string, unknown> = existing?.value ?? { $schema: "https://opencode.ai/config.json" };
  upsertOpenCodeProvider(
    config,
    inject.host,
    {
      name: host.label,
      baseUrl: host.baseUrl,
      apiKey: hostApiKey(host, env),
      models: { [inject.model]: { name: `${inject.model} (${host.label})` } },
    },
    { strict: true },
  );
  mkdirSync(opencodeConfigDir(env), { recursive: true });
  writeFileAtomic(path, renderOpenCodeConfig(config, existing?.text ?? null));
  return native;
}

/** Spec A3: drop the provider Murage wrote for a removed local server. */
export function removeOpenCodeLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const path = opencodeConfigPath(env);
  const existing = readNativeJsonConfig(path, env.HOME || env.USERPROFILE || homedir());
  if (!existing) return "absent";
  const provider = existing.value.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider) || !Object.hasOwn(provider, host.id)) return "absent";
  const next = { ...(provider as Record<string, unknown>) };
  delete next[host.id];
  writeFileAtomic(path, renderOpenCodeConfig({ ...existing.value, provider: next }, existing.text));
  return "removed";
}

/** Every path the OpenCode CLI may keep auth.json at.
 *
 * The CLI is xdg-flavoured on EVERY platform — `opencode auth list` on macOS
 * prints `~/.local/share/opencode/auth.json`, and that is where real logins
 * land. The platform-conventional locations are kept as fallbacks in case a
 * future CLI moves there, but the xdg path must come first: checking only
 * Library/Application Support on macOS is exactly the bug that made the app
 * demand a sign-in from users who were already signed in. */
function storedAuthPaths(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode", "auth.json"));
}

/** True when auth.json contains any usable provider login managed by
 * OpenCode. The generic harness can run all of them, including `opencode`
 * (Zen), `opencode-go`, and third-party providers such as OpenRouter. */
function usableAuthEntry(parsed: Record<string, unknown>): boolean {
  return Object.values(parsed).some((auth) => {
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
    const entry = auth as { key?: unknown; access?: unknown; refresh?: unknown };
    return Boolean(entry.key || entry.access || entry.refresh);
  });
}

function hasStoredOpenCodeAuth(env: Record<string, string | undefined>) {
  const candidates: string[] = [];
  if (env.OPENCODE_AUTH_CONTENT) candidates.push(env.OPENCODE_AUTH_CONTENT);
  for (const path of storedAuthPaths(env)) {
    try {
      candidates.push(readFileSync(path, "utf8"));
    } catch {
      // A missing or unreadable file simply means there is no ambient login.
    }
  }
  return candidates.some((raw) => {
    try {
      return usableAuthEntry(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

export async function canListOpenCodeModels(
  env: Record<string, string | undefined>,
  cli: string,
  runModels: typeof runOpenCodeModels = runOpenCodeModels,
): Promise<boolean> {
  const cached = modelProbeCache.get(cli);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result: Promise.resolve(false),
  };
  entry.result = runModels(cli, env, false)
    .then((stdout) => stdout
      .split(/\r?\n/u)
      .some((line) => validModelSlug(line.trim())))
    .catch(() => false)
    .finally(() => {
      entry.expiresAt = Date.now() + MODEL_PROBE_TTL_MS;
    });
  modelProbeCache.set(cli, entry);
  return entry.result;
}

/** Migrate the model name published during Ox Alpha's first preview. The
 * current CLI calls the same model `x-preview-f-free`; prefer Go for an old
 * Go bot with an explicit key, otherwise use Zen's anonymous/free route. */
export function normalizeLegacyOpenCodeModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  if (model !== "opencode-go/ox-alpha-free") return model;
  return env.OPENCODE_API_KEY
    ? "opencode-go/x-preview-f-free"
    : "opencode/beam-free"; // x-preview-f-free is gone from opencode 1.19.3
}

/** Whether a turn works inside a folder Murage owns: a bot's own workspace or
 * one of its conversation folders (all under DATA_DIR/workspaces). Everything
 * in them was written by a bot, so none of it may become OpenCode
 * configuration. The workspaces root itself is not an owned working folder.
 * Adapted from OpenMausBot #2053 (658763e9), `openMausOwnsWorkingFolder`. */
export function murageOwnsWorkingFolder(cwd: string): boolean {
  // Both as written and with links resolved, on either side: OpenCode reads
  // config from the folder it really runs in, so a picked folder that links
  // into a workspace is owned too. Owned on any match (fails closed).
  // A folder not created yet resolves through its nearest existing parent.
  const real = (path: string): string | null => {
    for (let at = path, rest = ""; ; ) {
      try { return join(realpathSync.native(at), rest); } catch { /* not there yet */ }
      const up = dirname(at);
      if (up === at) return null;
      rest = join(basename(at), rest);
      at = up;
    }
  };
  const root = resolve(DATA_DIR, "workspaces");
  const folder = resolve(cwd);
  const roots = [root, real(root)].filter((path): path is string => path !== null);
  const folders = [folder, real(folder)].filter((path): path is string => path !== null);
  return roots.some((base) => folders.some((path) => {
    const rest = relative(base, path);
    return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  }));
}

/**
 * The owner's personal OpenCode setup stays out of a bot's turns (same
 * principles as the Claude engine's design B, claude.ts claudeIsolation):
 * - OPENCODE_DISABLE_CLAUDE_CODE: no ~/.claude/CLAUDE.md prompt, no
 *   ~/.claude/skills (the owner's Claude Code setup);
 * - OPENCODE_DISABLE_EXTERNAL_SKILLS: no ~/.agents and other external skills;
 * - OPENCODE_PURE: no external plugins (the `--pure` flag's env; built-in
 *   provider/auth plugins are a separate switch and stay, so logins work);
 * - every MCP server in the owner's global config (opencode.json/.jsonc,
 *   config.json, $OPENCODE_CONFIG) is set `enabled: false` in the
 *   OPENCODE_CONFIG_CONTENT overlay, which OpenCode merges over its files.
 *   Murage's own servers ride ACP `session/new` and are untouched: only a name
 *   this turn actually mounts is spared, never a name merely reserved.
 * Names from the opencode 1.15.11 binary (Flag.OPENCODE_PURE, RuntimeFlags
 * disableExternalSkills, OPENCODE_DISABLE_CLAUDE_CODE). Older builds ignore an
 * env they do not know, so there is no version floor; an unreadable config
 * leaves its servers alone (fail open). An explicit value already in the
 * environment wins.
 * Rig (build host, opencode 1.15.11, fake model): before = 109 tools (40 the
 * owner's), personal skill, plugin loaded, 20.6k tokens; after = Murage's 69
 * tools, no skill or plugin, 15.3k tokens.
 * The global ~/.config/opencode/AGENTS.md: isolateOpenCodeGlobalInstructions.
 */
const OPENCODE_ISOLATION_ENV = [
  ["OPENCODE_DISABLE_CLAUDE_CODE", "1"],
  ["OPENCODE_DISABLE_EXTERNAL_SKILLS", "1"],
  ["OPENCODE_PURE", "1"],
] as const;

/** JSON with comments and trailing commas (OpenCode's .jsonc) as plain JSON. */
export function jsoncToJson(text: string): string {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const c = text[i]!, next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === '"') inString = false;
      i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** MCP server names in the owner's global OpenCode config files. Read only. */
export function ownerOpenCodeMcpNames(env: Record<string, string | undefined>): string[] {
  const dir = opencodeConfigDir(env);
  const files = [join(dir, "config.json"), join(dir, "opencode.json"), join(dir, "opencode.jsonc"), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])];
  return memoDeps("opencode-owner-mcp", JSON.stringify(files), () => scanOwnerOpenCodeMcpNames(files));
}

function scanOwnerOpenCodeMcpNames(files: string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    let mcp: unknown;
    try { mcp = (JSON.parse(jsoncToJson(readText(file))) as { mcp?: unknown } | null)?.mcp; } catch { continue; }
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) for (const name of Object.keys(mcp)) names.add(name);
  }
  return [...names].sort();
}

/** The env switches above; an explicit value already in the environment wins. */
export function applyOpenCodeIsolationFlags(env: Record<string, string | undefined>): void {
  for (const [name, value] of OPENCODE_ISOLATION_ENV) if (env[name] === undefined) env[name] = value;
}

/**
 * The switches, and every server in the owner's global config turned off.
 * Ownership is by origin: everything in the owner's config files is theirs,
 * whatever it is called (a personal `computer`, `agents` or `composio` too).
 * Murage's own servers ride ACP `session/new`, and OpenCode starts an ACP
 * mount even when the config overlay says `enabled: false` for that name; a
 * same-named config entry is replaced by the ACP one (rig, opencode 1.15.11 and
 * 1.18.35). So nothing is spared by name.
 */
export function isolateOpenCodeFromPersonalSetup(env: Record<string, string | undefined>): void {
  applyOpenCodeIsolationFlags(env);
  const names = ownerOpenCodeMcpNames(env);
  if (!names.length) return;
  let base: Record<string, unknown> = {};
  try {
    const parsed = env.OPENCODE_CONFIG_CONTENT?.trim() ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) as unknown : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch { /* an unparseable overlay is replaced, as opencodeConfigOverlay does */ }
  const mcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp) ? base.mcp as Record<string, unknown> : {};
  const off = Object.fromEntries(names.map((name) => [name, { ...(mcp[name] && typeof mcp[name] === "object" ? mcp[name] as object : {}), enabled: false }]));
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...base, mcp: { ...mcp, ...off } });
}

/** OpenCode's own tools that act (each named, so an owner or project config
 *  that allows one by name is overridden too; `*` covers MCP tools). */
const OPENCODE_ASKED_TOOLS = ["bash", "edit", "write", "task", "skill", "lsp", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"] as const;

/** A key-file read rule (shared/sensitive-paths.ts) as an OpenCode read
 *  pattern. OpenCode's `*` spans folders, so a leading `*` matches the rule
 *  anywhere: in the project, or under a home that is the working folder. */
function openCodeReadPattern(rule: string): string {
  const tail = rule.replace(/^~\//, "").replace(/^\*\*\//, "").replace(/\*\*/g, "*");
  return tail.startsWith("*") ? tail : `*${tail}`;
}

/** The permission set every OpenCode bot turn runs under. OpenCode's defaults
 *  allow bash, edits and every MCP tool, so it never asked and Murage's access
 *  level never applied (real-engine gate, OpenCode 1.19.3: shell and computer
 *  clicks ran at Ask with no card). Here everything that acts asks, so each
 *  call reaches Murage as session/request_permission and the bot's level
 *  answers it (Full access and Auto answer it unasked). Reads, searches and
 *  the to-do list run, as they do on Claude, except a key file. */
export function openCodeTurnPermission(): Record<string, unknown> {
  const read: Record<string, string> = { "*": "allow" };
  for (const row of SENSITIVE_PATHS) for (const rule of row.read) read[openCodeReadPattern(rule)] = "ask";
  return {
    "*": "ask",
    ...Object.fromEntries(OPENCODE_ASKED_TOOLS.map((tool) => [tool, "ask"])),
    read,
    glob: "allow",
    grep: "allow",
    list: "allow",
    todoread: "allow",
    todowrite: "allow",
  };
}

/** Write the turn's permission set into the inline config, which OpenCode
 *  merges over every config file; the owner's own `permission` there is
 *  replaced, never merged. */
export function applyOpenCodeTurnPermission(env: Record<string, string | undefined>): void {
  let base: Record<string, unknown> = {};
  const raw = env.OPENCODE_CONFIG_CONTENT?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch { /* an unparseable overlay is replaced, as opencodeConfigOverlay does */ }
  }
  const permission = openCodeTurnPermission();
  // An agent's own `permission` outranks the top-level one (an owner's
  // `agent.build.permission.bash: "allow"` ran bash unasked on the real CLI),
  // so OpenCode's own agents carry the same set, and a bot turn always starts
  // on `build`, never on an agent of the owner's own config.
  const agent = Object.fromEntries(OPENCODE_AGENTS.map((name) => [name, { permission }]));
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...base, permission, agent, default_agent: "build" });
}

/** OpenCode's own agents: `build` (the default), `plan`, and the subagents it starts. */
const OPENCODE_AGENTS = ["build", "plan", "general", "explore"] as const;

/**
 * The owner's global ~/.config/opencode/AGENTS.md is read from
 * `OPENCODE_CONFIG_DIR ?? <config folder>`, so pointing OPENCODE_CONFIG_DIR at
 * an empty Murage-owned folder leaves it out while the global opencode.json
 * (providers, Murage's Flux connector, the overlay above) still loads; the
 * login is in the data folder (~/.local/share/opencode/auth.json), which this
 * does not move. Rig: opencode 1.15.11 and 1.18.35, marker gone, provider
 * loaded. An older build that does not know the variable ignores it.
 *
 * An OPENCODE_CONFIG_DIR the owner set is never passed to a bot: that folder is
 * the SOURCE, and the bot gets a Murage-owned scope of it (one per bot,
 * scoped-cli-home.ts) holding only a copy of its opencode.json / config.json
 * without the keys that start or load the owner's own things (`mcp`, `plugin`,
 * `instructions`), so providers and models still resolve. Its AGENTS.md, agents,
 * commands, skills and plugins are absent. The owner's folder is only read.
 */
export const OPENCODE_CONFIG_FILES = ["opencode.json", "opencode.jsonc", "config.json"] as const;
/** opencode.json keys that start or load the owner's own servers, plugins and instruction files. */
const OPENCODE_PERSONAL_CONFIG_KEYS = ["mcp", "plugin", "instructions"] as const;

/**
 * Config-relative file references, rebased against the SOURCE folder. OpenCode resolves `{file:path}` in the config text relative
 * to the config file's own directory ("~/" is the home folder, an absolute path stays; packages/core/src/config/variable.ts lines
 * 56-58, anomalyco/opencode; docs https://opencode.ai/docs/config/#files), and the `references` table's local paths the same way
 * (packages/core/src/config/plugin/reference.ts localPath). A copy of the config lives in the bot's scope, so a relative path
 * would resolve there and miss the owner's file: each relative one is made absolute against the owner's folder. Tokens on a `//`
 * comment line are left alone, as OpenCode leaves them. Forward slashes, which every platform's OpenCode accepts.
 */
export function rebaseOpenCodeFileRefs(text: string, sourceDir: string): string {
  return text.replace(/\{file:[^}]+\}/g, (token, index: number) => {
    const lineStart = text.lastIndexOf("\n", index - 1) + 1;
    if (text.slice(lineStart, index).trimStart().startsWith("//")) return token;
    const path = token.slice("{file:".length, -1);
    if (path.startsWith("~/") || isAbsolute(path)) return token;
    return `{file:${resolve(sourceDir, path).replaceAll("\\", "/")}}`;
  });
}

function rebaseOpenCodeReferences(references: unknown, sourceDir: string): unknown {
  if (!references || typeof references !== "object" || Array.isArray(references)) return references;
  const local = (value: string) => value.startsWith(".") || value.startsWith("/") || value.startsWith("~");
  const rebased = (value: string) => (value.startsWith("~/") || isAbsolute(value) ? value : resolve(sourceDir, value).replaceAll("\\", "/"));
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(references as Record<string, unknown>)) {
    if (typeof entry === "string") out[name] = local(entry) ? rebased(entry) : entry;
    else if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { path?: unknown }).path === "string") out[name] = { ...entry, path: rebased((entry as { path: string }).path) };
    else out[name] = entry;
  }
  return out;
}

/** The owner's config file without the keys above and with config-relative references rebased to `sourceDir`; null for text that cannot be read as a JSON or JSONC object. */
export function filterOpenCodeConfigFile(text: string, sourceDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(jsoncToJson(rebaseOpenCodeFileRefs(text, sourceDir)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rest = { ...(parsed as Record<string, unknown>) };
    for (const key of OPENCODE_PERSONAL_CONFIG_KEYS) delete rest[key];
    if ("references" in rest) rest.references = rebaseOpenCodeReferences(rest.references, sourceDir);
    return `${JSON.stringify(rest, null, 2)}\n`;
  } catch { return null; }
}

function openCodeConfigScopeSpec(owner: string, botId?: string): ScopedCliHomeSpec {
  return {
    kind: "opencode-config",
    realHome: owner,
    botId,
    share: [],
    generated: () => {
      const out: Record<string, string> = {};
      for (const name of OPENCODE_CONFIG_FILES) {
        let text: string;
        try { text = readText(join(owner, name)); } catch (error) {
          pathExists(join(owner, name));
          // Absent: no copy (an earlier one is removed by the scope build). Present but unreadable: not run with stale settings.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw engineConfigInvalid("OpenCode", error);
        }
        if (!text.trim()) continue; // an empty file holds no settings
        const filtered = filterOpenCodeConfigFile(text, owner);
        if (filtered === null) throw engineConfigInvalid("OpenCode");
        out[name] = filtered;
      }
      return out;
    },
  };
}
registerScopeReconstructor("opencode-config", ({ realHome, botId }) => openCodeConfigScopeSpec(realHome, botId));

export function isolateOpenCodeGlobalInstructions(env: Record<string, string | undefined>, botId?: string): void {
  const owner = env.OPENCODE_CONFIG_DIR;
  if (owner && owner.startsWith(scopedCliHomeRoot("opencode-config"))) { const current = currentScopeHome("opencode-config", owner); if (current) env.OPENCODE_CONFIG_DIR = current; return; } // already a Murage scope: its current generation
  try {
    if (owner) {
      env.OPENCODE_CONFIG_DIR = scopedCliHome(openCodeConfigScopeSpec(owner, botId));
      return;
    }
    const dir = join(DATA_DIR, "native", "opencode-empty-config");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    env.OPENCODE_CONFIG_DIR = dir;
  } catch (error) {
    // Fails closed: the owner's global instructions would otherwise reach the bot; the turn path rejects the turn.
    throw error;
  }
}

const support = (loadCatalog: OpenCodeCatalogLoader): AcpSupport => ({
  driverKind: "opencodeGo",
  // OpenCode starts every ACP mount it is handed, even one its config disables
  // (isolateOpenCodeFromPersonalSetup, rig 1.15.11 and 1.18.35), with no readiness signal.
  mcpListedWait: true,
  // Keep the historical driver kind so existing bots and instance config do
  // not break; only the product name/catalog expand from Go to OpenCode.
  displayName: "OpenCode",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote:
    "OpenCode has no usable models: run `opencode auth login` or connect a provider in the OpenCode app",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  credentialEnv: ["OPENCODE_API_KEY"],
  selectModel: { configId: "model" },
  /**
   * Flux on OpenCode is a pure ID REWRITE at spawn — it writes nothing.
   *
   * OpenCode addresses models as `<provider>/<model>`, so the bare picker id
   * `flux-auto` is not a slug it can resolve (`validModelSlug` above rejects
   * it) and `session/set_config_option` would fail the turn. The provider row
   * that `flux/flux-auto` resolves against was written earlier, once, by the
   * user-initiated connector — never from here. That separation is the point:
   * a spawn must never be able to touch the user's opencode.json.
   *
   * The explicit early return also keeps a Flux id out of
   * `ensureOpenCodeInjectModel` entirely. `decodeInjectId` already returns
   * null for `flux-*` so it would no-op, but a config write is unrecoverable
   * and should not depend on another module's parser staying that way.
   */
  resolveTurnModel: (model, env) => {
    if (!model) return model;
    const tier = fluxModelId(model);
    if (tier) return opencodeFluxModelId(tier);
    return ensureOpenCodeInjectModel(normalizeLegacyOpenCodeModel(model, env), env);
  },
  /**
   * Flux Memory headers. OpenCode merges `OPENCODE_CONFIG_CONTENT` (inline
   * JSON) over the config files, so `provider.flux.options.headers` lands on
   * the Flux provider Murage's connector wrote without rewriting the user's
   * own opencode.json (a per-turn write there is exactly what the connector
   * refuses to do). The provider id is the connector's.
   */
  applyFluxMemory: (env, { decision }) => {
    env.OPENCODE_CONFIG_CONTENT = opencodeConfigOverlay(OPENCODE_FLUX_PROVIDER, decision.headers, env.OPENCODE_CONFIG_CONTENT);
  },
  transformEnv: (env) => {
    stripForeignProviderKeys(env);
    isolateOpenCodeFromPersonalSetup(env);
    // every spawn, provider-route turns included (they skip applyTurnEnv)
    applyOpenCodeTurnPermission(env);
  },
  // The owner's global AGENTS.md: after every Murage read and write of their real
  // config folder this turn (resolveTurnModel), so those still reach it.
  scopeKind: "opencode-config",
  applyMountEnv: (env, { botId }) => isolateOpenCodeGlobalInstructions(env, botId),
  // OpenCode reads opencode.json and .opencode/ from the working folder and
  // every folder above it. In a Murage-owned folder a bot could write one in
  // Auto and grant itself permissions on later turns, so project config is
  // switched off there. A person's own project folder keeps its config.
  applyTurnEnv: (env, { cwd }) => {
    if (cwd && murageOwnsWorkingFolder(cwd)) env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  // A connected Flux provider IS a usable login, and it does not live in
  // auth.json — its key sits inline in opencode.json, which `hasStoredOpenCodeAuth`
  // never reads. Without this clause a Flux turn on an OpenCode install with no
  // other provider is refused by the pre-spawn subscription gate (core.ts:313)
  // before it can reach the router: Flux would be paying for a turn the gate
  // never lets start. `skipSubscriptionAuthForLocalInject` cannot cover it —
  // that predicate only knows `host::model` inject ids.
  //
  // F2: `canListOpenCodeModels` used to be a fourth leg of this predicate, and
  // it is the reason an empty $HOME reported opencode as signed in. `opencode
  // models` prints the bundled models.dev catalogue whether or not anybody has
  // logged in, so a non-empty list is evidence the BINARY works, never that
  // this machine has a credential. It now lives in `mayRunUnauthenticated`
  // below: the pre-spawn gate is exactly as permissive as before, and the
  // Engines screen stops claiming a login nobody performed.
  isAuthenticated: (env) => (
    Boolean(env.OPENCODE_API_KEY)
    || openCodeFluxRouted(env)
    || hasStoredOpenCodeAuth(env)
  ),
  requireAuthenticationBeforeSpawn: true,
  mayRunUnauthenticated: (env, config) => canListOpenCodeModels(env, config.cli),
  classifyError: classifyOpenCodeError,
  // The gate env is READ-ONLY and never handed to a child: `process.env` for
  // the Flux key (FLUX_API_KEY is a workspace credential the ACP core has
  // already stripped out of `environment`, so `environment` alone would hide a
  // dev-mode key), overlaid with `environment` so an instance-specific HOME /
  // XDG_CONFIG_HOME / OPENCODE_CONFIG_DIR still decides WHICH opencode.json
  // the connector gate inspects.
  resolveModels: async (environment, config) => {
    const listed = await loadCatalog(environment, config.cli);
    const merged = await mergeFluxCatalog(
      await mergeLocalInject(listed, environment),
      "opencodeGo",
      { ...process.env, ...environment } as NodeJS.ProcessEnv,
    );
    // The merges build new catalogs; the source of the CLI list is carried over.
    return listed.source ? { ...merged, source: listed.source } : merged;
  },
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function classifyOpenCodeError(error: unknown): ProviderErrorCode | undefined {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = value.code;
  if (code === -32000) return "invalid_credentials";
  if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED") return "invalid_credentials";
  if (code === "SUBSCRIPTION_INACTIVE") return "inactive_subscription";
  if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED") return "quota_or_region_restriction";
  if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") return "upstream_outage";
  if (code === "MODEL_CATALOG_UNAVAILABLE") return "model_catalog_outage";
  return undefined;
}

export const classifyOpenCodeGoError = classifyOpenCodeError;

export function createOpenCodeDriver(loadCatalog: OpenCodeCatalogLoader = discoverOpenCodeModels) {
  return createAcpDriver(support(loadCatalog));
}

export const createOpenCodeGoDriver = createOpenCodeDriver;
export const OpenCodeDriver = createOpenCodeDriver();
export const OpenCodeGoDriver = OpenCodeDriver;
