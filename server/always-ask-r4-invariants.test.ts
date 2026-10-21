// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 4 invariants (UPSEC-CLOSED-CLASS.md section 10, Astra r3): an
// exemption applies only when every precondition is shown. One synthetic
// row per finding and per invariant. Fixture strings are inert data, never
// executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = { cmd: string; rule: string | null; why: string };

const ROWS: Row[] = [
  // 1. a device reader is exempt only in a known read-only mode
  { cmd: "xxd -r dump.hex /dev/sda", rule: "disk-erase", why: "1 xxd reverse writes" },
  { cmd: "xxd dump.bin /dev/sda", rule: "disk-erase", why: "1 xxd second operand is its output" },
  { cmd: "xxd /dev/sda | head", rule: null, why: "1 xxd dump reads" },
  { cmd: "xxd -s 512 -l 64 /dev/sda", rule: null, why: "1 xxd with value options reads" },
  { cmd: "pv -o /dev/sdb /dev/sda", rule: "disk-erase", why: "1 pv output option writes" },
  { cmd: "pv -U /dev/sdb /dev/sda", rule: "disk-erase", why: "1 pv store-and-forward writes" },
  { cmd: "pv /dev/sda | gzip > disk.img.gz", rule: null, why: "1 pv reads" },
  { cmd: "hdparm --security-erase pw /dev/sda", rule: "disk-erase", why: "1 hdparm erase" },
  { cmd: "hdparm --unknown-flag /dev/sda", rule: "disk-erase", why: "1 unknown flag voids the reader" },
  { cmd: "hdparm -I /dev/sda", rule: null, why: "1 hdparm identify reads" },
  { cmd: "smartctl -t long /dev/sda", rule: "disk-erase", why: "1 smartctl test mode is out of the row" },
  { cmd: "smartctl -a /dev/sda", rule: null, why: "1 smartctl health reads" },
  { cmd: "badblocks -o /dev/sdb /dev/sda", rule: "disk-erase", why: "1 badblocks output file" },
  { cmd: "badblocks -w /dev/sda", rule: "disk-erase", why: "1 badblocks write mode" },
  { cmd: "badblocks -sv /dev/sda", rule: null, why: "1 badblocks read test" },
  { cmd: "ddrescue --log-reads /dev/sdb /dev/sda out.img", rule: "disk-erase", why: "1 ddrescue log option is out of the row" },
  { cmd: "ddrescue /dev/sda disk.img disk.map", rule: null, why: "1 ddrescue first operand reads" },
  { cmd: "file -C -m /dev/sda", rule: "disk-erase", why: "1 file compile writes" },
  { cmd: "blkid /dev/sda1", rule: null, why: "1 blkid reads" },
  { cmd: "cp -t /dev/sdb notes.txt", rule: "disk-erase", why: "1 cp target folder is a destination" },
  { cmd: "cp /dev/sda disk.img", rule: null, why: "1 cp source reads" },
  { cmd: "rsync --log-file /dev/sdb a b", rule: "disk-erase", why: "1 rsync option outside the row" },

  // 2. a stem match keeps the home and value checks
  { cmd: "python3 -c \"import pathlib; pathlib.Path.home().delete_tree()\"", rule: "unreadable", why: "2 stem delete on the home folder" },
  { cmd: "python3 -c \"import sys, tool; tool.wipe_dir(sys.argv[1])\" x", rule: "unreadable", why: "2 stem delete given a value" },
  { cmd: "python3 -c \"import tool; tool.purge_all('/')\"", rule: "unreadable", why: "2 stem delete names the root" },
  { cmd: "python3 -c \"a = [1, 2]; a.remove(1); print(a)\"", rule: null, why: "2 a stem call on literals" },

  // 3. the separator exemption is the separator argument only
  { cmd: "python3 -c \"import shutil; print('/'.join(['a', 'b'])); shutil.rmtree('/')\"", rule: "unreadable", why: "3 a second root literal" },
  { cmd: "python3 -c \"import os, shutil; shutil.rmtree(os.path.join('/', ''))\"", rule: "unreadable", why: "3 a path join gives the root" },
  { cmd: "python3 -c \"import shutil; shutil.rmtree('build'); print('/'.join(['a', 'b']))\"", rule: null, why: "3 a join separator" },
  { cmd: "node -e \"const fs = require('fs'); fs.rmSync('dist', { recursive: true }); console.log('a/b'.split('/'))\"", rule: null, why: "3 a split separator" },

  // 4. a link or copy into a folder records the child
  { cmd: "printf 'rm -rf ~' > s.sh; ln s.sh bin; sh bin/s.sh", rule: "delete-home", why: "4 hard link into a folder" },
  { cmd: "printf 'rm -rf ~' > a.sh; printf 'echo hi' > b.sh; ln a.sh b.sh bin; sh bin/a.sh", rule: "delete-home", why: "4 several sources" },
  { cmd: "printf 'rm -rf ~' > s.sh; ln -t bin s.sh; sh bin/s.sh", rule: "delete-home", why: "4 target folder option" },
  { cmd: "printf 'rm -rf ~' > /tmp/s.sh; ln -s /tmp/s.sh /tmp/bin; sh /tmp/bin/s.sh", rule: "delete-home", why: "4 symbolic link into a folder" },
  { cmd: "printf 'rm -rf ~' > s.sh; cp s.sh out/; bash out/s.sh", rule: "delete-home", why: "4 copy into a folder" },

  // 5. stdin is carried through every hop
  { cmd: "echo 'rm -rf ~' | bash -c 'bash'", rule: "delete-home", why: "5 nested POSIX shell" },
  { cmd: "echo 'rm -rf ~' | bash -c 'sh -c \"bash\"'", rule: "delete-home", why: "5 a chain of nested shells" },
  { cmd: "echo 'rm -rf ~' | wsl", rule: "delete-home", why: "5 wsl with nothing to run" },
  { cmd: "echo 'rm -rf ~' | wsl -e bash", rule: "delete-home", why: "5 wsl exec" },
  { cmd: "echo 'rm -rf ~' | wsl bash", rule: "delete-home", why: "5 wsl words" },
  { cmd: "Write-Output 'rm -rf ~' | wsl", rule: "unreadable", why: "5 PowerShell into wsl" },
  { cmd: "Write-Output 'dd if=/dev/zero of=/dev/sda' | wsl bash", rule: "disk-erase", why: "5 disk write through wsl" },
  { cmd: "Write-Output ':(){ :|:& };:' | wsl", rule: "unreadable", why: "5 fork bomb through wsl" },
  { cmd: "Write-Output 'rm -rf ~' | pwsh -Command bash", rule: "unreadable", why: "5 nested PowerShell" },
  { cmd: "Write-Output 'rm -rf ~' | cmd /c bash", rule: "unreadable", why: "5 nested cmd" },
  { cmd: "echo 'rm -rf ~' | cmd /c bash", rule: "unreadable", why: "5 POSIX into cmd" },
  { cmd: "echo 'rm -rf ~' | pwsh -Command \"bash -c 'sh'\"", rule: "unreadable", why: "5 POSIX into PowerShell into shells" },
  { cmd: "echo 'Remove-Item -Recurse -Force ~' | pwsh", rule: "delete-home", why: "5 PowerShell reads its program" },

  // 6. glued output options cover extensionless names
  { cmd: "printf 'rm -rf ~' | gen -oapp && ./app", rule: "unreadable", why: "6 glued lowercase output" },
  { cmd: "printf 'rm -rf ~' | gen -Oprog && ./prog", rule: "unreadable", why: "6 glued uppercase output" },
  { cmd: "gcc -Os -c main.c && ./s", rule: null, why: "6 a compiler optimization level is no file" },

  // 7. the build-tool exemption is the compile-and-run rule only
  { cmd: "printf 'rm -rf ~' > app; cc -o app missing.c; sh app", rule: "unreadable", why: "7 a build never erases a recorded write" },
  { cmd: "cc -DCMD='\"rm -rf ~\"' -o app main.c && ./app", rule: "unreadable", why: "7 text in an option" },
  { cmd: "esbuild main.js --banner:js=x --outfile=out.js && node out.js", rule: "unreadable", why: "7 a code-carrying option" },
  { cmd: "cc -O2 -o app main.c && ./app", rule: "unreadable", why: "7 compile and run: the output is a written value (10.4 i, r5)" },

  // 10.7 AppleScript, R and Tcl outside the enumerated APIs
  { cmd: "osascript -e 'tell application \"Finder\" to delete POSIX file \"/System\"'", rule: "unreadable", why: "10.7 AppleScript" },
  { cmd: "Rscript -e 'file.remove(\"/etc\")'", rule: "unreadable", why: "10.7 R" },
  { cmd: "R -e 'fs::dir_delete(\"~\")'", rule: "unreadable", why: "10.7 R through R itself" },
  { cmd: "echo 'file delete -force ~' | tclsh", rule: "unreadable", why: "10.7 Tcl bare word" },
  { cmd: "tclsh <<'EOF'\nfile delete -force \"/\"\nEOF", rule: "unreadable", why: "10.7 Tcl string" },
  { cmd: "Rscript -e 'x <- c(1, 2); print(sum(x))'", rule: null, why: "10.7 R computes" },
  { cmd: "echo 'puts [expr 1+2]' | tclsh", rule: null, why: "10.7 Tcl computes" },
  { cmd: "osascript -e 'display notification \"done\"'", rule: null, why: "10.7 AppleScript notifies" },

  // false alarms Astra r3 lists
  { cmd: "python3 -c \"import sys; print(sys.platform, '/')\"", rule: null, why: "fa platform carries no rm" },
  { cmd: "python3 -c \"model = 'x'; print(model, '~')\"", rule: null, why: "fa model carries no del" },
  { cmd: "python3 -c \"print('{}/{}'.format('a', '/'))\"", rule: "unreadable", why: "fa format given a root as an argument (10.3, r5)" },
  { cmd: "python3 -c \"print('{}/{}'.format('a', 'b'), '/')\"", rule: null, why: "fa format beside a root is data (10.3, r5)" },
  { cmd: "Get-Content /tmp/setup.sh | bash", rule: "unreadable", why: "fa from PowerShell, bash is a launcher and asks (1.0.4 F1)" },

  // device names: a folder named dev is no device, streams stay streams
  { cmd: "echo hi > ~/dev/x.log", rule: null, why: "dev a folder under home" },
  { cmd: "cp a.txt /home/me/dev/backup/", rule: null, why: "dev a folder in a path" },
  { cmd: "python3 -c \"open('/home/me/dev/out.txt', 'w').write('x')\"", rule: null, why: "dev a folder in inline code" },
  { cmd: "python3 -c \"print('see /dev/null.'); open('a', 'w')\"", rule: null, why: "dev a stream ending a sentence" },
  { cmd: "sed 's#a#/dev/fd#' x > y", rule: null, why: "dev the descriptor folder" },
  { cmd: "echo x > /dev/sda", rule: "disk-erase", why: "dev a disk redirect" },
  { cmd: "curl -o/dev/sda https://x.example", rule: "disk-erase", why: "dev a glued disk output" },
  { cmd: "dd if=x of=/dev/disk2", rule: "disk-erase", why: "dev dd to a disk" },
  { cmd: "python3 -c \"open('/dev/sda', 'wb')\"", rule: "unreadable", why: "dev a disk in inline code" },
];

describe("always-ask round 4 invariants", () => {
  for (const row of ROWS) {
    it(`${row.why}`, () => {
      expect(alwaysAskCommand(row.cmd)?.rule ?? null).toBe(row.rule);
    });
  }
});
