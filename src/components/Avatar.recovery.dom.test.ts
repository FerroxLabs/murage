// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import "@/lib/settings-copy";
import { ensureDesktopSurfaceSecret, openLiveEvents, type LiveEventSourceLike } from "@/lib/live-events";
import { installDOMHarness, mount, settle } from "@/testing/dom-harness";
import { BotAvatar } from "./Avatar";
import { BrowseBotsPage } from "./settings/BrowseBotsPage";

const bot = {
  name: "Nova Finch",
  color: "blue" as const,
  avatarCrop: "rounded" as const,
  avatarUrl: "/api/attachments/portrait.png",
};
const avatar = (profile = bot) => createElement(BotAvatar, { bot: profile, animated: false });
const fire = (node: EventTarget, event: string) => act(() => { node.dispatchEvent(new Event(event)); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const image = (container: HTMLElement) => container.querySelector("img");
let clean: () => void;

beforeEach(() => {
  clean = installDOMHarness();
  vi.useFakeTimers();
});
afterEach(() => {
  clean();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows colored initials while loading and after an image error, with an empty alt", () => {
  const { container } = mount(avatar());
  const attempt = image(container)!;
  expect(attempt.alt).toBe("");
  expect(getComputedStyle(attempt).display).toBe("none");
  expect(container.textContent).toBe("NF");

  fire(attempt, "error");
  expect(image(container)).toBeNull();
  expect(container.textContent).toBe("NF");
  const fallback = container.querySelector<HTMLElement>("[aria-hidden=true]")!;
  expect(getComputedStyle(fallback).display).not.toBe("none");
  expect(fallback.style.backgroundColor).not.toBe("");
  expect(fallback.style.borderRadius).toBe("22%");
});

it("retries the same picture with backoff and only swaps in a loaded image", () => {
  const { container } = mount(avatar());
  const first = image(container)!;
  fire(first, "error");

  advance(249);
  expect(image(container)).toBeNull();
  advance(1);
  const second = image(container)!;
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  expect(second.getAttribute("src")).toBe(bot.avatarUrl);
  fire(second, "error");

  advance(499);
  expect(image(container)).toBeNull();
  advance(1);
  const third = image(container)!;
  expect(getComputedStyle(third).display).toBe("none");
  expect(container.textContent).toBe("NF");
  fire(third, "load");
  expect(getComputedStyle(third).display).not.toBe("none");
  expect(container.textContent).toBe("");
  advance(60_000);
  expect(image(container)).toBe(third);
});

it("wakes failed avatars on stream readiness and reconnect, without reloading healthy photos", () => {
  const streams: LiveEventSourceLike[] = [];
  const stop = openLiveEvents({ onFrame() {}, onSnapshotRequired: async () => true, staleMs: 600_000 }, {
    createEventSource: () => {
      const stream = { onopen: null, onerror: null, onmessage: null, close() {} };
      streams.push(stream);
      return stream;
    },
    isVisible: () => true,
    isOnline: () => true,
  });
  try {
    const { container } = mount(avatar());
    const healthy = mount(avatar({ ...bot, avatarUrl: "/api/attachments/other.png" })).container;
    const healthyImage = image(healthy)!;
    fire(healthyImage, "load");
    const first = image(container)!;
    fire(first, "error");
    act(() => streams[0]!.onopen!());
    const second = image(container)!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    fire(second, "load");
    expect(getComputedStyle(second).display).not.toBe("none");

    act(() => streams[0]!.onerror!());
    fire(second, "error");
    for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 32000]) {
      advance(delay);
      fire(image(container)!, "error");
    }
    advance(120_000);
    expect(image(container)).toBeNull();
    expect(container.textContent).toBe("NF");
    act(() => streams[1]!.onopen!());
    const recovered = image(container)!;
    expect(getComputedStyle(recovered).display).toBe("none");
    fire(recovered, "load");
    expect(getComputedStyle(recovered).display).not.toBe("none");
    expect(image(healthy)).toBe(healthyImage);
  } finally {
    stop();
  }
});

it("discards a failed picture's retry when the bot switches to a new picture", () => {
  const view = mount(avatar());
  const old = image(view.container)!;
  fire(old, "error");
  view.rerender(avatar({ ...bot, avatarUrl: "/api/attachments/replacement.png" }));
  const replacement = image(view.container)!;
  expect(replacement.getAttribute("src")).toBe("/api/attachments/replacement.png");
  expect(getComputedStyle(replacement).display).toBe("none");
  fire(old, "load");
  advance(60_000);
  expect(image(view.container)).toBe(replacement);
  expect(view.container.textContent).toBe("NF");
  fire(replacement, "load");
  expect(view.container.textContent).toBe("");
});

it("keeps the Settings row name and Open button while its portrait recovers", () => {
  const { container } = mount(createElement(BrowseBotsPage, { bots: [{ ...bot, id: "nova" }], onOpen() {} }));
  const row = container.querySelector<HTMLElement>("[data-settings-browse-row=nova]")!;
  const pending = image(row)!;
  expect(pending.alt).toBe("");
  expect(getComputedStyle(pending).display).toBe("none");
  fire(pending, "error");
  expect(image(row)).toBeNull();
  expect(row.querySelector("[aria-hidden=true]")?.textContent).toBe("NF");
  expect(row.querySelector("button")?.getAttribute("aria-label")).toBe("Open Nova Finch");
  advance(250);
  const retry = image(row)!;
  fire(retry, "load");
  expect(getComputedStyle(retry).display).not.toBe("none");
  expect(row.textContent).toContain(bot.name);
});

it("gets a fresh desktop resource ticket on retry and keeps the pending image hidden", async () => {
  vi.stubGlobal("muragebox", { desktopSurfaceSecret: "test-proof" });
  await ensureDesktopSurfaceSecret(true);
  const mint = vi.fn()
    .mockResolvedValueOnce(Response.json({ ticket: "first" }))
    .mockResolvedValueOnce(Response.json({ ticket: "second" }));
  vi.stubGlobal("fetch", mint);
  const { container } = mount(avatar());
  expect(container.textContent).toBe("NF");
  await settle();
  const attempt = image(container)!;
  expect(attempt.getAttribute("src")).toBe(bot.avatarUrl + "?surfaceTicket=first");
  fire(attempt, "error");
  expect(image(container)).toBeNull();

  advance(250);
  await settle();
  const retry = image(container)!;
  expect(retry.getAttribute("src")).toBe(bot.avatarUrl + "?surfaceTicket=second");
  expect(getComputedStyle(retry).display).toBe("none");
  expect(mint).toHaveBeenCalledTimes(2);
  fire(retry, "load");
  expect(getComputedStyle(retry).display).not.toBe("none");
});
