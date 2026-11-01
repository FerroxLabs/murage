// NOLIMITS-MEANS-IT section 2: the start test with each condition flipped alone, the read at an ask, and the one door
// that writes the terms. The real starts are in nolimits-owner-started-api.test.ts.
import { describe, expect, it } from "vitest";
import { parseConfigPatch } from "./config.ts";
import { fullAccessChange, NO_LIMITS_TERMS, noLimitsTermsAccepted } from "./full-access.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { failoverSendProof, OWNER_STARTED_RUNS_MAX, ownerStartedAsk, ownerStartedTurn, recordOwnerStarted, type OwnerStartFacts, type StartMarks } from "./owner-started.ts";
import { scopedConfig } from "./sse-visibility.ts";

const owners: OwnerStartFacts = {
  directOwnerAudience: true, directThread: true, sharedWork: false, ownerOrigin: true, queuedOwnerProof: false,
  fullAccessOrigin: "owner", routineLevel: false, inheritedRoutine: false, termsAccepted: true, marks: undefined,
};

describe("ownerStartedTurn", () => {
  it("is true for the owner's own new line, and for a queued batch that carries the proof", () => {
    expect(ownerStartedTurn(owners)).toBe(true);
    expect(ownerStartedTurn({ ...owners, ownerOrigin: false, queuedOwnerProof: true })).toBe(true);
  });
  it.each<[string, Partial<OwnerStartFacts>]>([
    ["not the owner's audience", { directOwnerAudience: false }],
    ["a room, a channel or another person's thread", { directThread: false }],
    ["shared work", { sharedWork: true }],
    ["no owner origin and no queue proof", { ownerOrigin: false }],
    ["an origin of other", { fullAccessOrigin: "other" }],
    ["an origin of routine", { fullAccessOrigin: "routine" }],
    ["the owner's channel", { fullAccessOrigin: "owner-channel" }],
    ["a routine level", { routineLevel: true }],
    ["an inherited routine", { inheritedRoutine: true }],
    ["terms not accepted", { termsAccepted: false }],
  ])("is false for %s", (_name, flip) => {
    expect(ownerStartedTurn({ ...owners, ...flip })).toBe(false);
  });
  it.each<[keyof StartMarks, unknown]>([
    ["automationSource", "webhook"], ["unattended", true], ["via", "share"], ["commsDepth", 1], ["delegationRun", {}],
    ["cardContinuation", true], ["askerWake", true], ["routineRunId", "r"], ["routineAuthority", {}],
    ["projectCardRun", {}], ["sharedWorkRun", {}],
  ])("is false with %s on the start, and on any value of it", (mark, value) => {
    expect(ownerStartedTurn({ ...owners, marks: { [mark]: value } })).toBe(false);
    expect(ownerStartedTurn({ ...owners, marks: { [mark]: false } })).toBe(false);
  });
});

describe("ownerStartedAsk", () => {
  const bound = { generation: "g2", phase: "running", providerTurnId: "t2" };
  const record = new Map([["g2", "bot"]]);
  it("is true only for the bound turn of a run in the record, for its bot", () => {
    expect(ownerStartedAsk(record, bound, "bot", "t2")).toBe(true);
    expect(ownerStartedAsk(record, bound, "other", "t2")).toBe(false);
  });
  it("reads false for an older turn's ask, bound or not, and with no turn id", () => {
    expect(ownerStartedAsk(record, { generation: "g2", phase: "dispatching" }, "bot", "t1")).toBe(false);
    expect(ownerStartedAsk(record, { generation: "g2", phase: "dispatching" }, "bot", undefined)).toBe(false);
    expect(ownerStartedAsk(record, bound, "bot", "t1")).toBe(false);
    expect(ownerStartedAsk(record, bound, "bot", undefined)).toBe(false);
  });
  it("reads false during a rebuild, with no run, and once the record is gone", () => {
    expect(ownerStartedAsk(record, { ...bound, phase: "rebuilding" }, "bot", "t2")).toBe(false);
    expect(ownerStartedAsk(record, undefined, "bot", "t2")).toBe(false);
    expect(ownerStartedAsk(new Map(), bound, "bot", "t2")).toBe(false);
  });
  it("evicts the oldest record at the cap", () => {
    const runs = new Map<string, string>();
    for (let index = 0; index <= OWNER_STARTED_RUNS_MAX; index++) recordOwnerStarted(runs, `g${index}`, "bot");
    expect(runs.size).toBe(OWNER_STARTED_RUNS_MAX);
    expect(ownerStartedAsk(runs, { generation: "g0", phase: "running", providerTurnId: "t" }, "bot", "t")).toBe(false);
    expect(runs.has(`g${OWNER_STARTED_RUNS_MAX}`)).toBe(true);
  });
  it("hears the generation when a run is released", () => {
    const runs = new IndependentThreadRuns<object>();
    const released: string[] = [];
    runs.onReleased = (_thread, _bot, generation) => { released.push(generation); };
    const run = runs.admit("bot", "thread", {});
    runs.release(run);
    expect(released).toEqual([run.generation]);
  });
});

describe("failoverSendProof", () => {
  it("keeps a stored origin and turns a missing one into a not-proven send", () => {
    expect(failoverSendProof("desktop")).toEqual({ origin: "desktop", unprovenSend: false });
    expect(failoverSendProof("companion")).toEqual({ origin: "companion", unprovenSend: false });
    expect(failoverSendProof(undefined)).toEqual({ origin: "unproven", unprovenSend: true });
    expect(failoverSendProof("unproven")).toEqual({ origin: "unproven", unprovenSend: true });
  });
});

describe("No limits terms", () => {
  it("are met only at the current version", () => {
    expect(noLimitsTermsAccepted(undefined)).toBe(false);
    expect(noLimitsTermsAccepted(NO_LIMITS_TERMS - 1)).toBe(false);
    expect(noLimitsTermsAccepted(NO_LIMITS_TERMS)).toBe(true);
  });
  it("are accepted by the confirm of the warning, on the desktop, and by nothing else", () => {
    const acknowledged = { noLimitsAcknowledgedAt: 1, fullAccessAcknowledgedAt: 1 };
    expect(fullAccessChange({ noLimits: true, acknowledgeNoLimits: true }, acknowledged, true)).toMatchObject({ ok: true, noLimitsTerms: true });
    expect(fullAccessChange({ noLimits: true }, acknowledged, true)).not.toHaveProperty("noLimitsTerms");
    expect(fullAccessChange({ noLimits: true, acknowledgeNoLimits: true }, acknowledged, false)).toMatchObject({ ok: false, status: 404 });
    expect(fullAccessChange({ acknowledgeNoLimits: true }, acknowledged, true)).not.toHaveProperty("noLimitsTerms");
  });
  it("have no door on the generic config route", () => {
    expect(() => parseConfigPatch({ noLimitsTermsVersion: NO_LIMITS_TERMS })).toThrow(/desktop/);
  });
  it("stay off a phone's copy of the config", () => {
    const config: { profile?: unknown; vps?: unknown; noLimitsTerms: object } = { noLimitsTerms: { accepted: true } };
    expect(scopedConfig(config)).not.toHaveProperty("noLimitsTerms");
  });
});
