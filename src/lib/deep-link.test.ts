// A link into one message: `#open=<threadId>&msg=<messageId>` from the phone
// app or a pasted URL, and the app's notificationOpened event. Nothing can be
// placed until the first snapshot has loaded, so targets wait for it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createDeepLinkQueue, openDeepLink, openHashHref, parseOpenHash } from "./deep-link";
import { DEEP_LINK_MAX_PAGES } from "./scrollback";

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

// open-hash.json is checked in native-contract.test.ts, which passes unchanged.
describe("the phone app's fixtures", () => {
  const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../apps/mobile/contract/${name}`, import.meta.url)), "utf8")) as Array<Record<string, unknown>>;

  it("reads every compose-hash case as listed and refuses the rest", () => {
    for (const row of read("compose-hash.json")) {
      const hash = row.hash as string;
      if ("parses" in row) {
        expect(parseOpenHash(hash), String(row.why)).toBeNull();
      } else if (row.bot) {
        expect(parseOpenHash(hash), hash).toEqual({ botId: row.bot, compose: true });
      } else {
        expect(parseOpenHash(hash), hash).toEqual({ threadId: row.threadId, compose: true, ...(row.again ? { again: row.again } : {}) });
      }
    }
  });

  it("refuses odd compose shapes outright", () => {
    for (const hash of ["#open=bot:b1", "#open=bot:b1&compose=1&again=m1", "#open=bot:b1&compose=1&msg=m2", "#open=t1&compose=", "#open=t1&compose=1&compose=2", "#open=t1&compose=1&again=m1&again=m2", "#open=bot:b1&compose=true"]) {
      expect(parseOpenHash(hash), hash).toBeNull();
    }
  });
});

describe("opening a compose link", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [] }];
  it("opens the bot's main chat and never dispatches a send", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ botId: "bot-1", compose: true }, { bots, groups: [] }, dispatch)).toBe(true);
    const types = dispatch.mock.calls.map(([action]) => action.type);
    expect(types).toEqual(["select", "switchTask"]);
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ botId: "bot-1", threadId: "main-thread" });
  });
  it("opens nothing for a bot this device does not hold", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ botId: "ghost", compose: true }, { bots, groups: [] }, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("opens a thread link with compose and again the same way as a plain one", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "main-thread", compose: true, again: "m1" }, { bots, groups: [] }, dispatch)).toBe(true);
    expect(dispatch.mock.calls.map(([a]) => a.type)).not.toContain("send");
    expect(dispatch.mock.calls.map(([a]) => a.type)).not.toContain("focusMessage");
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
      { type: "focusMessage", threadId: "detached-thread", messageId: "m1", maxPages: DEEP_LINK_MAX_PAGES },
    ]);
    expect(DEEP_LINK_MAX_PAGES).toBe(5);
  });

  it("focuses nothing when the thread cannot be placed", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "gone", messageId: "m1" }, { bots, groups: [] }, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("hands the page cap through the store to the walk", () => {
  const store = readFileSync(fileURLToPath(new URL("../state/store.tsx", import.meta.url)), "utf8");
  expect(store).toContain("scrollback.loadThrough(threadId, messageId, maxPages)");
});

it("is mounted once, in the shell", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  expect(app).toContain("useDeepLinks();");
  const hook = readFileSync(fileURLToPath(new URL("../components/useDeepLinks.ts", import.meta.url)), "utf8");
  expect(hook).toContain('onNativeEvent("notificationOpened"');
  expect(hook).toContain('window.addEventListener("hashchange"');
  expect(hook).toContain("if (state.hydrated) queue.ready();");
});
