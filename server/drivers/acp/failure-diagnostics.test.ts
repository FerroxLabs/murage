import { describe, expect, it } from "vitest";
import { createFuigoFailureObservations } from "./failure-diagnostics.ts";

const context = () => ({ source: "fuigo.acp", sessionId: "s-one", promptStartedAt: Date.now() - 10, pendingPrompts: 1, promptSent: true, settled: false, cancelRequested: false });
const notification = () => ({ method: "_fuigo/session_notification", params: { sessionId: "s-one", _meta: { eventId: "event-1", agentTimestampMs: Date.now() }, update: { sessionUpdate: "retry_state", type: "failed", error_type: "api" } } });

describe("Fuigo observation fences", () => {
  it.each([
    { source: "custom.acp" }, { sessionId: "s-other" }, { sessionId: null },
    { promptStartedAt: null }, { pendingPrompts: 0 }, { pendingPrompts: 2 },
    { promptSent: false }, { settled: true }, { cancelRequested: true },
  ])("rejects inactive or ambiguous request context %j", override => {
    const observations = createFuigoFailureObservations();
    observations.observe(notification(), { ...context(), ...override });
    expect(observations.details()).toBeUndefined();
    expect(observations.kind()).toBeUndefined();
  });

  it("does not carry observations into another turn and rejects duplicate event IDs", () => {
    const observations = createFuigoFailureObservations();
    const msg = notification();
    observations.observe(msg, context());
    expect(observations.details()).toContain(": api");
    expect(observations.kind()).toBe("api");
    msg.params.update.error_type = "auth";
    observations.observe(msg, context());
    expect(observations.details()).not.toContain(": auth");
    expect(observations.kind()).toBe("api");
    expect(createFuigoFailureObservations().details()).toBeUndefined();
  });

  it("unknown newest category removes an older category rather than inferring it", () => {
    const observations = createFuigoFailureObservations();
    const msg = notification();
    observations.observe(msg, context());
    msg.params._meta.eventId = "event-2";
    msg.params.update.error_type = "unknown";
    observations.observe(msg, context());
    expect(observations.details()).toBeUndefined();
    expect(observations.kind()).toBeUndefined();
  });
});
