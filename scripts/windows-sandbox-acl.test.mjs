import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const hook=readFileSync(new URL("../build/windows-sandbox-acl.nsh",import.meta.url),"utf8");
const builder=readFileSync(new URL("../electron-builder.yml",import.meta.url),"utf8");
it.each(["\n", "\r\n"])("runs the package permission hook with %j line endings",(lineEnding)=>{
 expect(builder.replace(/\r?\n/g,lineEnding)).toMatch(/nsis:\r?\n  include: build\/windows-sandbox-acl\.nsh/);
 expect(hook).toContain("!macro customInstall");
 expect(hook).not.toMatch(/isUpdated|isNotUpdated|isReinstall/);
});
it("grants restricted packages RX only on the quoted installation tree",()=>{
 const command=hook.split("\n").find(line=>line.includes("nsExec::ExecToStack"));
 expect(command).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /L /Q');
 expect(command).not.toMatch(/\/(reset|inheritance|remove|setowner)|\(F\)|\(M\)|APPDATA|PROFILE|MURAGE_DATA_DIR/i);
 expect(command).toContain("/TIMEOUT=60000");
});
it("treats nonzero/error/timeout as failure instead of launching after an unverified grant",()=>{
 expect(hook).toContain('StrCmp $0 "0" murage_lpac_ready');
 expect(hook).toContain("SetErrorLevel 2");expect(hook).toContain('Abort "Unable to prepare Murage application folder permissions."');
 expect(hook).toContain("IfSilent murage_lpac_no_dialog");
});
