// secret-scan: fixture (fake paths, policy test rows)
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FULL-DENY-1018: Full access protects system paths, including climbs and odd spellings.
// MAIN 11-12: "No limits = wipe check only". The owner still gets cards for whole-root wipes and destructive device writes.
import { describe, expect, it } from "vitest";
import type { AutoContext } from "./auto-approve.ts";

const { autoVerdict } = await import("./auto-approve.ts");
const { alwaysAskCommand, protectedClass } = await import("./always-ask.ts");
const { ownerMarks } = await import("./testing/marks-nlh0.ts");
const { expectNoLimitsProtectedWrite } = await import("./testing/no-limits-1019.ts");

const FULL = { id: "owned", autoApprove: true, fullAccess: true };
const NO_LIMITS = { ...FULL, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const ctx = (command: string): AutoContext => ({ ...OWNER, commandText: command, commandCwd: "/w" });

// MAIN 11-12: "No limits = wipe check only". These commands are inspected as text.
it.each(["find ../../.. -delete", "find ../../.. -exec rm -rf {} \\;"])(
  "No limits wipe check holds %s",
  (command) => {
    expect(autoVerdict(NO_LIMITS, "Bash", command, ctx(command))).toMatchObject({
      approve: null, source: "always-ask", rule: "delete-root",
    });
  },
);

const CLIMB = "../../../../../../etc/cron.d";
const DEVICE_ALIASES = [
  "printf x > /tmp/../proc/self/root/dev/sda",
  "echo x > /var/tmp/../../proc/self/cwd/../dev/sda",
  "echo x > /tmp/../proc/thread-self/cwd/../dev/sda",
];
const DENIED: string[] = [
  `mv ./blob ${CLIMB}/pwn`, `cp ./blob ${CLIMB}/pwn`, `tee ${CLIMB}/pwn`, `touch ${CLIMB}/pwn`, `touch ~/${CLIMB}/pwn`,
  `install -m 644 ./blob ${CLIMB}/pwn`, `ln -sf /tmp/blob ${CLIMB}/pwn`, `rsync -a /tmp/a/ ${CLIMB}/`, `find ${CLIMB} -delete`,
  "find /w -fprintf /etc/out %p", "find /w -fls /etc/out",
  `tar -C ${CLIMB} -xf /tmp/o.tar`, `tar --directory=${CLIMB} -xf /tmp/o.tar`, `unzip -d ${CLIMB} /tmp/o.zip`, `zip ${CLIMB}/o.zip /tmp/a`,
  "sed -e'w /etc/cron.d/pwn'", "sed --expression='w /etc/cron.d/pwn'", "sed -e 1p -e 'w /etc/cron.d/pwn' notes.txt", `sed -i -e 1p ${CLIMB}/../passwd`,
  `awk 'BEGIN{print "owned" > "/etc/cron.d/pwn"}'`,
  "echo x > /etc/hosts", "printf x > /tmp/../sys/../w/x", ...DEVICE_ALIASES,
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
const MUTANT_ROWS: Array<[label: string, command: string, asksFull: boolean]> = [
  ["M-FD-redirect", "echo x > /etc/hosts", true],
  ["M-FD-find", "find ../../../../../../etc/cron.d -delete", true],
  ["M-FD-sed-w", "sed -e'w /etc/cron.d/pwn'", true],
  ["M-FD-archive", "tar -C ../../../../../../etc/cron.d -xf /tmp/o.tar", true],
  ["M-FD-home", "touch ~/../../../../../../etc/cron.d/pwn", true],
  ["M-FIX3-class", DEVICE_ALIASES[0], true],
  ["M-FIX2-protected", "mkdir -p /usr/share/x", true],
  ["M-FD-source", "cp /etc/hosts ./hosts", false],
  ["M-FD-usrlocal", "cp build/tool /usr/local/bin/tool", false],
  // MurageMain 11-07: opaque native calls hold at Full access.
  ["M-FD-ffi", `python3 -c 'import ctypes; ctypes.CDLL(None).syscall(87, b"/etc/passwd")'`, true],
  ["M-FD-ffi", `python3 -c 'import cffi; cffi.FFI().dlopen(None)'`, true],
  ["M-FD-ffi", `node -e 'require("ffi-napi")'`, true],
  ["M-FD-ffi", `ruby -e 'require "fiddle"; Fiddle.dlopen(nil)'`, true],
  // MurageMain 11-07: in `ln -s TARGET LINK` only LINK is written; a hard link keeps both as write targets
  ["M-FD-ln", "ln -s /usr/bin/x ./y", false],
  ["M-FD-ln", "ln -sf /etc/hosts ./hosts", false],
  ["M-FD-ln", "ln -s ./a /usr/y", true],
  ["M-FD-ln", "ln /usr/bin/x ./y", true],
  ["M-FD-ln", "ln -s -t /usr/bin ./x", true],
];

function expectNoLimitsWrite(command: string, device: boolean): void {
  const verdict = autoVerdict(NO_LIMITS, "Bash", command, ctx(command));
  // MAIN 11-12 / NL-WIPE-ONLY-FIXTURES: "No limits = wipe check only". Ordinary owner writes run and device wipes card.
  if (device) expect(verdict).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase" });
  else {
    expectNoLimitsProtectedWrite(verdict, command);
    expect(verdict.source).toBe("no-limits");
  }
}

describe("MARKS r11: the strict read of an unproven wrapper path", () => {
  // a wrapper spelled by a path outside the system bin folders is not the wrapper its name says (the strict read holds it)
  it.each(["command ./x/env echo x", "nohup /opt/bin/env echo x"])("M-FIX2-wrapper-path %s holds", (command) => {
    expect(alwaysAskCommand(command, "/w")).toMatchObject({ rule: "unreadable" });
  });
});

/** OVERREACH #6: what the owner's own Full access turn does with a row the always-ask reader names: exactly what No limits does with it. */
function expectFullOwnerLikeNoLimits(command: string, verdict: ReturnType<typeof autoVerdict>): void {
  const noLimits = autoVerdict(NO_LIMITS, "Bash", command, ctx(command));
  // the key guard cards at Full access whatever No limits does with the same text
  if (verdict.source === "sensitive-guard") { expect(verdict.approve).toBeNull(); return; }
  expect(verdict.approve === null, `${command}: Full access card = No limits card`).toBe(noLimits.approve === null);
  if (verdict.approve === null) expect(["always-ask", "sensitive-guard"]).toContain(verdict.source);
  else expect(verdict.source).toBe("full-access");
}

describe("FULL-DENY-1018 mutant rows", () => {
  it("M-FD-gate Full access: >> ~/.kube/./config asks", () => {
    const command = ">> ~/.kube/./config";
    expect(autoVerdict(FULL, "Bash", command, ctx(command))).toMatchObject({ approve: null, source: "sensitive-guard" });
  });
  it.each(MUTANT_ROWS)("%s Full access: %s", (_label, command, asksFull) => {
    const verdict = autoVerdict(FULL, "Bash", command, ctx(command));
    // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn takes No limits' outcome for the always-ask rules: a protected
    // path runs, a wipe (a disk-erase device write) and the key guard still ask.
    if (asksFull) expectFullOwnerLikeNoLimits(command, verdict);
    else expect(verdict.approve).not.toBeNull();
  });
  it.each(MUTANT_ROWS)("%s No limits: %s", (_label, command) => {
    expectNoLimitsWrite(command, DEVICE_ALIASES.includes(command));
  });
});

describe("FULL-DENY-1018: protected paths and the wipe check", () => {
  it.each([...DENIED, ...GATE_SPELLINGS])("Full access: %s follows the owner's No limits outcome (protected paths run; wipes and the key guard ask)", (command) => {
    expectFullOwnerLikeNoLimits(command, autoVerdict(FULL, "Bash", command, ctx(command)));
  });
  it.each(DENIED)("No limits: %s follows the wipe check", (command) => {
    expectNoLimitsWrite(command, DEVICE_ALIASES.includes(command));
  });
  for (const [level, bot] of [["Full access", FULL], ["No limits", NO_LIMITS]] as const) {
    it.each(ORDINARY)(`${level}: %s keeps running`, (command) => {
      expect(autoVerdict(bot, "Bash", command, ctx(command)).approve).not.toBeNull();
    });
  }
});

// MAIN 11-12: "No limits = wipe check only". Keep the older raw classifier controls for Full access.
const DEV_SINK_RUNS = ["echo x > /dev/null", "make 2>&1 | tee /dev/stderr", "cmd > /dev/tty", "exec 3>/dev/fd/1"];
const DEV_PROTECTED_STOPS = [
  "dd if=x of=/dev/disk2", "cat x > /dev/sda", "echo x > /dev/mem", "tee /dev/fd/../disk0", "echo x > /dev/kmem",
];
describe("FULL-DENY-1018 ruling 11-08: device sinks at owner No limits", () => {
  it("control first: an ordinary write runs", () => {
    expect(autoVerdict(NO_LIMITS, "Bash", "echo x > ./out.txt", ctx("echo x > ./out.txt")).approve).not.toBeNull();
  });
  it.each(DEV_SINK_RUNS)("M-DEV-sink No limits: %s runs", (command) => {
    expect(autoVerdict(NO_LIMITS, "Bash", command, ctx(command)).approve).not.toBeNull();
  });
  it.each(DEV_PROTECTED_STOPS)("M-DEV-protected No limits: %s stops", (command) => {
    expectNoLimitsWrite(command, true);
  });
  it.each([
    "ln -sf /etc/hosts ./hosts && echo 1 > ./hosts",
    "cat /dev/mem", "cat /dev/kmem", "echo x > /dev/memory", "echo x > /dev/kmemory",
  ])("M-DEV-protected No limits: %s runs", (command) => {
    expectNoLimitsWrite(command, false);
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
