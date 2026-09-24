// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The composer's "/" menu with an engine group, in a real browser against the
// task-owned verification server and its fake Claude Code CLI (command list
// switched on). It never reads a normal profile or calls a provider.
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let headers: Record<string, string> = {};

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`).toBe(true);
  return result as any;
}
const idle = async () => !(await api("GET", "/api/bots?messages=0")).bots.some((bot: any) => bot.busy);
const dumpedPrompt = () => {
  try {
    if (!existsSync(fixture.fixtureDumpPath)) return "";
    const content = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))?.prompt?.message?.content;
    return typeof content === "string" ? content : "";
  } catch { return ""; }
};

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1'; process.env.FAKE_CLAUDE_COMMANDS='1';",
  });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).secret };
  const model = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  for (const name of ["Moss", "Fern"]) {
    const bot = (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    // Moss has run once, so its engine has reported its commands. Fern has not.
    if (name === "Moss") {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hello" });
      await expect.poll(async () => (await api("GET", `/api/bots/${bot.id}/engine-commands`)).status, { timeout: 20_000 }).toBe("ready");
      await expect.poll(idle, { timeout: 20_000 }).toBe(true);
    }
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({
    configFile: false,
    envFile: false,
    root,
    cacheDir: join(fixture.info.dataDir, "vite-cache"),
    resolve: { alias: { "@": join(root, "src") } },
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } },
  });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing isolated UI port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openBot(page: Page, name: string) {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  await (await openSidebar(page)).getByText(name, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
  return page.getByRole("textbox", { name: `Message ${name}`, exact: true });
}

const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

test("before the engine has run, the menu says how to load its commands", async ({ page }, info) => {
  const composer = await openBot(page, "Fern");
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Composer commands", exact: true });
  await expect(menu.getByRole("group", { name: "Murage", exact: true }).getByRole("option", { name: /\/setup/ })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Claude Code", exact: true })).toContainText("Start a chat to load Claude Code commands");
  await shot(page, info, "engine-commands-unknown");
});

test("lists the engine's own commands under Murage's, and sends a picked one to the engine", async ({ page }, info) => {
  const composer = await openBot(page, "Moss");
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Composer commands", exact: true });
  const engine = menu.getByRole("group", { name: "Claude Code", exact: true });
  await expect(engine.getByRole("option")).toHaveText([
    /\/compact.*Clear conversation history/,
    /\/context.*Show current context usage/,
    /\/review.*Review a pull request/,
  ]);
  // terminal-bound by Claude Code's own report, and kept out by Murage
  await expect(menu.getByRole("option", { name: /\/statusline|\/clear/ })).toHaveCount(0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // below md the bot list is a drawer the resize can leave open over the chat
    if (width < 768) {
      await page.mouse.click(width - 5, 100);
      await expect.poll(() => page.getByRole("complementary", { name: "Bots and navigation", exact: true })
        .evaluate((node) => node.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await expect(engine).toBeInViewport({ ratio: 1 });
    await shot(page, info, `engine-commands-menu-${width}`);
  }

  // a command that takes input is left in the draft to finish
  await composer.fill("/comp");
  await expect(engine.getByRole("option", { name: /\/compact/ })).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/compact ");

  // a command that takes none is sent as it is
  await composer.fill("/cont");
  await engine.getByRole("option", { name: /\/context/ }).click();
  await expect(composer).toHaveValue("");
  await expect.poll(dumpedPrompt, { timeout: 20_000 }).toBe("/context");
  await expect(page.getByTestId("chat-scroll").getByText("FAKE_CONTEXT 12k of 200k tokens used")).toBeVisible();
  await shot(page, info, "engine-command-answer");
});
