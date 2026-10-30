// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's routine carve-out (1.0.3): on a scheduled or manual routine
// run, a write or delete whose target is held in a value does not hold the
// turn. Everything else the always-ask reader finds, and every guard, holds
// exactly as A+ does; owner turns and webhooks keep the full check.
import { describe, expect, it } from "vitest";
import { alwaysAskCommand, alwaysAskRoutineCommand } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { approvalSummary } from "../shared/approval-summary.ts";
import { routineValueTargetLine } from "./routine-permissions.ts";
import type { StopHit } from "./stop-line.ts";

const CWD = "/home/tester/dev";
const AUTO = { autoApprove: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const routine = (command: string, extra: AutoContext = {}): AutoContext => ({
  commandText: command, commandCwd: CWD, automated: true, routineLevel: true, routineCarveOut: true, ...extra,
});
const owner = (command: string): AutoContext => ({ commandText: command, commandCwd: CWD });

describe("routine carve-out: the reader", () => {
  it.each([
    ['OUT="$(cat target.txt)"; cat x > "$OUT"', [{ tool: "a redirect", target: '"$OUT"' }]],
    ['tmp="$(cat list.txt)"; rm "$tmp"', [{ tool: "rm", target: '"$tmp"' }]],
    ['tmp="tempfile_$(date +%s).txt" && date > "$tmp" && rm "$tmp"', [{ tool: "a redirect", target: '"$tmp"' }, { tool: "rm", target: '"$tmp"' }]],
    ['t=$(mktemp -d); find "$t" -delete', [{ tool: "find -delete", target: '"$t"' }]],
    ['cd "$D" && rm -rf build', [{ tool: "rm", target: "a path in a folder set by a value" }]],
    ['find "$t" -name "*.tmp" -delete', [{ tool: "find -delete", target: '"$t"' }]],
    ['rsync -a --delete -- src/ "$DEST"', [{ tool: "rsync", target: '"$DEST"' }]],
  ])("%s passes on a routine and names the tool and target it passed over", (command, targets) => {
    expect(alwaysAskCommand(command, CWD)).toMatchObject({ rule: "unreadable" });
    expect(alwaysAskRoutineCommand(command, CWD)).toEqual({ hit: null, valueTarget: targets });
  });

  it.each([
    ["rm -rf ~", "delete-home"],
    ["cat x > /dev/disk0", "disk-erase"],
    // A+ reads a name bound to a literal as that literal: a disk, so it holds
    ['DISK=/dev/disk0; cat x > "$DISK"', "disk-erase"],
    ['t=$(mktemp -d); find $t -delete', "unreadable"],
    ['find "$t" -exec rm {} \\; -delete', "unreadable"],
    ['find "$(cat l)" -delete', "unreadable"],
    // a value spelling an action, with its terminator from another value (Astra)
    [`find ./build -type f "$ACTION" sh -c ':(){ :|:& };:' "$END" -delete`, "unreadable"],
    ['find . -name "$p" -delete', "unreadable"],
    // values spelling an action, a flag and its terminator among the roots (Astra r2)
    [`find . "$ACTION" sh "$FLAG" ':(){ :|:& };:' "$END" -delete`, "unreadable"],
    ['find "$a" "$b" -delete', "unreadable"],
    ['find "$a" ./x -delete', "unreadable"],
    ['find "$t" -delete -fprint "$f"', "unreadable"],
    // a mirror's source and option values are not its target (Astra)
    ['rsync --delete -e "$CMD" host:src ./dst', "unreadable"],
    ['rsync -a --delete "$SRC" ./dst', "unreadable"],
    // a value before `--` may be an option that runs a command (Astra r4)
    ['rsync --delete ./src host:dst --rsh="$CMD"', "unreadable"],
    ['rsync --delete ./src host:dst --rsync-path="$CMD"', "unreadable"],
    ['rsync -a --delete src/ "$DEST"', "unreadable"],
    ['rsync -a --delete -- "$SRC" ./dst', "unreadable"],
    ['rm "$t"; rm -rf ~', "delete-home"],
    ['cat x > "$t"; dd if=/dev/zero of=/dev/disk0', "disk-erase"],
    ['rm -rf "$t" /', "delete-root"],
    ['rm -rf "$t/"', "unknown-target"],
    ['rm -rf "/Users/$t"', "unknown-target"],
    ['rm $FLAGS /', "unreadable"],
    ['cp "$x" y', "unreadable"],
    ['rm "$t"; eval "$x"', "unreadable"],
    ['rm "$t"; sh -c "$x"', "unreadable"],
    ["rm 'unterminated", "unreadable"],
    ['rm "$t"; mv ~ /tmp/old', "protected-path"],
  ])("%s still holds on a routine (%s)", (command, rule) => {
    expect(alwaysAskRoutineCommand(command, CWD).hit).toMatchObject({ rule });
    expect(alwaysAskRoutineCommand(command, CWD).valueTarget).toBeUndefined();
  });

  it("an ordinary command has nothing to record", () => {
    expect(alwaysAskRoutineCommand("ls -la", CWD)).toEqual({ hit: null });
  });

  it("the carve leaves no state behind for the next ordinary read", () => {
    alwaysAskRoutineCommand('cat x > "$DISK"', CWD);
    expect(alwaysAskCommand('cat x > "$DISK"', CWD)).toMatchObject({ rule: "unreadable" });
  });
});

describe("routine carve-out: the verdict", () => {
  const VALUE_WRITE = 'OUT="$(cat target.txt)"; cat x > "$OUT"';

  it("a routine run on Auto passes a value-held write and marks it for the run's history", () => {
    const verdict = autoVerdict(AUTO, "Bash", VALUE_WRITE, routine(VALUE_WRITE));
    expect(verdict.approve).toBeTruthy();
    expect(verdict.valueTarget).toEqual([{ tool: "a redirect", target: '"$OUT"' }]);
  });

  it("the owner's own turn with the same command still asks (1.0.10 1B fail closed: a command substitution keeps the card)", () => {
    expect(autoVerdict(AUTO, "Bash", VALUE_WRITE, owner(VALUE_WRITE))).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, owner(VALUE_WRITE))).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });

  it("a webhook run is not covered", () => {
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, { commandText: VALUE_WRITE, commandCwd: CWD, automated: true, unattended: true })).toMatchObject({ approve: null, source: "always-ask" });
    // even if a caller marked it a routine level, an unattended turn keeps the full check
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, routine(VALUE_WRITE, { unattended: true }))).toMatchObject({ approve: null, source: "always-ask" });
  });

  it("a peer turn, a cut card, host control and a non-command tool keep the full check", () => {
    // 1.0.10 (1B fail closed): a command substitution is never waived, so a peer turn keeps the card too
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, routine(VALUE_WRITE, { routineCarveOut: undefined }))).toMatchObject({ source: "always-ask" });
    expect(autoVerdict(AUTO, "Bash", VALUE_WRITE, routine(VALUE_WRITE, { routineCarveOut: undefined }))).toMatchObject({ source: "always-ask" });
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, routine(VALUE_WRITE, { inputCut: true }))).toMatchObject({ source: "always-ask" });
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, routine(VALUE_WRITE, { scope: "local-computer" }))).toMatchObject({ approve: null });
    expect(autoVerdict(NO_LIMITS, "Bash", VALUE_WRITE, { automated: true, routineLevel: true, routineCarveOut: true })).toMatchObject({ source: "always-ask" });
  });

  it.each(["rm -rf ~", "cat x > /dev/disk0", 'rm "$t"; rm -rf ~'])("a routine with %s still holds at No limits", (command) => {
    expect(autoVerdict(NO_LIMITS, "Bash", command, routine(command))).toMatchObject({ approve: null, source: "always-ask" });
  });

  it("keys still hold in a routine", () => {
    const command = 'cat ~/.ssh/id_rsa > "$OUT"';
    expect(autoVerdict(NO_LIMITS, "Bash", command, routine(command))).toMatchObject({ approve: null, source: "sensitive-guard" });
    expect(autoVerdict(AUTO, "Bash", command, routine(command))).toMatchObject({ approve: null, source: "sensitive-guard" });
  });

  it("a key past the card's cut summary still holds (Astra r2)", () => {
    const command = `cat x > "$OUT"; echo ${"a".repeat(4_500)}; cat ~/.ssh/id_rsa`;
    const summary = approvalSummary(command);
    expect(summary.length).toBeLessThan(command.length);
    expect(autoVerdict(NO_LIMITS, "Bash", summary, routine(command))).toMatchObject({ approve: null, source: "sensitive-guard" });
    const destructive = `cat x > "$OUT"; echo ${"a".repeat(4_500)}; git reset --hard`;
    expect(autoVerdict(AUTO, "Bash", approvalSummary(destructive), routine(destructive))).toMatchObject({ approve: null, source: "destructive-guard" });
  });

  it("the destructive guard and the stop line still decide on Auto", () => {
    const command = 'rm -rf "$t"';
    expect(autoVerdict(AUTO, "Bash", command, routine(command))).toMatchObject({ approve: null, source: "destructive-guard" });
    const stop: StopHit = { kind: "delete", place: "/x", what: "This deletes something outside its folder." };
    expect(autoVerdict(AUTO, "Bash", 'rm "$t"', routine('rm "$t"', { stopLine: stop }))).toMatchObject({ approve: null, source: "stop-line" });
  });

  it("a held verdict carries no history mark", () => {
    const command = 'rm -rf "$t"';
    expect(autoVerdict(AUTO, "Bash", command, routine(command)).valueTarget).toBeUndefined();
  });
});

describe("routine carve-out: the history line", () => {
  it("is one plain line naming the tool and target only", () => {
    const { valueTarget } = alwaysAskRoutineCommand('OUT="$(cat target.txt)";\n  cat x > "$OUT"', CWD);
    expect(routineValueTargetLine(valueTarget!)).toBe('Ran without asking, target held in a value: a redirect to "$OUT"');
    const long = routineValueTargetLine(alwaysAskRoutineCommand(`cat x > "$T" ${"a".repeat(300)}`, CWD).valueTarget!);
    expect(long).toBe('Ran without asking, target held in a value: a redirect to "$T"');
    expect(long).not.toMatch(/—|\bsafe|unsafe|safety/i);
  });
});
