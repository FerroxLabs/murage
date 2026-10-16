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
  PLAIN_APPROVAL_WAIT_MS,
  holdForPlainWords,
  loadPlainApproval,
  plainApproval,
  plainApprovalReady,
  plainApprovalSettled,
  resetPlainApprovalForTests,
  subscribePlainApproval,
  subscribePlainApprovalSettled,
  startPlainApprovalWait,
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

describe("a call waits for the plain words before it speaks an approval", () => {
  it("is not settled while they load (the spoken action would be the pre-load wording), and settles when they arrive", async () => {
    let arrive!: (module: PlainModule) => void;
    resetPlainApprovalForTests(() => new Promise<PlainModule>((resolve) => { arrive = resolve; }));
    const settledHeard = vi.fn();
    const stop = subscribePlainApprovalSettled(settledHeard);
    const pending = loadPlainApproval();
    expect(plainApprovalSettled()).toBe(false);
    // what a call would have said without waiting
    expect(spokenToolAction("other", "Agents_web_search")).toBe("use web search");
    arrive(realModule);
    await pending;
    expect(plainApprovalSettled()).toBe(true);
    expect(settledHeard).toHaveBeenCalledTimes(1);
    expect(spokenToolAction("other", "Agents_web_search")).toBe("search the web");
    stop();
  });

  it("settles on a failed round too, so the request is still spoken in the neutral wording", async () => {
    vi.useFakeTimers();
    resetPlainApprovalForTests(async () => { throw new TypeError("offline"); });
    const settledHeard = vi.fn();
    const readyHeard = vi.fn();
    const stopSettled = subscribePlainApprovalSettled(settledHeard);
    const stopReady = subscribePlainApproval(readyHeard);
    const settled = loadPlainApproval().catch((error: unknown) => error);
    expect(plainApprovalSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_RETRY_DELAYS_MS[0] + PLAIN_APPROVAL_RETRY_DELAYS_MS[1]);
    expect(await settled).toBeInstanceOf(TypeError);
    expect(plainApprovalSettled()).toBe(true);
    expect(plainApprovalReady()).toBe(false);
    expect(settledHeard).toHaveBeenCalledTimes(1);
    // the cards' subscription is only for the words themselves
    expect(readyHeard).not.toHaveBeenCalled();
    stopSettled();
    stopReady();
  });
});

describe("a call's wait for the plain words is bounded", () => {
  it("an import that never arrives nor fails: the call holds a new approval only until the wait runs out, then asks in the neutral wording", async () => {
    vi.useFakeTimers();
    resetPlainApprovalForTests(() => new Promise<PlainModule>(() => undefined));
    const settledHeard = vi.fn();
    const stop = subscribePlainApprovalSettled(settledHeard);
    void loadPlainApproval().catch(() => undefined);
    startPlainApprovalWait();
    // a new approval (never asked) is held while the words may still come
    expect(holdForPlainWords("req-1", undefined, plainApprovalSettled())).toBe(true);
    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_WAIT_MS - 1);
    expect(plainApprovalSettled()).toBe(false);
    expect(settledHeard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(plainApprovalSettled()).toBe(true);
    expect(settledHeard).toHaveBeenCalledTimes(1);
    // not held any more: asked, in the wording used while the words load
    expect(holdForPlainWords("req-1", undefined, plainApprovalSettled())).toBe(false);
    expect(plainApprovalReady()).toBe(false);
    expect(spokenToolAction("other", "Agents_web_search")).toBe("use web search");
    stop();
  });

  it("words that arrive after the wait ran out fill the cache, and the approval already asked is not asked again", async () => {
    vi.useFakeTimers();
    let arrive!: (module: PlainModule) => void;
    resetPlainApprovalForTests(() => new Promise<PlainModule>((resolve) => { arrive = resolve; }));
    const pending = loadPlainApproval();
    startPlainApprovalWait();
    await vi.advanceTimersByTimeAsync(PLAIN_APPROVAL_WAIT_MS);
    expect(plainApprovalSettled()).toBe(true);
    // the call asked req-1 now (askedApproval = req-1)
    const asked = "req-1";
    arrive(realModule);
    await pending;
    expect(plainApprovalReady()).toBe(true);
    expect(spokenToolAction("other", "Agents_web_search")).toBe("search the web");
    // the effect re-runs on the arrival: req-1 is neither held nor new, so it is not spoken a second time
    expect(holdForPlainWords("req-1", asked, plainApprovalSettled())).toBe(false);
    // a later approval gets the plain words without waiting
    expect(holdForPlainWords("req-2", asked, plainApprovalSettled())).toBe(false);
  });

  it("CallView and GroupCallView hold a new approval through holdForPlainWords and ask only an approval not asked yet (source check)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["../components/CallView.tsx", "../components/GroupCallView.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toContain("const approvalWordsSettled = usePlainApprovalSettled();");
      const gate = source.indexOf("if (holdForPlainWords(approval?.requestId, askedApproval.current?.requestId, approvalWordsSettled)) return;");
      expect(gate).toBeGreaterThan(0);
      // the asking block after the gate only takes an approval whose requestId was not asked yet
      expect(source.indexOf("askedApproval.current?.requestId !== approval.requestId", gate)).toBeGreaterThan(gate);
    }
    const call = readFileSync(new URL("../components/CallView.tsx", import.meta.url), "utf8");
    // no recognition turn while the microphone is unavailable, whatever opens it (the duplex effect included)
    const openTurn = call.slice(call.indexOf("const openTurn = useCallback("), call.indexOf("micLive.current = true;", call.indexOf("const openTurn = useCallback(")));
    expect(openTurn).toContain("if (micUnavailable.current) return;");
  });
});
