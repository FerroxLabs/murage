// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// browserHighRisk (DESIGN section 4): which cards need a fresh emailed code from the owner's browser on a Cloud home.
import { describe, expect, test } from "vitest";
import { MAX_RISK_TEXT, browserEffectiveReason, browserHighRisk, riskReasonOf, stricterReason, type BrowserRiskCard } from "./mobile-push-risk.ts";
import { classifyStopLine, type StopLinePlace } from "./stop-line.ts";

const place: StopLinePlace = { cwd: "/w/ws", roots: ["/w/ws"], home: "/home/u", knownRecipients: new Set(), realpath: (path) => path };
const permission = (over: Partial<BrowserRiskCard> = {}): BrowserRiskCard => ({ requestId: "req-1", tool: "Bash", summary: "ls", riskReason: "none", ...over });

describe("riskReasonOf", () => {
  test("a real delete outside the folder is delete, one inside the workspace is not", () => {
    const outside = classifyStopLine("delete", { path: "/home/u/Documents/old" }, "", place);
    expect(outside?.kind).toBe("delete");
    expect(riskReasonOf({ stopHit: outside, tool: "Bash", summary: "rm -rf ~/Documents/old" })).toBe("delete");
    expect(classifyStopLine("delete", { path: "/w/ws/tmp.txt" }, "", place)).toBeNull();
  });
  test("pay and delete are the strictest, message is plain", () => {
    expect(riskReasonOf({ stopHit: { kind: "pay" }, tool: "stripe", summary: "charge" })).toBe("pay");
    expect(riskReasonOf({ stopHit: { kind: "message" }, tool: "gmail", summary: "send" })).toBe("message");
  });
  test("a mixed batch rates by its strictest row, never the first hit alone", () => {
    const rows = [[{ kind: "message" }], [{ kind: "pay" }]];
    expect(riskReasonOf({ stopHit: { kind: "message" }, stopRows: rows, tool: "composio", summary: "two sends" })).toBe("pay");
    expect(riskReasonOf({ stopHit: { kind: "message" }, stopRows: [[{ kind: "message" }], [{ kind: "delete" }]], tool: "t", summary: "s" })).toBe("delete");
    expect(riskReasonOf({ stopHit: { kind: "message" }, stopRows: [[{ kind: "message" }], []], tool: "t", summary: "s" })).toBe("message");
  });
  test("credentials, unreadable cards and an unknown stop kind fail closed", () => {
    expect(riskReasonOf({ tool: "Bash", summary: "echo $OPENAI_API_KEY", rating: "low" })).toBe("credential");
    expect(riskReasonOf({ tool: "Bash", summary: "ls", paths: ["/home/u/.ssh/id_rsa"], rating: "low" })).toBe("credential");
    expect(riskReasonOf({ tool: "Bash", summary: "ls", truncated: true, rating: "low" })).toBe("credential");
    expect(riskReasonOf({ tool: "Bash", summary: "x".repeat(MAX_RISK_TEXT), rating: "low" })).toBe("credential");
    expect(riskReasonOf({ tool: 7, summary: "ls", rating: "low" })).toBe("credential");
    expect(riskReasonOf({ tool: "computer", summary: "click", scope: "local-computer", rating: "low" })).toBe("credential");
    expect(riskReasonOf({ stopHit: { kind: "something-new" }, tool: "t", summary: "s" })).toBe("pay");
  });
  test("clean and low is none, clean and not low is read", () => {
    expect(riskReasonOf({ tool: "Bash", summary: "ls", rating: "low" })).toBe("none");
    expect(riskReasonOf({ tool: "Write", summary: "write notes.md", rating: "risky" })).toBe("read");
  });
  test("the stricter of two reasons wins and an unknown value is ignored", () => {
    expect(stricterReason("message", "pay")).toBe("pay");
    expect(stricterReason("none", "read")).toBe("read");
    expect(stricterReason(undefined, "message")).toBe("message");
    expect(stricterReason("bogus", undefined)).toBeUndefined();
  });
});

describe("browserHighRisk", () => {
  test("pay, delete and credential cards are high risk", () => {
    for (const riskReason of ["pay", "delete", "credential"]) expect(browserHighRisk(permission({ riskReason }))).toBe(true);
  });
  test("message, read and none stamped cards are plain", () => {
    for (const riskReason of ["message", "read", "none"]) expect(browserHighRisk(permission({ riskReason }))).toBe(false);
  });
  test("a card with no stamp needs a code; a stamped none does not", () => {
    expect(browserHighRisk(permission({ riskReason: undefined }))).toBe(true);
    expect(browserHighRisk(permission({ riskReason: "nonsense" }))).toBe(true);
    expect(browserHighRisk(permission({ riskReason: "none" }))).toBe(false);
  });
  test("restart: a stamped pay card is still high with no in-memory stop hit", () => {
    expect(browserHighRisk(permission({ riskReason: "pay" }), undefined)).toBe(true);
    expect(browserHighRisk(permission({ riskReason: "pay" }), { stopHit: null })).toBe(true);
  });
  test("a live stop hit or credential in the card text overrides a lower stamp", () => {
    expect(browserHighRisk(permission({ riskReason: "message" }), { stopHit: { kind: "pay" } })).toBe(true);
    expect(browserHighRisk(permission({ riskReason: "none", summary: "cat ~/.ssh/id_rsa" }))).toBe(true);
    expect(browserEffectiveReason(permission({ riskReason: "message" }), { stopHit: { kind: "delete" } })).toBe("delete");
  });
  test("a message-then-pay batch, stamped by the strictest row, needs a code", () => {
    const stamped = riskReasonOf({ stopHit: { kind: "message" }, stopRows: [[{ kind: "message" }], [{ kind: "pay" }]], tool: "composio", summary: "two" });
    expect(browserHighRisk(permission({ riskReason: stamped }))).toBe(true);
  });
  test("email Send, a trust Add, a publish, local-computer scope and an unreadable card are high", () => {
    expect(browserHighRisk(permission({ emailSend: { payloadHash: "h" } }))).toBe(true);
    expect(browserHighRisk(permission({ emailTrustOffer: {} }))).toBe(true);
    expect(browserHighRisk(permission({ requestId: "publish-1", tool: undefined }))).toBe(true);
    expect(browserHighRisk(permission({ approvalScope: "local-computer" }))).toBe(true);
    expect(browserHighRisk(permission({ toolInputTruncated: true }))).toBe(true);
    expect(browserHighRisk(permission({ tool: 7 }))).toBe(true);
    expect(browserHighRisk(permission({ summary: "y".repeat(MAX_RISK_TEXT) }))).toBe(true);
  });
  test("a missing card and an unknown kind are high", () => {
    expect(browserHighRisk(undefined)).toBe(true);
    expect(browserHighRisk(null)).toBe(true);
    expect(browserHighRisk({ requestId: "mystery-1" })).toBe(true);
    expect(browserHighRisk({})).toBe(true);
  });
  test("the explicit plain kinds need no stamp", () => {
    expect(browserHighRisk({ requestId: "r", routineRequest: { operation: {} } })).toBe(false);
    expect(browserHighRisk({ requestId: "r", skillRequest: { name: "x" } })).toBe(false);
    expect(browserHighRisk({ requestId: "r" }, undefined, "peer")).toBe(false);
    expect(browserHighRisk({ requestId: "r" }, undefined, "host-consent")).toBe(false);
    expect(browserHighRisk({ requestId: "limit-1" })).toBe(false);
    expect(browserHighRisk({ requestId: "r", browserCardKind: "newRecipient" })).toBe(false);
    expect(browserHighRisk({ requestId: "r", questions: [{ id: "q" }] })).toBe(false);
  });
});
