import { describe, expect, it } from "vitest";
import { parseStoredConfig } from "./config.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushDetail, type DetailWorld } from "./mobile-push-detail.ts";
import { GENERIC_TEXT } from "../shared/mobile-push.ts";
import { vi } from "vitest";
import type { PushEventRow } from "./mobile-push-store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const event = (over: Partial<PushEventRow> = {}): PushEventRow => ({
  eventRef: "a".repeat(64), bindingId: "b", kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
  messageId: "m1", collapseKey: "c", threadGroup: "g", revision: 1, timeSensitive: true, resolvedBy: null, createdAt: 0, expiresAt: 1,
  holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0, phoneUsed: false, ...over,
});
const world = (over: Partial<DetailWorld> = {}): DetailWorld => ({
  bot: () => ({ id: "lena", name: "Lena", threadId: "t1" }),
  message: () => ({ card: { title: "Permission", subtitle: "Lena wants to delete 3 files" } }),
  prefs: undefined,
  previewContent: true,
  ...over,
});
const noon = new Date("2026-09-27T12:00:00Z");

describe("pushDetail phoneUsed (X1)", () => {
  it("a flagged row is generic text with previewContent on, before any read (X1)", () => {
    const message = vi.fn(() => ({ text: "Your 3pm with Dr Lee is moved" }));
    const bot = vi.fn(() => ({ id: "lena", name: "Lena", threadId: "t1" }));
    expect(pushDetail(event({ kind: "done", category: "done", phoneUsed: true }), world({ message, bot, previewContent: true }), noon)).toEqual(GENERIC_TEXT.done);
    expect(message).not.toHaveBeenCalled();
    expect(bot).not.toHaveBeenCalled();
  });
  it.each(["approval", "approval-open", "question", "done"] as const)("a flagged %s row is its own generic text", (category) => {
    const message = vi.fn(() => ({ text: "private" }));
    expect(pushDetail(event({ kind: category === "done" ? "done" : category === "question" ? "question" : "approval", category, phoneUsed: true }), world({ message }), noon)).toEqual(GENERIC_TEXT[category]);
    expect(message).not.toHaveBeenCalled();
  });
  it("an unflagged row whose thread is marked at detail time is generic too, with no read", () => {
    const message = vi.fn(() => ({ text: "private" }));
    expect(pushDetail(event({ kind: "done", category: "done" }), world({ message, phoneMarked: () => true }), noon)).toEqual(GENERIC_TEXT.done);
    expect(message).not.toHaveBeenCalled();
  });
  it("a mark check that throws reads as marked (fail closed)", () => {
    const message = vi.fn(() => ({ text: "private" }));
    expect(pushDetail(event({ kind: "done", category: "done" }), world({ message, phoneMarked: () => { throw new Error("closed"); } }), noon)).toEqual(GENERIC_TEXT.done);
    expect(message).not.toHaveBeenCalled();
  });
  it("an unflagged, unmarked row still reads the content as before", () => {
    expect(pushDetail(event(), world({ phoneMarked: () => false }), noon).body).toContain("delete 3 files");
  });
});

describe("pushDetail device-job", () => {
  const job = event({ kind: "device-job", category: "device-job", requestId: "op-1", messageId: null });
  it.each([false, true, undefined])("is the fixed template with previewContent %s and never reads a message", (previewContent) => {
    let read = 0;
    const w = world({ previewContent, deviceJob: () => ({ capability: "calendar" }), message: () => { read++; return { text: "SECRET ARGS" }; } });
    expect(pushDetail(job, w, noon)).toEqual({ title: "Murage", body: "Lena wants to use your calendar. Open Murage to allow it." });
    expect(read).toBe(0);
  });
  it("names the capability from the live job and falls back to the generic text when it is gone", () => {
    expect(pushDetail(job, world({ deviceJob: () => ({ capability: "calls" }) }), noon).body).toBe("Lena wants to use your phone calls. Open Murage to allow it.");
    expect(pushDetail(job, world(), noon)).toEqual({ title: "Murage", body: "A bot is asking to use your phone" });
    expect(pushDetail(job, world({ bot: () => undefined, deviceJob: () => ({ capability: "calendar" }) }), noon)).toEqual({ title: "Murage", body: "A bot is asking to use your phone" });
    expect(pushDetail(job, world({ deviceJob: () => { throw new Error("closed"); } }), noon)).toEqual({ title: "Murage", body: "A bot is asking to use your phone" });
  });
});

describe("pushDetail", () => {
  it.each([undefined, false, "true"])("withholds private titles and bodies without explicit phone consent: %s", previewContent => {
    const privateWorld = world({ previewContent: previewContent as boolean, prefs: { previewContent: true } });
    expect(pushDetail(event(), privateWorld, noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
    expect(pushDetail(event({ kind: "done", category: "done" }), { ...privateWorld, message: () => ({ text: "PRIVATE MESSAGE" }) }, noon))
      .toEqual({ title: "Murage", body: "A task has finished." });
  });
  it("an existing settings file with no phone choice keeps generic previews", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-settings-"));
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, '{"notifications":{"previewContent":true}}');
      const config = parseStoredConfig(JSON.parse(readFileSync(file, "utf8")));
      expect(pushDetail(event(), world({ prefs: config.notifications, previewContent: undefined }), noon))
        .toEqual({ title: "Murage", body: "Your attention is needed." });
    } finally { removeTempDirSync(dir); }
  });
  it("rebuilds an approval with the notify.ts builder", () => {
    expect(pushDetail(event(), world(), noon)).toEqual({ title: "Lena needs approval", body: "Lena wants to delete 3 files" });
  });
  it("never puts the tool input on the lock screen: pushBody wins over subtitle", () => {
    const w = world({ message: () => ({ card: { title: "Permission", subtitle: '{"command":"curl -u bob:pw x"}', pushBody: "curl x" } }) });
    expect(pushDetail(event(), w, noon).body).toBe("curl x");
  });
  it("rebuilds a question, a done and a failure from the referenced message", () => {
    expect(pushDetail(event({ kind: "question", category: "question" }), world({ message: () => ({ text: "Which branch?" }) }), noon))
      .toEqual({ title: "Lena has a question", body: "Which branch?" });
    expect(pushDetail(event({ kind: "done", category: "done", requestId: null }), world({ message: () => ({ text: "Pushed the branch." }) }), noon))
      .toEqual({ title: "Lena finished", body: "Pushed the branch." });
    expect(pushDetail(event({ kind: "turn-failed", category: "question", requestId: null }), world({ message: () => ({ text: "The provider is down." }) }), noon))
      .toEqual({ title: "Lena couldn't start", body: "The provider is down." });
  });
  it("returns the generic text when the message is gone", () => {
    expect(pushDetail(event(), world({ message: () => undefined }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
  });
  it("previewContent false at read time returns the generic text", () => {
    expect(pushDetail(event(), world({ prefs: { previewContent: false } }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
  });
  it("a category switched off since the push reads as generic, not as an error", () => {
    expect(pushDetail(event({ kind: "done", category: "done" }), world({ prefs: { completion: false }, message: () => ({ text: "x" }) }), noon))
      .toEqual({ title: "Murage", body: "A task has finished." });
  });
  it("a resolution says where it was answered", () => {
    expect(pushDetail(event({ category: "resolved", resolvedBy: "desktop" }), world(), noon).body).toBe("Answered on desktop.");
    expect(pushDetail(event({ category: "resolved", resolvedBy: "elsewhere" }), world(), noon).body).toBe("Answered on another device.");
  });
  it("a card that expired or was dismissed says nobody answered it (B10)", () => {
    expect(pushDetail(event({ category: "resolved", resolvedBy: "expired" }), world(), noon).body).toBe("No longer waiting.");
    expect(pushDetail(event({ category: "resolved", resolvedBy: "dismissed" }), world(), noon).body).toBe("No longer waiting.");
  });
  it("anything missing or refused reads as the generic text, never an error", () => {
    expect(pushDetail(event(), world({ bot: () => undefined }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
    expect(pushDetail(event(), world({ bot: () => ({ id: "lena", name: "Lena", threadId: "t1", notifications: false }) }), noon))
      .toEqual({ title: "Murage", body: "Your attention is needed." });
    expect(pushDetail(event(), world({ prefs: { previewContent: "no" } }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
    expect(pushDetail(event(), world({ message: () => { throw new Error("db closed"); } }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
    expect(pushDetail(event({ kind: "done", category: "done" }), world({ message: () => ({ text: "  " }) }), noon)).toEqual({ title: "Murage", body: "A task has finished." });
  });
  it("a failure with previews off reads as its category's generic text, like the push did", () => {
    expect(pushDetail(event({ kind: "turn-failed", category: "question" }), world({ prefs: { previewContent: false }, message: () => ({ text: "secret" }) }), noon))
      .toEqual({ title: "Murage", body: "Your attention is needed." });
  });
  it("quiet hours at read time read as the generic text", () => {
    const prefs = { quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } };
    expect(pushDetail(event(), world({ prefs }), noon)).toEqual({ title: "Murage", body: "Your attention is needed." });
  });
});
