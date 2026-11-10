// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BRLOCK19, extension route: Page.getFrameTree never lists a cross-site iframe, so the page lock reads the tab's frames
// (chrome.webNavigation.getAllFrames through the extension) and locks on a frame from another origin, or on a read that fails.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserExtensionExecutor, frameLockVerdict, type ExtensionDocument } from "./browser-extension-executor.ts";

const DOC: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://shop.example", url: "https://shop.example/" };
const top = { frameId: 0, parentFrameId: -1, url: "https://shop.example/" };

function executor(frames: (() => Promise<unknown>) | undefined, passwordPage = false, tree: () => unknown = () => ({ root: { nodeType: 9, children: [] } }), described: Record<number, unknown> = {}) {
  return new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async () => true,
    transport: {
      document: async () => ({ ...DOC }),
      ...(frames ? { frames } : {}),
      send: async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate") return String(params.expression).includes("__murageGuard()") ? { result: { type: "boolean", value: passwordPage } } : { result: { value: 0 } };
        if (method === "DOM.getDocument") return tree();
        if (method === "DOM.describeNode") return { node: described[params.backendNodeId as number] ?? { nodeType: 1, nodeName: "IFRAME", backendNodeId: params.backendNodeId, childNodeCount: 0 } };
        return {};
      },
    },
  } as never);
}

describe("frameLockVerdict", () => {
  it("a frame from another origin locks", () => {
    expect(frameLockVerdict({ frames: [top, { frameId: 5, parentFrameId: 0, url: "https://pay.other.example/card" }] }, DOC.url)).toBe("locked");
  });
  it("a page with no frames, or only same-origin and blank frames, stays clear", () => {
    expect(frameLockVerdict({ frames: [top] }, DOC.url)).toBe("clear");
    expect(frameLockVerdict({ frames: [top, { frameId: 2, parentFrameId: 0, url: "https://shop.example/widget" }, { frameId: 3, parentFrameId: 0, url: "about:blank" }] }, DOC.url)).toBe("clear");
  });
  it("about:blank and about:srcdoc with a fragment or query still take the parent's origin", () => {
    expect(frameLockVerdict({ frames: [top, { frameId: 2, parentFrameId: 0, url: "about:blank#foo" }, { frameId: 3, parentFrameId: 0, url: "about:srcdoc?x=1" }] }, DOC.url)).toBe("clear");
  });
  it("two top frames (a cached document beside the live one) is unsure, not a lock on a stale origin", () => {
    expect(frameLockVerdict({ frames: [top, { frameId: 0, parentFrameId: -1, url: "https://old.example/" }] }, DOC.url)).toBe("unsure");
  });
  it("an unreadable answer is unsure, never clear", () => {
    for (const reply of [undefined, null, {}, { frames: [] }, { frames: "x" }, { frames: [{ frameId: 5, parentFrameId: 0, url: "https://shop.example/a" }] }]) expect(frameLockVerdict(reply, DOC.url)).toBe("unsure");
    expect(frameLockVerdict({ frames: [top, { frameId: 5, parentFrameId: 0, url: "data:text/html,x" }] }, DOC.url)).toBe("unsure");
    expect(frameLockVerdict({ frames: [top, { frameId: 5, parentFrameId: 0 }] }, DOC.url)).toBe("unsure");
  });
});

describe("the extension route locks on an out-of-process frame", () => {
  it("a cross-site iframe LOCKS", async () => {
    expect(await executor(async () => ({ frames: [top, { frameId: 9, parentFrameId: 0, url: "https://elsewhere.example/" }] })).protectedDocument({ ...DOC })).toBe(true);
  });
  it("an ordinary page stays unlocked (Hobart)", async () => {
    expect(await executor(async () => ({ frames: [top] })).protectedDocument({ ...DOC })).toBe(false);
  });
  // An old store extension answers Murage.getAllFrames with method_denied; the browser's own DOM tree is the fallback.
  const denied = async () => { throw Object.assign(new Error("method_denied"), { code: "method_denied" }); };
  const page = (...children: unknown[]) => () => ({ root: { nodeType: 9, backendNodeId: 1, childNodeCount: children.length, children } });
  const iframe = (extra: Record<string, unknown> = {}) => ({ nodeType: 1, nodeName: "IFRAME", backendNodeId: 20, childNodeCount: 0, ...extra });
  it("an old extension (frame listing denied) with a clean page tree stays unlocked", async () => {
    expect(await executor(denied, false, page()).protectedDocument({ ...DOC })).toBe(false);
  });
  it("an old extension: an iframe the browser shows a contentDocument for (same process) stays unlocked", async () => {
    expect(await executor(denied, false, page(iframe({ contentDocument: { nodeType: 9, backendNodeId: 21, childNodeCount: 0, children: [] } }))).protectedDocument({ ...DOC })).toBe(false);
  });
  it("an old extension: an iframe whose contentDocument only shows on a direct look (cut off by depth) stays unlocked", async () => {
    const inner = { nodeType: 9, backendNodeId: 21, childNodeCount: 0, children: [] };
    expect(await executor(denied, false, page(iframe()), { 20: iframe({ contentDocument: inner }) }).protectedDocument({ ...DOC })).toBe(false);
  });
  it("an old extension: an iframe inserted after a clean look locks the next look of the same page (the fallback is never cached)", async () => {
    let inserted = false;
    const e = executor(denied, false, () => (inserted ? page(iframe())() : page()()));
    expect(await e.protectedDocument({ ...DOC })).toBe(false);
    inserted = true;
    expect(await e.protectedDocument({ ...DOC })).toBe(true);
  });
  it("an old extension: an iframe with no contentDocument is out-of-process and LOCKS", async () => {
    expect(await executor(denied, false, page(iframe())).protectedDocument({ ...DOC })).toBe(true);
  });
  it("a frame listing that fails for any other reason is doubt and LOCKS, whatever the tree says", async () => {
    expect(await executor(async () => { throw Object.assign(new Error("binding_inactive"), { code: "binding_inactive" }); }, false, page()).protectedDocument({ ...DOC })).toBe(true);
  });
  it("only the error CODE method_denied falls back: the same words under another code are doubt", async () => {
    expect(await executor(async () => { throw Object.assign(new Error("method_denied"), { code: "binding_inactive" }); }, false, page()).protectedDocument({ ...DOC })).toBe(true);
    expect(await executor(async () => { throw new Error("method_denied"); }, false, page()).protectedDocument({ ...DOC })).toBe(true);
  });
  it("an old extension: an <object> or <embed> with no contentDocument is doubt and LOCKS", async () => {
    expect(await executor(denied, false, page({ nodeType: 1, nodeName: "OBJECT", backendNodeId: 22, childNodeCount: 0 })).protectedDocument({ ...DOC })).toBe(true);
  });
  it("a frame listing that fails AND a page tree that cannot be read LOCKS", async () => {
    const e = executor(async () => { throw new Error("no webNavigation"); }, false, () => { throw new Error("tree_denied"); });
    expect(await e.protectedDocument({ ...DOC })).toBe(true);
  });
  it("a password page still locks", async () => {
    expect(await executor(async () => ({ frames: [top] }), true).protectedDocument({ ...DOC })).toBe(true);
  });
  it("the service hands the executor the frame listing, and the extension answers it (the lock is wired end to end)", () => {
    expect(readFileSync(new URL("./browser-extension-service.ts", import.meta.url), "utf8")).toContain("frames:document=>transport.send('Murage.getAllFrames'");
    const runtime = readFileSync(new URL("../extensions/murage-browser/runtime.mjs", import.meta.url), "utf8");
    expect(runtime).toContain("method === 'Murage.getAllFrames'");
    expect(runtime).toContain("api.webNavigation.getAllFrames");
    expect(runtime).toContain("documentLifecycle === 'active'");
  });
});
