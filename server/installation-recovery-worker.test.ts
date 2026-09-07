import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const worker = fileURLToPath(new URL("../scripts/installation-recovery-worker.ts", import.meta.url));

it("the actual worker emits a bounded summary without archive contents or inherited provider configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-recovery-worker-")); roots.push(root);
  const data = join(root, "source"); mkdirSync(data);
  const original = '{"profile":{"name":"Private fixture"},"flux":{"apiKey":"private-worker-canary"}}';
  writeFileSync(join(data, "config.json"), original);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [worker, "backup", "--data-dir", data, "--output", join(root, "backup.zip")], { timeout: 20_000, env: { PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ ok: true, operation: "backup", omittedCount: 1 });
  expect(stdout.length).toBeLessThan(4096);
  expect(stdout + stderr).not.toContain("private-worker-canary");
  expect(result.omitted).toBeUndefined();
  expect(readFileSync(join(data, "config.json"), "utf8")).toBe(original);
});
