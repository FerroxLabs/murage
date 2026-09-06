import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationPreferences } from "../../shared/notification-preferences";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-notification-settings-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/notification-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "notification-settings-fixture",
      resolveId(id) { if (id === "/__notifications.js") return "\0notification-settings"; if (id === "/notification-fixture-store") return "\0notification-store"; },
      load(id) {
        if (id === "\0notification-store") return "import React from 'react';export async function api(path,init){const r=await fetch(path,init);const value=await r.json();if(!r.ok)throw new Error(value.error);return value;}export function useStore(){const [config,setConfig]=React.useState(window.fixtureConfig);return {state:{config},dispatch:action=>setConfig(action.config)}}";
        if (id !== "\0notification-settings") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {NotificationSettings} from '/src/components/NotificationSettings.tsx';import '/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';window.fixtureConfig=await (await fetch('/api/config')).json();createRoot(document.getElementById('root')).render(React.createElement(NotificationSettings));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__notifications?") && req.url !== "/__notifications") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:620px;margin:16px auto"></main><script type="module" src="/__notifications.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });
const base: NotificationPreferences = { attention: true, completion: true, failures: true, previewContent: true };
async function notificationAPI(page: Page) {
  await page.addInitScript(() => {
    (window as any).permissionCalls = 0;
    const requested = new URLSearchParams(location.search).get("permission") ?? "default";
    Object.defineProperty(window, "Notification", { configurable: true, value: requested === "unavailable" ? undefined : class {
      static permission = requested;
      static async requestPermission() { (window as any).permissionCalls++; this.permission = "granted"; return "granted"; }
    } });
  });
}

test("explicit save and reload retain false preferences and the stored quiet-hour time zone", async ({ page }) => {
  await notificationAPI(page);
  let notifications: NotificationPreferences = { attention: false, completion: false, failures: true, previewContent: false, quietHours: { enabled: false, start: "23:00", end: "07:00", timeZone: "Europe/London" } };
  const writes: any[] = [];
  let release: (() => void) | undefined;
  await page.route("**/api/config", async route => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      await new Promise<void>(resolve => { release = resolve; });
      notifications = writes.at(-1).notifications;
    }
    return route.fulfill({ json: { notifications } });
  });
  await page.goto(origin + "/__notifications");
  await expect(page.getByRole("checkbox", { name: /^Task completed/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Show notification previews/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /^Needs your attention/ }).check();
  await page.getByRole("checkbox", { name: "Quiet hours", exact: true }).check();
  await expect(page.getByLabel("Quiet hours time zone")).toHaveValue("Europe/London");
  expect(writes).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).permissionCalls)).toBe(0);
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByRole("status")).toContainText("Notification preferences saved");
  expect(writes[0]).toEqual({ notifications: { attention: true, completion: false, failures: true, previewContent: false, quietHours: { enabled: true, start: "23:00", end: "07:00", timeZone: "Europe/London" } } });
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /^Task completed/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Show notification previews/ })).not.toBeChecked();
  await expect(page.getByLabel("Quiet hours time zone")).toHaveValue("Europe/London");
  await expect(page.getByRole("button", { name: "Save notifications" })).toBeDisabled();
});

test("quiet hours validate before writing and failed saves preserve edits without claiming success", async ({ page }) => {
  await notificationAPI(page);
  let writes = 0, fail = true;
  await page.route("**/api/config", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { notifications: base } });
    writes++;
    if (fail) return route.fulfill({ status: 503, json: { error: "fixture persistence failure" } });
    return route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.goto(origin + "/__notifications");
  await expect(page.getByLabel("Quiet hours time zone")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Quiet hours", exact: true }).check();
  await expect(page.getByLabel("Quiet hours time zone")).toHaveValue("Asia/Bangkok");
  await page.getByLabel("Quiet hours end").fill("22:00");
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("alert")).toContainText("different start and end");
  expect(writes).toBe(0);
  await page.getByLabel("Quiet hours end").fill("08:00");
  await page.getByLabel("Quiet hours time zone").fill("Invalid/Zone");
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("alert")).toContainText("valid named time zone");
  expect(writes).toBe(0);
  await page.getByLabel("Quiet hours time zone").fill("Asia/Bangkok");
  await page.getByRole("checkbox", { name: /^Show notification previews/ }).uncheck();
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("alert")).toContainText("Your edits are still here");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^Show notification previews/ })).not.toBeChecked();
  await expect(page.getByText(/Clicking still opens the right conversation/)).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Save notifications" }).click();
  await expect(page.getByRole("status")).toContainText("Notification preferences saved");
});

test("permission is requested only after a settings click and unavailable or denied permission is explained", async ({ page }) => {
  await notificationAPI(page);
  await page.route("**/api/config", route => route.fulfill({ json: { notifications: base } }));
  await page.goto(origin + "/__notifications");
  await expect(page.getByRole("button", { name: "Request notification permission" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).permissionCalls)).toBe(0);
  await page.getByRole("button", { name: "Request notification permission" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Notification permission is granted/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).permissionCalls)).toBe(1);
  await page.goto(origin + "/__notifications?permission=denied");
  await expect(page.getByText(/Notification permission is blocked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request notification permission" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).permissionCalls)).toBe(0);
  await page.goto(origin + "/__notifications?permission=unavailable");
  await expect(page.getByText(/permission controls are unavailable/)).toBeVisible();
});

for (const skin of ["light", "dark"]) test("mobile " + skin + " privacy and quiet-hour controls remain readable", async ({ page }, info) => {
  await notificationAPI(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/config", route => route.fulfill({ json: { notifications: { ...base, previewContent: false, quietHours: { enabled: true, start: "22:00", end: "08:00", timeZone: "Asia/Bangkok" } } } }));
  await page.goto(origin + "/__notifications?skin=" + skin + "&permission=denied");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByText(/Tasks and approval cards stay active/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("notification-settings-" + skin + "-mobile.png"), fullPage: true });
});
