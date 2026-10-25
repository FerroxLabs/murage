// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// False alarms measured on real command history, closed as classes. Each
// ordinary row is a shape that used to raise a card it should not; each held
// row is the still-catastrophic neighbour of a class, and keeps asking.
// Fixture strings are inert data, never executed. Rows are named by id.
//
// Classes:
//   DEV  the device class is a raw disk or volume only; a device that is only
//        read or listed is ordinary; a write to a raw disk asks
//   RUN  a program or script file outside the text is out of scope; literal
//        inline code asks only when what it runs or deletes is catastrophic
//   CAT  catastrophic text that is only printed, searched or commented is data
//   HOME looking up the home folder is ordinary; deleting it asks
//   VAL  code or a command from a value keeps asking (ask on any variable)
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = { id: string; cmd: string; rule: string | null };

const ORDINARY: Row[] = [
  // DEV: streams and other non-disk /dev paths are not disks
  { id: "DEV-O1", cmd: "ssh host \"ls /srv 2>/dev/null|head -5\"", rule: null },
  { id: "DEV-O2", cmd: "echo ping > /dev/tcp/127.0.0.1/8080", rule: null },
  { id: "DEV-O3", cmd: "exec 3<>/dev/tcp/example.com/80", rule: null },
  { id: "DEV-O4", cmd: "sed -i 's#/tmp/log#/dev/null#' app.conf", rule: null },
  { id: "DEV-O5", cmd: "echo AT > /dev/ttyUSB0", rule: null },
  { id: "DEV-O6", cmd: "stty -f /dev/cu.usbmodem1 115200", rule: null },
  { id: "DEV-O7", cmd: "mkdir -p /dev/shm", rule: null },
  { id: "DEV-O8", cmd: "cd app && grep -rn foo src 2>/dev/null; echo done", rule: null },
  // DEV: a raw disk that is only read or listed
  { id: "DEV-O9", cmd: "grep -c MAGIC /dev/sda", rule: null },
  { id: "DEV-O10", cmd: "ls -l /dev/disk2s1", rule: null },
  { id: "DEV-O11", cmd: "diskutil info /dev/disk0", rule: null },
  { id: "DEV-O12", cmd: "sudo fdisk -l /dev/nvme0n1", rule: null },
  { id: "DEV-O13", cmd: "blkid /dev/mapper/vg-root", rule: null },
  { id: "DEV-O14", cmd: "lsblk /dev/nbd0", rule: null },
  { id: "DEV-O15", cmd: "lsblk /dev/zram0", rule: null },
  { id: "DEV-O16", cmd: "lsblk /dev/mtdblock0", rule: null },
  { id: "DEV-O17", cmd: "lsblk /dev/sg0", rule: null },
  { id: "DEV-O18", cmd: "lsblk /dev/ram0", rule: null },
  { id: "DEV-O19", cmd: "lsblk /dev/mmcblk0boot0", rule: null },
  // RUN: literal inline code that runs ordinary things, and a program run directly
  { id: "RUN-O2", cmd: "./run.sh && make && npm run build", rule: null },
  { id: "RUN-O3", cmd: "python3 -c \"import subprocess; subprocess.run(['git', 'status'])\"", rule: null },
  { id: "RUN-O4", cmd: "cd app && python3 - <<'EOF'\nimport subprocess\nprint(subprocess.check_output(['ls', '-la']).decode())\nEOF", rule: null },
  { id: "RUN-O5", cmd: "node -e \"require('child_process').execSync('npm test', {stdio: 'inherit'})\"", rule: null },
  { id: "RUN-O6", cmd: "node -e 'console.log(`v${process.version}`)'", rule: null },
  { id: "RUN-O7", cmd: "python3 -c \"import os; os.remove('build/out.txt')\"", rule: null },
  // CAT: catastrophic text that is only printed or commented
  { id: "CAT-O1", cmd: "python3 -c \"import os; print(os.path.join('/', 'tmp'))\"", rule: null },
  { id: "CAT-O2", cmd: "python3 - <<'EOF'\n# never pass '~' to rmtree\nprint('ok')\nEOF", rule: null },
  { id: "CAT-O3", cmd: "node -e \"console.log('never run rm -rf on', '/')\"", rule: null },
  { id: "CAT-O4", cmd: "ruby -e 'puts \"/usr\"'", rule: null },
  // HOME: looking up the home folder, or reading it
  { id: "HOME-O1", cmd: "python3 -c \"import os; print(os.path.expanduser('~/.config'))\"", rule: null },
  { id: "HOME-O2", cmd: "node -e \"console.log(require('os').homedir())\"", rule: null },
  { id: "HOME-O3", cmd: "cd ~ && ls ~ && cat ~/.zshrc", rule: null },
];

const HELD: Row[] = [
  // DEV: a write to a raw disk or volume, by any spelling
  { id: "DEV-H1", cmd: "grep x f > /dev/sdb", rule: "disk-erase" },
  { id: "DEV-H2", cmd: "dd if=/dev/zero of=/dev/nvme0n1", rule: "disk-erase" },
  { id: "DEV-H3", cmd: "cp image.img /dev/mmcblk0", rule: "disk-erase" },
  { id: "DEV-H4", cmd: "tee /dev/mapper/vg-root < x", rule: "disk-erase" },
  { id: "DEV-H5", cmd: "curl -o/dev/disk3 https://example.com/img", rule: "disk-erase" },
  { id: "DEV-H6", cmd: "cat x > /dev/rdisk4", rule: "disk-erase" },
  { id: "DEV-H7", cmd: "dd if=x of=/dev/loop0", rule: "disk-erase" },
  { id: "DEV-H8", cmd: "cat x > /dev/disk/by-id/ata-DISK", rule: "disk-erase" },
  { id: "DEV-H9", cmd: "cat x > /dev/md0", rule: "disk-erase" },
  { id: "DEV-H10", cmd: "cat x > /dev/dm-0", rule: "disk-erase" },
  { id: "DEV-H11", cmd: "cat x > /dev/xvda", rule: "disk-erase" },
  { id: "DEV-H12", cmd: "cat x > /dev/vdb", rule: "disk-erase" },
  { id: "DEV-H13", cmd: "cat x > /dev/hda1", rule: "disk-erase" },
  { id: "DEV-H14", cmd: "cat x > /dev/sr0", rule: "disk-erase" },
  { id: "DEV-H15", cmd: "ssh host \"ls 2>/dev/null|head\" > /dev/sda", rule: "disk-erase" },
  { id: "DEV-H16", cmd: "python3 -c \"open('/dev/sda', 'wb').write(b'0')\"", rule: "unreadable" },
  { id: "DEV-H17", cmd: "python3 -c \"import os; os.system('dd if=/dev/zero of=/dev/sda')\"", rule: "unreadable" },
  { id: "DEV-H18", cmd: "cat x > /dev/nbd0", rule: "disk-erase" },
  { id: "DEV-H19", cmd: "cat x > /dev/zram0", rule: "disk-erase" },
  { id: "DEV-H20", cmd: "cat x > /dev/mtdblock0", rule: "disk-erase" },
  { id: "DEV-H21", cmd: "cat x > /dev/sg0", rule: "disk-erase" },
  { id: "DEV-H22", cmd: "cat x > /dev/ram0", rule: "disk-erase" },
  { id: "DEV-H23", cmd: "cat x > /dev/mmcblk0boot0", rule: "disk-erase" },
  // RUN: a script file on disk this text did not write, run by an interpreter (1.0.4 U17: asks, as under PowerShell)
  { id: "RUN-H11", cmd: "cd tools && python3 build.py --fast", rule: "unreadable" },
  { id: "RUN-H12", cmd: "node scripts/gen.js && ./run.sh && make && npm run build", rule: "unreadable" },
  // RUN: the text writes the code it then runs
  { id: "RUN-H1", cmd: "cat > x.py <<'EOF'\nimport subprocess\nsubprocess.run(['ls'])\nEOF\npython3 x.py", rule: "unreadable" },
  { id: "RUN-H2", cmd: "echo 'rm -rf ~' > c.txt; python3 -c \"import os; os.system(open('c.txt').read())\"", rule: "unreadable" },
  // RUN: literal inline code that runs or deletes a catastrophe
  { id: "RUN-H3", cmd: "python3 -c \"import subprocess; subprocess.run('rm -rf ~', shell=True)\"", rule: "unreadable" },
  { id: "RUN-H4", cmd: "python3 -c \"import subprocess; subprocess.run(['rm', '-rf', '/'])\"", rule: "unreadable" },
  { id: "RUN-H5", cmd: "osascript -e 'do shell script \"rm -rf ~\"'", rule: "unreadable" },
  { id: "RUN-H6", cmd: "node -e \"require('child_process').execSync(process.argv[1])\" 'rm -rf ~'", rule: "unreadable" },
  { id: "RUN-H7", cmd: "echo 'rm -rf ~' | python3 -c \"import os; os.system(input())\"", rule: "unreadable" },
  { id: "RUN-H8", cmd: "python3 -c \"import os; os.system('diskutil eraseDisk JHFS+ x disk2')\"", rule: "unreadable" },
  { id: "RUN-H9", cmd: "cd app && python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/usr')\nEOF", rule: "unreadable" },
  { id: "RUN-H10", cmd: "node -e 'console.log(`${require(\"child_process\").execSync(\"rm -rf ~\")}`)'", rule: "unreadable" },
  // HOME: a delete whose target is the home folder itself
  { id: "HOME-H1", cmd: "python3 -c \"import shutil, os; shutil.rmtree(os.environ['HOME'])\"", rule: "unreadable" },
  { id: "HOME-H2", cmd: "node -e \"require('fs').rmSync(require('os').homedir(), {recursive: true})\"", rule: "unreadable" },
  { id: "HOME-H3", cmd: "ruby -e 'FileUtils.rm_rf(Dir.home)'", rule: "unreadable" },
  { id: "HOME-H4", cmd: "python3 -c \"import subprocess, os; subprocess.run(['rm', '-rf', os.environ['HOME']])\"", rule: "unreadable" },
  { id: "HOME-H5", cmd: "cd ~ && rm -rf .", rule: "delete-home" },
  // VAL: code or a command from a value
  { id: "VAL-H1", cmd: "eval \"$CMD\"", rule: "unreadable" },
  { id: "VAL-H2", cmd: "python3 -c \"$CODE\"", rule: "unreadable" },
  { id: "VAL-H3", cmd: "echo \"$X\" | python3", rule: "unreadable" },
  { id: "VAL-H4", cmd: "node -e \"require('child_process').execSync(process.argv[1])\" \"$CMD\"", rule: "unreadable" },
  { id: "VAL-H5", cmd: "CMD=x python3 -c \"import os; os.system(os.environ['CMD'])\"", rule: "unreadable" },
];

describe("false alarms closed by class", () => {
  it("has each id once", () => {
    const ids = [...ORDINARY, ...HELD].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it.each(ORDINARY)("$id is ordinary", ({ cmd }) => {
    expect(alwaysAskCommand(cmd, "/work/project")).toBeNull();
  });
  it.each(HELD)("$id still asks ($rule)", ({ cmd, rule }) => {
    expect(alwaysAskCommand(cmd, "/work/project")?.rule ?? null).toBe(rule);
  });
});
