import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const hook=readFileSync(new URL("../build/windows-sandbox-acl.nsh",import.meta.url),"utf8");
const builder=readFileSync(new URL("../electron-builder.yml",import.meta.url),"utf8");
it.each(["\n", "\r\n"])("runs the package permission hook with %j line endings",(lineEnding)=>{
 expect(builder.replace(/\r?\n/g,lineEnding)).toMatch(/nsis:\r?\n  include: build\/windows-sandbox-acl\.nsh/);
 expect(hook).toContain("!macro customInstall");
 expect(hook).not.toMatch(/isUpdated|isNotUpdated|isReinstall/);
});
it("grants restricted packages inheritable RX once on the quoted installation tree",()=>{
 const commands=hook.split("\n").filter(line=>line.includes("nsExec::ExecToStack"));
 const grant='\'"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /C /Q\'';
 expect(commands).toHaveLength(2);
 for(const command of commands){
  expect(command).toContain(grant);
  expect(command).toContain("/TIMEOUT=600000");
  expect(command).not.toMatch(/\/T\b|\/L\b/);
  expect(command).not.toMatch(/\/(reset|inheritance|remove|setowner)|\(F\)|\(M\)|\(W\)|\(D\)|APPDATA|PROFILE|MURAGE_DATA_DIR/i);
 }
 expect(hook.match(/\*S-1-/g)).toHaveLength(2);
 expect(hook.match(/\(RX\)/g)).toHaveLength(2+0);
});
it("retries once, then logs a failed grant and lets the install finish",()=>{
 expect(hook.match(/StrCmp \$0 "0" murage_lpac_ready/g)).toHaveLength(2);
 expect(hook).toContain("Retrying sandboxed application runtime permissions");
 expect(hook).toMatch(/DetailPrint "Sandboxed application runtime permissions were not set/);
 expect(hook).toContain("murage_lpac_ready:");
 expect(hook).not.toMatch(/SetErrorLevel|Abort\b|Quit\b/);
});
