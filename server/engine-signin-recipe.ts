// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a desktop signs an engine in (1.0.14, handoffs/designs/ENGINE-SIGNIN-SIMPLE-1014.md): one fixed row per driver, and
// the exact argv and environment that row runs with. Pure: the route in server/index.ts hands in the live facts. Argv is
// never free text and nothing here comes from a renderer or a bot.
//
// Kinds, by what each CLI did detached with no TTY in a throwaway Linux container (no sign-in completed):
//   headless  it opens the owner's browser by itself, so electron/engine-login-local.mjs runs it with all stdio on ignore.
//   terminal  it needs a real terminal (a picker, or it refuses without a TTY). One button opens the recipe in a terminal.
//   none      no sign-in to run: an API key, an engine with no account, or a command that could not be resolved.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type EngineSigninKind = "headless" | "terminal" | "none";
/** Exact allow-list of a sign-in child's environment (G5), before the instance's own account keys. */
export const SIGNIN_BASE_ENV = Object.freeze(["PATH", "HOME", "USERPROFILE", "SystemRoot", "PATHEXT"]);
/** Rev 4 C5: the only names a row may add. Each says where an engine keeps its sign-in, and nothing else. A row with any
 * other name is refused here, so SSL_CERT_FILE, BASH_ENV, a proxy or a blocked name can never come back through a row. */
export const SIGNIN_ACCOUNT_ROOT_KEYS = Object.freeze(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "OPENCODE_CONFIG_DIR", "CLINE_DIR", "CLINE_DATA_DIR", "FACTORY_HOME_OVERRIDE", "HERMES_HOME", "FUIGO_HOME"]);
const ACCOUNT_ROOT_KEY_SET = new Set<string>(SIGNIN_ACCOUNT_ROOT_KEYS);
/** What the engine's own browser opener needs, and nothing else (amends G5). Read from the desktop session only, never from
 * instance environment, so an instance cannot point a sign-in at another display or shell. Mac needs no name past the base list. */
export const SIGNIN_OPENER_ENV: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = Object.freeze({
  linux: Object.freeze(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"]),
  win32: Object.freeze(["ComSpec", "windir", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]),
});

interface SigninRoot { key?: string; fallback: readonly string[]; suffix?: readonly string[] }

export interface EngineSigninRow {
  kind: EngineSigninKind;
  /** Arguments after the executable. Fixed. */
  args: readonly string[];
  /** The names this driver reads for its sign-in home. The only names past the base list. */
  accountKeys: readonly string[];
  root: SigninRoot;
  /** Plain measured reason for the kind, for the next reader. */
  measured: string;
}

const NO_ROOT: SigninRoot = { fallback: [] };
const none = (measured: string): EngineSigninRow => ({ kind: "none", args: [], accountKeys: [], root: NO_ROOT, measured });
const terminal = (args: readonly string[], accountKeys: readonly string[], root: SigninRoot, measured: string): EngineSigninRow =>
  ({ kind: "terminal", args, accountKeys, root, measured });

/** Every driver Murage ships. A driver with no row is "none", and a test holds every driver with a sign-in command to a row. */
export const ENGINE_SIGNIN_TABLE: Readonly<Record<string, EngineSigninRow>> = Object.freeze({
  codex: { kind: "headless", args: ["login"], accountKeys: ["CODEX_HOME"], root: { key: "CODEX_HOME", fallback: [".codex"] }, measured: "0.166.0 detached: listens on 127.0.0.1:1455, opener called" },
  claudeAgent: { kind: "headless", args: ["auth", "login"], accountKeys: ["CLAUDE_CONFIG_DIR"], root: { key: "CLAUDE_CONFIG_DIR", fallback: [".claude"] }, measured: "2.1.316 detached: listens on a random port, opener called" },
  // Bare `login` picked device code in the container, so the row names the browser flow.
  grokAgent: { kind: "headless", args: ["login", "--oauth"], accountKeys: ["GROK_HOME"], root: { key: "GROK_HOME", fallback: [".grok"] }, measured: "1.0.70 detached: listens on a random port, opener called, alive 91 s" },
  kimiAgent: { kind: "headless", args: ["login", "--region", "global"], accountKeys: ["KIMI_CODE_HOME"], root: { key: "KIMI_CODE_HOME", fallback: [".kimi-code"] }, measured: "2.4.1 detached: device code only, the CLI opens the page itself" },
  cursorAgent: { kind: "headless", args: ["login"], accountKeys: ["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"], root: { key: "CURSOR_CONFIG_DIR", fallback: [".cursor"] }, measured: "2026.10.22 detached: opener called, process stayed alive" },
  opencodeGo: terminal(["auth", "login"], ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"], { key: "XDG_DATA_HOME", fallback: [".local", "share", "opencode"], suffix: ["opencode"] }, "a picker, not headless"),
  clineAgent: terminal(["auth"], ["CLINE_DIR", "CLINE_DATA_DIR"], { key: "CLINE_DIR", fallback: [".cline"] }, "refuses without a TTY"),
  droidAgent: terminal([], ["FACTORY_HOME_OVERRIDE"], { key: "FACTORY_HOME_OVERRIDE", fallback: [".factory"], suffix: [".factory"] }, "1.1.0 pipes: draws a picker and prints no link"),
  openclawAgent: terminal(["onboard"], [], { fallback: [".openclaw"] }, "2026.10.5 pipes: refuses, needs a TTY"),
  hermesAgent: terminal(["setup"], ["HERMES_HOME"], { key: "HERMES_HOME", fallback: [".hermes"] }, "0.22.5 pipes: refuses, no TTY, prints no link"),
  // agy 1.4.12 has no sign-in subcommand: `auth` and `login` are refused as stray arguments, so a first run is the sign-in.
  antigravityAgent: terminal([], [], { fallback: [".gemini"] }, "1.4.12 pipes: prints nothing, no sign-in subcommand"),
  // Stays on FluxKeyCard in EngineSetup. Bare `login` exits 2 with no TTY, so it is never called here.
  fuigoAgent: none("the Flux key card, or a plan through Murage"),
  // The sign-in command itself holds the API key in argv, so it never gets a run button: the key box in Engines takes it.
  minimax: none("an API key in argv; the key path takes it"),
  grok: none("API key"),
  "openai-compat": none("API key or local server"),
  piAgent: none("no account of its own"),
  geminiAgent: none("no sign-in command"),
  qwenAgent: none("no sign-in command"),
  customAcp: none("owner's own agent"),
  boxAgent: none("runs on the box"),
});

const lower = (name: string) => name.toUpperCase();

/** `{ ...source, ...instance }` the way the platform reads names: on Windows `Path` and `PATH` are one variable. */
function mergedEnv(source: Record<string, string | undefined>, instance: Record<string, string> | undefined, platform: NodeJS.Platform) {
  const map = new Map<string, string>();
  const key = (name: string) => platform === "win32" ? lower(name) : name;
  for (const layer of [source, instance ?? {}]) for (const [name, value] of Object.entries(layer)) if (typeof value === "string") map.set(key(name), value);
  return (name: string) => map.get(key(name));
}

const clean = (value: string | undefined): string | undefined => typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/.test(value) ? value : undefined;

export interface SigninEnvInput {
  row: Pick<EngineSigninRow, "accountKeys">;
  source: Record<string, string | undefined>;
  instanceEnvironment?: Record<string, string>;
  /** The PATH the server launches engines with. */
  searchPath: string;
  platform: NodeJS.Platform;
  /** Account keys Murage decides itself (a named Claude account's folder). Win over anything inherited. */
  account?: Record<string, string>;
}

/** The whole environment of a sign-in child, and the names of everything left out. Nothing passes by default:
 * no token, key, base URL, proxy, NODE_OPTIONS, DYLD_* or LD_PRELOAD reaches a sign-in, whatever its spelling. */
export function buildSigninEnv({ row, source, instanceEnvironment, searchPath, platform, account }: SigninEnvInput): { env: Record<string, string>; unsetKeys: string[] } {
  const read = mergedEnv(source, instanceEnvironment, platform);
  const env: Record<string, string> = {};
  for (const name of SIGNIN_BASE_ENV) {
    if (name === "PATH") continue;
    if (platform !== "win32" && (name === "USERPROFILE" || name === "SystemRoot" || name === "PATHEXT")) continue;
    const value = clean(read(name));
    if (value) env[name] = value;
  }
  env.PATH = searchPath;
  for (const name of row.accountKeys) {
    if (!ACCOUNT_ROOT_KEY_SET.has(name)) continue;
    const value = clean(account?.[name] ?? read(name));
    if (value) env[name] = value;
  }
  const session = mergedEnv(source, undefined, platform);
  for (const name of SIGNIN_OPENER_ENV[platform] ?? []) {
    const value = clean(session(name));
    if (value) env[name] = value;
  }
  const kept = new Set(Object.keys(env).map(lower));
  const unsetKeys = [...new Set(Object.keys(source).filter((name) => !kept.has(lower(name))))].sort();
  return { env, unsetKeys };
}

export interface ResolvedArgv { command: string; args: string[] }

export interface SigninExecutableInput {
  /** The instance's cli value. */
  cli: string;
  args: readonly string[];
  platform: NodeJS.Platform;
  /** resolveCli: Windows shims to their target, a wrapper's fixed words ahead of the args. */
  resolve: (cli: string, args: string[]) => ResolvedArgv;
  /** Absolute paths for a bare name, on the PATH engines launch with, first one first. */
  candidates: (name: string) => string[];
  /** realpath; throws when the file is gone. */
  realpath: (file: string) => string;
}

/** Absolute realpath and prefix args (A6, G4), or null when there is none, or a Windows shim could not be read. Never a shell. */
export function resolveSigninArgv({ cli, args, platform, resolve, candidates, realpath }: SigninExecutableInput): string[] | null {
  const resolved = resolve(cli, [...args]);
  const absolute = (platform === "win32" ? win32 : posix).isAbsolute(resolved.command) ? resolved.command : candidates(resolved.command)[0];
  if (!absolute) return null;
  let real: string;
  try { real = realpath(absolute); } catch { return null; }
  if (!real || !(platform === "win32" ? win32 : posix).isAbsolute(real)) return null;
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(real)) return null;
  return [real, ...resolved.args];
}

export interface EngineSigninRecipe {
  kind: EngineSigninKind;
  argv: string[];
  env: Record<string, string>;
  unsetKeys: string[];
  accountRoot: string;
  /** The account-root keys alone: a terminal runs on the owner's own environment plus these. */
  accountEnv: Record<string, string>;
  label: string;
}

export interface EngineSigninRecipeInput {
  driverKind: string;
  label: string;
  cli: string | undefined;
  source: Record<string, string | undefined>;
  instanceEnvironment?: Record<string, string>;
  searchPath: string;
  platform: NodeJS.Platform;
  account?: Record<string, string>;
  /** The folder the sign-in writes to when the engine has a say of its own (a named Claude account). */
  accountRoot?: string;
  resolve: SigninExecutableInput["resolve"];
  candidates: SigninExecutableInput["candidates"];
  realpath: SigninExecutableInput["realpath"];
}

function accountRootOf(row: EngineSigninRow, read: (name: string) => string | undefined, platform: NodeJS.Platform): string {
  const home = read("HOME") || read("USERPROFILE") || homedir();
  const paths = platform === "win32" ? win32 : posix;
  if (row.root.key) {
    const set = clean(read(row.root.key));
    if (set && paths.isAbsolute(set)) return paths.join(set, ...(row.root.suffix ?? []));
  }
  return row.root.fallback.length ? paths.join(home, ...row.root.fallback) : "";
}

/** The one recipe for an instance. A row with nothing to run, or a command that cannot be resolved, is kind "none" with an empty argv. */
export function buildEngineSigninRecipe(input: EngineSigninRecipeInput): EngineSigninRecipe {
  const row = ENGINE_SIGNIN_TABLE[input.driverKind] ?? none("unknown driver");
  const { env, unsetKeys } = buildSigninEnv({ row, source: input.source, instanceEnvironment: input.instanceEnvironment, searchPath: input.searchPath, platform: input.platform, account: input.account });
  const read = mergedEnv(input.source, input.instanceEnvironment, input.platform);
  const accountRoot = input.accountRoot ?? accountRootOf(row, read, input.platform);
  const argv = row.kind !== "none" && input.cli
    ? resolveSigninArgv({ cli: input.cli, args: row.args, platform: input.platform, resolve: input.resolve, candidates: input.candidates, realpath: input.realpath })
    : null;
  if (!argv) return { kind: "none", argv: [], env: {}, unsetKeys: [], accountRoot, accountEnv: {}, label: input.label };
  const accountEnv = Object.fromEntries(row.accountKeys.flatMap((name) => ACCOUNT_ROOT_KEY_SET.has(name) && env[name] ? [[name, env[name]]] : []));
  return { kind: row.kind, argv, env, unsetKeys, accountRoot, accountEnv, label: input.label };
}
