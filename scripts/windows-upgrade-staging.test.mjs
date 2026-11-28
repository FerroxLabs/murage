import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// The NSIS sources are matched across lines: read them with LF endings
// whatever the checkout wrote (a Windows checkout with core.autocrlf is CRLF;
// makensis accepts either).
const nsh = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const staging = nsh("../build/windows-upgrade-staging.nsh");
const install = nsh("../build/windows-sandbox-acl.nsh");

it("leaves fresh installations outside legacy staging", () => {
  const freshGuard = staging.indexOf('IfFileExists "$INSTDIR\\Uninstall ${PRODUCT_FILENAME}.exe" 0 murage_stage_done');
  expect(freshGuard).toBeGreaterThan(-1);
  expect(freshGuard).toBeLessThan(staging.indexOf('ReadEnvStr $murageSavedTemp "TEMP"'));
});

it("admits only a writable staging prefix no longer than the installed prefix", () => {
  expect(staging).toContain('GetFullPathName /SHORT $murageStageRoot "$PROFILE"');
  expect("\\nssBDA1.tmp\\old-install\\").toHaveLength(25);
  expect(staging).toContain("IntOp $0 $0 + 25");
  expect(staging).toContain("IntOp $1 $1 + 1");
  // 1.0.21: a longer staging prefix no longer aborts by itself (it ended every upgrade of a short /D= folder with
  // exit 2); it goes to the measured check below, which still aborts when a staged path would not fit.
  expect(staging).toContain("IntCmp $0 $1 murage_stage_probe murage_stage_probe murage_stage_measure");
  expect(staging).toContain('GetTempFileName $2 "$murageStageRoot"\n  IfErrors murage_stage_fail\n  Delete "$2"\n  IfErrors murage_stage_fail');
});

it("uses process environment only and preserves missing variables on restoration", () => {
  for (const name of ["TEMP", "TMP"]) {
    expect(staging).toContain(`SetEnvironmentVariableW(w "${name}", p 0)`);
    expect(staging).toContain(`SetEnvironmentVariableW(w "${name}", w "$murageStageRoot")`);
  }
  expect(staging).not.toMatch(/WriteReg|setx|SetFileAttributes|icacls|RMDir|ExecWait|--delete-app-data/);
  expect(staging).toContain("Call MurageRestoreStagingEnvironment\n  Pop $2");
});

it("restores before the existing ACL helper and aborts on restoration failure", () => {
  expect(install.indexOf("!insertmacro murageRestoreUpgradeEnvironment")).toBeLessThan(install.indexOf("nsExec::ExecToStack"));
  expect(staging).toContain('StrCmp $murageRestoreFailed "0" murage_environment_restored\n    SetErrorLevel 2\n    Abort');
  expect(staging).toContain('StrCpy $murageTempRedirected "1"\n  System::Call');
});

// The measured check, as the installer runs it. $0 = staging prefix length, $1 = installed prefix length, both set by
// the lines asserted above; $2 = the helper's answer.
const measure = staging.slice(staging.indexOf("  murage_stage_measure:"), staging.indexOf("  murage_stage_probe:"));
const instructions = measure.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith(";"));
const helper = /-Command "(.*)"'$/.exec(instructions.find(line => line.startsWith("nsExec::ExecToStack")) ?? "")?.[1]?.replaceAll("$$", "$");

/** Runs the measured check's own NSIS lines (integer compare and arithmetic only) for one helper answer. */
function admits({ stagePrefix, installedPrefix, answer }) {
  const reg = { $0: stagePrefix, $1: installedPrefix, $2: 0 };
  const int = word => (word in reg ? reg[word] : /^-?\d+$/.test(word) ? Number(word) : 0); // NSIS reads a non-number as 0
  const tail = instructions.slice(instructions.findIndex(line => line.startsWith("System::Call") && line.includes("p 0)")) + 1);
  reg.$2 = /^-?\d+$/.test(String(answer)) ? Number(answer) : 0;
  for (const line of tail) {
    const [op, a, b, c, d, e] = line.split(/\s+/);
    if (op === "IntOp") { reg[a] = c === "+" ? int(b) + int(d) : c === "-" ? int(b) - int(d) : NaN; continue; }
    if (op !== "IntCmp") throw new Error(`unexpected instruction in the measured check: ${line}`);
    const target = int(a) === int(b) ? c : int(a) < int(b) ? d : e;
    if (target === "0" || target === undefined) continue;
    return target === "murage_stage_probe";
  }
  throw new Error("the measured check fell through without a verdict");
}

// Behaviour first, shape after: a mutant of the compare lines must fail on the verdict it changes, not on source text.
it("a short /D= folder upgrades when every staged path fits, and still aborts when one does not", () => {
  // The canary folder: 38 characters, profile 15. Prefixes 40 and 39; its longest path was far below the limit.
  const canary = { stagePrefix: 15 + 25, installedPrefix: 38 + 1 };
  expect(admits({ ...canary, answer: 39 + 180 })).toBe(true);
  // Exactly at the limit, and one past it: staged length = answer - installed prefix + staging prefix.
  expect(admits({ ...canary, answer: 247 - 40 + 39 })).toBe(true);
  expect(admits({ ...canary, answer: 247 - 40 + 39 + 1 })).toBe(false);
  // Unmeasured: the helper's 0, a helper that did not start or timed out, a stray small or negative exit code.
  for (const answer of [0, "error", "timeout", 1, 39, -1073741502]) expect(admits({ ...canary, answer })).toBe(false);
  // The model above runs exactly these four compare/arithmetic lines and ends on the limit check.
  expect(instructions.filter(line => line.startsWith("IntCmp") || line.startsWith("IntOp"))).toHaveLength(4);
  expect(instructions.at(-1)).toBe("IntCmp $2 247 murage_stage_probe murage_stage_probe murage_stage_fail");
});

it("the measuring helper reads the folder from the environment and answers 0 on any failure", () => {
  expect(helper).toBe("try { $m = 0; Get-ChildItem -LiteralPath $env:MURAGE_STAGE_INSTDIR -Recurse -Force -ErrorAction Stop | ForEach-Object { if ($_.FullName.Length -gt $m) { $m = $_.FullName.Length } }; exit $m } catch { exit 0 }");
  expect(helper).not.toMatch(/["'`]/); // nothing to quote: the folder never enters the command line
  expect(measure).toContain(`SetEnvironmentVariableW(w "MURAGE_STAGE_INSTDIR", w "$INSTDIR") i .r2'\n  StrCmp $2 "0" murage_stage_fail`);
  expect(measure).toContain('SetEnvironmentVariableW(w "MURAGE_STAGE_INSTDIR", p 0)');
  // The exit code is taken and the helper's output dropped, leaving the installer stack as it was.
  expect(instructions.slice(4, 7)).toEqual(["Pop $2", "Exch $2", "Pop $2"]);
});

it.runIf(process.platform === "win32")("on Windows the helper answers the longest path, and 0 for a folder it cannot read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "murage stage 'probe "));
  try {
    const deep = path.join(root, "resources", "a folder", "deeper");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(root, "Uninstall Murage.exe"), "");
    writeFileSync(path.join(deep, "the-longest-file-name.txt"), "");
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = folder => spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", helper], { env: { ...process.env, MURAGE_STAGE_INSTDIR: folder }, windowsHide: true, timeout: 60_000 }).status;
    expect(run(root)).toBe(path.join(deep, "the-longest-file-name.txt").length);
    expect(run(path.join(root, "absent"))).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
