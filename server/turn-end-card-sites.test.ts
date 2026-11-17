// The two guarded index card sites (runtime.error card, preparation-failure card), driven as the shipped index.ts functions.
import { describe, expect, it, vi, afterEach } from "vitest";
import { wiring } from "./decision-wiring/fixture.ts";
import { ENGINE_FALLBACK_TEXT, ownerEngineText } from "./turn-end.ts";
import { ERROR_MESSAGE_MAX } from "../shared/provider-error.ts";

afterEach(() => vi.restoreAllMocks());
const ADVERSARIAL = ["Engine said no — try later", "range 2–3 failed", "unsafe request", "do it safely", "a safer path", "unsafely", "the free tier", "Forge refused", "this will fail"];
const VERBATIM = ["please re-run", "freedom", "forged"];
const withheld = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(c => c[0] === "[turn] engine-text-withheld").length;

describe("runtime.error card: the stored card name", () => {
  const { runtimeErrorCardName } = wiring(["runtimeErrorCardName"], { ownerEngineText, ERROR_MESSAGE_MAX });
  it.each(ADVERSARIAL)("engine text %j gives the fallback sentence and one withheld log", text => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runtimeErrorCardName!(text)).toBe(`error: ${ENGINE_FALLBACK_TEXT}`);
    expect(withheld(warn)).toBe(1);
  });
  it.each(VERBATIM)("engine text %j passes verbatim with no log", text => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runtimeErrorCardName!(text)).toBe(`error: ${text}`);
    expect(withheld(warn)).toBe(0);
  });
});

describe("preparation-failure card: the stored card name", () => {
  class RecallDispatchPending extends Error { constructor() { super("Memory is still getting ready. Send it again in a moment."); } }
  class RecallPreparationPending extends Error {}
  class PinnedFailure extends Error {}
  const boundary = { canRetry: false, hasConfirmedSubmission: false, hasReleasedSubmission: false };
  const { preparationFailureText, turnFailureDiagnostic } = wiring(["preparationFailureText", "turnFailureDiagnostic"], {
    ownerEngineText, RecallDispatchPending, RecallPreparationPending, Error,
    pinnedMemoryFailure: (error: unknown, subject: string) => (error instanceof PinnedFailure ? `${subject} memory could not be read. Send it again.` : undefined),
    isMemoryContextRevoked: () => false,
    engineNameOf: (i: { driverKind: string }) => i.driverKind, lateMemoryRefusalLine: () => "late", turnRefusedLine: () => "refused", submissionRefusalKind: () => "not-started",
  });
  const card = (failure: unknown, owner = true) => turnFailureDiagnostic!(preparationFailureText!(failure, "Ada", owner, boundary, { driverKind: "codex" }, "codex")).name;
  it.each(ADVERSARIAL)("engine failure %j gives the fallback sentence and one withheld log", text => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(card(new Error(text))).toBe(`error: ${ENGINE_FALLBACK_TEXT}`);
    expect(withheld(warn)).toBe(1);
  });
  it("a thrown non-Error engine value goes through the same guard", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(card("unsafe request")).toBe(`error: ${ENGINE_FALLBACK_TEXT}`);
    expect(withheld(warn)).toBe(1);
  });
  it("host lines pass verbatim with no withheld log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(card(new RecallPreparationPending("x"))).toBe(`error: ${new RecallDispatchPending().message}`);
    expect(card(new PinnedFailure("x"))).toBe("error: Ada's memory could not be read. Send it again.");
    expect(card(new PinnedFailure("x"), false)).toBe("error: Could not start this reply. Send it again.");
    expect(card(new Error("please re-run"))).toBe("error: please re-run");
    expect(withheld(warn)).toBe(0);
  });
});
