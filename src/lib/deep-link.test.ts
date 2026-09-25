// A link into one message: `#open=<threadId>&msg=<messageId>` from the phone
// app or a pasted URL, and the app's notificationOpened event. Nothing can be
// placed until the first snapshot has loaded, so targets wait for it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createDeepLinkQueue, openDeepLink, openHashHref, parseOpenHash } from "./deep-link";

describe("reading the fragment", () => {
  it("reads a thread and a message", () => {
    expect(parseOpenHash("#open=thread-1&msg=message-9")).toEqual({ threadId: "thread-1", messageId: "message-9" });
    expect(parseOpenHash("#open=thread%2F1")).toEqual({ threadId: "thread/1" });
  });

  it("leaves every other fragment alone, including the door's pairing link", () => {
    // /enter#murage_pair_… is the door's; it must never be read or cleared here.
    expect(parseOpenHash("#murage_pair_abcdef")).toBeNull();
    expect(parseOpenHash("")).toBeNull();
    expect(parseOpenHash("#msg=m1&open=t1")).toBeNull();
  });

  it("refuses ids that are empty or absurdly long, and drops a bad message id only", () => {
    expect(parseOpenHash("#open=")).toBeNull();
    expect(parseOpenHash(`#open=${"t".repeat(513)}`)).toBeNull();
    expect(parseOpenHash(`#open=t1&msg=${"m".repeat(513)}`)).toEqual({ threadId: "t1" });
  });

  it("removes the fragment and keeps the path and query", () => {
    expect(openHashHref("/", "?x=1")).toBe("/?x=1");
  });
});

describe("waiting for the snapshot", () => {
  it("holds a target until ready, then opens it once", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.push({ threadId: "t1" });
    expect(open).not.toHaveBeenCalled();
    queue.ready();
    queue.ready();
    expect(open.mock.calls).toEqual([[{ threadId: "t1" }]]);
  });

  it("opens the newest of several early taps, not all of them in a row", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.push({ threadId: "t1" });
    queue.push({ threadId: "t2", messageId: "m2" });
    queue.ready();
    expect(open.mock.calls).toEqual([[{ threadId: "t2", messageId: "m2" }]]);
  });

  it("opens at once after ready", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.ready();
    queue.push({ threadId: "t3" });
    expect(open).toHaveBeenCalledWith({ threadId: "t3" });
  });
});

describe("opening", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];

  it("opens the thread and lands on the message", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "detached-thread", messageId: "m1" }, { bots, groups: [] }, dispatch)).toBe(true);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
      { type: "focusMessage", threadId: "detached-thread", messageId: "m1" },
    ]);
  });

  it("focuses nothing when the thread cannot be placed", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "gone", messageId: "m1" }, { bots, groups: [] }, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("is mounted once, in the shell", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  expect(app).toContain("useDeepLinks();");
  const hook = readFileSync(fileURLToPath(new URL("../components/useDeepLinks.ts", import.meta.url)), "utf8");
  expect(hook).toContain('onNativeEvent("notificationOpened"');
  expect(hook).toContain('window.addEventListener("hashchange"');
  expect(hook).toContain("if (state.hydrated) queue.ready();");
});
