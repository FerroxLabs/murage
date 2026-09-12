import { readFileSync } from "node:fs";
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
  expect(staging).toContain("IntCmp $0 $1 murage_stage_probe murage_stage_probe murage_stage_fail");
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
