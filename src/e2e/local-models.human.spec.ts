// Settings → Models → Local models, the picker's Local rail and the Engines
// line, in the real renderer against a real isolated server (0.1.52 LM2, spec
// V1–V5, A1, A3, T1).
//
// The acceptance bar is Sean's: someone who has never seen Murage must be able
// to add a server, test it and pick its model for a bot from the screenshots
// alone. So every state is walked the way that person would — by keyboard, in
// order, with no click that a screenshot could not explain — at phone and
// desktop width, light and dark.
//
// The "server" is a fake llama-server in this process, answering exactly what
// the real one answers (/props n_ctx, /v1/models, tool calls on chat, messages
// and responses). It serves two models: one whose tools work and one that
// answers with prose instead of calling the tool, so the failed-test marker has
// something true to mark. The live proof against SeanBeast's real llama.cpp is
// docs/plans/0152-LOCAL-MODELS-PROOF.md; this spec is what keeps the screens
// honest after that machine is switched off.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
type Launcher = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture>;

const TOOL_MODEL = "qwen3.8-27b";
const PROSE_MODEL = "chatty-7b";
const SERVER_NAME = "lm2-fake";
const botId = "local-models-proof-bot";

let fixture: Fixture, vite: ViteDevServer, origin: string, llama: Server, llamaAddress: string;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const call = { id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } };

/** A llama-server started with `-c 65536 --jinja`, two models loaded. */
async function fakeLlamaServer(): Promise<{ server: Server; address: string }> {
  const server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    const prose = body.model === PROSE_MODEL;
    switch (req.url) {
      case "/props": return send(res, 200, { default_generation_settings: { n_ctx: 65_536 }, model_path: "D:/models/qwen.gguf", total_slots: 1 });
      case "/health": return send(res, 200, { status: "ok" });
      case "/v1/models": return send(res, 200, { object: "list", data: [TOOL_MODEL, PROSE_MODEL].map((id) => ({ id, object: "model", owned_by: "llamacpp" })) });
      case "/v1/chat/completions":
        if (prose || messages.some((message) => message.role === "tool")) {
          return send(res, 200, { choices: [{ message: { role: "assistant", content: "It is 17°C and raining lightly in Paris." } }] });
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] })}\n\n`);
          return res.end("data: [DONE]\n\n");
        }
        return send(res, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [call] } }], usage: { prompt_tokens: 7_800 } });
      // Both models answer the Anthropic surface with a tool_use, so both are
      // offered to the fixture's Claude-driver engine (spec E3) — that is what
      // puts the prose model, and its warning, in the picker at all.
      case "/v1/messages": return send(res, 200, { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] });
      case "/v1/responses": return send(res, 200, { output: [{ type: "function_call", name: "get_weather", arguments: '{"city":"Paris"}' }] });
      default: return send(res, 404, { error: "not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, address: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test.beforeAll(async () => {
  ({ server: llama, address: llamaAddress } = await fakeLlamaServer());
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: Launcher };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const at=Date.now();writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'local-models-proof-task',name:'Local models proof bot',title:'',description:'',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'local-models-proof-task',title:'Proof task',createdAt:at,resumeCursors:{}}],chiefOfStaff:false,autoApprove:false,composio:false,computer:'off',browser:false}]));` });
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "local-models-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "local-models-fixture", resolveId(id) { if (id === "/__local-models.js") return "\0local-models-fixture"; },
        load(id) { if (id !== "\0local-models-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import {ModelPicker} from '/src/components/ModelPicker.tsx';import '/src/styles.css';
function Surface(){const {state,dispatch}=useStore();const bot=state.bots.find(bot=>bot.id==='${botId}');return React.createElement(React.Fragment,null,
  React.createElement('div',{style:{padding:16,maxWidth:520}},
    React.createElement('button',{type:'button',onClick:()=>dispatch({type:'toggleAppSettings',open:true})},'Open settings'),
    bot&&React.createElement('div',{style:{marginTop:16}},React.createElement(ModelPicker,{bot,contained:true,label:React.createElement('span',{className:'text-[13px] text-ink-secondary'},'Model')}))),
  state.appSettingsOpen&&React.createElement(SettingsModal));}
createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(DesktopCapabilitiesProvider,null,React.createElement(Surface))));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__local-models") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>Local models fixture</title><div id="root"></div><script type="module" src="/__local-models.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("Local models fixture did not bind"); origin = `http://127.0.0.1:${address.port}/__local-models`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { try { await fixture?.close(); } finally { await new Promise<void>((resolve) => llama?.close(() => resolve())); } } });

const skins = ["light", "dark"] as const;
const widths = [390, 1440] as const;

async function open(page: Page, skin: string, width: number) {
  await page.setViewportSize({ width, height: 960 });
  await page.addInitScript((skin) => { localStorage.setItem("murage-skin", skin); localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); }, skin);
  await page.goto(origin);
  await page.evaluate((skin) => { document.documentElement.dataset.skin = skin; }, skin);
}

/** The settings body scrolls inside the modal, so a page screenshot would
 *  crop the section. Capture the element in full, and the viewport beside it
 *  for the surrounding context a reviewer needs. */
async function shoot(page: Page, target: import("@playwright/test").Locator, path: string) {
  // The modal sizes itself to the viewport, so a section taller than the
  // window is clipped by its own scroll box. Give the window the height for
  // one full capture, then put it back for the viewport shot.
  const { width, height } = page.viewportSize()!;
  await page.setViewportSize({ width, height: 2600 });
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path });
  await page.setViewportSize({ width, height });
  await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.replace(/\.png$/, ".viewport.png") });
}

/** Keyboard only: Tab forward until the focused element reads `name`. */
async function tabTo(page: Page, name: string | RegExp, limit = 120) {
  const matches = (text: string) => typeof name === "string" ? text.trim() === name : name.test(text.trim());
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el ? (el.getAttribute("aria-label") || el.textContent || "") : ""; });
    if (matches(focused)) return;
  }
  throw new Error(`Tab never reached "${name}"`);
}

const focusedText = (page: Page) => page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el ? (el.getAttribute("aria-label") || el.textContent || "").trim() : ""; });

/** Open Settings on a section the way a person does: the modal first, then
 *  its own navigation. Models and Engines are desktop-only, so they are not
 *  there to jump to until the surface has been confirmed — the nav is. */
async function openSettings(page: Page, section: "Models" | "Engines") {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true }); await expect(dialog).toBeVisible();
  const entry = dialog.getByRole("navigation").getByRole("button", { name: section, exact: true });
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  return dialog;
}

async function removeEveryServer(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const section = dialog.locator("#local-models");
  for (;;) {
    const remove = section.getByRole("button", { name: /^Remove / }).first();
    if (!(await remove.count())) break;
    await remove.click();
    await section.getByRole("button", { name: "Remove this server", exact: true }).click();
    await expect(section.getByText("No model server is running on this computer.", { exact: true })).toBeVisible();
  }
}

for (const skin of skins) for (const width of widths) test(`Local models: found nothing → add by keyboard → test → use, at ${width}px ${skin}`, async ({ page }, testInfo) => {
  await open(page, skin, width);
  const dialog = await openSettings(page, "Models");
  const section = dialog.locator("#local-models");
  await expect(section.getByRole("heading", { name: "Local models", exact: true })).toBeVisible();

  // V1 — the section is there with nothing detected, and it says where it looked.
  await expect(section.getByText("No model server is running on this computer.", { exact: true })).toBeVisible();
  const looked = section.getByText(/^Looked for /);
  await expect(looked).toContainText("Ollama at 127.0.0.1:11434");
  await expect(looked).toContainText("LM Studio at 127.0.0.1:1234");
  await expect(looked).toContainText("llama.cpp at 127.0.0.1:8080");
  await expect(looked).toContainText("vLLM at 127.0.0.1:8000");
  await expect(looked).toContainText("nothing answered");
  await expect(section.getByRole("button", { name: "Add a server", exact: true })).toBeVisible();
  await shoot(page, section, testInfo.outputPath(`local-models-1-empty-${width}-${skin}.png`));

  // A1 — add it without touching the mouse. The address field takes focus on
  // its own, the rule for plain addresses is under it, Enter submits.
  await tabTo(page, "Add a server");
  await page.keyboard.press("Enter");
  expect(await focusedText(page)).toBe("Server address");
  await expect(section.getByText("This computer, your home network or your tailnet can use a plain address. Anything else has to be https.", { exact: true })).toBeVisible();
  await page.keyboard.type(llamaAddress);
  await page.keyboard.press("Tab");
  expect(await focusedText(page)).toBe("Server name (optional)");
  await page.keyboard.type(SERVER_NAME);
  await shoot(page, section, testInfo.outputPath(`local-models-2-add-form-${width}-${skin}.png`));
  await page.keyboard.press("Enter");

  // V2 — the card: correct name, address, running, context, models, when it
  // was checked, and one primary action per model.
  const card = section.getByRole("region", { name: `llama.cpp on ${SERVER_NAME} local model server`, exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: `llama.cpp on ${SERVER_NAME}`, exact: true })).toBeVisible();
  await expect(card.getByText(`http://${llamaAddress}/v1`, { exact: true })).toBeVisible();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(card.getByText(/^Running · 2 models · checked just now · added by you$/)).toBeVisible();
  await expect(card.getByText("64K context loaded", { exact: true }).first()).toBeVisible();
  await expect(card.getByText(TOOL_MODEL, { exact: true })).toBeVisible();
  await expect(card.getByText(PROSE_MODEL, { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: `Test ${TOOL_MODEL}`, exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: `Test ${PROSE_MODEL}`, exact: true })).toBeVisible();
  // Before a test, a chat engine is offered (it runs its own tool loop on any
  // live model) but Codex and Claude are not — their surfaces are unproven.
  const toolEngines = card.getByText(/^Usable by /).first();
  await expect(toolEngines).toContainText("Fuigo");
  await expect(toolEngines).not.toContainText("Claude");
  await expect(toolEngines).not.toContainText("Codex");
  await shoot(page, section, testInfo.outputPath(`local-models-3-detected-${width}-${skin}.png`));

  // T1 — the test, by keyboard, with the outcome in words and the checks
  // behind a disclosure.
  await tabTo(page, `Test ${TOOL_MODEL}`);
  await page.keyboard.press("Enter");
  await expect(card.getByText("Tools work — ready for agents", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Use with a bot", exact: true })).toBeVisible();
  await expect(card.getByText(/^Usable by .*Codex, Claude$/)).toBeVisible();
  await tabTo(page, `Test ${PROSE_MODEL}`);
  await page.keyboard.press("Enter");
  await expect(card.getByText("This model answers but can't use tools (it came back as text)", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Try another model", exact: true })).toBeVisible();
  // the disclosure, opened by keyboard, holds the diagnostics — not the card
  const summary = card.locator("summary", { hasText: "What the test checked" }).first();
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(card.getByText("Calls a tool when it should: Pass — passed", { exact: true })).toBeVisible();
  await expect(card.getByText("Handles a full tool set: Pass — passed", { exact: true })).toBeVisible();
  await expect(card.getByText(/^Proven: chat tools, Codex \(responses\), Claude \(messages\)$/)).toBeVisible();
  await shoot(page, section, testInfo.outputPath(`local-models-4-tested-${width}-${skin}.png`));

  // "Use with a bot" sends the person to the one place a model is chosen.
  await card.getByRole("button", { name: "Use with a bot", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Open the bot you want and choose it from the model menu.");

  // A3 — removing says what it takes with it before it happens.
  await card.getByRole("button", { name: `Remove ${SERVER_NAME}`, exact: true }).click();
  await expect(card.getByText(`Remove ${SERVER_NAME}? The engine entries Murage wrote for it are removed too. Bots pointed at its models will need another model.`, { exact: true })).toBeVisible();
  await shoot(page, section, testInfo.outputPath(`local-models-5-remove-${width}-${skin}.png`));
  await card.getByRole("button", { name: "Remove this server", exact: true }).click();
  await expect(section.getByText("No model server is running on this computer.", { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});

for (const skin of skins) for (const width of widths) test(`Picker: the Local rail names the server, marks a failed test, and has a row when nothing is there, at ${width}px ${skin}`, async ({ page }, testInfo) => {
  await open(page, skin, width);
  // Models is a desktop-only section, so the modal only lets a jump land there
  // once the surface has been confirmed; that is one round trip after load.
  // Wait for it the way the app itself would show it: the Models entry exists.
  {
    const dialog = await openSettings(page, "Models");
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  // Start from nothing: the rail's single row is the way in, and it lands on
  // the section with "Add a server" focused — not on the pane to hunt through.
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  const trigger = page.locator('button[aria-haspopup="dialog"]').first();
  await trigger.click();
  await expect(picker).toBeVisible();
  const emptyRow = picker.getByRole("button", { name: "No local server detected — add one in Settings → Models", exact: true });
  await expect(emptyRow).toBeVisible();
  await expect(picker.getByText("Local models", { exact: true })).toBeVisible();
  await shoot(page, picker, testInfo.outputPath(`picker-1-no-local-server-${width}-${skin}.png`));
  await emptyRow.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.locator("#local-models").getByRole("heading", { name: "Local models", exact: true })).toBeVisible();
  await expect.poll(() => focusedText(page)).toBe("Add a server");

  // Add the fake server through the same route the form uses, test both
  // models, and the rail fills in.
  const section = dialog.locator("#local-models");
  await section.getByRole("button", { name: "Add a server", exact: true }).click();
  await section.getByLabel("Server address", { exact: true }).fill(llamaAddress);
  await section.getByLabel("Server name (optional)", { exact: true }).fill(SERVER_NAME);
  await section.getByRole("button", { name: "Add server", exact: true }).click();
  const card = section.getByRole("region", { name: `llama.cpp on ${SERVER_NAME} local model server`, exact: true });
  await card.getByRole("button", { name: `Test ${TOOL_MODEL}`, exact: true }).click();
  await expect(card.getByText("Tools work — ready for agents", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: `Test ${PROSE_MODEL}`, exact: true }).click();
  await expect(card.getByText("This model answers but can't use tools (it came back as text)", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // V3 — "model · server" on every local row; the failed one is marked.
  await trigger.click();
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Refresh models", exact: true }).click();
  const toolRow = picker.getByRole("button", { name: new RegExp(`^${TOOL_MODEL} · llama\\.cpp on ${SERVER_NAME}`) });
  await expect(toolRow).toBeVisible();
  await expect(toolRow).toContainText("Tools work");
  await expect(toolRow).toContainText("64K context");
  await expect(toolRow).not.toContainText("Tools test failed");
  // the server is named once, on the row's first line, not repeated under it
  expect(((await toolRow.textContent()) ?? "").split(`llama.cpp on ${SERVER_NAME}`).length).toBe(2);
  const proseRow = picker.getByRole("button", { name: new RegExp(`^${PROSE_MODEL} · llama\\.cpp on ${SERVER_NAME}`) });
  await expect(proseRow).toBeVisible();
  await expect(proseRow).toContainText("Tools test failed — chat only, not usable for agent work");
  await expect(picker.locator("[data-local-rail-empty]")).toHaveCount(0);
  await toolRow.scrollIntoViewIfNeeded();
  await shoot(page, picker, testInfo.outputPath(`picker-2-local-rail-${width}-${skin}.png`));

  // Picking it is one Enter, and the bot's chip then says the model and its
  // machine — the same words the card and the rail used.
  await toolRow.focus(); await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(`${TOOL_MODEL} · llama\\.cpp on ${SERVER_NAME}`) })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`picker-3-picked-${width}-${skin}.png`) });

  // Take the server away with the pick still on it: the chip must say the
  // model and the fact, not a raw `srv_…::` id — the removal copy promised
  // the bot "will need another model", and this is how it says so.
  await openSettings(page, "Models");
  await removeEveryServer(page);
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Close settings", exact: true }).click();
  await trigger.click();
  await expect(picker).toBeVisible();
  // A catalog refresh already in flight when the server was removed is
  // joined, not restarted (registry.refreshCatalog), so the first refresh
  // after a removal can still carry the old rows; the next one does not.
  await expect.poll(async () => {
    await picker.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect(picker.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
    return picker.getByText(`Current choice: ${TOOL_MODEL} · local server unavailable. It is unavailable in this catalog; your selection is preserved.`, { exact: true }).count();
  }, { timeout: 20_000 }).toBe(1);
  await expect(picker.locator("[data-local-rail-empty]")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`picker-4-server-removed-${width}-${skin}.png`) });
  // and leave the bot as it was found for the next run
  await picker.getByRole("button", { name: /^Claude Sonnet/ }).first().click();
  await expect(picker).toHaveCount(0);
});

for (const skin of skins) test(`Engines: each engine says where it stands on local models, at 1440px ${skin}`, async ({ page }, testInfo) => {
  await open(page, skin, 1440);
  const dialog = await openSettings(page, "Engines");
  // V4 — the fixture's engine is a Claude-driver instance, a tools engine.
  const line = dialog.getByText("Works with local models — manage them under Models → Local models", { exact: false }).first();
  await expect(line).toBeVisible();
  await shoot(page, dialog, testInfo.outputPath(`engines-local-line-1440-${skin}.png`));
  // and the link on it is the same door the picker's empty row uses
  await line.getByRole("button", { name: "Open Local models", exact: true }).click();
  await expect(dialog.locator("#local-models").getByRole("heading", { name: "Local models", exact: true })).toBeVisible();
  await expect.poll(() => focusedText(page)).toBe("Add a server");
});
