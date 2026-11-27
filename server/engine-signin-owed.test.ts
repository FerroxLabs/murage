// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 (field gate). Owners: lane fix1022-withheld-fable owns server/engine-signin-owed.ts and memory/dispatch.ts
// turnRefusedSignInLine. Module level: the mark's own rules. The server rows that read it through index.ts are driven on a real
// server in signin-refused-resend-1022-api.test.ts.
import { describe, expect, it } from "vitest";
import { EngineSignInOwed, SIGN_IN_OWED_TTL_MS } from "./engine-signin-owed.ts";
import { turnRefusedSignInLine } from "./memory/dispatch.ts";

const ENGINE = "Fixture engine";
const SIGN_IN_LINE = `${ENGINE} needs you to sign in again, so Murage did not send your message again. Sign in to ${ENGINE} in Settings, Models & engines, then send it again.`;

describe("1.0.22: the sign-in mark is evidence for wording only, ends on a good turn and goes stale", () => {
  it("only a refused repeat of a send gets the sign-in line", () => {
    expect(turnRefusedSignInLine(ENGINE, "after-submission")).toBe(SIGN_IN_LINE);
    expect(turnRefusedSignInLine(ENGINE, "after-submission-uncertain")).toBe(SIGN_IN_LINE);
    for (const kind of ["without-memory", "without-memory-checking", "without-memory-unknown", "not-started", "unknown-submission", "resend-offer"] as const) expect(turnRefusedSignInLine(ENGINE, kind)).toBeUndefined();
  });
  it("marked by the engine's sign-in facts, cleared by a turn that finished well, stale after its window, per engine", () => {
    const owed = new EngineSignInOwed();
    owed.observe("a", { type: "runtime.error", authRequired: true }, 1000);
    owed.observe("b", { type: "turn.completed", ok: false, stopReason: "auth_required" }, 1000);
    owed.observe("c", { type: "runtime.error" }, 1000);
    owed.observe("d", { type: "turn.completed", ok: false, stopReason: "submission_refused" }, 1000);
    expect(["a", "b", "c", "d", undefined].map(id => owed.owed(id, 2000))).toEqual([true, true, false, false, false]);
    owed.observe("a", { type: "turn.completed", ok: true }, 3000);
    expect(owed.owed("a", 3000)).toBe(false);
    expect(owed.owed("b", 1000 + SIGN_IN_OWED_TTL_MS)).toBe(true);
    expect(owed.owed("b", 1001 + SIGN_IN_OWED_TTL_MS)).toBe(false);
    owed.note("e", 1000); owed.clear("e");
    expect(owed.owed("e", 1000)).toBe(false);
  });
});
