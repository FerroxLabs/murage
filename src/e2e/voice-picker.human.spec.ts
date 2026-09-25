// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The voice picker in a real browser: the real VoiceSettings, VoicePicker
// and speaker, with the harness's /api/tts routes answered here. Audio is a
// local 3 s tone; nothing calls Flux or xAI, and no key exists.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLUX_VOICES } from "../../server/tts/flux-speech.ts";
import { XAI_VOICES } from "../../server/tts/xai-speech.ts";
import { axeScriptPath } from "./axe";
import { laneDataDir } from "./lane-data-dir";

/** 3 s of a 330 Hz tone, mp3. */
const TONE = readFileSync(fileURLToPath(new URL("./speech-streaming-tone.mp3", import.meta.url)));
/** How long the stand-in takes to start sending audio, so Loading shows. */
const PREPARE_MS = 500;
/** A voice whose preview the stand-in refuses, as Flux does when speech is off. */
const FAILING = "fable";
const REFUSAL = "Flux voices aren't switched on for this account yet.";

let vite: ViteDevServer, origin: string;
const seen = { voices: 0, speak: [] as string[] };

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cache = join(laneDataDir("the voice picker spec's vite cache"), "voice-picker-vite-cache");
  mkdirSync(cache, { recursive: true });
  const voices = JSON.stringify({ voices: [...FLUX_VOICES, ...XAI_VOICES] });
  vite = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: [
      { find: /^@\/state\/store$/, replacement: join(root, "src/e2e/voice-picker-store.ts") },
      { find: "@", replacement: join(root, "src") },
    ] },
    // bundled up front: a first run that discovers them reloads the page mid-test
    optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-dev-runtime", "react-dom/client", "lucide-react", "clsx", "tailwind-merge"] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "voice-picker-fixture",
      resolveId(id) { if (id === "/__voices.js") return "\0voice-picker-fixture"; },
      load(id) {
        if (id !== "\0voice-picker-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {VoiceSettings} from '/src/components/VoiceSettings.tsx';import {speaker} from '/src/lib/tts/index.ts';import '/src/styles.css';
const skin=new URLSearchParams(location.search).get('skin')||'light';
document.documentElement.setAttribute('data-skin',skin);
window.__patches=[];window.__speaker=speaker;
function Surface(){const [bot,setBot]=React.useState({id:'voice-proof-bot',name:'Nova',voice:'nova',voiceProvider:'flux',speakReplies:false});
return React.createElement('main',{style:{maxWidth:640,margin:'0 auto',padding:16}},React.createElement(VoiceSettings,{bot,onPatch:(patch)=>{window.__patches.push(patch);setBot(b=>({...b,...patch}));}}));}
createRoot(document.getElementById('root')).render(React.createElement(Surface));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0];
          if (path === "/__voices") {
            res.setHeader("content-type", "text/html");
            return res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice picker</title></head><body style="margin:0;background:var(--color-app)"><div id="root"></div><script type="module" src="/__voices.js"></script></body></html>');
          }
          if (path === "/api/tts/voices") {
            seen.voices += 1;
            res.setHeader("content-type", "application/json");
            return res.end(voices);
          }
          if (path === "/api/tts/prepare") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ready: true, utterances: [JSON.parse(body).text] }));
            });
            return;
          }
          if (path !== "/api/tts/speak") return next();
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            const { voiceId } = JSON.parse(body) as { voiceId?: string };
            seen.speak.push(voiceId ?? "");
            setTimeout(() => {
              if (res.destroyed) return;
              if (voiceId === FAILING) {
                res.writeHead(503, { "content-type": "application/json" });
                return res.end(JSON.stringify({ error: REFUSAL }));
              }
              res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
              res.end(TONE);
            }, PREPARE_MS);
          });
        });
      },
    }],
  });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("The voice picker fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); });
test.beforeEach(() => Object.assign(seen, { voices: 0, speak: [] }));

async function open(page: Page, skin = "light") {
  await page.goto(`${origin}/__voices?skin=${skin}`);
  const list = page.getByRole("listbox", { name: "Nova's voice" });
  await expect(list.getByRole("option")).toHaveCount(41, { timeout: 20_000 });
  return list;
}

const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}\\b`) });

test("the chosen voice is marked and in view, and nothing is fetched to play until a play button is pressed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const kira = option(page, "Kira");
  await expect(kira).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await expect(kira).toBeInViewport();
  // 44px targets: every row and every play button
  const rowBox = (await kira.boundingBox())!;
  const playBox = (await page.getByRole("button", { name: "Play Kira", exact: true }).boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  expect(playBox.height).toBeGreaterThanOrEqual(44);
  expect(playBox.width).toBeGreaterThanOrEqual(44);
  // the play button sits on its own row
  expect(playBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
  expect(playBox.y + playBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  await expect(page.getByText("Every voice speaks every language.", { exact: true })).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(seen.voices).toBe(1);
  expect(seen.speak).toEqual([]);
});

test("choosing by keyboard: arrows, Home, End, typing a name, Enter", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("searchbox", { name: "Search voices" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "Kira")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "Luke")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(option(page, "Kira")).toBeFocused();
  await page.keyboard.press("End");
  await expect(option(page, "Zoe")).toBeFocused();
  await expect(option(page, "Zoe")).toBeInViewport();
  await page.keyboard.press("Home");
  await expect(option(page, "Adrian")).toBeFocused();
  await page.keyboard.type("ru");
  await expect(option(page, "Rupert")).toBeFocused();
  // moving is not choosing
  await expect(option(page, "Kira")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(option(page, "Rupert")).toHaveAttribute("aria-selected", "true");
  await expect(option(page, "Kira")).toHaveAttribute("aria-selected", "false");
  expect(await page.evaluate(() => (window as any).__patches)).toEqual([{ voice: "fable" }]);
  // Space chooses too, and Tab goes on to the focused row's play button
  await page.waitForTimeout(700);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(option(page, "Ryan")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Play Ryan", exact: true })).toBeFocused();
  expect(seen.speak).toEqual([]);
});

test("one preview at a time: playing a second voice stops the first", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole("button", { name: "Play Nora", exact: true }).click();
  await expect(page.getByRole("button", { name: "Loading Nora", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Nora", exact: true })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath("voice-picker-playing-1440-light.png") });

  await page.getByRole("button", { name: "Play Owen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play Nora", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Owen", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-preview="playing"], [data-preview="loading"]')).toHaveCount(1);
  expect(seen.speak).toEqual(["marin", "cedar"]);
  // playing is not choosing
  await expect(option(page, "Kira")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Stop Owen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play Owen", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speaker.state.status)).toBe("idle");
});

test("a preview that fails says so on its own row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await option(page, "Rupert").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Play Rupert", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(`Couldn't play Rupert. ${REFUSAL}`);
  await expect(option(page, "Rupert")).toContainText("Couldn't play");
  await expect(option(page, "Nora")).not.toContainText("Couldn't play");
  // the next preview clears it
  await page.getByRole("button", { name: "Play Nora", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("search and filters narrow the list, and clear back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const list = await open(page);
  await page.getByRole("searchbox", { name: "Search voices" }).fill("british");
  await expect(list.getByRole("option")).toHaveCount(4);
  const filters = page.getByRole("group", { name: "Filter voices" });
  await filters.getByRole("button", { name: "Female", exact: true }).click();
  await expect(filters.getByRole("button", { name: "Female", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(option(page, "Harriet")).toBeVisible();
  await filters.getByRole("button", { name: "Neutral", exact: true }).click();
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(page.getByText("No voices match.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(list.getByRole("option")).toHaveCount(41);
  await expect(option(page, "Kira")).toBeInViewport();
  await filters.getByRole("button", { name: "British", exact: true }).click();
  await expect(list.getByRole("option")).toHaveCount(4);
});

for (const skin of ["light", "dark"] as const) {
  test(`reads well in the ${skin} skin at 1440 and 390, with no accessibility violations`, async ({ page }, testInfo) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, skin);
      await expect(option(page, "Kira")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // the play button stays inside the list's box at every width
      const list = (await page.getByRole("listbox", { name: "Nova's voice" }).boundingBox())!;
      const play = (await page.getByRole("button", { name: "Play Kira", exact: true }).boundingBox())!;
      expect(play.x + play.width).toBeLessThanOrEqual(list.x + list.width + 1);
      await page.screenshot({ path: testInfo.outputPath(`voice-picker-${width}-${skin}.png`), fullPage: true });
      await page.addScriptTag({ path: axeScriptPath });
      const result = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
      const violations = result.violations.map((v: { id: string; nodes: Array<{ target: string[] }> }) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(violations).toEqual([]);
    }
  });
}
