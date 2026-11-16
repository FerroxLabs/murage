// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineRequestCommit } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(m => m.stop()); roots.splice(0).forEach(root => removeTempDirSync(root)); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-proposal-red-")); roots.push(root);
  const m = new RoutineManager({ file: join(root, "routines.json"), botState: () => "busy", createTask: () => null, startTurn: async () => {} }); managers.push(m); return m;
}
const request: RoutineRequestCommit = { requestId: "request", messageId: "message", botId: "bot", threadId: "thread", action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64) };
for (const phase of ["begin", "action", "result", "cleanup"] as const) it(`P35 exact-base RED ${phase} must avoid a full history transaction`, () => {
  const m = fixture();
  if (phase !== "begin") m.beginRoutineRequest(request, { before: { absent: true }, ...(phase === "result" ? { kind: "webhook" as const } : {}) });
  const full = vi.spyOn(m as unknown as { commitMutation(fn: () => void): void }, "commitMutation");
  if (phase === "begin") m.beginRoutineRequest(request, { before: { absent: true } });
  if (phase === "action") m.create({ name: "Fake", prompt: "Fake", botId: "bot", enabled: false, schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } }, request as never);
  if (phase === "result") m.completeRoutineRequest(request, "hook", Date.now());
  if (phase === "cleanup") m.forgetRoutineRequestReceipt(request);
  expect(full, "automatic proposal may not clone unrelated run/receipt history").not.toHaveBeenCalled();
});
