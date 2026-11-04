// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The form (src/lib/screen-envelope.ts) and the relay (server/feedback-relay.ts)
// are separate lanes with separate checks. This holds them together: whatever
// the form can send on any screen is what the relay accepts, reaches the
// control plane word for word, and fits the relay's size limit.
import { describe, expect, it } from "vitest";
import fixed from "../../shared/feedback-fixed.json";
import { FEEDBACK_MAX_BODY_BYTES, feedbackRequestSchema, outboundBody, scrubbedRequest } from "../../server/feedback-relay.ts";
import { buildFeedbackRequest, checkFeedbackRequest, FEEDBACK_CHOICE_WORDS, FEEDBACK_CHOICES, FEEDBACK_FIXED, feedbackEnvelopeForScreen, type FeedbackRequest, type FeedbackSurface } from "./screen-envelope";
import { SCREENS } from "./screens-index";

const now = new Date("2026-11-02T12:00:00.000Z");
const surfaces: readonly FeedbackSurface[] = ["desktop", "phone", "cloud"];
const allGates = [...FEEDBACK_FIXED.gates.keys()].map((id) => ({ id, reasonKey: "" }));
const screens = [...SCREENS.map((entry) => entry.key), "not-a-screen"];

function everyRequest(): FeedbackRequest[] {
  const out: FeedbackRequest[] = [];
  for (const screen of screens) {
    for (const gates of [[], allGates]) {
      for (const choice of FEEDBACK_CHOICES) {
        const envelope = feedbackEnvelopeForScreen({ key: screen, gates });
        for (const surface of surfaces) out.push(buildFeedbackRequest({ envelope, choice, surface, now }));
      }
    }
  }
  return out;
}

describe("the feedback form and the relay agree", () => {
  const requests = everyRequest();

  // The relay cannot import the form's tables, so it reads this copy. A new screen or a changed label goes in both.
  it("shared/feedback-fixed.json is the form's tables, value for value", () => {
    expect(fixed.titles).toEqual(Object.fromEntries(FEEDBACK_FIXED.titles));
    expect(new Set(fixed.pages)).toEqual(FEEDBACK_FIXED.pages);
    expect(fixed.gates).toEqual(Object.fromEntries(FEEDBACK_FIXED.gates));
    expect(fixed.controls).toEqual(Object.fromEntries(FEEDBACK_FIXED.controls));
    expect(fixed.words).toEqual(Object.values(FEEDBACK_CHOICE_WORDS));
  });

  it("covers every screen; a key with no entry is named as the help page", () => {
    expect(new Set(requests.map((request) => request.screen)).size).toBe(SCREENS.length);
    expect(feedbackEnvelopeForScreen({ key: "not-a-screen", gates: [] })).toMatchObject({ screen: "help", title: "Help" });
  });

  // FEEDBACK-SCREEN-UNKNOWN: a report reached Discord as "Screen: unknown (unknown)". Neither table holds that pair now,
  // so no caller can send it and the relay refuses it.
  it("no table holds an unknown screen, and the relay refuses one", () => {
    expect(Object.keys(fixed.titles)).not.toContain("unknown");
    expect(FEEDBACK_FIXED.screens.has("unknown")).toBe(false);
    const request = { ...requests[0], screen: "unknown", title: "unknown" };
    expect(feedbackRequestSchema.safeParse(request).success).toBe(false);
    expect(checkFeedbackRequest(request)).toBe("screen");
  });

  it("every request the form can build passes the form's own check and the relay's schema", () => {
    for (const request of requests) {
      expect(checkFeedbackRequest(request), request.screen).toBeNull();
      const parsed = feedbackRequestSchema.safeParse(request);
      expect(parsed.success, `${request.screen}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("the relay's scrub leaves every fixed word as the owner saw it in the fold", () => {
    for (const request of requests) expect(scrubbedRequest(feedbackRequestSchema.parse(request)), request.screen).toEqual(request);
  });

  it("the largest request fits the relay's limit with its own fields added", () => {
    for (const request of requests) {
      const added = { installId: "00000000-0000-4000-8000-000000000000", appVersion: "1.0.13", os: "windows" as const };
      const body = outboundBody({ ...feedbackRequestSchema.parse(request), ...added });
      expect(body, request.screen).not.toBeNull();
      expect(new TextEncoder().encode(body!).length, request.screen).toBeLessThan(FEEDBACK_MAX_BODY_BYTES);
      // What the control plane reads is the request as the fold showed it, plus the relay's three fields.
      expect(JSON.parse(body!), request.screen).toEqual({ ...request, ...added });
    }
  });
});
