// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DICTATION-LIFECYCLE-1018 section 5 D, in real Chromium with the production CSS: the stop control for composer
// dictation is VISIBLE and ACTIVATED (pointer and keyboard) wherever the OS recognizer may still be running.
//   - the strip, in the Composer, during an approval takeover;
//   - the app bar, inside an open Settings window layer and inside a nested modal <dialog> (which makes everything
//     outside it inert), reachable by Tab and Enter;
//   - the app bar after the owner Composer is gone (navigating to Health).
// The REAL Composer, dictation store and runner, DictationStatusBar, LazyOverlay window layer and native dialog layer
// are mounted; only the store, the capability probe, the approval panel and the native bridge are fakes (as in
// call-host.human.spec.ts). The fake recognizer's stop is held until the test settles it.
import { test, expect, type Page, type Locator } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;

const BRIDGE = `
window.__calls = { start: [], finish: [], stop: [] };
window.__stops = [];
const T = new Set(), E = new Set();
window.muragebox = {
  desktopSurfaceSecret: "fixture-surface-secret",
  speechStart: async (options) => { window.__calls.start.push(options.session); },
  speechFinish: async (session) => { window.__calls.finish.push(session); },
  // held: the test settles each stop
  speechStop: (session) => { window.__calls.stop.push(session); return new Promise((resolve, reject) => window.__stops.push({ resolve, reject })); },
  onDictationTranscript: (fn) => { T.add(fn); return () => T.delete(fn); },
  onDictationEnd: (fn) => { E.add(fn); return () => E.delete(fn); },
  onSpeechTranscript: () => () => {},
  onSpeechEnd: () => () => {},
};
window.__say = (text, partial = true) => { for (const fn of [...T]) fn({ text, partial, session: window.__calls.start.at(-1) }); };
window.__end = (info) => { for (const fn of [...E]) fn({ ...info, session: window.__calls.start.at(-1) }); };
window.__settleStop = (index, how) => { const stop = window.__stops[index]; how === "reject" ? stop.reject(new Error("refused")) : stop.resolve(); };
`;

const STORE = `
import { initialState } from "/src/state/store.tsx";
export * from "/src/state/store.tsx";
const STATE = { ...initialState, instances: [], bots: [] };
const noop = () => {};
export const useStore = () => ({ state: STATE, dispatch: noop, refreshAfterKey: noop });
export const api = async () => ({});
`;

const ENTRY = `
import React from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "/src/components/Composer.tsx";
import { DictationStatusBar } from "/src/components/DictationStatusBar.tsx";
import { LazyOverlay } from "/src/components/LazyOverlay.tsx";
import { useLayerContainer } from "/src/components/LayerSlot.tsx";
import { LayerSurface } from "/src/components/LayerSurface.tsx";
import { useNativeDialogLayer } from "/src/lib/native-dialog-layer.ts";
import "/src/styles.css";
const h = React.createElement;
const APPROVAL = { id: "m-approval", parentId: null, role: "bot", kind: "options", text: "", at: 1, card: { requestId: "r1", tool: "Bash", subtitle: "ls", options: [] } };
const BOT = { id: "bot-1", name: "Sable", color: "green", busy: false, threadId: "thread-1", messages: [], modelSelection: { instanceId: "inst-1" } };

function SettingsWindow() {
  const ref = React.useRef(null);
  useLayerContainer(ref, { onEscape: () => window.__ui.setSettings(false) });
  return h(LayerSurface, null,
    h("div", { ref, role: "dialog", "aria-modal": "true", "aria-label": "Settings", tabIndex: -1, className: "fixed inset-8 z-40 rounded-2xl border border-hairline bg-raised p-6 text-ink" },
      h("h2", null, "Settings"),
      h("button", { id: "open-nested", onClick: () => window.__ui.setDialog(true) }, "Open nested dialog"),
      h("button", { id: "close-settings", onClick: () => window.__ui.setSettings(false) }, "Close settings")));
}
function Nested() {
  const ref = React.useRef(null);
  const layer = useNativeDialogLayer(ref, { name: "fixture-dialog" });
  React.useEffect(() => { layer.show(); }, []);
  return h("dialog", { ref, "aria-label": "Nested", onClose: () => window.__ui.setDialog(false), className: "rounded-xl bg-raised p-6 text-ink" },
    h("p", null, "A nested modal dialog"),
    h("button", { id: "close-nested", onClick: () => layer.dismiss(() => window.__ui.setDialog(false)) }, "Close nested"));
}
function Fixture() {
  const [view, setView] = React.useState("chat");
  const [settings, setSettings] = React.useState(false);
  const [dialog, setDialog] = React.useState(false);
  const [bot, setBot] = React.useState(BOT);
  window.__ui = { setView, setSettings, setDialog, approve: () => setBot((b) => ({ ...b, messages: [APPROVAL] })) };
  return h(React.Fragment, null,
    h("main", { className: "flex h-screen flex-col justify-end bg-app text-ink" },
      view === "chat" ? h(Composer, { key: bot.threadId, bot }) : h("div", { "data-testid": "health" }, "Health")),
    settings && h(LazyOverlay, { name: "settings", kind: "window", covers: "always", opener: null, onDismiss: () => setSettings(false), onRetry: () => {} }, h(SettingsWindow)),
    dialog && h(Nested),
    h(DictationStatusBar));
}
createRoot(document.getElementById("root")).render(h(Fixture));
`;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-composer-dictation-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] },
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "composer-dictation-fixture", enforce: "pre",
      resolveId(id, importer) {
        if (id === "@/state/store" || id.endsWith("/src/state/store")) return "\0dict-store";
        if (id === "@/components/DesktopCapabilities" || id === "./DesktopCapabilities" || id.endsWith("/src/components/DesktopCapabilities")) return "\0dict-caps";
        if (id === "./PendingApprovalQueue" && importer?.includes("/Composer")) return "\0dict-queue";
        if (id === "./PushToTalk" && importer?.includes("/Composer")) return "\0dict-ptt";
        if (id === "/__dict.js") return "\0dict-entry";
      },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id === "\0dict-store") return STORE;
        if (id === "\0dict-caps") return `export * from "/src/components/DesktopCapabilities.tsx"; export const useDesktopCapabilities=()=>({ready:true,capabilities:{dictation:{available:true},host:{platform:"darwin"}}});`;
        if (id === "\0dict-queue") return `import React from "react"; export const PendingApprovalQueue=()=>React.createElement("div",{"data-testid":"approval-panel"},"A bot is waiting for your answer");`;
        if (id === "\0dict-ptt") return `export const PushToTalk=()=>null; export const browserPushToTalkFacts=()=>({});`;
        if (id === "\0dict-entry") return ENTRY;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__dict") return next();
          res.setHeader("content-type", "text/html");
          res.end(`<div id="root"></div><script>${BRIDGE}</script><script type="module" src="/__dict.js"></script>`);
        });
      },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const stopCount = (page: Page) => page.evaluate(() => (window as unknown as { __calls: { stop: string[] } }).__calls.stop.length);
const call = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([name, rest]) => (window as unknown as Record<string, (...a: unknown[]) => unknown>)[name as string](...(rest as unknown[])), [fn, args] as const);
const ui = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([name, rest]) => ((window as unknown as { __ui: Record<string, (...a: unknown[]) => unknown> }).__ui)[name as string](...(rest as unknown[])), [fn, args] as const);

async function openPage(page: Page) {
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto(`${origin}/__dict`);
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
}
/** Listening with a few words in the box. */
async function listening(page: Page) {
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: { start: string[] } }).__calls.start.length)).toBe(1);
  await call(page, "__say", "hello from the microphone");
  await expect(page.locator("textarea")).toHaveValue("hello from the microphone");
  await expect(page.getByRole("button", { name: "Stop dictation" })).toBeVisible();
}
/** The recognizer finished its last line; the real stop is out and held. */
async function finalLine(page: Page) {
  await call(page, "__end", { code: 0, reason: "completed" });
  await expect.poll(() => stopCount(page)).toBe(1);
}
const control = (page: Page) => page.locator("[data-dictation-control]");
/** The failed control, reached from the first (refused) stop. */
async function failed(page: Page) {
  await call(page, "__settleStop", 0, "reject");
  await expect(control(page)).toBeVisible();
  await expect(control(page)).toContainText("Dictation did not stop, so the microphone may still be on.");
  await expect(control(page).getByRole("button", { name: "Stop again" })).toBeVisible();
}
/** Tab until the focused element is `target` (a layer's own focus scope keeps Tab inside it). */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the control");
}
async function finishRetry(page: Page) {
  await expect.poll(() => stopCount(page)).toBe(2);
  await call(page, "__settleStop", 1, "resolve");
  await expect(control(page)).toHaveCount(0);
}

test.describe("the strip, during an approval takeover", () => {
  for (const how of ["pointer", "keyboard"] as const) {
    test(`is visible and activated by ${how}`, async ({ page }) => {
      await openPage(page);
      await listening(page);
      await ui(page, "approve");
      await expect(page.getByTestId("approval-panel")).toBeVisible();
      // the takeover finishes dictation (words kept) and exactly one stop control is drawn
      await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: { finish: string[] } }).__calls.finish.length)).toBe(1);
      await expect(control(page)).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveCount(1);
      await finalLine(page);
      await failed(page);
      const again = control(page).getByRole("button", { name: "Stop again" });
      if (how === "pointer") {
        await again.click();
      } else {
        await tabTo(page, again);
        await page.keyboard.press("Enter");
      }
      await finishRetry(page);
      await expect(page.locator("textarea")).toHaveValue("hello from the microphone");
    });
  }
});

test.describe("the app bar", () => {
  test("is visible inside an open Settings layer and is activated by pointer", async ({ page }) => {
    await openPage(page);
    await listening(page);
    await ui(page, "setSettings", true);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: { finish: string[] } }).__calls.finish.length)).toBe(1);
    await finalLine(page);
    await failed(page);
    await expect(settings.locator("[data-dictation-control]")).toHaveCount(1);
    await settings.getByRole("button", { name: "Stop again" }).click();
    await finishRetry(page);
  });

  test("is reached by Tab and activated by Enter inside an open Settings layer", async ({ page }) => {
    await openPage(page);
    await listening(page);
    await ui(page, "setSettings", true);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await finalLine(page);
    await failed(page);
    const again = settings.getByRole("button", { name: "Stop again" });
    await tabTo(page, again);
    await page.keyboard.press("Enter");
    await finishRetry(page);
  });

  test("is visible and activated by pointer inside a nested modal dialog", async ({ page }) => {
    await openPage(page);
    await listening(page);
    await ui(page, "setSettings", true);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Open nested dialog" }).click();
    const nested = page.locator("dialog[open]");
    await expect(nested).toBeVisible();
    await finalLine(page);
    await failed(page);
    // a modal dialog makes everything outside it inert: the control is inside it, so a pointer can use it
    await expect(nested.locator("[data-dictation-control]")).toHaveCount(1);
    await nested.getByRole("button", { name: "Stop again" }).click();
    await finishRetry(page);
  });

  test("is reached by Tab and activated by Enter inside a nested modal dialog", async ({ page }) => {
    await openPage(page);
    await listening(page);
    await ui(page, "setSettings", true);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.getByRole("button", { name: "Open nested dialog" }).click();
    const nested = page.locator("dialog[open]");
    await expect(nested).toBeVisible();
    await finalLine(page);
    await failed(page);
    const again = nested.getByRole("button", { name: "Stop again" });
    await tabTo(page, again);
    await page.keyboard.press("Enter");
    await finishRetry(page);
  });

  test("is visible after navigating to Health, while stopping and while failed", async ({ page }) => {
    await openPage(page);
    await listening(page);
    await ui(page, "setView", "health");
    await expect(page.getByTestId("health")).toBeVisible();
    // the owner Composer is gone: its unmount asked for the stop, and the bar carries the control
    await expect.poll(() => stopCount(page)).toBe(1);
    await expect(control(page)).toBeVisible();
    await expect(control(page)).toContainText("Stopping dictation");
    await failed(page);
    await control(page).getByRole("button", { name: "Stop again" }).click();
    await finishRetry(page);
  });
});
