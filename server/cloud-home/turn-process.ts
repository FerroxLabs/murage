import { cloudHomeCopy } from "./copy.ts";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const CLOUD_ENGINES = ["claudeAgent", "codex", "pi", "antigravity", "grokAgent", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "customAcp", "fuigoAgent", "hermesAgent", "opencodeGo", "qwenAgent"] as const;
export const TURN_LAUNCHER = "/usr/local/libexec/murage-turn-launch";
/** The turn's typed `render` parameters (CLOUD-ENGINES-DESIGN.md 2.3), accumulated by
 * the drivers and sent to the launcher, which renders every engine config file itself.
 * The server never sends file content or a config path. */
export const TURN_RENDER = "MURAGE_CLOUD_TURN_RENDER";
export const TURN_SCRATCH = "MURAGE_CLOUD_TURN_SCRATCH";
/** The bot this turn runs for. The launcher scopes per-bot state (conversation files, B-mode
 * sign-in) by it and refuses a non-login turn without one unless argv is a probe. The marker
 * rides the env only to reach cloudTurnLaunch, which moves it into the request as `bot`; the
 * MURAGE_CLOUD_ prefix rule keeps it out of the child's environment. */
export const TURN_BOT = "MURAGE_CLOUD_TURN_BOT";
/** Claude's approval-broker sockets. The server (murage) binds them and the turn's
 * proxy connects from inside the sandbox; neither can use the engine home for it,
 * so the launcher binds this one directory (root:murage-turn 2770) into Claude turns. */
export const CLOUD_BROKER_DIR = "/data/broker";
export const TURN_MARKER = "MURAGE_CLOUD_TURN_ENGINE";
/** The launcher validates exactly this shape (TURN_UNIT_PATTERN) and runs the turn in
 * that scope under murage-turns.slice, so the server knows the turn's cgroup before
 * the process exists and never needs /proc (hidepid=2 on a home). */
export const TURN_UNIT_PATTERN = /^murage-turn-[0-9a-f]{16}\.scope$/u;
export const TURN_SLICE = "murage-turns.slice";
/** The workspaces a Cloud turn may name as cwd or Claude --add-dir (launcher WORKSPACE_ROOT). */
export const CLOUD_WORKSPACE_ROOT = "/data/home/workspaces";
/** argv placeholders the launcher swaps for the path of the file it rendered for this
 * turn (its RENDER shapes); a written-out path under those flags refuses the turn. */
export const CLOUD_RENDER_MCP = "@render:mcp";
export const CLOUD_RENDER_SYSTEM_PROMPT = "@render:system-prompt";
export function isCloudRenderPlaceholder(path: string | null | undefined): boolean {
  return path === CLOUD_RENDER_MCP || path === CLOUD_RENDER_SYSTEM_PROMPT;
}
export function newTurnUnit(): string { return `murage-turn-${randomBytes(8).toString("hex")}.scope`; }
export function cloudEngineHome(engine: string): string {
  if (!(CLOUD_ENGINES as readonly string[]).includes(engine)) throw new Error(cloudHomeCopy.cloudEngineIsNotRegistered);
  return `/data/engine-homes/${engine}`;
}
/** Start with public runtime settings and this driver's explicit credential grant.
 * Routing code can then inject the selected provider's credential for this turn. */
export function cloudTurnEnvironment(engine: string, source: NodeJS.ProcessEnv, credentials: readonly string[] = []): NodeJS.ProcessEnv {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return source;
  const home = cloudEngineHome(engine);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "TZ", "TERM", ...credentials]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  Object.assign(env, { PATH: "/opt/murage/bin:/usr/local/bin:/usr/bin:/bin", HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: join(home, "tmp"), [TURN_MARKER]: engine });
  if (engine === "claudeAgent") Object.assign(env, { CLAUDE_CONFIG_DIR: join(home, ".claude"), DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1",
    // Telemetry/updater hosts are not on the egress allowlist; turn them off so a blocked call never stalls a turn.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
  if (engine === "codex") env.CODEX_HOME = join(home, ".codex");
  if (engine === "grokAgent") Object.assign(env, { GROK_HOME: join(home, ".grok"), GROK_DISABLE_AUTOUPDATER: "1" });
  if (engine === "opencodeGo") Object.assign(env, { OPENCODE_CONFIG: join(home, ".config/opencode/opencode.json"), OPENCODE_CONFIG_DIR: join(home, ".config/opencode"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    // No on-demand npm: external plugins off, no LSP installs (the launcher pins the same set).
    OPENCODE_PURE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" });
  // KIMI_CODE_NO_AUTO_UPDATE is read by Kimi Code 2.2.0 (found in the shipped binary); the image pins the version.
  if (engine === "kimiAgent") Object.assign(env, { KIMI_CODE_HOME: join(home, ".kimi-code"), KIMI_CODE_NO_AUTO_UPDATE: "1" });
  return env;
}

export type CloudMcpProxyKind = "permission" | "agents" | "memory" | "phone" | "browser" | "computer" | "hostComputer" | "dweb" | "connectors" | "remote" | "vpsRelay" | "url";
export interface CloudMcpStanza { proxy: CloudMcpProxyKind; socket?: string; server?: string; url?: string; env?: Record<string, string>; ask?: boolean }
export interface CloudTurnRoute { provider: string; baseUrl: string; model: string; apiKey: string; protocol?: "openai" | "anthropic" | "responses"; contextSize?: number; label?: string; models?: string[];
  /** Flux Memory headers the launcher renders as the Codex provider table's http_headers. */ headers?: Record<string, string> }
/** `resume`: the Codex thread id a fresh process will `thread/resume`, so the launcher stages that one
 * rollout file into the turn's home (its state allowlist) and no other session. */
export interface CloudTurnRender { route?: CloudTurnRoute; mcp?: Record<string, CloudMcpStanza>; systemPrompt?: string; memoryTools?: boolean; resume?: string; codexPolicy?: CloudCodexPolicy }
/** The approval policy and sandbox a resumed Codex thread must run under. The launcher renders
 * them as the effective policy (REQUIRED whenever `resume` is set), because a resumed thread
 * otherwise keeps whatever policy the stored rollout started with. */
export interface CloudCodexPolicy { approval: "untrusted" | "on-request" | "never"; sandbox: "read-only" | "workspace-write" | "danger-full-access" }

export function cloudTurnRenderContents(env: NodeJS.ProcessEnv): CloudTurnRender {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return {};
  return JSON.parse(env[TURN_RENDER] ?? "{}") as CloudTurnRender;
}
/** Set one typed part of this turn's render; the launcher validates the whole object. */
export function cloudTurnRender<K extends keyof CloudTurnRender>(env: NodeJS.ProcessEnv, key: K, value: CloudTurnRender[K] | undefined): void {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") throw new Error(cloudHomeCopy.cloudTurnFileRequiresAHome);
  const render = cloudTurnRenderContents(env);
  if (value === undefined) delete render[key];
  else render[key] = value;
  env[TURN_RENDER] = JSON.stringify(render);
}
/** Name the bot this turn runs for (no-op off a home). A probe (`--version`, `login status`)
 * never calls this, so its request carries no `bot`. */
export function cloudTurnBot(env: NodeJS.ProcessEnv, botId: string | null | undefined): void {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return;
  if (botId) env[TURN_BOT] = botId;
  else delete env[TURN_BOT];
}
/** Ask the launcher for a fresh per-turn tmpfs at `relative` (a path inside
 * this engine's home) so the server never creates anything under
 * /data/engine-homes. The launcher validates the shape. */
export function cloudTurnScratch(env: NodeJS.ProcessEnv, relative: string): void {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") throw new Error(cloudHomeCopy.cloudTurnFileRequiresAHome);
  const scratch = JSON.parse(env[TURN_SCRATCH] ?? "[]") as string[];
  scratch.push(relative);
  env[TURN_SCRATCH] = JSON.stringify(scratch);
}
export function cloudTurnLaunch(command: string, args: string[], env: NodeJS.ProcessEnv | undefined, cwd?: string | URL) {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  const engine = env?.[TURN_MARKER];
  if (!engine) throw new Error(cloudHomeCopy.cloudCLILaunchRequiresAnExplicitEngine);
  const home = cloudEngineHome(engine);
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined && key !== TURN_MARKER && !key.startsWith("MURAGE_CLOUD_") && !/^(LD_|PYTHON|PERL5)/.test(key) && !["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "GCONV_PATH", "CI"].includes(key)) childEnv[key] = value;
  }
  childEnv.HOME = home;
  childEnv.USERPROFILE = home;
  const unit = newTurnUnit();
  const render = JSON.parse(env?.[TURN_RENDER] ?? "{}") as CloudTurnRender;
  return { command: "/usr/bin/sudo", args: ["-n", "-C", "4", "--", TURN_LAUNCHER], unit,
    request: JSON.stringify({ unit, engine, command, args, cwd: cwd === undefined ? home : String(cwd), env: childEnv,
      ...(env?.[TURN_BOT] ? { bot: env[TURN_BOT] } : {}),
      ...(Object.keys(render).length ? { render } : {}), ...(env?.[TURN_SCRATCH] ? { scratch: JSON.parse(env[TURN_SCRATCH]) } : {}) }) };
}
