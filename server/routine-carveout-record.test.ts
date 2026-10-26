// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The routine carve-out's run-history record: what it writes, the card it
// raises when the record cannot be written, and when a turn is marked as a
// routine run's own.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alwaysAskRoutineCommand } from "./always-ask.ts";
import { approvalHoldNote, autoVerdict } from "./auto-approve.ts";
import { routineRecordUnwrittenVerdict, routineValueTargetLine } from "./routine-permissions.ts";

describe("routineValueTargetLine", () => {
  // assembled at runtime so no token-shaped literal sits in the source
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  const key = `sk-ant-api03-${alpha}`;
  const CWD = "/home/tester/dev";
  const LEAD = "Ran without asking, target held in a value: ";
  const ROUTINE = { autoApprove: true };
  const lineOf = (command: string): string => {
    const { hit, valueTarget } = alwaysAskRoutineCommand(command, CWD);
    expect(hit).toBeNull();
    expect(valueTarget).toBeDefined();
    return routineValueTargetLine(valueTarget!);
  };

  it("stores no argument of the command: a quoted password beside a value rm target stays out", () => {
    const command = 'deploy --password "hunter2xyz" --verbose; rm "$TMP"';
    const line = lineOf(command);
    expect(line).not.toContain("hunter2xyz");
    expect(line).not.toContain("deploy");
    expect(line).not.toContain("--password");
    expect(line).toBe(`${LEAD}rm on "$TMP"`);
  });

  it("a long key and a quoted password both stay out, however redaction changes their length (Astra)", () => {
    const command = `TOKEN=${key}${"a".repeat(100)} PASSWORD='tiny!Password987' make build > "$OUT"`;
    const line = lineOf(command);
    // Astra's case: a long value before the password, and the routine verdict approves
    const astra = `TOKEN=${"a".repeat(100)} PASSWORD='tiny!Password987' make build > "$OUT"`;
    const verdict = autoVerdict(ROUTINE, "Bash", astra, { commandText: astra, commandCwd: CWD, automated: true, routineLevel: true, routineCarveOut: true });
    expect(verdict.approve).toBeTruthy();
    expect(routineValueTargetLine(verdict.valueTarget!)).toBe(`${LEAD}a redirect to "$OUT"`);
    expect(line).not.toContain(alpha);
    expect(line).not.toContain("sk-ant");
    expect(line).not.toContain("tiny!Password987");
    expect(line).not.toContain("Password987");
    expect(line).toBe(`${LEAD}a redirect to "$OUT"`);
  });

  it("a redirect stores no source text", () => {
    const line = lineOf('cat private-notes.txt | grep -v hunter2xyz > "$OUT"');
    expect(line).not.toContain("private-notes");
    expect(line).not.toContain("hunter2xyz");
    expect(line).not.toContain("cat");
    expect(line).toBe(`${LEAD}a redirect to "$OUT"`);
  });

  it.each([
    ['tmp="$(cat list.txt)"; rm -f "$tmp"', 'rm on "$tmp"'],
    ['echo "hunter2xyz" > "$OUT"', 'a redirect to "$OUT"'],
    ['t=$(mktemp -d); find "$t" -name "hunter2xyz*" -delete', 'find -delete on "$t"'],
    ['rsync -a --delete --password-file=hunter2xyz -- src/ "$DEST"', 'rsync on "$DEST"'],
  ])("%s gives its tool and target only", (command, entry) => {
    const line = lineOf(command);
    expect(line).toBe(`${LEAD}${entry}`);
    expect(line).not.toContain("hunter2xyz");
  });

  it("records no string spelled inside the target word itself (Astra r6)", () => {
    const line = lineOf(`echo ok > "$(lookup --password 'tiny!Password987')"`);
    expect(line).not.toContain("Password987");
    expect(line).not.toContain("lookup");
    expect(line).toBe(`${LEAD}a redirect to "$(...)"`);
    expect(lineOf('cat x > "$D/hunter2xyz.txt"')).toBe(`${LEAD}a redirect to "$D/..."`);
    expect(lineOf('rm "${T:-hunter2xyz}"')).toBe(`${LEAD}rm on "\${T:-...}"`);
    expect(lineOf('rm "$(echo hunter2xyz)/$N"')).toBe(`${LEAD}rm on "$(...)/...$N"`);
    // cmd keeps a substitution's word inside the variable's name (Astra r7)
    const viaCmd = lineOf("cmd /c echo ok > %D:x=HUNTER2XYZ%");
    expect(viaCmd).not.toMatch(/hunter2xyz/i);
    expect(viaCmd).toBe(`${LEAD}a redirect to $...`);
  });

  it("names every target it passed over, once each", () => {
    expect(lineOf('tmp="tempfile_$(date +%s).txt" && date > "$tmp" && rm "$tmp"')).toBe(`${LEAD}a redirect to "$tmp"; rm on "$tmp"`);
  });

  it("masks a secret inside a stored field as a second layer", () => {
    const line = routineValueTargetLine([{ tool: "rm", target: `"$DIR/${key}"` }]);
    expect(line).not.toContain(alpha);
  });

  it("keeps the line short with many targets, and counts the rest", () => {
    const targets = Array.from({ length: 7 }, (_, i) => ({ tool: "rm", target: `"$T${i}"` }));
    expect(routineValueTargetLine(targets)).toBe(`${LEAD}rm on "$T0"; rm on "$T1"; rm on "$T2"; rm on "$T3"; and 3 more`);
    const long = routineValueTargetLine([{ tool: "rm", target: `"$\{X:-${"a".repeat(300)}}"` }]);
    expect(long.length).toBeLessThan(LEAD.length + 80);
    expect(long).not.toMatch(/—|\bsafe\b|\bunsafe\b|\bsafety\b/i);
  });
});

describe("routineRecordUnwrittenVerdict", () => {
  it("holds the card with its own note about the run record", () => {
    const verdict = routineRecordUnwrittenVerdict();
    expect(verdict).toMatchObject({ approve: null, source: "always-ask", rule: "run-record-unwritten" });
    const note = approvalHoldNote(verdict) ?? "";
    expect(note).toMatch(/run record/i);
    expect(note).not.toMatch(/unread|could not read/i);
    expect(note).not.toMatch(/—|\bsafe\b|\bunsafe\b|\bsafety\b/i);
  });
});

describe("routine origin mark", () => {
  it("marks the thread only after the turn is admitted to its slot", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const start = source.indexOf("async function startTurnAdmitting(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);
    const admit = body.indexOf("directRuns.admit(");
    const add = body.indexOf("routineOriginThreads.add(threadId)");
    const remove = body.indexOf("routineOriginThreads.delete(threadId)");
    expect(admit).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(admit);
    expect(remove).toBeGreaterThan(admit);
  });
});
