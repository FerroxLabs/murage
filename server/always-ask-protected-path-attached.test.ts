// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Option A+, the build review's two classes (astra-aplus-build):
// 1. an option value glued to its option, as getopt and pflag accept it
//    (`-vVALUE`, `-v=VALUE`, `-itvVALUE`, `-itv VALUE`), is read as the
//    separate form is, for every option the protected-path rule reads;
// 2. a wrapper's own literal arguments are judged before the wrapper is
//    taken off, whatever runs after it (a shell, a script, a function), and
//    a folder a wrapper moves to (`env -C`, `sudo -D`, a login) is the folder
//    its command's relative paths are read from.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = [cmd: string, rule: string | null];

const ATTACHED: Row[] = [
  // the review's example and every attached spelling of a mount
  ["docker run -v/home/tester:/h alpine sh -c 'rm -rf /h/*'", "protected-path"],
  ["docker run -v=/home/tester:/h img", "protected-path"],
  ["docker run -itv/home/tester:/h img", "protected-path"],
  ["docker run -itv /home/tester:/h img", "protected-path"],
  ["docker run -itv ~:/h img", "protected-path"],
  ["docker run -it -v~:/h img", "protected-path"],
  ["docker run --rm -dv/:/host img", "protected-path"],
  ["docker create -v/Volumes/Scratch:/m img", "protected-path"],
  ["podman run -v/etc:/etc img", "protected-path"],
  ["podman run -itv=/home/tester:/h img", "protected-path"],
  ["nerdctl run -v /home/tester:/h img", "protected-path"],
  ["nerdctl run -itv/:/host img", "protected-path"],
  ["sudo docker run -v/home/tester:/h img", "protected-path"],
  ["systemd-nspawn --bind=/home/tester:/h -D /tmp/root", "protected-path"],
  ["systemd-nspawn --bind-ro /:/host -D /tmp/root", "protected-path"],
  // a short option's value glued to it, any program
  ["tar -C/ -xf x.tgz", "protected-path"],
  ["tar -xzf x.tgz -C/home/tester", "protected-path"],
  ["git -C/home/tester clean -fdx", "protected-path"],
  ["make -C~ install", "protected-path"],
  ["zorbtool -o/Volumes/Scratch", "protected-path"],
  ["zorbtool -xo=/usr", "protected-path"],
  ["zorbtool '-dC:\\Users\\tester'", "protected-path"],
  // a command line glued to its option, or last in a cluster
  ["lftp -c'mirror -R --delete x /home/tester'", "protected-path"],
  ["lftp -dc 'mirror -R --delete x ~'", "protected-path"],
  ["lftp -e'mirror -R --delete x /usr; quit' host", "protected-path"],
];

const ATTACHED_ORDINARY: Row[] = [
  ["docker run -v/home/tester/dev:/app img", null],
  ["docker run -itv ./data:/data img", null],
  ["docker run -itv=/tmp/x:/x img", null],
  ["docker run -ev=1 img", null],
  ["podman run -dp 8080:80 img", null],
  ["tar -C/tmp -xf x.tgz", null],
  ["tar -xzf x.tgz -C./out", null],
  ["gcc -I/usr/include -L/usr/lib x.c", null],
  ["git -C~/dev/app status", null],
  ["zorbtool -o/tmp/out", null],
  ["systemd-nspawn --bind=/tmp/x:/x -D /tmp/root", null],
  ["lftp -c'mirror -R x /tmp/x'", null],
];

const WRAPPED: Row[] = [
  // the review's examples
  ["env -C /home/tester sh -c 'srm -rf ./*'", "protected-path"],
  ["env --chdir=~ bash -c 'rm -rf *'", "delete-home"],
  ["sudo -D / sh -c 'x'", "protected-path"],
  // a wrapper's arguments before a shell, a script or a function
  ["env -C /home/tester bash -c 'true'", "protected-path"],
  ["env -C/home/tester sh -c 'zorb'", "protected-path"],
  ["env -iC/ zorb", "protected-path"],
  ["sudo --chdir=/usr bash -c 'true'", "protected-path"],
  ["sudo -D/ sh -c 'true'", "protected-path"],
  ["flock /home/tester sh -c 'true'", "protected-path"],
  ["flock /home/tester -c 'true'", "protected-path"],
  ["nice -n 5 flock / sh -c 'true'", "protected-path"],
  ["timeout 5 flock ~ bash -c 'true'", "protected-path"],
  ["nohup flock /Volumes/Scratch sh -c 'true'", "protected-path"],
  ["stdbuf -oL flock /usr sh -c 'true'", "protected-path"],
  ["ionice -c3 flock / sh -c 'true'", "protected-path"],
  ["taskset 0x1 flock / sh -c 'true'", "protected-path"],
  ["chrt 10 flock / sh -c 'true'", "protected-path"],
  ["setsid -f flock / sh -c 'true'", "protected-path"],
  ["xargs -a /etc zorb", "protected-path"],
  ["xargs -a/home/tester zorb", "protected-path"],
  ["time -o /home/tester sh -c 'true'", "protected-path"],
  ["unshare -w /home/tester sh -c 'true'", "protected-path"],
  ["nsenter --wd=/ -t 1 sh -c 'true'", "protected-path"],
  ["f() { true; }; env -C / f", "protected-path"],
  ["printf 'true' > /tmp/s.sh; env -C /home/tester sh /tmp/s.sh", "protected-path"],
  // the folder a wrapper moves to is where the command's relative paths land
  ["env -C /home/tester rm -rf .", "delete-home"],
  ["env -C /home/tester/dev/project sh -c 'rm -rf ../../..'", "delete-system-folder"],
  ["sudo -D /home/tester/dev sh -c 'rm -rf ..'", "delete-home"],
  ["systemd-run --working-directory=/home/tester rm -rf ./*", "delete-home"],
  ["unshare --wd=/home/tester/dev sh -c 'rm -rf ..'", "delete-home"],
  ["env -C /home/tester/dev env -C .. rm -rf .", "delete-home"],
  ["chroot /home/tester rm -rf ./*", "delete-home"],
  // a login runs from the target's home folder
  ["sudo -i sh -c 'rm -rf *'", "delete-home"],
  ["sudo -u bob --login bash -c 'rm -rf ./*'", "delete-home"],
  ["su - -c 'rm -rf *'", "delete-home"],
  ["su -l bob -c 'rm -rf ./*'", "delete-home"],
  ["pkexec rm -rf ./*", "delete-home"],
];

const WRAPPED_ORDINARY: Row[] = [
  ["env -C /home/tester/dev/project sh -c 'rm -rf build'", null],
  ["env -C sub rm -rf ..", null],
  ["sudo -D /home/tester/dev sh -c 'make'", null],
  ["nice -n 10 sh -c 'npm test'", null],
  ["timeout 30 bash -c 'pnpm test'", null],
  ["flock /tmp/lock sh -c 'make'", null],
  ["xargs -a list.txt echo", null],
  ["pkexec --keep-cwd rm -rf ./build", null],
  ["chroot --skip-chdir /tmp/root rm -rf ./build", null],
  ["sudo -u bob sh -c 'rm -rf ./build'", null],
];

describe("A+: an option value glued to its option is read as the separate form", () => {
  it.each(ATTACHED)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd, "/home/tester/dev/project")?.rule ?? null).toBe(rule);
  });
  it.each(ATTACHED_ORDINARY)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd, "/home/tester/dev/project")?.rule ?? null).toBe(rule);
  });
});

describe("A+: a wrapper's own arguments are judged before what it runs", () => {
  it.each(WRAPPED)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd, "/home/tester/dev/project")?.rule ?? null).toBe(rule);
  });
  it.each(WRAPPED_ORDINARY)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd, "/home/tester/dev/project")?.rule ?? null).toBe(rule);
  });
  it("a folder a value names is a folder the text does not fix", () => {
    expect(alwaysAskCommand("sudo -D \"$d\" rm -rf ./*", "/home/tester/dev/project")?.rule).toBe("unreadable");
    // the wrapper's folder never leaks into the next command
    expect(alwaysAskCommand("env -C /tmp/x true; rm -rf ../../..", "/home/tester/dev/project")?.rule).toBe("delete-system-folder");
  });
});
