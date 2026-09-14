import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../server/testing/cleanup.ts", () => ({ removeTempDir: vi.fn(), waitForExit: vi.fn() }));
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createHarness } from "./channel-live-harness.ts";
import { Checks, finishCleanup } from "./channel-live-qualify.ts";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
it("reports retained roots and adds final cleanup failure without losing primary failure", async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "channel-cleanup-evidence-")); roots.push(evidenceDir);
  const harness = await createHarness({ label: "cleanup-test", evidenceDir }); roots.push(harness.root);
  vi.mocked(removeTempDir).mockResolvedValue(undefined);
  const checks = new Checks(() => harness); checks.expect("primary", "preserved primary failure", false);
  await finishCleanup(harness, checks);
  expect(existsSync(harness.root)).toBe(true);
  expect(checks.list.map(check => [check.id, check.outcome])).toEqual([["primary", "fail"], ["cleanup", "fail"]]);
  expect(readFileSync(join(evidenceDir, "steps.jsonl"), "utf8")).toContain('"rootRemoved":false');
  expect(checks.list[1].detail).toMatchObject({ retainedRoot: harness.root });
});
it("records removal only after the root is absent and closes idempotently", async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "channel-cleanup-evidence-")); roots.push(evidenceDir);
  const harness = await createHarness({ label: "cleanup-test", evidenceDir }); roots.push(harness.root);
  vi.mocked(removeTempDir).mockImplementation(async root => { rmSync(root, { recursive: true, force: true }); });
  await harness.close(); await harness.close();
  expect(existsSync(harness.root)).toBe(false); expect(removeTempDir).toHaveBeenCalledOnce();
  expect(readFileSync(join(evidenceDir, "steps.jsonl"), "utf8")).toContain('"rootRemoved":true');
});
