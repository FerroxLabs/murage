// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ACP driver mounted MCP gate (acp/core.ts), lane q1023-winfirst. Consumer: the message route and the conversation the owner reads.
// 1.0.23 winfirst item (2) through the REAL route (ASTRA High on 9c56155247: the driver witnesses stopped at the driver): a booted Murage
// server, the real fuigoAgent driver and mount relay, a fresh owner bot's first message on POST /api/bots/:id/messages, against a fake ACP
// engine that lists the bot's required agents mount as failed while every other server is ready (the fresh Windows first turn, where the
// agents mount died at start). The owner must read the bot's reply, never "couldn't start" or any refusal row.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
let model = "default";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(fixture.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(value)}`).toBe(true);
  return value;
};

beforeAll(async () => {
  const root = resolve(".");
  fixture = await launchVerificationServer(process.env, undefined, {
    portRange: { from: 45650, span: 90 },
    instrumentationSource: `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      process.env.NODE_ENV = 'test';
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
      process.env.MURAGE_ENGINE_EXCLUSION_PATH = ${JSON.stringify(join(root, "server/testing/engine-exclusion-stub.cjs"))};
      const data = process.env.MURAGE_DATA_DIR;
      writeFileSync(join(data, 'winfirst-env'), '{}');
      const cli = join(data, 'winfirst-fuigo.mjs');
      writeFileSync(cli, [
        '#!/usr/bin/env -S node --experimental-strip-types',
        "import { readFileSync } from 'node:fs';",
        'Object.assign(process.env, JSON.parse(readFileSync(' + JSON.stringify(join(data, 'winfirst-env')) + ', "utf8")));',
        'await import(' + JSON.stringify('file://' + ${JSON.stringify(join(root, "server/testing/"))} + 'fake-acp-cli.ts') + ');',
      ].join('\\n'), {mode: 0o755});
      mkdirSync(join(process.env.HOME, '.fuigo'), {recursive:true});
      writeFileSync(join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
      const file = join(data, 'config.json');
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      cfg.instances = { fuigo: { driver: 'fuigoAgent', config: { cli } } };
      writeFileSync(file, JSON.stringify(cfg));
    `,
  });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const instance = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === "fuigo");
  expect(instance?.snapshot?.state).toBe("available");
  const first = instance.models.options[0];
  model = instance.models.default || (typeof first === "string" ? first : first?.id || "default");
}, 120_000);

afterAll(async () => { await fixture?.close(); });

/** A fresh owner bot (fresh thread, fresh engine process) on an engine configured by `env`; its first message on the real route. */
async function firstTurn(env: Record<string, string>) {
  writeFileSync(join(fixture.info.dataDir, "winfirst-env"), JSON.stringify(env));
  let { bot } = await api("POST", "/api/bots", {});
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "fuigo", model }, computer: "off", browser: false, composio: false, autoApprove: false, fullAccess: false });
  bot = (await api("GET", `/api/bots/${bot.id}`)).bot;
  await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Reply with the single word GATE" });
  const busy = async () => (await api("GET", `/api/bots/${bot.id}`)).bot.busy === true;
  const messages = async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages ?? []) as any[];
  const events = () => readFileSync(join(fixture.info.dataDir, "events", bot.threadId + ".ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line)) as any[];
  return { bot, busy, messages, events };
}

describe("1.0.23 winfirst (2) through the booted server: a fresh owner bot's first turn with its agents mount failed answers", () => {
  it("W3-route: the owner reads the bot's reply, with no error row and no refusal", async () => {
    const t = await firstTurn({ FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_LIST_OVERRIDE: JSON.stringify({ agents: "failed" }) });
    // Settled either way: the reply's turn completed, or the owner was shown an error row (the refusal card after the rebuilds).
    const settled = async () => t.events().some(e => e.type === "turn.completed") || (await t.messages()).some(m => String(m.tool?.name ?? "").startsWith("error:"));
    await expect.poll(settled, { timeout: 150_000, interval: 300 }).toBe(true);
    await expect.poll(async () => !(await t.busy()), { timeout: 60_000, interval: 300 }).toBe(true);
    const rows = await t.messages();
    const said = rows.map(m => String(m.text ?? m.tool?.name ?? ""));
    expect({
      replied: rows.some(m => m.role === "bot" && m.kind !== "activity" && String(m.text ?? "").includes("hello from fake acp")),
      errorRows: said.filter(text => text.startsWith("error:") || text.includes("couldn't start") || text.includes("no longer available")),
      refusals: t.events().filter(e => e.type === "runtime.error").length,
    }).toEqual({ replied: true, errorRows: [], refusals: 0 });
  }, 260_000);
});
