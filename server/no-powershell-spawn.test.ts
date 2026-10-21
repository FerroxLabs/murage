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
// a call that starts a program (its opening parenthesis is matched), and a shell option naming PowerShell
const LAUNCH = /(?:(?<![.\w$])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execa|execaSync)|\b(?:child_process\w*|childProcess|cp)\.(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\)?|\bShellExecute\w*)\s*\(/g;
const SHELL_OPTION = /\bshell\s*:\s*([^,}\n]*)/g;
// a launch descriptor: [executable, [arguments...]] (the shape electron/terminal-launch.mjs hands to its launcher)
const DESCRIPTOR = /\[\s*([^\[\],]+?)\s*,\s*\[/g;
const MENTION = /powershell|pwsh/i;
// a string that is, or ends in a path to, a console host that can start another program (cmd, conhost, wt) or the `start` command
const HOST_STRING = /(["'`])\s*(?:[^"'`\n]*[\\/])?(?:cmd|CMD|conhost|wt|start|explorer)(?:\.exe|\.EXE)?(?:\s+[\/-][^"'`\n]*|\s+""[^"'`\n]*|\s+start\b[^"'`\n]*)?\1/;
const DECLARATION = /(?:\b(export)\s+)?\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(.*)$/g;
const IMPORT_CLAUSE = /\bimport\s*(?:type\s*)?\{([^}]*)\}/g;
const IMPORT_ALIAS = /\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g;
const stringsOut = (code: string) => code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "S");
const open = (code: string) => { const bare = stringsOut(code); return (bare.match(/\(/g)?.length ?? 0) > (bare.match(/\)/g)?.length ?? 0); };
const escapeName = (name: string) => name.replace(/\$/g, "\\$");
const wordRegex = (names: Iterable<string>) => { const list = [...names].map(escapeName); return list.length ? new RegExp(`(?<![\\w$.])(?:${list.join("|")})(?![\\w$])`) : null; };
// The one launch site user_terminal allows (electron/terminal-launch.mjs): cmd's `start` opens PowerShell in a console window of its
// own, argv exactly powershell.exe -NoExit, nothing else. Any other character in the descriptor makes it a different launch.
const USER_TERMINAL_FILE = "electron/terminal-launch.mjs";
const USER_TERMINAL_LAUNCH = /^\[cmd, \["\/d", "\/c", `start "" "\$\{powershell\}" -NoExit`\], \{ windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore", env: clean, \.\.\.\(profile \? \{ cwd: profile \} : \{\}\) \}, "user_terminal"\]$/;

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
  user_terminal: Record<string, { reason: string; lines: Record<string, string>; launches?: Record<string, string> }>;
  open_spawns: Record<string, unknown>;
}
interface Finding { file: string; line: number; fingerprint: string; text: string }

/** An initializer that only strings, names, joins and a choice between them can build (no object, array, function or block): a value
 *  that is itself a program name, as against code that merely mentions one. */
const constantExpression = (init: string) => /^[\s\w$.+,()?:|&!=]*;?\s*$/.test(stringsOut(init));

/** Names that hold PowerShell (or a console host such as cmd) through a constant: a string constant naming powershell/pwsh, a path to
 *  it, or anything built from such a constant. A name exported from one file is known in every file (and through `import { A as B }`),
 *  so spawn(WINDOWS_FALLBACK_SHELL, ...) is seen for what it launches; any other name is known in its own file only. */
function constantNames(files: Record<string, string>) {
  interface Declaration { name: string; init: string; exported: boolean }
  const declarations = new Map<string, Declaration[]>(), aliases = new Map<string, Array<[string, string]>>();
  for (const [file, text] of Object.entries(files)) {
    const rows = text.split("\n").map(line => (isComment(line) ? "" : line)), mine: Declaration[] = [], renamed: Array<[string, string]> = [];
    rows.forEach((row, at) => {
      for (const match of row.matchAll(DECLARATION)) {
        // The rest of the line; a call left open (win32.join(...) over several lines) continues onto the next lines.
        let init = match[3]!;
        for (let next = at + 1; next < rows.length && next <= at + 4 && open(init); next += 1) init += `\n${rows[next]}`;
        mine.push({ name: match[2]!, init, exported: !!match[1] });
      }
      for (const clause of row.matchAll(IMPORT_CLAUSE)) for (const match of clause[1]!.matchAll(IMPORT_ALIAS)) renamed.push([match[1]!, match[2]!]);
    });
    declarations.set(file, mine);
    aliases.set(file, renamed);
  }
  const grow = (seed: (init: string) => boolean) => {
    const fixpoint = (start: Set<string>, rows: Declaration[], renamed: Array<[string, string]>) => {
      const found = new Set(start);
      for (let changed = true; changed;) {
        changed = false;
        const known = wordRegex(found);
        for (const { name, init } of rows) if (!found.has(name) && ((constantExpression(init) && seed(init)) || (known?.test(init) && constantExpression(init)))) { found.add(name); changed = true; }
        for (const [from, to] of renamed) if (found.has(from) && !found.has(to)) { found.add(to); changed = true; }
      }
      return found;
    };
    const everywhere = fixpoint(new Set(), [...declarations.values()].flat().filter(row => row.exported), []);
    return (file: string) => fixpoint(everywhere, declarations.get(file) ?? [], aliases.get(file) ?? []);
  };
  return { powershell: grow(init => PROGRAM.test(init) || FOLDER.test(init)), host: grow(init => HOST_STRING.test(init)) };
}

/** From an opening ( or [ at `open`, its contents up to the matching close and the top-level pieces split on commas. */
function bracketed(text: string, open: number) {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [], pieces: string[] = [];
  let quote = "", from = open + 1;
  for (let at = open; at < text.length && at < open + 4000; at += 1) {
    const char = text[at]!;
    if (quote) { if (char === "\\") at += 1; else if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (pairs[char]) { stack.push(pairs[char]!); continue; }
    if (char === "," && stack.length === 1) { pieces.push(text.slice(from, at)); from = at + 1; continue; }
    if (stack.length && char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) { pieces.push(text.slice(from, at)); return { whole: text.slice(open, at + 1), pieces }; }
    }
  }
  return { whole: text.slice(open, open + 4000), pieces };
}

/** The guard over a set of files ({ "server/x.ts": text }): what holds a PowerShell name, what launches PowerShell, and how that
 *  compares with the allowlist. Every array empty: clean. A launch is anything that starts PowerShell directly, through a constant
 *  that names it, or through cmd / start / conhost / wt arguments; the one user_terminal launch is allowed by its exact text. */
export function scanForPowerShell(files: Record<string, string>, list: Allowlist) {
  const holders: Finding[] = [], launches: Finding[] = [], userTerminalLaunches: Finding[] = [];
  const names = constantNames(files);
  let powershellName: RegExp | null = null, hostName: RegExp | null = null;
  const namesPowerShell = (text: string) => MENTION.test(text) || !!powershellName?.test(text);
  const namesHost = (text: string) => HOST_STRING.test(text) || !!hostName?.test(text);
  for (const [file, text] of Object.entries(files)) {
    powershellName = wordRegex(names.powershell(file));
    hostName = wordRegex(names.host(file));
    const lines = text.split("\n");
    const code = lines.map(line => (isComment(line) ? " ".repeat(line.length) : line)).join("\n");
    const lineStarts: number[] = [];
    for (let at = 0, n = 0; n < lines.length; n += 1) { lineStarts.push(at); at += lines[n]!.length + 1; }
    const lineOf = (index: number) => { let low = 0, high = lineStarts.length - 1; while (low < high) { const mid = (low + high + 1) >> 1; if (lineStarts[mid]! <= index) low = mid; else high = mid - 1; } return low; };
    const findingAt = (index: number): Finding => { const n = lineOf(index); return { file, line: n + 1, fingerprint: fingerprint(lines[n]!), text: lines[n]!.trim().slice(0, 160) }; };
    lines.forEach((line, index) => {
      if (isComment(line)) return;
      if (PROGRAM.test(line) || FOLDER.test(line)) holders.push({ file, line: index + 1, fingerprint: fingerprint(line), text: line.trim().slice(0, 160) });
    });
    const flagged = new Map<string, Finding>(), exact = new Map<string, Finding>();
    const flag = (index: number) => { const finding = findingAt(index); flagged.set(`${finding.line}`, finding); };
    for (const match of code.matchAll(LAUNCH)) {
      const call = bracketed(code, match.index! + match[0].length - 1), first = call.pieces[0] ?? "", rest = call.pieces.slice(1).join(",");
      if (namesPowerShell(first) || (namesHost(first) && namesPowerShell(rest))) flag(match.index!);
      for (const option of call.whole.matchAll(SHELL_OPTION)) if (namesPowerShell(option[1] ?? "")) flag(match.index!);
    }
    for (const match of code.matchAll(SHELL_OPTION)) if (namesPowerShell(match[1] ?? "")) flag(match.index!);
    for (const match of code.matchAll(DESCRIPTOR)) {
      if (!namesHost(match[1] ?? "")) continue;
      const open = match.index!, whole = bracketed(code, open).whole;
      if (!namesPowerShell(whole)) continue;
      const finding = findingAt(open), normal = whole.replace(/\s+/g, " ");
      if (file === USER_TERMINAL_FILE && USER_TERMINAL_LAUNCH.test(normal)) exact.set(`${finding.line}`, finding); else flag(open);
    }
    launches.push(...flagged.values());
    userTerminalLaunches.push(...exact.values());
  }
  const listed = (group: Allowlist["names_only"], { file, fingerprint: print }: Finding) => Object.hasOwn(group, file) && Object.hasOwn(group[file]!.lines, print);
  const unlisted = holders.filter(finding => !listed(list.names_only, finding) && !listed(list.user_terminal, finding));
  // The user_terminal launch is the exact site above, once, and its fingerprint is on the list; every other launch is forbidden.
  const permitted = userTerminalLaunches.slice(0, 1).filter(finding => Object.hasOwn(list.user_terminal[finding.file]?.launches ?? {}, finding.fingerprint));
  const forbiddenLaunches = [...launches, ...userTerminalLaunches.filter(finding => !permitted.includes(finding))];
  const seen = new Set(holders.map(({ file, fingerprint: print }) => `${file}\u0000${print}`));
  const stale = [...Object.entries(list.names_only), ...Object.entries(list.user_terminal)].flatMap(([file, entry]) => Object.keys(entry.lines).filter(print => !seen.has(`${file}\u0000${print}`)).map(print => `${file} ${print}`));
  const staleLaunches = Object.entries(list.user_terminal).flatMap(([file, entry]) => Object.keys(entry.launches ?? {}).filter(print => !permitted.some(finding => finding.file === file && finding.fingerprint === print)).map(print => `${file} ${print}`));
  return { holders, launches, userTerminalLaunches: permitted, unlisted, forbiddenLaunches, stale: [...stale, ...staleLaunches] };
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
    // ...and the launch of it is exactly one site, whose arguments are exactly powershell.exe -NoExit (USER_TERMINAL_LAUNCH), in that file.
    expect(result.userTerminalLaunches).toHaveLength(1);
    expect(result.userTerminalLaunches[0]!.file).toBe("electron/terminal-launch.mjs");
    expect(Object.keys(list.user_terminal["electron/terminal-launch.mjs"]!.launches ?? {})).toEqual([result.userTerminalLaunches[0]!.fingerprint]);
    expect(shipped["electron/terminal-launch.mjs"]).toMatch(/^\s*const cmd = win32\.join\(root, "System32", "cmd\.exe"\);$/m);
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

    const terminal = shipped["electron/terminal-launch.mjs"]!;
    const site = terminal.split("\n").find(line => line.includes('out.push([cmd, ["/d"'))!;
    const scan = (extra: Record<string, string>, base: Record<string, string> = shipped) => scanForPowerShell({ ...base, ...extra }, list).forbiddenLaunches.map(finding => `${finding.file}:${finding.text}`);
    it("the real user_terminal launch passes, and is the only launch", () => {
      expect(scan({})).toEqual([]);
    });
    it("a launch through a constant that names PowerShell fails (spawn(WINDOWS_FALLBACK_SHELL, ...))", () => {
      expect(scan({ "server/c1.ts": 'import { WINDOWS_FALLBACK_SHELL } from "../electron/terminal-launch.mjs";\nspawn(WINDOWS_FALLBACK_SHELL, ["-NoExit"]);' })).toEqual(['server/c1.ts:spawn(WINDOWS_FALLBACK_SHELL, ["-NoExit"]);']);
      expect(scan({ "server/c2.ts": 'import { WINDOWS_FALLBACK_SHELL as SHELL } from "../electron/terminal-launch.mjs";\nexecFile(SHELL, []);' })).toHaveLength(1);
      expect(scan({ "server/c3.ts": 'const SHELL = "pwsh";\nconst PROGRAM = SHELL;\nspawnSync(\n  PROGRAM,\n  [],\n);' })).toHaveLength(1);
      expect(scan({ "server/c4.ts": 'const options = { shell: WINDOWS_FALLBACK_SHELL };\nspawn("tool", [], options);' })).toHaveLength(1);
      expect(scan({ "server/c5.ts": "exec(`cmd /c start ${WINDOWS_FALLBACK_SHELL}`);" })).toHaveLength(1);
    });
    it("a launch through cmd / start / conhost / wt arguments that include PowerShell fails", () => {
      for (const [index, code] of [
        'spawn("cmd.exe", ["/c", "start", "powershell"]);',
        'execFile("C:\\\\Windows\\\\System32\\\\cmd.exe", ["/d", "/c", "start", "", "pwsh.exe", "-NoExit"]);',
        'exec("cmd /c start powershell");',
        'spawn("conhost.exe", ["powershell.exe"]);',
        'spawn("wt.exe", ["-p", "pwsh"]);',
        'spawn("start", ["powershell"], { shell: true });',
        'const host = "cmd.exe";\nspawn(host, ["/c", "start", WINDOWS_FALLBACK_SHELL]);',
        'const shell = "powershell.exe";\nspawn("cmd", [\n  "/c",\n  "start",\n  shell,\n]);',
        'out.push(["cmd.exe", ["/c", `start "" "${WINDOWS_FALLBACK_SHELL}"`], {}, "x"]);',
      ].entries()) expect(scan({ [`server/h${index}.ts`]: code }), code).toHaveLength(1);
    });
    it("a second copy of the user_terminal launch, anywhere, and any change to its arguments fail", () => {
      expect(scan({ "server/second.ts": `const cmd = "cmd.exe";\nconst powershell = "powershell.exe";\n${site.trim()}` })).toHaveLength(1);
      expect(scan({ "electron/terminal-launch.mjs": `${terminal}\n${site.trim()}` })).toHaveLength(1);
      for (const changed of [site.replace("-NoExit`", "-NoExit -Command x`"), site.replace("-NoExit", "-NoProfile"), site.replace("start", "start /wait"), site.replace('"/c"', '"/k"'), site.replace("stdio: \"ignore\"", "stdio: \"pipe\"")]) {
        expect(changed).not.toBe(site);
        expect(scan({ "electron/terminal-launch.mjs": terminal.replace(site, changed) }), changed).toHaveLength(1);
      }
    });
    it("the user_terminal exception does not cover the same text in another file", () => {
      expect(scan({ "server/elsewhere.mjs": `const cmd = win32.join(root, "System32", "cmd.exe");\nconst powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");\n${site.trim()}`, "electron/terminal-launch.mjs": terminal })).toHaveLength(1);
    });
  });
});
