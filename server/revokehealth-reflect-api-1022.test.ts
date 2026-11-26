// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (the bot PATCH route's reflect switch, index.ts; pip-reflect.ts startReflectFromNow). Consumer owner: the
// desktop Continuity settings card.
// 1.0.22 MUST-FIX item 6 through the real server: switching reflection on starts it from now. Each of the bot's threads gets a reflect
// cursor at the switch, so the history from before it is never billed as a backfill (memory/revokehealth-reflect-1022.test.ts shows the
// cursor keeps that history out of the run's choice while a turn after it is chosen). A save that leaves reflection on moves nothing.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const out = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(out)}`).toBeLessThan(300);
  return out;
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": ((await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json()) as { secret: string }).secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("W-REFLECT-FROM-NOW the booted server's bot PATCH that switches reflect on puts every thread's reflect cursor at the switch; a re-save keeps it", async () => {
  const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot as { id: string; threadId: string };
  await api("PATCH", `/api/bots/${moss.id}`, { continuity: true });
  const before = Date.now();
  await api("PATCH", `/api/bots/${moss.id}`, { continuity: true, continuityOptions: { reflect: true } });
  const after = Date.now();
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const cursor = () => { const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`pip-reflect:${moss.id}`); return row ? JSON.parse(String(row.intent)).threads?.[moss.threadId] : undefined; };
    const at = cursor()?.cursorAt;
    // base 68ed0def17: the switch writes no cursor, so the next run reads the thread from its first message
    expect(typeof at, "reflect cursor of the bot's thread").toBe("number");
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    await new Promise(resolve => setTimeout(resolve, 20));
    await api("PATCH", `/api/bots/${moss.id}`, { continuityOptions: { reflect: true, inner: true } });
    expect(cursor()?.cursorAt).toBe(at);
  } finally { db.close(); }
}, 60000);
