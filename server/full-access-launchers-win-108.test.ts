// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCli } from "./procs.ts";
import { autoVerdict } from "./auto-approve.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) removeTempDirSync(path); });
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const judge = (command: string) => autoVerdict({ autoApprove: true, fullAccess: true }, "PowerShell", command, { commandText: command, fullAccessOrigin: "owner", stopLine: null });
const execute = (shell: string, command: string, cwd: string) => new Promise<string>((resolve, reject) => execCli(shell, ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, env: process.env, timeout: 10_000 }, (error, text) => error ? reject(error) : resolve(text)));
describe.runIf(process.platform === "win32")("108 required Windows literal launcher fixtures", () => {
  it.each(["powershell.exe", "pwsh.exe"])("reads Git Bash payload argv under %s; unreadable launchers still ask", async shell => {
    const cwd = mkdtempSync(join(tmpdir(), "launch108-")); roots.push(cwd);
    const command = "bash -c 'printf marker108'";
    expect(judge(command).approve).not.toBeNull();
    expect((await execute(shell, command, cwd)).trim()).toBe("marker108");
    // Harmless argv capture establishes what the deferred form does on both shells.
    const script = join(cwd, "capture.cjs"), marker = join(cwd, "args.json");
    writeFileSync(script, "require('node:fs').writeFileSync('args.json',JSON.stringify(process.argv.slice(2)))");
    const start = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList 'capture.cjs','marker108' -Wait -NoNewWindow`;
    expect(judge(start).approve).toBeNull(); await execute(shell, start, cwd);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["marker108"]);
    expect(judge("python -c 'print(1)'").approve).not.toBeNull();
    for (const unreadable of ["wsl -e echo marker108", 'bash -c "echo $env:USERNAME"', "bash --login -c 'echo marker108'", "Set-Content x.ps1 'echo marker108'; & ./x.ps1"]) expect(judge(unreadable).approve).toBeNull();
    // Keep dangerous examples inert: only the harmless marker commands
    // above are executed by this isolated Windows fixture.
    for (const denied of ["Remove-Item ~ -Recurse", "Get-Content .env", "pwsh -enc !!!"]) expect(judge(denied).approve).toBeNull();
  }, 30_000);
});
