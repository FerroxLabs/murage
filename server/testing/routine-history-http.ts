// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: rhist-s1b owns measurement; rhist-h1 owns the H1 production consumer.
import { beforeAll, expect } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HistoryWork } from "./routine-history-work.ts";

process.env.MURAGE_IDENTITY_CONTROL_ENTRY = fileURLToPath(new URL("./routine-history-entry.mjs", import.meta.url));
const harness = await import("./index-harness.ts");
export interface HistoryMeasurement { path: string; size: number; work?: HistoryWork; ms: number; rebuilds: number; rows: number; before: number; after: number; lookupCalls: number }
export const historyMeasurements: HistoryMeasurement[] = [];
export const historyHeaps: Array<{ size: number; heapUsed: number; forcedGC: boolean }> = [];
let ownerBotId = "", seedInput: object;
async function control(action: string, data: object = {}) {
  const response = await fetch(`${harness.BASE}/__routine_history/${action}`, { method: "POST", body: JSON.stringify(data) });
  const body = await response.json() as any;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}
const op = (name: string, data: object = {}) => control("operation", { name, ...data });
async function measure(path: string, size: number, counting: boolean, operation: () => Promise<{ rows?: number } | void>, delta = 0, invalidate = true) {
  const started = await control("start", { counting, invalidate });
  expect(started.retained, `${path}: exact retained count before operation`).toBe(size);
  let result;
  try { result = await operation(); } catch (error) { await control("stop"); throw error; }
  const measured = await control("stop");
  expect(measured.retained, `${path}: exact retained count after operation (declared delta ${delta})`).toBe(size + delta);
  const row: HistoryMeasurement = { path, size, work: measured.work, ms: measured.ms, rebuilds: measured.rebuilds, rows: result?.rows ?? 0, before: started.retained, after: measured.retained, lookupCalls: measured.lookupCalls };
  historyMeasurements.push(row);
  console.info("RHIST", JSON.stringify({ counting, ...row }));
}
async function http(method: string, path: string, data?: object) {
  const result = await harness.desktopApi(method, path, data);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body).slice(0, 400)}`).toBe(200);
  return { rows: result.body.runs?.length ?? result.body.chats?.length ?? result.body.hits?.length ?? 0 };
}
async function h1(size: number, counting: boolean) {
  for (const kind of ["chats", "search"]) {
    const route = kind === "chats" ? "/api/chats?limit=10" : "/api/search?view=chats&q=fixture&limit=10";
    // Reset the canonical store between samples outside the window: no warm owner view or cache.
    for (let sample = 0; sample < (counting ? 1 : 20); sample++) {
      expect((await control("resetHistory")).retained).toBe(size);
      await measure(`H1 ${kind} cold`, size, counting, () => http("GET", route), 0, false);
      await measure(`H1 ${kind} warm`, size, counting, () => http("GET", route), 0, false);
      expect((await control("writeRun")).retained).toBe(size);
      await measure(`H1 ${kind} after-write`, size, counting, () => http("GET", route), 0, false);
    }
  }
}
beforeAll(async () => {
  expect((await harness.desktopApi("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
  const botIds: string[] = [], groupIds: string[] = [];
  for (let n = 0; n < 3; n++) botIds.push((await harness.desktopApi("POST", "/api/bots", { name: `History fixture ${n}` })).body.bot.id);
  for (let n = 0; n < 2; n++) groupIds.push((await harness.desktopApi("POST", "/api/groups", { name: `History room ${n}`, memberIds: botIds })).body.group.id);
  expect((await control("chats", { botIds, groupIds })).candidates).toBe(80);
  const botId = botIds[0], groupId = groupIds[0];
  seedInput = { botId, botIds, groupIds };
  for (const counting of process.env.RHIST_COUNT_ONLY === "1" ? [true] : [true, false]) for (const size of [10, 2_000, 10_000]) {
    const fixture = await control("seed", { ...seedInput, count: size });
    expect(fixture.retained).toBe(size);
    expect(fixture.chatRunThreads, "same ten run-bearing chat threads at every N").toBe(10);
    if (!counting) { historyHeaps.push({ size, heapUsed: fixture.heapUsed, forcedGC: fixture.forcedGC }); console.info("RHIST_HEAP", JSON.stringify(historyHeaps.at(-1))); }
    const definition = fixture.definitions[5].id;
    const run = async (path: string, operation: () => Promise<{ rows?: number } | void>, delta = 0) => measure(path, size, counting, operation, delta);
    await h1(size, counting);
    await run("H2 hydrate", () => http("GET", "/api/routines"));
    await run("H2 calendar point", () => http("GET", `/api/routines?from=${fixture.now}&to=${fixture.now}`));
    await run("H2 calendar week", () => http("GET", `/api/routines?from=${fixture.now - 7 * 86_400_000}&to=${fixture.now}`));
    await run("H2 page", async () => { const result = await harness.desktopApi("GET", "/api/routines/runs?limit=5"); return { rows: result.status === 200 ? result.body.runs?.length ?? 0 : -result.status }; });
    await run("H6 setup", async () => { expect((await op("setup")).briefRan).toBe(true); });
    await run("H7 roster", () => http("PATCH", `/api/groups/${groupId}`, { memberIds: botIds }));
    await run("H7 permission preview", () => http("POST", `/api/bots/${botId}/permissions/refresh`, { scope: "open" }));
    await run("H7 binding changed", async () => { await op("bindingChanged"); });
    for (const name of ["signalInventory", "signalVerify", "signalEarlier", "signalOpen"]) await run(`H7 ${name}`, async () => { await op(name); });
    for (let channel = 0; channel < 5; channel++) await run(`H7 revoke ${["telegram", "slack", "discord", "signal", "whatsapp"][channel]}`, async () => { await op("channelRevoke", { channel }); });
    await run("H8 legacy", async () => ({ rows: (await op("inboxLegacy")).length }));
    await run("H8 fallback and start", async () => ({ rows: (await op("inboxFallback")).length }));
    await run("H8 push badge fallback", async () => ({ rows: (await op("pushBadge")).length }));
    await run("H8 lifecycle start", async () => { await op("inboxStart"); });
    await run("H3 full rollback", async () => { await op("fullRollback"); });
    await run("H4 full save", async () => { await op("fullSave"); });
    await run("H3 edit", async () => { await op("update", { id: definition }); });
    await run("H3 run now", async () => { await op("runNow", { id: definition }); }, 1);
    const queued = (await harness.desktopApi("GET", "/api/routines")).body.runs.find((run: { status: string }) => run.status === "queued");
    expect(queued).toBeDefined(); await op("cancel", { id: queued.id }); await op("deleteRun", { id: queued.id });
    let deleted: unknown;
    await run("H3 delete run", async () => { deleted = await op("deleteRun", { id: fixture.sampleId }); }, -1);
    await op("restoreRun", { run: deleted });
    let created: { id: string };
    await run("H4 create", async () => { created = await op("create", { botId }); });
    await run("H4 delete", async () => { await op("remove", { id: created!.id }); });
    await run("H5 mark all seen", async () => { expect(await op("markAllSeen")).toHaveLength(3); });
    await op("repairFixture");
    await run("H5 delete bot", async () => { await op("disableForBot", { botId }); });
    await run("H5 delete room", async () => { await op("disableForGroup", { groupId }); });
    await run("H5 project close pause", async () => { await op("projectClosePause", { groupId }); });
    await run("R1 replaceStore notice", async () => { await op("replaceStore"); });
    await run("F1 persistence recovery", async () => { await op("recovery"); });
    await run("W1 workspace root", async () => { await op("workspaceRoot"); });
    await run("S startup enumeration", async () => { await op("startup"); });
    await run("D index diagnostics", async () => { await op("diagnostics"); });
    expect((await op("prepareOwed")).owed).toBe(3);
    await run("F2 owed delivery retry", async () => { const result = await op("owedRetry"); expect(result.owedBefore).toBe(3); expect(result.owedAfter).toBe(3); return { rows: result.owedBefore }; });
    await run("B15 bot roster aggregates", () => http("GET", "/api/bots?messages=0"));
  }
  ownerBotId = (await harness.desktopApi("POST", "/api/bots", { name: "Turn fixture" })).body.bot.id;
}, 900_000);

export async function measureOrdinaryOwnerTurn(size?: number) {
  if (size !== undefined) await control("seed", { ...seedInput, count: size });
  await control("start", { counting: false }); await http("GET", "/api/chats?limit=10"); await control("stop");
  const cardinality = (await control("start", { counting: false })).retained;
  const turn = await harness.startInternalFixtureTurn(ownerBotId, undefined, "hold this fixture turn");
  await http("GET", "/api/chats?limit=10");
  writeFileSync(join(harness.home, "finish-fake", String(turn.dump.pid)), "finish");
  await expect.poll(async () => (await harness.desktopApi("GET", "/api/bots?messages=0")).body.bots.find((row: { id: string }) => row.id === ownerBotId)?.busy, { timeout: 30000 }).toBe(false);
  await http("GET", "/api/chats?limit=10");
  const result = await control("stop");
  expect(result.retained, "owner turn preserves retained cardinality").toBe(cardinality);
  console.info("RHIST_OWNER_TURN", JSON.stringify({ size: cardinality, ...result }));
  return result.rebuilds as number;
}

export async function measureRoutineOwnerTurn(size?: number) {
  if (size !== undefined) await control("seed", { ...seedInput, count: size });
  // Keep refresh delivery outside the emit hook: one real HTTP request per broadcast.
  await op("allowDispatch"); await op("observeChats");
  const definition = (await harness.desktopApi("GET", "/api/routines")).body.routines[6];
  await op("setRoutineBot", { id: definition.id, botId: ownerBotId });
  await http("GET", "/api/chats?limit=10");
  const cardinality = (await control("start", { counting: false })).retained;
  // The original 10,000-run check still requires retirement. Below the cap the real completed receipt stays.
  const retired = cardinality >= 2000;
  const expectedRetained = cardinality + (retired ? 0 : 1);
  let fetched = 0;
  async function drain() {
    const pending = (await control("refreshes")).refreshes;
    while (fetched < pending) { await http("GET", "/api/chats?limit=10"); fetched++; }
  }
  const run = await op("runNow", { id: definition.id });
  await expect.poll(async () => {
    await drain();
    try { const value = JSON.parse(readFileSync(harness.fakeClaudeDump, "utf8")); if (!JSON.stringify(value.prompt).includes("Fixture report")) return false; return value.pid as number; } catch { return false; }
  }, { timeout: 30000 }).toBeTruthy();
  expect((await op("turnState", { id: run.id })).retained, "live routine adds one run before completion").toBe(cardinality + 1);
  const dump = JSON.parse(readFileSync(harness.fakeClaudeDump, "utf8"));
  writeFileSync(join(harness.home, "finish-fake", String(dump.pid)), "finish");
  await expect.poll(async () => {
    await drain();
    const state = await op("turnState", { id: run.id });
    return { completed: state.statuses.includes("completed"), present: state.present, retained: state.retained };
  }, { timeout: 30000 }).toEqual({ completed: true, present: !retired, retained: expectedRetained });
  await drain();
  const measured = await control("stop");
  expect(fetched).toBe(measured.refreshes);
  expect(measured.retained, "completed real result is delivered and retired above the cap; all N protected seed receipts remain").toBe(expectedRetained);
  console.info("RHIST_ROUTINE_TURN", JSON.stringify({ size: cardinality, ...measured, fetched }));
  return { rebuilds: measured.rebuilds as number, refreshes: measured.refreshes as number };
}
