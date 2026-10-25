// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// 1.0.4 rig: the project's Activity had no hand-off line. A hand-off row (read from its request) says who handed work to whom, by the
// teammate's current name, and whether it ended without finishing.
import { expect, it } from "vitest";
import { activityActor, activityLine } from "./project-activity";
import type { ProjectActivityRow } from "./project-client";

const members = [{ id: "ember", name: "Ember" }, { id: "canvas", name: "Canvas" }];
const handoff = (detail: Record<string, unknown>): ProjectActivityRow => ({ id: "handoff:h", kind: "handoff", detail, at: 1000, actor: "ember", workItemId: null, goalId: null, requestId: "h" });

it("a hand-off line names the teammate it went to; the actor line names who handed it", () => {
  expect(activityLine(handoff({ toBotId: "canvas", state: "done" }), [], null, members)).toBe("Handed work to Canvas");
  expect(activityLine(handoff({ toBotId: "canvas", state: "running" }), [], null, members)).toBe("Handed work to Canvas");
  expect(activityActor("ember", members)).toBe("Ember");
});

it("a hand-off that ended without finishing says so", () => {
  for (const state of ["failed", "expired", "cancelled", "unknown"]) expect(activityLine(handoff({ toBotId: "canvas", state }), [], null, members)).toBe("Handed work to Canvas. It did not finish.");
});

it("a teammate no longer in the project, or a malformed row, reads as a teammate", () => {
  expect(activityLine(handoff({ toBotId: "gone", state: "done" }), [], null, members)).toBe("Handed work to a teammate");
  expect(activityLine(handoff({ toBotId: 7, state: "failed" }), [], null)).toBe("Handed work to a teammate. It did not finish.");
});
