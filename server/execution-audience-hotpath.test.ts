// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 io, the caller behind ~10,000 binding reads a second: homeThread (working-context.ts botContext, defaultThreadId, audienceTask) on a
// bot whose active task is not its home asked the human of EVERY task (2,400 on Sean's bots) before sorting, several times a second; and
// projectBotForTask asked one thread's human five times. Now the newest tasks are tried first and the first that fits is taken (the same task
// the old filter-then-sort chose), and a projection asks once. Synthetic data only.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, type BotRecord, type TaskRecord } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { homeThread, isHomePartition, threadPartition } from "./execution-audience.ts";
import { threadHasKeyed } from "./message-db.ts";
import { BINDING_MEMO_LIMITS, bindHumanThread, linkHumanBinding, observeVerifiedHuman, OWNER, resolveHumanBinding, threadHumanPrincipal } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { ioBudget } from "./io-budget.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const limits = { ...BINDING_MEMO_LIMITS };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { Object.assign(BINDING_MEMO_LIMITS, limits); });

/** Statements run so far (the io budget's own count): a binding read, a routine-run check, ... per task checked. */
const statementRuns = () => ioBudget.topStatements(500).reduce((n, cost) => n + cost.calls, 0);
/** homeThread as it was before 1.0.3 io: every task checked, then sorted. */
function reference(bot: BotRecord): TaskRecord | undefined {
  const active = bot.tasks?.find(t => t.threadId === bot.threadId);
  if (bot.partitionedAt === undefined && active && JSON.stringify(threadHumanPrincipal(active.threadId)) === JSON.stringify(OWNER)) return active;
  const eligible = (task: TaskRecord) => !task.sharedWork && isHomePartition(threadPartition(bot, task.threadId))
    && JSON.stringify(threadHumanPrincipal(task.threadId)) === JSON.stringify(OWNER) && !threadHasKeyed(task.threadId, "routineRun");
  return bot.tasks?.find(t => t.threadId === bot.threadId && eligible(t)) ?? bot.tasks?.filter(eligible).sort((a, b) => b.createdAt - a.createdAt)[0];
}
function person(userId: string) {
  const id = observeVerifiedHuman({ platform: "slack", authorityId: "TEAM", connectionId: "c-" + userId, userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "person" });
  return resolveHumanBinding(id);
}

it("a partitioned bot with 2,400 tasks and a shared active task: a call checks a few tasks, not every task", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Iris", section: "Design" });
  const sales = teamIdFor("Sales");
  const live = store.bot(bot.id)!;
  live.partitionedAt = 1; live.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] };
  const template = store.createTask(bot.id, "template", false)!;
  // 2,400 owner tasks (synthetic records; no messages), the newest last
  for (let i = 0; i < 2400; i++) live.tasks!.push({ ...structuredClone(template), threadId: `synthetic-${i}`, title: `task ${i}`, createdAt: 1_000_000 + i });
  const work = store.createSharedWorkTask(bot.id, sales)!; store.switchTask(bot.id, work.threadId);
  const db = database();
  const CALLS = 20;
  const want = reference(live);
  let runs = 0;
  for (let call = 0; call < CALLS; call++) {
    db.exec("UPDATE memory_scope_bindings SET revision=revision WHERE 0");  // a fresh memory per call, as across routes
    const start = statementRuns();
    const got = homeThread(live);
    runs += statementRuns() - start;
    expect(got).toBe(want);
  }
  const perCall = runs / CALLS;
  db.exec("UPDATE memory_scope_bindings SET revision=revision WHERE 0");
  const old0 = statementRuns(); reference(live); const oldPerCall = statementRuns() - old0;
  console.log(`[io-hotpath] homeThread tasks=${live.tasks!.length} statementsPerCall before=${oldPerCall} after=${perCall}`);
  expect(oldPerCall).toBeGreaterThan(2000);
  expect(perCall).toBeLessThanOrEqual(12);
}, 120_000);

it("homeThread picks exactly the task the old scan picked, over random task sets of owner, contact, shared and routine threads", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const sales = teamIdFor("Sales"), contact = person("UX");
  let seed = 7;
  const rand = (n: number) => { seed = (Math.imul(seed ^ (seed >>> 13), 0x5bd1e995) + 0x9e3779b9) >>> 0; return seed % n; };
  for (let round = 0; round < 25; round++) {
    const bot = store.createBot(); store.patchBot(bot.id, { name: `B${round}`, section: "Design" });
    const live = store.bot(bot.id)!;
    if (rand(2)) { live.partitionedAt = 1; live.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] }; }
    for (let i = 0; i < 30; i++) {
      const kind = rand(4);
      if (kind === 0) store.createSharedWorkTask(bot.id, sales);
      else {
        const task = store.createTask(bot.id, `t${i}`, false)!;
        if (kind === 1) bindHumanThread(task.threadId, contact);
        if (kind === 2) store.appendMessage(task.threadId, { role: "user", kind: "text", text: "routine", routineRunPrompt: { trigger: "manual", routineName: "r" } });
      }
    }
    live.tasks!.forEach(task => { task.createdAt = rand(10); });  // ties on purpose: the list order breaks them, as before
    const pick = live.tasks![rand(live.tasks!.length)]!; store.switchTask(bot.id, pick.threadId);
    const want = reference(live);
    if (want) expect(homeThread(live)).toBe(want);
  }
});

it("projectBotForTask reads the thread's human once and projects as before for owner and contact threads", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot(); const contact = person("UP");
  const owned = store.createTask(bot.id, "mine", false)!, theirs = store.createTask(bot.id, "theirs", false)!;
  bindHumanThread(theirs.threadId, contact);
  store.patchTask(bot.id, owned.threadId, { autoApprove: true, alwaysAllow: ["Bash"] } as never);
  BINDING_MEMO_LIMITS.BULK_MAX = 0;
  const db = database();
  db.exec("UPDATE memory_scope_bindings SET revision=revision WHERE 0");
  const reads = () => ioBudget.topStatements(500).filter(cost => cost.sql.includes("subject_type='human-thread'")).reduce((n, cost) => n + cost.calls, 0);
  const start = reads();
  const mine = store.projectBotForTask(bot.id, owned.threadId)!;
  expect(reads() - start).toBeLessThanOrEqual(1);
  expect(mine.autoApprove).toBe(true); expect(mine.alwaysAllow).toEqual(["Bash"]);
  const other = store.projectBotForTask(bot.id, theirs.threadId)!;
  expect(other.computer).toBe("off"); expect(other.autoApprove).toBe(false); expect(other.alwaysAllow).toEqual([]);
});

// Astra iohot2 (REVISE on 3bcd0bf29), Low execution-audience.ts:124: a task with a missing createdAt makes the comparator inconsistent, and
// sorting every task is not the same as sorting the eligible ones. Any such task takes the old path, exactly.
it("iohot2: [A(1, eligible), X(no createdAt, ineligible), B(2, eligible)] with no active match gives the old answer (B)", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const sales = teamIdFor("Sales"), contact = person("UX");
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Ada", section: "Design" });
  const live = store.bot(bot.id)!;
  live.partitionedAt = 1; live.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] };
  const a = store.createTask(bot.id, "A", false)!, x = store.createTask(bot.id, "X", false)!, b = store.createTask(bot.id, "B", false)!;
  bindHumanThread(x.threadId, contact);
  const work = store.createSharedWorkTask(bot.id, sales)!;
  const byThread = (t: TaskRecord) => live.tasks!.find(task => task.threadId === t.threadId)!;
  const [A, X, B, W] = [byThread(a), byThread(x), byThread(b), byThread(work)];
  A.createdAt = 1; delete (X as { createdAt?: number }).createdAt; B.createdAt = 2; W.createdAt = 3;
  live.tasks = [A, X, B, W];
  store.switchTask(bot.id, W.threadId);
  expect(live.threadId).toBe(W.threadId);
  const want = reference(live);
  expect(want?.threadId).toBe(B.threadId);
  expect(homeThread(live).threadId).toBe(B.threadId);
  // and a non-finite one (NaN) the same way
  (X as { createdAt: number }).createdAt = Number.NaN;
  expect(homeThread(live).threadId).toBe(reference(live)!.threadId);
});
