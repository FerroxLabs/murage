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
const { alwaysAskCommand } = await import("./always-ask.ts");

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
  "cp build/tool /usr/local/bin/tool", "tee /dev/stderr", "echo hi > /dev/null", "ls 2>/dev/null", "cmd > /dev/null 2>&1", "cp /etc/hosts ./hosts",
  "cat /etc/hosts", "cd /etc && ls", "tar -xf a.tar -C out", "tar -cf a.tar src", "unzip a.zip -d out", "zip -r out.zip src",
  "find . -name x -delete", "find . -name x", "touch ~/x.txt", "awk '{print $1}' f", "echo x > ./out.txt", "cp a ../b", "echo a > ../../up",
];

/** One row per mutation label (scripts/check-marks-mutations.py kills a mutant by a failing test whose name carries its label). */
const MUTANT_ROWS: Array<[label: string, command: string, asks: boolean]> = [
  ["M-FD-redirect", "echo x > /etc/hosts", true],
  ["M-FD-find", "find ../../../../../../etc/cron.d -delete", true],
  ["M-FD-sed-w", "sed -e'w /etc/cron.d/pwn'", true],
  ["M-FD-archive", "tar -C ../../../../../../etc/cron.d -xf /tmp/o.tar", true],
  ["M-FD-home", "touch ~/../../../../../../etc/cron.d/pwn", true],
  ["M-FIX3-class", "printf x > /tmp/../proc/self/root/dev/sda", true],
  ["M-FIX2-protected", "mkdir -p /usr/share/x", true],
  ["M-FD-source", "cp /etc/hosts ./hosts", false],
  ["M-FD-usrlocal", "cp build/tool /usr/local/bin/tool", false],
  // MurageMain 11-07: code that calls into native code fails closed at every level (Astra r16 recheck OPEN 1)
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
    it.each(MUTANT_ROWS)(`%s ${level}: %s`, (_label, command, asks) => {
      const verdict = autoVerdict(bot, "Bash", command, ctx(command));
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
      expect(verdict.approve).toBeNull();
      expect(["always-ask", "sensitive-guard"]).toContain(verdict.source);
    });
    it.each(ORDINARY)(`${level}: %s keeps running`, (command) => {
      expect(autoVerdict(bot, "Bash", command, ctx(command)).approve).not.toBeNull();
    });
  }
});
