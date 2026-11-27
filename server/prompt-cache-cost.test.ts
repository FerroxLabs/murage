// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createTaskAggregateCache, taskWindowWork } from "./task-window.ts";
import { directTurnLayers, joinShapeLayers, type DirectTurnShapeInput } from "./bot-shapes.ts";
import { addCacheUsage, requestUsage } from "../shared/prompt-cache-usage.ts";

const input: DirectTurnShapeInput = { houseRules: "RULES", persona: "PERSONA", computerKind: null, vmPerBot: false, driverKind: "fixture", connectors: " APPS", requiredApps: "", browser: " BROWSER", coordination: "", credential: "", image: "", webSearchBackup: false, routines: "", learn: "", importedSkills: "", teamBrief: " BRIEF", memory: " NOTES", primer: " PRIMER", skills: [], playbooks: "", outputFolder: "", tagged: [] };
it("PC-R2-history-work-bound: current prompt assembly and usage deltas do equal work with 100 and 100000 old tasks", () => {
  const measure = (length: number) => {
    let reads = 0, active = false;
    const before = { ...requestUsage(100, 1, 80), costUsd: null, turns: 1 };
    const rows = Array.from({ length }, (_, n) => ({ threadId: `task-${n}`, createdAt: n, usage: n === 0 ? before : undefined }));
    const tasks = new Proxy(rows, { get(target, key, receiver) { if (active && typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
    const cache = createTaskAggregateCache();
    const get = () => cache.get("fixture", tasks, "task-0", "revision", 10, () => undefined);
    get(); active = true;
    const builds = taskWindowWork.builds, visits = taskWindowWork.tasksVisited;
    const after = { ...addCacheUsage(before, requestUsage(100, 1, undefined)), costUsd: null, turns: 2 };
    cache.noteUsage("fixture", before, after); rows[0].usage = after;
    const text = joinShapeLayers(directTurnLayers(input));
    const usage = get().usage;
    expect(usage).toMatchObject({ input: 200, output: 2, cachedInput: 80, usageAccounting: { inputComplete: true, cacheComplete: false } });
    const times: number[] = [];
    for (let n = 0; n < 10; n++) {
      const started = performance.now();
      joinShapeLayers(directTurnLayers(input));
      const previous: typeof before = rows[0].usage!;
      const next: typeof before = { ...previous, ...addCacheUsage(previous, requestUsage(1, 0, 0)), turns: previous.turns + 1 };
      cache.noteUsage("fixture", previous, next); rows[0].usage = next; get();
      times.push(performance.now() - started);
    }
    times.sort((a,b) => a-b);
    console.info("PROMPT_CACHE_WORK", JSON.stringify({ history: length, samples: times.length, medianMs: times[5], p95Ms: times[9], historyReads: reads, usageBytes: JSON.stringify(usage).length }));
    expect(reads).toBe(0); expect(taskWindowWork.builds - builds).toBe(0); expect(taskWindowWork.tasksVisited - visits).toBe(0);
    return { text, usage, bytes: JSON.stringify(usage).length, reads };
  };
  expect(measure(100000)).toEqual(measure(100));
});
