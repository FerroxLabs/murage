// SPDX-License-Identifier: AGPL-3.0-or-later
// "Use my Chrome" against REAL Google Chrome (not Playwright Chromium), the
// real agent-browser engine and the real server: the 1.0.7 proof for Sean's
// report (Chrome kept asking "Allow remote debugging?", the Profile picker
// locked, and Murage never took over his browser).
//
// Proves, with Chrome's own dialog counted on screen:
// 1. one Allow per session: many steps, a second turn, take and return of
//    control and the panel's polling all ride the one approved connection;
// 2. the panel answers at once while Chrome waits for Allow, and the picker's
//    switches (back to the bot's own browser, then Use my Chrome again) never
//    409 once control is returned;
// 3. once Murage for Chrome is paired, "Use my Chrome" goes through it: no
//    Allow prompt, and the bot's steps reach the owner's Chrome.
//
// Runs only with MURAGE_USE_MY_CHROME_REAL=1 on a desktop Linux host with
// google-chrome, Xvfb on MURAGE_REAL_DISPLAY (default :95), xdotool and
// ImageMagick `import`, and MURAGE_REAL_AGENT_BROWSER naming the staged engine
// (node scripts/prepare-browser.mjs --current). Screenshots and a step log go
// to MURAGE_UMC_EVIDENCE (default /tmp/umc-real-evidence). The window
// coordinates below are for Chrome's default window on a 1400x1000 screen.
// The extension case loads dist-native/browser-extension/extension (node
// scripts/prepare-browser-extension.mjs --mode development) through
// chrome://extensions, as branded Chrome ignores --load-extension.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
// The warm engine carries per-turn tokens in a credential file; put them back inline as a proxy reads them.
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const REAL = process.env.MURAGE_USE_MY_CHROME_REAL === "1";
const DISPLAY = process.env.MURAGE_REAL_DISPLAY ?? ":95";
const ENGINE = process.env.MURAGE_REAL_AGENT_BROWSER ?? "";
const EVIDENCE = process.env.MURAGE_UMC_EVIDENCE ?? "/tmp/umc-real-evidence";
const run = promisify(execFile);
const x = (command: string, args: string[]) => run(command, args, { env: { ...process.env, DISPLAY } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line: string) => { appendFileSync(join(EVIDENCE, "steps.log"), `${new Date().toISOString()} ${line}\n`); };
let shots = 0;
const screenshot = async (name: string) => { await x("import", ["-window", "root", join(EVIDENCE, `${String(++shots).padStart(2, "0")}-${name}.png`)]); };

// Chrome's "Allow remote debugging?" dialog greys the whole window.
const ALLOW = [698, 316], CANCEL_FREE_SPOT = [900, 700];
let prompts = 0, watching = true, greyNow = false;
const watcher = async () => {
  while (watching) {
    try {
      const { stdout } = await x("import", ["-window", "root", "-crop", `1x1+${CANCEL_FREE_SPOT[0]}+${CANCEL_FREE_SPOT[1]}`, "txt:-"]);
      // The dimmed page behind the dialog: mid grey, never black (no window) or white (no dialog).
      const rgb = /\((\d+),(\d+),(\d+)\)/u.exec(stdout)?.slice(1).map(Number) ?? [];
      const grey = rgb.length === 3 && rgb.every((value) => value > 12_000 && value < 40_000) && Math.max(...rgb) - Math.min(...rgb) < 3_000;
      if (grey && !greyNow) { prompts += 1; note(`chrome allow prompt #${prompts} shown`); await screenshot(`allow-prompt-${prompts}`); }
      greyNow = grey;
    } catch { /* the screen is busy; look again */ }
    await pause(250);
  }
};
const waitForPrompt = async (count: number, timeoutMs = 60_000) => {
  const until = Date.now() + timeoutMs;
  while (prompts < count && Date.now() < until) await pause(200);
  expect(prompts, `Chrome's Allow prompt #${count}`).toBeGreaterThanOrEqual(count);
};
// Chrome ignores a click that lands right after its dialog opens; a person takes a moment too.
const clickAllow = async () => { await pause(1_500); await x("xdotool", ["mousemove", String(ALLOW[0]), String(ALLOW[1]), "click", "1"]); note("clicked Allow"); await pause(1_000); };

const launchChrome = (userData: string) => spawn("google-chrome", [`--user-data-dir=${userData}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "about:blank"], { env: { ...process.env, DISPLAY }, stdio: "ignore" });
let fixture: VerificationServer;
let chrome: ChildProcess | undefined;
let page: Server;
let pageUrl = "";
let model = "";
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};
const timed = async <T>(work: () => Promise<T>) => { const started = Date.now(); const value = await work(); return { value, ms: Date.now() - started }; };
const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); } catch { return null; } };
const startTurn = async (bot: any, label: string) => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${label}` })).status).toBe(202);
  await expect.poll(() => JSON.stringify(dump()?.prompt ?? ""), { timeout: 30_000 }).toContain(label);
  const mounted = dump()?.mcpConfig?.mcpServers?.browser;
  expect(mounted, "a browser is mounted for the turn").toBeTruthy();
  return mounted.env.MURAGE_CONTROL_TOKEN as string;
};
const stop = async (bot: any) => {
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id)?.busy === true, { timeout: 30_000 }).toBe(false);
  await pause(1_500);
};
const rpc = async (token: string, method: string, params?: unknown) => {
  const response = await fetch(`${fixture.info.url}/api/internal/unified-browser`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, ...(params === undefined ? {} : { params }) }),
  });
  const body = await response.json().catch(() => ({}));
  note(`${method}${params && typeof params === "object" && "name" in params ? ` ${(params as { name: string }).name}` : ""} -> ${response.status}${response.status === 200 ? "" : ` ${JSON.stringify(body).slice(0, 300)}`}`);
  return { status: response.status, body: body as any };
};
/** The owner answers each Murage for Chrome card ("let the bot use this site") with Allow while `work` runs. */
const allowingCards = async <T>(bot: any, work: Promise<T>) => {
  let done = false; const answered = new Set<string>();
  const loop = (async () => {
    while (!done) {
      const bots = (await api("GET", "/api/bots")).body.bots ?? [];
      const cards = (bots.find((item: any) => item.id === bot.id)?.messages ?? []).filter((message: any) => message.card?.tool === "browser_extension_action" && !message.card.answered).map((message: any) => message.card);
      for (const card of cards) {
        if (answered.has(card.requestId)) continue;
        answered.add(card.requestId);
        const reply = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
        note(`owner allowed card ${answered.size}: ${reply.status}`);
        await screenshot(`extension-card-${answered.size}-allowed`);
      }
      await pause(500);
    }
  })();
  try { return await work; } finally { done = true; await loop; }
};
type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
let tools: Tool[] = [];
const tool = (pattern: RegExp) => { const found = tools.find((item) => pattern.test(item.name)); expect(found, `a tool matching ${pattern}`).toBeTruthy(); return found!; };
const open = (token: string, url: string) => { const nav = tool(/navigate|_open$/u); const key = Object.keys(nav.inputSchema?.properties ?? { url: 1 }).find((name) => /url/iu.test(name)) ?? "url"; return rpc(token, "tools/call", { name: nav.name, arguments: { [key]: url } }); };
const snapshot = (token: string) => rpc(token, "tools/call", { name: tool(/snapshot/u).name, arguments: {} });

describe.skipIf(!REAL)("Use my Chrome with real Google Chrome", () => {
  beforeAll(async () => {
    expect(ENGINE, "MURAGE_REAL_AGENT_BROWSER").not.toBe("");
    mkdirSync(EVIDENCE, { recursive: true });
    page = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      // An owner's sign-in tab: a password field the bot must never reach.
      if ((request.url ?? "").startsWith("/owner-signin")) { response.end("<!doctype html><title>Owner sign in</title><body style='background:#fff'><h1>owner-signin-page</h1><input type='password' name='password'></body>"); return; }
      response.end("<!doctype html><title>Use my Chrome proof</title><body style='background:#fff'><h1 id='proof'>umc-proof-page</h1></body>");
    });
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", () => resolve()));
    pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/proof`;
    const instrumentation = `process.env.MURAGE_USER_DATA = process.env.MURAGE_DATA_DIR; process.env.MURAGE_AGENT_BROWSER_PATH = ${JSON.stringify(ENGINE)};`;
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 18_899, span: 1 } });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    model = (await api("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    // The owner's Chrome, in the place Murage looks for it under the fixture's HOME.
    const userData = join(fixture.info.dataDir, ".config", "google-chrome");
    mkdirSync(userData, { recursive: true });
    chrome = launchChrome(userData);
    await pause(6_000);
    await x("xdotool", ["key", "ctrl+l"]); await pause(400);
    await x("xdotool", ["type", "--delay", "20", "chrome://inspect/#remote-debugging"]); await x("xdotool", ["key", "Return"]); await pause(2_500);
    await screenshot("remote-debugging-page");
    await x("xdotool", ["mousemove", "220", "166", "click", "1"]);
    for (let wait = 0; wait < 60 && !existsSync(join(userData, "DevToolsActivePort")); wait += 1) await pause(250);
    if (!existsSync(join(userData, "DevToolsActivePort"))) throw new Error("Chrome did not turn on remote debugging");
    await screenshot("remote-debugging-on");
    note(`google-chrome ${(await run("google-chrome", ["--version"])).stdout.trim()}; remote debugging on`);
    void watcher();
  }, 120_000);

  afterAll(async () => {
    watching = false;
    if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
    await fixture?.close();
    await new Promise<void>((resolve) => page ? page.close(() => resolve()) : resolve());
  });

  it("asks for Allow once per session, keeps the panel answering while Chrome waits, then connects and drives the owner's Chrome", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Real Chrome", modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, computer: "off" })).status).toBe(200);
    // The picker's "Use my Chrome": the server picks remote debugging (no extension paired).
    const picked = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "auto" });
    expect(picked.status).toBe(200);
    expect(picked.body.bot.useMyChrome).toBe(true);
    expect(picked.body.bot.browserTransport).toBeUndefined();
    note("picked Use my Chrome (auto -> remote debugging)");
    const token = await startTurn(bot, "real-chrome-one");
    const listed = await rpc(token, "tools/list");
    expect(listed.status).toBe(200);
    tools = listed.body.tools ?? listed.body.result?.tools ?? [];
    note(`tools: ${tools.map((item) => item.name).join(", ")}`);
    // The first step dials Chrome; Chrome asks; the panel keeps answering meanwhile.
    const first = open(token, pageUrl);
    await waitForPrompt(1);
    for (let poll = 0; poll < 3; poll += 1) {
      const { value, ms } = await timed(() => api("GET", `/api/bots/${bot.id}/browser`));
      note(`panel while Chrome asks: ${value.status} in ${ms} ms ${JSON.stringify(value.body).slice(0, 400)}`);
      expect(value.status).toBe(200);
      expect(ms).toBeLessThan(3_000);
      expect(value.body.waitingForChrome).toBe(true);
      await pause(700);
    }
    await clickAllow();
    expect((await first).status).toBe(200);
    // Many steps on the one approved connection.
    for (let step = 0; step < 4; step += 1) {
      const shot = await snapshot(token);
      expect(shot.status).toBe(200);
      expect(JSON.stringify(shot.body)).toContain("umc-proof-page");
    }
    await screenshot("driven-owner-chrome");
    // The live view (the panel's own picture of the page) connects over the same approved connection.
    let panel = await api("GET", `/api/bots/${bot.id}/browser`);
    for (let poll = 0; poll < 30 && !(panel.status === 200 && panel.body.connected); poll += 1) { await pause(500); panel = await api("GET", `/api/bots/${bot.id}/browser`); }
    note(`panel after Allow: ${panel.status} ${JSON.stringify(panel.body).slice(0, 400)}`);
    expect(panel.status).toBe(200);
    expect(panel.body.connected).toBe(true);
    expect(panel.body.waitingForChrome).toBeFalsy();
    expect(panel.body.problem).toBeUndefined();
    // Take control and hand it back, as the panel does.
    const taken = await api("POST", `/api/bots/${bot.id}/browser`, { action: "take" });
    expect(taken.status).toBe(200);
    const released = await api("POST", `/api/bots/${bot.id}/browser`, { action: "release", generation: taken.body.generation, control: taken.body.control });
    note(`take ${taken.status}, release ${released.status}`);
    expect(released.status).toBe(200);
    await stop(bot);
    // A second turn: the engine reconnects through the same approved connection.
    const again = await startTurn(bot, "real-chrome-two");
    const later = await snapshot(again);
    expect(later.status).toBe(200);
    expect(JSON.stringify(later.body)).toContain("umc-proof-page");
    await pause(2_000);
    expect(prompts, "one Allow for the whole session").toBe(1);
    note(`session 1 done: ${prompts} Allow prompt(s)`);

    // The picker stays usable: back to the bot's own browser, then Use my Chrome again.
    await stop(bot);
    const held = await api("POST", `/api/bots/${bot.id}/browser`, { action: "take" });
    expect(held.status).toBe(200);
    // Switching while control is held is refused until the panel returns it (it does this itself).
    expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false })).status).toBe(409);
    expect((await api("POST", `/api/bots/${bot.id}/browser`, { action: "release", generation: held.body.generation, control: held.body.control })).status).toBe(200);
    const own = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false });
    note(`switch to own browser: ${own.status}`);
    expect(own.status).toBe(200);
    const back = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "auto" });
    note(`switch back to Use my Chrome: ${back.status}`);
    expect(back.status).toBe(200);
    // A new session: Chrome asks once more, then everything rides that connection.
    const third = await startTurn(bot, "real-chrome-three");
    const reopened = open(third, pageUrl);
    await waitForPrompt(2);
    await clickAllow();
    expect((await reopened).status).toBe(200);
    for (let step = 0; step < 3; step += 1) expect((await snapshot(third)).status).toBe(200);
    await pause(2_000);
    expect(prompts, "one Allow per session").toBe(2);
    await screenshot("session-two-driven");
    note(`session 2 done: ${prompts} Allow prompt(s) in all`);
    await stop(bot);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: false })).status).toBe(200);
  }, 300_000);

  it("goes through Murage for Chrome once it is paired: no Allow prompt at all, and the bot drives the owner's Chrome", async () => {
    const extension = join(process.cwd(), "dist-native", "browser-extension", "extension");
    expect(existsSync(join(extension, "manifest.json")), "node scripts/prepare-browser-extension.mjs --mode development").toBe(true);
    const bot = (await api("POST", "/api/bots", { name: "Real Chrome extension", modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, computer: "off" })).status).toBe(200);
    // The owner's Connect: Murage registers its helper for Google Chrome (under the fixture's HOME).
    const connect = await api("POST", `/api/bots/${bot.id}/browser-extension`, { action: "connect", browser: "chrome" });
    note(`extension connect: ${connect.status} ${JSON.stringify(connect.body).slice(0, 300)}`);
    expect(connect.status).toBe(200);
    // The owner adds Murage for Chrome the way branded Chrome allows (it ignores --load-extension):
    // chrome://extensions, Developer mode, Load unpacked.
    const before = prompts;
    await x("xdotool", ["key", "ctrl+l"]); await pause(400);
    await x("xdotool", ["type", "--delay", "20", "chrome://extensions"]); await x("xdotool", ["key", "Return"]); await pause(2_500);
    await x("xdotool", ["mousemove", "1034", "125", "click", "1"]); await pause(1_500);
    await x("xdotool", ["mousemove", "95", "181", "click", "1"]); await pause(2_500);
    await x("xdotool", ["key", "ctrl+l"]); await pause(400);
    await x("xdotool", ["type", "--delay", "15", extension]); await pause(800);
    await x("xdotool", ["key", "Return"]); await pause(1_500);
    // The first click closes the folder name suggestions, the second opens the folder.
    for (let click = 0; click < 2; click += 1) { await x("xdotool", ["mousemove", "1074", "798", "click", "1"]); await pause(1_500); }
    let status = await api("GET", `/api/bots/${bot.id}/browser-extension`);
    for (let poll = 0; poll < 60 && !(status.body.profiles ?? []).some((profile: any) => ["chrome", "chromium"].includes(String(profile.browser).toLowerCase())); poll += 1) { await pause(1_000); status = await api("GET", `/api/bots/${bot.id}/browser-extension`); }
    note(`extension status: ${JSON.stringify({ profiles: status.body.profiles, helper: status.body.helper }).slice(0, 400)}`);
    await screenshot("extension-loaded");
    // Murage for Chrome names itself "chromium" even in Google Chrome (runtime.mjs hello).
    expect((status.body.profiles ?? []).some((profile: any) => ["chrome", "chromium"].includes(String(profile.browser).toLowerCase())), "Murage for Chrome paired in Google Chrome").toBe(true);
    // The picker's "Use my Chrome": paired, so the server picks the extension.
    const picked = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "auto", browserApproval: "full" });
    note(`picked Use my Chrome with extension paired: ${picked.status} transport=${picked.body.bot?.browserTransport}`);
    expect(picked.status).toBe(200);
    expect(picked.body.bot.browserTransport).toBe("extension");
    // A "chromium" hello could be Edge or Brave, so the server never pins it: the panel asks.
    expect(picked.body.bot.browserExtensionProfileId, "a chromium hello is never pinned").toBeUndefined();
    // The owner's choice in "Choose a profile" (BrowserExtensionPanel onProfile sends exactly this).
    const chosen = (status.body.profiles ?? []).find((profile: any) => String(profile.browser).toLowerCase() === "chromium") ?? (status.body.profiles ?? [])[0];
    const choice = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: chosen.profileId });
    note(`owner chose profile: ${choice.status} transport=${choice.body.bot?.browserTransport} pinned=${choice.body.bot?.browserExtensionProfileId === chosen.profileId}`);
    expect(choice.status).toBe(200);
    expect(choice.body.bot.browserExtensionProfileId).toBe(chosen.profileId);
    const token = await startTurn(bot, "real-chrome-extension");
    const listed = await rpc(token, "tools/list");
    expect(listed.status).toBe(200);
    tools = listed.body.tools ?? listed.body.result?.tools ?? [];
    note(`extension tools: ${tools.map((item) => item.name).join(", ")}`);
    const opened = await allowingCards(bot, open(token, pageUrl));
    note(`extension open body: ${JSON.stringify(opened.body).slice(0, 300)}`);
    expect(opened.status).toBe(200);
    const read = await allowingCards(bot, rpc(token, "tools/call", { name: tool(/snapshot|read/u).name, arguments: {} }));
    note(`extension read body: ${JSON.stringify(read.body).slice(0, 300)}`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain("umc-proof-page");
    await screenshot("extension-driven");
    await pause(2_000);
    expect(prompts, "no remote-debugging Allow prompt on the extension route").toBe(before);
    note(`extension route done: ${prompts - before} new Allow prompt(s)`);
    await stop(bot);
  }, 300_000);

  it("works in tabs of its own with 25 of the owner's tabs open, one of them a sign-in page, and never reaches them", async () => {
    // The owner's tabs: 24 plain pages and a sign-in page with a password field.
    for (let tab = 0; tab < 25; tab += 1) {
      await x("xdotool", ["key", "ctrl+t"]); await pause(300);
      await x("xdotool", ["type", "--delay", "5", tab === 12 ? `${pageUrl.replace("/proof", "/owner-signin")}?tab=${tab}` : `${pageUrl}?owner=${tab}`]);
      await x("xdotool", ["key", "Return"]); await pause(300);
    }
    await pause(2_000); await screenshot("owner-25-tabs");
    const bot = (await api("POST", "/api/bots", { name: "Own tabs", modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: false, computer: "off" })).status).toBe(200);
    const picked = await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: "auto" });
    expect(picked.status).toBe(200);
    // Murage for Chrome is still paired from the test before: this bot goes through remote debugging by choice.
    if (picked.body.bot.browserTransport === "extension") expect((await api("PATCH", `/api/bots/${bot.id}`, { useMyChrome: true, browserTransport: null, browserExtensionProfileId: null })).status).toBe(200);
    note(`own-tabs bot on ${picked.body.bot.browserTransport ?? "remote debugging"}`);
    const token = await startTurn(bot, "real-chrome-own-tabs");
    tools = ((await rpc(token, "tools/list")).body.tools ?? []);
    const before = prompts;
    const first = open(token, `${pageUrl}?bot=1`);
    await waitForPrompt(before + 1); await clickAllow();
    const opened = await first;
    note(`own-tabs open: ${opened.status} ${JSON.stringify(opened.body).slice(0, 200)}`);
    expect(opened.status, "the first step works with 25 owner tabs open").toBe(200);
    const shot = await snapshot(token);
    expect(shot.status).toBe(200);
    expect(JSON.stringify(shot.body)).toContain("umc-proof-page");
    // The bot's tab list holds only its own tab.
    const listed = await rpc(token, "tools/call", { name: tool(/tab_list/u).name, arguments: {} });
    expect(listed.status).toBe(200);
    const text = JSON.stringify(listed.body);
    const listedTabs = [...text.matchAll(/tabId\\+":\s*\\+"(t\d+)\\+"[^}]*?url\\+":\s*\\+"([^"\\]*)/gu)].map((match) => `${match[1]} ${match[2]}`);
    note(`own-tabs tab_list: ${JSON.stringify(listedTabs)}, owner tab named: ${/owner=|owner-signin/u.test(text)}`);
    expect(text).toContain("bot=1");
    expect(text).not.toMatch(/owner=|owner-signin/u);
    // No switch reaches an owner's tab.
    for (const tab of ["t2", "t13", "t26"]) {
      const switched = await rpc(token, "tools/call", { name: tool(/tab_switch/u).name, arguments: { tab } });
      const read = await snapshot(token);
      note(`own-tabs switch ${tab}: ${switched.status}; read after: ${read.status} owner page read: ${/owner-signin-page/u.test(JSON.stringify(read.body))}`);
      expect(JSON.stringify(read.body)).not.toContain("owner-signin-page");
    }
    await screenshot("own-tabs-driven");
    expect(prompts - before, "one Allow for this session").toBe(1);
    await stop(bot);
  }, 300_000);
});

