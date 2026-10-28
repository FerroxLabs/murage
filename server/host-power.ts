// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S4 power (docs/designs/S4-POWER-STRUCTURAL-108.md, revision 4.1): the one block each desktop system applies to an engine spawn
// that section 2 wraps. Linux: the shipped bwrap with a user and pid namespace, the bus sockets covered by a stub that closes every
// connection, a fresh minimal /dev and the small power seccomp filter (section 4). macOS: `/usr/bin/sandbox-exec -p` with a fixed
// default-allow profile (section 5). Windows is the privilege removal on the server's own token (procs.ts, section 6), not here.
// This module plans the launch; procs.ts spawnCli runs it. It imports nothing of procs.ts.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_ROOT } from "./proxy-paths.ts";

/** The code on the pid-less child a refused wrapped launch returns (section 2). Not ECONTAIN, which stays the Windows job failure. */
export const HOST_POWER_CODE = "EPOWER";
/** Section 8 on Linux and macOS: Claude, Codex and Fuigo are not wrapped there (section 2), so switching to one of them is a next
 *  step that holds for every refusal cause (the cage not starting, a hash mismatch, an architecture with no filter pin). */
export const HOST_POWER_MESSAGE_LINUX_MAC = "Murage could not block shut down and restart for this engine, so this turn was not started. You can choose Claude, Codex or Fuigo as this bot's engine now, or update or reinstall Murage and try again.";
/** Section 8 on Windows: every engine is under the block there (section 6), so the next step is the addon that a current install
 *  brings back. */
export const HOST_POWER_MESSAGE_WINDOWS = "Murage could not block shut down and restart for this engine, so this turn was not started. Update or reinstall Murage, then try again.";
/** Linux: the stub socket could not be placed because every temp folder path is too long for a socket; the next step is a
 *  shorter TMPDIR, not another engine. */
export const HOST_POWER_MESSAGE_LONG_TMPDIR = "Murage could not block shut down and restart for this engine because its temp folder path is too long, so this turn was not started. Set TMPDIR to a shorter folder, such as /tmp, then restart Murage.";
/** Section 8: the owner-facing message for a wrapped turn that was not started because the block could not be applied. */
export const HOST_POWER_MESSAGE = process.platform === "win32" ? HOST_POWER_MESSAGE_WINDOWS : HOST_POWER_MESSAGE_LINUX_MAC;

/** Section 5: the profile text, fixed in the server. No path and no turn string. */
export const SEATBELT_POWER_PROFILE = `(version 1)
(allow default)
(deny mach-lookup
  (global-name "com.apple.logind")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.iokit.powerdxpc"))
(deny iokit-open-service
  (iokit-registry-entry-class "IOPMrootDomain"))
(deny iokit-open-user-client
  (iokit-user-client-class "RootDomainUserClient"))
(deny appleevent-send
  (appleevent-destination "com.apple.loginwindow")
  (appleevent-destination "com.apple.systemevents")
  (appleevent-destination "com.apple.finder"))
`;

/** Section 4: the bwrap process's own environment. The turn's reaches the engine through --clearenv and --setenv, which bwrap reads
 *  from its --args pipe (BWRAP_ARGS_FD), never from its argv: /proc/<pid>/cmdline is readable by every local user for the life of
 *  the turn, and the turn environment carries keys. */
export const BWRAP_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin" });
/** Section 4: bwrap arguments (argv and the --args pipe together) over this many bytes are refused (no fallback lets the turn
 *  environment reach bwrap another way). */
export const BWRAP_ARGV_LIMIT_BYTES = 1024 * 1024;
/** bwrap 0.13.1 refuses more than 9000 arguments (MAX_ARGS, argv and --args counted together); a plan over it is refused here. */
export const BWRAP_MAX_ARGS = 9000;
/** The sha256 of the shipped murage-power.bpf per Node architecture, the pin in native/power-seccomp/POWER-BPF-HASHES.txt that
 *  scripts/build-murage-cage.mjs enforces. Linux x64 and arm64 are pinned; an architecture with no pin is refused. */
export const POWER_FILTER_SHA256: Readonly<Record<string, string>> = Object.freeze({
  x64: "72cf57db4cd8ff5ec32f5a477be727ac0cfa29d8a9b240515dc4fb2504aed4a6",
  arm64: "ed3bd9b4e5761211665c25c00153aaf1de2c21851a414c5e76ef689c7eb06c3a",
});
/** Section 4: the system bus paths the stub covers when they exist (the per-user ones are added from XDG_RUNTIME_DIR). */
export const SYSTEM_BUS_PATHS = ["/run/dbus/system_bus_socket", "/var/run/dbus/system_bus_socket", "/run/systemd/private"] as const;

/** The test override is for tests only: not in a packaged app, never outside a test process (the engine-exclusion rule). */
function testProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" && !env.MURAGE_PACKAGED && !env.MURAGE_RESOURCES_PATH && !env.OMB_RESOURCES_PATH;
}
/** server/testing/setup.ts sets this so the existing suite's fake engines keep running as before; the host-power tests clear it.
 *  It is a value in the test process's memory, not an environment variable, and is ignored outside a test process. */
export const HOST_POWER_TEST_UNWRAPPED = Symbol.for("murage.hostPower.testUnwrapped");

/** The seams the host-power tests replace. Production reads the real process and file system. */
export const hostPowerDeps = {
  platform: (): NodeJS.Platform => process.platform,
  arch: (): string => process.arch,
  geteuid: (): number => (typeof process.geteuid === "function" ? process.geteuid() : -1),
  getegid: (): number => (typeof process.getegid === "function" ? process.getegid() : -1),
  /** Whether this user can write the file: access(W_OK), so a read-only mount (an AppImage) and a root-owned install both read as
   *  not writable. The desktop server's real and effective ids are the same. */
  writable: (file: string): boolean => { try { accessSync(file, fsConstants.W_OK); return true; } catch { return false; } },
  /** A server running as root can write every file, so access(W_OK) says nothing there: the helper must be root's own and not
   *  writable by its group or anyone else. */
  othersMayWrite: (file: string): boolean => { try { const info = lstatSync(file); return info.uid !== 0 || (info.mode & 0o022) !== 0; } catch { return true; } },
  /** The folder that holds the shipped bwrap and murage-power.bpf, or null when this build has none. */
  helperDir: (): string | null => defaultHelperDir(),
  sandboxExec: "/usr/bin/sandbox-exec",
  /** The stub socket's path once it is bound (startHostPowerStub), else null. */
  stubSocket: (): string | null => stub.path,
  /** The temp folder the stub's own folder is made in (os.tmpdir(), which follows $TMPDIR). */
  tmpdir: (): string => tmpdir(),
  /** The per-user runtime folder, when the session has one. */
  runtimeDir: (): string | undefined => process.env.XDG_RUNTIME_DIR || undefined,
  /** The last place the stub's folder may go. */
  fallbackTmp: (): string => "/tmp",
  /** The pinned murage-power.bpf sha256 for this architecture, or null when it has none. */
  powerFilterSha256: (arch: string): string | null => POWER_FILTER_SHA256[arch] ?? null,
};

function defaultHelperDir(): string | null {
  const resources = process.env.MURAGE_RESOURCES_PATH ?? process.env.OMB_RESOURCES_PATH;
  const root = typeof SERVER_ROOT === "string" ? SERVER_ROOT : null;
  const candidates = [
    ...(resources ? [join(resources, "cage")] : []),
    ...(root ? [join(root, "..", "cage"), join(root, "..", "dist-native", "cage", `linux-${hostPowerDeps.arch()}`)] : []),
  ];
  return candidates.find((dir) => existsSync(join(dir, "bwrap"))) ?? null;
}

/** True when this test process asked for the existing suite's unwrapped launches (never in a packaged app). */
export function hostPowerTestUnwrapped(): boolean {
  return testProcess() && (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] === true;
}

/** Whether spawnCli applies the desktop block to a spawn that carries `hostPower: true` on this system. */
export function hostPowerPlatform(): "linux" | "darwin" | null {
  const platform = hostPowerDeps.platform();
  return platform === "linux" || platform === "darwin" ? platform : null;
}

// ── The stub socket (section 4) ─────────────────────────────────────────────

const stub: { path: string | null; dir: string | null; server: Server | null; starting: Promise<string | null> | null; problem: string | null } = { path: null, dir: null, server: null, starting: null, problem: null };

const TMPDIR_TOO_LONG = "its temp folder path is too long for a socket; set TMPDIR to a shorter folder (such as /tmp) and restart Murage";
/** The owner-facing sentence for a refusal caused by the stub, when that cause has a next step of its own. */
export function hostPowerStubMessage(): string | null {
  return stub.problem === TMPDIR_TOO_LONG ? HOST_POWER_MESSAGE_LONG_TMPDIR : null;
}
/** A unix socket path holds at most 108 bytes on Linux (107 and the NUL). */
const SOCKET_PATH_MAX = 107;
/** Where the stub's folder goes: the temp folder when the socket path fits there, else the runtime folder, else /tmp. A long
 *  $TMPDIR (a developer's `TMPDIR=$HOME/.cache/...`, a deep CI checkout) would otherwise fail the bind and refuse every turn. */
export function hostPowerStubBase(): string | null {
  const fits = (base: string) => Buffer.byteLength(join(base, "murage-power-XXXXXX", "bus.sock")) <= SOCKET_PATH_MAX;
  const candidates = [hostPowerDeps.tmpdir(), hostPowerDeps.runtimeDir(), hostPowerDeps.fallbackTmp()].filter((dir): dir is string => Boolean(dir));
  for (const base of candidates) {
    if (fits(base)) return base;
    let real: string; try { real = realpathSync(base); } catch { continue; }
    if (fits(real)) return real;
  }
  return null;
}

/** At server startup (Linux): bind one unix socket in a 0700 directory that accepts only to close the connection. Every wrapped
 *  engine uses the same socket. Until it is bound (or when it cannot be), a wrapped Linux turn does not start. */
export function startHostPowerStub(): Promise<string | null> {
  if (stub.starting) return stub.starting;
  stub.starting = new Promise((resolve) => {
    let dir: string;
    const base = hostPowerStubBase();
    if (!base) {
      stub.problem = TMPDIR_TOO_LONG;
      console.warn(`[host-power] the bus stub could not be placed: ${stub.problem}`);
      resolve(null); return;
    }
    try { dir = mkdtempSync(join(base, "murage-power-")); } catch (error) {
      stub.problem = `its temp folder could not be made in ${base}`;
      console.warn(`[host-power] the bus stub folder could not be made: ${error instanceof Error ? error.message : String(error)}`);
      resolve(null); return;
    }
    // mkdtemp makes the folder 0700.
    const path = join(dir, "bus.sock");
    const server = createServer((socket) => { socket.on("error", () => {}); socket.destroy(); });
    server.on("error", (error) => {
      stub.problem = `its socket could not be opened (${error.message})`;
      console.warn(`[host-power] the bus stub could not be bound: ${error.message}`);
      try { server.close(); } catch { /* not listening */ }
      try { rmSync(dir!, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve(null);
    });
    server.listen(path, () => {
      server.unref();
      stub.path = path; stub.dir = dir; stub.server = server; stub.problem = null;
      process.once("exit", () => { try { rmSync(dir!, { recursive: true, force: true }); } catch { /* best effort */ } });
      resolve(path);
    });
  });
  return stub.starting;
}

/** Tests: close the stub and forget it. */
export async function stopHostPowerStubForTests(): Promise<void> {
  const { server, dir } = stub;
  stub.path = null; stub.dir = null; stub.server = null; stub.starting = null; stub.problem = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// ── The plan ───────────────────────────────────────────────────────────────

export type HostPowerPlan =
  | { kind: "refuse"; reason: string }
  /** This computer cannot give an engine the block (an environment gap, hostPowerGap): the engine runs as an unwrapped spawn,
   *  under the access level, the never-list and the command reader. Never for a helper that failed its checks (tampering). */
  | { kind: "unwrapped"; reason: string }
  | { kind: "seatbelt"; command: string; args: string[] }
  /** `args` is bwrap's visible argv (`--args <fd> -- <engine argv>`); `argsData` is every bwrap option, the turn environment's
   *  --setenv pairs among them, NUL-separated for the --args pipe. `bpfSha256` is the pin openPowerFilter checks. */
  | { kind: "bwrap"; command: string; args: string[]; argsData: Buffer; bpf: string; bpfSha256: string; env: Record<string, string> };

/** A shipped helper file: absolute, realpath'd, a regular file, not a symlink, not writable by this euid. Null when it is fine. */
function helperProblem(file: string): string | null {
  let info;
  try { info = lstatSync(file); } catch { return `${file} is missing`; }
  if (info.isSymbolicLink()) return `${file} is a symlink`;
  if (!info.isFile()) return `${file} is not a regular file`;
  let real: string;
  try { real = realpathSync(file); } catch { return `${file} could not be resolved`; }
  if (real !== file) return `${file} is not its real path`;
  if (hostPowerDeps.geteuid() === 0) { if (hostPowerDeps.othersMayWrite(file)) return `${file} is writable by a user other than root`; }
  else if (hostPowerDeps.writable(file)) return `${file} is writable by this user`;
  return null;
}

/** The shipped helper after its checks (section 4): bwrap and the filter present, real paths, not symlinks, not writable by this
 *  user, bwrap the binary the cage manifest names and the manifest naming this server's filter pin. A problem is tampering or a
 *  broken install, never the environment. */
function verifiedHelper(arch: string, bpfSha256: string): { helperDir: string; bwrap: string; bpf: string } | { problem: string } {
  const dir = hostPowerDeps.helperDir();
  if (!dir) return { problem: "the shipped bwrap is missing: run `pnpm build:murage-cage` (needs Docker and the Linux build tools)" };
  let helperDir: string;
  try { helperDir = realpathSync(dir); } catch { return { problem: `${dir} could not be resolved` }; }
  const bwrap = join(helperDir, "bwrap"), bpf = join(helperDir, "murage-power.bpf");
  for (const file of [bwrap, bpf]) { const problem = helperProblem(file); if (problem) return { problem }; }
  // The bytes: bwrap must be the binary the cage manifest names, and the manifest must name this server's filter pin (the filter's
  // own bytes are hashed through the fd bwrap is handed, openPowerFilter).
  const digests = cageDigests(helperDir, arch, bpfSha256);
  if ("problem" in digests) return { problem: digests.problem };
  if (fileSha256(bwrap, 64 * 1024 * 1024) !== digests.bwrap) return { problem: `${bwrap} is not the shipped bwrap` };
  return { helperDir, bwrap, bpf };
}
/** Before a run without the block is granted (root, or a gap): the filter's own bytes must be the pin too, so an install whose
 *  filter was swapped is refused with or without a gap (a wrapped launch hashes them through the fd bwrap is handed instead,
 *  openPowerFilter). */
function filterBytesProblem(bpf: string, bpfSha256: string): string | null {
  return fileSha256(bpf, 1024 * 1024) === bpfSha256 ? null : `${bpf} is not the pinned power filter`;
}

// ── The environment gap (1.0.9) ─────────────────────────────────────────────
// House rules v2, rules 1 and 8: a local check never leaves an owner unable to run their bots. Where this computer cannot give
// an engine the block (the verified bwrap may not create a user namespace: Ubuntu 23.10+ AppArmor restricting unprivileged user
// namespaces for an AppImage, a container's seccomp profile, a kernel with them turned off), a
// wrapped engine runs as an ordinary spawn under the access level, the never-list and the command reader. The cause is logged
// once and the owner is told once (HOST_POWER_GAP_NOTICE). A helper that fails its checks is never a gap.

export type HostPowerGapCause = "container" | "userns-off" | "userns-restricted" | "userns-denied";
export type HostPowerGap = { cause: HostPowerGapCause; detail: string };
/** The one owner-facing line, shown once (hostPowerGapNoticeDue). Says what protects the bots; no sandbox words. */
export const HOST_POWER_GAP_NOTICE = "On this computer your bots are protected by their access level, and Murage checks their commands before they run.";

/** The driver kinds whose spawns are not under the block on Linux and macOS (section 2, revision 4.1): they pass
 *  `posixHostPower: false` (claude.ts, codex.ts, acp/core.ts for fuigoAgent). Every other engine is wrapped. */
export const HOST_POWER_UNWRAPPED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "fuigoAgent"]);

const gapState: { gap: HostPowerGap | null; probing: Promise<HostPowerGap | null> | null } = { gap: null, probing: null };

/** The environment gap this server found, or null when the block applies (or the probe has not answered yet). */
export function hostPowerGap(): HostPowerGap | null { return gapState.gap; }

/** Record the gap once, with its reason in the app log. A later cause does not replace the first. */
export function noteHostPowerGap(cause: HostPowerGapCause, detail: string): HostPowerGap {
  if (gapState.gap) return gapState.gap;
  gapState.gap = { cause, detail };
  console.warn(`[host-power] this computer cannot apply the power block (${cause}: ${detail}); wrapped engines run under the access level, the never-list and the command reader`);
  return gapState.gap;
}

const readKernelSetting = (file: string): string | null => { try { return readFileSync(file, "utf8").trim(); } catch { return null; } };
/** bwrap's own words, on the first line of its stderr, when the kernel or a security module refused it a user namespace (bwrap
 *  0.13.1: the uid map write, unshare EPERM, "No permissions ...", EINVAL "Creating new namespace failed, likely ...", ENOSPC
 *  "Creating new namespace failed: nesting depth or ... exceeded (ENOSPC)" and the generic "Creating new namespace failed: ...").
 *  Only the first line: a later line can carry a path the turn chose (bwrap's own chdir error prints the cwd unescaped). */
export function usernsDenied(stderr: string, read: (file: string) => string | null = readKernelSetting): boolean {
  const first = stderr.split("\n", 1)[0];
  if (!/^bwrap: (?:setting up uid map: (?:Permission denied|Operation not permitted)$|unshare user ns: (?:Permission denied|Operation not permitted)$|Creating new namespace failed[:,] |No permissions to create a new namespace)/.test(first)) return false;
  // ENOSPC is also what a user's namespace count being used up says, which any process of this user can cause for a moment: it
  // is the environment only when the kernel allows no user namespaces at all.
  if (/\(ENOSPC\)$|No space left on device$/.test(first)) return read("/proc/sys/user/max_user_namespaces") === "0";
  return true;
}

/** Why a verified bwrap was refused a user namespace, for the log: a container, user namespaces off, the AppArmor restriction, or
 *  (none of those visible) a plain denial. The label never changes what runs. */
export function usernsGapCause(read: (file: string) => string | null = readKernelSetting, present: (file: string) => boolean = existsSync): HostPowerGapCause {
  if (present("/.dockerenv") || present("/run/.containerenv") || /(?:docker|containerd|kubepods|libpod|lxc)/.test(read("/proc/1/cgroup") ?? "")) return "container";
  if (read("/proc/sys/kernel/unprivileged_userns_clone") === "0" || read("/proc/sys/user/max_user_namespaces") === "0") return "userns-off";
  if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") return "userns-restricted";
  return "userns-denied";
}

/** The probe's bwrap options: the block's user and pid namespace with nothing else, so a refusal can only be the namespace. */
export function probeOptions(euid: number, egid: number): string[] {
  return ["--unshare-user", "--uid", String(euid), "--gid", String(egid), "--unshare-pid", "--cap-drop", "ALL", "--die-with-parent", "--new-session",
    "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"];
}

/** Seam for the probe's one bwrap run. */
export const hostPowerProbeDeps = {
  run: (command: string, args: string[]): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
    execFile(command, args, { env: { ...BWRAP_ENVIRONMENT }, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0;
      resolve({ code, stderr: String(stderr ?? "") });
    });
  }),
};

/** At server startup (Linux, desktop): find out once whether this computer lets the verified bwrap make the block's namespaces.
 *  A helper that fails its checks is not probed (its launches stay refused). Any other failure is not a gap. */
export function probeHostPowerEnvironment(): Promise<HostPowerGap | null> {
  if (gapState.probing) return gapState.probing;
  gapState.probing = (async () => {
    if (hostPowerDeps.platform() !== "linux") return null;
    const arch = hostPowerDeps.arch();
    const pin = hostPowerDeps.powerFilterSha256(arch);
    if (!["x64", "arm64"].includes(arch) || !pin) return null;
    const euid = hostPowerDeps.geteuid();
    const helper = verifiedHelper(arch, pin);
    if ("problem" in helper || filterBytesProblem(helper.bpf, pin)) return gapState.gap;
    const result = await hostPowerProbeDeps.run(helper.bwrap, probeOptions(euid, hostPowerDeps.getegid()));
    if (result.code === 0 || !usernsDenied(result.stderr, readKernelSetting)) return gapState.gap;
    return noteHostPowerGap(usernsGapCause(), result.stderr.split("\n")[0].trim().slice(0, 200));
  })();
  return gapState.probing;
}

/** A wrapped launch's bwrap said, before the engine started, that it was refused a namespace. That stderr is not trusted on its
 *  own (a turn can shape later lines): it only asks for the same independent probe startup runs. */
export function reprobeHostPowerEnvironment(): Promise<HostPowerGap | null> {
  if (gapState.gap) return Promise.resolve(gapState.gap);
  gapState.probing = null;
  return probeHostPowerEnvironment();
}

/** Whether the owner is still owed the one gap line: a gap is known, it was not shown in this run, and the data folder's
 *  power-guard-notice.json (`marker`, data-dir-inventory.ts) does not say it was shown on this computer. */
export function hostPowerGapNoticeDue(marker: string): boolean {
  return gapState.gap !== null && !noticeState.shown && !existsSync(marker);
}
/** After the line reached the thread: never again in this run, and the marker for later runs (a marker that cannot be written
 *  still keeps it to once per run). */
export function markHostPowerGapNoticeShown(marker: string): void {
  noticeState.shown = true;
  try { writeFileSync(marker, JSON.stringify({ shownAt: new Date().toISOString(), cause: gapState.gap?.cause ?? null }) + "\n", { mode: 0o600 }); } catch { /* once per run */ }
}
const noticeState = { shown: false };

/** Tests: forget the gap, the probe and the notice. */
export function resetHostPowerGapForTests(): void { gapState.gap = null; gapState.probing = null; noticeState.shown = false; }

/** The pathname of each `unix:path=` entry in a D-Bus address; `abstract` when any entry is an abstract socket. */
export function sessionBusPaths(address: string | undefined): { paths: string[]; abstract: boolean } {
  const paths: string[] = [];
  let abstract = false;
  for (const entry of (address ?? "").split(";")) {
    const match = /^unix:(.*)$/.exec(entry.trim());
    if (!match) continue;
    for (const pair of match[1].split(",")) {
      const [key, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (key === "abstract") abstract = true;
      else if (key === "path" && value) paths.push(decodeURIComponent(value));
    }
  }
  return { paths, abstract };
}

const sameFile = (a: string, b: string): boolean => {
  try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
};
const exists = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/** Section 4: the bus paths the stub covers, each only when it exists. */
export function coveredBusPaths(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const add = (path: string) => { if (path && !out.includes(path) && exists(path)) out.push(path); };
  add(SYSTEM_BUS_PATHS[0]);
  if (!sameFile(SYSTEM_BUS_PATHS[1], SYSTEM_BUS_PATHS[0])) add(SYSTEM_BUS_PATHS[1]);
  add(SYSTEM_BUS_PATHS[2]);
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime) { add(join(runtime, "bus")); add(join(runtime, "systemd", "private")); }
  for (const path of sessionBusPaths(env.DBUS_SESSION_BUS_ADDRESS).paths) add(path);
  return out;
}

/** Section 4: the bwrap options, flags in the design's order. They reach bwrap on the --args pipe; its argv is only
 *  `--args <fd> -- <engine argv>` (bwrapArgv), the engine and its argv unchanged after `--`. */
export function bwrapOptions(input: { euid: number; egid: number; helperDir: string; stub: string; busPaths: string[]; bpfFd: number; cwd: string; env: Record<string, string> }): string[] {
  return [
    "--unshare-user", "--uid", String(input.euid), "--gid", String(input.egid), "--unshare-pid", "--cap-drop", "ALL", "--die-with-parent", "--new-session",
    "--bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--ro-bind", input.helperDir, input.helperDir,
    ...input.busPaths.flatMap((path) => ["--bind", input.stub, path]),
    "--seccomp", String(input.bpfFd),
    "--json-status-fd", String(BWRAP_STATUS_FD),
    "--chdir", input.cwd,
    "--clearenv",
    ...Object.entries(input.env).flatMap(([name, value]) => ["--setenv", name, value]),
  ];
}

/** The fd bwrap reads its options from (--args): the fifth stdio entry, after the engine's three pipes and the filter. */
export const BWRAP_ARGS_FD = 4;
/** The fd bwrap writes its JSON status to (--json-status-fd): the sixth stdio entry. bwrap writes `{ "child-pid": N, ... }` once
 *  the sandbox process exists, and `{ "exit-code": N }` when it ends ONLY if the engine's execvp succeeded (bwrap 0.13.1
 *  report_child_exit_status reads its close-on-exec setup pipe: one byte means the engine was exec'd). That exit-code record is
 *  the one positive sign the engine started; a wrapped run that ends without it never ran the engine (bwrapEngineStarted). */
export const BWRAP_STATUS_FD = 5;

/** Whether bwrap's --json-status-fd output says the engine was exec'd: a line that is a JSON object with a numeric "exit-code".
 *  Anything else (no output at all when bwrap itself could not load, a "child-pid" line only when setup or execvp failed, bytes
 *  that do not parse) means the engine never started. */
export function bwrapEngineStarted(status: string): boolean {
  for (const line of status.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const record = JSON.parse(text) as Record<string, unknown> | null;
      if (record && typeof record === "object" && Number.isInteger(record["exit-code"])) return true;
    } catch { /* not a status record */ }
  }
  return false;
}

/** Section 4: bwrap's visible argv. No option value and no environment value is on it. */
export function bwrapArgv(command: string, args: string[]): string[] {
  return ["--args", String(BWRAP_ARGS_FD), "--", command, ...args];
}

/** The --args payload: each option NUL-terminated, as bwrap's parser splits it. */
export function bwrapArgsData(options: string[]): Buffer {
  return Buffer.from(options.map((option) => `${option}\0`).join(""), "utf8");
}

const argvBytes = (argv: string[]): number => argv.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);

/** The turn environment as bwrap --setenv pairs: string values only, the names a spawn's environment can carry. */
function turnEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? process.env)) if (typeof value === "string" && name !== "" && !name.includes("=")) out[name] = value;
  return out;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Read a whole regular file through an fd with positional reads (the fd's offset stays at 0), up to `limit` bytes. */
function readWholeFd(fd: number, limit: number): Buffer | null {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > limit) return null;
  const bytes = Buffer.alloc(info.size);
  let at = 0;
  while (at < bytes.length) {
    const read = readSync(fd, bytes, at, bytes.length - at, at);
    if (read <= 0) return null;
    at += read;
  }
  // A file that grew after fstat is not the file that was hashed.
  return readSync(fd, Buffer.alloc(1), 0, 1, at) === 0 ? bytes : null;
}

/** The sha256 of a file read once through one fd, or null when it cannot be read as a regular file. */
function fileSha256(file: string, limit: number): string | null {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return null; }
  try { const bytes = readWholeFd(fd, limit); return bytes ? sha256(bytes) : null; } catch { return null; } finally { closeSync(fd); }
}

/** The cage manifest scripts/build-murage-cage.mjs writes next to bwrap (after-pack.mjs checks it at packaging): its bwrap digest,
 *  and its power filter digest, which must be this server's own pin. */
function cageDigests(helperDir: string, arch: string, powerPin: string): { bwrap: string } | { problem: string } {
  const file = join(helperDir, "manifest.json");
  const problem = helperProblem(file);
  if (problem) return { problem };
  let manifest: { schema?: unknown; target?: unknown; executable?: unknown; binarySha256?: unknown; filters?: Record<string, { sha256?: unknown } | undefined> };
  try {
    let fd: number;
    try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return { problem: `${file} could not be opened` }; }
    try { const bytes = readWholeFd(fd, 1024 * 1024); if (!bytes) return { problem: `${file} could not be read` }; manifest = JSON.parse(bytes.toString("utf8")); } finally { closeSync(fd); }
  } catch { return { problem: `${file} is not a cage manifest` }; }
  const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (manifest?.schema !== 1 || manifest.target !== `linux-${arch}` || manifest.executable !== "bwrap" || !hex(manifest.binarySha256)) return { problem: `${file} is not the cage manifest for linux-${arch}` };
  if (manifest.filters?.["murage-power.bpf"]?.sha256 !== powerPin) return { problem: `${file} names a different power filter` };
  return { bwrap: manifest.binarySha256 };
}

/** The file descriptor bwrap reads the filter from: stdio is the engine's three pipes, this fd, then the --args pipe. */
export const BWRAP_SECCOMP_FD = 3;

/** Plan a wrapped launch on Linux or macOS (the caller checked the marker, the cloud launch and the docker server tool). A refusal
 *  is a pid-less EPOWER child; nothing is spawned. */
export function planHostPower(command: string, args: string[], env: NodeJS.ProcessEnv | undefined, cwd: string | undefined): HostPowerPlan {
  const platform = hostPowerPlatform();
  if (platform === "darwin") {
    const file = hostPowerDeps.sandboxExec;
    let present = false;
    try { present = statSync(file).isFile(); } catch { present = false; }
    if (!present) return { kind: "refuse", reason: `${file} is missing` };
    return { kind: "seatbelt", command: file, args: ["-p", SEATBELT_POWER_PROFILE, command, ...args] };
  }
  if (platform !== "linux") return { kind: "refuse", reason: `no power block on ${String(hostPowerDeps.platform())}` };
  const arch = hostPowerDeps.arch();
  const bpfSha256 = hostPowerDeps.powerFilterSha256(arch);
  if (!["x64", "arm64"].includes(arch) || !bpfSha256) return { kind: "refuse", reason: `architecture ${arch} has no power filter` };
  const euid = hostPowerDeps.geteuid();
  const helper = verifiedHelper(arch, bpfSha256);
  if ("problem" in helper) return { kind: "refuse", reason: helper.problem };
  const { helperDir, bwrap, bpf } = helper;
  // Only after the helper passed every check above: a writable, swapped or unpinned helper is tampering and stays refused. A
  // verified bwrap that this computer does not let create a user namespace (Ubuntu 24.04 AppArmor for an AppImage, a container's
  // seccomp profile, user namespaces turned off), as the probe found, is the environment: the turn runs without the block. A
  // server running as root is wrapped like any other (bwrap makes its namespaces as root, and the filter and the bus stub still
  // apply); it is a gap only when the probe says so (a root container).
  const gap = hostPowerGap();
  if (gap) {
    const swapped = filterBytesProblem(bpf, bpfSha256);
    if (swapped) return { kind: "refuse", reason: swapped };
    return { kind: "unwrapped", reason: gap.detail };
  }
  const stubPath = hostPowerDeps.stubSocket();
  if (!stubPath) return { kind: "refuse", reason: stub.problem ? `Murage could not set up its power-control socket: ${stub.problem}` : "the bus stub is not bound" };
  const turnEnv = turnEnvironment(env);
  const lookup: NodeJS.ProcessEnv = { ...process.env, ...turnEnv };
  for (const source of [process.env, turnEnv]) if (sessionBusPaths(source.DBUS_SESSION_BUS_ADDRESS).abstract) return { kind: "refuse", reason: "the session bus address is abstract" };
  const busPaths = [...new Set([...coveredBusPaths(process.env), ...coveredBusPaths(lookup)])];
  // A NUL inside a value would split it into extra bwrap options on the --args pipe.
  for (const [name, value] of Object.entries(turnEnv)) if (name.includes("\0") || value.includes("\0")) return { kind: "refuse", reason: "the turn environment holds a NUL byte" };
  const options = bwrapOptions({ euid, egid: hostPowerDeps.getegid(), helperDir, stub: stubPath, busPaths, bpfFd: BWRAP_SECCOMP_FD, cwd: cwd ?? process.cwd(), env: turnEnv });
  const argv = bwrapArgv(command, args);
  if (options.some((option) => option.includes("\0"))) return { kind: "refuse", reason: "a bwrap option holds a NUL byte" };
  if (argvBytes([bwrap, ...argv]) + argvBytes(options) > BWRAP_ARGV_LIMIT_BYTES) return { kind: "refuse", reason: "the bwrap arguments would exceed 1 MiB" };
  if (argv.length + options.length > BWRAP_MAX_ARGS) return { kind: "refuse", reason: `the bwrap arguments would exceed ${BWRAP_MAX_ARGS}` };
  return { kind: "bwrap", command: bwrap, args: argv, argsData: bwrapArgsData(options), bpf, bpfSha256, env: { ...BWRAP_ENVIRONMENT } };
}

/** Open the filter for one bwrap spawn and hash its bytes through that same fd (positional reads: its offset stays at 0 for
 *  bwrap). The fd is returned only when the bytes are the pin; null otherwise, and the launch is refused. The caller hands this fd
 *  to bwrap and closes it once the spawn returned. */
export function openPowerFilter(bpf: string, pinnedSha256: string): number | null {
  let fd: number;
  try { fd = openSync(bpf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return null; }
  let ok = false;
  try { const bytes = readWholeFd(fd, 1024 * 1024); ok = bytes !== null && sha256(bytes) === pinnedSha256; } catch { ok = false; }
  if (!ok) { closePowerFilter(fd); return null; }
  return fd;
}
export function closePowerFilter(fd: number): void { try { closeSync(fd); } catch { /* already closed */ } }

/** Explain an already refused bwrap launch. Its status fd still decides whether the engine ran. */
export function bwrapEarlyExitMessage(status: string, stderr: string, command: string, env: NodeJS.ProcessEnv = process.env): string {
  const said = stderr.split("\n")[0].trim().slice(0, 200);
  const message = `the bundled bwrap ended (${status}) before the engine started, so the power block was not in place${said ? `: ${said}` : ""}`;
  const sourceRun = hostPowerDeps.platform() === "linux" && !env.MURAGE_PACKAGED && !env.MURAGE_RESOURCES_PATH && !env.OMB_RESOURCES_PATH
    && command.endsWith(`/dist-native/cage/linux-${hostPowerDeps.arch()}/bwrap`);
  const usernsDenial = usernsDenied(stderr);
  return sourceRun && usernsDenial
    ? `${message}. Run \`pnpm cage:apparmor\` once from this repository (it asks for your sudo password one time) to install the source cage AppArmor profile, then try again.`
    : message;
}

/** macOS: sandbox-exec's own refusal, read from the first bytes of the wrapped child's stderr (sandbox-exec names itself). Linux
 *  does not read stderr: the bwrap stage is judged by its status fd (bwrapEngineStarted). */
export function wrapperRefusalText(stderrPrefix: string): boolean {
  return stderrPrefix.startsWith("sandbox-exec: ");
}
