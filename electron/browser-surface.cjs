// The built-in browser surface: WebContentsViews driven over the Chrome
// DevTools Protocol that Electron already ships (webContents.debugger), and
// shown inside the app window as the Browser tab of the computer panel.
//
// Why a native view and not a screenshot stream: the view IS the panel. The
// person sees the real page, and taking over is just clicking into it — no
// JPEG plumbing, no VNC, no second Chrome. The renderer only reports where
// the tab's rectangle is; this module owns lifecycle, isolation and input.
//
// Profiles: a bot has one view per profile it has used — its own private
// session, any named shared profile, or a throwaway Guest — and switching
// shows another live view instead of rebuilding one, the way Ferdium and
// pi-desktop do it (Electron cannot move a WebContents between sessions).
// Cold views are evicted least-recently-used so memory stays bounded.
//
// Isolation, per view: a session partition, sandbox on, no preload, every
// permission prompt denied, downloads refused, popups routed back into the
// same view, JavaScript dialogs answered by the surface (never shown as
// native modals), and only http(s) navigations honoured. A bot's browser can
// never reach file://, chrome:// or the app's own origin.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeDesktopWorkspaceBounds } = require("./desktop-workspace.cjs");
const {
  backendNodeIdFromRef,
  browserNavigationAllowed,
  browserNavigationUrl,
  browserPartition,
  browserProfilePartition,
  browserUserAgent,
  formatSnapshot,
  snapshotFromAxNodes,
} = require("./browser-snapshot.cjs");

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const GUEST_PROFILE = "guest";
const MAX_VIEWS = 8;
const SETTLE_MS = 350;
const LOAD_WAIT_MS = 8_000;
const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_QUALITY = 70;
const MAX_TEXT = 4_000;
const MAX_READ_CHARS = 24_000;
const AX_TREE_DEPTH = 24;
/** The page lays out at this size whatever the panel's rectangle is; the
 * compact preview scales it down, the expanded view shows it 1:1. Bots see
 * one consistent desktop viewport regardless of how wide the panel is. */
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** Keys a bot may press by name → CDP key event fields. `text` is what makes
 * Enter/Tab actually fire in inputs; the virtual key code is what makes
 * shortcuts and arrow navigation work in apps that listen at keydown. */
const KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

const SCROLL_DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const INJECTED_BUNDLE = path.join(__dirname, "resources", "browser-snapshot.js");
const SNAPSHOT_MAX_CHARS = 60_000;

/** Playwright's accessibility snapshot, bundled for the page
 * (scripts/build-browser-snapshot.mjs). Missing only in a broken checkout;
 * the surface then falls back to the bare accessibility tree. */
function loadInjectedSource() {
  try {
    return fs.readFileSync(INJECTED_BUNDLE, "utf8");
  } catch {
    return null;
  }
}

function botIdOf(value) {
  const id = String(value ?? "");
  if (!BOT_ID.test(id)) throw new Error("A bot id is required");
  return id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isString = (value) => Object.prototype.toString.call(value) === "[object String]";

/** Page-side helpers, evaluated over CDP. Everything here is plain
 * expressions on the page — nothing is injected persistently. */
const PAGE_TEXT_EXPRESSION = `(() => {
  const text = (document.body && document.body.innerText) || "";
  return text.replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
})()`;
const SCROLL_METRICS_EXPRESSION = `(() => {
  const el = document.scrollingElement || document.documentElement;
  return { top: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), view: Math.round(window.innerHeight) };
})()`;

/**
 * @param {object} options
 * @param {import("electron").BrowserWindow} options.owner the app window that hosts the views
 * @param {(options: object) => import("electron").WebContentsView} options.createView
 * @param {(state: object) => void} [options.notify] renderer-facing state changes
 * @param {NodeJS.Platform} [options.platform]
 * @param {(botId: string) => string} [options.partitionFor] test seam for the per-bot partition
 * @param {number} [options.settleMs]
 * @param {number} [options.maxViews]
 * @param {() => number} [options.now]
 */
function createBrowserSurfaceManager({
  owner,
  createView,
  notify,
  platform = process.platform,
  partitionFor: ownPartitionFor = browserPartition,
  settleMs = SETTLE_MS,
  maxViews = MAX_VIEWS,
  now = () => Date.now(),
  injectedSource = loadInjectedSource(),
}) {
  if (!owner || owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
  if (createView?.constructor !== Function) throw new Error("The browser surface viewer is unavailable");
  const emit = notify?.constructor === Function ? notify : () => {};
  /** every live view, keyed by `${botId}\0${partition}` */
  const entries = new Map();
  /** the view a bot currently shows / acts on */
  const active = new Map();
  let guestCounter = 0;

  const partitionForProfile = (botId, profile) => {
    if (profile === GUEST_PROFILE) return `openmausbot-browser-guest-${botId}-${++guestCounter}`;
    return profile ? browserProfilePartition(profile) : ownPartitionFor(botId);
  };
  const keyOf = (botId, partition) => `${botId}\0${partition}`;

  const closedState = (botId) => ({
    botId,
    open: false,
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: false,
    partition: null,
    profile: null,
    mode: null,
  });

  const stateFor = (entry) => {
    const contents = entry.view.webContents;
    const destroyed = contents.isDestroyed?.() === true;
    const history = destroyed ? null : contents.navigationHistory;
    return {
      botId: entry.botId,
      open: true,
      url: destroyed ? "" : contents.getURL?.() ?? "",
      title: destroyed ? "" : contents.getTitle?.() ?? "",
      loading: destroyed ? false : contents.isLoading?.() === true,
      canGoBack: destroyed ? false : history?.canGoBack?.() ?? contents.canGoBack?.() ?? false,
      canGoForward: destroyed ? false : history?.canGoForward?.() ?? contents.canGoForward?.() ?? false,
      visible: entry.visible,
      partition: entry.partition,
      profile: entry.profile,
      mode: entry.mode,
    };
  };

  const emitState = (entry) => {
    if (active.get(entry.botId) === entry) emit(stateFor(entry));
  };

  const remove = (entry, code) => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    const wasActive = active.get(entry.botId) === entry;
    if (wasActive) active.delete(entry.botId);
    try {
      entry.view.setVisible(false);
    } catch {}
    try {
      owner.contentView.removeChildView(entry.view);
    } catch {}
    try {
      if (entry.attached) entry.view.webContents.debugger.detach();
    } catch {}
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    } catch {}
    if (wasActive) emit({ ...closedState(entry.botId), ...(code ? { code } : {}) });
  };

  /** Make room for one more view: drop the coldest view nobody is showing. */
  const evictIfNeeded = () => {
    if (entries.size < maxViews) return;
    const candidates = [...entries.values()]
      .filter((entry) => active.get(entry.botId) !== entry)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (!victim) throw new Error(`Only ${maxViews} bot browsers can be open at once`);
    remove(victim, "evicted");
  };

  const secure = (entry) => {
    const contents = entry.view.webContents;
    const ses = contents.session;
    try {
      ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    } catch {}
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // A download would land on the user's disk under a bot's control; refuse
    // until there is a reviewed place for it to go.
    ses.on("will-download", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      // target=_blank links stay in this bot's one tab: a second window would
      // escape the panel, the partition guarantees and the person's view.
      if (browserNavigationAllowed(url) && !contents.isDestroyed()) void contents.loadURL(browserNavigationUrl(url));
      return { action: "deny" };
    });
    const guard = (event, target) => {
      if (!browserNavigationAllowed(target)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    for (const signal of ["did-navigate", "did-navigate-in-page", "did-stop-loading", "page-title-updated"]) {
      contents.on(signal, () => emitState(entry));
    }
    contents.on("did-navigate", () => {
      // refs name nodes of the page that just went away
      entry.refs = null;
    });
    contents.on("render-process-gone", () => remove(entry, "renderer-gone"));
    contents.debugger.on("detach", () => {
      entry.attached = false;
    });
    contents.debugger.on("message", (_event, method, params) => {
      onProtocolEvent(entry, method, params ?? {});
    });
  };

  /** Things the page does on its own that a bot must hear about. */
  const onProtocolEvent = (entry, method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      // alert/confirm/prompt would otherwise be a native modal over the app
      // window that nobody can answer for the bot. Accept confirm/beforeunload,
      // give prompts their default, and hand the message to the next result.
      const type = String(params.type ?? "alert");
      entry.dialogs.push({ type, message: String(params.message ?? "").slice(0, 500) });
      void cdp(entry, "Page.handleJavaScriptDialog", {
        accept: true,
        ...(type === "prompt" ? { promptText: String(params.defaultPrompt ?? "") } : {}),
      }).catch(() => {});
    } else if (method === "Page.fileChooserOpened") {
      entry.dialogs.push({ type: "filechooser", message: "the page asked for a file upload; uploads are not supported yet" });
    }
  };

  const create = (botId, profile) => {
    evictIfNeeded();
    if (owner.isDestroyed?.()) throw new Error("The OpenMausBot window is unavailable");
    const partition = partitionForProfile(botId, profile);
    const view = createView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition,
      },
    });
    const entry = {
      key: keyOf(botId, partition),
      botId,
      profile: profile || "",
      partition,
      view,
      attached: false,
      visible: false,
      bounds: null,
      mode: null,
      refs: null,
      refKind: "ax",
      dialogs: [],
      lastUsed: now(),
    };
    entries.set(entry.key, entry);
    secure(entry);
    // A tab nobody is looking at (panel closed, another tab shown) still
    // needs a real viewport: a zero-size view lays the page out as nothing
    // visible, and Playwright's snapshot hands out refs only for visible
    // nodes. Hidden views keep the desktop size until the panel lays them
    // out. Attach first — bounds set before a view has a parent are dropped.
    owner.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
    view.setVisible(false);
    void view.webContents.loadURL("about:blank").catch(() => {});
    return entry;
  };

  /** The view a bot should be looking at: `undefined` keeps whatever is
   * active (callers that don't know the profile never evict a tab); "" is
   * the bot's own session; "guest" a throwaway; anything else a named
   * profile. Switching hides the previous view and shows this one in the
   * same rectangle. */
  const ensure = (rawBotId, profile) => {
    const botId = botIdOf(rawBotId);
    const current = active.get(botId);
    if (profile === undefined) {
      if (current) return touch(current);
      return activate(botId, create(botId, ""), null);
    }
    if (current && current.profile === profile && profile !== GUEST_PROFILE) return touch(current);
    if (current && current.profile === GUEST_PROFILE && profile === GUEST_PROFILE) return touch(current);
    const partition = profile === GUEST_PROFILE ? null : partitionForProfile(botId, profile);
    const existing = partition ? entries.get(keyOf(botId, partition)) : null;
    return activate(botId, existing ?? create(botId, profile), current);
  };

  const touch = (entry) => {
    entry.lastUsed = now();
    return entry;
  };

  const activate = (botId, entry, previous) => {
    const takesOverScreen = Boolean(previous && previous !== entry && previous.visible);
    if (previous && previous !== entry) {
      previous.visible = false;
      try {
        previous.view.setVisible(false);
      } catch {}
      // a Guest session is for one visit: switching away forgets it
      if (previous.profile === GUEST_PROFILE) remove(previous);
      // the new view takes the old one's place on screen
      if (previous.bounds && !entry.bounds) entry.bounds = previous.bounds;
      if (previous.mode && !entry.mode) applyMode(entry, previous.mode);
    }
    active.set(botId, entry);
    touch(entry);
    if (entry.bounds && takesOverScreen) {
      entry.view.setBounds(entry.bounds);
      entry.visible = true;
      entry.view.setVisible(true);
      // raise above siblings that were added later
      try {
        owner.contentView.addChildView(entry.view);
      } catch {}
    }
    emit(stateFor(entry));
    return entry;
  };

  const cdp = async (entry, method, params = {}) => {
    const dbg = entry.view.webContents.debugger;
    if (!entry.attached) {
      dbg.attach("1.3");
      entry.attached = true;
      try {
        await dbg.sendCommand("Page.enable");
        // never show a native file picker for a bot; the event is reported instead
        await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
        // Chromium drops synthetic mouse input for a widget that is not
        // focused — and a child view is not focused while the person types
        // in the chat, or while another app is in front. Playwright makes
        // every page believe it has focus for exactly this reason.
        await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch {
        // an older protocol without these is still usable for input
      }
    }
    return dbg.sendCommand(method, params);
  };

  /** Fit the fixed desktop viewport into the rectangle the panel gave us:
   * scaled down for the compact preview, 1:1 when expanded. */
  const applyMode = (entry, mode) => {
    const contents = entry.view.webContents;
    entry.mode = mode;
    if (mode === "compact" && entry.bounds) {
      const scale = Math.min(entry.bounds.width / VIEWPORT.width, entry.bounds.height / VIEWPORT.height);
      try {
        contents.enableDeviceEmulation({
          screenPosition: "desktop",
          screenSize: { ...VIEWPORT },
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 0,
          viewSize: { ...VIEWPORT },
          scale: Math.max(0.1, Math.min(1, scale)),
        });
      } catch {}
    } else {
      try {
        contents.disableDeviceEmulation();
      } catch {}
    }
  };

  /** Wait for the page to be idle enough to observe: a short settle, and if a
   * navigation is in flight, its end (bounded — a page that never stops
   * loading must not hang the bot). */
  const settle = async (entry, ms = settleMs) => {
    await sleep(ms);
    const contents = entry.view.webContents;
    if (!contents.isLoading?.()) return;
    await Promise.race([
      new Promise((resolve) => contents.once("did-stop-loading", resolve)),
      sleep(LOAD_WAIT_MS),
    ]);
  };

  const evaluate = async (entry, expression) => {
    const { result, exceptionDetails } = await cdp(entry, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "page script failed");
    return result?.value;
  };

  const scrollHint = async (entry) => {
    try {
      const metrics = await evaluate(entry, SCROLL_METRICS_EXPRESSION);
      if (!metrics || !Number.isFinite(metrics.height)) return null;
      const below = metrics.height - metrics.top - metrics.view;
      const above = metrics.top;
      if (below <= 8 && above <= 8) return null;
      const parts = [];
      if (above > 8) parts.push(`${Math.round(above)}px above`);
      if (below > 8) parts.push(`${Math.round(below)}px below`);
      return `More of the page is off-screen: ${parts.join(", ")} (browser_scroll to see it).`;
    } catch {
      return null;
    }
  };

  /** Make sure the page carries our snapshot script (a fresh document loses
   * it). False when the bundle is missing or the page refuses scripts. */
  const ensureInjected = async (entry) => {
    if (!injectedSource) return false;
    try {
      if ((await evaluate(entry, "Boolean(window.__ombBrowser)")) === true) return true;
      await cdp(entry, "Runtime.evaluate", { expression: injectedSource, returnByValue: true });
      return (await evaluate(entry, "Boolean(window.__ombBrowser)")) === true;
    } catch {
      return false;
    }
  };

  /** Playwright's ARIA snapshot with `[ref=eN]` refs — what models were
   * trained to read. Falls back to the bare accessibility tree (`bN` refs)
   * when the script cannot run. */
  const snapshot = async (entry) => {
    const state = stateFor(entry);
    let elements = [];
    let yaml = null;
    let truncated = false;
    if (await ensureInjected(entry)) {
      try {
        const result = await evaluate(entry, `window.__ombBrowser.snapshot(${SNAPSHOT_MAX_CHARS})`);
        if (result && isString(result.yaml) && Array.isArray(result.refs)) {
          yaml = result.yaml;
          truncated = result.truncated === true;
          entry.refs = new Set(result.refs.map(String));
          entry.refKind = "aria";
        }
      } catch {
        yaml = null;
      }
    }
    if (yaml === null) {
      await cdp(entry, "Accessibility.enable");
      const { nodes = [] } = await cdp(entry, "Accessibility.getFullAXTree", { depth: AX_TREE_DEPTH });
      elements = snapshotFromAxNodes(nodes);
      entry.refs = new Set(elements.map((element) => element.ref));
      entry.refKind = "ax";
    }
    const dialogs = entry.dialogs.splice(0);
    const hint = await scrollHint(entry);
    const notes = [
      ...dialogs.map((dialog) => `Dialog (${dialog.type}) was answered automatically: ${JSON.stringify(dialog.message)}`),
      ...(hint ? [hint] : []),
    ];
    const body = yaml !== null ? yaml || "(empty page)" : formatSnapshot({ title: state.title, url: state.url, elements });
    return {
      url: state.url,
      title: state.title,
      elements,
      yaml,
      truncated,
      dialogs,
      notes,
      text: [yaml !== null ? `Browser — ${state.title || "Untitled"}: ${state.url || "about:blank"}` : "", body, ...notes].filter(Boolean).join("\n"),
    };
  };

  const observe = async (entry) => {
    await settle(entry);
    return snapshot(entry);
  };

  /** Where a ref is, in viewport CSS pixels — plus what the two ref kinds
   * need to act on it: the DOM node id (accessibility refs) or nothing more
   * (Playwright refs resolve in the page). */
  const centerOf = async (entry, ref) => {
    const wanted = String(ref ?? "").trim();
    if (!entry.refs) throw new Error("the page changed since the last browser_snapshot — take a new one");
    if (!entry.refs.has(wanted)) throw new Error("that browser ref is stale or unknown — take a new browser_snapshot");
    if (entry.refKind === "aria") {
      const box = await evaluate(entry, `window.__ombBrowser ? window.__ombBrowser.boxForRef(${JSON.stringify(wanted)}) : { found: false }`);
      if (!box || box.found !== true) throw new Error("that browser ref is stale or unknown — take a new browser_snapshot");
      if (box.connected !== true) throw new Error("that element is gone; take a new browser_snapshot");
      if (box.visible !== true) throw new Error("that element is not visible; take a new browser_snapshot");
      return { ref: wanted, x: box.x, y: box.y };
    }
    const backendNodeId = backendNodeIdFromRef(wanted);
    try {
      await cdp(entry, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      // not every node can be scrolled into view; the box model is the real check
    }
    let model;
    try {
      ({ model } = await cdp(entry, "DOM.getBoxModel", { backendNodeId }));
    } catch {
      throw new Error("that element is gone; take a new browser_snapshot");
    }
    const quad = model?.border ?? model?.content;
    if (!Array.isArray(quad) || quad.length < 8) throw new Error("that element is not visible; take a new browser_snapshot");
    return {
      backendNodeId,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  };

  const viewportCenter = () => ({ x: Math.floor(VIEWPORT.width / 2), y: Math.floor(VIEWPORT.height / 2) });

  const selectAllModifiers = platform === "darwin" ? 4 : 2;

  const api = {
    /** Create or switch the bot's view; hidden until laid out. */
    ensure(botId, profile) {
      return stateFor(ensure(botId, profile));
    },

    state(botId) {
      const entry = active.get(botIdOf(botId));
      return entry ? stateFor(entry) : closedState(botIdOf(botId));
    },

    /** Position the bot's active view over the renderer's rectangle (or hide
     * it: null). `profile` switches views; `mode` picks the scaling. */
    layout(botId, bounds, profile, mode) {
      if (bounds === null || bounds === undefined) {
        const entry = active.get(botIdOf(botId));
        if (!entry) return closedState(botIdOf(botId));
        entry.visible = false;
        entry.view.setVisible(false);
        return stateFor(entry);
      }
      const entry = ensure(botId, profile);
      const normalized = normalizeDesktopWorkspaceBounds(bounds, owner.getContentSize());
      entry.bounds = normalized;
      entry.view.setBounds(normalized);
      applyMode(entry, mode === "expanded" ? "expanded" : "compact");
      entry.visible = true;
      entry.view.setVisible(true);
      return stateFor(entry);
    },

    async navigate(botId, rawUrl, profile) {
      const entry = ensure(botId, profile);
      const url = browserNavigationUrl(rawUrl);
      try {
        await entry.view.webContents.loadURL(url);
      } catch (error) {
        // ERR_ABORTED (-3) is a redirect or an in-page replacement, not a failure
        if (error?.errno !== -3 && error?.code !== "ERR_ABORTED") {
          throw new Error(`could not open ${url}: ${error?.message ?? error}`);
        }
      }
      return observe(entry);
    },

    async back(botId, profile) {
      const entry = ensure(botId, profile);
      const contents = entry.view.webContents;
      const canGoBack = contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack?.();
      if (!canGoBack) throw new Error("there is no previous page");
      if (contents.navigationHistory?.goBack) contents.navigationHistory.goBack();
      else contents.goBack();
      return observe(entry);
    },

    async forward(botId, profile) {
      const entry = ensure(botId, profile);
      const contents = entry.view.webContents;
      const canGoForward = contents.navigationHistory?.canGoForward?.() ?? contents.canGoForward?.();
      if (!canGoForward) throw new Error("there is no next page");
      if (contents.navigationHistory?.goForward) contents.navigationHistory.goForward();
      else contents.goForward();
      return observe(entry);
    },

    async snapshot(botId, profile) {
      const entry = ensure(botId, profile);
      await settle(entry, 0);
      return snapshot(entry);
    },

    async click(botId, ref, { button = "left", clickCount = 1, profile } = {}) {
      const entry = ensure(botId, profile);
      const { x, y } = await centerOf(entry, ref);
      const which = button === "right" ? "right" : button === "middle" ? "middle" : "left";
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: which, clickCount });
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: which, clickCount });
      return observe(entry);
    },

    async hover(botId, ref, profile) {
      const entry = ensure(botId, profile);
      const { x, y } = await centerOf(entry, ref);
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return observe(entry);
    },

    async drag(botId, fromRef, toRef, profile) {
      const entry = ensure(botId, profile);
      const from = await centerOf(entry, fromRef);
      const to = await centerOf(entry, toRef);
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      // a few intermediate moves so drag-and-drop libraries see a gesture
      for (const step of [0.25, 0.5, 0.75, 1]) {
        await cdp(entry, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + (to.x - from.x) * step,
          y: from.y + (to.y - from.y) * step,
          button: "left",
        });
      }
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
      return observe(entry);
    },

    async fill(botId, ref, text, profile) {
      const entry = ensure(botId, profile);
      const value = String(text ?? "");
      if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
      const target = await centerOf(entry, ref);
      if (entry.refKind === "aria") {
        const focused = await evaluate(entry, `window.__ombBrowser.focusRef(${JSON.stringify(target.ref)})`);
        if (focused !== true) throw new Error("that element cannot take keyboard focus; click it first or pick a text field");
      } else {
        await cdp(entry, "DOM.focus", { backendNodeId: target.backendNodeId });
      }
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: selectAllModifiers });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyDown", ...KEYS.backspace });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", ...KEYS.backspace });
      if (value) await cdp(entry, "Input.insertText", { text: value });
      return observe(entry);
    },

    async type(botId, text, profile) {
      const entry = ensure(botId, profile);
      const value = String(text ?? "");
      if (!value) throw new Error("text is required");
      if (value.length > MAX_TEXT) throw new Error(`text is limited to ${MAX_TEXT} characters`);
      await cdp(entry, "Input.insertText", { text: value });
      return observe(entry);
    },

    async press(botId, rawKey, profile) {
      const entry = ensure(botId, profile);
      const key = KEYS[String(rawKey ?? "").toLowerCase().replace(/[\s_-]/g, "")];
      if (!key) throw new Error(`unsupported key; use one of ${Object.keys(KEYS).join(", ")}`);
      await cdp(entry, "Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...key });
      await cdp(entry, "Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
      return observe(entry);
    },

    async scroll(botId, rawDirection, amount, profile) {
      const entry = ensure(botId, profile);
      const direction = SCROLL_DIRECTIONS[String(rawDirection ?? "down").toLowerCase()];
      if (!direction) throw new Error("direction must be up, down, left, or right");
      const pixels = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Math.min(Number(amount), 5_000) : 600;
      const { x, y } = viewportCenter();
      await cdp(entry, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: direction[0] * pixels, deltaY: direction[1] * pixels });
      return observe(entry);
    },

    /** Choose options in a <select> by value or visible label. */
    async select(botId, ref, rawValues, profile) {
      const entry = ensure(botId, profile);
      const values = (Array.isArray(rawValues) ? rawValues : [rawValues]).map((value) => String(value ?? "")).filter(Boolean);
      if (!values.length) throw new Error("at least one option value or label is required");
      const target = await centerOf(entry, ref);
      let objectId;
      if (entry.refKind === "aria") {
        const { result: handle } = await cdp(entry, "Runtime.evaluate", {
          expression: `window.__ombBrowser.elementForRef(${JSON.stringify(target.ref)})`,
          returnByValue: false,
        });
        objectId = handle?.objectId;
      } else {
        const { object } = await cdp(entry, "DOM.resolveNode", { backendNodeId: target.backendNodeId });
        objectId = object?.objectId;
      }
      if (!objectId) throw new Error("that element is gone; take a new browser_snapshot");
      const { result, exceptionDetails } = await cdp(entry, "Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        arguments: [{ value: values }],
        functionDeclaration: `function (wanted) {
          const select = this.tagName === "SELECT" ? this : this.closest && this.closest("select");
          if (!select) return { error: "that ref is not a select field" };
          const options = [...select.options];
          const chosen = [];
          for (const option of options) {
            const hit = wanted.includes(option.value) || wanted.includes(option.textContent.trim());
            if (!select.multiple && chosen.length) { option.selected = false; continue; }
            option.selected = hit;
            if (hit) chosen.push(option.textContent.trim());
          }
          if (!chosen.length) return { error: "no option matched: " + options.map((o) => o.textContent.trim()).slice(0, 30).join(" | ") };
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return { chosen };
        }`,
      });
      if (exceptionDetails) throw new Error("could not change that select field");
      if (result?.value?.error) throw new Error(result.value.error);
      return observe(entry);
    },

    /** Wait until text appears, the address contains something, or the page
     * simply settles — bounded, so a bot never hangs on a page that stalls. */
    async waitFor(botId, { text, url, timeoutMs } = {}, profile) {
      const entry = ensure(botId, profile);
      const deadline = now() + Math.min(Math.max(Number(timeoutMs) || WAIT_DEFAULT_MS, WAIT_POLL_MS), WAIT_MAX_MS);
      const wantText = isString(text) && text.trim() ? text.trim() : null;
      const wantUrl = isString(url) && url.trim() ? url.trim() : null;
      if (!wantText && !wantUrl) {
        await settle(entry);
        return snapshot(entry);
      }
      for (;;) {
        const current = entry.view.webContents.getURL?.() ?? "";
        let hit = wantUrl ? current.includes(wantUrl) : true;
        if (hit && wantText) {
          try {
            const pageText = await evaluate(entry, PAGE_TEXT_EXPRESSION);
            hit = String(pageText ?? "").includes(wantText);
          } catch {
            hit = false;
          }
        }
        if (hit) return observe(entry);
        if (now() >= deadline) {
          throw new Error(
            `timed out waiting for ${[wantText ? `text ${JSON.stringify(wantText)}` : "", wantUrl ? `url containing ${JSON.stringify(wantUrl)}` : ""].filter(Boolean).join(" and ")}`,
          );
        }
        await sleep(WAIT_POLL_MS);
      }
    },

    /** The page's readable text — for reading, not for acting. */
    async read(botId, profile) {
      const entry = ensure(botId, profile);
      await settle(entry, 0);
      const text = String((await evaluate(entry, PAGE_TEXT_EXPRESSION)) ?? "");
      const state = stateFor(entry);
      return {
        url: state.url,
        title: state.title,
        text: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated at ${MAX_READ_CHARS} characters)` : text,
        truncated: text.length > MAX_READ_CHARS,
      };
    },

    /** JPEG of the page at the fixed viewport, downscaled for the model. */
    async screenshot(botId, profile) {
      const entry = ensure(botId, profile);
      let buffer = null;
      try {
        const shot = await cdp(entry, "Page.captureScreenshot", {
          format: "jpeg",
          quality: SCREENSHOT_QUALITY,
          clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: SCREENSHOT_WIDTH / VIEWPORT.width },
        });
        if (shot?.data) buffer = Buffer.from(shot.data, "base64");
      } catch {
        buffer = null;
      }
      if (buffer) {
        return { png: buffer.toString("base64"), format: "jpeg", width: SCREENSHOT_WIDTH, height: Math.round((VIEWPORT.height * SCREENSHOT_WIDTH) / VIEWPORT.width) };
      }
      const image = await entry.view.webContents.capturePage();
      const size = image.getSize();
      const scaled = size.width > SCREENSHOT_WIDTH ? image.resize({ width: SCREENSHOT_WIDTH }) : image;
      return { png: scaled.toJPEG(SCREENSHOT_QUALITY).toString("base64"), format: "jpeg", width: scaled.getSize().width, height: scaled.getSize().height };
    },

    /** Drop every bot's view on a named profile — before its data is cleared. */
    forgetProfile(profileId) {
      const wanted = String(profileId ?? "");
      if (!wanted || wanted === GUEST_PROFILE) return 0;
      let dropped = 0;
      for (const entry of [...entries.values()]) {
        if (entry.profile === wanted) {
          remove(entry, "profile-deleted");
          dropped += 1;
        }
      }
      return dropped;
    },

    /** Drop every view a bot has (all profiles). */
    close(botId) {
      const id = botIdOf(botId);
      for (const entry of [...entries.values()]) if (entry.botId === id) remove(entry);
      return true;
    },

    closeAll() {
      for (const entry of [...entries.values()]) remove(entry);
    },

    hideAll() {
      for (const entry of entries.values()) {
        entry.visible = false;
        try {
          entry.view.setVisible(false);
        } catch {}
      }
    },

    size() {
      return entries.size;
    },

    /** Which views exist — for the panel's profile picker and diagnostics. */
    list() {
      return [...entries.values()].map((entry) => ({
        botId: entry.botId,
        profile: entry.profile,
        partition: entry.partition,
        active: active.get(entry.botId) === entry,
        visible: entry.visible,
        url: entry.view.webContents.isDestroyed?.() ? "" : entry.view.webContents.getURL?.() ?? "",
      }));
    },
  };
  return api;
}

module.exports = { GUEST_PROFILE, KEYS, MAX_VIEWS, VIEWPORT, createBrowserSurfaceManager };
