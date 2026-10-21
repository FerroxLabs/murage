// Chromium's Windows AppContainer needs RX on the shipped browser binaries.
// This grants no write access and never changes the sandbox or a user profile.
// No PowerShell (murage-releases #1): the folder's ACLs are read with icacls /save /T (SDDL, by SID: shared/windows-sddl.mjs) and,
// only when an entry lacks it, the grant is icacls' own /grant. Both by absolute System32 path.
// On Linux, the bundled Chrome needs a sandbox it can start: see
// ensureLinuxChromeSandbox below. Neither platform ever turns the sandbox off.
import { execFile } from "node:child_process";
import { readFileSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { savedAclEntries, sddlMask } from "../shared/windows-sddl.mjs";
import { browserBundlePaths, browserBundleSpec } from "./browser-bundle-release.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { enableLinuxEngineBrowser, ensureLinuxEngineChrome, LinuxEngineNotInstalled, type EnableOutcome, type EnablePlan, type PkexecRun } from "./browser-sandbox-linux-engine.ts";
import { admitWindowsBrowserImage, nativeAuthenticodeIn, WINDOWS_BROWSER_IMAGE_PINS } from "./browser-windows-identity.ts";
/** ALL APPLICATION PACKAGES, the AppContainer group Chromium's sandbox runs as. */
export const APP_CONTAINER_SID = "S-1-15-2-1";
const READ_AND_EXECUTE = 0x1200a9;
// Generic rights as a file maps them (FILE_GENERIC_READ / _EXECUTE, and GENERIC_ALL to full control).
const GENERIC_FILE: Array<[number, number]> = [[0x80000000, 0x120089], [0x20000000, 0x1200a0], [0x10000000, 0x1f01ff]];
const fileMask = (mask: number) => GENERIC_FILE.reduce((out, [generic, specific]) => (mask & generic ? out | specific : out), mask) >>> 0;
/** True when every entry icacls /save wrote (the folder and everything under it) lets the AppContainer read and run it: an allow
 * entry for S-1-15-2-1 that applies to the item itself (not inherit-only) with all of ReadAndExecute. A listing that cannot be read
 * counts as missing, so the grant runs. */
export function appContainerCanRead(saved: Uint8Array): boolean {
  let entries: Array<{ sddl: string }>;
  try { entries = savedAclEntries(saved); } catch { return false; }
  // Only the AppContainer's own allow entries are read (alias "AC" or its SID), so an entry for an account this check has no use for
  // never forces a grant (which a standard user could not make on Program Files).
  return entries.length > 0 && entries.every(({ sddl }) => [...sddl.matchAll(/\(A;([A-Z]*);([^;()]*);;;(?:AC|S-1-15-2-1)\)/g)].some(([, flags = "", rights = ""]) => {
    const aceFlags: string[] = flags.match(/../g) ?? [];
    if (aceFlags.includes("IO")) return false;
    try { return (fileMask(sddlMask(rights)) & READ_AND_EXECUTE) === READ_AND_EXECUTE; } catch { return false; }
  }));
}
type Run = (file: string, args: string[]) => Promise<boolean>;
const runTool: Run = (file, args) => new Promise(done => execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, error => done(!error)));
/** Reads the folder's ACLs and grants the AppContainer RX only when one is missing. `run` and `read` are test seams. */
export async function grantAppContainerRead(chromeDirectory: string, systemRoot: string | undefined, run: Run = runTool, read: (file: string) => Uint8Array = readFileSync): Promise<void> {
  const icacls = join(systemRoot && /^[A-Za-z]:\\[^"\x00-\x1f]*$/.test(systemRoot) ? systemRoot : "C:\\Windows", "System32", "icacls.exe");
  const folder = mkdtempSync(join(tmpdir(), "murage-browser-acl-"));
  try {
    const file = join(folder, "acl.txt");
    const saved = await run(icacls, [chromeDirectory, "/save", file, "/T", "/C", "/Q"]);
    if (saved && appContainerCanRead(read(file))) return;
    if (!await run(icacls, [chromeDirectory, "/grant", `*${APP_CONTAINER_SID}:(OI)(CI)(RX)`, "/T", "/C", "/Q"])) throw new Error("Browser sandbox file access could not be prepared");
  } finally { try { rmSync(folder, { recursive: true, force: true }); } catch { /* a private temp folder holding ACL lines */ } }
}
const prepared = new Map<string, Promise<void>>();
export async function ensureBrowserSandboxAccess(spec: AgentBrowserSpec): Promise<void> {
  if (process.platform === "linux") return ensureLinuxChromeSandbox(spec);
  if (process.platform !== "win32") return;
  const directory = spec.env.MURAGE_BROWSER_BUNDLE_DIR;
  if (!directory) throw new Error("Windows browser requires Murage's verified bundled Chromium");
  const root = resolve(directory), paths = browserBundlePaths(root, "win32-x64"), pin = browserBundleSpec("win32-x64");
  if (resolve(spec.command) !== paths.engine || resolve(spec.env.AGENT_BROWSER_EXECUTABLE_PATH ?? "") !== paths.chrome) throw new Error("Browser bundle identity does not match its launch configuration");
  if (prepared.has(root)) return prepared.get(root)!;
  const operation = (async () => {
    // The same admission rule the resolver applies (browser-windows-identity.ts windowsBrowserImageState), for both images.
    const native = nativeAuthenticodeIn(process.env.MURAGE_RESOURCES_PATH);
    for (const [file, original] of [[paths.engine, WINDOWS_BROWSER_IMAGE_PINS.engine], [paths.chrome, WINDOWS_BROWSER_IMAGE_PINS.chrome]] as const) {
      if (await admitWindowsBrowserImage(file, original, native) !== "ok") throw new Error("Browser bundle failed identity verification");
    }
    if (!lstatSync(paths.licenses).isDirectory()) throw new Error("Browser bundle failed identity verification");
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    if (manifest.engine?.sha256 !== pin.engine.sha256 || manifest.chrome?.executableSha256 !== pin.chrome.executableSha256) throw new Error("Browser bundle manifest is invalid");
    const chromeDirectory = dirname(paths.chrome);
    if (lstatSync(chromeDirectory).isSymbolicLink()) throw new Error("Browser bundle directory cannot be a link");
    // Check existing permissions first: Program Files may already grant RX,
    // and a standard user should not need elevation to use a correct install.
    try { await grantAppContainerRead(chromeDirectory, spec.env.SystemRoot); }
    catch { throw new Error("Windows browser sandbox file access needs repair. Reinstall Murage or repair its bundled browser permissions."); }
  })();
  prepared.set(root, operation);
  try { await operation; } catch (error) { prepared.delete(root); throw error; }
}

/** Where the .deb installs the bundled Chrome. build/linux-apparmor-profile.tpl
 * attaches its murage-browser profile to exactly this path. */
export function linuxDebChromePath(): string {
  return join("/opt/Murage/resources/browser-engine", browserBundleSpec("linux-x64").chrome.executable);
}
/** The profile file the .deb's after-install hook copies into place. */
export const LINUX_APPARMOR_PROFILE_FILE = "/etc/apparmor.d/murage";

export type LinuxUserNamespaces = { off: boolean; restricted: boolean };
function readKernelSetting(file: string): string | null {
  try { return readFileSync(file, "utf8").trim(); } catch { return null; }
}
/** The kernel settings Chrome's namespace sandbox depends on. `off`: no
 * unprivileged user namespaces at all. `restricted`: Ubuntu 23.10+ lets a
 * program use them only under an AppArmor profile that allows `userns`. */
export function linuxUserNamespaces(read: (file: string) => string | null = readKernelSetting): LinuxUserNamespaces {
  return {
    off: read("/proc/sys/kernel/unprivileged_userns_clone") === "0" || read("/proc/sys/user/max_user_namespaces") === "0",
    restricted: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1",
  };
}

export type ChromeSandboxVerdict = "available" | "blocked" | "unknown";
/** Chrome's own answer. With neither its namespace sandbox nor a working
 * setuid helper it stops at start-up with "No usable sandbox!" (or, with a
 * helper that is not root-owned and setuid, says so). Any other failure is not
 * a sandbox question; the normal launch path reports it. */
export function classifyChromeSandboxProbe(result: { failed: boolean; stderr: string }): ChromeSandboxVerdict {
  if (/No usable sandbox!|SUID sandbox helper binary was found, but is not configured correctly/u.test(result.stderr)) return "blocked";
  return result.failed ? "unknown" : "available";
}

const NEVER_WITHOUT = "Murage never runs the browser without its sandbox.";
/** What the browser panel and the log say, with the step that fixes it. */
export function linuxSandboxBlockedMessage(input: { chrome: string; namespaces: LinuxUserNamespaces; appImage?: boolean }): string {
  if (input.namespaces.off) return `The bot browser can't start: this Linux system has user namespaces turned off, and Chrome needs them for its sandbox. Ask your administrator to turn them on (sysctl user.max_user_namespaces). ${NEVER_WITHOUT}`;
  if (input.appImage) return `The bot browser can't start: Ubuntu lets Chrome use its sandbox only with an AppArmor rule. Choose Enable browser to add one; your computer asks for an administrator password. You can also install Murage from the .deb package instead. ${NEVER_WITHOUT}`;
  if (resolve(input.chrome) === linuxDebChromePath()) return `The bot browser can't start: Ubuntu hasn't loaded the AppArmor rule Murage installed for it. Restart your computer, or run: sudo apparmor_parser -r ${LINUX_APPARMOR_PROFILE_FILE}`;
  return `The bot browser can't start: Ubuntu lets Chrome use its sandbox only with an AppArmor rule, and this copy of Murage (an AppImage or an unpacked package) can't add one. Install Murage from the .deb package to use the browser. ${NEVER_WITHOUT}`;
}

export type ChromeProbeRun = (chrome: string) => Promise<{ failed: boolean; stderr: string }>;
const PROBE_PREFIX = "murage-sandbox-probe-";
/** One short headless run of the bundled Chrome, the same binary and AppArmor
 * attachment agent-browser launches, in a throwaway profile. */
const runChromeProbe: ChromeProbeRun = (chrome) => new Promise((done) => {
  const profile = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
  const finish = (failed: boolean, stderr: string) => {
    if (dirname(profile) === resolve(tmpdir()) && profile.split(sep).pop()!.startsWith(PROBE_PREFIX)) rmSync(profile, { recursive: true, force: true });
    done({ failed, stderr });
  };
  try {
    execFile(chrome, ["--headless", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--dump-dom", "about:blank"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile }, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1 << 20, windowsHide: true,
    }, (error, _stdout, stderr) => finish(!!error, String(stderr)));
  } catch (error) { finish(true, String(error)); }
});

/** Ask again this long after a refusal, so loading the profile (or a restart
 * of nothing but the profile) is picked up without restarting Murage. */
export const LINUX_SANDBOX_RECHECK_MS = 30_000;
type LinuxCheck = { at: number; verdict: Promise<ChromeSandboxVerdict>; settled?: ChromeSandboxVerdict; logged?: boolean };
const linuxChecks = new Map<string, LinuxCheck>();
export function clearLinuxSandboxChecks(): void { linuxChecks.clear(); }

/** Linux: refuse, with a message a person can act on, when Chrome would find
 * no sandbox. Ubuntu 24.04 restricts unprivileged user namespaces through
 * AppArmor; the .deb installs a profile for the bundled Chrome, an AppImage
 * cannot. Chrome is asked once per binary and kernel setting; a success is
 * kept, a refusal is asked again after LINUX_SANDBOX_RECHECK_MS. Where the
 * kernel does not restrict namespaces at all nothing is launched. */
export async function ensureLinuxChromeSandbox(spec: AgentBrowserSpec, deps: { read?: (file: string) => string | null; run?: ChromeProbeRun; now?: () => number; log?: (line: string) => void; engine?: (bundled: string) => Promise<string>; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  // Cloud homes run Chrome inside their own launcher; the owner's own Chrome is never started here.
  if (process.env.MURAGE_CLOUD_ROLE === "home" || spec.env.AGENT_BROWSER_CDP) return;
  if (!spec.env.AGENT_BROWSER_EXECUTABLE_PATH) return;
  if (!bundledChromes.has(spec)) bundledChromes.set(spec, spec.env.AGENT_BROWSER_EXECUTABLE_PATH);
  const bundled = bundledChromes.get(spec)!;
  let chrome = bundled;
  const namespaces = linuxUserNamespaces(deps.read);
  if (!namespaces.off && !namespaces.restricted) return;
  // An AppImage's mount path changes every launch: run the verified, root-owned
  // copy at a fixed path that one AppArmor profile can name. Only Enable
  // browser's administrator step writes it; a missing copy is the same refusal
  // as a Chrome with no sandbox.
  const appImage = !namespaces.off && isAppImageChrome(bundled, deps.env ?? process.env);
  if (appImage) {
    lastAppImageChrome = bundled;
    try { chrome = await (deps.engine ?? ensureLinuxEngineChrome)(bundled); }
    catch (error) {
      if (error instanceof LinuxEngineNotInstalled) {
        const message = linuxSandboxBlockedMessage({ chrome: bundled, namespaces, appImage });
        (deps.log ?? console.warn)(`[browser] ${message}`);
        throw Object.assign(new Error(message), { status: 503, code: LINUX_SANDBOX_ENABLE_CODE });
      }
      const message = `The bot browser can't start: Murage couldn't check its browser copy (${(error as Error).message}). Try Enable browser again, or install Murage from the .deb package. ${NEVER_WITHOUT}`;
      (deps.log ?? console.warn)(`[browser] ${message}`);
      throw Object.assign(new Error(message), { status: 503, code: "browser_sandbox_unavailable" });
    }
    spec.env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
  }
  let stamp: string;
  try { const info = statSync(chrome); stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
  catch { return; }
  const now = deps.now ?? Date.now;
  const key = JSON.stringify([resolve(chrome), stamp, namespaces]);
  let check = linuxChecks.get(key);
  if (!check || (check.settled && check.settled !== "available" && now() - check.at >= LINUX_SANDBOX_RECHECK_MS)) {
    const fresh: LinuxCheck = { at: now(), verdict: (deps.run ?? runChromeProbe)(chrome).then(classifyChromeSandboxProbe, () => "unknown" as const) };
    void fresh.verdict.then((verdict) => { fresh.settled = verdict; fresh.at = now(); });
    linuxChecks.set(key, check = fresh);
  }
  const verdict = await check.verdict;
  if (verdict !== "blocked") return;
  const message = linuxSandboxBlockedMessage({ chrome, namespaces, appImage });
  if (!check.logged) { check.logged = true; (deps.log ?? console.warn)(`[browser] ${message}`); }
  throw Object.assign(new Error(message), { status: 503, code: appImage ? LINUX_SANDBOX_ENABLE_CODE : "browser_sandbox_unavailable" });
}

/** The refusal the panel answers with an Enable browser button. */
export const LINUX_SANDBOX_ENABLE_CODE = "browser_sandbox_enable";
/** True for the AppImage refusal text, which the browser status carries as
 * its `problem` once a command has failed with it. */
export function isLinuxSandboxEnableProblem(problem: unknown): boolean {
  return problem === linuxSandboxBlockedMessage({ chrome: "", namespaces: { off: false, restricted: true }, appImage: true });
}
/** The bundled Chrome each launch spec started with, before any copy replaced it. */
const bundledChromes = new WeakMap<AgentBrowserSpec, string>();
/** The AppImage Chrome Enable browser installs a copy of (set when the refusal is raised). */
let lastAppImageChrome: string | undefined;
/** Chrome inside a mounted AppImage (APPDIR, or the runtime's .mount_ folder). */
export function isAppImageChrome(chrome: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = resolve(chrome);
  if (env.APPDIR && path.startsWith(resolve(env.APPDIR) + sep)) return true;
  return /\/\.mount_[^/]+\//u.test(path);
}
/** Enable browser: the administrator prompt installs the profile, and the
 * next browser request asks Chrome again at once instead of after the
 * recheck interval, so nothing restarts. */
export async function enableLinuxBrowserSandbox(deps: { run?: PkexecRun; exists?: (file: string) => boolean; bundled?: string; plan?: EnablePlan } = {}): Promise<EnableOutcome> {
  if (process.platform !== "linux") throw Object.assign(new Error("Enable browser is for Linux only"), { status: 404 });
  const bundled = deps.bundled ?? lastAppImageChrome;
  if (!bundled) throw Object.assign(new Error("Open the browser panel first, then choose Enable browser."), { status: 409, code: "browser_sandbox_no_browser" });
  const outcome = await enableLinuxEngineBrowser(bundled, deps);
  if (outcome === "enabled") clearLinuxSandboxChecks();
  return outcome;
}
