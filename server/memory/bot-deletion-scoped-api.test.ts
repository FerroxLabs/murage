// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
const { countSignatures, judge } = await import(new URL("../../scripts/smoothness/smooth-config.mjs", import.meta.url).href);
const { loadBudgets } = await import(new URL("../../scripts/smoothness/smooth-gate.mjs", import.meta.url).href);
let fixture: VerificationServer;
let headers: Record<string, string>;
const evidence: unknown[] = [];
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json() as any;
  evidence.push({ method, path, status: response.status });
  return { status: response.status, json };
};
afterAll(async () => {
  if (fixture) {
    mkdirSync("evidence/s6", { recursive: true });
    writeFileSync("evidence/s6/fixture-server.log", readFileSync(fixture.info.logPath));
    writeFileSync("evidence/s6/fixture-commands.json", JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    await fixture.close();
  }
});
it("S6 isolated fixture: deleting an idle bot preserves three held turns, refuses a working thread deletion, and passes both rig rows", async () => {
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';process.env.MURAGE_TURN_TRACE='1';", dumpLog: true,
  });
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).json.secret };
  const engines = (await call("GET", "/api/instances")).json.instances;
  const instance = engines.find((i: any) => i.instanceId === "verification");
  const option = instance.models.options[0], model = instance.models.default || (typeof option === "string" ? option : option.id);
  const make = async () => {
    const made = await call("POST", "/api/bots", { modelSelection: { instanceId: "verification", model } });
    expect(made.status).toBe(201);
    const bot = made.json.bot;
    expect((await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const held = [await make(), await make(), await make()], idle = await make();
  const mark = readFileSync(fixture.info.logPath, "utf8").length;
  const sends = await Promise.all(held.map((bot, i) => call("POST", `/api/bots/${bot.id}/messages`, { text: `Held ${i} __fixture_hold_authority__`, threadId: bot.threadId, sendId: `s6-held-message-${i}` })));
  for (const send of sends) expect(send.status, JSON.stringify(send.json)).toBeLessThan(300);
  let turns: Array<{ pid: number }> = [];
  await expect.poll(() => {
    try { turns = readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").map(s => JSON.parse(s)).filter(t => JSON.stringify(t.prompt).includes("__fixture_hold_authority__")); } catch { return false; }
    return turns.length === 3;
  }, { timeout: 60000 }).toBe(true);
  expect((await call("DELETE", `/api/bots/${idle.id}`)).status).toBe(200);
  const working = await call("DELETE", `/api/bots/${held[0].id}/tasks/${held[0].threadId}`);
  expect(working.status).toBe(409);
  for (const turn of turns) writeFileSync(join(fixture.fixtureFinishGateDir, String(turn.pid)), "finish");
  let completed = 0;
  await expect.poll(async () => {
    completed = 0;
    for (const bot of held) {
      const state = (await call("GET", `/api/bots/${bot.id}`)).json.bot;
      const transcript = (await call("GET", `/api/threads/${bot.threadId}/messages?limit=30`)).json.messages;
      if (!state.busy && transcript.some((m: any) => m.kind === "text" && m.role === "bot" && m.text === "Fixture turn finished.")) completed++;
    }
    return completed;
  }, { timeout: 60000, interval: 100 }).toBe(3);
  const sig = countSignatures(readFileSync(fixture.info.logPath, "utf8").slice(mark));
  const results = { scenarios: { deletion: { heldCompleted: completed, rePreparing: sig.rePreparing } } };
  const rows = judge(loadBudgets(), results).rows.filter((r: any) => ["S6.held", "S6.rePreparing"].includes(r.id));
  evidence.push({ results, rows });
  expect(rows).toHaveLength(2);
  expect(rows.every((r: any) => r.pass)).toBe(true);
}, 180000);
