// The push contract as the web, the harness and the relay see it. The Swift
// and Java cores (Plan 3b C1) read the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CALL_SOUND, EXPIRING_CATEGORIES, GENERIC_TEXT, PUSH_CATEGORIES, PUSH_CONTRACT_VERSION, callDisplayAction, RESOLVED_TEXT, TOKEN_PATTERNS, isAttention, parseIssueTokens, parsePushPayload,
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
  version: number;
  expiringCategories: string[];
  callSound: unknown;
  callDetail: Array<{ kind: "call" | "call-note"; previewContent: boolean; detail: { title: string; body: string } }>;
  callDisplay: Array<{ case: string; payload: unknown; now: number; shown: string[]; action: string }>;
}
const push = JSON.parse(readFileSync(new URL("../apps/mobile/contract/push.json", import.meta.url), "utf8")) as PushContract;

describe("push categories", () => {
  it.each(push.categories)("$kind at risk $risk is $category", (c) => {
    expect(pushCategory(c.kind, c.risk)).toBe(c.category);
  });
  it("names exactly the eight wire categories of contract v2", () => {
    expect(push.version).toBe(PUSH_CONTRACT_VERSION);
    expect([...PUSH_CATEGORIES]).toEqual(["approval", "approval-open", "question", "done", "resolved", "device-job", "call", "call-note"]);
    expect([...EXPIRING_CATEGORIES]).toEqual(push.expiringCategories);
    expect(CALL_SOUND).toEqual(push.callSound);
  });
  it("lists every kind and rating once, so a merge cannot leave a second row behind", () => {
    const rows = push.categories.map((c) => `${c.kind}:${c.risk}`);
    expect(new Set(rows).size).toBe(rows.length);
  });
  it("a phone job is its own category whatever the rating", () => {
    for (const risk of ["low", "risky", "unrated"] as const) expect(pushCategory("device-job", risk)).toBe("device-job");
  });
  it("a phone job asks for attention, so it is never dropped for a desk", () => {
    expect(isAttention("device-job")).toBe(true);
  });
  it("the device-job text names no bot and no capability", () => {
    expect(GENERIC_TEXT["device-job"]).toEqual({ title: "Murage", body: "A bot is asking to use your phone" });
  });
  it("counts everything but done as attention (R5)", () => {
    expect(isAttention("done")).toBe(false);
    for (const kind of ["approval", "question", "takeover", "routine-failed", "turn-failed", "backup-waiting", "memories-waiting", "device-job", "call", "call-note"] as const) expect(isAttention(kind)).toBe(true);
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

describe("bot calls (contract v2)", () => {
  it.each(push.callDisplay)("$case", (c) => {
    const payload = parsePushPayload(c.payload);
    expect(payload).not.toBeNull();
    expect(callDisplayAction(payload!, c.now, c.shown)).toBe(c.action);
  });
  it.each(push.callDetail)("$kind detail at preview $previewContent is the closed sentence", async (c) => {
    const { pushDetail } = await import("../server/mobile-push-detail");
    const event = { kind: c.kind, category: c.kind, botId: "scout", threadId: "t1", messageId: "m1", resolvedBy: null } as unknown as Parameters<typeof pushDetail>[0];
    const world = { bot: () => ({ id: "scout", name: "Scout" }), message: () => ({ text: "Your server is down at acme.example" }), prefs: {}, previewContent: c.previewContent } as unknown as Parameters<typeof pushDetail>[1];
    expect(pushDetail(event, world, new Date())).toEqual(c.detail);
  });
  it.each(push.callDetail)("$kind stays closed with phone-used withholding at preview $previewContent", async (c) => {
    const { pushDetail } = await import("../server/mobile-push-detail");
    const privateRead = () => { throw new Error("must not read private detail"); };
    for (const phoneUsed of [false, true]) {
      for (const category of [c.kind, "question"] as const) {
        const event = { kind: c.kind, category, phoneUsed, botId: "scout", threadId: "t1", messageId: "m1", resolvedBy: null } as unknown as Parameters<typeof pushDetail>[0];
        const world = { bot: privateRead, message: privateRead, phoneMarked: privateRead, get prefs() { return privateRead(); }, previewContent: c.previewContent };
        expect(pushDetail(event, world, new Date())).toEqual(c.detail);
      }
    }
  });
  it("the closed sentences follow the copy rules", () => {
    for (const kind of EXPIRING_CATEGORIES) for (const text of Object.values(GENERIC_TEXT[kind])) expect(text).not.toMatch(/—|\bsafe(ty)?\b|\bunsafe\b/i);
  });
});
