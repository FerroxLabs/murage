// A link out of the app, and an a[download] in the page, inside the phone
// app. The WebView has no tabs: `window.open` returns null there and a
// target=_blank link does nothing, so the phone app opens them in the system
// browser (spec §3.6). The desktop keeps its own bridge; a browser keeps the
// blank-tab-then-navigate that keeps an opener away from OAuth pages.
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "./native-shell";
import { nativeClickAction, openExternalPage, routeNativeClicks } from "./open-external";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://desk.tail0a48a4.ts.net";

describe("opening a page outside Murage", () => {
  it("uses the desktop bridge when there is one", async () => {
    const openExternal = vi.fn(async () => true);
    const open = vi.fn();
    vi.stubGlobal("window", { muragebox: { openExternal }, open });
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(openExternal).toHaveBeenCalledWith("https://composio.dev/auth");
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the phone app when it offers openExternal", async () => {
    const openExternal = vi.fn(async () => undefined);
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["openExternal"] }), openExternal });
    await nativeHello();
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(openExternal).toHaveBeenCalledWith("https://composio.dev/auth");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a blank tab first in a browser, then navigates it without an opener", async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() } };
    vi.stubGlobal("window", { open: vi.fn(() => tab) });
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith("https://composio.dev/auth");
  });

  it("says what happened when the browser blocks the tab", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    await expect(openExternalPage("https://x.example", "Allow pop-ups, then try again.")).rejects.toThrow("Allow pop-ups, then try again.");
  });
});

describe("which clicks the phone app takes over", () => {
  const anchor = (over: Partial<Parameters<typeof nativeClickAction>[0]>) => ({ href: "", target: "", hasDownload: false, download: "", ...over });

  it("saves any a[download], naming it from the attribute or the path", () => {
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/api/attachments/a1`, hasDownload: true, download: "clip.mp4" }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/api/attachments/a1`, filename: "clip.mp4" });
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/files/My%20Report.pdf`, hasDownload: true }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/files/My%20Report.pdf`, filename: "My Report.pdf" });
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/files/%E0%A4%A`, hasDownload: true }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/files/%E0%A4%A`, filename: "download" });
  });

  it("sends a cross-origin target=_blank link to the system browser", () => {
    expect(nativeClickAction(anchor({ href: "https://docs.murage.ai/x", target: "_blank" }), ORIGIN))
      .toEqual({ kind: "external", url: "https://docs.murage.ai/x" });
  });

  it("leaves same-origin, same-tab and non-web links alone", () => {
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/api/artifacts/a1/view`, target: "_blank" }), ORIGIN)).toBeNull();
    expect(nativeClickAction(anchor({ href: "https://docs.murage.ai/x" }), ORIGIN)).toBeNull();
    expect(nativeClickAction(anchor({ href: "mailto:a@b.c", target: "_blank" }), ORIGIN)).toBeNull();
  });

  it("routes a real click, but never one a component already handled", async () => {
    const saveFile = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile", "openExternal"] }), saveFile, openExternal });
    await nativeHello();
    let handler: ((event: any) => void) | undefined;
    const doc = { addEventListener: vi.fn((_: string, h: any) => { handler = h; }), removeEventListener: vi.fn() };
    const stop = routeNativeClicks(doc as any, ORIGIN);
    const click = (a: Record<string, unknown>, defaultPrevented = false) => {
      const event = {
        defaultPrevented,
        button: 0,
        preventDefault: vi.fn(),
        target: { closest: () => ({ hasAttribute: (n: string) => n === "download" && "download" in a, getAttribute: () => a.download ?? "", target: "", href: "", ...a }) },
      };
      handler!(event);
      return event;
    };
    expect(click({ href: "https://docs.murage.ai/x", target: "_blank" }).preventDefault).toHaveBeenCalled();
    expect(click({ href: `${ORIGIN}/api/attachments/a1`, download: "a.png" }).preventDefault).toHaveBeenCalled();
    expect(click({ href: "https://docs.murage.ai/y", target: "_blank" }, true).preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: `${ORIGIN}/api/attachments/a1`, filename: "a.png" });
    stop();
    expect(doc.removeEventListener).toHaveBeenCalledWith("click", handler);
  });
});

it("is installed only inside the phone app", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("if (inNativeShell()) routeNativeClicks();");
});
