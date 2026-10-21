// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The AppImage's bot browser on Ubuntu 23.10 and later. An AppImage runs from
// a mount whose path changes every launch, so no AppArmor profile can name its
// Chrome. "Enable browser" in the browser panel runs ONE pkexec step (the
// system's standard administrator prompt) that, as root:
//   1. takes the bundled Chrome folder from the app as a tar stream,
//   2. unpacks it into a root-only staging folder and checks every file, folder
//      and hash against the bundle's manifest after the copy,
//   3. installs it as root:root, dirs 0755, files 0755/0644, with no group or
//      other write anywhere, at
//        /usr/local/lib/murage/browser-engine/<Chrome version>/chrome-headless-shell-linux64/
//      (copies of other Chrome versions are replaced), and
//   4. installs and loads one AppArmor profile that names exactly that path.
// agent-browser is pointed at that copy. A path no ordinary program can write
// is the only place the profile gives user namespaces to. Nothing restarts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { browserBundleSpec, CHROME_VERSION } from "./browser-bundle-release.ts";

const CHROME_DIRECTORY = "chrome-headless-shell-linux64";
export const LINUX_ENGINE_ROOT = "/usr/local/lib/murage/browser-engine";
export const LINUX_ENGINE_PROFILE_NAME = "murage-browser-engine";
export const LINUX_ENGINE_PROFILE_FILE = `/etc/apparmor.d/${LINUX_ENGINE_PROFILE_NAME}`;
const PKEXEC = "/usr/bin/pkexec";
const TAR = "/bin/tar";

/** The Chrome the profile names, for one Chrome version. */
export function linuxEngineChromePath(version: string = CHROME_VERSION, root: string = LINUX_ENGINE_ROOT): string {
  return join(root, version, CHROME_DIRECTORY, "chrome-headless-shell");
}

/** The same rules as the .deb's murage-browser profile
 * (build/linux-apparmor-profile.tpl), attached to the one exact path. */
export function linuxEngineBrowserProfile(version: string = CHROME_VERSION): string {
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    "# Murage's bot browser, copied out of the Murage AppImage to a folder only",
    "# the administrator can write. Installed by Murage's Enable browser button;",
    "# delete this file and run apparmor_parser -R on it to remove it.",
    "",
    `profile ${LINUX_ENGINE_PROFILE_NAME} ${linuxEngineChromePath(version)} flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${LINUX_ENGINE_PROFILE_NAME}>`,
    "}",
    "",
  ].join("\n");
}

type InventoryEntry = { path: string; kind: "file" | "directory" | "symlink"; bytes?: number; sha256?: string; target?: string };
/** The bundle's manifest entries for the Chrome folder, relative to it. */
function chromeInventory(bundleDirectory: string): InventoryEntry[] {
  const manifest = JSON.parse(readFileSync(join(bundleDirectory, "manifest.json"), "utf8")) as { chrome?: { executableSha256?: string }; files?: InventoryEntry[] };
  if (manifest.chrome?.executableSha256 !== browserBundleSpec("linux-x64").chrome.executableSha256 || !Array.isArray(manifest.files)) throw new Error("Browser bundle manifest does not match the pinned release");
  const prefix = `chrome/${CHROME_DIRECTORY}/`;
  return manifest.files.filter(entry => entry.path.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) }));
}
/** Who may own the copy and how: the system root, and nobody else with write access. */
export type EngineTrust = { owner: number };
const writableByOthers = (mode: number) => (mode & 0o022) !== 0;
/** Every folder from `path` up to `top` is a real folder (no link), owned by
 * `owner`, with no group or other write. Returns false on the first that is not. */
export function isTrustedEnginePath(path: string, trust: EngineTrust = { owner: 0 }, top: string = "/"): boolean {
  try {
    let current = resolve(path);
    const stop = resolve(top);
    for (;;) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || stat.uid !== trust.owner || writableByOthers(stat.mode)) return false;
      if (current === stop || dirname(current) === current) return true;
      current = dirname(current);
    }
  } catch { return false; }
}
/** Every file, folder and link under the copy matches the manifest, nothing else is there,
 * and (with `trust`) every one is owned by the owner with no group or other write. */
export function verifyLinuxEngineCopy(copy: string, inventory: InventoryEntry[], trust?: EngineTrust): boolean {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      found.push(relative(copy, path).split(sep).join("/"));
      if (lstatSync(path).isDirectory()) walk(path);
    }
  };
  try {
    walk(copy);
    if (JSON.stringify(found.sort()) !== JSON.stringify(inventory.map(entry => entry.path).sort())) return false;
    if (trust) { const top = lstatSync(copy); if (!top.isDirectory() || top.uid !== trust.owner || writableByOthers(top.mode)) return false; }
    for (const entry of inventory) {
      const path = join(copy, entry.path), stat = lstatSync(path);
      if (entry.kind === "directory" ? !stat.isDirectory() : entry.kind === "symlink" ? !stat.isSymbolicLink() : !stat.isFile() || stat.size !== entry.bytes) return false;
      if (trust && (stat.uid !== trust.owner || writableByOthers(stat.mode))) return false;
      if (entry.kind === "file" && createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256) return false;
    }
    return inventory.length > 0;
  } catch { return false; }
}

/** Murage's copy is missing, or is not exactly the verified, root-owned tree. Enable browser fixes it. */
export class LinuxEngineNotInstalled extends Error {}
const installed = new Map<string, Promise<string>>();
/** The verified system copy of the AppImage's Chrome. It is never made here:
 * only Enable browser's administrator step writes it. The path, every file and
 * the hashes are checked once per process; a missing or changed copy is refused
 * (and checked again next time). */
export function ensureLinuxEngineChrome(bundledChrome: string, deps: { root?: string; trust?: EngineTrust; top?: string } = {}): Promise<string> {
  const root = deps.root ?? LINUX_ENGINE_ROOT, trust = deps.trust ?? { owner: 0 };
  const target = linuxEngineChromePath(CHROME_VERSION, root);
  const key = JSON.stringify([resolve(bundledChrome), target, trust.owner]);
  let check = installed.get(key);
  if (!check) {
    check = (async () => {
      const inventory = chromeInventory(dirname(dirname(dirname(resolve(bundledChrome)))));
      const destination = dirname(target);
      if (!isTrustedEnginePath(destination, trust, deps.top) || !verifyLinuxEngineCopy(destination, inventory, trust)) throw new LinuxEngineNotInstalled("The browser copy is missing or has changed");
      return target;
    })();
    installed.set(key, check);
    check.catch(() => { if (installed.get(key) === check) installed.delete(key); });
  }
  return check;
}

/** The manifest, as the lines the root script checks: `d<TAB>path` and `f<TAB>sha256<TAB>path`. */
export function linuxEngineInventoryText(inventory: InventoryEntry[]): string {
  return inventory.map((entry) => {
    if (entry.kind === "symlink" || !/^[^\t\n\\]+$/u.test(entry.path) || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error(`The browser bundle has an entry Murage can't install (${entry.path})`);
    return entry.kind === "directory" ? `d\t${entry.path}` : `f\t${entry.sha256}\t${entry.path}`;
  }).join("\n");
}
/** Everything Enable browser hands the root script. */
export function linuxEngineEnablePlan(bundledChrome: string): { source: string; args: string[] } {
  const source = dirname(resolve(bundledChrome));
  const inventory = chromeInventory(dirname(dirname(source)));
  if (!verifyLinuxEngineCopy(source, inventory)) throw Object.assign(new Error("Murage's browser bundle is damaged. Reinstall Murage."), { status: 500, code: "browser_sandbox_enable_failed" });
  return { source, args: [CHROME_VERSION, linuxEngineBrowserProfile(), linuxEngineInventoryText(inventory), browserBundleSpec("linux-x64").chrome.executableSha256] };
}

/** What pkexec runs as root. The tar stream on stdin is the bundled Chrome
 * folder; the script never reads a path the owner's account could change.
 * Arguments: Chrome version, profile text, manifest lines, pinned sha256 of
 * the Chrome executable. Nothing is installed unless every check passes. */
export const LINUX_ENGINE_ENABLE_SCRIPT = [
  "set -eu",
  "umask 022",
  "owner=root:root",
  "top=/",
  `root=${LINUX_ENGINE_ROOT}`,
  `target=${LINUX_ENGINE_PROFILE_FILE}`,
  `chrome_dir=${CHROME_DIRECTORY}`,
  "version=$1; profile=$2; inventory=$3; exe_sha=$4",
  "stage=''; staged=''",
  "trap 'if [ -n \"$stage\" ]; then rm -rf -- \"$stage\"; fi; if [ -n \"$staged\" ]; then rm -f -- \"$staged\"; fi' EXIT",
  "fail() { echo \"$1\" >&2; exit 1; }",
  "case $version in ''|*[!0-9.]*) fail 'bad browser version';; esac",
  "user=${owner%%:*}",
  // Every folder from $1 up to $top is a real folder, owned by the administrator, with no group or other write.
  "check_chain() { p=$1; while :; do",
  "  bad=$(find \"$p\" -maxdepth 0 \\( ! -type d -o ! -user \"$user\" -o -perm /022 \\) -print)",
  "  [ -z \"$bad\" ] || fail \"$p is not a plain folder owned by $user that only $user can write\"",
  "  if [ \"$p\" = \"$top\" ] || [ \"$p\" = / ]; then break; fi; p=$(dirname \"$p\"); done; }",
  // Look at what is already there before making anything, so no folder is made through a link.
  "near=$root; while [ ! -e \"$near\" ] && [ ! -L \"$near\" ]; do near=$(dirname \"$near\"); done",
  "check_chain \"$near\"",
  "mkdir -p \"$root\"",
  "check_chain \"$root\"",
  "for old in \"$root\"/.copy-*; do if [ -e \"$old\" ] || [ -L \"$old\" ]; then rm -rf -- \"$old\"; fi; done",
  "stage=$(mktemp -d \"$root/.copy-XXXXXX\")",
  "head -c 1500000000 > \"$stage/in.tar\"",
  // Only plain files and folders, with names that stay inside the folder.
  "tar --list --verbose --numeric-owner --quoting-style=escape -f \"$stage/in.tar\" | awk '{c=substr($1,1,1); if (c!=\"-\" && c!=\"d\") bad=1} END{exit bad}' || fail 'the browser bundle holds more than files and folders'",
  "tar --list --quoting-style=escape -f \"$stage/in.tar\" | while IFS= read -r name; do case $name in /*|..|../*|*/../*|*/..) fail 'the browser bundle has a name outside its folder';; esac; done",
  "mkdir \"$stage/$chrome_dir\"",
  "tar --extract --no-same-owner --no-same-permissions --no-overwrite-dir -f \"$stage/in.tar\" -C \"$stage/$chrome_dir\"",
  "rm -f \"$stage/in.tar\"",
  "chown -R \"$owner\" \"$stage\"",
  "find \"$stage\" -type d -exec chmod 0755 {} +",
  "find \"$stage\" -type f -perm /111 -exec chmod 0755 {} +",
  "find \"$stage\" -type f ! -perm /111 -exec chmod 0644 {} +",
  // After the copy: exactly the manifest's files and folders, every hash, and the pinned Chrome.
  "dir=$stage/$chrome_dir",
  "want=$(printf '%s\\n' \"$inventory\" | awk -F'\\t' '{print $1\" \"$NF}' | LC_ALL=C sort)",
  "have=$(cd \"$dir\" && find . -mindepth 1 -printf '%y %P\\n' | LC_ALL=C sort)",
  "[ \"$want\" = \"$have\" ] || fail 'the copied browser does not match the browser bundle'",
  "printf '%s\\n' \"$inventory\" | awk -F'\\t' '$1==\"f\"{printf \"%s  %s\\n\", $2, $3}' | (cd \"$dir\" && sha256sum --check --quiet -) >&2 || fail 'a copied browser file has the wrong hash'",
  "printf '%s  chrome-headless-shell\\n' \"$exe_sha\" | (cd \"$dir\" && sha256sum --check --quiet -) >&2 || fail 'the copied Chrome is not the pinned release'",
  "final=$root/$version",
  "rm -rf -- \"$final\"",
  "mv -T \"$stage\" \"$final\"",
  "stage=''",
  "for old in \"$root\"/*; do n=${old##*/}; case $n in [0-9]*.[0-9]*.[0-9]*.[0-9]*) [ \"$n\" = \"$version\" ] || rm -rf -- \"$old\";; esac; done",
  "check_chain \"$final/$chrome_dir\"",
  "staged=$(mktemp /etc/apparmor.d/.murage-browser-engine.XXXXXX)",
  "printf '%s' \"$profile\" > \"$staged\"",
  "apparmor_parser --skip-kernel-load --skip-cache \"$staged\" > /dev/null",
  "chmod 0644 \"$staged\"",
  "mv -f \"$staged\" \"$target\"",
  "staged=''",
  "apparmor_parser --replace --write-cache --skip-read-cache \"$target\"",
].join("\n");

export type EnablePlan = (bundledChrome: string) => { source: string; args: string[] };
export type EnableOutcome = "enabled" | "cancelled";
/** Runs pkexec with these arguments, a tar stream of `tarDirectory` on its stdin. */
export type PkexecRun = (file: string, args: string[], tarDirectory: string) => Promise<{ code: number | null; stderr: string }>;
const runPkexec: PkexecRun = (file, args, tarDirectory) => new Promise((done) => {
  let stderr = "", settled = false;
  const finish = (code: number | null) => { if (!settled) { settled = true; done({ code, stderr }); } };
  const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const tar = spawn(TAR, ["-C", tarDirectory, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const timer = setTimeout(() => { child.kill("SIGKILL"); tar.kill("SIGKILL"); }, 10 * 60_000);
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4096); });
  tar.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on("error", () => {});
  tar.stdout.on("error", () => {});
  tar.stdout.pipe(child.stdin);
  tar.on("error", () => { child.kill("SIGKILL"); });
  child.on("error", () => { clearTimeout(timer); tar.kill("SIGKILL"); finish(null); });
  child.on("close", (code) => { clearTimeout(timer); tar.kill("SIGKILL"); finish(code); });
});
const DEB_ALTERNATIVE = "You can also install Murage from the .deb package instead.";
/** Asks for the administrator prompt and installs the browser copy and its
 * profile in that one step. pkexec exits 126 when the person closes the prompt
 * and 127 when it is refused. */
export async function enableLinuxEngineBrowser(bundledChrome: string, deps: { run?: PkexecRun; exists?: (file: string) => boolean; plan?: EnablePlan } = {}): Promise<EnableOutcome> {
  if (!(deps.exists ?? existsSync)(PKEXEC)) throw Object.assign(new Error(`This system has no administrator prompt (pkexec), so Murage can't add the browser's AppArmor rule. ${DEB_ALTERNATIVE}`), { status: 409, code: "browser_sandbox_no_prompt" });
  const plan = (deps.plan ?? linuxEngineEnablePlan)(bundledChrome);
  const result = await (deps.run ?? runPkexec)(PKEXEC, ["/bin/sh", "-c", LINUX_ENGINE_ENABLE_SCRIPT, "murage-enable-browser", ...plan.args], plan.source);
  if (result.code === 0) return "enabled";
  if (result.code === 126 || result.code === 127) return "cancelled";
  throw Object.assign(new Error(`Murage couldn't add the browser's AppArmor rule (${result.stderr.trim().split("\n").pop()?.slice(0, 160) || `exit ${result.code}`}). ${DEB_ALTERNATIVE}`), { status: 500, code: "browser_sandbox_enable_failed" });
}
