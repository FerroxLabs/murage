// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The limit line through the real server: a chat turn whose engine relays its refusal as answer text and then fails with
// the same text. The relayed row becomes the limit line and keeps non-empty text; no transcript row of the thread is left
// with a tool line and empty text (the pre-fix handler patched the row to text "").
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
const LINEAGE_ALLOWANCE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "memory", "lineage-allowance.ts")).href;
const REFUSAL = "You've hit your usage limit. Upgrade to Pro or try again at Dec 1st, 2099 9:00 AM.";
let fixture: VerificationServer, headers: Record<string, string>;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
};

beforeAll(async () => {
  chmodSync(FAKE_CODEX, 0o755);
  fixture = await launchVerificationServer({ ...process.env }, undefined, { instrumentationSource: `
    (await import(${JSON.stringify(LINEAGE_ALLOWANCE)})).setLineageTimeBudgetForTest(null);
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.relayedLimit={driver:'codex',displayName:'Codex relayed',environment:{FAKE_CODEX_VERSION:'codex-cli 0.163.0',FAKE_CODEX_MODE:'limit-relayed',FAKE_CODEX_LIMIT_TEXT:${JSON.stringify(REFUSAL)}},config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const secret = await fetch(`${fixture.info.url}/api/desktop-secret`).then(r => r.json()) as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
}, 120000);
afterAll(async () => { await fixture?.close(); });

it("a refusal the engine relayed as its answer becomes the limit line with its text kept", async () => {
  const created = await api("POST", "/api/bots", { name: "Limit line fixture", modelSelection: { instanceId: "relayedLimit", model: "gpt-fake-default" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "limit-line-booted" })).status).toBe(202);
  const limitRows = async () => {
    const messages = ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages ?? []) as any[];
    return messages.filter(m => m.role === "bot" && m.kind === "activity" && m.tool?.ok === false && /is at its limit/.test(m.tool?.name ?? ""));
  };
  await expect.poll(async () => (await limitRows()).length, { timeout: 30000 }).toBeGreaterThan(0);
  const rows = await limitRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].text, "the limit row keeps its line as text").toBe(rows[0].tool.name);
}, 60000);
