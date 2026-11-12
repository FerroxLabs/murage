// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FULL-DENY-1018 (MurageMain 11-07): a deny rule holds at EVERY level. These protected targets (system folders reached
// by `../` climbs, /proc and device climbs, protected files in odd spellings) asked only on No limits before: Full access
// ran them (since b18). Each row asks on Full access AND on No limits; the ordinary twins keep running on both.
import { describe, expect, it } from "vitest";
import type { AutoContext } from "./auto-approve.ts";

const { autoVerdict } = await import("./auto-approve.ts");
const { alwaysAskCommand, protectedClass } = await import("./always-ask.ts");
const { ownerMarks } = await import("./testing/marks-nlh0.ts");
const { expectNoLimitsOwnerOutcome } = await import("./testing/no-limits-1019.ts");
// NOLIM 1.0.19 (rev 3): at No limits the owner's built-in typed denies run; only the wipe list (and, by rev 3.2, Murage's own
// hook and relay files, pinned in hook-selfguard.test.ts) still ask. Full access rows are unchanged.
const noLimitsRule = (command: string): string | undefined => alwaysAskCommand(command, "/w")?.rule;

const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const NO_LIMITS = { ...FULL, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const ctx = (command: string): AutoContext => ({ ...OWNER, commandText: command, commandCwd: "/w" });

const CLIMB = "../../../../../../etc/cron.d";
const DENIED: string[] = [
  `mv ./blob ${CLIMB}/pwn`, `cp ./blob ${CLIMB}/pwn`, `tee ${CLIMB}/pwn`, `touch ${CLIMB}/pwn`, `touch ~/${CLIMB}/pwn`,
  `install -m 644 ./blob ${CLIMB}/pwn`, `ln -sf /tmp/blob ${CLIMB}/pwn`, `rsync -a /tmp/a/ ${CLIMB}/`, `find ${CLIMB} -delete`,
  "find /w -fprintf /etc/out %p", "find /w -fls /etc/out",
  `tar -C ${CLIMB} -xf /tmp/o.tar`, `tar --directory=${CLIMB} -xf /tmp/o.tar`, `unzip -d ${CLIMB} /tmp/o.zip`, `zip ${CLIMB}/o.zip /tmp/a`,
  "sed -e'w /etc/cron.d/pwn'", "sed --expression='w /etc/cron.d/pwn'", "sed -e 1p -e 'w /etc/cron.d/pwn' notes.txt", `sed -i -e 1p ${CLIMB}/../passwd`,
  `awk 'BEGIN{print "owned" > "/etc/cron.d/pwn"}'`,
  "echo x > /etc/hosts", "printf x > /tmp/../sys/../w/x", "printf x > /tmp/../proc/self/root/dev/sda",
  "echo x > /var/tmp/../../proc/self/cwd/../dev/sda", "echo x > /tmp/../proc/thread-self/cwd/../dev/sda",
  "cp proj /tmp/../proc/self/fd/1", "cp blob /tmp/../proc/../w/out", "mv blob /x/../dev/../w/y", "touch /tmp/../sys/../w/x",
  "tee /w/../etc/../w/x", "ln blob /tmp/../proc/../w/out", "rsync blob /tmp/../proc/../w/out",
  "install blob /tmp/../var/spool/cron/../../../w/z", "zip /x/../dev/../w/y blob", "unzip -d /tmp/../sys/../w/x blob",
];
const GATE_SPELLINGS = [
  ">> ~/.kube/./config", ">> ~/.kube//config", ">> ~/.kube/foo/../config", '>> ~/.kube/""./config', '>> ~/.kube/"./config"',
  ">> ~/.murage/./config.json", ">> ~/.murage//config.json", '>> ~/.murage/""./config.json', ">> ~/.murage/foo/../config.json",
  ">> ~/.codex/./auth.json", '>> ~/.codex/""./auth.json', ">> ~/.claude/./.credentials", '>> ~/.claude/""./.credentials',
];
/** Owner work that must keep running on both levels (and stays out of the system-folder rule). */
const ORDINARY = [
  "tee /dev/stderr", "echo hi > /dev/null", "ls 2>/dev/null", "cmd > /dev/null 2>&1", "cp /etc/hosts ./hosts",
  "cat /etc/hosts", "cd /etc && ls", "tar -xf a.tar -C out", "tar -cf a.tar src", "unzip a.zip -d out", "zip -r out.zip src",
  "find . -name x -delete", "find . -name x", "touch ~/x.txt", "awk '{print $1}' f", "echo x > ./out.txt", "cp a ../b", "echo a > ../../up",
];

/** One row per mutation label (scripts/check-marks-mutations.py kills a mutant by a failing test whose name carries its label). */
const MUTANT_ROWS: Array<[label: string, command: string, asks: boolean, asksNoLimits?: boolean]> = [
  ["M-FD-redirect", "echo x > /etc/hosts", true],
  ["M-FD-find", "find ../../../../../../etc/cron.d -delete", true],
  ["M-FD-sed-w", "sed -e'w /etc/cron.d/pwn'", true],
  ["M-FD-archive", "tar -C ../../../../../../etc/cron.d -xf /tmp/o.tar", true],
  ["M-FD-home", "touch ~/../../../../../../etc/cron.d/pwn", true],
  ["M-FIX3-class", "printf x > /tmp/../proc/self/root/dev/sda", true],
  ["M-FIX2-protected", "mkdir -p /usr/share/x", true],
  ["M-FD-source", "cp /etc/hosts ./hosts", false],
  // 11-08 re-baseline (MurageMain ruling, MARKS r14 R-B): /usr/local is a system-path write, so the owner No limits turn STOPS
  // (designs/MARKS-r14-DENY-CLASS.md :92 :95 :157 :193 :292); Full access keeps running.
  ["M-FD-usrlocal", "cp build/tool /usr/local/bin/tool", false, true],
  // MurageMain 11-07: code that calls into native code fails closed at every level (Astra r16 recheck OPEN 1)
  ["M-FD-ffi", `python3 -c 'import ctypes; ctypes.CDLL(None).syscall(87, b"/etc/passwd")'`, true],
  ["M-FD-ffi", `python3 -c 'import cffi; cffi.FFI().dlopen(None)'`, true, false],
  ["M-FD-ffi", `node -e 'require("ffi-napi")'`, true, false],
  ["M-FD-ffi", `ruby -e 'require "fiddle"; Fiddle.dlopen(nil)'`, true, false],
  // MurageMain 11-07: in `ln -s TARGET LINK` only LINK is written; a hard link keeps both as write targets
  // G-NL SYMLINK RULING (MAIN 2026-11-11 10:45Z), superseded under S1-B3:
  // only LINK is written here, outside protected folders. Full access is unchanged.
  ["M-FD-ln", "ln -s /usr/bin/x ./y", false, false],
  ["M-FD-ln", "ln -sf /etc/hosts ./hosts", false, false],
  ["M-FD-ln", "ln -s ./a /usr/y", true],
  ["M-FD-ln", "ln /usr/bin/x ./y", true],
  ["M-FD-ln", "ln -s -t /usr/bin ./x", true],
];
describe("MARKS r11: the strict read of an unproven wrapper path", () => {
  // a wrapper spelled by a path outside the system bin folders is not the wrapper its name says (the strict read holds it)
  it.each(["command ./x/env echo x", "nohup /opt/bin/env echo x"])("M-FIX2-wrapper-path %s holds", (command) => {
    expect(alwaysAskCommand(command, "/w")).toMatchObject({ rule: "unreadable" });
  });
});

describe("FULL-DENY-1018 mutant rows", () => {
  it("M-FD-gate Full access: >> ~/.kube/./config asks", () => {
    const command = ">> ~/.kube/./config";
    expect(autoVerdict(FULL, "Bash", command, ctx(command))).toMatchObject({ approve: null, source: "sensitive-guard" });
  });
  for (const [level, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
    it.each(MUTANT_ROWS)(`%s ${level}: %s`, (_label, command, asksFull, asksNoLimits) => {
      const asks = level === "No limits" && asksNoLimits !== undefined ? asksNoLimits : asksFull;
      const verdict = autoVerdict(bot, "Bash", command, ctx(command));
      if (level === "No limits") {
        // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected writes keep their deny card, including owner-only protected targets.
        // S1-B3 RULING (MAIN 2026-11-11 09:30Z): the explicit syscall fixture writes /etc/passwd; library imports retain the inherited run assertion.
        if (asks && (_label !== "M-FD-ffi" || command.includes(".syscall("))) expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
        else expectNoLimitsOwnerOutcome(verdict, command, noLimitsRule(command));
        return;
      }
      if (asks) { expect(verdict.approve).toBeNull(); expect(["always-ask", "sensitive-guard"]).toContain(verdict.source); }
      else expect(verdict.approve).not.toBeNull();
    });
  }
});

describe("FULL-DENY-1018: a deny rule holds at every level", () => {
  for (const [level, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
    // a protected file runs on a clean owner No limits turn and is recorded by its gate row (NOLIMITS-MEANS-IT 2.3), so the odd
    // spellings are pinned at Full access, where the plain spelling asks
    it.each(level === "Full access" ? [...DENIED, ...GATE_SPELLINGS] : DENIED)(`${level}: %s asks`, (command) => {
      const verdict = autoVerdict(bot, "Bash", command, ctx(command));
      if (level === "No limits") {
        // S1-B3 RULING (MAIN 2026-11-11 09:30Z): these protected-write run expectations are superseded.
        expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
        return;
      }
      expect(verdict.approve).toBeNull();
      expect(["always-ask", "sensitive-guard"]).toContain(verdict.source);
    });
    it.each(ORDINARY)(`${level}: %s keeps running`, (command) => {
      expect(autoVerdict(bot, "Bash", command, ctx(command)).approve).not.toBeNull();
    });
  }
});

// FULL-DENY-1018 (MurageMain ruling 11-08): at owner No limits the ordinary character-device sinks RUN (exact match, never a /dev/
// prefix); every other /dev path stays protected. 1.0.17 ran the first four; the tip stopped them (always-ask.ts systemDescendant).
const DEV_SINK_RUNS = ["echo x > /dev/null", "make 2>&1 | tee /dev/stderr", "cmd > /dev/tty", "exec 3>/dev/fd/1"];
const DEV_PROTECTED_STOPS = [
  "dd if=x of=/dev/disk2", "cat x > /dev/sda", "echo x > /dev/mem", "tee /dev/fd/../disk0",
  "ln -sf /etc/hosts ./hosts && echo 1 > ./hosts",
];
describe("FULL-DENY-1018 ruling 11-08: device sinks at owner No limits", () => {
  it("control first: an ordinary write runs", () => {
    expect(autoVerdict(NO_LIMITS, "Bash", "echo x > ./out.txt", ctx("echo x > ./out.txt")).approve).not.toBeNull();
  });
  it.each(DEV_SINK_RUNS)("M-DEV-sink No limits: %s runs", (command) => {
    expect(autoVerdict(NO_LIMITS, "Bash", command, ctx(command)).approve).not.toBeNull();
  });
  it.each(DEV_PROTECTED_STOPS)("M-DEV-protected No limits: %s stops", (command) => {
    const verdict = autoVerdict(NO_LIMITS, "Bash", command, ctx(command));
    // S1-B3 RULING (MAIN 2026-11-11 09:30Z): protected device writes and writes through protected links still ask.
    expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
  });
  // The command rows above are also held by the independent device-write rule (disk-erase), so a /dev/ prefix widening of the
  // exemption leaves them green; the class rows below read the strict classifier itself and are what the prefix mutant turns red.
  it.each(["/dev/disk2", "/dev/rdisk0", "/dev/sda", "/dev/nvme0n1", "/dev/mem", "/dev/kmem", "/dev/fd/../disk0"])("M-DEV-protected class: %s is system", (path) => {
    expect(ownerMarks(() => protectedClass(path))).toBe("system");
  });
  it.each(["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/12"])("M-DEV-sink class: %s is not system", (path) => {
    expect(ownerMarks(() => protectedClass(path))).not.toBe("system");
  });
  it("control last: an ordinary write still runs", () => {
    expect(autoVerdict(NO_LIMITS, "Bash", "cp a ./b", ctx("cp a ./b")).approve).not.toBeNull();
  });
});
