import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceBudget, handleTranscribeRoute } from "../../server/voice/transcribe-route";
import { TranscriptionUnavailable } from "../../server/voice/flux-voice";

// Real Composer + StoreProvider + transcription HTTP registrar. Only the
// external paid provider is replaced; no key/private audio leaves this rig.
const bot = { id: "audio-bot", name: "Audio fixture", color: "blue", threadId: "audio-thread", modelSelection: { instanceId: "fixture", model: "text-model" }, tasks: [], messages: [], description: "", title: "" };
const audio = Buffer.alloc(48); audio.write("RIFF"); audio.writeUInt32LE(40, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(4, 40);
let server: ViteDevServer, origin: string, cache: string;
let configured = true, mode: "success" | "hold" | "error" = "success", release = () => {};
let budget = createVoiceBudget();
const calls: Array<{ mime?: string; model?: string; hex: string }> = [];
const unexpectedPosts: string[] = [];
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-audio-ui-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": root + "/src" } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "audio-intake-fixture", resolveId(id) { if (id === "/__audio.js") return "\0audio-intake"; },
      load(id) { if (id !== "\0audio-intake") return; return `
        import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {Composer} from '/src/components/Composer.tsx';import '/src/styles.css';
        document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';
        function Probe(){const {state}=useStore();if(!state.bots[0]||!state.instances.length)return React.createElement('output',null,'loading');return React.createElement(React.Fragment,null,React.createElement('output',null,state.bots[0].modelSelection.instanceId+'/'+state.bots[0].modelSelection.model),React.createElement(Composer,{bot:state.bots[0]}));}
        createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Probe)));`; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://fixture"), path = url.pathname;
        const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (path === "/__audio") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding-top:24px;max-width:720px;margin:auto"></main><script type="module" src="/__audio.js"></script>'); }
        else if (path === "/api/voice/transcribe") void handleTranscribeRoute(req.method!, url, req, res, { env: {}, budget, transcribe: async (recording, options) => {
          calls.push({ mime: recording.mime, model: options?.model, hex: Buffer.from(recording.bytes).toString("hex") });
          if (mode === "hold") await new Promise<void>(resolve => { release = resolve; });
          if (mode === "error") throw new TranscriptionUnavailable("premium", "Fixture plan does not cover transcription");
          return { text: "Fixture transcript to review", language: "en", duration: 1, model: "flux-voice-fast", billedSeconds: 10 };
        } });
        else if (req.method === "POST") { unexpectedPosts.push(path); json({ error: "Unexpected fixture mutation" }, 400); }
        else if (path === "/api/desktop-secret") json({ error: "Not found" }, 404);
        else if (path === "/api/events") { res.statusCode = 204; res.end(); }
        else if (path === "/api/bots") json({ bots: [bot], groups: [] });
        else if (path === "/api/config") json({ surface: "remote", features: {}, flux: { configured }, rooms: { turnTimeoutMinutes: 5 } });
        else if (path === "/api/instances") json({ instances: [{ instanceId: "fixture", driverKind: "fixture", displayName: "Fixture", snapshot: { state: "available", authenticated: true }, models: { default: "text-model", options: [{ id: "text-model", label: "Text model" }] }, capabilities: { images: true } }] });
        else if (path === "/api/routines") json({ routines: [], runs: [] });
        else if (path === "/api/webhooks") json({ webhooks: [], attempts: [] });
        else if (path.startsWith("/api/")) json({ error: "Unexpected fixture route" }, 404); else next();
      }); },
    }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(() => { configured = true; mode = "success"; calls.length = 0; unexpectedPosts.length = 0; budget = createVoiceBudget(); release = () => {}; });
test.afterEach(() => release());
test.afterAll(async () => { release(); await server?.close(); rmSync(cache, { recursive: true, force: true }); });
async function open(page: Page, skin = "dark") { await page.goto(origin + "/__audio?skin=" + skin); await expect(page.locator("output")).toHaveText("fixture/text-model"); }
async function pick(page: Page) { await page.locator('input[type="file"]').setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: audio }); }
const transcribe = (page: Page) => page.getByRole("button", { name: "Transcribe with Flux (uses credits)", exact: true });

test("pick asks before real route upload, pins the alias, edits transcript and preserves the chosen engine/draft", async ({ page }, info) => {
  await open(page); await page.getByRole("textbox").fill("Keep my notes"); await pick(page);
  await expect(transcribe(page)).toBeVisible(); expect(calls).toHaveLength(0); expect(unexpectedPosts).toHaveLength(0);
  await expect(page.getByText(/up to 4 MiB/)).toBeVisible(); await page.screenshot({ path: info.outputPath("audio-consent-desktop.png"), fullPage: true });
  await transcribe(page).click(); await expect(page.getByRole("textbox", { name: "Review transcript" })).toHaveValue("Fixture transcript to review");
  expect(calls).toEqual([{ mime: "audio/wav", model: "flux-voice-fast", hex: audio.toString("hex") }]);
  await page.getByRole("textbox", { name: "Review transcript" }).fill("My reviewed transcript");
  await page.screenshot({ path: info.outputPath("audio-transcript-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Add transcript to draft" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Keep my notes"); await expect(page.getByText("My reviewed transcript", { exact: true })).toBeVisible();
  await expect(page.locator("output")).toHaveText("fixture/text-model"); expect(unexpectedPosts).toEqual([]);
});
test("drop queues locally and cancellation never retries or adds an attachment", async ({ page }) => {
  mode = "hold"; await open(page);
  await page.evaluate(bytes => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "drop.wav", { type: "audio/wav" })); window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data })); }, Array.from(audio));
  await expect(transcribe(page)).toBeVisible(); expect(calls).toHaveLength(0);
  await transcribe(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => calls.length).toBe(1); await page.getByRole("button", { name: "Cancel transcription" }).click();
  await expect(page.getByRole("alert")).toContainText("Cancelled locally"); await expect(transcribe(page)).toBeEnabled();
  expect(calls).toHaveLength(1); expect(unexpectedPosts).toEqual([]); release();
});
test("missing key and plan refusal remain actionable without retries", async ({ page }) => {
  configured = false; await open(page); await pick(page); await expect(transcribe(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open engine settings" })).toBeVisible(); expect(calls).toHaveLength(0);
  configured = true; mode = "error"; await page.reload(); await pick(page); await transcribe(page).click();
  await expect(page.getByRole("alert")).toContainText("paid Flux plan"); expect(calls).toHaveLength(1); await expect(page.getByRole("textbox", { name: "Review transcript" })).toHaveCount(0);
});
test("oversized or unsupported audio is refused before upload", async ({ page }) => {
  await open(page); await page.locator('input[type="file"]').setInputFiles({ name: "large.wav", mimeType: "audio/wav", buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
  await expect(page.getByText(/Audio transcription accepts files up to 4 MiB/)).toBeVisible(); expect(calls).toHaveLength(0);
  await page.locator('input[type="file"]').setInputFiles({ name: "unsupported.aac", mimeType: "audio/aac", buffer: audio });
  await expect(page.getByText(/Audio transcription accepts Ogg/)).toBeVisible(); await expect(transcribe(page)).toHaveCount(0); expect(unexpectedPosts).toEqual([]);
});
test("mobile light consent remains readable before any paid request", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page, "light"); await pick(page);
  await expect(transcribe(page)).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("audio-consent-mobile.png"), fullPage: true }); expect(calls).toHaveLength(0);
});
