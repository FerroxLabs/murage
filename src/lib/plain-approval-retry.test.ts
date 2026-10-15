// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Before the plain words load, a card names no action it guessed from the
// request's words; and a fetch that fails is tried again until it arrives,
// then the cards waiting on it re-render in plain words.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "@/components/ApprovalCard";
import { spokenToolAction } from "@/components/PendingApproval";
import type { Bot, Message } from "@/state/store";
import {
  PLAIN_APPROVAL_RETRY_DELAYS_MS,
  loadPlainApproval,
  plainApproval,
  plainApprovalReady,
  resetPlainApprovalForTests,
  subscribePlainApproval,
} from "./plain-approval";

const bot = { id: "bot-ember", name: "Ember" } as Bot;
// "Google invoice" once made the pre-load guess read this as a web search.
const GMAIL = JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "Google invoice", body: "Attached." } }] });
const message: Message = { id: "m-gmail", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: GMAIL, options: ["Allow", "Deny"], tool: "other", requestId: "r1" } };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
const cardText = () => text(renderToStaticMarkup(createElement(ApprovalCard, { bot, message })));

type PlainModule = typeof import("../../shared/approval-plain");
let realModule: PlainModule;
beforeAll(async () => { realModule = await import("../../shared/approval-plain"); });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPlainApprovalForTests();
});

describe("before the plain words load", () => {
  it("an ACP Gmail send reads 'wants to use a tool' with the raw request shown, never a softer guess", () => {
    resetPlainApprovalForTests(() => new Promise<PlainModule>(() => undefined));
    expect(plainApprovalReady()).toBe(false);
    const said = cardText();
    expect(said).toContain("Ember wants to use a tool");
    expect(said).not.toContain("search the web");
    expect(said).toContain("GMAIL_SEND_EMAIL");
    expect(said).toContain("ana@example.com");
    expect(spokenToolAction("other", GMAIL)).not.toContain("search the web");
  });
});

describe("a failed fetch is tried again", () => {
  it("fails twice, then loads: subscribers hear it and the card re-renders in plain words", async () => {
    vi.useFakeTimers();
    let calls = 0;
    resetPlainApprovalForTests(async () => {
      calls += 1;
      if (calls <= 2) throw new TypeError("Failed to fetch dynamically imported module");
      return realModule;
    });
    const heard = vi.fn();
    const stop = subscribePlainApproval(heard);

    // the card asks for the words; the first try fails
    expect(cardText()).toContain("Ember wants to use a tool");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(plainApprovalReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_RETRY_DELAYS_MS[0]);
    expect(calls).toBe(2);
    expect(heard).not.toHaveBeenCalled();
    expect(cardText()).toContain("Ember wants to use a tool");

    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_RETRY_DELAYS_MS[1]);
    expect(plainApprovalReady()).toBe(true);
    expect(calls).toBe(3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(cardText()).toContain("Ember wants to use Gmail to send email");
    stop();
  });

  it("after a whole round fails, renders do not refetch; the next window focus does", async () => {
    vi.useFakeTimers();
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    let calls = 0;
    let fail = true;
    resetPlainApprovalForTests(async () => {
      calls += 1;
      if (fail) throw new TypeError("offline");
      return realModule;
    });
    const heard = vi.fn();
    const stop = subscribePlainApproval(heard);

    const round = loadPlainApproval();
    const settled = round.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_RETRY_DELAYS_MS[0] + PLAIN_APPROVAL_RETRY_DELAYS_MS[1]);
    expect(await settled).toBeInstanceOf(TypeError);
    expect(calls).toBe(3);

    // bounded: a burst of renders while the window is unfocused starts nothing
    for (let i = 0; i < 5; i++) expect(plainApproval("other", GMAIL)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);

    fail = false;
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plainApprovalReady()).toBe(true);
    expect(calls).toBe(4);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(plainApproval("other", GMAIL)?.action).toBe("use Gmail to send email");
    stop();
  });
});
