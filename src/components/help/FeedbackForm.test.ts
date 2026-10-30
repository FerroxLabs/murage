// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("@/state/store")>()), api: (...args: unknown[]) => api(...args) }));

const { FEEDBACK_CHOICE_LABEL, FEEDBACK_TIMEOUT_MS, FeedbackForm, phaseAfter, postFeedback } = await import("./FeedbackForm");
const { buildFeedbackRequest, envelopeForScreen, FEEDBACK_CHOICE_WORDS, FEEDBACK_CHOICES, resolveHelpScreen } = await import("@/lib/screen-envelope");
const { hx } = await import("./help-copy");

const envelope = envelopeForScreen(resolveHelpScreen({ activeView: "chat", bot: { id: "b1", name: "Nova" }, connected: true }), hx);
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(FeedbackForm, {
  envelope, surface: "desktop", onCancel: vi.fn(), onAskBot: vi.fn(), now: () => new Date("2026-11-02T12:00:00Z"), ...over,
}));
const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

afterEach(() => { api.mockReset(); vi.useRealTimers(); });

describe("feedback form", () => {
  it("says it is not a help request, with Ask your bot beside that line", () => {
    const html = decode(render());
    expect(html).toContain("Tell us what to make easier");
    expect(html).toContain("This goes to the Murage team to improve the app. It is not a help request, so nobody will reply here. Need help now? Ask your bot.");
    expect(html.indexOf(">Ask your bot<")).toBeGreaterThan(html.indexOf("It is not a help request"));
    expect(html).toContain("Anything that felt complicated, anything you couldn't do, or anything you couldn't find.");
    expect(html).toContain("We send this screen's name and what it shows. Never your messages, files, keys or memory.");
    expect(html).not.toMatch(/email|reply to you|we will reply/i);
  });

  it("offers three choices about this screen and no box to type into (1.0.12)", () => {
    const html = decode(render());
    expect(html).not.toMatch(/<textarea/i);
    expect(html).not.toMatch(/<input(?![^>]*type="radio")/i);
    expect(html.match(/type="radio"/g)?.length).toBe(FEEDBACK_CHOICES.length);
    expect(html).toContain("Something felt complicated");
    expect(html).toContain("I couldn't do something");
    expect(html).toContain("I couldn't find something");
    expect(html).toContain("Feedback by words comes in the next update.");
    for (const choice of FEEDBACK_CHOICES) expect(hx(FEEDBACK_CHOICE_LABEL[choice])).not.toBe(FEEDBACK_CHOICE_LABEL[choice]);
    // nothing is chosen yet, so nothing is shown as sent
    expect(html).toContain("Pick one above to see what we send.");
    expect(html).not.toContain('"words"');
  });

  it("shows exactly what will be sent before Send: the envelope and the choice's fixed sentence", () => {
    for (const choice of FEEDBACK_CHOICES) {
      const html = decode(render({ initialChoice: choice }));
      const preview = /<pre data-feedback-preview[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1];
      expect(preview).toBeDefined();
      const expected = buildFeedbackRequest({ envelope, choice, surface: "desktop", now: new Date("2026-11-02T12:00:00Z") });
      expect(JSON.parse(preview!)).toEqual(expected);
      expect(expected.words).toBe(FEEDBACK_CHOICE_WORDS[choice]);
      expect(html).toMatch(new RegExp(`value="${choice}"[^>]*checked|checked[^>]*value="${choice}"`));
    }
    const html = decode(render({ initialChoice: "complicated" }));
    // Cancel then Send, the primary on the right.
    expect(html.indexOf(">Cancel<")).toBeLessThan(html.indexOf(">Send<"));
  });

  it("each state has its words", () => {
    expect(decode(render({ initialPhase: "sent" }))).toContain("Thanks. This helps us make Murage clearer.");
    expect(decode(render({ initialPhase: "failed", initialChoice: "cant-do" }))).toContain("Could not send right now. Your note is kept here; try again later.");
    expect(decode(render({ initialPhase: "failed", initialChoice: "cant-do" }))).toMatch(/value="cant-do"[^>]*checked|checked[^>]*value="cant-do"/);
    expect(decode(render({ initialPhase: "too-long" }))).toContain("That is longer than we can take. Please shorten it");
    expect(decode(render({ initialPhase: "too-many" }))).toContain("Wait a minute and press Send again.");
    expect(decode(render({ initialPhase: "sending" }))).toContain("Sending. This takes a few seconds at most.");
  });

  it("maps the relay's answer to a state", () => {
    expect(phaseAfter({ sent: true })).toBe("sent");
    expect(phaseAfter({ sent: false, reason: "rate_limited" })).toBe("too-many");
    expect(phaseAfter({ sent: false, reason: "timeout" })).toBe("failed");
    expect(phaseAfter({ sent: false })).toBe("failed");
    expect(phaseAfter({ sent: false, reason: "too_long" })).toBe("too-long");
    expect(phaseAfter({ ok: true, id: "x" } as unknown as { sent: boolean })).toBe("failed");
  });

  it("holds no owner-text path: no text box, no draft store, no shared scrubber", () => {
    for (const path of ["./FeedbackForm.tsx", "./HelpPanel.tsx", "../../lib/screen-envelope.ts"]) {
      const text = source(path);
      expect(text, path).not.toMatch(/owner-text-redact|redactOwnerText/);
      expect(text, path).not.toMatch(/<textarea|sessionStorage|feedbackDraft/);
    }
    // The form builds its request only from a choice.
    expect(source("./FeedbackForm.tsx")).toMatch(/buildFeedbackRequest\(\{ envelope, choice, surface, now: createdAt\.current \}\)/);
  });
});

describe("posting feedback", () => {
  const request = buildFeedbackRequest({ envelope, choice: "cant-find", surface: "desktop", now: new Date() });

  it("posts the request as it was shown and reads {sent}", async () => {
    api.mockResolvedValueOnce({ sent: true });
    expect(await postFeedback(request)).toEqual({ sent: true });
    const [path, init] = api.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(JSON.parse(String(init.body)).words).toBe("I couldn't find something on this screen.");
    api.mockResolvedValueOnce({ sent: false, reason: "relay_down" });
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "relay_down" });
  });

  it("reads 429 as sending too often and anything else as not sent", async () => {
    api.mockRejectedValueOnce(Object.assign(new Error("slow down"), { status: 429 }));
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "rate_limited" });
    api.mockRejectedValueOnce(Object.assign(new Error("too long"), { status: 413 }));
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "too_long" });
    api.mockResolvedValueOnce({ ok: true, id: "abc" });
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "not_sent" });
    api.mockRejectedValueOnce(Object.assign(new Error("no route"), { status: 404 }));
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "unreachable" });
    api.mockRejectedValueOnce(new Error("offline"));
    expect(await postFeedback(request)).toEqual({ sent: false, reason: "unreachable" });
  });

  it("gives up after its deadline", async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = postFeedback(request);
    await vi.advanceTimersByTimeAsync(FEEDBACK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ sent: false, reason: "unreachable" });
  });
});
