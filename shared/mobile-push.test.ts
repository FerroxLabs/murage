// The push contract as the web, the harness and the relay see it. The Swift
// and Java cores (Plan 3b C1) read the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERIC_TEXT, PUSH_CATEGORIES, RESOLVED_TEXT, TOKEN_PATTERNS, isAttention, parseIssueTokens, parsePushPayload,
  parseRelayEvent, parseRespondBody, pushCategory, type PushKind, type PushRisk,
} from "./mobile-push";

interface PushContract {
  categories: Array<{ kind: PushKind; risk: PushRisk; category: string }>;
  payloads: Array<{ value: unknown; valid: boolean }>;
  relayEvents: Array<{ value: unknown; valid: boolean }>;
  respond: Array<{ body: unknown; valid: boolean }>;
  issueTokens: Array<{ args: unknown; valid: boolean }>;
  tokens: Array<{ kind: keyof typeof TOKEN_PATTERNS; value: string; valid: boolean }>;
  generic: Record<string, { title: string; body: string }>;
  resolvedText: { desktop: string; elsewhere: string };
}
const push = JSON.parse(readFileSync(new URL("../apps/mobile/contract/push.json", import.meta.url), "utf8")) as PushContract;

describe("push categories", () => {
  it.each(push.categories)("$kind at risk $risk is $category", (c) => {
    expect(pushCategory(c.kind, c.risk)).toBe(c.category);
  });
  it("names exactly the five wire categories", () => {
    expect([...PUSH_CATEGORIES]).toEqual(["approval", "approval-open", "question", "done", "resolved"]);
  });
  it("counts everything but done as attention (R5)", () => {
    expect(isAttention("done")).toBe(false);
    for (const kind of ["approval", "question", "takeover", "routine-failed", "turn-failed", "backup-waiting", "memories-waiting"] as const) expect(isAttention(kind)).toBe(true);
  });
});

describe("the opaque payload", () => {
  it.each(push.payloads)("$value is valid: $valid", (c) => {
    expect(parsePushPayload(c.value) !== null).toBe(c.valid);
  });
  it.each(push.relayEvents)("relay event $value is valid: $valid", (c) => {
    expect(parseRelayEvent(c.value) !== null).toBe(c.valid);
  });
});

describe("strict bodies", () => {
  it.each(push.respond)("respond $body is valid: $valid", (c) => {
    expect(parseRespondBody(c.body) !== null).toBe(c.valid);
  });
  it.each(push.issueTokens)("issuePushTokens $args is valid: $valid", (c) => {
    expect(parseIssueTokens(c.args) !== null).toBe(c.valid);
  });
  it.each(push.tokens)("$kind token $value is valid: $valid", (c) => {
    expect(TOKEN_PATTERNS[c.kind].test(c.value)).toBe(c.valid);
  });
});

describe("words", () => {
  it("the generic text matches the fixture for every category", () => {
    expect(GENERIC_TEXT).toEqual(push.generic);
    expect(RESOLVED_TEXT).toEqual(push.resolvedText);
  });
  it("follows the copy rules", () => {
    const all = [...Object.values(GENERIC_TEXT).flatMap((t) => [t.title, t.body]), RESOLVED_TEXT.desktop, RESOLVED_TEXT.elsewhere];
    for (const text of all) {
      expect(text).not.toMatch(/—|\bsafe(ty)?\b/i);
    }
  });
  it("the attention wording is the one applyNotificationPreferences uses", async () => {
    const { applyNotificationPreferences } = await import("./notification-preferences");
    const frame = applyNotificationPreferences({ kind: "approval", botId: "b", threadId: "t", title: "x", body: "y" }, { previewContent: false }, new Date());
    expect(GENERIC_TEXT.approval.body).toBe(frame!.body);
  });
});
