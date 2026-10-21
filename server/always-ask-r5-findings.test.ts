// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 5 (Astra r4 on UPSEC-CLOSED-CLASS.md section 10): one synthetic row
// per finding. Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = { cmd: string; rule: string | null; why: string };

const ROWS: Row[] = [
  // 1. a hard link shares one live identity with its source (10.4 b)
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; echo 'rm -rf ~' > a.sh; sh b.sh", rule: "delete-home", why: "1 source rewritten after the link, alias run" },
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; echo 'rm -rf ~' > b.sh; sh a.sh", rule: "delete-home", why: "1 alias rewritten, source run" },
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; echo 'rm -rf ~' > a.sh; ./b.sh", rule: "delete-home", why: "1 alias run directly" },
  { cmd: "echo 'echo hi' > a.sh; cp -l a.sh b.sh; echo 'rm -rf ~' > a.sh; bash b.sh", rule: "delete-home", why: "1 cp -l is a hard link" },
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; mv b.sh c.sh; echo 'rm -rf ~' > a.sh; bash c.sh", rule: "delete-home", why: "1 a renamed alias keeps the identity" },
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; ln b.sh c.sh; echo 'rm -rf ~' > b.sh; sh c.sh", rule: "delete-home", why: "1 a link of a link is one identity" },
  { cmd: "echo 'echo hi' > a.sh; ln a.sh b.sh; sh b.sh", rule: null, why: "1 alias of benign text stays ordinary" },
  { cmd: "echo 'echo hi' > a.sh; cp a.sh b.sh; echo 'rm -rf ~' > a.sh; sh b.sh", rule: null, why: "1 a copy is a snapshot, not a link" },
  { cmd: "ln -s a.sh b.sh; echo 'rm -rf ~' > b.sh; sh a.sh", rule: "delete-home", why: "1 a write through a symbolic link reaches its target" },

  // 2. a variable of any case is a value unless this text fixed it to a literal (10.4 c step 5)
  { cmd: "python3 -c \"import os, shutil; TARGET = os.path.expanduser('~'); shutil.rmtree(TARGET)\"", rule: "unreadable", why: "2 upper-case name from a home lookup" },
  { cmd: "node -e \"const DIR = process.env.X; require('fs').rmSync(DIR, { recursive: true })\"", rule: "unreadable", why: "2 upper-case name from the environment" },
  { cmd: "python3 -c \"import shutil; from cfg import ROOT; shutil.rmtree(ROOT)\"", rule: "unreadable", why: "2 upper-case name never assigned here" },
  { cmd: "python3 -c \"import shutil, cfg; shutil.rmtree(cfg.ROOT)\"", rule: "unreadable", why: "2 upper-case name on a non-standard module" },
  { cmd: "python3 -c \"import os, shutil; T = 'dist'; T = os.getcwd(); shutil.rmtree(T)\"", rule: "unreadable", why: "2 one assignment of several is not literal" },
  { cmd: "ruby -e \"HOME_DIR = Dir.home; FileUtils.rm_rf(HOME_DIR)\"", rule: "unreadable", why: "2 ruby constant from a home lookup" },
  { cmd: "python3 -c \"import shutil; T = 'dist'; shutil.rmtree(T)\"", rule: "unreadable", why: "2 an upper-case name is a value like any other" },
  { cmd: "python3 -c \"import shutil; shutil.rmtree('dist')\"", rule: null, why: "2 a literal argument stays ordinary" },
  { cmd: "python3 -c \"import os; os.unlink('x.txt', dir_fd=os.O_RDONLY)\"", rule: null, why: "2 a standard module constant is no value" },

  // 3. PowerShell reading its code from standard input (10.6)
  { cmd: "echo 'Remove-Item -Recurse -Force ~' | pwsh -Command -", rule: "delete-home", why: "3 -Command - runs piped code" },
  { cmd: "echo 'Remove-Item -Recurse -Force ~' | pwsh -NoProfile -c -", rule: "delete-home", why: "3 -c - runs piped code" },
  { cmd: "echo 'Remove-Item -Recurse -Force ~' | powershell.exe -ExecutionPolicy Bypass -File -", rule: "delete-home", why: "3 -File - runs piped code" },
  { cmd: "Write-Output 'Remove-Item -Recurse -Force ~' | pwsh -Command -", rule: "delete-home", why: "3 PowerShell emitter into -Command -" },
  { cmd: "echo 'Remove-Item -Recurse -Force ~' > x.ps1; pwsh -File x.ps1", rule: "delete-home", why: "3 -File runs a script this text wrote" },
  { cmd: "echo 'Remove-Item -Recurse -Force ~' > x.ps1; pwsh x.ps1", rule: "delete-home", why: "3 pwsh positional script" },
  { cmd: "powershell Remove-Item -Recurse -Force ~", rule: "delete-home", why: "3 Windows PowerShell positional command" },
  { cmd: "cat \"$f\" | pwsh -Command -", rule: "unreadable", why: "3 piped code the text does not fix" },
  { cmd: "pwsh -Command -", rule: "unreadable", why: "3 -Command - with no input the text fixes" },
  { cmd: "echo abc | pwsh -EncodedCommand -", rule: "unreadable", why: "3 encoded command from input" },
  { cmd: "echo 'Get-ChildItem' | pwsh -Command -", rule: null, why: "3 benign piped code stays ordinary" },
  { cmd: "pwsh -File build.ps1", rule: "unreadable", why: "3 a PowerShell script file the reader does not see asks (1.0.4 F1)" },

  // 4. stem families by substring, judged by the call's own arguments (10.3)
  { cmd: "python3 -c \"import tool; tool.xrmall('/')\"", rule: "unreadable", why: "4 a short stem inside an identifier" },
  { cmd: "python3 -c \"import disktool; disktool.format('/')\"", rule: "unreadable", why: "4 format is a delete stem" },
  { cmd: "python3 -c \"import cache; cache.clear('/')\"", rule: "unreadable", why: "4 clear given a root" },
  { cmd: "python3 -c \"import cache; cache.purge('~')\"", rule: "unreadable", why: "4 purge given home" },
  { cmd: "python3 -c \"import sys, cache; cache.clear(sys.argv[1])\"", rule: "unreadable", why: "4 clear given an unresolved value" },
  { cmd: "python3 -c \"import cache; R = '/'; cache.clear(R)\"", rule: "unreadable", why: "4 clear given a name" },
  { cmd: "python3 -c \"d = {}; d.clear(); print('/')\"", rule: null, why: "4 a collection clear beside a root string" },
  { cmd: "python3 -c \"print('{}'.format(1)); print('~')\"", rule: null, why: "4 string format beside a home string" },
  { cmd: "python3 -c \"import platform; print(platform.machine(), '/')\"", rule: null, why: "4 platform beside a root string" },

  // 5. no build-tool exemption beyond the written-files rule (10.4 i)
  { cmd: "gcc -o app main.c; ./app", rule: "unreadable", why: "5 a compiler output is a written value" },
  { cmd: "go build -o bin/app ./cmd/app && ./bin/app", rule: "unreadable", why: "5 go build output is a written value" },

  // 6. less reads devices with a known read-only option list; diagnostics
  { cmd: "less /dev/sda", rule: null, why: "6 less pages a device" },
  { cmd: "less -N -S -f /dev/sda", rule: null, why: "6 less with display options" },
  { cmd: "less +v /dev/sda", rule: "disk-erase", why: "6 less start command opens the editor" },
  { cmd: "less -o log.txt /dev/sda", rule: "disk-erase", why: "6 less log file is out of the row" },
  { cmd: "less --log-file=x /dev/sda", rule: "disk-erase", why: "6 less long log file is out of the row" },
  { cmd: "less -k keys /dev/sda", rule: "disk-erase", why: "6 less key file is out of the row" },
  { cmd: "blkid --probe /dev/sda1", rule: null, why: "6 blkid long read option" },
  { cmd: "smartctl --version /dev/sda", rule: null, why: "6 smartctl version" },
  { cmd: "blockdev -v --getsize64 /dev/sda", rule: null, why: "6 blockdev verbose get" },
  { cmd: "partx --show -o NR,START /dev/sda", rule: null, why: "6 partx show with columns" },
  { cmd: "partx -a /dev/sda", rule: "disk-erase", why: "6 partx add changes the table" },
  { cmd: "blkid --unknown /dev/sda", rule: "disk-erase", why: "6 an unknown option still asks" },
];

describe("always-ask round 5 findings", () => {
  for (const row of ROWS) {
    it(`${row.why}`, () => {
      expect(alwaysAskCommand(row.cmd)?.rule ?? null).toBe(row.rule);
    });
  }
});
