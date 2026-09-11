// STOP2: the one place a terminal turn is classified. Every consumer that
// acts on a finished turn (outputs publication, delegation receipts, ask_bot
// replies, routine status, memory settlement) reads these three helpers, so
// their answers for each shape an engine can settle with are pinned here.
import { describe, expect, it } from "vitest";
import { turnOutcome, turnStopped, turnSucceeded } from "./turn-outcome.ts";
import { hostStoppedActivityName, hostStoppedReason, HOST_STOPPED_PREFIX } from "../shared/host-stop.ts";

const classify = (event: { ok: boolean; stopReason?: string | null }) => ({
  stopped: turnStopped(event),
  succeeded: turnSucceeded(event),
  outcome: turnOutcome(event),
});

describe("turn outcome", () => {
  it("a user Stop settles ok:true 'cancelled' on every engine: stopped, never success", () => {
    expect(classify({ ok: true, stopReason: "cancelled" })).toEqual({ stopped: true, succeeded: false, outcome: "cancelled" });
  });

  it("a turn that ran to its end is the only success", () => {
    expect(classify({ ok: true, stopReason: "end_turn" })).toEqual({ stopped: false, succeeded: true, outcome: "completed" });
    expect(classify({ ok: true, stopReason: null })).toEqual({ stopped: false, succeeded: true, outcome: "completed" });
    expect(classify({ ok: true })).toEqual({ stopped: false, succeeded: true, outcome: "completed" });
  });

  it("an engine that still reports an interrupt as ok:false is a failure, not a stop", () => {
    expect(classify({ ok: false, stopReason: "interrupted" })).toEqual({ stopped: false, succeeded: false, outcome: "failed" });
  });

  it("an engine that exits before its result is a failure", () => {
    expect(classify({ ok: false, stopReason: "exit_before_result" })).toEqual({ stopped: false, succeeded: false, outcome: "failed" });
    expect(classify({ ok: false, stopReason: null })).toEqual({ stopped: false, succeeded: false, outcome: "failed" });
    expect(classify({ ok: false })).toEqual({ stopped: false, succeeded: false, outcome: "failed" });
  });

  it("a host-initiated stop goes through the same interruptTurn and settles exactly like a user Stop", () => {
    // The connection-changed and computer-switched-off paths in server/index.ts
    // call the driver's interruptTurn, so the terminal event is the same
    // ok:true "cancelled" a person's Stop yields — and never counts as done.
    for (const reason of ["the model connection it was using was changed or turned off", "this computer was switched off for the bot"]) {
      const notice = hostStoppedActivityName(reason);
      expect(notice.startsWith(HOST_STOPPED_PREFIX)).toBe(true);
      expect(notice.startsWith("error:")).toBe(false);
      expect(hostStoppedReason(notice)).toBe(reason);
      expect(classify({ ok: true, stopReason: "cancelled" })).toEqual({ stopped: true, succeeded: false, outcome: "cancelled" });
    }
  });

  it("ok:false with a 'cancelled' reason is still a stop, not a failure", () => {
    // ok is "not an engine failure"; the stop reason decides. A driver that
    // both flags failure and names the cancel must not produce an error card.
    expect(classify({ ok: false, stopReason: "cancelled" })).toEqual({ stopped: true, succeeded: false, outcome: "cancelled" });
  });
});

describe("host-stop notice name", () => {
  it("only a 'stopped:' name carries a reason; tool runs and error chips do not", () => {
    expect(hostStoppedReason("stopped: this computer was switched off for the bot")).toBe("this computer was switched off for the bot");
    expect(hostStoppedReason("error: claude exited null before result")).toBeUndefined();
    expect(hostStoppedReason("Read")).toBeUndefined();
    expect(hostStoppedReason("stopped:")).toBeUndefined();
    expect(hostStoppedReason(undefined)).toBeUndefined();
    expect(hostStoppedReason(null)).toBeUndefined();
  });
});
