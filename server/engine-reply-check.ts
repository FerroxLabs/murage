// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The set-up check (ENGINE-SIGNIN simple path, Install order 1). `authenticated` can be true while a turn fails, so one short
// real reply decides. It runs on a press only, on the same hidden session Learning uses: no bot, thread or message is touched,
// the prompt is fixed text, and it costs one small reply of the owner's plan. A second press while one runs joins it.
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { DATA_DIR } from "./config.ts";
import { requireWindowsAddon } from "./engine-exclusion.ts";
import { ENGINE_REPLY_PROMPT } from "./drivers/cli-memory-learning.ts";
import { CLAUDE_MANAGED_MCP_CONFLICT } from "./drivers/claude-guards.ts";

export type EngineReplyResult = "ready" | "signin" | "limit" | "refused";
export interface EngineReplyCheck { result: EngineReplyResult; line?: string }
export interface ReplyCheckEngine {
  instanceId: string; displayName?: string;
  checkReply?(signal: AbortSignal, cwd?: string): Promise<string>;
  generateText?(prompt: string, botId?: string, cwd?: string): Promise<string>;
}

const CHECK_TIMEOUT_MS = 90_000;
const LINE_LIMIT = 300;
const REFUSAL_CODES: ReadonlySet<unknown> = new Set(["update_required", CLAUDE_MANAGED_MCP_CONFLICT]);
const LIMIT_WORDS = /(?:usage|rate|quota|plan|message|credit|session)s?[ _-]?(?:limit|cap|exceeded|exhausted|reached)|\b429\b|too many requests|out of (?:credits|usage)|limit (?:reached|resets)|at (?:its|your) limit|hit (?:your|the)(?: \w+)? limit/i;
/** The words of a lost login. They outrank a status code: a revoked token can come back as a 403. */
const SIGNIN_WORDS = /\/login|not (?:logged|signed) in|(?:log|sign) ?in (?:required|again)|please (?:log|sign) ?in|\b401\b|unauthori[sz]ed|invalid.{0,20}(?:credential|api key)|(?:token|session|credentials?).{0,20}(?:expired|revoked|invalid)/i;
/** A 403 with no such words is a rule, not a login: the owner signing in again would change nothing. */
const POLICY_WORDS = /\b403\b|forbidden|\bpolicy\b|not (?:allowed|permitted)|disabled by|your organi[sz]ation/i;

/** The engine's words, one short line. Colour codes, control characters and secrets-shaped text do not reach the owner. */
export function engineLine(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)\S+/gi, "$1[hidden]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, LINE_LIMIT) : undefined;
}

/** What a failed reply means. A plan limit and a CLI or policy refusal keep the engine's own line; only a lost login is Sign in. */
export function replyCheckFailure(error: unknown, name: string): EngineReplyCheck {
  const failure = (error ?? {}) as { message?: unknown; engineLine?: unknown; code?: unknown; limit?: unknown; status?: unknown; signedOut?: unknown };
  const raw = typeof failure.engineLine === "string" ? failure.engineLine : typeof failure.message === "string" ? failure.message : "";
  const internal = /^MEMORY_(?:EXTRACTION|ENGINE)_/.test(raw);
  const line = internal ? undefined : engineLine(raw);
  if (REFUSAL_CODES.has(failure.code)) return { result: "refused", line: line ?? `${name} refused this request.` };
  if (failure.limit === true || failure.status === 429 || LIMIT_WORDS.test(raw)) return { result: "limit", line: line ?? `${name} is at its plan limit.` };
  if (failure.signedOut === true || SIGNIN_WORDS.test(raw)) return { result: "signin" };
  if (failure.status === 401 && !POLICY_WORDS.test(raw)) return { result: "signin" };
  if (raw === "MEMORY_EXTRACTION_TIMEOUT" || raw === "MEMORY_EXTRACTION_ABORTED") return { result: "refused", line: `${name} did not answer in time. Try again.` };
  return { result: "refused", line: line ?? `${name} did not answer. Try again.` };
}

// ---- The folder a set-up check runs in (ENGINE-CHECK-FOLDER-1018) ----
// The check touches no bot, and the bot-folder launch contract (botFolderOrThrow) gives no default folder. Its folder lies OUTSIDE the
// owner's home, so no ancestor of it holds owner data for any engine (no git root, AGENTS.md, GEMINI.md, opencode.json or CLAUDE.md of
// the owner's above it). Fixed system paths, never TMPDIR or TEMP (an environment value can point into home). One folder, reused and
// never deleted by Murage: checks run tools-off and write nothing, so emptiness is checked, not created, and no teardown can race a CLI
// that is still stopping.

/** The instruction files Claude Code reads from a folder and every ancestor. Claude's isolation switches them off for a check folder
 * (forward-slash spellings; the win32 settings add the backslash ones). */
export const ENGINE_CHECK_CLAUDE_MD_EXCLUDES: readonly string[] = ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/AGENTS.md", "**/.claude/rules/**"];

/** The answer when the folder cannot be proven private. Nothing is launched. */
export const ENGINE_CHECK_FOLDER_FAILURE = "Murage could not prepare a private folder for this check.";

export class EngineCheckFolderError extends Error {
  constructor() { super(ENGINE_CHECK_FOLDER_FAILURE); this.name = "EngineCheckFolderError"; }
}

export interface EngineCheckWindowsUser { name: string; sid: string }

/** What this process asks the operating system. An object so a test can replace one answer (vi.spyOn) without mocking a module. */
export const engineCheckHost = {
  uid: (): number | null => (typeof process.getuid === "function" ? process.getuid() : null),
  windowsUser: ((): (() => EngineCheckWindowsUser | null) => {
    let known: EngineCheckWindowsUser | null | undefined;
    return () => {
      if (known !== undefined) return known;
      try {
        const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
        const match = /^"([^"]+)","(S-1-[0-9-]+)"$/.exec(out.split(/\r?\n/)[0] ?? "");
        known = match ? { name: match[1], sid: match[2] } : null;
      } catch { known = null; }
      return known;
    };
  })(),
  /** icacls on Windows only: arguments in, output out. */
  icacls: (args: string[]): string => execFileSync("icacls", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }),
  /** The owner SID of a folder on Windows (null when it cannot be read). Read by the engine-exclusion addon (GetSecurityInfo on the folder itself, a link not followed); no program is started and no path travels in a command. */
  owner: (folder: string): string | null => {
    try {
      const out = requireWindowsAddon().fileOwnerSid?.(folder);
      return typeof out === "string" && /^S-1-\d+(?:-\d+)+$/.test(out) ? out : null;
    } catch { return null; }
  },
  /** The system folder the check base lives in. Always undefined here; a test answers with a temp dir (the platform default is used otherwise). */
  systemRoot: (): string | undefined => undefined,
};

/** What the folder checks need of a file system: this is the real one unless a test hands in another. */
export interface EngineCheckStat { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }
export interface EngineCheckFs {
  lstat(path: string): EngineCheckStat | null;
  mkdir(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
  readdir(path: string): string[];
  realpath(path: string): string;
}
const realFs: EngineCheckFs = {
  lstat: (path) => { try { return lstatSync(path); } catch { return null; } },
  mkdir: (path, mode) => { mkdirSync(path, { mode }); },
  chmod: (path, mode) => { chmodSync(path, mode); },
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync.native(path),
};

export interface EngineCheckFolderOptions {
  platform?: NodeJS.Platform;
  /** The system folder the check base lives in (default /tmp, /private/tmp on macOS, ProgramData on Windows). A test passes a temp dir. */
  root?: string;
  /** The user's id (a uid, or a Windows SID). Default: this process's. */
  user?: string | number;
  home?: string;
  dataDir?: string;
  /** Resolves links, for the predicate. Default: the real file system. */
  realpath?: (path: string) => string;
  /** The file system the folder is prepared on. Default: the real one; a test hands in a fake to run Windows preparation. */
  fs?: EngineCheckFs;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
const folded = (platform: NodeJS.Platform, path: string): string => (platform === "win32" ? path.toLowerCase() : path);

function currentUser(platform: NodeJS.Platform): string | number | null {
  if (platform === "win32") return engineCheckHost.windowsUser()?.sid ?? null;
  return engineCheckHost.uid();
}

/** The check base for one user: a fixed system path that never follows TMPDIR or TEMP. The folder checks run in is `run` inside it. */
export function engineCheckBasePath(platform: NodeJS.Platform, user: string | number, root?: string): string {
  if (platform === "win32") {
    const drive = /^[A-Za-z]:$/.test(process.env.SystemDrive ?? "") ? process.env.SystemDrive! : "C:";
    return win32.join(root ?? `${drive}\\ProgramData`, "Murage", "engine-check", String(user));
  }
  return posix.join(root ?? (platform === "darwin" ? "/private/tmp" : "/tmp"), `murage-engine-check-${user}`);
}

/** A path with links resolved; a folder not created yet resolves through its nearest existing parent. */
function realThrough(path: string, platform: NodeJS.Platform, realpath: (path: string) => string): string | null {
  const p = pathFor(platform);
  for (let at = path, rest = ""; ; ) {
    try { return p.join(realpath(at), rest); } catch { /* not there yet */ }
    const up = p.dirname(at);
    if (up === at) return null;
    rest = p.join(p.basename(at), rest);
    at = up;
  }
}

/** True when `path` is `parent` itself or lies inside it. */
function insideOrSame(platform: NodeJS.Platform, parent: string, path: string): boolean {
  const p = pathFor(platform);
  const rest = p.relative(folded(platform, parent), folded(platform, path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${p.sep}`) && !p.isAbsolute(rest));
}

/**
 * Whether a working folder is a set-up check folder: the `run` folder and anything below it (strict descendants of the check base), as
 * written and with links resolved. False for the base itself, a sibling prefix (`murage-engine-check-<uid>x`), a `..` escape and any other
 * folder. Any match counts (fails closed): the engines then switch off project instructions and config for it.
 */
export function isEngineCheckFolder(cwd: string, options: EngineCheckFolderOptions = {}): boolean {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) return false;
  const platform = options.platform ?? process.platform;
  const user = options.user ?? currentUser(platform);
  if (user === null || user === undefined) return false;
  const p = pathFor(platform);
  const realpath = options.realpath ?? ((path: string) => realpathSync.native(path));
  const base = engineCheckBasePath(platform, user, options.root ?? engineCheckHost.systemRoot());
  const bases = [p.resolve(base), realThrough(base, platform, realpath)].filter((path): path is string => path !== null);
  const folders = [p.resolve(cwd), realThrough(p.resolve(cwd), platform, realpath)].filter((path): path is string => path !== null);
  return bases.some((root) => folders.some((folder) => folded(platform, folder) !== folded(platform, root) && insideOrSame(platform, root, folder)));
}

/** The only rights that cannot change a folder: read, execute, synchronize and no access. Every other right is treated as write, and an unknown one
 * too (WA and WEA write attributes, DC delete child, DE delete, WDAC and WO, GA and GW generic ...): an ACL that cannot be proven read-only is refused. */
const ACL_READ_ONLY_RIGHTS = new Set(["N", "R", "RX", "RD", "REA", "RA", "X", "S", "RC", "GR", "GE", "GX"]);
/** Inheritance markers in an icacls entry: not rights. */
const ACL_INHERITANCE_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);

/** Names in an icacls listing of `folder` that are granted anything beyond read and are not in `allowed` (lower case names and SIDs). Empty: owner-only,
 * and only when `mustGrant` (the current user, by name and SID) has at least one granting entry: empty, unrecognized and null-DACL output is outside.
 * An entry this reader cannot parse counts as outside (fails closed). */
export function aclWritersOutside(listing: string, folder: string, allowed: readonly string[], mustGrant: readonly string[] = []): string[] {
  const outside: string[] = [];
  let granted = mustGrant.length === 0;
  for (const raw of listing.split(/\r?\n/)) {
    const line = (raw.toLowerCase().startsWith(folder.toLowerCase()) ? raw.slice(folder.length) : raw).trim();
    // a null DACL (icacls: "No permissions are set. All users have full control.") grants everyone everything
    if (/no permissions are set|all users have full control/i.test(line)) { outside.push("null DACL"); continue; }
    const entry = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (!entry) { if (line.includes(":(")) outside.push(`unreadable entry: ${line.slice(0, 80)}`); continue; }
    const rights = [...entry[2].matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(",")).map((right) => right.trim().toUpperCase()).filter((right) => !ACL_INHERITANCE_FLAGS.has(right));
    if (!rights.includes("DENY") && rights.some((right) => right !== "N") && mustGrant.includes(entry[1].trim().toLowerCase())) granted = true;
    if (rights.includes("DENY") || !rights.some((right) => !ACL_READ_ONLY_RIGHTS.has(right))) continue;
    const who = entry[1].trim().toLowerCase();
    if (!allowed.includes(who)) outside.push(entry[1].trim());
  }
  // positive evidence is required: empty or unrecognized output (no entry granting the current user access) is not private
  if (!granted) outside.push("no entry granting the current user access");
  return outside;
}

function fail(): never { throw new EngineCheckFolderError(); }

/**
 * The one folder set-up checks run in, validated before every check. Returns its canonical (realpath) path. Any failure throws
 * EngineCheckFolderError and the check launches nothing: it never falls back to a home folder.
 */
export function engineCheckFolder(options: EngineCheckFolderOptions = {}): string {
  try { return prepareEngineCheckFolder(options); } catch { throw new EngineCheckFolderError(); }
}

function prepareEngineCheckFolder(options: EngineCheckFolderOptions): string {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  const user = options.user ?? currentUser(platform);
  if (user === null || user === undefined || user === "") fail();
  const fs = options.fs ?? realFs;
  const base = engineCheckBasePath(platform, user, options.root ?? engineCheckHost.systemRoot());
  const run = p.join(base, "run");
  const windows = platform === "win32";
  const winUser = windows ? engineCheckHost.windowsUser() : null;
  if (windows && !winUser) fail();
  const aclUser = winUser ? [winUser.name.toLowerCase(), winUser.sid.toLowerCase()] : [];
  const aclAllowed = winUser ? [winUser.name.toLowerCase(), winUser.sid.toLowerCase(), "nt authority\\system", "s-1-5-18"] : [];

  /** One level, created if missing, and refused when it is a link (lstat never follows one; Node reports a Windows junction as a link). */
  const level = (dir: string, mode: "shared" | "private"): void => {
    let stat = fs.lstat(dir);
    if (!stat) {
      fs.mkdir(dir, 0o700);
      if (windows) {
        // the owner-only ACL goes on the user's own base; run inherits it
        if (dir === base) engineCheckHost.icacls([dir, "/inheritance:r", "/grant:r", `*${winUser!.sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
      } else if (mode === "private") fs.chmod(dir, 0o700);
      stat = fs.lstat(dir);
    }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (mode === "shared") return; // an intermediate level every user's base sits in: only its not being a link matters
    if (windows) {
      // owned by this user (never a folder someone else made), and nobody but this user and SYSTEM may write
      if (engineCheckHost.owner(dir)?.toLowerCase() !== winUser!.sid.toLowerCase()) fail();
      if (aclWritersOutside(engineCheckHost.icacls([dir]), dir, aclAllowed, aclUser).length) fail();
      return;
    }
    if (stat.uid !== Number(user)) fail();
    if (stat.mode & 0o022) fail(); // group- or world-writable
  };
  if (windows) {
    // ProgramData itself must exist; the Murage and engine-check levels under it are created here, so each is checked for a link
    const shared = p.dirname(p.dirname(base));
    const programData = p.dirname(shared);
    if (!fs.lstat(programData)?.isDirectory()) fail();
    level(shared, "shared");
    level(p.dirname(base), "shared");
  } else if (!fs.lstat(p.dirname(base))?.isDirectory()) fail();
  level(base, "private");
  level(run, "private");

  const realpath = options.realpath ?? ((path: string) => fs.realpath(path));
  const realBase = realpath(base);
  const realRun = realpath(run);
  // the canonical folder is the base's own `run`: no link anywhere on the way
  if (folded(platform, realRun) !== folded(platform, p.join(realBase, "run"))) fail();
  // NOT inside the owner's home or data folder, as written or with links resolved
  for (const owner of [options.home ?? homedir(), options.dataDir ?? DATA_DIR]) {
    if (!owner) fail();
    const roots = [p.resolve(owner), realThrough(p.resolve(owner), platform, realpath)].filter((path): path is string => path !== null);
    if (roots.some((root) => insideOrSame(platform, root, realRun) || insideOrSame(platform, root, p.resolve(run)))) fail();
  }
  // nothing else lives beside `run`, and `run` itself is EMPTY: checks write nothing
  const beside = fs.readdir(base);
  if (beside.length !== 1 || beside[0] !== "run") fail();
  if (fs.readdir(realRun).length !== 0) fail();
  return realRun;
}

const running = new Map<string, Promise<EngineReplyCheck>>();

async function reply(engine: ReplyCheckEngine, name: string, timeoutMs: number, folderFor: () => string): Promise<string> {
  // The folder is proven before anything launches; a refusal here throws EngineCheckFolderError and no engine is touched.
  const folder = folderFor();
  const signal = AbortSignal.timeout(timeoutMs);
  if (engine.checkReply) return engine.checkReply(signal, folder);
  const generateText = engine.generateText?.bind(engine);
  if (!generateText) throw new Error(`${name} has no quick check. Send it a message in a chat to try it.`);
  return Promise.race([generateText(ENGINE_REPLY_PROMPT, undefined, folder), new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("MEMORY_EXTRACTION_TIMEOUT")), { once: true });
  })]);
}

/** One short real reply through this engine. Never throws: every outcome is an answer for the card. `folderFor` is a test seam. */
export function checkEngineReply(engine: ReplyCheckEngine, timeoutMs = CHECK_TIMEOUT_MS, folderFor: () => string = engineCheckFolder): Promise<EngineReplyCheck> {
  const joined = running.get(engine.instanceId);
  if (joined) return joined;
  const name = engine.displayName || "This engine";
  const check = (async (): Promise<EngineReplyCheck> => {
    try {
      const text = await reply(engine, name, timeoutMs, folderFor);
      return text.trim() ? { result: "ready" } : { result: "refused", line: `${name} did not answer. Try again.` };
    } catch (error) {
      if (error instanceof EngineCheckFolderError) return { result: "refused", line: ENGINE_CHECK_FOLDER_FAILURE };
      return replyCheckFailure(error, name);
    }
  })().finally(() => { running.delete(engine.instanceId); });
  running.set(engine.instanceId, check);
  return check;
}
