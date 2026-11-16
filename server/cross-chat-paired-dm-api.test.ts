// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
import { turnSecret } from "./turn-credential.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const observations: unknown[] = [];
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, fixture.info.url), { method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
}
function updates(rows: unknown[]) {
  const dir = join(fixture.info.dataDir, "telegram-fixture");
  writeFileSync(join(dir, "updates.tmp"), JSON.stringify(rows));
  renameSync(join(dir, "updates.tmp"), join(dir, "updates.json"));
}
const update = (id: number, text: string) => ({ update_id: id, message: {
  message_id: id, date: 1_700_000_000 + id, text,
  from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" },
} });
const dump = () => {
  try { return withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))); }
  catch { return null; }
};
function agentsEnv(value: any): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  // Every shipped mount now has a credential file. Select the agents mount
  // whose venue flags and authority this fixture is checking.
  if (value.mcpServers?.agents?.env) return value.mcpServers.agents.env;
  if (value.env?.MURAGE_CRED_SERVER === 'agents' || value.env?.MURAGE_COMMS_TOKEN) return value.env;
  for (const child of Object.values(value)) { const found = agentsEnv(child); if (found) return found; }
  return undefined;
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
      process.env.FAKE_CLAUDE_HOLD_MARKER = 'PAIRED_DM_HOLD';
      process.env.FAKE_CLAUDE_HOLD_GATE = join(process.env.MURAGE_DATA_DIR, 'paired-hold');
      process.env.FAKE_TELEGRAM_DIR = join(process.env.MURAGE_DATA_DIR, 'telegram-fixture');
      mkdirSync(process.env.FAKE_TELEGRAM_DIR);
      await import(${JSON.stringify(new URL("./testing/telegram-fetch-preload.mjs", import.meta.url).href)});
    `,
  });
  const proof = await (await fetch(new URL("/api/desktop-secret", fixture.info.url))).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 120_000);
afterAll(async () => {
  if (fixture && process.env.CROSSCHAT_EVIDENCE_DIR) {
    mkdirSync(process.env.CROSSCHAT_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.CROSSCHAT_EVIDENCE_DIR, "paired-server.log"), readFileSync(fixture.info.logPath));
    writeFileSync(join(process.env.CROSSCHAT_EVIDENCE_DIR, "paired-workflow.json"), JSON.stringify({
      fixture: fixture.info, observations,
    }, null, 2));
  }
  await fixture?.close();
});

it("T58j a real channel dispatch mounts the paired reader and revocation closes its live HTTP capability", async () => {
  const model = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "verification").models.options[0].id;
  const { bot } = await api("POST", "/api/bots", { name: "Paired reader", modelSelection: { instanceId: "verification", model } });
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, chiefOfStaff: true, chiefScope: "workspace" });
  const { group } = await api("POST", "/api/groups", { name: "Paired fixture room", memberIds: [bot.id],
    setup: { bulletin: "Fixture notes.", defaultResponder: { kind: "member", botId: bot.id } } });
  await api("POST", `/api/groups/${group.id}/messages`, { text: "PAIRED_ROOM_LINE" });
  await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).bots.some((entry: any) => entry.busy), { timeout: 30_000 }).toBe(true);
  await api("PATCH", "/api/config", { telegram: { botToken: "123:abcdefghijklmnopqrstuvwxyz123456" } });
  const pair = await api("POST", "/api/telegram/pair", { targetBotId: bot.id });
  const rows = [update(1, `/pair ${pair.code}`)];
  updates(rows);
  await expect.poll(async () => (await api("GET", "/api/telegram/status")).paired, { timeout: 20_000 }).toBe(true);
  const binding = (await api("POST", "/api/memory/action", { action: "humans" })).bindings[0];
  const linked = await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "owner" });
  rows.push(update(2, "PAIRED_DM_HOLD"));
  updates(rows);
  await expect.poll(() => JSON.stringify(dump()?.prompt).includes("PAIRED_DM_HOLD"), { timeout: 30_000 }).toBe(true);
  const held = dump();
  const env = agentsEnv(held.mcpConfig);
  expect(env?.MURAGE_VENUE_READ).toBe("1");
  expect(env?.MURAGE_VENUE_POST).not.toBe("1");
  expect(env?.MURAGE_ROOM_SHARE).not.toBe("1");
  expect(JSON.stringify(held.mcpConfig)).not.toMatch(/phone-jobs-proxy|phone-proxy/);
  const token = turnSecret("MURAGE_COMMS_TOKEN", env!);
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  const read = async () => {
    const response = await fetch(new URL("/api/internal/venue/read-messages", fixture.info.url), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ venueId: group.id }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const allowed = await read();
    observations.push({ action: "paired-read", result: allowed });
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(allowed.body)).toContain("PAIRED_ROOM_LINE");
    await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: linked.revision, as: "unlink" });
    const revoked = await read();
    observations.push({ action: "unlink-then-read", result: revoked });
    // MAIN RULING INT-CONFLICT-DEFAULT 7C P3: a known retired token gets
    // the fixed stale-owner 401 before inspecting any live binding or ledger.
    expect(revoked).toEqual({ status: 401, body: { error: "internal turn owner is unavailable" } });
  } finally {
    if (existsSync(fixture.info.dataDir)) writeFileSync(join(fixture.info.dataDir, "paired-hold"), "");
  }
}, 120_000);
