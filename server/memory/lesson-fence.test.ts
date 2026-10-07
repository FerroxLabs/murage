// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tier 1 allowlist (TIER1-ALLOWLIST.md sections 3.5 and 6.4): lessons are prompt text only. Approval, permission mode, always-allow,
// budgets and tool mounts are host state that never reads memory_lessons. This is a static import-graph test: none of those modules
// reaches lessons.ts, lesson-spec.ts or the learned block, directly or through anything they import, and none of them names the table.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The host-state modules: who may act, on what, with whose yes. */
const HOST_STATE = [
  "auto-approve.ts", "auto-review.ts", "permission-proxy.ts", "permission-status.ts", "routine-permissions.ts", "peer-approval.ts", "peer-approval-key.ts",
  "own-workspace-approval.ts", "image-approval.ts", "telegram-approvals.ts", "browser-extension-approvals.ts", "approval-notification-state.ts", "message-allow.ts",
  "custom-mcp-mounts.ts", "turn-dispatch-guard.ts",
];
/** What a lesson is made of. */
const LESSON_MODULES = ["memory/lessons.ts", "memory/lesson-spec.ts", "memory/lesson-sharing.ts", "memory/lesson-lineage.ts", "memory/lessons-local.ts", "memory/learning-wiring.ts"];

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+\.ts)["']/g;
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT)) { const target = resolve(dirname(file), match[1]!); if (existsSync(target)) out.push(target); }
  return out;
}
/** store.ts is the persistence hub that nearly every server module imports, and the memory subsystem is a separate layer that
 * reaches lessons for its own chips. The fence follows what a host-state module imports for itself: the walk does not continue
 * through the hub or into the memory subsystem, but a lesson module reached at any step (directly, or through another server
 * module such as bot-shapes) is a failure. */
const HUBS = new Set(["store.ts", "database.ts", "message-db.ts", "config.ts"].map(name => join(SERVER, name)));
const inMemoryLayer = (file: string) => file.startsWith(join(SERVER, "memory") + "/");
function closure(entry: string): Map<string, string> {
  const parent = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const next of importsOf(file)) {
      if (parent.has(next) || next === entry) continue;
      parent.set(next, file);
      const isLesson = LESSON_MODULES.some(name => join(SERVER, name) === next);
      if (!HUBS.has(next) && (!inMemoryLayer(next) || isLesson)) queue.push(next);
    }
  }
  return parent;
}
const chain = (parent: Map<string, string>, end: string, entry: string): string => {
  const path = [end];
  for (let cur = end; parent.has(cur) && cur !== entry;) { cur = parent.get(cur)!; path.unshift(cur); }
  return path.map(file => file.slice(SERVER.length + 1)).join(" -> ");
};

describe("approvals, permissions and tool mounts sit outside lessons", () => {
  it("lists host-state modules that exist, so the fence cannot silently shrink", () => {
    const present = HOST_STATE.filter(name => existsSync(join(SERVER, name)));
    expect(present.length).toBeGreaterThanOrEqual(10);
    for (const name of LESSON_MODULES) expect(existsSync(join(SERVER, name)), name).toBe(true);
  });
  for (const name of HOST_STATE) {
    it(`${name} never reaches a lesson module, directly or through its imports`, () => {
      const entry = join(SERVER, name);
      if (!existsSync(entry)) return;
      const reached = closure(entry);
      const forbidden = LESSON_MODULES.map(module => join(SERVER, module)).filter(file => reached.has(file));
      expect(forbidden.map(file => chain(reached, file, entry)), name).toEqual([]);
      expect(readFileSync(entry, "utf8"), name).not.toMatch(/memory_lessons|what-it-learned|renderLearnedBlock/);
    });
  }
});
