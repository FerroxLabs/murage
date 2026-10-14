// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The user-felt flows of the scale rig, timed in Chromium against a running server.
//   node pw.mjs <url> <secret> <mode> <out.json> [seconds]
//   mode flows : app start, open the longest conversation, switch between two bots, App settings › Engines, bot settings
//   mode type  : type into the composer for <seconds> (the background-CPU scenario samples the server meanwhile)
// Prints one line "PW <json>" with every sample in ms. Run from the tree under test (it loads its @playwright/test).
// Network waterfall (app start and Settings › Engines): every request of the flow (API, scripts, styles, fonts), with
// its start and end in ms from the flow's start, status and bytes, in out.waterfall[flow][rep]; app start also keeps the
// page's own navigation and resource timing. The row shaping is rig-config.mjs waterfallRows.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waterfallRows } from "./rig-config.mjs";

const [url, secret, mode, outFile, secondsArg] = process.argv.slice(2);
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
const out = { mode, flows: {}, errors: [], waterfall: {} };
const LONG = process.env.PW_LONG_BOT ?? "Atlas", A = process.env.PW_SWITCH_A ?? "Nova", B = process.env.PW_SWITCH_B ?? "Orion";

let lastPage = null;
// When a wait fails: what the page showed (screenshot) and said (first 2 KB of its text), next to the results file.
async function diagnose(label, page = lastPage) {
  if (!page) return;
  const base = join(dirname(outFile), `pw-fail-${mode}-${label.replace(/[^\w.-]+/g, "_")}`);
  try { await page.screenshot({ path: `${base}.png` }); } catch {}
  try { writeFileSync(`${base}.txt`, (await page.evaluate(() => document.body.innerText)).slice(0, 2048)); } catch {}
  out.errors.push(`${label}: saved ${base}.png and ${base}.txt`);
}
// A setup step that may fail without costing the flows after it.
async function setup(label, fn) { try { await fn(); return true; } catch (error) { out.errors.push(`${label}: ${String(error.message).slice(0, 200)}`); await diagnose(label); return false; } }
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } });
  await ctx.addInitScript(() => { try { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); } catch {} });
  const page = await ctx.newPage();
  lastPage = page;
  const live = new Map();
  // every request of the page, for the waterfall: start here, end and size when it finishes or fails
  const net = [];
  page.on("request", r => {
    net.push({ request: r, start: performance.now() });
    if (r.url().includes("/api/") && !r.url().includes("/api/events")) live.set(r, performance.now());
  });
  const ended = (r, failed) => {
    live.delete(r);
    const row = net.find(n => n.request === r && n.end === undefined);
    if (!row) return;
    row.end = performance.now(); row.failed = failed ? (r.failure()?.errorText ?? "failed") : undefined;
    // sizes and status resolve later; the waterfall awaits them
    row.detail = failed ? Promise.resolve({}) : Promise.all([r.sizes().catch(() => null), r.response().catch(() => null)]).then(([sz, res]) => ({ bytes: sz ? sz.responseBodySize + sz.responseHeadersSize : undefined, bodyBytes: sz?.responseBodySize, status: res?.status() }));
  };
  page.on("requestfinished", r => ended(r, false)); page.on("requestfailed", r => ended(r, true));
  // the rows of requests that started at or after t0 (and are taken out, so the next flow starts empty)
  const waterfall = async t0 => {
    const taken = net.filter(n => n.start >= t0);
    for (const n of taken) net.splice(net.indexOf(n), 1);
    const rows = [];
    for (const n of taken) rows.push({ url: n.request.url(), method: n.request.method(), type: n.request.resourceType(), start: n.start, end: n.end, failed: n.failed, ...(n.detail ? await n.detail : {}) });
    return waterfallRows(rows, t0, url);
  };
  // settled: no API request in flight for `quiet` ms
  const settle = async (t0, quiet = 500, cap = 60000) => { let q = performance.now(); while (performance.now() - t0 < cap) { if (live.size) q = performance.now(); else if (performance.now() - q >= quiet) return Math.round(q - t0); await new Promise(r => setTimeout(r, 20)); } return -1; };
  return { ctx, page, settle, waterfall };
}
const keepWaterfall = (flow, entry) => { (out.waterfall[flow] ??= []).push(entry); };
const botButton = (page, name) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
async function sample(name, reps, fn) {
  const rows = [];
  for (let i = 0; i < reps; i++) { try { rows.push(await fn(i)); } catch (error) { out.errors.push(`${name}#${i}: ${String(error.message).slice(0, 200)}`); await diagnose(`${name}-${i}`); } }
  out.flows[name] = { usable: rows.map(r => r.usable).filter(n => n >= 0), settled: rows.map(r => r.settled).filter(n => n >= 0) };
  // click to rows, timed inside the page (see clickToRows)
  const inPage = rows.map(r => r.inPage).filter(n => typeof n === "number" && n >= 0);
  if (inPage.length) out.flows[name].inPage = inPage;
}
const ROWS_TEXT = /Open items on .* follow|Summarise the open items/;
// Click to rows on screen, measured in the page itself: the click is
// dispatched there, a MutationObserver watches for the named bot's transcript
// to hold a row with the expected text, and the time is read after the next
// animation frame (the frame that paints it). No Playwright actionability
// checks or CDP round trips are inside the number; `usable` keeps those.
async function clickToRows(page, name) {
  const handle = await botButton(page, name).elementHandle();
  return handle.evaluate((button, { label, source }) => new Promise((resolve) => {
    const re = new RegExp(source);
    const shown = () => {
      const log = document.querySelector(`[role="log"][aria-label="${label}"]`);
      return Boolean(log && [...log.querySelectorAll("[data-row]")].some((row) => re.test(row.textContent ?? "")));
    };
    const t0 = performance.now();
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; observer.disconnect(); clearTimeout(timer); resolve(value); };
    const check = () => { if (shown()) requestAnimationFrame(() => finish(Math.round(performance.now() - t0))); };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(-1), 60000);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
    button.click();
    check();
  }), { label: `Conversation with ${name}`, source: ROWS_TEXT.source });
}

if (mode === "flows") {
  // 1. app start: page load until the bot list shows the longest conversation's bot
  await sample("appStart", 3, async () => {
    const { ctx, page, settle, waterfall } = await context();
    const t0 = performance.now();
    await page.goto(url);
    await botButton(page, LONG).waitFor({ timeout: 120000 });
    const r = { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
    // the page's own view: navigation timing and every resource it loaded (transfer and body sizes)
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const pick = e => ({ name: e.name.replace(location.origin, ""), type: e.initiatorType, start: Math.round(e.startTime), end: Math.round(e.responseEnd), transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize });
      return { navigation: nav ? { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), responseEnd: Math.round(nav.responseEnd), transferSize: nav.transferSize } : null, resources: performance.getEntriesByType("resource").map(pick) };
    }).catch(error => ({ error: String(error.message).slice(0, 200) }));
    keepWaterfall("appStart", { usable: r.usable, settled: r.settled, requests: await waterfall(t0), ...timing });
    await ctx.close(); return r;
  });
  const { page, settle, waterfall } = await context();
  await setup("flows-setup", async () => {
    await page.goto(url);
    await botButton(page, LONG).waitFor({ timeout: 120000 });
    await settle(performance.now());
  });
  // 2. open the longest conversation from another bot: first page painted.
  // Each rep is timed twice: by Playwright (usable) and in the page (inPage).
  await sample("openLongThread", 3, async () => {
    await botButton(page, A).click(); await settle(performance.now());
    const t0 = performance.now();
    await botButton(page, LONG).click();
    await page.getByText(ROWS_TEXT).last().waitFor({ timeout: 60000 });
    const r = { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
    await botButton(page, A).click(); await settle(performance.now());
    r.inPage = await clickToRows(page, LONG); await settle(performance.now());
    return r;
  });
  // 3. switch between two bots with history: click to their rows on screen
  await sample("switchConversation", 6, async (i) => {
    const name = i % 2 ? A : B;
    const t0 = performance.now();
    await botButton(page, name).click();
    await page.getByRole("button", { name: new RegExp(`Open ${name}.s profile`) }).first().waitFor({ timeout: 60000 });
    await page.getByText(ROWS_TEXT).last().waitFor({ timeout: 60000 });
    const r = { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
    // the same switch again, timed in the page: away to the other bot, then back
    await botButton(page, i % 2 ? B : A).click(); await settle(performance.now());
    r.inPage = await clickToRows(page, name); await settle(performance.now());
    return r;
  });
  // 4. App settings, then the Engines section settled
  await sample("settingsEngines", 3, async () => {
    const t0 = performance.now();
    await page.getByRole("button", { name: "App settings", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.waitFor({ timeout: 60000 });
    const s0 = performance.now();
    const entry = dialog.getByRole("navigation").getByRole("button", { name: "Engines", exact: true });
    if (await entry.count()) await entry.click();
    const r = { usable: Math.round(s0 - t0), settled: await settle(s0) };
    keepWaterfall("settingsEngines", { usable: r.usable, settled: r.settled, requests: await waterfall(t0) });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    return r;
  });
  // 5. bot settings of the longest conversation's bot
  await sample("botSettings", 3, async () => {
    await botButton(page, LONG).click();
    const profile = page.getByRole("button", { name: new RegExp(`Open ${LONG}.s profile`) }).first();
    await profile.waitFor({ timeout: 60000 }); await settle(performance.now());
    const t0 = performance.now();
    await profile.click();
    const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true });
    await dialog.waitFor({ timeout: 60000 });
    const r = { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    return r;
  });
} else if (mode === "type") {
  const { page, settle } = await context();
  const box = page.locator("textarea").first();
  const ready = await setup("type-setup", async () => {
    await page.goto(url);
    await botButton(page, A).waitFor({ timeout: 120000 });
    await botButton(page, A).click(); await settle(performance.now());
    await box.waitFor({ timeout: 60000 });
    await box.click();
  });
  // the rig samples CPU only from here on (page load and first paint are not the owner typing)
  if (ready) writeFileSync(`${outFile}.start`, String(Date.now()));
  const until = ready ? performance.now() + Number(secondsArg ?? 30) * 1000 : 0;
  const keys = [];
  // the owner composing a long message: one key every ~90 ms, never sent
  while (performance.now() < until) {
    const t = performance.now();
    await page.keyboard.type("the quarterly numbers moved ", { delay: 90 });
    keys.push(Math.round((performance.now() - t) / 28));
    await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
  }
  out.flows.typing = { msPerKey: keys };
}
await browser.close();
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log("PW " + JSON.stringify(out));
