// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../control-murage.ts";
import { prepareLongThread } from "./long-thread.mjs";
import { turnFromLog } from "../scale/rig-config.mjs";
import { stats } from "../scale/stats.mjs";
import { contextChangedIn, countSignatures, judgeRow } from "./smooth-config.mjs";
import { loadBudgets } from "./smooth-gate.mjs";

let fixture, call, bot, folder;
const evidence = resolve(process.env.SMOOTH_TRIAGE_EVIDENCE ?? ".planning/smooth-triage/s5");
beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: 'process.env.MURAGE_TURN_TRACE="1"; process.env.MURAGE_DEV_DESKTOP_SECRET="smooth-fixture-desktop"; globalThis[Symbol.for("murage.hostPower.testUnwrapped")]=true;',
  });
  const url = fixture.info.url;
  const secret = (await (await fetch(`${url}/api/desktop-secret`, { headers: { "x-test-bare-loopback": "1" } })).json()).secret;
  expect(typeof secret).toBe("string");
  call = async (method, path, body) => {
    const response = await fetch(url + path, { method, headers: { "x-test-bare-loopback": "1", "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
  const created = await runControlMurage(["new-bot", "--name", "Copied S5 primary task", "--url", url]);
  const detail = await call("GET", `/api/bots/${created.bot.id}?messages=0`);
  bot = detail.json.bot;
  folder = join(fixture.info.dataDir, "relocated-desk");
  mkdirSync(folder);
}, 120000);
afterAll(async () => {
  if (fixture) {
    writeFileSync(join(evidence, "server.log"), readFileSync(fixture.info.logPath));
    await fixture.close();
  }
});

it("S5 patches the primary task's own copied folder and measures five resumed fake turns", async () => {
  // A copied profile may have a persisted task pin even when the task is the
  // primary thread. Seed while stopped; an owner cannot pick a missing folder.
  await fixture.stop();
  const path = join(fixture.info.dataDir, "bots.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const stored = (Array.isArray(saved) ? saved : saved.bots).find(row => row.id === bot.id);
  const threadId = bot.threadId;
  const task = stored.tasks.find(row => row.threadId === threadId);
  task.cwd = "/Users/smooth-fixture/original-mac-desk";
  writeFileSync(path, JSON.stringify(saved));
  await fixture.restart();
  // First demonstrate the unchanged product refuses the unavailable task pin,
  // including after the old rig's successful bot-level PATCH.
  expect((await call("PATCH", `/api/bots/${bot.id}`, { cwd: folder })).status).toBe(200);
  const before = await call("GET", `/api/bots/${bot.id}/tasks/${threadId}`);
  expect(before.json.task.cwd).toBe(task.cwd);
  const turn = async text => {
    const mark = readFileSync(fixture.info.logPath, "utf8").length;
    const started = performance.now();
    const sent = await runControlMurage(["send", "--bot", bot.id, "--text", text, "--url", fixture.info.url]);
    const wait = await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url]);
    const wall = performance.now() - started;
    const trace = turnFromLog(readFileSync(fixture.info.logPath, "utf8").slice(mark), threadId);
    const messages = await runControlMurage(["messages", "--bot", bot.id, "--limit", "10", "--url", fixture.info.url]);
    return { sent, wait, messages, wall, trace };
  };
  const refused = await turn("Prove the unavailable copied folder is refused.");
  expect(readFileSync(fixture.info.logPath, "utf8")).toContain("outcome=setup-failed");
  const setup = await prepareLongThread({ call, bot, threadId, folder });
  const after = await call("GET", `/api/bots/${bot.id}/tasks/${threadId}`);
  expect(after.json.task.cwd, "bot-level PATCH cannot relocate the primary task").toBe(folder);
  const measuredMark = readFileSync(fixture.info.logPath, "utf8").length;
  const turns = [];
  for (let i = 0; i < 5; i++) turns.push(await turn(`S5 synthetic measured turn ${i}.`));
  const log = readFileSync(fixture.info.logPath, "utf8");
  const measuredLog = log.slice(measuredMark);
  const tail = turns.at(-1).messages.messages;
  expect(Array.isArray(tail), "S5 requires a readable resulting transcript").toBe(true);
  const results = { scenarios: { longThread: {
    firstText: stats(turns.map(row => row.trace.firstText)), wall: stats(turns.map(row => row.wall)),
    resumed: turns.slice(1).filter(row => row.trace.resumed === true).length,
    resets: turns.reduce((sum, row) => sum + row.trace.resets, 0),
    contextChanged: contextChangedIn(tail).length + countSignatures(measuredLog).contextCard,
    failed: turns.filter(row => row.trace.outcome !== "ok" || row.wait.status !== "settled").length,
  } } };
  const verdicts = loadBudgets().rows.filter(row => row.id.startsWith("S5.")).map(row => judgeRow(row, results));
  writeFileSync(join(evidence, "workflow.json"), JSON.stringify({ fixture: fixture.info, before, refused, setup, after, turns, results, verdicts }, null, 2));
  expect(turns.every(row => row.wait.status === "settled")).toBe(true);
  expect(measuredLog.match(/outcome=ok/g)?.length).toBeGreaterThanOrEqual(5);
  expect(measuredLog.match(/resumed=true/g)?.length).toBeGreaterThanOrEqual(4);
  expect(results.scenarios.longThread.firstText.n).toBe(5);
  expect(verdicts).toHaveLength(6);
  expect(verdicts.filter(row => !row.pass)).toEqual([]);
}, 240000);

it.each([404, 409, 500])("S5 refuses to measure when task relocation returns %s", async status => {
  const calls = [];
  await expect(prepareLongThread({ bot: { id: "b", threadId: "primary" }, threadId: "primary", folder: "/fixture/desk",
    call: async (method, path) => { calls.push([method, path]); return { status: path.includes("/tasks/") ? status : 200, json: {} }; },
  })).rejects.toThrow(/S5.*folder/);
});
