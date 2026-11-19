// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 T1 (hunt-turnerr): every registered bot/room/task root and mount is published to the turn's delete check
// (drivers/murage-exec-wipe.ts wipeGuardRootPaths). An install with more than 512 of them made startWipeGuardTurn throw
// wipe-guard-invalid-turn, so every owner No-limits turn through the guarded exec path ended at once. Real registry, real root list, real
// guard start: 600 task roots start the guard, and every one of them is in the guard file (never truncated).
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wipeGuardRootPaths } from "../drivers/murage-exec-wipe.ts";
import { registeredWipeProjects } from "../wipe/registry.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { startWipeGuardTurn } from "./server.ts";
import type { GuardFile } from "./guard-file.ts";

const TASK_ROOTS = 600;
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform === "win32")("1.0.20 T1: a delete check for an install with many registered roots", () => {
  it(`starts with ${TASK_ROOTS} registered task roots and publishes every one`, async () => {
    const parent = mkdtempSync(join(tmpdir(), "wg-many-"));
    cleanups.push(() => removeTempDirSync(parent));
    const owners: string[] = [];
    for (let n = 0; n < TASK_ROOTS; n++) {
      const owner = `task:bot-many:${n}`; owners.push(owner);
      registeredWipeProjects.replace(owner, [join(parent, "tasks", `t${n}`)]);
    }
    cleanups.push(() => { for (const owner of owners) registeredWipeProjects.drop(owner); });
    const project = join(parent, "project"); mkdirSync(project);
    const ctx = { project, cwd: project, home: join(parent, "home"), dataDir: join(parent, "data") };
    const roots = wipeGuardRootPaths(ctx, [], "linux");
    expect(roots.length).toBeGreaterThan(TASK_ROOTS);
    const guard = await startWipeGuardTurn({ directory: parent, threadId: "t-many", roots, client: [process.execPath, join(parent, "client.mjs")],
      realTools: { rm: process.execPath }, context: ctx, isLive: () => true, askWipe: async () => "deny" });
    cleanups.push(() => guard.end());
    const published = (JSON.parse(readFileSync(guard.file, "utf8")) as GuardFile).roots;
    for (let n = 0; n < TASK_ROOTS; n++) expect(published).toContain(join(parent, "tasks", `t${n}`));
  });
});
