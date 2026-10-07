// Child processes of a warm engine process. The engine starts its MCP servers
// once; anything that appears under it after the turn began (a dev server a
// Bash call left running) is background work that must not outlive the turn
// inside a process we keep warm, so the driver recycles the process instead.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platformListTree } from "../platform-process-hooks.ts";

/** One row of the Windows process table: pid, parent pid, creation time
 * (`start`: FILETIME ticks as text, the identity; `startMs`: epoch ms) and
 * working set in bytes (the warm pool's resident size). A value Windows does
 * not report (System, Idle) is null / "". */
export interface WindowsProcessRow { pid: number; ppid: number; startMs: number | null; start: string; rssBytes: number | null }

// Win32_Process via CIM: one "pid ppid filetime workingset" line per process
// ("-" for a value Windows withholds), then a
// sentinel so a truncated answer is a failed probe. CreationDate is local
// time; ToFileTimeUtc makes it absolute. No shell is involved: powershell.exe
// is run by absolute path with the script as -EncodedCommand.
const WIN_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rows = Get-CimInstance -ClassName Win32_Process | ForEach-Object { $c = $_.CreationDate; $t = if ($c) { $c.ToFileTimeUtc() } else { '-' }; $w = if ($null -ne $_.WorkingSetSize) { $_.WorkingSetSize } else { '-' }; \"$($_.ProcessId) $($_.ParentProcessId) $t $w\" }",
  "[Console]::Out.Write(($rows -join \"`n\") + \"`nEND`n\")",
].join("; ");
// Shorter than the Claude driver's 5 s baseline wait (claude.ts BASELINE_WAIT_MS),
// so a probe that finishes late is a failed probe here, never a result the
// consumer's race already gave up on.
const WIN_TIMEOUT_MS = 4_000;
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function powershellPath(): string {
  return join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Exported for tests: the argv of the Windows listing probe. */
export function windowsListingArgs(): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WIN_LIST_SCRIPT, "utf16le").toString("base64")];
}

/** Exported for tests: parse the Windows listing. Null unless the END
 * sentinel closes it and every line before it is a well-formed row with
 * nothing after it (a cut-off or damaged answer proves nothing). A parent link whose
 * parent started AFTER the child is dropped: Windows keeps a dead parent's
 * pid in ParentProcessId, and that pid may since belong to another process. */
export function parseWindowsListing(stdout: string): WindowsProcessRow[] | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const end = lines.indexOf("END");
  if (end < 0) return null;
  // Anything after the sentinel means the answer is not the one we asked for.
  if (lines.slice(end + 1).some((line) => line !== "")) return null;
  const rows: WindowsProcessRow[] = [];
  for (const line of lines.slice(0, end)) {
    if (line === "") continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+|-)\s+(\d+|-)$/.exec(line);
    // One malformed row could be a vanished child: reject the whole listing.
    if (!match) return null;
    const ticks = match[3] === "-" ? null : match[3]!;
    const startMs = ticks ? Math.floor(Number(ticks) / 10_000) - FILETIME_EPOCH_OFFSET_MS : null;
    const rssBytes = match[4] === "-" ? null : Number(match[4]);
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), startMs, start: ticks ?? "", rssBytes });
  }
  const startOf = new Map(rows.map((row) => [row.pid, row.startMs]));
  return rows.map((row) => {
    const parentStart = startOf.get(row.ppid);
    const stale = row.pid === row.ppid || (parentStart != null && row.startMs !== null && parentStart > row.startMs);
    return stale ? { ...row, ppid: 0 } : row;
  });
}

/** The Windows process table; null when the probe failed, timed out or its
 * answer was incomplete (callers then fail closed: never reuse). */
export function windowsListing(): Promise<WindowsProcessRow[] | null> {
  return new Promise((resolve) => {
    try {
      execFile(powershellPath(), windowsListingArgs(), { timeout: WIN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(parseWindowsListing(String(stdout ?? "")));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Windows baselines are pid + creation time: a pid alone is reused by the
 * OS. The identities ride alongside the Set the drivers hold. */
const winBaselineIds = new WeakMap<ReadonlySet<number>, Map<number, string>>();

/** The descendants of `root` among `kept`, registered with their creation
 * identity (looked up in the full `rows`). */
function winBaseline(rows: readonly WindowsProcessRow[], kept: readonly WindowsProcessRow[], root: number): Set<number> {
  const found = walk(winWalkLines(kept), root, null, null)?.found ?? new Set<number>();
  const starts = new Map(rows.map((row) => [row.pid, row.start]));
  winBaselineIds.set(found, new Map([...found].map((pid) => [pid, starts.get(pid) ?? ""])));
  return found;
}

const winWalkLines = (rows: readonly WindowsProcessRow[]) => rows.map((row) => `${row.pid} ${row.ppid}`).join("\n");

/** Every descendant pid of `root`, or null where the probe failed (on Windows
 * the table comes from Win32_Process, see windowsListing). Callers treat null as "no extra evidence". */
export function descendantPids(root: number): Promise<Set<number> | null> {
  return processTreeWalk(root, null);
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,comm="];
const PS_ETIME_ARGS = ["-A", "-o", "pid=,ppid=,etime=,comm="];

/** Seconds in a `ps` etime field, `[[dd-]hh:]mm:ss`; null when malformed. */
export function parseEtime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** Whether a process `elapsedSec` old at `probeAtMs` started strictly before
 * the second of `initAtMs`. etime has 1 s resolution, so the comparison is in
 * whole seconds. A process whose estimated start shares init's second is left
 * out (the turn then recycles, never the reverse). probeAtMs is taken AFTER ps
 * answered, so estimated starts can only come out later than the truth. */
function startedBeforeInit(elapsedSec: number, probeAtMs: number, initAtMs: number): boolean {
  return Math.floor((probeAtMs - elapsedSec * 1000) / 1000) < Math.floor(initAtMs / 1000);
}

/** Descendants of `root` that had started by `initAtMs`, from a
 * `ps -o pid=,ppid=,etime=,comm=` listing taken at `probeAtMs`. A process's
 * start time is probeAtMs minus its etime; one that started after init is
 * never part of the baseline, however late the probe ran. That holds: a tool
 * cannot start within a second of init (it needs a model round trip first),
 * and MCP servers start before init. Lines that do not parse are dropped. */
export function baselineFromListing(stdout: string, root: number, probeAtMs: number, initAtMs: number): Set<number> {
  const kept: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const elapsed = parseEtime(match[3]!);
    if (elapsed === null) continue;
    if (!startedBeforeInit(elapsed, probeAtMs, initAtMs)) continue;
    kept.push(`${match[1]} ${match[2]} ${match[4] ?? ""}`);
  }
  return walk(kept.join("\n"), root, null, null)?.found ?? new Set();
}

/** How a `ps` run ended. Exit status 1 alone is how ps reports that some of
 * the pids it was asked about are gone (or that one is out of range); callers
 * treat a pid missing from the answer as unconfirmed. Anything else (a timeout, a kill, any
 * other status, an overflowing buffer) is a failed probe, whatever it printed
 * first: its output is incomplete and proves nothing about what is missing. */
export function psOutcome(error: unknown): "complete" | "some-missing" | "failed" {
  if (!error) return "complete";
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
  if (failure.killed || failure.signal || failure.code !== 1) return "failed";
  return "some-missing";
}

/** True only when the OS says the pid does not exist (ESRCH). */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Pids from `listing` that had started strictly before init, judged from a
 * `ps -o pid=,etime=` listing taken at `probeAtMs`. A pid the listing does not
 * cover (gone, or unreadable) is never baseline. */
export function startedBeforeFromListing(stdout: string, pids: ReadonlySet<number>, probeAtMs: number, initAtMs: number): Set<number> {
  const out = new Set<number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const elapsed = parseEtime(match[2]!);
    if (!pids.has(pid) || elapsed === null) continue;
    if (startedBeforeInit(elapsed, probeAtMs, initAtMs)) out.add(pid);
  }
  return out;
}

/** The descendants the engine started on its own, taken ASYNCHRONOUSLY (the
 * event loop is never blocked) once the CLI's `init` message is handled.
 * `initAtMs` is recorded synchronously at that moment. Null when the platform
 * gives no answer or the probe failed or timed out (5 s). */
export async function descendantBaseline(root: number, initAtMs: number): Promise<Set<number> | null> {
  // A platform listTree hook replaces the walk. Its answer can arrive after a
  // tool started a process, so each pid's start time is read here and the
  // same rule applies: started after init means not baseline. A pid whose
  // start cannot be read is left out; a probe that fails makes it unknown.
  const platform = await platformListTree(root);
  if (platform !== undefined) {
    if (!platform) return null;
    if (!platform.size) return new Set();
    if (process.platform === "win32") return null;
    return new Promise((resolve) => {
      execFile("ps", ["-o", "pid=,etime=", "-p", [...platform].join(",")], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (psOutcome(error) === "failed") return resolve(null);
        resolve(startedBeforeFromListing(String(stdout), platform, Date.now(), initAtMs));
      });
    });
  }
  if (process.platform === "win32") {
    const rows = await windowsListing();
    if (!rows) return null;
    // Creation times are exact to the tick, so a process counts as baseline
    // when it started before init, sub-second included. Unknown start: left out.
    const kept = rows.filter((row) => row.startMs !== null && row.startMs < initAtMs);
    return winBaseline(rows, kept, root);
  }
  return new Promise((resolve) => {
    // SIGKILL on timeout: a ps that ignores SIGTERM must not outlive the wait.
    execFile("ps", PS_ETIME_ARGS, { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      // The listing's ages were read while ps ran; "now" is after that, so
      // start = now - age can only be late. Late is the right direction: a
      // process that started after init can never be counted as baseline.
      resolve(baselineFromListing(stdout, root, Date.now(), initAtMs));
    });
  });
}

/** Process identities: pid to the start time ps reports for it (`lstart`,
 * C locale, whitespace collapsed). A pid alone is not an identity: once a
 * process exits the OS can hand its pid to an unrelated one. */
export type ProcessIdentities = Map<number, string>;

// lstart is five fields in the C locale ("Wed Oct  7 10:00:00 2026"), so it
// goes before comm/args, which may hold spaces.
const LSTART = String.raw`(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)`;
const PS_ID_ARGS = ["-A", "-o", "pid=,ppid=,lstart=,comm="];
const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const normStart = (text: string) => text.trim().replace(/\s+/g, " ");

/** Exported for tests: parse `ps -o pid=,ppid=,lstart=,<comm|args>=` lines. */
export function parseIdentityListing(stdout: string): Array<{ pid: number; ppid: number; start: string; rest: string }> {
  const out: Array<{ pid: number; ppid: number; start: string; rest: string }> = [];
  const pattern = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+${LSTART}(?:\s(.*))?$`);
  for (const line of stdout.split("\n")) {
    const match = pattern.exec(line);
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), start: normStart(match[3]!), rest: (match[4] ?? "").trim() });
  }
  return out;
}

/** Start identities of a few pids (`ps -o pid=,lstart= -p`). A pid missing
 * from the answer is absent from the map (not confirmed); null when the
 * probe failed. */
function processStarts(pids: Iterable<number>): Promise<ProcessIdentities | null> {
  const list = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!list.length) return Promise.resolve(new Map());
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pid=,lstart=", "-p", list.join(",")], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: PS_ENV }, (error, stdout) => {
      if (psOutcome(error) === "failed") return resolve(null);
      const out: ProcessIdentities = new Map();
      const pattern = new RegExp(String.raw`^\s*(\d+)\s+${LSTART}\s*$`);
      for (const line of String(stdout).split("\n")) {
        const match = pattern.exec(line);
        if (match) out.set(Number(match[1]), normStart(match[2]!));
      }
      resolve(out);
    });
  });
}

/** The process-table listing with start identities; null when it failed. */
async function identityListing(): Promise<ReturnType<typeof parseIdentityListing> | null> {
  if (process.platform === "win32") {
    const rows = await windowsListing();
    return rows ? rows.map((row) => ({ pid: row.pid, ppid: row.ppid, start: row.start, rest: "" })) : null;
  }
  return new Promise((resolve) => {
    execFile("ps", PS_ID_ARGS, { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: PS_ENV }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(parseIdentityListing(String(stdout)));
    });
  });
}

/** Every descendant of `root` with its start identity, or null when the
 * platform gives no answer or the probe failed. Under a platform listTree
 * hook a pid whose start cannot be read is left out, so a later check
 * reports it (never the reverse). */
export async function descendantIdentities(root: number): Promise<ProcessIdentities | null> {
  const platform = await platformListTree(root);
  if (platform !== undefined) {
    if (!platform) return null;
    return processStarts(platform);
  }
  const rows = await identityListing();
  if (!rows) return null;
  const found = walk(rows.map((row) => `${row.pid} ${row.ppid} ${row.rest}`).join("\n"), root, null, null)?.found;
  if (!found) return null;
  const starts = new Map(rows.map((row) => [row.pid, row.start]));
  return new Map([...found].map((pid) => [pid, starts.get(pid)!]));
}

/** Descendants of `root` measured against an identity baseline, from ONE
 * listing. A baseline entry is exempt only when its pid AND start time match
 * a live process in this listing (a recycled pid is new work). `fresh` holds
 * every descendant that is not exempt, with its start identity ("" when it
 * could not be read); `alive` holds the baseline entries this listing
 * confirmed, the only ones a later baseline may keep. Null when the platform
 * gives no answer or the probe failed. */
export async function untrackedIdentified(
  root: number,
  baseline: ReadonlyMap<number, string>,
  options: UntrackedOptions = {},
): Promise<{ fresh: ProcessIdentities; alive: ProcessIdentities } | null> {
  const platform = await platformListTree(root);
  if (platform !== undefined) {
    // No parentage from the platform: nothing below a baseline process is
    // exempt, every pid outside the confirmed baseline is reported.
    if (!platform) return null;
    const starts = await processStarts(platform);
    if (!starts) return null;
    const fresh: ProcessIdentities = new Map(), alive: ProcessIdentities = new Map();
    for (const pid of platform) {
      const start = starts.get(pid);
      if (start !== undefined && start !== "" && baseline.get(pid) === start) alive.set(pid, start);
      else fresh.set(pid, start ?? "");
    }
    return { fresh, alive };
  }
  const rows = await identityListing();
  if (!rows) return null;
  const starts = new Map(rows.map((row) => [row.pid, row.start]));
  // An unreadable start is no identity: "" never matches, so a recycled pid
  // whose creation time could not be read is new work, never exempt.
  const confirmed = new Set(rows.filter((row) => row.start !== "" && baseline.get(row.pid) === row.start).map((row) => row.pid));
  const result = walk(rows.map((row) => `${row.pid} ${row.ppid} ${row.rest}`).join("\n"), root, confirmed, options.layout);
  if (!result) return null;
  return {
    fresh: new Map([...result.found].map((pid) => [pid, starts.get(pid) ?? ""])),
    alive: new Map([...result.exempt].map((pid) => [pid, starts.get(pid)!])),
  };
}

/** Where exempt executables may live. Injectable so tests can use scratch
 * directories; the defaults describe a real macOS install. */
export interface ExemptLayout {
  /** the folder browsers install into (default `/Applications`) */
  applications: string;
  /** the home directory holding the Playwright and puppeteer caches */
  home: string;
  /** the running Murage app bundle, or null when not running from one */
  murageBundle: string | null;
  /** resolves symlinks (default `fs.realpathSync`); a throw means not exempt */
  realpath?: (path: string) => string;
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (path: string) => path.replace(/\/+$/, "");

/** The bundle of the running app: the real path of `process.execPath` up to
 * its `.app` folder, or null (tests, dev) so that no Murage helper is exempt. */
function runningAppBundle(): string | null {
  try {
    const real = realpathSync(process.execPath);
    const at = real.indexOf(".app/");
    return at < 0 ? null : real.slice(0, at + 4);
  } catch {
    return null;
  }
}

function defaultLayout(): ExemptLayout | null {
  if (process.platform !== "darwin") return null;
  return { applications: "/Applications", home: homedir(), murageBundle: runningAppBundle() };
}

const HELPER_VARIANT = String.raw`(?<v> \((?:Renderer|GPU|Plugin|Alerts)\))?`;

/** Exact in-bundle executables of one Chromium-family app: the main binary and
 * the bundle's own Helper executables. `bundle` is a regex source for the
 * `<name>.app` folder; `name` is literal. */
function chromiumBundle(bundle: string, name: string): string[] {
  const n = esc(name);
  return [
    `${bundle}/Contents/MacOS/${n}`,
    `${bundle}/Contents/Frameworks/${n} Framework\\.framework/Versions/[0-9][0-9.]*/Helpers/${n} Helper${HELPER_VARIANT}\\.app/Contents/MacOS/${n} Helper\\k<v>`,
  ];
}

function firefoxBundle(bundle: string, main: string): string[] {
  return [
    `${bundle}/Contents/MacOS/${main}`,
    `${bundle}/Contents/MacOS/plugin-container`,
    `${bundle}/Contents/MacOS/plugin-container\\.app/Contents/MacOS/plugin-container`,
  ];
}

/** Anchored, whole-path executable patterns for a layout. Nothing is matched
 * by prefix: a path under an install root that is not one of these exact
 * in-bundle executables is not exempt. */
export function exemptPatterns(layout: ExemptLayout): RegExp[] {
  const apps = esc(trimSlash(layout.applications));
  const home = esc(trimSlash(layout.home));
  const out: string[] = [];
  for (const name of ["Google Chrome", "Google Chrome for Testing", "Chromium", "Microsoft Edge"]) {
    out.push(...chromiumBundle(`${apps}/${esc(name)}\\.app`, name));
  }
  out.push(...firefoxBundle(`${apps}/Firefox\\.app`, "firefox"));
  // Playwright's cache
  const pw = `${home}/Library/Caches/ms-playwright`;
  // Older Playwright ships Chromium.app; current Playwright (1.57+) ships
  // Chrome for Testing in the same chromium-<rev> folder, and the headless
  // shell under chrome-headless-shell-mac-<arch>.
  out.push(...chromiumBundle(`${pw}/chromium-[0-9]+/chrome-mac(?:-(?:arm64|x64))?/Chromium\\.app`, "Chromium"));
  out.push(...chromiumBundle(`${pw}/chromium-[0-9]+/chrome-mac(?:-(?:arm64|x64))?/Google Chrome for Testing\\.app`, "Google Chrome for Testing"));
  out.push(`${pw}/chromium_headless_shell-[0-9]+/(?:chrome-mac(?:-(?:arm64|x64))?|chrome-headless-shell-mac-(?:arm64|x64))/chrome-headless-shell`);
  out.push(...firefoxBundle(`${pw}/firefox-[0-9]+/firefox/Nightly\\.app`, "firefox"));
  // puppeteer and chrome-devtools-mcp: Chrome for Testing layouts only
  for (const cache of [`${home}/\\.cache/puppeteer`, `${home}/\\.cache/chrome-devtools-mcp`]) {
    out.push(...chromiumBundle(`${cache}/chrome/[^/]+/chrome-mac(?:-(?:arm64|x64))?/Google Chrome for Testing\\.app`, "Google Chrome for Testing"));
    out.push(`${cache}/chrome-headless-shell/[^/]+/chrome-headless-shell-mac-(?:arm64|x64)/chrome-headless-shell`);
  }
  // Murage's own helpers: only inside the RUNNING bundle
  if (layout.murageBundle) {
    const bundle = esc(trimSlash(layout.murageBundle));
    out.push(`${bundle}/Contents/Frameworks/Murage Helper\\.app/Contents/MacOS/Murage Helper`);
    out.push(`${bundle}/Contents/Frameworks/Murage Helper \\((?<w>Renderer|GPU|Plugin)\\)\\.app/Contents/MacOS/Murage Helper \\(\\k<w>\\)`);
  }
  return out.map((source) => new RegExp(`^${source}$`));
}

/** True when the executable is one of the exact exempt executables of the
 * layout (default: macOS install locations and the running Murage bundle;
 * nothing on other platforms). The path is resolved with realpath first, so a
 * symlink cannot borrow an exempt name; where that fails it is not exempt.
 * Relative paths and `..` segments never match. */
export function isBrowserPath(comm: string, layout?: ExemptLayout | null, patterns?: RegExp[]): boolean {
  const path = comm.trim();
  if (!path.startsWith("/") || path.split("/").includes("..")) return false;
  const active = layout === undefined ? defaultLayout() : layout;
  if (!active) return false;
  let real: string;
  try {
    real = (active.realpath ?? realpathSync)(path);
  } catch {
    return false;
  }
  return (patterns ?? exemptPatterns(active)).some((pattern) => pattern.test(real));
}

export interface UntrackedOptions {
  /** Replaces the default exempt layout (tests). Honored on every platform. */
  layout?: ExemptLayout;
}

/** Descendants of `root` that are not this turn's leftover work. A process
 * present at `baseline` (an MCP server the CLI started) is not reported, and
 * neither is a BROWSER below it: a process whose executable path, and that of
 * every process between it and the baseline ancestor, is inside a known
 * browser install. Any other new process below a baseline process (a worker a
 * shell-capable MCP left running, or one merely named "chrome") is reported
 * like the CLI's own new children, with everything under it. Null where the
 * platform gives no answer or the probe failed. */
export function untrackedDescendants(root: number, baseline: ReadonlySet<number>, options: UntrackedOptions = {}): Promise<Set<number> | null> {
  return processTreeWalk(root, baseline, options.layout);
}

async function processTreeWalk(root: number, stopAt: ReadonlySet<number> | null, layout?: ExemptLayout): Promise<Set<number> | null> {
  // A platform listTree hook (Murage Cloud) replaces the process-table walk.
  // It gives no parentage, so nothing below a baseline process is exempt:
  // every pid outside the baseline is reported (stricter, never looser).
  const platform = await platformListTree(root);
  if (platform !== undefined) {
    if (!platform) return null;
    return new Set([...platform].filter((pid) => !stopAt?.has(pid)));
  }
  if (process.platform === "win32") {
    const rows = await windowsListing();
    if (!rows) return null;
    if (!stopAt) return winBaseline(rows, rows, root);
    // Exempt only a baseline entry whose pid AND creation time match a live
    // process; a baseline set with no recorded identities exempts nothing.
    const ids = winBaselineIds.get(stopAt);
    const exact = new Set(rows.filter((row) => row.start !== "" && ids?.get(row.pid) === row.start).map((row) => row.pid));
    return walk(winWalkLines(rows), root, exact, layout)?.found ?? null;
  }
  return new Promise((resolve) => {
    execFile("ps", PS_ARGS, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(walk(stdout, root, stopAt, layout)?.found ?? null);
    });
  });
}

/** Exported for tests: the walk over a given `ps -o pid=,ppid=,comm=` listing. */
export function walk(stdout: string, root: number, stopAt: ReadonlySet<number> | null, layout?: ExemptLayout | null): { found: Set<number>; exempt: Set<number> } | null {
  const active = layout === undefined ? defaultLayout() : layout;
  const patterns = active ? exemptPatterns(active) : [];
  const children = new Map<number, number[]>();
  const comms = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    comms.set(pid, match[3] ?? "");
    (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
  }
  const isBrowser = (pid: number) => active !== null && isBrowserPath(comms.get(pid) ?? "", active, patterns);
  const found = new Set<number>();
  // baseline processes reached in this listing (live descendants of root)
  const exempt = new Set<number>();
  const seen = new Set<number>();
  // "owned": below a baseline process; "browser": inside an exempt browser
  // chain; "free": ordinary new work. Only owned and browser nodes may pass a
  // child on as exempt, and only when that child is itself a browser path.
  const queue: Array<{ pid: number; mode: "free" | "owned" | "browser" }> = [{ pid: root, mode: "free" }];
  while (queue.length) {
    const { pid: parent, mode } = queue.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (stopAt?.has(child)) {
        exempt.add(child);
        queue.push({ pid: child, mode: "owned" });
        continue;
      }
      if (mode !== "free" && isBrowser(child)) {
        queue.push({ pid: child, mode: "browser" });
        continue;
      }
      found.add(child);
      queue.push({ pid: child, mode: "free" });
    }
  }
  return { found, exempt };
}

/** Parent pid, start identity and full argument line
 * (`ps -ww -o pid=,ppid=,lstart=,args=`) of a few pids. A pid is missing from
 * the map only when it has exited (the OS confirms it is gone); null when the
 * platform gives no answer or the probe failed, timed out or was killed, or a
 * pid missing from the answer is still there. Unknown never reads as exited. */
export function processParentsAndArgs(pids: Iterable<number>): Promise<Map<number, ProcessArgs> | null> {
  const list = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (!list.length) return Promise.resolve(new Map());
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-ww", "-o", "pid=,ppid=,lstart=,args=", "-p", list.join(",")], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, env: PS_ENV }, (error, stdout) => {
      resolve(settleArgsProbe(error, String(stdout ?? ""), list));
    });
  });
}

export interface ProcessArgs { ppid: number; start: string; args: string }

/** Exported for tests: the answer of an argv probe for `pids`. A failed probe
 * is unknown (null) whatever it printed. Otherwise each pid missing from the
 * answer must be confirmed gone by the OS, or the whole answer is unknown
 * (macOS ps exits 0 when some asked pids are gone, so the status alone never
 * proves it). */
export function settleArgsProbe(error: unknown, stdout: string, pids: readonly number[], gone: (pid: number) => boolean = pidGone): Map<number, ProcessArgs> | null {
  const outcome = psOutcome(error);
  if (outcome === "failed") return null;
  const out = parseParentsAndArgs(stdout);
  for (const pid of pids) {
    if (out.has(pid)) continue;
    if (!gone(pid)) return null;
  }
  return out;
}

/** Exported for tests: parse `ps -o pid=,ppid=,lstart=,args=` lines. */
export function parseParentsAndArgs(stdout: string): Map<number, ProcessArgs> {
  const out = new Map<number, ProcessArgs>();
  for (const row of parseIdentityListing(stdout)) out.set(row.pid, { ppid: row.ppid, start: row.start, args: row.rest });
  return out;
}

/** Program names (basename of the executable) for a few pids, for a log
 * line only: never paths, arguments or environment. Missing pids are skipped. */
export function processNames(pids: Iterable<number>): Promise<string[]> {
  const list = [...pids].filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 8);
  if (!list.length || process.platform === "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "comm=", "-p", list.join(",")], { timeout: 2_000, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error && !stdout) return resolve([]);
      resolve(String(stdout).split("\n").map((line) => line.trim().split("/").pop() ?? "").filter(Boolean));
    });
  });
}

