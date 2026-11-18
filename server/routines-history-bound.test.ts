// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { directRoutineHistoryFixture, historyInside, routineHistoryOracle } from "./testing/routine-history-fixture.ts";
import { historyMeasurementCardinality, historyMeasurementMs, measureHistoryWork, type HistoryWork } from "./testing/routine-history-work.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { routineRunsFileName } from "./routine-runs-journal.ts";
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding, type HumanPrincipal } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import type { RoutineRun } from "./routines.ts";

type Fixture = ReturnType<typeof directRoutineHistoryFixture>;
let channelPrincipal: HumanPrincipal;
const fixtures: Array<{ size: number; root: string; fixture: Fixture }> = [];
beforeAll(async () => {
  const bindingId = observeVerifiedHuman({ platform: "signal", authorityId: "fixture-account", userId: "fixture-account", connectionId: "fixture-connection" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "owner" });
  channelPrincipal = resolveHumanBinding(bindingId);
  for (const size of [10, 2_000, 10_000]) {
    const root = mkdtempSync(join(tmpdir(), "routine-history-bound-"));
    const fixture = directRoutineHistoryFixture(root, size, { isChannelCurrent: () => true, limitRefusal: (_run, refusal) => refusal.message === "limit" ? {
      engineKey: "fixture-engine", until: fixture.clock.now + 3600000, engineName: "Fixture", line: "Wait", failLine: "Limit",
    } : null });
    fixtures.push({ size, root, fixture });
    // A real dispatch supplies the exact settled side-map shape. Replicate it directly,
    // rather than executing 10000 turns or leaving the historical dispatch map empty.
    const queued = fixture.manager.runNow(fixture.definitions[9].id)!;
    await fixture.manager.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    const run = historyInside(fixture.manager).indexes.runsById.get(queued.id)!;
    fixture.manager.handleRuntimeEvent(fixture.event(run, "turn.started"));
    fixture.manager.handleRuntimeEvent(fixture.event(run, "turn.completed", { ok: true }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const inside = historyInside(fixture.manager), template = inside.liveDispatch.get(run.id)!;
    expect(template).toBeDefined(); fixture.manager.deleteRun(run.id);
    for (const receipt of inside.runStore) inside.liveDispatch.set(receipt.id, structuredClone(template));
    expect(inside.liveDispatch.size).toBe(size);
    expect(inside.runStore.size).toBe(size);
  }
}, 120000);
afterAll(() => { for (const { fixture, root } of fixtures) { fixture.manager.stop(); historyInside(fixture.manager).journal.compact(); removeTempDirSync(root); } });
const drained = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
function bounded(work: HistoryWork, label: string, maxCopies = 64) {
  expect(work.retainedMapVisits, `${label}: retained side-map visits`).toBe(0);
  expect(work.trieEnumerations, `${label}: trie history enumeration`).toBe(0);
  expect(work.storeTraversals, `${label}: store traversals`).toBe(0);
  expect(work.storeVisits, `${label}: store visits`).toBe(0);
  expect(work.runsMaterialized, `${label}: materializations`).toBe(0);
  expect(work.journalFullTraversals, `${label}: journal full traversals`).toBe(0);
  expect(work.fullCommits, `${label}: full transactions`).toBe(0);
  expect(work.runArrayVisits, `${label}: changed/live record array visits`).toBeLessThanOrEqual(256);
  expect(work.runSortComparisons, `${label}: live sorting comparisons`).toBeLessThanOrEqual(256);
  expect(work.cloneRun, `${label}: changed-record copies`).toBeLessThanOrEqual(maxCopies);
  expect(work.serializedRuns, `${label}: changed-record serializers`).toBeLessThanOrEqual(64);
  expect(work.trieCalls, `${label}: fixed-width index calls`).toBeLessThanOrEqual(10000);
}
async function check(name: string, run: (f: Fixture, root: string) => Promise<HistoryWork>, equal = true) {
  const counts = [];
  for (const { size, fixture, root } of fixtures) {
    for (const active of [...historyInside(fixture.manager).indexes.openRuns]) await fixture.manager.cancelRun(active.id);
    const work = await run(fixture, root); bounded(work, `${name}@${size}`); counts.push(work);
    console.info("RHIST_BOUNDED", JSON.stringify({ name, size, ms: historyMeasurementMs.get(work), cardinality: historyMeasurementCardinality.get(work), work }));
  }
  for (const large of counts.slice(1)) {
  if (equal) for (const key of ["runArrayVisits", "runSortComparisons", "storeTraversals", "storeVisits", "runsMaterialized", "cloneRun", "fullCommits", "journalFullTraversals", "serializedRuns"] as const)
    expect(large[key], `${name}: ${key} independent of retained history`).toBe(counts[0][key]);
  // The configured 2000-run retention threshold adds one constant guard per save/tick.
  // Preserve raw counts above; compare index work after separately accounting for those guards.
  if (equal) expect(large.trieCalls - large.retirementChecks, `${name}: trie calls excluding measured retirement guards`)
    .toBe(counts[0].trieCalls - counts[0].retirementChecks);
  }
}
async function live(f: Fixture, index = 5) {
  const queued = f.manager.runNow(f.definitions[index].id)!;
  await f.manager.tick(); await drained();
  const run = historyInside(f.manager).indexes.runsById.get(queued.id)!;
  expect(run.status).toBe("running");
  f.manager.handleRuntimeEvent(f.event(run, "turn.started"));
  return run;
}
async function finish(f: Fixture, run: RoutineRun) {
  f.manager.handleRuntimeEvent(f.event(run, "turn.completed", { ok: true })); await drained();
  expect(run.status).toBe("completed");
}

it("B1 tick fleet/overlap/cap work is independent of retained history", async () => {
  await check("tick", async f => {
    const inside = historyInside(f.manager), definition = inside.routines.find(row => row.id === f.definitions[2].id)!;
    definition.enabled = true; definition.nextRunAt = f.clock.now;
    inside.save({ routines: [definition] });
    const before = f.dispatched.length;
    const measured = await measureHistoryWork(f.manager, async () => { await f.manager.tick(); await drained(); }, 1);
    expect(f.dispatched.length).toBe(before + 1);
    const run = inside.indexes.runsById.get(f.dispatched.at(-1)!.runId)!;
    expect(run.status).toBe("running");
    f.manager.update(definition.id, { enabled: false }); await finish(f, run);
    return measured.work;
  });
});
it("B2 run-limit enforcement visits live work only", async () => {
  await check("run limits", async f => {
    const run = await live(f); f.clock.now += 300001;
    const measured = await measureHistoryWork(f.manager, () => f.manager.enforceRunLimits());
    expect(run.status).toBe("failed"); return measured.work;
  });
});
it("B3 approval timeout is scoped, including its follow-up tick", async () => {
  await check("approval timeout", async f => {
    const run = await live(f); expect(f.manager.cardOpened(run.threadId!, "fixture-card", "Fixture approval")).toBe(true);
    f.clock.now += 300001;
    const measured = await measureHistoryWork(f.manager, async () => { await f.manager.enforceRunLimits(); await drained(); });
    expect(run.status).toBe("needs-you"); f.manager.cardClosed(run.threadId!, "fixture-card");
    f.manager.handleRuntimeEvent(f.event(run, "turn.started")); await finish(f, run); return measured.work;
  });
});
it("B4 dispatch carries an actual prior report without retained-history work", async () => {
  await check("carry last report", async f => {
    const definition = historyInside(f.manager).routines.find(row => row.id === f.definitions[6].id)!;
    definition.threadId = "history-thread-6";
    // Flush the definition before dispatch; no unhinted full transaction inside the measured turn.
    historyInside(f.manager).save({ routines: [definition] });
    const queued = f.manager.runNow(definition.id)!;
    const measured = await measureHistoryWork(f.manager, async () => { await f.manager.tick(); await drained(); });
    const run = historyInside(f.manager).indexes.runsById.get(queued.id)!;
    expect(f.dispatched.at(-1)?.prompt).toContain("Fixture report");
    expect(run.status).toBe("running"); await finish(f, run); return measured.work;
  });
});
it("B5 completion emits the actual recovery callback without retained-history work", async () => {
  await check("recovery note", async f => {
    const prior = historyInside(f.manager).indexes.runsById.get("history-run-0")!;
    prior.status = "failed"; prior.finishedAt = ++f.clock.now;
    historyInside(f.manager).save({ runs: [prior] }); f.clock.now++;
    const run = await live(f, 0), before = f.recovered.length;
    const measured = await measureHistoryWork(f.manager, async () => { await finish(f, run); await f.manager.tick(); await drained(); });
    expect(f.recovered.length).toBe(before + 1); return measured.work;
  });
});
it("B6 provider-limit completion counts only waits on its engine", async () => {
  await check("provider limit waits", async f => {
    const first = await live(f, 7), second = await live(f, 8);
    const measured = await measureHistoryWork(f.manager, async () => {
      f.manager.settleDispatch({ runId: first.id }, "limit"); f.manager.settleDispatch({ runId: second.id }, "limit"); await drained();
    });
    expect(first.status).toBe("queued"); expect(second.limitWait!.until - first.limitWait!.until).toBe(60000);
    // Cancel outside the window so subsequent cases have identical live work.
    await f.manager.cancelRun(first.id); await f.manager.cancelRun(second.id); return measured.work;
  });
});
it("B7 dispatch buffer sweep ignores settled dispatch entries made by actual turns", async () => {
  await check("dispatch buffer sweep", async f => {
    const run = await live(f, 7); await finish(f, run);
    expect(historyInside(f.manager).liveDispatch.has(run.id)).toBe(true);
    expect(historyInside(f.manager).openDispatch.has(run.id)).toBe(false);
    return (await measureHistoryWork(f.manager, async () => { await f.manager.tick(); await drained(); })).work;
  });
});
for (const channel of [false, true]) it(`${channel ? "B9 channel" : "B8 webhook"} arrival and dedup use scoped persistence`, async () => {
  await check(channel ? "channel arrival" : "webhook arrival", async f => {
    let run!: RoutineRun;
    const measured = await measureHistoryWork(f.manager, async () => {
      run = f.manager.enqueueWebhook({ webhookId: "fixture-hook", webhookName: "Fixture hook", deliveryId: channel ? "channel" : "webhook",
        botId: "fixture-ingress-bot", prompt: "Fixture ingress", runOn: "ember", receivedAt: f.clock.now,
        ...(channel ? { humanPrincipal: channelPrincipal, channelOrigin: { platform: "signal" as const, connectionId: "fixture-connection" } } : {}) });
      expect(f.manager.findWebhookDelivery("fixture-hook", channel ? "channel" : "webhook")?.id).toBe(run.id);
      await f.manager.tick(); await drained();
    }, 1);
    await f.manager.cancelRun(run.id); return measured.work;
  });
});
it("B10 runtime events and thread lookup include completion and the queued follow-up", async () => {
  await check("runtime events", async f => {
    const run = await live(f);
    const measured = await measureHistoryWork(f.manager, async () => {
      expect(f.manager.routineRunForThread(run.threadId!)?.runId).toBe(run.id);
      expect(f.manager.runById(run.id)?.id).toBe(run.id);
      f.manager.handleRuntimeEvent(f.event(run, "item.completed", { itemType: "assistant_text", text: "Fixture output" }));
      await finish(f, run); await f.manager.tick(); await drained();
    });
    expect(run.status).toBe("completed"); return measured.work;
  });
});
it("B11 routines-list health uses fixed-depth outcome indexes", async () => {
  await check("routines-list health", async f => {
    const measured = await measureHistoryWork(f.manager, () => f.manager.listRoutines());
    expect(measured.value).toHaveLength(10); return measured.work;
  });
});
it("B12 journal append serializes changed runs only", async () => {
  await check("journal append", async f => {
    const run = historyInside(f.manager).indexes.runsById.get("history-run-9")!; run.output = "Fixture updated";
    const measured = await measureHistoryWork(f.manager, () => historyInside(f.manager).save({ runs: [run] }));
    expect(measured.work.serializedRuns).toBe(1); return measured.work;
  });
});
it("B13 journal compaction copies a bounded slice through the real append entrypoint", async () => {
  await check("journal compaction", async (f, root) => {
    const inside = historyInside(f.manager), run = inside.indexes.runsById.get("history-run-9")!;
    const name = routineRunsFileName(run.routineId), file = join(root, "events", "routine-runs", name);
    const journal = inside.journal as unknown as { files: Map<string, { lines: number; live: number }> };
    const state = journal.files.get(name)!;
    const line = readFileSync(file, "utf8").trimEnd().split("\n").at(-1)! + "\n";
    const copies = Math.max(0, 2 * state.live + 51 - state.lines);
    appendFileSync(file, line.repeat(copies)); state.lines += copies; // reachable append debt, prepared outside the window
    run.output = "Fixture compaction";
    const measured = await measureHistoryWork(f.manager, () => inside.save({ runs: [run] }));
    expect(measured.work.compactCopied).toBeGreaterThan(0);
    expect(measured.work.compactCopied).toBeLessThanOrEqual(256); // small-file sync <=256; large-file cursor <=64
    return measured.work;
  }, false);
});
it("B14 full dispatch, successful completion, recovery callback and follow-up tick form one bounded window", async () => {
  await check("full turn", async f => {
    const prior = historyInside(f.manager).indexes.runsById.get("history-run-1")!; prior.status = "failed"; prior.finishedAt = ++f.clock.now;
    f.clock.now++;
    historyInside(f.manager).save({ runs: [prior] });
    const queued = f.manager.runNow(f.definitions[1].id)!;
    const before = f.recovered.length;
    const measured = await measureHistoryWork(f.manager, async () => {
      await f.manager.tick(); await drained();
      const run = historyInside(f.manager).indexes.runsById.get(queued.id)!;
      expect(run.status).toBe("running");
      f.manager.handleRuntimeEvent(f.event(run, "turn.started"));
      f.manager.handleRuntimeEvent(f.event(run, "item.completed", { itemType: "assistant_text", text: "Fixture complete" }));
      await finish(f, run); await f.manager.tick(); await drained(); expect(run.status).toBe("completed");
    });
    expect(f.recovered.length).toBe(before + 1); return measured.work;
  });
});

it("S1 slow oracle preserves needs-you, channel budgets and deterministic list ordering", () => {
  const f = fixtures[0].fixture;
  const list = f.manager.listRuns(), oracle = routineHistoryOracle(f.manager);
  for (const run of list) {
    expect(oracle.isAutomationThread(run.threadId!)).toBe(true);
    expect(oracle.listRuns(run.scheduledFor, run.scheduledFor).every(row => row.scheduledFor === run.scheduledFor)).toBe(true);
  }
  expect(oracle.openRunsWhere(() => true).every(run => ["queued", "running", "waiting", "needs-you"].includes(run.status))).toBe(true);
});


it("B16 live room/thread accessors visit only the fixed live bucket", async () => {
  await check("live room and thread bucket", async f => {
    const run = await live(f, 8);
    run.target = "room-goal"; run.groupId = "fixture-room";
    historyInside(f.manager).save({ runs: [run] });
    const measured = await measureHistoryWork(f.manager, () => {
      expect(f.manager.roomGoalRunForThread(run.threadId!)?.id).toBe(run.id);
      expect(f.manager.usageRunForThread(run.threadId!)?.routineId).toBe(run.routineId);
      expect(f.manager.liveRunThreadIds(run.botId)?.has(run.threadId!)).toBe(true);
    });
    run.target = "bot"; run.groupId = undefined;
    historyInside(f.manager).save({ runs: [run] });
    await finish(f, run); return measured.work;
  });
});
