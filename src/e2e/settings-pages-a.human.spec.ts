// SETPAGES-A: real SettingsModal/store/window layer, 24 bots and isolated desktop/phone/Cloud-browser transports.
// Assertions always run. SHOTS_DIR adds light/dark evidence; it never substitutes screenshots for acceptance checks.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { freePortBlock } from "../../server/testing/ports";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { BOTS, RECORDS, SKILLS, fixtureEntry, installBridge, type EvidenceWindow, type FixtureSurface, type TranscriptionRoute } from "./fixtures/settings-pages-a-fixture";

let server: ViteDevServer;
let origin: string;
let cache: string;
const shots = process.env.SHOTS_DIR ?? "";
// This fixture owns its surface matrix; phone groups opt into touch explicitly.
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, colorScheme: "light", locale: "en-US", timezoneId: "UTC", screenshot: "off" });

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-settings-shell-vite-"));
  if (shots) mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "settings-shell-fixture",
      resolveId(id) { if (id === "/__settingsshell.js") return "\0settings-shell-fixture"; },
      load(id) {
        if (id !== "\0settings-shell-fixture") return;
        return fixtureEntry;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname !== "/__settingsshell") return next();
          res.setHeader("content-type", "text/html");
          const home = url.searchParams.get("surface") === "cloud-browser" ? '<meta name="murage-home-id" content="fixture-home">' : "";
          res.end(`${home}<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__settingsshell.js"></script>`);
        });
      },
    }],
  });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

/** What the fixture server holds for one test: the writes a page makes land here, so a reopened page reads them back. */
interface Fixture {
  botsPaused: string[]; revision: number; engines: Array<Record<string, unknown>>; webSearch: Record<string, unknown>;
  effort: string | null; requests: string[]; failNext: string | null; reviewMode: boolean;
  houseRules: { text: string; enabled: boolean; isDefault: boolean; defaultText: string };
  records: typeof RECORDS; phoneRevision: number; phoneSettings: Record<string, unknown>;
  transcribe: TranscriptionRoute;
}
const engine = (id: string, driverKind: string, displayName: string, snapshot: Record<string, unknown>) => ({
  instanceId: id, driverKind, displayName, enabled: true, cliDefault: id, cli: `/usr/local/bin/${id}`, snapshot: { state: "available", ...snapshot },
});
let fx: Fixture;
const freshFixture = (): Fixture => ({
  botsPaused: [], revision: 1, effort: null, requests: [], transcribe: null,
  failNext: null, reviewMode: false, records: RECORDS.map(record => ({ ...record })),
  houseRules: { text: "Keep sources beside each finding.", enabled: true, isDefault: true, defaultText: "Keep sources beside each finding." },
  phoneRevision: 1, phoneSettings: { phoneNumberId: "outbound", ownerName: "Sean", language: "auto", maxSeconds: 300, voices: {}, recordAudio: false,
    aiLine: { on: true, edits: { en: "I am Sean's AI assistant." } }, notice: { on: true, edits: { en: "May I record this call?" } } },
  webSearch: { provider: "engine", tavilyConfigured: false, exaConfigured: false, firecrawlConfigured: false },
  engines: [engine("claude", "claudeAgent", "Claude", { authenticated: true }), engine("codex", "codex", "Codex", { authenticated: false }), engine("fuigo", "fuigoAgent", "Fuigo", { authenticated: true })],
});
const memoryStatus = () => ({
  mode: "active", policyRevision: 1, deletionEpoch: 0, configuration: { excludedThreadIds: [], extractorInstanceId: null },
  scopes: [{ id: "workspace", kind: "workspace", ownerKey: "owner", label: "All bots" }, ...BOTS.map(bot => ({ id: `bot:${bot.id}`, kind: "bot", ownerKey: bot.id, label: bot.name }))],
  backlog: { pending: 0, leased: 0, deferred: 0, failed: 0, oldestQueuedAt: null }, records: { candidate: fx.records.filter(record => record.state === "candidate").length, active: fx.records.filter(record => record.state === "active").length, archived: 0, superseded: 0, deleted: 0 },
  model: { state: "ready", bytesDownloaded: 0, totalBytes: 0, revision: "r1", model: "fixture", bundled: true },
  extractors: [{ instanceId: "@murage/flux-fast", label: "Flux Router · Fast", eligible: true }], deletion: { pending: 0 }, workerError: null,
  semantic: { state: "ready", done: 3, total: 3 },
  learning: {
    revision: fx.revision, defaultOn: true,
    settings: { version: 3, automaticFacts: true, automaticProcedures: true, reviewMode: fx.reviewMode, perCallOutputTokens: { extraction: 1, grounding: 1, reflection: 1 }, ceiling: { input: 100000000, output: 15000000 }, callsPerMinute: 10, learnFrom: { chats: true, channels: true }, botsPaused: fx.botsPaused },
    connection: { instanceId: null, label: "Flux Router · Fast", source: "default" },
    ceiling: { month: "2026-11", input: 100000000, output: 15000000, inputUsed: 10, outputUsed: 1, paused: false },
  },
});

async function mount(page: Page, mode?: "simple" | "advanced", surface: FixtureSurface = "desktop") {
  fx = freshFixture();
  const phone = surface === "phone";
  const desktop = surface === "desktop";
  await installBridge(page, surface);
  if (mode) await page.addInitScript((value) => { localStorage.setItem("murage.settings.mode", value); }, mode);
  if (process.env.SPEC_DEBUG) { page.on("pageerror", (error) => console.log("PAGEERROR", error.message)); page.on("console", async (message) => { if (message.type() !== "error") return; console.log("CONSOLE", message.text()); for (const arg of message.args()) { const text = await arg.evaluate((value: any) => (value && value.stack ? value.stack : String(value))).catch(() => ""); if (text) console.log("ARG", text.slice(0, 700)); } }); }
  const config = () => ({ surface: desktop ? "desktop" : "remote", computer: desktop, features: { skillRecorder: true }, rooms: { turnTimeoutMinutes: 5 }, profile: { name: "Sean", email: "sean@example.com" }, composio: {}, webSearch: fx.webSearch,
    // Missing routes models an older response whose transcription configuration is unknown.
    tts: { configured: false, ready: false, voice: "", ...(fx.transcribe === undefined ? {} : { routes: { host: null, lookup: null, speech: null, transcribe: fx.transcribe } }) },
    newBots: fx.effort ? { effort: fx.effort } : {} });
  await page.exposeFunction("__settingsCredential", (name: string, value: string) => {
    // Packaged SearchSettings saves via credential:set, not the browser fallback HTTP route.
    if (name !== "tavilySearchApiKey") throw new Error(`Unmodelled fixture credential: ${name}`);
    fx.requests.push(`BRIDGE credential:set ${name}`);
    if (fx.failNext === "web-search-key") { fx.failNext = null; throw new Error("Fixture credential storage refused the save."); }
    fx.webSearch.tavilyConfigured = value !== "";
    return config();
  });
  await page.route("**/session", route => route.fulfill({ status: desktop ? 404 : 200, json: desktop ? {} : { device: { name: `Fixture ${surface}` } } }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = (): Record<string, any> => { try { return JSON.parse(request.postData() ?? "{}"); } catch { return {}; } };
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (method !== "GET") fx.requests.push(`${method} ${path} ${request.postData() ?? ""}`);
    const failure = path === "/api/config" && body().webSearch?.tavilyApiKey ? "web-search-key"
      : path === "/api/house-rules" ? "bot-defaults"
      : path === "/api/instances/claude" ? "engine-toggle"
      : path === "/api/memory/action" && body().action === "configure" ? "memory-learning" : null;
    if (method !== "GET" && failure && fx.failNext === failure) {
      fx.failNext = null;
      return json({ error: `Could not save ${failure}. Try again.` }, 500);
    }
    if (path === "/api/desktop-secret") return json(desktop ? { secret: "fixture-proof" } : {}, desktop ? 200 : 403);
    if (path === "/api/cloud/devices") return json({ devices: [], self: null });
    if (path === "/api/owner/timezone") return json({ timeZone: "UTC", chosen: false, computerTimeZone: "UTC" });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path === "/api/bots") return json({ bots: BOTS, groups: [] });
    if (path === "/api/config") {
      if (method === "GET") return json(config());
      const patch = body();
      if (patch.webSearch) {
        const web = patch.webSearch as Record<string, unknown>;
        if (typeof web.provider === "string") fx.webSearch.provider = web.provider;
        if (typeof web.tavilyApiKey === "string") fx.webSearch.tavilyConfigured = web.tavilyApiKey !== "";
      }
      if (patch.newBots) fx.effort = (patch.newBots as { effort?: string | null }).effort ?? null;
      return json(config());
    }
    if (path === "/api/instances/hidden") return json({ hidden: [] });
    if (path === "/api/instances") return json({ instances: fx.engines });
    if (path.startsWith("/api/instances/") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/")[3] ?? "");
      const row = fx.engines.find((each) => each.instanceId === id);
      if (row && typeof body().enabled === "boolean") row.enabled = body().enabled;
      return json({ ok: true });
    }
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    if (path === "/api/provider-connections") return json({ connections: [], storage: "encrypted" });
    if (path === "/api/flux-connection") return json({ configured: false, revision: 1, choices: [] });
    if (path === "/api/claude-accounts") return json({ accounts: [] });
    if (path === "/api/about-me") return json({ text: "", saved: false, chars: 0, maxChars: 4000, suggestion: "" });
    if (path === "/api/house-rules") {
      if (method === "PUT") Object.assign(fx.houseRules, body(), { isDefault: false });
      return json(fx.houseRules);
    }
    if (path === "/api/starter-profiles") return json({ profiles: [] });
    if (path === "/api/images/settings") return json({ enabled: false, connections: [], selected: null, catalog: null, dailyProbe: false });
    if (path === "/api/images/library") return json({ blocks: [], packs: [] });
    if (path === "/api/skills") {
      const query = new URL(request.url()).searchParams.get("q")?.toLowerCase() ?? "";
      const rows = SKILLS.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
      return json({ yours: rows.filter(skill => skill.kind === "collection"), library: rows.filter(skill => skill.kind === "library"), categories: [], libraryReady: true });
    }
    if (path === "/api/mobile/push/preferences") return json({ previewContent: false });
    if (path === "/api/mcp-grants") return json({ grants: [] });
    if (path === "/api/calls/active") return json({ calls: [], offUntil: null });
    if (path === "/api/calls/history") return json({ items: [], next: null });
    if (path === "/api/phone-calls/status") return json({ supported: desktop, keyPresent: desktop, active: { revision: fx.phoneRevision, settings: fx.phoneSettings }, olderScheduled: [] });
    if (path === "/api/phone-calls/setup") return json({ numbers: [{ id: "outbound", number: "+12025550123", canCallOut: true }, { id: "inbound", number: "+12025550124", canCallOut: false }] });
    if (path === "/api/phone-calls/settings") { fx.phoneSettings = body(); return json({ revision: ++fx.phoneRevision }); }
    if (path === "/api/phone-calls") return json({ calls: [{ id: "fixture-call", status: "ended", outcome: "done", to: "+12025550125", goal: "Fixture test call: confirm the booking", transcript: "Assistant: Is the booking confirmed? Business: Yes, Friday at noon.", reference: "FIXTURE-01", length_seconds: 42, dashboard: "", time: "2026-11-09T12:00:00Z" }] });
    if (path === "/api/local-models") return json({ servers: [], looked: [], checkedAt: 1 });
    if (path === "/api/memory/status") return json(memoryStatus());
    if (path === "/api/memory/flux-memory") return json({ keyPresent: false });
    if (path === "/api/memory/action") {
      const action = body();
      if (action.action === "learning-history") return json({ events: [{ id: "learned-coffee", kind: "activated", record_id: "memory-coffee", record_version: 1, created_at: 1794225600000,
        kept_at: 1794225600000, undone_at: null, scopeLabel: "All bots", source: { threadId: "thread-nova", botId: "nova", botName: "Nova" }, record: fx.records[0] }], nextCursor: null });
      if (action.action === "learning-bot") {
        fx.botsPaused = action.enabled ? fx.botsPaused.filter((id) => id !== action.botId) : [...new Set([...fx.botsPaused, action.botId as string])];
        fx.revision += 1;
        return json(memoryStatus());
      }
      if (action.action === "configure") {
        if (typeof action.learning?.reviewMode === "boolean") fx.reviewMode = action.learning.reviewMode;
        fx.revision += 1;
        return json(memoryStatus());
      }
      if (action.action === "list") {
        const records = fx.records.filter(record => (!action.query || record.text.toLowerCase().includes(String(action.query).toLowerCase())) && (action.view !== "review" || record.state === "candidate"));
        return json({ records, nextCursor: null, scopeIds: ["workspace"], matchCountLabel: String(records.length) });
      }
      if (action.action === "inspect") return json({ record: fx.records.find(record => record.id === action.id), evidence: [{ sourceId: "source-owner", revision: 1, startByte: 0, endByte: 40, hash: "fixture", speaker: "owner", text: "Coffee meetings work best for me after 10am." }], lineage: [] });
      if (action.action === "approve") {
        const record = fx.records.find(record => record.id === action.id);
        if (record) { record.state = "active"; record.version += 1; }
        return json(record);
      }
      if (action.action === "waiting-summary") return json({ subjects: [], total: fx.records.filter(record => record.state === "candidate").length, later: 0, boot: "fixture", revision: fx.revision });
      if (action.action === "import-review-list") return json({ links: [], nextCursor: null });
      if (action.action === "humans") return json({ ownerPersonId: "owner", bindings: [], shares: [] });
      return json({ items: [], records: [], nextCursor: null });
    }
    return json({});
  });
  await page.goto(`${origin}/__settingsshell?surface=${surface}`);
  await expect(page.locator("output")).toHaveText("ready");
  await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.layer().confirmed)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.layer().surface)).toBe(desktop ? "desktop" : "remote");
  await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.layer().windows)).toContainEqual({ name: "settings", kind: "window", attached: true });
  const layer = await page.evaluate(() => ({ ...(window as unknown as EvidenceWindow).__settings.layer(), userAgent: navigator.userAgent, touch: navigator.maxTouchPoints, width: innerWidth }));
  expect(layer.desktop).toBe(desktop);
  expect(layer.bridge).toBe(desktop);
  expect(layer.surface).toBe(desktop ? "desktop" : "remote");
  expect(layer.bots).toBe(24);
  expect(layer.windows).toContainEqual({ name: "settings", kind: "window", attached: true });
  if (phone) { expect(layer.touch).toBeGreaterThan(0); expect(layer.userAgent).toContain("Mobile"); }
  else { expect(layer.touch).toBe(0); expect(layer.userAgent).not.toContain("Mobile"); }
  console.log(`SETTINGS LAYER ${surface}`, layer);
  await test.info().attach(`layer-${surface}`, { body: JSON.stringify(layer, null, 2), contentType: "application/json" });
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const nav = (page: Page) => dialog(page).getByRole("navigation", { name: "Settings sections" });
const shot = async (page: Page, name: string) => {
  const { width, height } = page.viewportSize()!;
  const skin = await page.locator("html").getAttribute("data-skin");
  expect(["light", "dark"]).toContain(skin);
  const desktopNarrow = width === 390 && await page.evaluate(() => Boolean(window.muragebox));
  if (shots) await page.screenshot({ path: join(shots, `${name}-${skin}-${desktopNarrow ? "desktop" : ""}${width}x${height}.png`), animations: "disabled" });
};


const open = (page: Page, section: string, anchor?: string) => page.evaluate(([s, a]) => (window as unknown as { __settings: { open: (s: string, a?: string) => void } }).__settings.open(s, a), [section, anchor ?? ""] as const);
const widths = [{ w: 1280, h: 800 }, { w: 390, h: 844 }];
const phoneUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 MurageApp/1.0";
const surfaceOptions = (w: number, h: number, surface: FixtureSurface = "desktop") => ({ viewport: { width: w, height: h }, isMobile: surface === "phone", hasTouch: surface === "phone",
  ...(surface === "phone" ? { userAgent: phoneUserAgent } : {}) });

async function generalGroups(page: Page, mode: "simple" | "advanced") {
  const groups = dialog(page).locator("[data-settings-card-group]");
  // Group ids name the composed surfaces; their children retain the registry ids' landing anchors.
  expect(await groups.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-settings-card-group"),
    anchors: Array.from(node.children).map((child) => child.id),
  })))).toEqual([
    { id: "general.about-you", anchors: ["profile-heading", "about-me-heading"] },
    { id: "general.appearance", anchors: ["appearance-heading", "sidebar-density-heading"] },
    ...(mode === "advanced" ? [{ id: "general.language-time", anchors: ["language-heading", "time-zone-heading"] }] : []),
  ]);
  const about = dialog(page).locator('[data-settings-card-group="general.about-you"]');
  await expect(about.getByRole("textbox", { name: "Your name", exact: true })).toHaveValue("Sean");
  await expect(about.getByRole("textbox", { name: "Your email", exact: true })).toHaveValue("sean@example.com");
  await expect(about.getByRole("textbox", { name: "About me", exact: true })).toBeVisible();
  const appearance = dialog(page).locator('[data-settings-card-group="general.appearance"]');
  await expect(appearance.getByRole("radiogroup", { name: "Appearance", exact: true })).toBeVisible();
  await expect(appearance.getByRole("combobox", { name: "Interface font", exact: true })).toBeVisible();
  // Sidebar density is still in this card but its existing max-md:hidden rule applies to a narrow desktop too.
  const density = appearance.locator('[role="radiogroup"][aria-labelledby="settings-sidebar-density"]');
  await expect(density).toHaveCount(1);
  if (page.viewportSize()!.width >= 768) await expect(density).toBeVisible();
  else await expect(density).toBeHidden();
  if (mode === "advanced") {
    const language = dialog(page).locator('[data-settings-card-group="general.language-time"]');
    await expect(language.getByRole("combobox", { name: "App language", exact: true })).toBeVisible();
    await expect(language.getByLabel("Your time zone", { exact: true })).toBeVisible();
  }
}

for (const { w, h } of widths) {
  test.describe(`appearance status ${w}x${h}`, () => {
    test.use(surfaceOptions(w, h));
    test(`General's Automatic status names the theme in use at ${w}px`, async ({ page }) => {
      await mount(page, "advanced");
      await open(page, "general", "appearance-heading");
      const card = dialog(page).locator("#appearance-heading").locator("xpath=ancestor::*[@data-settings-card-group][1]");
      for (const [scheme, label] of [["dark", "System (Dark)"], ["light", "System (Light)"]] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expect(page.locator("html")).toHaveAttribute("data-skin", scheme);
        await expect(card.getByText(label, { exact: true })).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await shot(page, `general-system-status-${scheme}`);
      }
    });
  });
}

for (const { w, h } of widths) {
  test.describe(`card inventory ${w}`, () => {
  test.use(surfaceOptions(w, h));
  test(`pages 1 to 4 render their cards at ${w}px, nothing wider than the screen`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await mount(page, "advanced");
    for (const [id, label, anchors] of [
      ["general", "General", ["advanced-mode-heading", "profile-heading", "about-me-heading", "appearance-heading", "sidebar-density-heading", "language-heading", "time-zone-heading", "send-key-heading", "notifications-heading", "analytics-heading"]],
      ["calls", "Calls", ["calls-settings-title"]],
      ["botDefaults", "How every bot behaves", ["house-rules-heading", "starter-profiles-heading", "tool-calls-heading", "project-autonomy-heading", "room-turn-timeout", "room-routing-label"]],
      ["skills", "Skills", ["skill-recorder-heading", "skills-settings-title", "skill-scan-rules-heading"]],
    ] as const) {
      await open(page, id);
      await expect(dialog(page).getByRole("navigation", { name: "Where you are" }).locator("[aria-current='page']")).toHaveText(label);
      for (const anchor of anchors) await expect(dialog(page).locator(`#${anchor}`), `${id} ${anchor}`).toHaveCount(1);
      if (id === "general") await generalGroups(page, "advanced");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), `${id} overflow`).toBe(false);
    }
  });
  });
}

test("General in Simple shows five cards and one Set in Advanced line, and the press keeps keyboard focus", async ({ page }) => {
  await mount(page);
  const body = dialog(page).locator("[data-settings-page-body]");
  await expect(body.locator("#advanced-mode-heading")).toHaveCount(1);
  await expect(body.locator("#profile-heading")).toHaveCount(1);
  await expect(body.locator("#about-me-heading")).toHaveCount(1);
  await expect(body.locator("#sidebar-density-heading")).toHaveCount(1);
  await generalGroups(page, "simple");
  await expect(body.locator(":scope > div[id], :scope > [data-settings-card-group]")).toHaveCount(5);
  for (const anchor of ["appearance-heading", "notifications-heading", "startup-heading"]) await expect(body.locator(`#${anchor}`)).toHaveCount(1);
  for (const anchor of ["time-zone-heading", "send-key-heading", "analytics-heading", "bring-your-ai-heading"]) await expect(body.locator(`#${anchor}`)).toHaveCount(0);
  await expect(body.locator("#language-heading")).toHaveCount(0);
  await expect(body.locator("[data-set-in-advanced]")).toBeVisible();
  await body.getByRole("button", { name: "Set in Advanced" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("switch", { name: "Advanced mode" })).toHaveAttribute("aria-checked", "true");
  await expect(body.locator("[data-set-in-advanced]")).toHaveCount(0);
  // The line is gone; the focus is on the first card it opened, not on the page body.
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("language-heading");
});

test("the sidebar's Set in Advanced line hands the focus to the mode footer", async ({ page }) => {
  await mount(page);
  await nav(page).getByRole("button", { name: "Set in Advanced" }).focus();
  await page.keyboard.press("Enter");
  await expect(nav(page).locator("[data-settings-mode-footer]")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-settings-mode-footer"))).toBe(true);
});

test("a link to a card Simple leaves out turns Advanced on first, then shows the card", async ({ page }) => {
  await mount(page);
  await expect(dialog(page).locator("#language-heading")).toHaveCount(0);
  await open(page, "general", "language-heading");
  await expect(dialog(page).getByRole("switch", { name: "Advanced mode" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog(page).locator("#language-heading")).toHaveCount(1);
  await expect(dialog(page).locator("#language-heading")).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("#language-heading")?.id)).toBe("language-heading");
});

test("every old address for a moved card still opens its card", async ({ page }) => {
  await mount(page, "advanced");
  for (const [section, anchor, owner] of [["houseRules", "house-rules-heading", "How every bot behaves"], ["aboutMe", "about-me-heading", "General"], ["experimental", "skill-recorder-heading", "Skills"]] as const) {
    await open(page, section);
    await expect(dialog(page).locator(`#${anchor}`), section).toHaveCount(1);
    await expect(dialog(page).getByRole("navigation", { name: "Where you are" }).locator("[aria-current='page']")).toHaveText(owner);
  }
});

const PAGES_5_TO_7 = [
  ["memory", "Memory", ["memory-heading", "memory-how-heading", "memory-bots-heading", "memory-learned-heading", "memory-import-heading", "memory-mode-heading", "memory-connection-heading", "memory-audience-heading", "memory-procedures-heading", "memory-reindex-heading", "memory-health-heading"]],
  ["models", "Models & engines", ["engines-heading", "local-models-heading", "models-heading", "paste-any-keys", "claude-accounts-heading", "existing-keys-heading", "model-catalogs-heading", "new-bot-effort-heading", "engine-command-lines-heading"]],
  ["webSearch", "Search, images and dictation", ["search-settings-heading", "search-keys-heading", "image-settings-heading", "image-daily-check-heading", "voice-settings-heading"]],
] as const;

for (const { w, h } of widths) {
  test.describe(`AI card inventory ${w}`, () => {
  test.use(surfaceOptions(w, h));
  test(`pages 5 to 7 render their cards at ${w}px, one anchor each, nothing wider than the screen`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: w, height: h });
    await mount(page, "advanced");
    for (const [id, label, anchors] of PAGES_5_TO_7) {
      await open(page, id);
      await expect(dialog(page).getByRole("navigation", { name: "Where you are" }).locator("[aria-current='page']")).toHaveText(label);
      for (const anchor of anchors) await expect(dialog(page).locator(`#${anchor}`), `${id} ${anchor}`).toHaveCount(1);
      await expect(dialog(page).locator("[role='alert']"), `${id} shows no error`).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), `${id} overflow`).toBe(false);
    }
    // The AssemblyAI key is one field, on Skills, next to Teach a skill: not on Search, images and dictation.
    await open(page, "webSearch");
    await expect(dialog(page).locator("#voice-key-heading")).toHaveCount(0);
    // Refresh the real store from the fixture response: no reload or replacement voice component.
    for (const { route, state, text } of [
      { route: "flux", state: "configured", text: "Configured to transcribe voice notes with Flux. Service availability is checked when you transcribe." },
      { route: null, state: "not-configured", text: "Add a Flux, Groq or OpenAI connection in Models and engines to transcribe voice notes." },
      { route: undefined, state: "unknown", text: "Voice-note transcription status is unavailable right now." },
    ] as const) {
      fx.transcribe = route;
      await page.evaluate(() => (window as unknown as EvidenceWindow).__settings.refreshConfig());
      const voice = dialog(page).locator("#voice-settings-heading");
      const notes = voice.locator("section").filter({ has: page.getByRole("heading", { name: "Voice notes", exact: true }) });
      await expect(notes).toHaveCount(1);
      await expect(notes.getByRole("heading", { name: "Voice notes", exact: true })).toBeVisible();
      await expect(notes.getByRole("status")).toHaveText(text);
      await expect(notes).toContainText("Chat attachments and phone recordings also need a Flux key.");
      await expect(notes).not.toContainText("AssemblyAI");
      await expect(voice.getByText("AssemblyAI transcription", { exact: true })).toBeVisible();
      await expect(voice.getByText("Live narration for recorded skills. Audio is sent to AssemblyAI while recording; the API key is protected by your operating system.", { exact: true })).toBeVisible();
      await expect(voice.getByRole("button", { name: "Open Skills", exact: true })).toBeEnabled();
      await expect(notes.getByRole("button", { name: "Open Skills", exact: true })).toHaveCount(0);
      await themedState(page, `dictation-voice-notes-${state}`, voice);
    }
    await dialog(page).locator("#voice-settings-heading").getByRole("button", { name: "Open Skills", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.section())).toBe("skills");
    await expect(dialog(page).locator("#voice-key-heading")).toHaveCount(1);
    await expect(dialog(page).getByLabel("AssemblyAI API key")).toHaveCount(1);
    await expect(dialog(page).getByLabel("AssemblyAI API key")).toBeEnabled();
    await expect(dialog(page).getByTestId("settings-stub-voice-key-heading")).toHaveCount(0);
  });
  });
}

test("Memory lists the upkeep section after the seven cards, ending on health", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "memory");
  await expect(dialog(page).getByRole("heading", { name: "Memory upkeep" })).toBeVisible();
  const order = await dialog(page).locator("[data-settings-page-body] > div[id]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(order.indexOf("memory-connection-heading")).toBeGreaterThan(order.indexOf("memory-mode-heading"));
  expect(order.indexOf("memory-health-heading")).toBe(order.length - 1);
});

test("pausing one of 24 bots changes only that bot, and it is still paused when Memory is reopened", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "memory");
  const bots = dialog(page).locator("#memory-bots-heading").getByRole("switch");
  await expect(bots).toHaveCount(24);
  await expect(bots.nth(1)).toHaveAttribute("aria-checked", "true");
  await bots.nth(1).click();
  await expect.poll(() => fx.botsPaused).toEqual(["ada"]);
  await open(page, "botDefaults");
  await open(page, "memory");
  const again = dialog(page).locator("#memory-bots-heading").getByRole("switch");
  await expect(again).toHaveCount(24);
  const states = await again.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-checked")));
  expect(states).toEqual(BOTS.map(bot => bot.id === "ada" ? "false" : "true"));
});

test("each engine row says where it stands with one fix, and turning an engine off then on works from its row", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "models");
  const row = (name: string) => dialog(page).locator(`[data-engine-row="${name}"]`);
  await expect(row("Claude")).toHaveAttribute("data-route-state", "ready");
  await expect(row("Codex")).toHaveAttribute("data-route-state", "signIn");
  await expect(row("Codex").getByRole("button", { name: "Sign in to Codex" })).toBeVisible();
  await expect(row("Fuigo").locator("[data-route-line]")).toHaveText("Credit is not available right now.");
  await row("Claude").getByRole("button", { name: "Disable" }).click();
  await dialog(page).getByRole("button", { name: "Confirm disable" }).click();
  await expect(row("Claude")).toHaveAttribute("data-route-state", "off");
  await row("Claude").getByRole("button", { name: /Turn on/ }).click();
  await expect(row("Claude")).toHaveAttribute("data-route-state", "ready");
  expect(fx.requests.filter((line) => line.includes("/api/instances/claude")).length).toBe(2);
});

test("the new-bot effort lives on Models & engines and saves there", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "botDefaults");
  await expect(dialog(page).locator("#new-bot-effort-heading")).toHaveCount(0);
  await open(page, "models");
  await dialog(page).locator("#new-bot-effort-heading").getByRole("combobox").selectOption("high");
  await expect.poll(() => fx.effort).toBe("high");
  await open(page, "models", "new-bot-effort-heading");
  await expect(dialog(page).locator("#new-bot-effort-heading").getByRole("combobox")).toHaveValue("high");
});

test("Auto stays chosen after a Tavily key is saved, and saving a key changes nothing else", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "webSearch");
  await dialog(page).locator("#web-search-provider").selectOption("auto");
  await expect.poll(() => fx.webSearch.provider).toBe("auto");
  await dialog(page).locator("#tavily-search-key").fill("tvly-fixture");
  await dialog(page).locator("#search-keys-heading").getByRole("button", { name: "Save Tavily key", exact: true }).click();
  await expect.poll(() => fx.webSearch.tavilyConfigured).toBe(true);
  expect(fx.webSearch.provider).toBe("auto");
  await open(page, "skills");
  await open(page, "webSearch");
  await expect(dialog(page).locator("#web-search-provider")).toHaveValue("auto");
});

test("Simple lists the four Models cards and one Set in Advanced line; the Engines card keeps its fix buttons", async ({ page }) => {
  await mount(page);
  await open(page, "models");
  const body = dialog(page).locator("[data-settings-page-body]");
  for (const anchor of ["engines-heading", "models-heading", "paste-any-keys", "existing-keys-heading"]) await expect(body.locator(`#${anchor}`), anchor).toHaveCount(1);
  for (const anchor of ["local-models-heading", "claude-accounts-heading", "model-catalogs-heading", "new-bot-effort-heading", "engine-command-lines-heading"]) await expect(body.locator(`#${anchor}`), anchor).toHaveCount(0);
  await expect(body.locator("[data-set-in-advanced]")).toBeVisible();
  await expect(body.locator('[data-engine-row="Codex"]').getByRole("button", { name: "Sign in to Codex" })).toBeVisible();
});

const PAGES = [
  { id: "general", first: "advanced-mode-heading", last: "bring-your-ai-heading", simple: true },
  { id: "models", first: "engines-heading", last: "engine-command-lines-heading", simple: true },
  { id: "botDefaults", first: "house-rules-heading", last: "room-routing-label", simple: false },
  { id: "skills", first: "skill-recorder-heading", last: "skill-scan-rules-heading", simple: false },
  { id: "webSearch", first: "search-settings-heading", last: "voice-settings-heading", simple: false },
  { id: "calls", first: "calls-settings-title", last: "phone-calls-heading", simple: false },
  { id: "memory", first: "memory-heading", last: "memory-health-heading", simple: false },
] as const;
const schemes = ["light", "dark"] as const;
async function theme(page: Page, colorScheme: typeof schemes[number]) {
  await page.emulateMedia({ colorScheme });
  // The entry installs the actual main.tsx skin watcher with the Automatic preference.
  await expect(page.locator("html")).toHaveAttribute("data-skin", colorScheme);
}
async function themedState(page: Page, name: string, target = dialog(page)) {
  for (const scheme of schemes) {
    await theme(page, scheme);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    await shot(page, name);
  }
}
async function scrollBody(page: Page, end: boolean) {
  const body = dialog(page).locator("[data-box-body]").first();
  await body.evaluate((element, end) => { element.scrollTop = end ? element.scrollHeight : 0; }, end);
  await expect.poll(() => body.evaluate((element, end) => end
    ? Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2
    : element.scrollTop <= 2, end)).toBe(true);
}

for (const { w, h } of widths) {
  test.describe(`evidence matrix ${w}x${h}`, () => {
    test.use(surfaceOptions(w, h));
    for (const entry of PAGES) {
      test(`${entry.id}: desktop at ${w}px, both palettes and lower cards`, async ({ page }) => {
        test.setTimeout(60_000);
        await mount(page, "advanced");
        await open(page, entry.id);
        await expect(dialog(page).locator(`#${entry.first}`)).toHaveCount(1);
        await expect(dialog(page).locator(`#${entry.last}`)).toHaveCount(1);
        expect(await page.evaluate(() => Boolean(window.muragebox))).toBe(true);
        await expect(dialog(page).locator('[data-settings-stub="other-surface"]')).toHaveCount(0);
        if (entry.id === "general") await expect(dialog(page).getByRole("switch", { name: "Keep running when the window closes" })).toBeEnabled();
        if (entry.id === "botDefaults") await expect(dialog(page).getByRole("textbox", { name: "House rules", exact: true })).toHaveText(fx.houseRules.text);
        if (entry.id === "webSearch") await expect(dialog(page).locator("#web-search-provider")).toBeEnabled();
        if (entry.id === "calls") await populateCalls(page);
        if (entry.id === "skills") {
          await expect(dialog(page).getByLabel("AssemblyAI API key")).toBeEnabled();
          await expect(dialog(page).getByRole("button", { name: /Weekly brief/ })).toBeVisible();
        }
        if (entry.id === "models") await expect(dialog(page).locator("[data-engine-row]")).toHaveCount(3);
        if (entry.id === "memory") {
          await memoryOverview(page);
          for (const scheme of schemes) {
            await theme(page, scheme);
            await scrollBody(page, false);
            await shot(page, "memory-overview");
          }
          const browser = dialog(page).getByRole("button", { name: "Open memory", exact: true });
          await browser.click();
          await expect(dialog(page).locator("[data-memory-id]")).toHaveCount(3);
          await browser.click();
          await memoryOverview(page);
        }
        await expect(dialog(page).getByRole("alert")).toHaveCount(0);
        // Only General and Models have distinct Simple cards. Opening the other pages selects Advanced in the product.
        for (const mode of entry.simple ? ["simple", "advanced"] as const : ["advanced"] as const) {
          await page.evaluate(mode => (window as unknown as EvidenceWindow).__settings.mode(mode), mode);
          await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.layer().mode)).toBe(mode);
          await expect(dialog(page).locator(`#${entry.first}`)).toHaveCount(1);
          const last = mode === "simple" ? (entry.id === "general" ? "startup-heading" : "existing-keys-heading") : entry.last;
          await expect(dialog(page).locator(`#${last}`)).toHaveCount(1);
          if (entry.id === "general") await generalGroups(page, mode);
          for (const scheme of schemes) {
            await theme(page, scheme);
            await scrollBody(page, false);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
            await shot(page, `${mode}-${entry.id}`);
            await scrollBody(page, true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
            await shot(page, `${mode}-${entry.id}-lower`);
          }
        }
      });
    }
  });
}

async function memoryOverview(page: Page) {
  await expect(dialog(page).getByLabel("Search memory", { exact: true })).toBeHidden();
  await expect(dialog(page).getByRole("button", { name: "Open memory", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(dialog(page).locator('#memory-how-heading [role="switch"][aria-labelledby="memory-review-label"]')).toBeVisible();
  await expect(dialog(page).locator('#memory-bots-heading [role="switch"]')).toHaveCount(24);
}

async function restrictedNavigation(page: Page) {
  // Connected apps is admitted on phone/Cloud by the merged shell contract.
  const expected = ["general", "connections", "usage", "about"];
  await expect(nav(page).locator("[data-settings-section]")).toHaveCount(expected.length);
  expect(await nav(page).locator("[data-settings-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section")))).toEqual(expected);
  expect(await nav(page).locator('[data-settings-page-select] option:not([value^="bot:"])').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(expected);
  await expect(dialog(page).locator('input[type="password"]')).toHaveCount(0);
}

async function expectRedirect(page: Page, entry: typeof PAGES[number]) {
  await open(page, entry.id, entry.first);
  await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.section())).toBe("general");
  await expect(dialog(page).getByRole("navigation", { name: "Where you are" }).locator("[aria-current='page']")).toHaveText("General");
  await expect(dialog(page).locator("#advanced-mode-heading")).toHaveCount(1);
  await expect(dialog(page).locator(`#${entry.first}`)).toHaveCount(0);
  await expect(dialog(page).locator(`#${entry.last}`)).toHaveCount(0);
  await restrictedNavigation(page);
}

test.describe("paired phone routing and General", () => {
  test.use(surfaceOptions(390, 844, "phone"));
  test("General phone cards, Usage and About are reachable; desktop pages redirect without keys", async ({ page }) => {
    test.setTimeout(60_000);
    await mount(page, "advanced", "phone");
    expect(await page.evaluate(() => Boolean(window.muragebox))).toBe(false);
    await expect(dialog(page).locator("#advanced-mode-heading")).toHaveCount(1);
    await expect(dialog(page).locator("#bring-your-ai-heading")).toHaveCount(1);
    await expect(dialog(page).getByText("Notifications on this phone", { exact: true })).toBeVisible();
    await expect(dialog(page).getByText("This device", { exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("switch", { name: "Let scripts use a bot" })).toBeEnabled();
    for (const anchor of ["about-me-heading", "sidebar-density-heading", "language-heading", "time-zone-heading", "startup-heading", "bring-your-ai-heading"]) {
      const stub = dialog(page).getByTestId(`settings-stub-${anchor}`);
      await expect(stub).toBeVisible();
      await expect(stub.getByRole("button", { name: /Copy/ })).toBeEnabled();
    }
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    for (const mode of ["simple", "advanced"] as const) {
      await page.evaluate(mode => (window as unknown as EvidenceWindow).__settings.mode(mode), mode);
      await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.layer().mode)).toBe(mode);
      for (const scheme of schemes) {
        await theme(page, scheme);
        await scrollBody(page, false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
        await shot(page, `${mode}-general`);
        await scrollBody(page, true);
        await shot(page, `${mode}-general-lower`);
      }
    }
    for (const [id, label, anchor] of [["usage", "Usage", "usage-heading"], ["about", "About & help", "about-version-heading"]] as const) {
      const selector = nav(page).getByRole("combobox", { name: "Settings page", exact: true });
      await expect(selector).toBeVisible();
      await selector.selectOption(id);
      await expect(selector).toHaveValue(id);
      await expect.poll(() => page.evaluate(() => (window as unknown as EvidenceWindow).__settings.section())).toBe(id);
      await expect(dialog(page).getByRole("navigation", { name: "Where you are" }).locator("[aria-current='page']")).toHaveText(label);
      await expect(dialog(page).locator(`#${anchor}`)).toBeVisible();
      await restrictedNavigation(page);
    }
    for (const entry of PAGES.filter(entry => entry.id !== "general")) {
      await expectRedirect(page, entry);
      for (const scheme of schemes) {
        await theme(page, scheme);
        await scrollBody(page, false);
        await shot(page, `phone-redirect-${entry.id}`);
      }
    }
  });
});

test("Cloud browser: desktop deep links redirect to General without exposing keys", async ({ page }) => {
  await mount(page, "advanced", "cloud-browser");
  // HTTP Cloud browser, identified by the home's real HTML marker; not the murage-home: Electron window.
  await expect(page.locator('meta[name="murage-home-id"]')).toHaveAttribute("content", "fixture-home");
  expect(await page.evaluate(() => Boolean(window.muragebox || "murageNative" in window))).toBe(false);
  await expect(dialog(page).getByText("Devices", { exact: true })).toBeVisible();
  await expect(dialog(page).getByText("Notifications on this phone", { exact: true })).toHaveCount(0);
  for (const entry of PAGES.filter(entry => entry.id !== "general")) await expectRedirect(page, entry);
  await theme(page, "light");
  await scrollBody(page, false);
  await shot(page, "cloud-redirect-memory");
});

async function populateCalls(page: Page) {
  const card = dialog(page).locator("#phone-calls-heading");
  await expect(card.getByTestId("phone-calls-desktop-only")).toHaveCount(0);
  await expect(card.getByTestId("phone-key-saved")).toHaveText("Key saved");
  await card.getByRole("button", { name: "Find my numbers" }).click();
  await expect(card.getByRole("radio")).toHaveCount(2);
  await expect(card.getByRole("radio").first()).toBeChecked();
  await expect(card.getByRole("radio").last()).toBeDisabled();
  await expect(card.getByTestId("phone-ready")).toHaveText("Ready: +12025550123");
  await expect(card.getByRole("checkbox", { name: "AI line", exact: true })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: "Recording notice", exact: true })).toBeChecked();
  await expect(card.getByLabel("Recording notice:", { exact: false })).toHaveValue("May I record this call?");
  await expect(card.getByTestId("phone-result-card")).toContainText("Fixture test call: confirm the booking");
}

test("24 bots: five sidebar rows, chief first, Browse bots includes long names and filters", async ({ page }) => {
  await mount(page, "advanced");
  const rows = nav(page).locator("[data-settings-bot]");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute("data-settings-bot", "nova");
  await nav(page).locator('[data-settings-section="browseBots"]').click();
  const browse = dialog(page).locator("[data-settings-browse-bots]");
  await expect(browse.locator("[data-settings-browse-row]")).toHaveCount(24);
  await themedState(page, "flow-browse-bots", browse.locator("[data-settings-browse-row]").last());
  await browse.getByRole("textbox").fill("international markets");
  await expect(browse.locator("[data-settings-browse-row]")).toHaveCount(1);
  await expect(browse.locator("[data-settings-browse-row]")).toHaveAttribute("data-settings-browse-row", "research");
  await themedState(page, "flow-browse-bots-filtered", browse);
});

test("web search: failed key save keeps the input and retry persists only the key", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "webSearch");
  const card = dialog(page).locator("#search-keys-heading");
  const key = card.locator("#tavily-search-key");
  await key.fill("tvly-retry-fixture");
  fx.failNext = "web-search-key";
  await card.getByRole("button", { name: "Save Tavily key", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not save the Tavily key. Check your connection and try again.");
  await expect(key).toHaveValue("tvly-retry-fixture");
  expect(fx.webSearch.tavilyConfigured).toBe(false);
  await themedState(page, "fail-web-search-key", card.getByRole("alert"));
  await card.getByRole("button", { name: "Save Tavily key", exact: true }).click();
  await expect.poll(() => fx.webSearch.tavilyConfigured).toBe(true);
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(fx.webSearch.provider).toBe("engine");
});

test("bot defaults: failed rich editor save keeps words, retry and reopen keep the edited rules", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "botDefaults");
  const card = dialog(page).locator("#house-rules-heading");
  const editor = card.getByRole("textbox", { name: "House rules", exact: true });
  const words = "Include sources, dates and a concrete next step in every weekly brief.";
  await editor.fill(words);
  fx.failNext = "bot-defaults";
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not save bot-defaults. Try again.");
  await expect(editor).toHaveText(words);
  expect(fx.houseRules.text).toBe("Keep sources beside each finding.");
  await themedState(page, "fail-bot-defaults", card.getByRole("alert"));
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("status")).toContainText("Saved. Bots use the new rules");
  await expect.poll(() => fx.houseRules.text.trim()).toBe(words);
  await open(page, "general");
  await expect(editor).toHaveCount(0);
  await open(page, "botDefaults");
  await expect(editor).toHaveText(words);
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await themedState(page, "flow-bot-defaults-reopened", editor);
});

test("engine toggle: failed disable retains confirmation, retry changes the row", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "models");
  const row = dialog(page).locator('[data-engine-row="Claude"]');
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  fx.failNext = "engine-toggle";
  const confirm = dialog(page).getByRole("button", { name: "Confirm disable" });
  await confirm.click();
  const error = dialog(page).getByRole("alert").filter({ hasText: "Could not save engine-toggle. Try again." });
  await expect(error).toBeVisible();
  await expect(row).toHaveAttribute("data-route-state", "ready");
  await expect(confirm).toBeEnabled();
  await expect(row.getByRole("button", { name: "Disable", exact: true })).toHaveAttribute("aria-expanded", "true");
  await themedState(page, "fail-engine-toggle", error);
  await confirm.click();
  await expect(row).toHaveAttribute("data-route-state", "off");
  await expect(error).toHaveCount(0);
  await row.getByRole("button", { name: /Turn on/ }).click();
  await expect(row).toHaveAttribute("data-route-state", "ready");
  await themedState(page, "flow-models-engines", row);
});

test("AssemblyAI: rejected desktop bridge save keeps the key and retry reconnects", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "skills");
  const card = dialog(page).locator("#voice-key-heading");
  const key = card.getByLabel("AssemblyAI API key");
  await key.fill("assembly-retry-fixture");
  await page.evaluate(() => { (window as unknown as EvidenceWindow).__settingsBridge.failAssembly = true; });
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not save AssemblyAI key. Try again.");
  await expect(key).toHaveValue("assembly-retry-fixture");
  await themedState(page, "fail-assemblyai-key", card);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Clear", exact: true })).toBeEnabled();
  await expect(key).toHaveValue("");
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as EvidenceWindow).__settingsBridge.assemblyKey)).toBe("assembly-retry-fixture");
  await expect(dialog(page).getByRole("button", { name: /Weekly brief/ })).toBeVisible();
  await themedState(page, "flow-skills-populated", card);
  await dialog(page).getByLabel("Search skills").fill("Weekly");
  await expect(dialog(page).getByRole("button", { name: /Research notes/ })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: /Weekly brief/ })).toBeVisible();
});

test("Memory learning: failed save shows the confirmed value and inline error; retry saves the requested choice", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "memory");
  const card = dialog(page).locator("#memory-how-heading");
  const review = card.locator('[role="switch"][aria-labelledby="memory-review-label"]');
  await expect(review).toHaveAttribute("aria-checked", "false");
  fx.failNext = "memory-learning";
  await review.click();
  const error = card.getByRole("alert");
  await expect(error.locator("span")).toHaveText("Could not update memory. Refresh settings and try again.");
  expect(fx.reviewMode).toBe(false);
  await expect(review).toBeEnabled();
  await expect(review, "failed save shows the confirmed saved value").toHaveAttribute("aria-checked", "false");
  await expect(error).toBeVisible();
  await themedState(page, "fail-memory-learning-confirmed-value", error);
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => fx.reviewMode).toBe(true);
  await expect(review).toHaveAttribute("aria-checked", "true");
  await expect(error).toHaveCount(0);
  await open(page, "general");
  await open(page, "memory");
  await expect(review).toHaveAttribute("aria-checked", "true");
});

test("Memory: search real records, inspect sources, review and keep a waiting item", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "memory");
  await memoryOverview(page);
  await dialog(page).getByRole("button", { name: "Open memory", exact: true }).click();
  await expect(dialog(page).locator("[data-memory-id]")).toHaveCount(3);
  const search = dialog(page).getByLabel("Search memory", { exact: true });
  await search.fill("coffee");
  await search.press("Enter");
  await expect(dialog(page).locator("[data-memory-id]")).toHaveCount(1);
  const coffee = dialog(page).locator('[data-memory-id="memory-coffee"]');
  await expect(coffee).toContainText(RECORDS[0].text);
  await themedState(page, "flow-memory-search", coffee);
  await coffee.getByRole("button", { name: "Inspect memory" }).click();
  const detail = dialog(page).locator('[data-memory-detail-id="memory-coffee"]');
  await expect(detail.getByTestId("memory-record-text")).toHaveText(RECORDS[0].text);
  await detail.getByRole("button", { name: /Conversation.*You/i }).click();
  await expect(detail.getByText("Coffee meetings work best for me after 10am.")).toBeVisible();
  await themedState(page, "flow-memory-inspect", detail.getByTestId("memory-record-text"));
  await search.fill("");
  await dialog(page).getByRole("button", { name: "Waiting", exact: true }).click();
  const waiting = dialog(page).locator('[data-memory-id="memory-waiting"]');
  await expect(dialog(page).locator("[data-memory-id]")).toHaveCount(1);
  await waiting.getByRole("button", { name: "Inspect memory" }).click();
  const review = dialog(page).locator('[data-memory-detail-id="memory-waiting"]');
  await expect(review).toContainText("Please check this before bots use it.");
  await themedState(page, "flow-memory-waiting", review.getByTestId("memory-record-text"));
  await review.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(waiting).toHaveCount(0);
  expect(fx.records.find(record => record.id === "memory-waiting")?.state).toBe("active");
});

test("Calls: populated desktop setup saves consent and exposes the fixture call transcript", async ({ page }) => {
  await mount(page, "advanced");
  await open(page, "calls");
  await populateCalls(page);
  const card = dialog(page).locator("#phone-calls-heading");
  await themedState(page, "flow-calls-numbers", card.getByTestId("phone-ready"));
  const notice = card.getByLabel("Recording notice:", { exact: false });
  await notice.fill("With your permission, this call is recorded for Sean.");
  await card.getByRole("button", { name: "Save settings" }).click();
  await expect(card.getByText("Settings saved.", { exact: true })).toBeVisible();
  expect(fx.phoneSettings.notice).toEqual({ on: true, edits: { en: "With your permission, this call is recorded for Sean." } });
  await themedState(page, "flow-calls-consent", notice);
  await card.getByRole("button", { name: "Show transcript" }).click();
  await expect(card.locator("pre")).toContainText("Business: Yes, Friday at noon.");
  await themedState(page, "flow-calls-result", card.locator("pre"));
  // PhoneCallsSettings has no dial/test-call action: this is a seeded result, not proof of placing a call.
});
