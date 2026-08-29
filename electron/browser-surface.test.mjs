import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { GUEST_PROFILE, VIEWPORT, createBrowserSurfaceManager } = require("./browser-surface.cjs");

const AX_NODES = [
  { role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 11 },
  { role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 12 },
  { role: { value: "combobox" }, name: { value: "Country" }, backendDOMNodeId: 13 },
];

/** A WebContents + WebContentsView double that records what the manager
 * asked of it. CDP calls answer from a small table so the click/fill
 * sequences can be asserted verbatim; protocol events can be injected. */
function fakeView(partition) {
  const calls = [];
  const listeners = new Map();
  const debuggerListeners = new Map();
  let url = "about:blank";
  let title = "";
  let pageText = "Welcome. Docs Search";
  const webContents = {
    session: {
      getUserAgent: () => "Mozilla/5.0 Chrome/1 Electron/43 OpenMausBot/1",
      setUserAgent: (ua) => calls.push(["setUserAgent", ua]),
      setPermissionCheckHandler: () => {},
      setPermissionRequestHandler: () => {},
      on: () => {},
    },
    setWindowOpenHandler: (handler) => {
      webContents.windowOpenHandler = handler;
    },
    on: (name, handler) => {
      listeners.set(name, handler);
    },
    once: (name, handler) => {
      listeners.set(name, handler);
    },
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => title,
    navigationHistory: {
      canGoBack: () => url !== "about:blank",
      canGoForward: () => false,
      goBack: () => calls.push(["goBack"]),
      goForward: () => calls.push(["goForward"]),
    },
    loadURL: async (next) => {
      calls.push(["loadURL", next]);
      url = next;
      title = next === "about:blank" ? "" : "Loaded";
    },
    enableDeviceEmulation: (options) => calls.push(["enableDeviceEmulation", options]),
    disableDeviceEmulation: () => calls.push(["disableDeviceEmulation"]),
    close: () => calls.push(["close"]),
    capturePage: async () => ({
      getSize: () => ({ width: 2048, height: 1200 }),
      resize: ({ width }) => ({ getSize: () => ({ width, height: Math.round((1200 * width) / 2048) }), toJPEG: () => Buffer.from("jpeg") }),
      toJPEG: () => Buffer.from("jpeg"),
    }),
    debugger: {
      attached: false,
      attach: (version) => {
        calls.push(["attach", version]);
        webContents.debugger.attached = true;
      },
      detach: () => calls.push(["detach"]),
      on: (name, handler) => debuggerListeners.set(name, handler),
      sendCommand: async (method, params) => {
        calls.push([method, params]);
        if (method === "Accessibility.getFullAXTree") return { nodes: AX_NODES };
        if (method === "DOM.getBoxModel") {
          if (params.backendNodeId === 99) throw new Error("No node with given id found");
          const base = params.backendNodeId === 13 ? 200 : 10;
          return { model: { border: [base, 20, base + 100, 20, base + 100, 60, base, 60] } };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
        if (method === "Runtime.callFunctionOn") return { result: { value: { chosen: ["India"] } } };
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression);
          if (expression === "/*injected*/") {
            view.injected = true;
            return { result: { value: undefined } };
          }
          if (expression.includes("Boolean(window.__ombBrowser)")) return { result: { value: view.injected === true } };
          if (expression.includes("__ombBrowser.snapshot(")) return { result: { value: { yaml: '- heading "Docs" [ref=e1]\n- textbox "Search" [ref=e2]', refs: ["e1", "e2"], truncated: false } } };
          if (expression.includes("boxForRef")) {
            if (expression.includes('"e9"')) return { result: { value: { found: false } } };
            return { result: { value: { found: true, connected: true, visible: true, x: 77, y: 33 } } };
          }
          if (expression.includes("focusRef")) return { result: { value: true } };
          if (expression.includes("elementForRef")) return { result: { objectId: "obj-e1" } };
          if (expression.includes("scrollingElement")) return { result: { value: { top: 0, height: 2400, view: 800 } } };
          return { result: { value: pageText } };
        }
        if (method === "Page.captureScreenshot") return { data: Buffer.from("cdp-jpeg").toString("base64") };
        return {};
      },
    },
  };
  const view = {
    partition,
    webContents,
    bounds: null,
    visible: null,
    setBounds: (bounds) => {
      view.bounds = bounds;
    },
    setVisible: (visible) => {
      view.visible = visible;
    },
    getBounds: () => view.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
    calls,
    listeners,
    debuggerListeners,
    setPageText: (text) => {
      pageText = text;
    },
  };
  return view;
}

function harness(options = {}) {
  const views = [];
  const owner = {
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: {
      children: [],
      addChildView: (view) => {
        owner.contentView.children = owner.contentView.children.filter((candidate) => candidate !== view);
        owner.contentView.children.push(view);
      },
      removeChildView: (view) => {
        owner.contentView.children = owner.contentView.children.filter((candidate) => candidate !== view);
      },
    },
  };
  const states = [];
  let clock = 0;
  const manager = createBrowserSurfaceManager({
    owner,
    createView: (viewOptions) => {
      const view = fakeView(viewOptions.webPreferences.partition);
      views.push(view);
      return view;
    },
    notify: (state) => states.push(state),
    platform: "darwin",
    settleMs: 0,
    // real time (waits have real deadlines) but strictly monotonic (LRU order)
    now: () => Date.now() + (clock += 1),
    ...options,
  });
  return { manager, owner, views, states };
}

const cdpCalls = (view) => view.calls.filter(([name]) => /^[A-Z]/.test(name) && name.includes("."));
const BOUNDS = { x: 20, y: 30, width: 400, height: 250 };

describe("browser surface manager", () => {
  it("creates one sandboxed, partitioned view per bot only when something needs it", () => {
    const { manager, owner, views } = harness();
    expect(manager.layout("bot-a", null)).toMatchObject({ botId: "bot-a", open: false });
    expect(views).toHaveLength(0);

    // a view that exists but is not laid out still has a real viewport
    manager.ensure("bot-z", "");
    expect(views[0].bounds).toEqual({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
    expect(views[0].visible).toBe(false);
    manager.close("bot-z");
    views.length = 0;

    const state = manager.layout("bot-a", { x: 20.4, y: 30.6, width: 5000, height: 300 }, "", "compact");
    expect(views).toHaveLength(1);
    expect(views[0].partition).toBe("persist:openmausbot-browser-bot-a");
    expect(views[0].bounds).toEqual({ x: 20, y: 31, width: 1180, height: 300 });
    expect(views[0].visible).toBe(true);
    expect(owner.contentView.children).toEqual([views[0]]);
    expect(state).toMatchObject({ botId: "bot-a", open: true, visible: true, url: "about:blank", profile: "", mode: "compact" });
    expect(views[0].calls).toContainEqual(["setUserAgent", "Mozilla/5.0 Chrome/1"]);

    manager.layout("bot-a", null);
    expect(views[0].visible).toBe(false);
    expect(() => manager.layout("../bad", BOUNDS)).toThrow(/bot id/);
  });

  it("scales the fixed desktop viewport into the compact box and shows it 1:1 when expanded", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    const emulation = views[0].calls.find(([name]) => name === "enableDeviceEmulation")[1];
    expect(emulation.viewSize).toEqual(VIEWPORT);
    // 400/1280 = 0.3125 and 250/800 = 0.3125 — fit on both axes
    expect(emulation.scale).toBeCloseTo(0.3125, 4);
    manager.layout("bot-a", { x: 0, y: 0, width: 1100, height: 700 }, "", "expanded");
    expect(views[0].calls.at(-1)).toEqual(["disableDeviceEmulation"]);
    expect(manager.state("bot-a").mode).toBe("expanded");
  });

  it("navigates only to web pages and answers with the page's elements plus a scroll hint", async () => {
    const { manager, views } = harness();
    await expect(manager.navigate("bot-a", "file:///etc/passwd")).rejects.toThrow(/http and https/);
    const page = await manager.navigate("bot-a", "example.com");
    expect(views[0].calls).toContainEqual(["loadURL", "https://example.com/"]);
    expect(page.url).toBe("https://example.com/");
    expect(page.elements.map((element) => element.ref)).toEqual(["b11", "b12", "b13"]);
    expect(page.text).toContain('b11 link "Docs"');
    expect(page.text).toContain("1600px below");
    expect(views[0].calls).toContainEqual(["attach", "1.3"]);
    // attaching also enables Page events, intercepts native file pickers, and
    // makes the page believe it is focused so synthetic clicks are not dropped
    expect(cdpCalls(views[0]).slice(0, 3).map(([name]) => name)).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog", "Emulation.setFocusEmulationEnabled"]);
  });

  it("keeps one live view per profile and switches by showing another, never rebuilding", async () => {
    const { manager, owner, views, states } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    await manager.navigate("bot-a", "https://own.example");
    // switch to a named profile: a second view in the shared partition takes the same rectangle
    manager.layout("bot-a", BOUNDS, "work", "compact");
    expect(views).toHaveLength(2);
    expect(views[1].partition).toBe("persist:openmausbot-browser-profile-work");
    expect(views[0].visible).toBe(false);
    expect(views[1].visible).toBe(true);
    expect(views[1].bounds).toEqual(BOUNDS);
    expect(manager.state("bot-a")).toMatchObject({ profile: "work", url: "about:blank" });
    await manager.navigate("bot-a", "https://work.example");
    // back to the bot's own session: the first view is still there with its page
    manager.layout("bot-a", BOUNDS, "", "compact");
    expect(views).toHaveLength(2);
    expect(manager.state("bot-a")).toMatchObject({ profile: "", url: "https://own.example/" });
    expect(views[0].visible).toBe(true);
    expect(views[1].visible).toBe(false);
    expect(owner.contentView.children.at(-1)).toBe(views[0]);
    // a caller that does not know the profile acts on whatever is active
    const page = await manager.snapshot("bot-a");
    expect(page.url).toBe("https://own.example/");
    // another bot on the same named profile shares the session, not the view
    manager.layout("bot-b", BOUNDS, "work", "compact");
    expect(views[2].partition).toBe("persist:openmausbot-browser-profile-work");
    expect(manager.list().filter((entry) => entry.active).map((entry) => entry.botId).sort()).toEqual(["bot-a", "bot-b"]);
    expect(states.some((state) => state.botId === "bot-a" && state.profile === "work")).toBe(true);
    expect(views[1].calls.some(([name]) => name === "close")).toBe(false);
  });

  it("forgets a Guest session the moment the bot switches off it", async () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, GUEST_PROFILE, "compact");
    expect(views[0].partition).toMatch(/^openmausbot-browser-guest-bot-a-\d+$/);
    expect(views[0].partition.startsWith("persist:")).toBe(false);
    await manager.navigate("bot-a", "https://secret.example");
    manager.layout("bot-a", BOUNDS, "", "compact");
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.size()).toBe(1);
    // a fresh Guest is a fresh partition
    manager.layout("bot-a", BOUNDS, GUEST_PROFILE, "compact");
    expect(views[2].partition).not.toBe(views[0].partition);
  });

  it("evicts the coldest view nobody is showing when the cap is reached", async () => {
    const { manager, views } = harness({ maxViews: 3 });
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-a", BOUNDS, "p1", "compact");
    manager.layout("bot-a", BOUNDS, "p2", "compact");
    expect(manager.size()).toBe(3);
    // the fourth view evicts the least recently used inactive one (own session)
    manager.layout("bot-a", BOUNDS, "p3", "compact");
    expect(manager.size()).toBe(3);
    expect(views[0].calls.some(([name]) => name === "close")).toBe(true);
    expect(manager.list().map((entry) => entry.profile).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("clicks at the centre of a known ref and refuses stale or unknown ones", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.click("bot-a", "b99")).rejects.toThrow(/stale or unknown/);
    await expect(manager.click("bot-a", "nope")).rejects.toThrow(/stale or unknown/);
    await manager.click("bot-a", "b11");
    const mouse = cdpCalls(views[0]).filter(([name]) => name === "Input.dispatchMouseEvent").map(([, params]) => params);
    expect(mouse).toEqual([
      { type: "mouseMoved", x: 60, y: 40 },
      { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
    ]);
    // a navigation invalidates every ref until the next snapshot
    views[0].listeners.get("did-navigate")?.();
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/changed since/);
  });

  it("hovers, drags, and chooses select options through the page", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.hover("bot-a", "b11");
    expect(cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseMoved")).toHaveLength(1);
    await manager.drag("bot-a", "b11", "b13");
    const dragMoves = cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseMoved");
    expect(dragMoves.at(-1)[1]).toMatchObject({ x: 250, y: 40 });
    expect(cdpCalls(views[0]).filter(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseReleased").at(-1)[1]).toMatchObject({ x: 250, y: 40 });
    await manager.select("bot-a", "b13", "India");
    const call = cdpCalls(views[0]).find(([name]) => name === "Runtime.callFunctionOn")[1];
    expect(call.objectId).toBe("obj-13");
    expect(call.arguments).toEqual([{ value: ["India"] }]);
    await expect(manager.select("bot-a", "b13", [])).rejects.toThrow(/option value or label/);
  });

  it("fills a field by focusing it, selecting everything, and inserting text", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await manager.fill("bot-a", "b12", "running shoes");
    const all = cdpCalls(views[0]);
    const start = all.findIndex(([name]) => name === "DOM.focus");
    const sequence = all.slice(start, start + 6).map(([name, params]) => [name, params.type ?? params.text ?? params.backendNodeId]);
    expect(sequence).toEqual([
      ["DOM.focus", 12],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.dispatchKeyEvent", "keyDown"],
      ["Input.dispatchKeyEvent", "keyUp"],
      ["Input.insertText", "running shoes"],
    ]);
    // macOS select-all is ⌘A (modifier 4), not ^A
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "a")[1].modifiers).toBe(4);
  });

  it("presses named keys, scrolls the fixed viewport, and screenshots through the protocol", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    await expect(manager.press("bot-a", "F13")).rejects.toThrow(/unsupported key/);
    await manager.press("bot-a", "Enter");
    const enter = cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchKeyEvent" && params.key === "Enter" && params.type === "keyDown");
    expect(enter?.[1]).toMatchObject({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await manager.scroll("bot-a", "down");
    expect(cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mouseWheel")[1]).toMatchObject({ x: 640, y: 400, deltaX: 0, deltaY: 600 });
    await expect(manager.scroll("bot-a", "sideways")).rejects.toThrow(/direction/);
    const shot = await manager.screenshot("bot-a");
    expect(shot).toMatchObject({ format: "jpeg", width: 1024, height: 640, png: Buffer.from("cdp-jpeg").toString("base64") });
  });

  it("waits for text or an address, reads the page, and reports dialogs it answered", async () => {
    const { manager, views } = harness();
    await manager.navigate("bot-a", "https://example.com");
    const read = await manager.read("bot-a");
    expect(read).toMatchObject({ url: "https://example.com/", text: "Welcome. Docs Search", truncated: false });
    await expect(manager.waitFor("bot-a", { text: "Docs" })).resolves.toMatchObject({ url: "https://example.com/" });
    await expect(manager.waitFor("bot-a", { text: "never there", timeoutMs: 300 })).rejects.toThrow(/timed out waiting for text "never there"/);
    await expect(manager.waitFor("bot-a", { url: "example.com" })).resolves.toBeTruthy();
    // a JS dialog is answered by the surface and surfaces in the next result
    views[0].debuggerListeners.get("message")?.({}, "Page.javascriptDialogOpening", { type: "confirm", message: "Leave page?" });
    expect(cdpCalls(views[0]).at(-1)).toEqual(["Page.handleJavaScriptDialog", { accept: true }]);
    const page = await manager.snapshot("bot-a");
    expect(page.dialogs).toEqual([{ type: "confirm", message: "Leave page?" }]);
    expect(page.text).toContain('Dialog (confirm) was answered automatically: "Leave page?"');
    expect((await manager.snapshot("bot-a")).dialogs).toEqual([]);
  });

  it("uses Playwright's snapshot with e-refs when the page carries the script, injecting it once per document", async () => {
    const { manager, views } = harness({ injectedSource: "/*injected*/" });
    const page = await manager.navigate("bot-a", "https://example.com");
    expect(page.yaml).toBe('- heading "Docs" [ref=e1]\n- textbox "Search" [ref=e2]');
    expect(page.text).toContain('[ref=e1]');
    expect(page.elements).toEqual([]);
    // injected exactly once, then reused
    const injections = views[0].calls.filter(([name, params]) => name === "Runtime.evaluate" && params.expression === "/*injected*/");
    expect(injections).toHaveLength(1);
    await manager.snapshot("bot-a");
    expect(views[0].calls.filter(([name, params]) => name === "Runtime.evaluate" && params.expression === "/*injected*/")).toHaveLength(1);
    // clicks resolve through the page, at the element's centre
    await manager.click("bot-a", "e1");
    const pressed = cdpCalls(views[0]).find(([name, params]) => name === "Input.dispatchMouseEvent" && params.type === "mousePressed")[1];
    expect(pressed).toMatchObject({ x: 77, y: 33 });
    await expect(manager.click("bot-a", "e9")).rejects.toThrow(/stale or unknown/);
    await expect(manager.click("bot-a", "b11")).rejects.toThrow(/stale or unknown/);
    // fill focuses through the page; select resolves the element handle through the page
    await manager.fill("bot-a", "e2", "shoes");
    expect(cdpCalls(views[0]).some(([name]) => name === "DOM.focus")).toBe(false);
    await manager.select("bot-a", "e2", "India");
    expect(cdpCalls(views[0]).find(([name]) => name === "Runtime.callFunctionOn")[1].objectId).toBe("obj-e1");
    // no bundle → the bare accessibility tree with b-refs
    const bare = harness({ injectedSource: null });
    const fallback = await bare.manager.navigate("bot-a", "https://example.com");
    expect(fallback.yaml).toBeNull();
    expect(fallback.elements.map((element) => element.ref)).toEqual(["b11", "b12", "b13"]);
  });

  it("drops every bot's view on a deleted profile and leaves other sessions alone", () => {
    const { manager, views } = harness();
    manager.layout("bot-a", BOUNDS, "work", "compact");
    manager.layout("bot-b", BOUNDS, "work", "compact");
    manager.layout("bot-c", BOUNDS, "", "compact");
    expect(manager.forgetProfile("work")).toBe(2);
    expect(manager.size()).toBe(1);
    expect(views[2].calls.some(([name]) => name === "close")).toBe(false);
    expect(manager.state("bot-a")).toMatchObject({ open: false });
    expect(manager.forgetProfile(GUEST_PROFILE)).toBe(0);
    expect(manager.forgetProfile("")).toBe(0);
  });

  it("tears every view down on closeAll and hides them all on hideAll", async () => {
    const { manager, owner, views, states } = harness();
    manager.layout("bot-a", BOUNDS, "", "compact");
    manager.layout("bot-b", BOUNDS, "", "compact");
    expect(manager.size()).toBe(2);
    manager.hideAll();
    expect(views.map((view) => view.visible)).toEqual([false, false]);
    manager.close("bot-a");
    expect(manager.size()).toBe(1);
    manager.closeAll();
    expect(manager.size()).toBe(0);
    expect(owner.contentView.children).toEqual([]);
    expect(states.at(-1)).toMatchObject({ botId: "bot-b", open: false });
  });
});
