// @vitest-environment jsdom
// Warm presence (designs/WARM-W1-1022-presence.md P-PRE 1a, P-SIG 1a; W-PR3 a, W-PR1 e): opening a chat (the composer mounts on a
// bot and thread) posts /warm once, and the /warm body says whether a real gesture is behind it. A mount with no user activation
// (a reload, a relaunch restoring the last chat, a programmatic focus) sends gesture false, so it never makes the owner present.
// The real hook and the real api() run; only the network (globalThis.fetch) is captured.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWarmIntent } from "./use-warm-intent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
let posts: { url: string; body: unknown }[];

function Composer({ botId, threadId }: { botId: string; threadId: string }) {
  useWarmIntent(botId, threadId, "");
  return null;
}
const setActivation = (isActive: boolean | undefined) => {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: isActive === undefined ? undefined : { isActive } });
};
const warmPosts = () => posts.filter((p) => /\/api\/bots\/[^/]+\/warm$/.test(p.url));

beforeEach(() => {
  posts = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input instanceof Request ? input.url : input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); setActivation(undefined); });

describe("W-PR3a / W-PR1e opening a chat warms it, and says whether a gesture is behind it", () => {
  it("W-PR3a: the composer mounting on a bot and thread after a real click posts /warm once with gesture true, marked as a chat open (hold only)", async () => {
    setActivation(true);
    await act(async () => { root.render(createElement(Composer, { botId: "bot-open-1", threadId: "thread-open-1" })); });
    expect(warmPosts().map((p) => p.body)).toEqual([{ threadId: "thread-open-1", gesture: true, open: true }]); // W-PR3a:mount-warm
  });

  it("W-PR1e: a mount with no user activation (reload, relaunch) posts gesture false; no activation API also posts false", async () => {
    setActivation(false);
    await act(async () => { root.render(createElement(Composer, { botId: "bot-open-2", threadId: "thread-open-2" })); });
    setActivation(undefined);
    await act(async () => { root.render(createElement(Composer, { botId: "bot-open-2", threadId: "thread-open-3" })); });
    expect(warmPosts().map((p) => p.body)).toEqual([{ threadId: "thread-open-2", gesture: false, open: true }, { threadId: "thread-open-3", gesture: false, open: true }]); // W-PR1e:no-gesture
  });
});
