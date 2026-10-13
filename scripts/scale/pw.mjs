// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The user-felt flows of the scale rig, timed in Chromium against a running server.
//   node pw.mjs <url> <secret> <mode> <out.json> [seconds]
//   mode flows : app start, open the longest conversation, switch between two bots, App settings › Engines, bot settings
//   mode type  : type into the composer for <seconds> (the background-CPU scenario samples the server meanwhile)
// Prints one line "PW <json>" with every sample in ms. Run from the tree under test (it loads its @playwright/test).
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const [url, secret, mode, outFile, secondsArg] = process.argv.slice(2);
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
const out = { mode, flows: {}, errors: [] };
const LONG = process.env.PW_LONG_BOT ?? "Sable", A = process.env.PW_SWITCH_A ?? "Claudia", B = process.env.PW_SWITCH_B ?? "Capt";

async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } });
  await ctx.addInitScript(() => { try { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); } catch {} });
  const page = await ctx.newPage();
  const live = new Map();
  page.on("request", r => { if (r.url().includes("/api/") && !r.url().includes("/api/events")) live.set(r, performance.now()); });
  const done = r => live.delete(r);
  page.on("requestfinished", done); page.on("requestfailed", done);
  // settled: no API request in flight for `quiet` ms
  const settle = async (t0, quiet = 500, cap = 60000) => { let q = performance.now(); while (performance.now() - t0 < cap) { if (live.size) q = performance.now(); else if (performance.now() - q >= quiet) return Math.round(q - t0); await new Promise(r => setTimeout(r, 20)); } return -1; };
  return { ctx, page, settle };
}
const botButton = (page, name) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
async function sample(name, reps, fn) {
  const rows = [];
  for (let i = 0; i < reps; i++) { try { rows.push(await fn(i)); } catch (error) { out.errors.push(`${name}#${i}: ${String(error.message).slice(0, 200)}`); } }
  out.flows[name] = { usable: rows.map(r => r.usable).filter(n => n >= 0), settled: rows.map(r => r.settled).filter(n => n >= 0) };
}

if (mode === "flows") {
  // 1. app start: page load until the bot list shows the longest conversation's bot
  await sample("appStart", 3, async () => {
    const { ctx, page, settle } = await context();
    const t0 = performance.now();
    await page.goto(url);
    await botButton(page, LONG).waitFor({ timeout: 120000 });
    const r = { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
    await ctx.close(); return r;
  });
  const { page, settle } = await context();
  await page.goto(url);
  await botButton(page, LONG).waitFor({ timeout: 120000 });
  await settle(performance.now());
  // 2. open the longest conversation from another bot: first page painted
  await sample("openLongThread", 3, async () => {
    await botButton(page, A).click(); await settle(performance.now());
    const t0 = performance.now();
    await botButton(page, LONG).click();
    await page.getByText(/Open items on .* follow|Summarise the open items/).last().waitFor({ timeout: 60000 });
    return { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
  });
  // 3. switch between two bots with history: click to their rows on screen
  await sample("switchConversation", 6, async (i) => {
    const name = i % 2 ? A : B;
    const t0 = performance.now();
    await botButton(page, name).click();
    await page.getByRole("button", { name: new RegExp(`Open ${name}.s profile`) }).first().waitFor({ timeout: 60000 });
    await page.getByText(/Open items on .* follow|Summarise the open items/).last().waitFor({ timeout: 60000 });
    return { usable: Math.round(performance.now() - t0), settled: await settle(t0) };
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
  await page.goto(url);
  await botButton(page, A).waitFor({ timeout: 120000 });
  await botButton(page, A).click(); await settle(performance.now());
  const box = page.locator("textarea").first();
  await box.waitFor({ timeout: 60000 });
  await box.click();
  // the rig samples CPU only from here on (page load and first paint are not the owner typing)
  writeFileSync(`${outFile}.start`, String(Date.now()));
  const until = performance.now() + Number(secondsArg ?? 30) * 1000;
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
