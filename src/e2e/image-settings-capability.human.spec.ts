// IMGSET1: Settings → Tools & Connections → Image generation states the
// selected model's real capability, driven in the real renderer against a
// real isolated harness (server/index.ts with its own data dir and HOME).
//
// The user smoke (feature 6) saw the capability line at run13 and not at
// run15. Nothing on the image-settings path changed between those HEADs; the
// smoke fixture did: it stopped seeding a Flux Router key ("No FluxRouter key
// at start", for the connected-apps lock). A keyless install has no image
// connection, so the only truthful screen is the "No supported image
// connections" message. This spec pins all three states a person can reach:
//   1. keyless: no connection, and no capability is claimed;
//   2. a Flux Router key added in Settings → Models: creates images only,
//      with the server's reason editing is unavailable;
//   3. an OpenAI image key: creates and edits, with the shared reference cap,
//      and switching connections switches the statement.
// No request leaves the machine: the suite preload answers the OpenAI image
// origin, and a spec-local preload fails every Flux Router request offline.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA_DIR = (() => {
  const raw = process.env.MURAGE_E2E_DATA_DIR;
  if (!raw) throw new Error("MURAGE_E2E_DATA_DIR is required — this spec never uses ~/.murage");
  const dir = resolve(raw, "image-settings-capability-data");
  if (dir.startsWith(resolve(join(homedir(), ".murage")))) throw new Error(`refusing the real data dir ${dir}`);
  return dir;
})();
const HARNESS_PORT = Number(process.env.MURAGE_E2E_PORT || 9540);
const UI_PORT = Number(process.env.MURAGE_E2E_UI_PORT || 9542);
const HARNESS_URL = `http://127.0.0.1:${HARNESS_PORT}`;
const EVIDENCE = process.env.MURAGE_IMGSET_EVIDENCE_DIR || join(DATA_DIR, "evidence");
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");
/** Every line ImageSettings can state for a selected model (src/locales/en.json imageSettings.model.*). */
const CAPABILITY = /Creates and edits images\.|Creates images only\.|Editing is unavailable with this model\.|This model cannot generate images here\./;

let harness: ChildProcess | undefined, vite: ViteDevServer | undefined, origin = "", logPath = "";
let headers: Record<string, string> = {};

async function startHarness() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const dir of [DATA_DIR, EVIDENCE, join(DATA_DIR, "home"), join(DATA_DIR, "tmp"), join(DATA_DIR, "bin")]) mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(DATA_DIR, "bin", "node"));
  // Keyless, like the smoke fixture since CTA1: no Flux Router key, no image key.
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances: { verification: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLI } } } }, null, 2) + "\n", { mode: 0o600 });
  const offline = join(DATA_DIR, "flux-offline-preload.mjs");
  writeFileSync(offline, `const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname.endsWith("fluxrouter.ai")) throw new Error("image-settings fixture: Flux Router is offline in this spec");
  return original(input, init);
};\n`);
  const home = join(DATA_DIR, "home"), tmp = join(DATA_DIR, "tmp");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(["LANG", "LC_ALL", "TZ"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    PATH: [join(DATA_DIR, "bin"), "/usr/bin", "/bin"].join(":"),
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(HARNESS_PORT), MURAGE_WEBHOOK_PORT: String(HARNESS_PORT + 1),
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", FAKE_CLAUDE_MODE: "happy",
  };
  logPath = join(DATA_DIR, "harness.log");
  const log = openSync(logPath, "a");
  const preload = pathToFileURL(join(ROOT, "server", "testing", "search-fetch-preload.mjs")).href;
  try {
    harness = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, "--import", pathToFileURL(offline).href, join(ROOT, "server", "index.ts")], { cwd: ROOT, env, stdio: ["ignore", log, log] });
  } finally { closeSync(log); }
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (harness.exitCode !== null) throw new Error(`harness exited early; see ${logPath}\n${readFileSync(logPath, "utf8").slice(-2000)}`);
    try { const res = await fetch(`${HARNESS_URL}/api/health`, { signal: AbortSignal.timeout(1000) }); if (res.ok && (await res.json()).app === "murage") break; } catch {}
    if (Date.now() > deadline) throw new Error(`harness never answered on ${HARNESS_URL}; see ${logPath}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = await (await fetch(`${HARNESS_URL}/api/desktop-secret`, { headers: { "x-murage-surface": "desktop" } })).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
async function stopHarness() {
  const child = harness; if (!child || child.exitCode !== null) return;
  const closed = new Promise<void>((r) => child.once("close", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { await closed; } finally { clearTimeout(timer); }
}
/** Fixture setup only (the OpenAI image key has no field of its own in this build's Settings). */
async function fixtureRequest(path: string, method: string, body: unknown) {
  return fetch(HARNESS_URL + path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await startHarness();
  try {
    vite = await createServer({ configFile: false, root: ROOT, envFile: false, cacheDir: join(DATA_DIR, "vite-cache"), resolve: { alias: { "@": join(ROOT, "src") } },
      plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: UI_PORT, strictPort: true, watch: null, hmr: false, proxy: { "/api": { target: HARNESS_URL } } } });
    await vite.listen();
    const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw new Error("the app did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await stopHarness(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await stopHarness(); } });

async function openApp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", "light"); });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "App settings", exact: true }).first()).toBeVisible({ timeout: 60_000 });
}
async function openSettings(page: Page, section: string) {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  if (!(await dialog.count())) await page.getByRole("button", { name: "App settings", exact: true }).first().click();
  await expect(dialog).toBeVisible();
  const entry = dialog.getByRole("navigation").getByRole("button", { name: section, exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  return dialog;
}
/** The same locator the user smoke reads (user-smoke-0152.human.spec.ts, feature 6). */
function imageRegion(settings: Locator) {
  return settings.getByRole("region", { name: "Image generation" }).or(settings.locator('section[aria-labelledby="image-settings-heading"]'));
}
const shot = (target: Locator, name: string) => target.screenshot({ path: join(EVIDENCE, `${name}.png`) });

test("a keyless install has no image connection, and claims no model capability", async ({ page }) => {
  await openApp(page);
  const images = imageRegion(await openSettings(page, "Tools & Connections"));
  await images.scrollIntoViewIfNeeded();
  await expect(images.getByText("No supported image connections are available.", { exact: false })).toBeVisible();
  await expect(images.getByRole("button", { name: "Refresh connections", exact: true })).toBeEnabled();
  await expect(images.getByText(CAPABILITY)).toHaveCount(0);
  await expect(images.locator("[data-image-capability]")).toHaveCount(0);
  await expect(images.getByRole("checkbox", { name: "Allow image requests" })).toBeDisabled();
  await shot(images, "01-keyless-no-image-connection");
});

test("a Flux Router key added in Settings → Models makes Image generation state creates-only with the reason", async ({ page }) => {
  await openApp(page);
  const settings = await openSettings(page, "Models");
  const field = settings.getByLabel("Flux Router key", { exact: true });
  await field.fill("fixture-flux-key");
  await settings.locator("#flux-router-connection").getByRole("button", { name: "Connect", exact: true }).click();
  await expect(settings.getByText("Key saved. Test the connection to check its model catalog.")).toBeVisible();

  const images = imageRegion(await openSettings(page, "Tools & Connections"));
  await images.scrollIntoViewIfNeeded();
  // The smoke's exact check, now against an install that has a connection.
  await expect(images.getByText(CAPABILITY).first()).toBeVisible({ timeout: 30_000 });
  await expect(images.getByRole("combobox", { name: "Image connection" })).toHaveValue("flux");
  await expect(images.getByRole("combobox", { name: "Image model" })).toHaveValue("flux-image-gpt2");
  const line = images.locator("[data-image-capability]");
  await expect(line).toHaveAttribute("data-image-capability", "generates");
  await expect(line).toHaveText("Creates images only. Flux Router offers image generation only. It has no reference-edit contract.");
  await expect(images.getByText("No supported image connections are available.", { exact: false })).toHaveCount(0);
  await shot(images, "02-flux-creates-only");
});

test("an OpenAI image key states create-and-edit, and switching connections switches the statement", async ({ page }) => {
  expect((await fixtureRequest("/api/config?secretStorage=external", "PATCH", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
  await openApp(page);
  const images = imageRegion(await openSettings(page, "Tools & Connections"));
  await images.scrollIntoViewIfNeeded();
  const connection = images.getByRole("combobox", { name: "Image connection" });
  await expect(connection.locator("option", { hasText: "OpenAI image key" })).toHaveCount(1);
  await connection.selectOption({ label: "OpenAI image key" });
  await expect(images.getByRole("combobox", { name: "Image model" })).toHaveValue("gpt-image-2");
  const line = images.locator("[data-image-capability]");
  await expect(line).toHaveAttribute("data-image-capability", "edits");
  await expect(line).toHaveText("Creates and edits images. Up to 4 reference images per edit.");
  await expect(images.getByText("Image settings saved.")).toBeVisible();
  await shot(images, "03-openai-creates-and-edits");

  await connection.selectOption({ label: "Flux Router" });
  await expect(images.getByRole("combobox", { name: "Image model" })).toHaveValue("flux-image-gpt2");
  await expect(line).toHaveAttribute("data-image-capability", "generates");
  await expect(line).toHaveText(/^Creates images only\. /);
  await shot(images, "04-switched-back-to-flux");
});
