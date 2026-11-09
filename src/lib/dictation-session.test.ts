import { describe, expect, it } from "vitest";
import {
  COULD_NOT_START,
  MACOS_ONLY,
  NEEDS_ACCESS,
  OFF_DURING_CALL,
  dictationReduce,
  dictationStartEligible,
  dictationStopControl,
  initialDictationState,
  type DictationEffect,
  type DictationEvent,
  type DictationKind,
  type DictationState,
} from "./dictation-session";

// The reducer over every row of DICTATION-LIFECYCLE-1018 section 2.2.

interface Played {
  state: DictationState;
  effects: DictationEffect[];
  all: DictationEffect[];
}
function play(events: DictationEvent[], from: DictationState = initialDictationState): Played {
  let state = from;
  let effects: DictationEffect[] = [];
  const all: DictationEffect[] = [];
  for (const event of events) {
    const result = dictationReduce(state, event);
    state = result.state;
    effects = result.effects;
    all.push(...effects);
  }
  return { state, effects, all };
}
const press = (owner = "A", token = "t1", base = "hello"): DictationEvent => ({ t: "press", owner, base, token });
const starting = () => play([press()]).state;
const listening = () => play([press(), { t: "startResolved", token: "t1" }]).state;
/** stopping (keep): finish asked, waiting for the final line. */
const finishing = () => play([press(), { t: "startResolved", token: "t1" }, { t: "stopRequest" }]).state;
/** stopping (stop in flight, attempt 1). */
const stopInFlight = () => play([press(), { t: "startResolved", token: "t1" }, { t: "stopRequest" }, { t: "finishDone", token: "t1" }]).state;
const failed = () => play([press(), { t: "startResolved", token: "t1" }, { t: "stopRequest" }, { t: "finishDone", token: "t1" }, { t: "stopRejected", attempt: 1 }]).state;
const states: Record<Exclude<DictationKind, "idle">, () => DictationState> = {
  starting,
  listening,
  stopping: finishing,
  failed,
};

describe("mic press", () => {
  it("idle: starts a session with a new token, owner, base and writeGen", () => {
    const { state, effects } = play([press()]);
    expect(state).toMatchObject({ kind: "starting", token: "t1", owner: "A", base: "hello", writeGen: 1, keepWords: true, sinkDetached: false });
    expect(effects).toEqual([{ t: "start", token: "t1" }]);
  });

  it("failed: stops again (discard) with a queued start; a resolved stop then starts, a rejected stop does not", () => {
    const pressed = play([press("B", "t2", "new")], failed());
    expect(pressed.state).toMatchObject({ kind: "stopping", keepWords: false, queuedStart: { owner: "B", base: "new", token: "t2" } });
    expect(pressed.effects).toEqual([{ t: "stop", token: "t1", attempt: 2 }]);

    const resolved = play([{ t: "stopResolved", attempt: 2 }], pressed.state);
    expect(resolved.state).toMatchObject({ kind: "starting", token: "t2", owner: "B", base: "new", queuedStart: null });
    expect(resolved.effects).toEqual([{ t: "start", token: "t2" }]);

    const rejected = play([{ t: "stopRejected", attempt: 2 }], pressed.state);
    expect(rejected.state).toMatchObject({ kind: "failed", queuedStart: null });
    expect(rejected.effects).toEqual([]);
  });

  it("from another draft while starting or listening: stop (discard) with a queued start for the new draft", () => {
    for (const from of [starting(), listening()]) {
      const { state, effects } = play([press("B", "t2", "")], from);
      expect(state).toMatchObject({ kind: "stopping", keepWords: false, queuedStart: { owner: "B", token: "t2" } });
      expect(effects).toEqual([{ t: "stop", token: "t1", attempt: 1 }]);
    }
  });

  it("the owner's own press while starting or listening is a stop request", () => {
    expect(play([press()], starting()).state.kind).toBe("stopping");
    expect(play([press()], listening()).effects).toEqual([{ t: "finish", token: "t1" }]);
  });

  it("while stopping: ignored (joins the stop in flight)", () => {
    const before = stopInFlight();
    const { state, effects } = play([press("B", "t2")], before);
    expect(state).toBe(before);
    expect(effects).toEqual([]);
  });
});

describe("start result", () => {
  it("resolves to listening", () => {
    expect(listening().kind).toBe("listening");
  });
  it("rejects to idle with the could-not-start message", () => {
    const { state } = play([{ t: "startRejected", token: "t1" }], starting());
    expect(state).toMatchObject({ kind: "idle", token: null, keepWords: false });
    expect(state.notice).toMatchObject({ owner: "A", text: COULD_NOT_START });
  });
  it("is ignored for another token, after a stop, or in any other kind", () => {
    const before = starting();
    expect(play([{ t: "startResolved", token: "other" }], before).state).toBe(before);
    expect(play([{ t: "startRejected", token: "other" }], before).state).toBe(before);
    const stopped = play([{ t: "stopRequest" }], before).state;
    expect(play([{ t: "startResolved", token: "t1" }], stopped).state).toBe(stopped);
    expect(play([{ t: "startRejected", token: "t1" }], stopped).state).toBe(stopped);
  });
});

describe("native end notices", () => {
  it("speech-busy while starting: idle, off during a call", () => {
    const { state } = play([{ t: "end", token: "t1", code: 1, reason: "speech-busy" }], starting());
    expect(state.kind).toBe("idle");
    expect(state.notice?.text).toBe(OFF_DURING_CALL);
    const l = listening();
    expect(play([{ t: "end", token: "t1", code: 1, reason: "speech-busy" }], l).state).toBe(l);
  });

  it("helper-stop-pending and stop-failed: failed from starting, listening and stopping, words no longer kept", () => {
    for (const reason of ["helper-stop-pending", "stop-failed"]) {
      for (const from of [starting(), listening(), finishing(), stopInFlight()]) {
        const { state, effects } = play([{ t: "end", token: "t1", code: 1, reason }], from);
        expect(state).toMatchObject({ kind: "failed", keepWords: false, finish: false, queuedStart: null, stop: null });
        expect(effects).toEqual([]);
      }
    }
  });

  it("failed invalidates the stop in flight: its late result is ignored", () => {
    const { state } = play([{ t: "end", token: "t1", code: 1, reason: "stop-failed" }, { t: "stopResolved", attempt: 1 }], stopInFlight());
    expect(state.kind).toBe("failed");
  });

  it("code 1 or 2 with another reason while starting or listening: idle with the existing messages", () => {
    for (const from of [starting(), listening()]) {
      expect(play([{ t: "end", token: "t1", code: 1, reason: "recognition-error" }], from).state.notice?.text).toBe(NEEDS_ACCESS);
      expect(play([{ t: "end", token: "t1", code: 2, reason: "unsupported-platform" }], from).state.notice?.text).toBe(MACOS_ONLY);
      const idle = play([{ t: "end", token: "t1", code: 1, reason: "dictation-disabled" }], from).state;
      expect(idle.kind).toBe("idle");
      expect(idle.notice?.text).not.toBe(NEEDS_ACCESS);
      expect(idle.notice?.text).toBeTruthy();
    }
  });

  it("code 1 while stopping (keep): as a settled finish (the words stay, so tidy), then the real stop", () => {
    const { state, effects } = play([{ t: "end", token: "t1", code: 1, reason: "recognition-error" }], finishing());
    expect(state).toMatchObject({ kind: "stopping", keepWords: false, finish: false, stop: 1 });
    expect(effects).toEqual([{ t: "tidy", owner: "A", base: "hello", writeGen: 1 }, { t: "stop", token: "t1", attempt: 1 }]);
  });

  it("code 1 while a stop is already in flight changes nothing", () => {
    const before = stopInFlight();
    expect(play([{ t: "end", token: "t1", code: 1, reason: "x" }], before).state).toBe(before);
  });

  it("code 0 completed while listening: final already written, tidy, idle (no stop: the helper exited)", () => {
    const { state, effects } = play([{ t: "end", token: "t1", code: 0, reason: "completed" }], listening());
    expect(state).toMatchObject({ kind: "idle", keepWords: false, token: null });
    expect(effects).toEqual([{ t: "tidy", owner: "A", base: "hello", writeGen: 1 }]);
  });

  it("superseded: idle from any kind but idle, writeGen bumped, no tidy", () => {
    for (const from of [starting(), listening(), finishing(), stopInFlight(), failed()]) {
      const { state, effects } = play([{ t: "end", token: "t1", code: 0, reason: "superseded" }], from);
      expect(state).toMatchObject({ kind: "idle", keepWords: false, writeGen: from.writeGen + 1, finish: false, queuedStart: null });
      expect(effects).toEqual([]);
    }
    const idle = play([{ t: "end", token: "t1", code: 0, reason: "superseded" }], listening()).state;
    expect(play([{ t: "end", token: "t1", code: 0, reason: "superseded" }], idle).state).toBe(idle);
  });

  it("an end for another token is ignored", () => {
    const before = listening();
    expect(play([{ t: "end", token: "old", code: 0, reason: "superseded" }], before).state).toBe(before);
    expect(play([{ t: "end", token: "old", code: 1, reason: "stop-failed" }], before).state).toBe(before);
  });
});

describe("stop requests (mic, Escape, approval, takeover, locked)", () => {
  it("starting: stop (discard)", () => {
    const { state, effects } = play([{ t: "stopRequest" }], starting());
    expect(state).toMatchObject({ kind: "stopping", keepWords: false, stop: 1 });
    expect(effects).toEqual([{ t: "stop", token: "t1", attempt: 1 }]);
  });
  it("listening: stop (keep): finish with the 1.5 s deadline", () => {
    const { state, effects } = play([{ t: "stopRequest" }], listening());
    expect(state).toMatchObject({ kind: "stopping", keepWords: true, finish: true, stop: null });
    expect(effects).toEqual([{ t: "finish", token: "t1" }]);
  });
  it("stopping, failed and idle: ignored", () => {
    for (const before of [finishing(), stopInFlight(), failed(), initialDictationState]) {
      expect(play([{ t: "stopRequest" }], before).state).toBe(before);
    }
  });
});

describe("finish settles", () => {
  it("the final line (end code 0), the deadline or a finish rejection: words no longer kept, tidy, then the real stop", () => {
    const settle: DictationEvent[] = [{ t: "end", token: "t1", code: 0, reason: "completed" }, { t: "finishDone", token: "t1" }];
    for (const event of settle) {
      const { state, effects } = play([event], finishing());
      expect(state).toMatchObject({ kind: "stopping", keepWords: false, finish: false, stop: 1 });
      expect(effects).toEqual([{ t: "tidy", owner: "A", base: "hello", writeGen: 1 }, { t: "stop", token: "t1", attempt: 1 }]);
    }
  });
  it("a finish result for another token is ignored", () => {
    const before = finishing();
    expect(play([{ t: "finishDone", token: "old" }], before).state).toBe(before);
  });
  it("settling twice does not stop twice", () => {
    const first = play([{ t: "finishDone", token: "t1" }], finishing());
    expect(play([{ t: "finishDone", token: "t1" }], first.state).effects).toEqual([]);
  });
});

describe("stop results", () => {
  it("a resolved current attempt: idle", () => {
    const { state } = play([{ t: "stopResolved", attempt: 1 }], stopInFlight());
    expect(state).toMatchObject({ kind: "idle", token: null, stop: null });
  });
  it("a rejected current attempt: failed, queued start dropped", () => {
    const { state } = play([{ t: "stopRejected", attempt: 1 }], stopInFlight());
    expect(state).toMatchObject({ kind: "failed", queuedStart: null, stop: null, keepWords: false });
  });
  it("an old attempt's result is ignored after Stop again", () => {
    const again = play([{ t: "stopAgain" }], failed());
    expect(again.state).toMatchObject({ kind: "stopping", stop: 2, keepWords: false });
    expect(again.effects).toEqual([{ t: "stop", token: "t1", attempt: 2 }]);
    expect(play([{ t: "stopResolved", attempt: 1 }], again.state).state).toBe(again.state);
    expect(play([{ t: "stopRejected", attempt: 1 }], again.state).state).toBe(again.state);
    expect(play([{ t: "stopResolved", attempt: 2 }], again.state).state.kind).toBe("idle");
  });
  it("Stop again outside failed is ignored", () => {
    const before = listening();
    expect(play([{ t: "stopAgain" }], before).state).toBe(before);
  });
});

describe("send and owner unmount", () => {
  for (const name of ["send", "unmount"] as const) {
    describe(name, () => {
      const ev: DictationEvent = { t: name, owner: "A" };
      it("starting or listening: writeGen bumped, box detached, base cleared, stop (discard), queued start dropped", () => {
        for (const from of [starting(), listening()]) {
          const { state, effects } = play([ev], from);
          expect(state).toMatchObject({ kind: "stopping", keepWords: false, finish: false, sinkDetached: true, base: "", writeGen: from.writeGen + 1, queuedStart: null, stop: 1 });
          expect(effects).toEqual([{ t: "stop", token: "t1", attempt: 1 }]);
        }
      });
      it("stopping (keep, finish pending): the finish wait is cancelled and the stop is issued", () => {
        const { state, effects } = play([ev], finishing());
        expect(state).toMatchObject({ kind: "stopping", keepWords: false, finish: false, stop: 1 });
        expect(effects).toEqual([{ t: "stop", token: "t1", attempt: 1 }]);
      });
      it("stopping with a stop in flight: joins it, no new IPC", () => {
        const before = stopInFlight();
        const { state, effects } = play([ev], before);
        expect(effects).toEqual([]);
        expect(state).toMatchObject({ kind: "stopping", stop: before.stop, attempt: before.attempt, keepWords: false, writeGen: before.writeGen + 1 });
      });
      it("stopping with a queued start: the queued start is cancelled", () => {
        const queued = play([press("B", "t2")], listening()).state;
        expect(queued.queuedStart).not.toBeNull();
        expect(play([{ t: name, owner: "A" }], queued).state.queuedStart).toBeNull();
      });
      it("failed: a new stop attempt", () => {
        const { state, effects } = play([ev], failed());
        expect(state).toMatchObject({ kind: "stopping", stop: 2, keepWords: false, sinkDetached: true });
        expect(effects).toEqual([{ t: "stop", token: "t1", attempt: 2 }]);
      });
      it("idle: only writeGen moves, so a pending tidy-up is void", () => {
        const idle = play([{ t: "stopRequest" }, { t: "finishDone", token: "t1" }, { t: "stopResolved", attempt: 1 }], listening()).state;
        expect(idle.kind).toBe("idle");
        const { state, effects } = play([ev], idle);
        expect(state).toMatchObject({ kind: "idle", writeGen: idle.writeGen + 1 });
        expect(effects).toEqual([]);
      });
      it("from a draft that does not own the session and has nothing queued: ignored", () => {
        const before = listening();
        expect(play([{ t: name, owner: "B" }], before).state).toBe(before);
      });
      it("from a draft waiting behind the stop: its queued start is cancelled, the owner's stop is untouched", () => {
        const queued = play([press("B", "t2")], listening()).state;
        const { state, effects } = play([{ t: name, owner: "B" }], queued);
        expect(state).toMatchObject({ kind: "stopping", queuedStart: null, stop: queued.stop, writeGen: queued.writeGen });
        expect(effects).toEqual([]);
        // the stop of A then resolves to idle: B never starts
        const done = play([{ t: "stopResolved", attempt: queued.stop! }], state);
        expect(done.state.kind).toBe("idle");
        expect(done.effects).toEqual([]);
      });
    });
  }
});

describe("a restart after a stop", () => {
  it("start, stop, start again: the second session has a new token and writeGen", () => {
    const { state } = play([
      press(), { t: "startResolved", token: "t1" }, { t: "stopRequest" }, { t: "finishDone", token: "t1" }, { t: "stopResolved", attempt: 1 },
      press("A", "t2", ""), { t: "startResolved", token: "t2" },
    ]);
    expect(state).toMatchObject({ kind: "listening", token: "t2", writeGen: 2, keepWords: true });
  });
  it("delayed events of the first session are ignored by the second", () => {
    const second = play([press("A", "t2", "")], play([press(), { t: "startResolved", token: "t1" }, { t: "end", token: "t1", code: 0, reason: "completed" }]).state).state;
    expect(second.token).toBe("t2");
    expect(play([{ t: "end", token: "t1", code: 0, reason: "completed" }], second).state).toBe(second);
    expect(play([{ t: "finishDone", token: "t1" }], second).state).toBe(second);
    expect(play([{ t: "startResolved", token: "t1" }], second).state).toBe(second);
  });
});

describe("dictationStopControl and dictationStartEligible", () => {
  const kinds: DictationKind[] = ["idle", "starting", "listening", "stopping", "failed"];
  const base = { ownerMounted: true, covered: false, approval: false, locked: false, available: true };

  it("idle has no stop control", () => {
    expect(dictationStopControl("idle", base)).toBeNull();
    expect(dictationStopControl("idle", { ...base, ownerMounted: false, covered: true, approval: true, locked: true, available: false })).toBeNull();
  });

  it("the mic when the owner is mounted, uncovered, unapproved, unlocked and available, outside failed", () => {
    for (const kind of ["starting", "listening", "stopping"] as const) expect(dictationStopControl(kind, base)).toBe("mic");
    expect(dictationStopControl("failed", base)).toBe("strip");
  });

  it("the strip when any mic condition fails while the owner is mounted and uncovered", () => {
    for (const kind of kinds.filter((k) => k !== "idle")) {
      for (const patch of [{ approval: true }, { locked: true }, { available: false }]) {
        expect(dictationStopControl(kind, { ...base, ...patch })).toBe("strip");
      }
    }
  });

  it("the app bar when the owner is not mounted or a layer covers it, whatever else holds", () => {
    for (const kind of kinds.filter((k) => k !== "idle")) {
      for (const patch of [{ ownerMounted: false }, { covered: true }]) {
        for (const extra of [{}, { approval: true }, { locked: true }, { available: false }]) {
          expect(dictationStopControl(kind, { ...base, ...patch, ...extra })).toBe("app");
        }
      }
    }
  });

  it("the sweep: every kind and takeover has exactly one answer, and start is offered only when idle and eligible", () => {
    const flags = [false, true];
    for (const kind of kinds) {
      for (const ownerMounted of flags) for (const covered of flags) for (const approval of flags) for (const locked of flags) for (const available of flags) {
        const stop = dictationStopControl(kind, { ownerMounted, covered, approval, locked, available });
        expect(stop === null).toBe(kind === "idle");
        const start = dictationStartEligible({ kind, available, locked, busy: false, hasContent: false, approval, covered });
        expect(start).toBe(kind === "idle" && available && !locked && !approval && !covered);
        if (start) expect(stop).toBeNull();
      }
    }
  });

  it("start is not offered when busy or when the box has content", () => {
    const eligible = { kind: "idle" as const, available: true, locked: false, busy: false, hasContent: false, approval: false, covered: false };
    expect(dictationStartEligible(eligible)).toBe(true);
    expect(dictationStartEligible({ ...eligible, busy: true })).toBe(false);
    expect(dictationStartEligible({ ...eligible, hasContent: true })).toBe(false);
  });
});

describe("every state is reachable and consistent", () => {
  it("each named state has the kind it claims", () => {
    for (const [kind, make] of Object.entries(states)) expect(make().kind).toBe(kind);
  });
});
