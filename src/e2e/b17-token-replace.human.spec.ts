import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import type { TelegramStatus } from "../lib/telegram-status";

// B17 T1: after Telegram rejects the saved token, the owner replaces it with a
// token for the same bot. Routes are mocked; the server refusal reason arrives
// through the refreshed status (resumeMessage), not the failed save.
let server: ViteDevServer, origin: string, cache: string;
const TOKEN_REJECTED = "Telegram rejected the saved bot token. Paste a new token for this same bot from BotFather to reconnect. Your pairing is saved.";
const WRONG_BOT = "This token belongs to a different Telegram bot. Your saved token and pairing were not changed. Paste the token for the paired bot, or revoke before pairing a different bot.";
const CHIEF = "The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief.";
const HINT = "Paste a new token for the same bot from BotFather. Your pairing and owner link are kept. A token for a different bot is refused.";
const REVOKE_HINT = "Revoke the connection before changing its token.";
const NOTICE = "Token replaced. Reconnecting with your saved pairing.";
const FAKE_TOKEN = "123:fixture_replacement_token_not_real";
const blocked: TelegramStatus = { configured: true, enabled: false, paired: false, pending: 0, uncertain: 0, rejected: 0, connecting: false, error: "auth",
  requiresRevoke: true, canResume: false, canReplaceToken: true, resumeState: "blocked", resumeMessage: TOKEN_REJECTED };
const active: TelegramStatus = { configured: true, enabled: true, paired: true, pending: 0, uncertain: 0, rejected: 0, connecting: false, error: null,
  requiresRevoke: true, canResume: false, canReplaceToken: false, resumeState: "active", resumeMessage: null };

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-b17-token-replace-vite-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` }, }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "b17-token-replace-fixture",
      resolveId(id) { if (id === "/__b17-token-replace.js") return "\0b17-token-replace"; },
      load(id) { if (id === "\0b17-token-replace") return `import React from 'react';import {createRoot} from 'react-dom/client';import {TelegramSettings} from '/src/components/TelegramSettings.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TelegramSettings));`; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => { if (request.url !== "/__b17-token-replace") return next(); response.setHeader("content-type", "text/html"); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="padding:16px"></div><script type="module" src="/__b17-token-replace.js"></script>'); }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing B17 token replacement fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

async function screenshots(page: Page, info: TestInfo, state: string) {
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`b17-token-replace-${state}-${width}.png`), fullPage: true });
  }
}

test("B17 token replacement: a wrong-bot token is refused and stays blocked, a same-bot token resumes the pairing", async ({ page }, info) => {
  let status: TelegramStatus = { ...blocked };
  let answer: { status: number; body: unknown; next: TelegramStatus } = { status: 409, body: { error: WRONG_BOT }, next: { ...blocked, resumeMessage: WRONG_BOT } };
  const saves: unknown[] = [];
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture" } }));
  await page.route("**/api/telegram/status", route => route.fulfill({ json: status }));
  await page.route("**/api/config", async route => {
    saves.push({ method: route.request().method(), body: route.request().postDataJSON() });
    status = answer.next;
    await route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.goto(`${origin}/__b17-token-replace`);
  const input = page.getByLabel("Bot token", { exact: true });
  const replace = page.getByRole("button", { name: "Replace token", exact: true });

  await expect(page.getByText("Token rejected · paste a new token for this bot", { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByText(HINT)).toBeVisible();
  await expect(page.getByText(REVOKE_HINT)).toHaveCount(0);
  await expect(replace).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pair with Chief", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Retry now", exact: true })).toHaveCount(0);
  await screenshots(page, info, "replaceable");

  await input.fill(FAKE_TOKEN);
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(page.getByRole("alert")).toContainText("could not be completed");
  await expect(page.getByText(WRONG_BOT)).toBeVisible();
  await expect(page.getByText("Token rejected · paste a new token for this bot", { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(FAKE_TOKEN);
  await expect(page.getByText("Paired", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pair with Chief", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  expect(saves).toEqual([{ method: "PUT", body: { telegram: { botToken: FAKE_TOKEN } } }]);
  await screenshots(page, info, "refused");

  answer = { status: 200, body: { xai: { configured: false } }, next: { ...active } };
  await replace.click();
  await expect(page.getByText("Paired", { exact: true })).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeDisabled();
  await expect(page.getByText(REVOKE_HINT)).toBeVisible();
  await expect(page.getByText(HINT)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save token", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Pair with Chief", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  expect(saves).toHaveLength(2);
  await screenshots(page, info, "replaced");
});

test("B17 token replacement through the desktop credential bridge shows the server refusal, then resumes", async ({ page }) => {
  let status: TelegramStatus = { ...blocked };
  let answer: { status: number; next: TelegramStatus } = { status: 409, next: { ...blocked, resumeMessage: WRONG_BOT } };
  const credentialCalls: unknown[] = [];
  let configCalls = 0;
  await page.addInitScript(() => {
    (window as unknown as { muragebox: unknown }).muragebox = {
      async setCredential(name: string, value: string) {
        const response = await fetch("/__b17-credential", { method: "POST", body: JSON.stringify({ name, value }) });
        if (!response.ok) throw new Error("Error invoking remote method 'credential:set': Error: refused");
        return response.json();
      },
    };
  });
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture" } }));
  await page.route("**/api/telegram/status", route => route.fulfill({ json: status }));
  await page.route("**/api/config", route => { configCalls++; return route.fulfill({ status: 500, json: { error: "the bridge path never uses PUT /api/config" } }); });
  await page.route("**/__b17-credential", async route => {
    credentialCalls.push(route.request().postDataJSON());
    status = answer.next;
    await route.fulfill({ status: answer.status, json: answer.status === 200 ? { xai: { configured: false } } : { error: "refused" } });
  });
  await page.goto(`${origin}/__b17-token-replace`);
  const input = page.getByLabel("Bot token", { exact: true });
  const replace = page.getByRole("button", { name: "Replace token", exact: true });

  await input.fill(FAKE_TOKEN);
  await replace.click();
  await expect(page.getByRole("alert")).toContainText("could not be completed");
  await expect(page.getByText(WRONG_BOT)).toBeVisible();
  await expect(page.getByText("Token rejected · paste a new token for this bot", { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();

  answer = { status: 200, next: { ...active } };
  await replace.click();
  await expect(page.getByText("Paired", { exact: true })).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(input).toHaveValue("");
  expect(credentialCalls).toEqual([{ name: "telegramBotToken", value: FAKE_TOKEN }, { name: "telegramBotToken", value: FAKE_TOKEN }]);
  expect(configCalls).toBe(0);
});

test("B17 token replacement is not offered after the paired Chief changed", async ({ page }, info) => {
  const status: TelegramStatus = { ...blocked, error: null, canReplaceToken: false, resumeMessage: CHIEF };
  let configCalls = 0;
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture" } }));
  await page.route("**/api/telegram/status", route => route.fulfill({ json: status }));
  await page.route("**/api/config", route => { configCalls++; return route.fulfill({ status: 409, json: { error: "Revoke Telegram before changing its token or target." } }); });
  await page.goto(`${origin}/__b17-token-replace`);

  await expect(page.getByText("Chief unavailable · revoke and re-pair", { exact: true })).toBeVisible();
  await expect(page.getByText(CHIEF)).toBeVisible();
  await expect(page.getByLabel("Bot token", { exact: true })).toBeDisabled();
  await expect(page.getByText(REVOKE_HINT)).toBeVisible();
  await expect(page.getByText(HINT)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save token", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Replace token", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pair with Chief", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  await screenshots(page, info, "chief-blocked");
  expect(configCalls).toBe(0);
});
