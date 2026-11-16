import { expect, it, vi } from "vitest";
import { assertEngineInput, fencedTurnInput, releaseNativeAnswer, steerBuilt } from "./engine-input.ts";
import { accountEngineWire, bindEngineWireFence, emitEngineWire, engineJsonLine } from "./engine-wire.ts";
import * as denyRead from "../memory/deny-read.ts";
import * as lineage from "../memory/lineage-write.ts";
import { buildPrompt, promptPart } from "../memory/prompt-parts.ts";
import type { ReleaseBudget } from "../memory/release-budget.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";

type Mode = "preparation" | "steer";
type Counts = ReleaseBudget["counts"];

function assertSingleCharge(before: Counts, after: Counts, expected: string): void {
  expect(after.bytes - before.bytes, "serialized UTF-8 bytes charged once").toBe(Buffer.byteLength(expected));
  expect(after.attempts - before.attempts, "one final wire event").toBe(1);
}

async function drive(mode: Mode, mutant = false, sabotage?: "retained" | "binding") {
  // Same isolated SQLite fixture and framing computation as D4; setup charges
  // precede the measurement, and no transport/provider or live app is used.
  const f = consumingFixture(undefined, { empty: false });
  const prompt = buildPrompt(f.turn, [promptPart('é\n"', [{ kind: "line", threadId: "T", messageId: "Y" }])]);
  const member = lineage.checkedOpenTurns(f.turn)[0]!;
  const fence = { reader: member.reader!, db: f.f.db, retained: f.turn };
  const caller = vi.fn(() => {
    if (sabotage === "retained") f.flip();
    if (sabotage === "binding") lineage.closeTurnLineage(f.turn);
  });
  const lookup = vi.spyOn(denyRead, "refsLookup");
  const resolve = vi.spyOn(lineage, "checkedOpenTurns");
  const charge = vi.spyOn(f.budget, "charge"); // Call-through: real counters/limits.
  const write = vi.fn();
  try {
    let callback: (() => void) | undefined;
    if (mode === "preparation") {
      callback = fencedTurnInput({ threadId: "T", prompt, beforeSubmit: caller }, fence).beforeSubmit;
    } else {
      await steerBuilt({ steer: async (_thread, _text, before) => { callback = before; return true; } },
        "T", prompt, fence, caller);
    }
    expect(callback).toBeTypeOf("function");
    const original = callback!;
    const frame = { type: "user", message: { role: "user", content: prompt.text } };
    const expected = JSON.stringify(frame) + "\n"; // D4 engine-wire.test.ts:77.
    if (mutant) {
      // Real original composition plus a second real final fence reservation.
      // No production patch, replacement budget, or mocked charge arithmetic.
      callback = () => original();
      bindEngineWireFence(callback, bytes => {
        accountEngineWire(original, expected);
        assertEngineInput(fence, prompt, bytes);
      }, (wire, sink) => emitEngineWire(original, wire, () => {
        // Candidate mutant: charge a second real release at the same sink.
        f.budget.charge({ attempts: 1, bytes: Buffer.byteLength(wire) });
        return sink();
      }));
    }
    const before = f.budget.counts;
    charge.mockClear();
    const release = () => {
      callback!();
      const wire = engineJsonLine(frame, callback);
      emitEngineWire(callback, wire, () => { expect(f.f.db.isTransaction).toBe(true); write(wire); });
    };
    if (sabotage) {
      expect(release).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(caller).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(f.refusals).toBe(1);
      return;
    }
    release();
    const after = f.budget.counts;
    expect(caller).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    // The callback, serializer preflight and both writer stages validate
    // the captured member. Only the actual writer charges an emitted attempt.
    const retainedLookups = lookup.mock.calls.filter(args => args[1] === member.parents && args[3] === true);
    expect(retainedLookups).toHaveLength(mutant ? 5 : 4);
    expect(retainedLookups.every(args => args[2] === member.reader)).toBe(true);
    expect(resolve.mock.calls.filter(args => args[0] === f.turn).length).toBeGreaterThanOrEqual(3);
    expect(after.work).toBeGreaterThan(before.work);
    expect(after.statements).toBeGreaterThan(before.statements);
    if (mutant) {
      expect(after.bytes - before.bytes).toBe(2 * Buffer.byteLength(expected));
      expect(after.attempts - before.attempts).toBe(2);
      expect(() => assertSingleCharge(before, after, expected)).toThrow();
    } else {
      assertSingleCharge(before, after, expected);
      expect(charge.mock.calls.filter(([cost]) => (cost.bytes ?? 0) > 0)).toHaveLength(1);
      expect(charge.mock.calls.filter(([cost]) => (cost.attempts ?? 0) > 0)).toHaveLength(1);
    }
  } finally {
    charge.mockRestore(); resolve.mockRestore(); lookup.mockRestore(); f.close();
  }
}

// red-at-4bf670e33dd963dce78eeffd60e26c9d615c5060 (inspection; execution owed):
// composed callbacks charge three attempts for one serialized event.
it("T-SINGLE-CHARGE preparation callback charges each byte once", async () => {
  await drive("preparation");
});

// red-at-4bf670e33dd963dce78eeffd60e26c9d615c5060 (inspection; execution owed).
it("T-SINGLE-CHARGE steer callback charges each byte once", async () => {
  await drive("steer");
});

// control: the identical single-charge assertion must reject the mutant.
it("T-SINGLE-CHARGE detects a double-charging composition", async () => {
  await drive("preparation", true);
  await drive("steer", true);
});

// control: validation is neither removed nor memoized when event charging moves.
it.each(["preparation", "steer"] as const)("T-SINGLE-CHARGE %s retains post-callback authority checks", async mode => {
  await drive(mode, false, "retained");
  await drive(mode, false, "binding");
});

// control: C's explicit non-consuming admission stays distinct from no binding.
it("T-SINGLE-CHARGE native binding discrimination remains fail closed", () => {
  const write = vi.fn();
  expect(() => releaseNativeAnswer(undefined, "fixture", "{}", write)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled();
  releaseNativeAnswer(null, "fixture", "{}", write);
  expect(write).toHaveBeenCalledTimes(1);
});
