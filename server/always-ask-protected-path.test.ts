// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Option A+ (decision build, not for release until Sean picks it): the
// literal-only protected-path rule. A program that is not an exact member
// of a tiny read-only allow list, whose literal arguments name a protected
// path (a home folder, `~`, the drive root, a folder the system runs from, a
// whole mounted volume), gets a card. Values, substitutions and a folder the
// text does not fix keep today's behaviour. The rule only adds cards.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = [cmd: string, rule: string | null];

/** Each of these is ordinary at 8a7ff8153. */
const CARD: Row[] = [
  // the rows the lane brief names
  ["srm -rf /home/tester", "protected-path"],
  ["lftp -c 'local mirror --delete x /home/tester'", "protected-path"],
  ["shred -u ~/*", "protected-path"],
  ["rm -rf /Volumes/Scratch", "protected-path"],
  ["made-up-tool --wipe ~", "protected-path"],
  ["docker run -v ~:/h img", "protected-path"],
  // tools the reader has never heard of, every protected class
  ["zorbwipe -rf ~", "protected-path"],
  ["zorbwipe /", "protected-path"],
  ["zorbwipe /usr", "protected-path"],
  ["zorbwipe /private/etc", "protected-path"],
  ["zorbwipe /Users/tester", "protected-path"],
  ["zorbwipe /var/root", "protected-path"],
  ["zorbwipe /mnt/data", "protected-path"],
  ["zorbwipe /media/tester/USB", "protected-path"],
  ["zorbwipe /run/media/tester/USB", "protected-path"],
  ["zorbwipe /Volumes", "protected-path"],
  ["zorbwipe /Volumes/Scratch/", "protected-path"],
  ["./tools/nuke /", "protected-path"],
  ["/opt/bin/cleanse --target=/Users/tester", "protected-path"],
  ["zorbwipe -C /", "protected-path"],
  ['zorbwipe "/home/tester"', "protected-path"],
  ["srm -rfll ~", "protected-path"],
  ["wipe -rf /", "protected-path"],
  ["sudo srm -r /usr", "protected-path"],
  ["timeout 5 zorbwipe ~", "protected-path"],
  ["zorbwipe C:/", "protected-path"],
  ["zorbwipe C:/Users/tester", "protected-path"],
  // destructive programs the delete rules leave to their own reading
  ["rm ~", "protected-path"],
  ["rmdir /", "protected-path"],
  ["cp -r x /usr", "protected-path"],
  ["chmod -R 777 ~", "protected-path"],
  ["chown -R nobody /Users/tester", "protected-path"],
  ["mv ~ /tmp/old", "protected-path"],
  ["tar -C / -xf x.tgz", "protected-path"],
  ["truncate -s 0 /etc", "protected-path"],
  // -c strings, tokenised
  ["lftp -e 'mirror -R --delete x /usr; quit' host", "protected-path"],
  ["zorbtool --command 'wipe ~'", "protected-path"],
  ["zorbtool -c \"wipe /Volumes/Scratch\"", "protected-path"],
  // Docker and Podman mount sources
  ["docker run -v /:/host img", "protected-path"],
  ["docker run --volume ~:/h img", "protected-path"],
  ["docker run --volume=/Users/tester:/u img", "protected-path"],
  ["docker run -v ~:/h:ro img", "protected-path"],
  ["podman run -v /etc:/etc:ro img", "protected-path"],
  ["docker run --mount type=bind,source=/Users/tester,target=/u img", "protected-path"],
  ["docker run --mount=type=bind,src=/Volumes/Scratch,dst=/m img", "protected-path"],
  ["docker run -v /Volumes/Scratch:/m img", "protected-path"],
  // wrapper arguments, before the wrapper is taken off
  ["env -C / zorb", "protected-path"],
  ["env --chdir=/home/tester ls", "protected-path"],
  ["flock /home/tester zorb", "protected-path"],
  // a relative path from a folder the text fixes
  ["cd /Volumes/Scratch/work && zorbwipe ..", "protected-path"],
  ["cd ~/dev && zorbwipe ..", "protected-path"],
  // exactness: case-sensitive on POSIX, a suffix is another program
  ["LS ~", "protected-path"],
  ["Cat /", "protected-path"],
  ["ls.exe ~", "protected-path"],
  ["/bin/ls ~", "protected-path"],
  // an allow-listed program that writes output somewhere
  ["ls ~ > /tmp/list.txt", "protected-path"],
  ["cat /etc >> out.txt", "protected-path"],
  // PowerShell and cmd
  ["powershell -Command \"Invoke-Zap -Path C:\\Users\\tester\"", "protected-path"],
  ["powershell -Command \"Copy-Item x C:\\\"", "protected-path"],
  ["powershell -Command \"ls.exe ~\"", "protected-path"],
  ["cmd /c \"zapit C:\\Users\\tester\"", "protected-path"],
  // ordinary at 8a7ff8153 (always-ask.test.ts 5.3 and 5.7 lists), cards under A+
  ["rm /", "protected-path"],
  ["dir C:\\", "protected-path"],
  ["h(){ echo \"$(dirname \"$1\")\"; }; h /", "protected-path"],
  // a value inside the line is today's behaviour; the literal beside it still counts
  ["zorbwipe $X /usr", "protected-path"],
  // search tools that run or write: rg --pre, find actions
  ["rg --pre x foo ~", "protected-path"],
  ["rg --pre=x foo /", "protected-path"],
  ["rg --pre-glob '*.pdf' foo ~", "protected-path"],
  ["grep -r foo ~ > /tmp/hits.txt", "protected-path"],
  ["find ~ -fprint /tmp/o", "protected-path"],
  ["find ~ -fprint0 /tmp/o", "protected-path"],
  ["find ~ -fprintf /tmp/o x", "protected-path"],
  ["find / -fls /tmp/o", "protected-path"],
  ["sed -i s/a/b/ ~", "protected-path"],
  ["awk 'BEGIN{system(\"x\")}' ~", "protected-path"],
];

/** find actions that delete, run or hide a value: some card asks, whichever rule reads it first. */
const ANY_CARD: string[] = [
  "find ~ -delete",
  "find ~ -name x -delete",
  "find / -exec rm {} +",
  "find ~ -execdir x {} ;",
  "find ~ -ok x {} ;",
  "find ~ -okdir x {} ;",
  "find ~ $X",
];

/** Commands that stay ordinary under A+. */
const ORDINARY: Row[] = [
  // searches: read-only by name
  ["grep -r foo ~", null],
  ["egrep -r foo /", null],
  ["fgrep -r foo /Volumes/Scratch", null],
  ["rg foo ~", null],
  ["rg -n foo /", null],
  ["find / -name x", null],
  ["find ~ -name '*.log' -type f", null],
  ["find /Volumes/Scratch -maxdepth 2 -print", null],
  // the rows the lane brief names
  ["ls ~", null],
  ["du -sh ~/Downloads", null],
  ["cat ~/.zshrc", null],
  // the tiny allow list, exactly as named
  ["pwd", null],
  ["ls -la /", null],
  ["ls /Volumes/Scratch", null],
  ["du -sh ~", null],
  ["df -h /Volumes/Scratch", null],
  ["df -h /", null],
  ["stat ~", null],
  ["wc -l /etc", null],
  ["head ~/.zshrc", null],
  ["tail -f /var/log/system.log", null],
  ["cat /etc/hosts", null],
  ["echo ~", null],
  ["echo /", null],
  ["printf '%s\\n' ~", null],
  ["cd ~", null],
  ["cd / && ls", null],
  ["ls ~ 2>/dev/null", null],
  ["ls ~ 2>&1", null],
  ["ls ~ | head", null],
  ["sudo ls /root", null],
  ["powershell -Command \"LS ~\"", null],
  ["powershell -Command \"cat ~\"", null],
  // project and temp paths, for any program
  ["zorbwipe ~/dev", null],
  ["zorbwipe ~/dev/x", null],
  ["zorbwipe /tmp", null],
  ["zorbwipe /private/tmp/x", null],
  ["zorbwipe /Volumes/Scratch/x", null],
  ["zorbwipe /Volumes/Scratch/work/app", null],
  ["zorbwipe C:/Users/tester/src", null],
  ["zorbwipe /usr/local/bin/x", null],
  ["zorbwipe /etc/hosts", null],
  ["srm -rf /tmp/x", null],
  ["shred -u ~/x", null],
  ["made-up-tool --wipe ~/dev/x", null],
  ["cp -r build /tmp/out", null],
  ["cp -r ~/dev /tmp", null],
  ["chmod -R 755 ~/dev", null],
  ["rm -rf dist build", null],
  ["rm -rf /tmp/*", null],
  ["rm -rf ~/dev", null],
  ["tar -C /tmp -xf x.tgz", null],
  ["npx rimraf node_modules", null],
  ["docker run -v ~/dev:/app img", null],
  ["docker run -v ~/.ssh:/s img", null],
  ["docker run -v ./data:/data img", null],
  ["docker run --mount type=bind,source=/tmp/x,target=/x img", null],
  ["cd ~/dev && zorbwipe .", null],
  ["cd /Volumes/Scratch/work/app && zorbwipe ../other", null],
  // values, substitutions and an unknown folder: today's behaviour
  ["zorbwipe $X", null],
  ["zorbwipe \"$(pwd)\"", null],
  ["zorbwipe \"$DIR\"", null],
  ["cd \"$D\" && zorbwipe ..", null],
  ["zorbwipe ..", null],
  ["zorbwipe .", null],
  // the quoted whole `~` is a file called `~`
  ["zorbwipe '~'", null],
  ["zorbwipe \\~", null],
  // the tokens of a message are not a -c string
  ["git commit -m \"clean up ~ handling\"", null],
  ["zorbtool --name 'a / b'", null],
  // option values that are not paths
  ["PATH=/usr/bin:/bin zorbwipe x", null],
  ["zorbwipe --root=/tmp", null],
];

describe("A+: a protected literal under a program off the allow list asks", () => {
  it.each(CARD)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd)?.rule ?? null).toBe(rule);
  });
  it("names the class in plain words", () => {
    expect(alwaysAskCommand("zorbwipe ~")?.what).toMatch(/home folder/);
    expect(alwaysAskCommand("zorbwipe /")?.what).toMatch(/main drive/);
    expect(alwaysAskCommand("zorbwipe /usr")?.what).toMatch(/needs to run/);
    expect(alwaysAskCommand("zorbwipe /Volumes/Scratch")?.what).toMatch(/whole disk or volume/);
  });
});

describe("A+: a find action is never exempt", () => {
  it.each(ANY_CARD)("%s asks", (cmd) => {
    expect(alwaysAskCommand(cmd)).not.toBeNull();
  });
});

describe("A+: ordinary work stays ordinary", () => {
  it.each(ORDINARY)("%s -> %s", (cmd, rule) => {
    expect(alwaysAskCommand(cmd)?.rule ?? null).toBe(rule);
  });
});

describe("A+ only adds cards", () => {
  it("the delete rules keep their own verdicts", () => {
    expect(alwaysAskCommand("rm -rf ~")?.rule).toBe("delete-home");
    expect(alwaysAskCommand("rm -rf /")?.rule).toBe("delete-root");
    expect(alwaysAskCommand("rm -rf /usr")?.rule).toBe("delete-system-folder");
    expect(alwaysAskCommand("rsync -a --delete empty/ ~")?.rule).toBe("delete-home");
    expect(alwaysAskCommand("zorbwipe $(cat x) ~")?.rule).toBe("protected-path");
    // a protected-path hit early in the text never hides a later rule's own verdict
    expect(alwaysAskCommand("cp ~ /tmp/x; rm -rf ~")?.rule).toBe("delete-home");
    expect(alwaysAskCommand("find / -name x | sort | xargs rm -rf")?.rule).toBe("delete-root");
    expect(alwaysAskCommand("zorbwipe /usr; rm -rf $X/")?.rule).toBe("unknown-target");
    expect(alwaysAskCommand("export DIR=/usr; rm -rf $DIR")?.rule).toBe("delete-system-folder");
    expect(alwaysAskCommand("env -i PATH=/bin ls")).toBeNull();
  });
  it("a fixed cwd resolves relative literals, and a project cwd stays ordinary", () => {
    expect(alwaysAskCommand("zorbwipe .", "/Users/tester/project")).toBeNull();
    expect(alwaysAskCommand("zorbwipe src", "/Users/tester/project")).toBeNull();
    expect(alwaysAskCommand("zorbwipe ..", "/Users/tester/project")?.rule).toBe("protected-path");
    expect(alwaysAskCommand("ls ..", "/Users/tester/project")).toBeNull();
  });
});
