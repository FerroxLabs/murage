// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// NOLIM-1019 P4, server half (designs/NOLIM-DO-EVERYTHING-1019.md R7, F4, F5): the finalizer's N2 class, written to
// `cardClass.noLimits` at open, decides Approve all eligibility; the same verdict runs in the preview and again on the live
// card at apply, so a card that turns N2 (or stops being open) after the preview is refused, not answered. A legacy card
// with no such record is approved one by one. Pure bulkEligibility plus the two call sites in server/index.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boundedProjection } from "../../server/decision/bounds.ts";
import { bulkEligibility } from "../../server/approve-all.ts";

const INDEX = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");

type Class = Record<string, unknown>;
/** An owner card of the engine, open, ordinary unless `cls` says otherwise. */
const card = (cls: Class, extra: Record<string, unknown> = {}) => ({ requestId: "r1", tool: "Bash", cardClass: { unattended: false, origin: "owner", ...cls }, ...extra });
const noLimits = (n2: boolean, initiator = "owner") => ({ initiator, n2 });

describe("bulkEligibility under No limits (R7)", () => {
  // An ordinary card (no grant answered it) is the 1.0.18 bulk class and needs no No limits record: it is no held or wipe class.
  // R7's record gates the held and sensitive classes below, where a missing record means one by one.
  it("control: an ordinary owner card with no grant answering it goes in bulk", () => {
    expect(bulkEligibility(card({ reason: "no-grant" }), "r1")).toEqual({ ok: true });
  });

  it("a journal-projected absent computer scope is ordinary; real and malformed scope values stay out", () => {
    const projected = boundedProjection(card({ reason: "no-grant" }, { approvalScope: undefined }));
    expect(projected.approvalScope).toBeNull();
    expect(bulkEligibility(projected, "r1")).toEqual({ ok: true });
    for (const approvalScope of ["local-computer", "unknown", false, 0, {}]) {
      expect(bulkEligibility({ ...projected, approvalScope }, "r1")).toEqual({ ok: false, reasonKey: "local-computer" });
    }
  });

  it("the owner's held and sensitive classes go in bulk when the finalizer wrote a non-N2 record", () => {
    for (const reason of ["always-ask", "destructive-guard", "sensitive-guard", "prompt-guard", "outside-turn", "unread-call"]) {
      expect(bulkEligibility(card({ reason, rule: "x", noLimits: noLimits(false) }), "r1"), reason).toEqual({ ok: true });
    }
  });

  it("an N2 card (the wipe list) never goes in bulk, whatever its class", () => {
    for (const reason of ["always-ask", "destructive-guard", "sensitive-guard", "no-grant"]) {
      const verdict = bulkEligibility(card({ reason, rule: "delete-home", noLimits: noLimits(true) }), "r1");
      expect(verdict.ok, reason).toBe(false);
    }
  });

  it("another person's or an unproven origin never goes in bulk, even marked non-N2", () => {
    for (const initiator of ["other", "unproven", "webhook", ""]) {
      expect(bulkEligibility(card({ reason: "always-ask", rule: "x", noLimits: noLimits(false, initiator) }), "r1").ok, initiator).toBe(false);
    }
  });

  it("a legacy held card with no record is approved one by one", () => {
    for (const reason of ["always-ask", "destructive-guard", "sensitive-guard", "prompt-guard", "outside-turn", "unread-call"]) {
      expect(bulkEligibility(card({ reason, rule: "x" }), "r1").ok, reason).toBe(false);
    }
    // a malformed record is no record
    expect(bulkEligibility(card({ reason: "always-ask", rule: "x", noLimits: "yes" }), "r1").ok).toBe(false);
    expect(bulkEligibility(card({ reason: "always-ask", rule: "x", noLimits: { initiator: "owner" } }), "r1").ok).toBe(false);
  });

  it("stale preview eligibility: a card eligible at preview that turns N2, is answered or is dismissed is refused at apply", () => {
    const live = card({ reason: "always-ask", rule: "x", noLimits: noLimits(false) }) as Record<string, any>;
    expect(bulkEligibility(live, "r1")).toEqual({ ok: true }); // the preview's verdict
    live.cardClass.noLimits.n2 = true; // the finalizer's class on the live card moved
    expect(bulkEligibility(live, "r1").ok).toBe(false);
    live.cardClass.noLimits.n2 = false;
    live.answered = { behavior: "allow" }; // answered elsewhere after the preview
    expect(bulkEligibility(live, "r1")).toEqual({ ok: false, reasonKey: "not-open" });
    delete live.answered;
    live.dismissed = true;
    expect(bulkEligibility(live, "r1")).toEqual({ ok: false, reasonKey: "not-open" });
  });
});

describe("the preview and the live apply run the same verdict on the live card (M-stale server half)", () => {
  it("the preview runs bulkEligibility on each row's card; the apply re-reads the live card and refuses when it is not eligible now", () => {
    // Rev 3.3 W1/X1: the preview (partitionThread) and the apply (bulkRecheck) both judge the row they resolved with the
    // same deps.eligibility, which is bulkEligibility; the apply refuses a card that is not open or not eligible now.
    const THREAD = readFileSync(new URL("../../server/approve-all-thread.ts", import.meta.url), "utf8");
    expect(THREAD).toMatch(/eligibility: bulkEligibility,/);
    expect(THREAD).toContain("const verdict = deps.eligibility(card, requestId);");
    expect(THREAD).toContain("return { ok: false, reason: `not-eligible:${verdict.reasonKey}` };");
    const apply = INDEX.slice(INDEX.indexOf("APPROVE-ALL 6.2 step 1b"));
    expect(apply.slice(0, 700)).toContain("const live = bulkRecheck(threadDeps(), threadId, requestId);");
    expect(apply.slice(0, 700)).toContain("if (!live.ok) return bulkSkip(res, live.reason);");
  });
});
