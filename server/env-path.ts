// PATH augmentation for GUI launches — the fix for "CLI not found" when
// the app is opened from Finder (issues #8, #12).
//
// A macOS app launched from Finder inherits a bare PATH
// (/usr/bin:/bin:...): no ~/.local/bin (the claude installer default),
// no /opt/homebrew/bin, and no nvm/volta/asdf/mise shims — those only exist
// in interactive shells. The terminal sees the CLIs; the packaged app
// doesn't. So every spawn of an agent CLI goes through augmentedPath():
// the inherited PATH, plus the well-known install locations that exist
// on this machine, plus (async, best-effort) whatever PATH the user's
// real login shell reports.
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { CAPTURE_BYTES, CAPTURE_MS } from "../shared/scan-limits.ts";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** nvm keeps every node version's bin dir separately; newest first so a
 * CLI installed under the latest node wins. */
function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

/** Where mise keeps its shims (upstream #1824): MISE_DATA_DIR, else
 * $XDG_DATA_HOME/mise, else ~/.local/share/mise. Only an absolute setting
 * counts; a relative one would resolve against whatever folder we run in. */
function miseShimsDir(home: string): string {
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : undefined);
  const dataDir = absolute(process.env.MISE_DATA_DIR);
  if (dataDir) return join(dataDir, "shims");
  return join(absolute(process.env.XDG_DATA_HOME) ?? join(home, ".local", "share"), "mise", "shims");
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"), // claude installer default
    join(home, ".npm-global", "bin"), // npm prefix ~/.npm-global (claude, opencode)
    join(home, ".kimi-code", "bin"), // kimi-code installer
    join(home, ".grok", "bin"), // x.ai installer
    join(home, ".fuigo", "bin"), // fuigo installer (npm postinstall target)
    join(home, ".opencode", "bin"), // opencode installer
    join(home, ".claude", "local"), // claude "local install"
    "/opt/homebrew/bin", // brew, Apple silicon
    "/usr/local/bin", // brew Intel / classic installs
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    miseShimsDir(home), // mise installer
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

/** Windows equivalents of knownDirs. A GUI app inherits the user PATH at
 * launch, but only at launch: a CLI installed while the app is running is
 * invisible until it restarts, because Windows never pushes PATH changes
 * into a live process. Scanning the standard install locations recovers
 * those without a restart — `~/.grok/bin` (the x.ai installer) and
 * `%APPDATA%\npm` (global npm shims), plus `%LOCALAPPDATA%\agy\bin`, cover
 * every engine we ship an install command for. */
function windowsKnownDirs(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(appData, "npm"), // npm -g shims: claude, codex
    join(home, ".grok", "bin"), // x.ai installer
    join(home, ".fuigo", "bin"), // fuigo installer (npm postinstall target)
    join(localAppData, "agy", "bin"), // Antigravity installer
    join(home, ".local", "bin"), // claude native installer
    join(home, ".claude", "local"),
    join(home, "bin"), // Factory droid installer (%USERPROFILE%\bin)
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
  ];
}

/** null = scan the real machine. Never set outside a test; see
 * restrictInstallScanDirsForTests. */
let scanDirsOverride: readonly string[] | null = null;

/** The install locations augmentedPath() scans on this platform. The ONLY
 * place either list is read, so the test seam below has exactly one place to
 * take effect and cannot drift away from what production scans. */
function installScanDirs(): string[] {
  if (scanDirsOverride !== null) return [...scanDirsOverride];
  // Both platforms scan their standard install locations; only the
  // login-shell probe stays unix-only, since Windows has no equivalent
  // rc file to source.
  return process.platform === "win32" ? windowsKnownDirs() : knownDirs();
}

/**
 * Test seam — pretend the machine's install locations are exactly `dirs`,
 * or pass null to restore the real scan.
 *
 * knownDirs() scans ABSOLUTE system directories — /opt/homebrew/bin,
 * /usr/local/bin — that no environment variable can move. Moving HOME and
 * emptying PATH therefore does NOT give a test a machine with "nothing
 * installed": a developer who has the engine under test installed via
 * Homebrew still gets a hit, the product correctly prefers their own install,
 * and the test asserts the opposite of what it means to. That is a test
 * defect, not a product one — resolveFuigoCli's documented order (a
 * user-installed engine wins when at least as new as the bundle) is deliberate.
 *
 * UNUSED, THIS CHANGES NOTHING: installScanDirs() returns exactly what
 * knownDirs()/windowsKnownDirs() return today, and env-path.test.ts asserts
 * that the unrestricted list still carries the hardcoded system directories
 * so this seam can never quietly become the production behaviour.
 *
 * The PATH cache is dropped here so a caller cannot set this and then read a
 * PATH built before it. resetPathCache*() deliberately does NOT clear the
 * override: tests reset the cache mid-test, and a reset that silently put
 * /opt/homebrew/bin back would reintroduce the very flake this removes. The
 * test that sets it is the test that clears it.
 */
export function restrictInstallScanDirsForTests(dirs: readonly string[] | null): void {
  scanDirsOverride = dirs === null ? null : [...dirs];
  cached = null;
  probed = false;
}

/** Test hook — the install locations installScanDirs() would scan right now,
 * so a test can assert the UNRESTRICTED list still contains the hardcoded
 * system directories. */
export function installScanDirsForTests(): string[] {
  return installScanDirs();
}

let cached: string | null = null;
let probed = false;
let loginShellPath: string | null = null;

/** Drop the memoized PATH so the next augmentedPath() rescans. Called when
 * the app re-probes engines, so "check again" can find something installed
 * since launch instead of answering from the PATH we booted with. `probed`
 * must reset too: the login-shell probe merges rc-file PATH entries (e.g.
 * ~/.kimi-code/bin exported from .zshrc) into the cache asynchronously,
 * and without resetting it a rescan would rebuild the cache without those
 * entries and never re-probe — "check again" would permanently lose
 * anything only the login shell's rc file knows about. */
export function resetPathCache(): void {
  cached = null;
  probed = false;
}

/** Current best PATH, synchronously. Cheap after the first call. */
export function augmentedPath(): string {
  if (cached === null) {
    cached = mergePaths([
      ...(process.env.MURAGE_EXTRA_PATH ? process.env.MURAGE_EXTRA_PATH.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      // Keep the last successful login-shell result while a rescan starts a
      // fresh asynchronous probe. Otherwise resetPathCache() would make
      // rc-only CLIs disappear again for the response that triggered it.
      ...(loginShellPath ? loginShellPath.split(delimiter) : []),
      ...installScanDirs().filter((d) => existsSync(d)),
    ]);
  }
  // The owner's interactive login capture (captureOwnerEnv, Rule 74a) is the
  // one probe: started here in the background so the Engines panel sees the
  // owner's PATH, and awaited by every engine spawn before it is handed.
  if (!probed && !process.env.VITEST && process.platform !== "win32") {
    probed = true;
    void captureOwnerEnv();
  }
  return cached;
}

/** The install directories that exist and that `path` does not already
 * name: what an engine's handed PATH gains after the owner's own order. */
export function installPathTail(path: string): string[] {
  const have = new Set(path.split(delimiter).filter(Boolean));
  return installScanDirs().filter((dir) => !have.has(dir) && existsSync(dir));
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

// ---------------------------------------------------------------------------
// Rule 74a (APP-GRANT-DESIGN-FINAL.AGREED-r10.md): the owner's toolchain
// environment, captured the way the owner's terminal gets it, once per server
// process per account shell, awaited before the first engine spawn.

/** One validated capture: the whole exported map, and where it came from. */
export interface OwnerEnv {
  env: Readonly<Record<string, string>>;
  capture: "session" | "kept" | "fallback";
  /** when the map was captured (kept) and why the latest capture failed */
  capturedAt?: number;
  cause?: string;
}

let ownerEnvStoreDir: string | null = null;
let lastValid: { env: Record<string, string>; at: number } | null = null;
/** The capture in use and the generation it was published under. */
let current: (OwnerEnv & { generation: number }) | null = null;
/** The capture in flight and the generation it started under. */
let pending: { generation: number; run: Promise<OwnerEnv> } | null = null;

// Rules 74a, 74d: one environment generation fences the capture and every consistency check. It only moves forward, and
// only invalidateEnvCapture moves it: a capture or a check that started under an older generation never publishes.
let generation = 0;
let invalidatedBecause: string | undefined;
const onInvalidate: Array<() => void> = [];

/** The current environment generation. */
export function envGeneration(): number {
  return generation;
}

/** Why the generation last moved (an approved startup-file write, the Engines panel's "check again"). */
export function envInvalidationCause(): string | undefined {
  return invalidatedBecause;
}

/** Register what an invalidation clears besides the capture (engine-env.ts registers its check map). */
export function onEnvInvalidate(clear: () => void): void {
  onInvalidate.push(clear);
}

/** The one place the environment goes stale: the next spawn captures again, a capture in flight is discarded when it
 *  finishes, and every cached check is dropped. A RUNNING engine keeps the map it was handed. */
export function invalidateEnvCapture(cause: string): void {
  generation++;
  invalidatedBecause = cause;
  // the capture in use is left as it was: "kept" is written only by a capture that failed (r3 (f))
  for (const clear of onInvalidate) clear();
}

/** Where the last validated map is persisted (`<dataDir>/env`). Set once at boot. */
export function setOwnerEnvStore(dir: string | null): void {
  ownerEnvStoreDir = dir;
}

/** The account shell, the same account record Codex reads; `$SHELL`, then `/bin/zsh`. */
export function accountShell(): string {
  let shell = "";
  try { shell = userInfo().shell ?? ""; } catch { shell = ""; }
  return shell || process.env.SHELL || "/bin/zsh";
}

/** Parse `name=value\0` pairs to the last byte; null when any byte is left over
 * or a pair has no name. */
export function parseEnvBlock(block: string): Record<string, string> | null {
  if (block === "") return null;
  if (!block.endsWith("\0")) return null;
  const out: Record<string, string> = {};
  for (const pair of block.slice(0, -1).split("\0")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const name = pair.slice(0, eq);
    if (!/^[^=\0]+$/.test(name)) return null;
    Object.defineProperty(out, name, { value: pair.slice(eq + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Validated complete: both markers present and outermost around the map,
 * the map parses whole, and it holds PATH and HOME. */
export function readCapture(stdout: string, mark: string): Record<string, string> | null {
  const first = stdout.indexOf(mark);
  const last = stdout.lastIndexOf(mark);
  if (first < 0 || last <= first) return null;
  const map = parseEnvBlock(stdout.slice(first + mark.length, last));
  if (!map || !map.PATH || !map.HOME) return null;
  delete map.MURAGE_ENV_MARK;
  return map;
}

function storeFile(shell: string): string | null {
  if (!ownerEnvStoreDir) return null;
  return join(ownerEnvStoreDir, `owner-env.${createHash("sha256").update(shell).digest("hex").slice(0, 16)}`);
}

/** Names whose values are credentials. The kept copy never holds them (the live in-memory capture still does). Names ending in _SOCK (SSH_AUTH_SOCK) are socket paths, not secrets, and stay. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/** The environment minus every credential-named variable. */
function withoutSecrets(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) && !/_SOCK$/i.test(name)) continue;
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function persist(shell: string, env: Record<string, string>): void {
  const file = storeFile(shell);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const body = Object.entries(withoutSecrets(env)).map(([name, value]) => `${name}=${value}\0`).join("");
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // a failed write only loses the kept copy; the session map still stands
  }
}

function readKept(shell: string): Record<string, string> | null {
  const file = storeFile(shell);
  if (!file) return null;
  try {
    const raw = parseEnvBlock(readFileSync(file, "utf8"));
    if (!raw) return null;
    // a copy written by an earlier 1.0.3 build may hold credentials: filter on read and rewrite it filtered
    const map = withoutSecrets(raw);
    if (Object.keys(map).length !== Object.keys(raw).length) persist(shell, map);
    return map.PATH && map.HOME ? map : null;
  } catch {
    return null;
  }
}

/** Run the interactive login capture once. Murage's own process, not a tool
 * call; no model text anywhere in it. */
function runCapture(shell: string): Promise<{ env: Record<string, string> } | { cause: string }> {
  const mark = `__MURAGE_ENV_${randomBytes(12).toString("hex")}__`;
  const script = `printf '%s' "$MURAGE_ENV_MARK"; env -0; printf '%s' "$MURAGE_ENV_MARK"`;
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ["-l", "-i", "-c", script],
      { timeout: CAPTURE_MS, maxBuffer: CAPTURE_BYTES, encoding: "utf8", env: { ...process.env, MURAGE_ENV_MARK: mark } },
      (error, stdout) => {
        if (error) return resolve({ cause: error.killed ? "it took too long" : `the shell exited with ${String((error as { code?: unknown }).code ?? "an error")}` });
        const env = readCapture(stdout, mark);
        resolve(env ? { env } : { cause: "its output could not be read whole" });
      },
    );
    child.stdin?.end();
  });
}

/**
 * The owner's environment for an engine spawn (Rule 74a). Captured once and
 * reused; a failed capture hands the last validated map (`kept`) or, with
 * none, Murage's own process environment with PATH = augmentedPath()
 * (`fallback`), and is retried before the next spawn. On Windows the GUI
 * launch already carries the user's registry environment whole, so it is read
 * live on every spawn (as 1.0.2 did), never kept from the first one: a frozen
 * copy would hand later engines names Murage has since changed or removed.
 */
export async function captureOwnerEnv(options: { shell?: string } = {}): Promise<OwnerEnv> {
  const at = generation;
  if (process.platform === "win32" && !options.shell) {
    const env = { ...(process.env as Record<string, string>), PATH: augmentedPath() };
    current = { env, capture: "session", generation: at };
    return current;
  }
  if (current?.capture === "session" && current.generation === at) return current;
  if (pending && pending.generation === at) return pending.run;
  const run: Promise<OwnerEnv> = (async (): Promise<OwnerEnv> => {
    const shell = options.shell ?? accountShell();
    // under test only a named shell is run: never the account's real startup files
    const result = process.env.VITEST && !options.shell ? { cause: "not captured under test" } : await runCapture(shell);
    // invalidated while it ran: this capture is discarded unpublished, and the caller gets one from the new generation
    if (generation !== at) return captureOwnerEnv(options);
    if ("env" in result) {
      lastValid = { env: result.env, at: Date.now() };
      persist(shell, result.env);
      loginShellPath = result.env.PATH ?? null;
      cached = null;
      current = { env: result.env, capture: "session", generation: at };
      return current;
    }
    const kept = lastValid ?? (() => { const map = readKept(shell); return map ? { env: map, at: 0 } : null; })();
    if (kept) {
      lastValid = kept;
      current = { env: kept.env, capture: "kept", capturedAt: kept.at || undefined, cause: result.cause, generation: at };
      return current;
    }
    current = { env: { ...(process.env as Record<string, string>), PATH: augmentedPath() }, capture: "fallback", cause: result.cause, generation: at };
    return current;
  })().finally(() => { if (pending?.run === run) pending = null; });
  pending = { generation: at, run };
  return run;
}

/** The last capture's state, for the Engines panel line. */
export function ownerEnvState(): OwnerEnv | null {
  return current;
}

/** The Engines panel's status after discovery (r3 (f), Rule 74a). `fresh` (Check again) invalidates the capture and
 *  awaits a new one, then discovery is awaited, and only THEN is the capture state read, so the line reports the
 *  capture that this check produced: session, kept (with when and why) or fallback. */
export async function ownerEnvAfterDiscovery<T>(fresh: boolean, discover: () => Promise<T>, options: { shell?: string } = {}): Promise<{ discovered: T; owner: OwnerEnv | null }> {
  if (fresh) {
    invalidateEnvCapture("the owner asked to check again");
    await captureOwnerEnv(options);
  }
  const discovered = await discover();
  return { discovered, owner: ownerEnvState() };
}

/** Test hook — the cache is process-wide otherwise. */
export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
  loginShellPath = null;
  current = null;
  lastValid = null;
  pending = null;
}

/** Every `name` binary on the augmented PATH as absolute paths, in PATH
 * order (first = what a bare name would run). Used by the Engines panel's
 * "detected" dropdown and the /api/cli-candidates endpoint. A path-ish
 * name is echoed back as-is — it already IS a location. */
export function findCliCandidates(name: string): string[] {
  if (!name || /[\n\r]/.test(name)) return [];
  if (/[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) return [name];
  // On win32 PATHEXT never contains "", so a name that ALREADY carries its
  // extension ("fuigo.exe") was probed only as fuigo.exe.COM/.EXE/.BAT/.CMD and
  // could never be found. That made resolveFuigoCli always answer "bundled" on
  // Windows, so the pinned copy shadowed a newer fuigo the user installed
  // themselves — the exact opposite of the documented precedence. `whichWin`
  // already got this right (it checks extname first); this did not.
  const winExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const exts =
    process.platform === "win32" ? (extname(name) ? ["", ...winExts] : winExts) : [""];
  const out: string[] = [];
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// Windows CLI resolution ───────────────────────────────────────────────
// PATH alone is not enough on Windows. libuv ignores PATHEXT, so
// spawn("claude") never finds claude.cmd — and since Node's
// CVE-2024-27980 fix, spawning a .cmd without shell:true throws
// synchronously anyway. shell:true is not an option here: the drivers
// pass raw JSON in argv (claude's --mcp-config), which cmd would mangle.
// Windows also has no #! support, so a node-shebang script (every fake
// CLI in server/testing) is unspawnable as itself.
//
// So resolve the real file ourselves, PATHEXT-aware, and turn what we
// find into a spawn that needs no shell: npm's .cmd shims are parsed
// down to the .exe or node script they wrap, and shebang scripts become
// `node <script>`. An unknown shim is deliberately left unspawnable instead
// of crossing the repository's no-shell security boundary.

export interface ResolvedSpawn {
  command: string;
  args: string[];
}

/** Split a `cli` string into [command, ...fixedArgs] on unquoted whitespace —
 * a mini tokenizer, never a shell. Quotes group segments (paths with spaces,
 * fixed args with spaces); no escapes, no substitution, nothing evaluated. */
export function splitCliString(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cli.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** PATHEXT-aware `which`. A path-ish cli is probed where it points. A bare
 * name is looked up in `searchPath` first (the PATH of the environment the
 * process will run with: a driver may put its own engine's folder first, the
 * bundled Fuigo's), then in Murage's own augmented PATH. */
function whichWin(cli: string, searchPath?: string): string | null {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // an extensionless name is not runnable on Windows, so PATHEXT wins over
  // the bare file — npm installs both `claude` (a sh script) and `claude.cmd`
  const probe = (base: string) => {
    const order = extname(base) ? [base, ...exts.map((e) => base + e)] : [...exts.map((e) => base + e), base];
    return order.find(isFile) ?? null;
  };
  if (/[\\/]/.test(cli) || /^[a-zA-Z]:/.test(cli)) return probe(cli);
  const dirs = new Set([...(searchPath ?? "").split(delimiter), ...augmentedPath().split(delimiter)]);
  for (const dir of dirs) {
    if (!dir) continue;
    const hit = probe(join(dir, cli));
    if (hit) return hit;
  }
  return null;
}

/** Windows: the file a bare command name runs when `searchPath` is searched
 * first, then Murage's own PATH (whichWin), or null. A path-ish name is probed
 * where it points. What isolation-cache.ts engineLaunchFile hands spawnCli, so
 * the engine that runs is the one found on the PATH its version was probed on. */
export function windowsCommandFile(cli: string, searchPath?: string): string | null {
  return whichWin(cli, searchPath);
}

/** node.exe to run a script with: the one npm's shim would pick, else PATH,
 * else this executable only when it really is Node. In a packaged app,
 * process.execPath is Electron and must never be mistaken for node.exe. */
function nodeExe(near: string): string | null {
  const local = join(near, "node.exe");
  if (isFile(local)) return local;
  // Ask for the executable explicitly so a custom PATHEXT ordering cannot
  // make a stray node.cmd hide the real node.exe beside it.
  const onPath = whichWin("node.exe");
  if (onPath && extname(onPath).toLowerCase() === ".exe") return onPath;
  return (process.versions as Record<string, string | undefined>).electron ? null : process.execPath;
}

/** The shim-relative targets a .cmd shim names, in the order to try them.
 * npm/pnpm package shims spell each target as "%dp0%\..." (or "%~dp0\...").
 * npm's own npm.cmd / npx.cmd, installed beside node.exe, instead name their
 * entry in a variable next to a helper script that is not the CLI:
 * SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js". That assignment is
 * honoured only for the variable matching the shim's own name, so npx.cmd
 * never resolves to npm's CLI and no other shim is steered by one. The
 * launcher's switch to a globally upgraded npm is not followed: this node's
 * own npm runs. Pure text parsing — nothing in the shim is executed. */
export function cmdShimTargets(text: string, shimName: string): string[] {
  const name = (shimName.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(cmd|bat)$/, "");
  const entry =
    name === "npm" || name === "npx"
      ? new RegExp(`^[ \\t]*SET "${name.toUpperCase()}_CLI_JS=%~dp0\\\\([^"\\r\\n]+)"`, "im").exec(text)
      : null;
  const quoted = [...text.matchAll(/"%~?dp0%?\\?([^"]+)"/g)].map((m) => m[1]!);
  return [...(entry ? [entry[1]!] : []), ...quoted];
}

/** Whatever target of a .cmd shim exists on disk is what the shim runs. */
function parseCmdShim(shim: string): ResolvedSpawn | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shim);
  const targets = cmdShimTargets(text, shim)
    .map((target) => join(dir, target))
    .filter((p) => isFile(p) && basename(p).toLowerCase() !== "node.exe");
  // npm names a package's bin entry as the package spells it: a .js file, or an extensionless node script (fuigo's
  // `bin\fuigo`, `#!/usr/bin/env node`). Either is run as `node <script>`; an extensionless target is taken only when its
  // first line is a node shebang, so a POSIX sh script beside it is never handed to node.
  const script = targets.find((p) => /\.[cm]?js$/i.test(p) || (extname(p) === "" && hasNodeShebang(p)));
  if (script) {
    const node = nodeExe(dir);
    if (node) return { command: node, args: [script] };
  }
  const exe = targets.find((p) => extname(p).toLowerCase() === ".exe");
  return exe ? { command: exe, args: [] } : null;
}

/** The first line of `file` is a `#!... node` shebang. */
function hasNodeShebang(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return /^#!.*\bnode(\.exe)?\b/.test(buf.subarray(0, n).toString("utf8").split("\n", 1)[0]);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort descriptor cleanup */
      }
    }
  }
}

/** `#!/usr/bin/env node` → `node <script>`. Only node: nothing else has a
 * meaningful Windows equivalent worth guessing at. */
function parseNodeShebang(file: string): ResolvedSpawn | null {
  if (!hasNodeShebang(file)) return null;
  const node = nodeExe(dirname(file));
  return node ? { command: node, args: [file] } : null;
}

/**
 * How to actually spawn `cli` with `args` on this platform. Identity
 * everywhere but win32 — POSIX already resolves PATH and #! itself.
 */
/** Resolve a single command word (no tokenizer) — the platform spawn rules. */
function resolveWord(cli: string, args: string[], searchPath?: string): ResolvedSpawn {
  if (process.platform !== "win32") return { command: cli, args };
  const file = whichWin(cli, searchPath);
  // not found: hand back the name so spawn reports its own ENOENT
  if (!file) return { command: cli, args };
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const direct = parseCmdShim(file);
    return direct ? { command: direct.command, args: [...direct.args, ...args] } : { command: file, args };
  }
  if (ext === ".exe" || ext === ".com") return { command: file, args };
  const viaNode = parseNodeShebang(file);
  return viaNode ? { command: viaNode.command, args: [...viaNode.args, ...args] } : { command: file, args };
}

export function resolveCliSpawn(cli: string, args: string[], searchPath?: string): ResolvedSpawn {
  // An EXISTING FILE wins over the tokenizer: paths with spaces come from
  // our own candidate list unquoted ("/Applications/My Tools/claude"), and
  // splitting those would shred them. Only a bare word (no spaces) or an
  // explicitly-quoted/wrapper string reaches the split below.
  const trimmed = cli.trim();
  if (trimmed.includes(" ") && existsSync(trimmed)) return resolveWord(trimmed, args, searchPath);
  // A `cli` value may carry fixed leading arguments — wrapper scripts like
  // `/usr/local/bin/ag claude agp` are one string in the Engines panel. ONE
  // tokenizer pass, then resolve the head directly (never re-tokenized: a
  // quoted token may itself contain spaces, so feeding it back through the
  // splitter would shred it). Fixed args go BEFORE invocation args — a
  // wrapper's subcommand must lead (`ag claude agp --help`), or the wrapper
  // swallows the flag itself.
  const split = splitCliString(cli);
  if (split.length > 1 || split[0] !== trimmed) {
    const [head, ...fixed] = split;
    // empty input → hand the raw string to spawn so IT reports the ENOENT
    if (!head) return { command: cli, args };
    return resolveWord(head, [...fixed, ...args], searchPath);
  }
  return resolveWord(cli, args, searchPath);
}

// Bundled Fuigo engine ──────────────────────────────────────────────────
// Murage ships Ferrox Labs' own `fuigo` engine as a real native executable in
// Resources so a desktop install has a working engine with no Node, npm or
// npx on the machine. electron/harness-resources.mjs is the single place the
// electron-builder `to:` directory and this env variable are declared, and
// the packaged main process hands MURAGE_FUIGO_DIR to the server child.

/** Keep in step with FUIGO_EXECUTABLE_NAMES in electron/harness-resources.mjs,
 * which is what electron-builder's `to:` basenames are asserted against. */
function fuigoExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "fuigo.exe" : "fuigo";
}

/** Where the bundled engine would be, or null when nothing declared one.
 * Null is not "no engine" — it only means this process was not told about a
 * packaged Resources directory (an unpackaged dev run, or a build that never
 * staged it). resolveFuigoCli turns that into a named error. */
export function bundledFuigoPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const directory = env.MURAGE_FUIGO_DIR?.trim();
  if (!directory) return null;
  return join(directory, fuigoExecutableName(platform));
}

export interface ResolvedEngineBinary {
  /** Absolute path to spawn. */
  command: string;
  /** Which of the two candidates answered. */
  source: "path" | "bundled";
  reason?: "path-older-than-bundled" | "path-version-unreadable" | "bundled-version-unreadable";
}

const fuigoVersions = new Map<string, { size: number; mtimeMs: number; version: number[] | null }>();

function fuigoVersion(binary: string): number[] | null {
  const absolute = resolve(binary);
  try {
    const { size, mtimeMs } = statSync(absolute);
    const cached = fuigoVersions.get(absolute);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.version;
    // Only platform launch essentials, never provider credentials or app config.
    const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    // An engine probe (Rule 74c launch clause): posix, a session of its own, so neither the binary nor a descendant has
    // a controlling terminal; win32, a hidden console, never detached. stdin is a pipe closed at once.
    const result = spawnSync(absolute, ["--version"], {
      env, encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 16 * 1024, input: "", stdio: ["pipe", "pipe", "pipe"], ...(process.platform === "win32" ? {} : { detached: true }),
    });
    const match = !result.error && result.status === 0
      ? /\bfuigo\s+(\d+)\.(\d+)\.(\d+)\b/i.exec(`${result.stdout}\n${result.stderr}`)
      : null;
    const version = match ? match.slice(1).map(Number) : null;
    fuigoVersions.set(absolute, { size, mtimeMs, version });
    return version;
  } catch {
    return null;
  }
}

/**
 * The fuigo binary to spawn.
 *
 * Prefer PATH only when its readable version is at least the bundled version.
 * With an executable bundle, unreadable versions select the bundle. Without
 * an executable bundle, retain PATH behavior without probing its version.
 * Version probes are synchronous, time bounded, and cached by absolute path,
 * size and modification time. A skipped PATH copy carries a reason and is logged.
 *
 * FAILS LOUDLY. An unset MURAGE_FUIGO_DIR is the exact shape of the bug that
 * made MURAGE_SKILL_LIBRARY silently install zero skills through 0.1.44, so
 * there is no empty-string or cwd fallback here: every way this can fail
 * throws an error naming both places that were checked and which one broke.
 */
export function resolveFuigoCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedEngineBinary {
  const onPath = findCliCandidates(fuigoExecutableName(platform))[0];
  const bundled = bundledFuigoPath(env, platform);
  if (onPath) {
    try {
      if (!bundled || !statSync(bundled).isFile()) return { command: onPath, source: "path" };
      accessSync(bundled, constants.X_OK);
    } catch {
      return { command: onPath, source: "path" };
    }
    const pathVersion = fuigoVersion(onPath);
    const bundleVersion = fuigoVersion(bundled);
    const difference = pathVersion && bundleVersion
      ? pathVersion.map((part, i) => part - bundleVersion[i]!).find((part) => part !== 0) ?? 0
      : null;
    if (difference !== null && difference >= 0) return { command: onPath, source: "path" };
    const reason = !pathVersion ? "path-version-unreadable"
      : !bundleVersion ? "bundled-version-unreadable" : "path-older-than-bundled";
    console.info(`[fuigo] Skipping PATH binary ${JSON.stringify(onPath)}: ${reason}`);
    return { command: bundled, source: "bundled", reason };
  }
  if (!bundled) {
    throw new Error(
      "fuigo is unavailable: no fuigo on PATH, and MURAGE_FUIGO_DIR is not set so no bundled engine was " +
        "declared. In a packaged app this means the fuigo resource was not shipped (see extraResources in " +
        "electron-builder.yml); in development run `pnpm build:fuigo` and set MURAGE_FUIGO_DIR to " +
        "dist-native/fuigo/<platform>-<arch>.",
    );
  }
  if (!existsSync(bundled)) {
    throw new Error(`fuigo is unavailable: no fuigo on PATH, and the bundled engine is missing at ${bundled}`);
  }
  try {
    accessSync(bundled, constants.X_OK);
  } catch {
    throw new Error(
      `fuigo is unavailable: the bundled engine at ${bundled} is not executable; its executable bit did not ` +
        "survive packaging",
    );
  }
  return { command: bundled, source: "bundled" };
}

/** The command names each deletion engine runs as (what the process check, engine-closed.ts, looks for by name). */
const ENGINE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude"], codex: ["codex"], fuigo: ["fuigo"], grok: ["grok", "fuigo"], gemini: ["gemini"], qwen: ["qwen"], kimi: ["kimi"],
  hermes: ["hermes"], opencode: ["opencode"], droid: ["droid"], cursor: ["cursor-agent"], antigravity: ["agy"],
};

/** The real paths of the programs Murage runs for `engine`: each instance's configured CLI, every program of the engine's name on the
 * search path, and (for a Windows shim or a node script) the script it runs. The process check treats a process that IS one of these
 * as the engine however it was renamed or launched. Paths that cannot be resolved are left out. */
export function engineIdentities(engine: string, configured: readonly string[] = []): string[] {
  const out = new Set<string>();
  const add = (path: string | undefined): void => {
    if (!path) return;
    try { out.add(realpathSync.native(path)); } catch { /* not there */ }
  };
  const hits = new Set<string>();
  for (const cli of configured) {
    const head = splitCliString(cli)[0];
    if (head) for (const found of findCliCandidates(head)) hits.add(found);
  }
  for (const name of ENGINE_COMMANDS[engine] ?? []) for (const found of findCliCandidates(name)) hits.add(found);
  for (const hit of hits) {
    add(hit);
    const ext = extname(hit).toLowerCase();
    const shim = ext === ".cmd" || ext === ".bat" ? parseCmdShim(hit) : parseNodeShebang(hit);
    add(shim?.args[0]); // the script it runs, never the node that runs it
  }
  return [...out];
}
