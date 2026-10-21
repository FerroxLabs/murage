// Murage must not start PowerShell by itself on Windows (murage-releases #1: an antivirus notice and a visible start on every
// launch; the packaged Windows smoke step 5 fails on any app-spawned powershell.exe). This guard reads every shipped code file
// (server/, electron/ including the vendored bundles, shared/, installer/lib/ and the packaged script) and finds each LINE that
// holds a PowerShell program name as a code string. Each such line must be on server/no-powershell-spawn.allowlist.json by its
// fingerprint (sha256 of the trimmed line), with a written reason for its file: a new line, even inside a file already listed,
// fails until it is reviewed, and a listed line that is gone fails too, so the list cannot go stale (Astra nops #8).
// Independently, every executable launch site whose target is PowerShell fails, wherever it is and whatever the list says, unless
// it is the one user_terminal entry: the person's own Open terminal (MurageMain, nops round 3, C).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "testing", "__snapshots__", "testdata", "fixtures", "dist", "dist-native"]);
const SHIPPED_ROOTS = ["server", "electron", "shared", "installer/lib"];
const SHIPPED_FILES = ["scripts/browser-extension-host-registration.mjs"];
// a string that is, or ends in a path to, powershell / pwsh (".exe" optional), or the System32 PowerShell folder
const PROGRAM = /(["'`])(?:[^"'`\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?\1/i;
const FOLDER = /WindowsPowerShell[\\/]+v1/;
// a call that starts a program, with its first argument (the program) captured, and a shell option naming PowerShell
const LAUNCH = /(?:(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execa|execaSync)|\b(?:child_process\w*|childProcess|cp)\.(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\)?|\bShellExecute\w*)\s*\(\s*([^,)]*)/g;
const SHELL_OPTION = /\bshell\s*:\s*[^,}\n]*(?:powershell|pwsh)/i;
const MENTION = /powershell|pwsh/i;

function shippedFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) shippedFiles(join(dir, entry.name), out); continue; }
    if (!/\.(?:ts|tsx|mjs|js|cjs)$/.test(entry.name) || /\.(?:test|node-test|spec)\./.test(entry.name) || /\.d\.m?ts$/.test(entry.name)) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

const isComment = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);
const fingerprint = (line: string) => createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
interface Allowlist {
  _about: string;
  names_only: Record<string, { reason: string; lines: Record<string, string> }>;
  user_terminal: Record<string, { reason: string; lines: Record<string, string> }>;
  open_spawns: Record<string, unknown>;
}
interface Finding { file: string; line: number; fingerprint: string; text: string }

/** The guard over a set of files ({ "server/x.ts": text }): what holds a PowerShell name, what launches PowerShell, and how that
 *  compares with the allowlist. Every array empty: clean. */
export function scanForPowerShell(files: Record<string, string>, list: Allowlist) {
  const holders: Finding[] = [], launches: Finding[] = [];
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      const finding = { file, line: index + 1, fingerprint: fingerprint(line), text: line.trim().slice(0, 160) };
      if (PROGRAM.test(line) || FOLDER.test(line)) holders.push(finding);
      // A launch call on this line whose program (its first argument, which may run onto the next two lines) names PowerShell.
      const window = [line, lines[index + 1] ?? "", lines[index + 2] ?? ""].filter(part => !isComment(part)).join("\n");
      const launchesPowerShell = [...window.matchAll(LAUNCH)].some(match => match.index! < line.length && MENTION.test(match[1] ?? ""));
      if (launchesPowerShell || SHELL_OPTION.test(line)) launches.push(finding);
    });
  }
  const listed = (group: Allowlist["names_only"], { file, fingerprint: print }: Finding) => Object.hasOwn(group, file) && Object.hasOwn(group[file]!.lines, print);
  const unlisted = holders.filter(finding => !listed(list.names_only, finding) && !listed(list.user_terminal, finding));
  // A launch site is allowed only as the one user_terminal line itself.
  const forbiddenLaunches = launches.filter(finding => !listed(list.user_terminal, finding));
  const seen = new Set(holders.map(({ file, fingerprint: print }) => `${file}\u0000${print}`));
  const stale = [...Object.entries(list.names_only), ...Object.entries(list.user_terminal)].flatMap(([file, entry]) => Object.keys(entry.lines).filter(print => !seen.has(`${file}\u0000${print}`)).map(print => `${file} ${print}`));
  return { holders, launches, unlisted, forbiddenLaunches, stale };
}

const relativeName = (file: string) => relative(root, file).split("\\").join("/");
const shipped = Object.fromEntries([...SHIPPED_ROOTS.flatMap(dir => shippedFiles(join(root, dir))), ...SHIPPED_FILES.map(file => join(root, file)).filter(existsSync)]
  .map(file => [relativeName(file), readFileSync(file, "utf8")]));
const list = JSON.parse(readFileSync(join(root, "server", "no-powershell-spawn.allowlist.json"), "utf8")) as Allowlist;
const result = scanForPowerShell(shipped, list);

describe("no app-spawned PowerShell", () => {
  it("reads the shipped vendored bundles too (electron/vendor)", () => {
    expect(Object.keys(shipped).filter(file => file.startsWith("electron/vendor/")).sort()).toEqual(["electron/vendor/electron-updater.cjs", "electron/vendor/ws.cjs"]);
  });
  it("every shipped line naming PowerShell as a program is on the allowlist by its fingerprint", () => {
    expect(result.unlisted, "not allowlisted: remove it or add its fingerprint with a reason").toEqual([]);
  });
  it("no shipped code launches PowerShell, except the one user_terminal entry", () => {
    expect(result.forbiddenLaunches, "a PowerShell launch").toEqual([]);
  });
  it("every allowlist entry is current and carries a written reason", () => {
    expect(result.stale, "stale fingerprints").toEqual([]);
    for (const [file, entry] of [...Object.entries(list.names_only), ...Object.entries(list.user_terminal)]) {
      expect(entry.reason.trim().length, file).toBeGreaterThan(40);
      expect(Object.keys(entry.lines).length, file).toBeGreaterThan(0);
    }
  });
  it("user_terminal is exactly one line: the Open terminal fallback's PowerShell program", () => {
    expect(Object.keys(list.user_terminal)).toEqual(["electron/terminal-launch.mjs"]);
    const lines = Object.keys(list.user_terminal["electron/terminal-launch.mjs"]!.lines);
    expect(lines).toHaveLength(1);
    const holder = result.holders.find(finding => finding.file === "electron/terminal-launch.mjs" && finding.fingerprint === lines[0]);
    expect(holder?.text).toMatch(/^const powershell = win32\.join\(root, "System32", "WindowsPowerShell", "v1\.0", "powershell\.exe"\);$/);
  });
  it("no open spawn is left: Murage starts no PowerShell by itself (1.0.3, no deferral)", () => {
    expect(Object.keys(list.open_spawns)).toEqual([]);
  });
  it("no PowerShell script ships with the server", () => {
    const scripts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? (SKIP_DIRS.has(entry.name) ? [] : scripts(join(dir, entry.name))) : /\.ps1$/i.test(entry.name) ? [relative(root, join(dir, entry.name))] : []);
    expect(scripts(join(root, "server"))).toEqual([]);
  });
  it("the replaced paths hold no PowerShell string any more", () => {
    for (const file of ["server/drivers/process-tree.ts", "server/drivers/win-process-table.ts", "server/memory/pip-reaper.ts", "server/browser-native-relay.ts", "server/engine-env.ts", "electron/backup-windows-acl.mjs", "electron/companion-stale.mjs",
      "server/tts/windows-voices.ts", "server/memory/pip-job.ts", "server/procs.ts", "server/browser-sandbox.ts", "server/browser-windows-identity.ts", "electron/backup-folder-check.mjs", "electron/data-dir-lease.mjs",
      "electron/vendor/electron-updater.cjs", "electron/updater.mjs", "electron/windows-update-signature.mjs"]) {
      expect(result.holders.filter(finding => finding.file === file), file).toEqual([]);
      expect(file in list.names_only, file).toBe(false);
    }
  });

  // Astra nops #8: the old guard exempted whole files, so a new spawn in an already-listed file passed.
  describe("the guard itself", () => {
    const index = shipped["server/index.ts"]!;
    it("a new PowerShell spawn inside an already-listed file fails, as an unlisted line and as a launch", () => {
      const found = scanForPowerShell({ ...shipped, "server/index.ts": `${index}\nspawn("powershell.exe", ["-NoProfile"]);` }, list);
      expect(found.unlisted.map(finding => finding.file)).toEqual(["server/index.ts"]);
      expect(found.forbiddenLaunches.map(finding => finding.text)).toEqual(['spawn("powershell.exe", ["-NoProfile"]);']);
    });
    it("a launch fails even when its line was put on the names-only list", () => {
      const line = 'execFile(powershell(env), ["-NoProfile", "-EncodedCommand", script]);';
      const sneaky: Allowlist = { ...list, names_only: { ...list.names_only, "server/index.ts": { ...list.names_only["server/index.ts"]!, lines: { ...list.names_only["server/index.ts"]!.lines, [fingerprint(line)]: "x" } } } };
      const found = scanForPowerShell({ ...shipped, "server/index.ts": `${index}\nconst powershell = (env) => "powershell.exe";\n${line}` }, sneaky);
      expect(found.forbiddenLaunches.map(finding => finding.text)).toEqual([line]);
    });
    it("a launch written over several lines, a shell option and a launch in the vendored code all fail", () => {
      const found = scanForPowerShell({
        "server/a.ts": 'const child = spawn(\n  "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",\n  [],\n);',
        "server/b.ts": 'execFile(cmd, args, { shell: "pwsh" });',
        "electron/vendor/x.cjs": '(0, child_process_1.execFile)("powershell.exe", ["-Command", c]);',
        "electron/terminal-launch.mjs": 'export function other() { spawn("powershell.exe", []); }',
      }, list);
      expect(found.forbiddenLaunches.map(finding => finding.file).sort()).toEqual(["electron/terminal-launch.mjs", "electron/vendor/x.cjs", "server/a.ts", "server/b.ts"]);
    });
  });
});
