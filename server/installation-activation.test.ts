import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { reviewInstallation, activateInstallation } from "./installation-activation.ts";
import { assertRestoreReviewed, RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { RESTORED_CONNECTIONS_FILE } from "../electron/restored-connections.mjs";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { freePortBlock } from "./testing/ports.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-activation-")); roots.push(root);
  const source = join(root, "source"), target = join(root, "target"); mkdirSync(source); mkdirSync(target);
  writeFileSync(join(source, "config.json"), "{}");
  writeFileSync(join(source, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "History bot" }]));
  writeFileSync(join(source, "groups.json"), "[]");
  writeFileSync(join(target, "original.txt"), "retained-original");
  const archive = join(root, "backup.zip"), saved = await writeInstallationArchive(source, archive);
  await restoreInstallation(target, archive, saved.sha256);
  return { root, target };
}
it("requires explicit hash-bound review and retains the permanent startup decision", async () => {
  const f = await fixture();
  expect(() => assertRestoreReviewed(f.target)).toThrow();
  const review = reviewInstallation(f.target);
  expect(review).toMatchObject({ engines: "disabled", schedules: "paused", activationAvailable: true });
  const result = activateInstallation(f.target, review.reviewHash);
  expect(result.status).toBe("reviewed-engines-disabled");
  expect(() => assertRestoreReviewed(f.target)).not.toThrow();
  expect(JSON.parse(readFileSync(join(f.target, RESTORE_REVIEW_FILE), "utf8")).reviewedTreeHash).toBe(review.reviewHash);
});
it("changed data invalidates approval without unlocking startup", async () => {
  const f = await fixture(), review = reviewInstallation(f.target);
  writeFileSync(join(f.target, "new-note.txt"), "changed after review");
  expect(() => activateInstallation(f.target, review.reviewHash)).toThrowError(expect.objectContaining({ code: "REVIEW_STATE_CHANGED" }));
  expect(() => assertRestoreReviewed(f.target)).toThrow();
});
it("enabled work and a live owner refuse activation", async () => {
  const f = await fixture();
  const config = JSON.parse(readFileSync(join(f.target, "config.json"), "utf8"));
  config.instances.fuigo.enabled = true;
  writeFileSync(join(f.target, "config.json"), JSON.stringify(config));
  expect(() => reviewInstallation(f.target)).toThrowError(expect.objectContaining({ code: "RESTORE_WORK_NOT_PAUSED" }));
  const lease = acquireDataDirLease(f.target);
  try { expect(() => reviewInstallation(f.target)).toThrow(); } finally { lease.release(); }
});
it.each(["config.json", RESTORED_CONNECTIONS_FILE])("missing %s after review cannot fall back to old settings", async file => {
  const f = await fixture(), review = reviewInstallation(f.target);
  activateInstallation(f.target, review.reviewHash);
  rmSync(join(f.target, file));
  expect(() => assertRestoreReviewed(f.target)).toThrowError(expect.objectContaining({ code: "RESTORE_REVIEW_REQUIRED" }));
});

it("the actual harness opens reviewed history with every engine disabled", async () => {
  const f = await fixture(), review = reviewInstallation(f.target);
  activateInstallation(f.target, review.reviewHash);
  const port = await freePortBlock([0, 1]);
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
    env: { PATH: dirname(process.execPath), HOME: f.root, USERPROFILE: f.root, MURAGE_DATA_DIR: f.target, MURAGE_PORT: String(port), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += String(chunk); }); child.stdout?.on("data", () => {});
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(stderr);
      try { const response = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(500) }); ready = response.ok; } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(ready, stderr).toBe(true);
    const response = await fetch("http://127.0.0.1:" + port + "/api/instances");
    const body = await response.json() as { instances: Array<{ enabled: boolean; snapshot: { state: string } }> };
    expect(body.instances.length).toBeGreaterThan(0);
    expect(body.instances.every(instance => instance.enabled === false && instance.snapshot.state === "unavailable")).toBe(true);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("owned fixture did not exit")), 10_000))]);
  }
}, 20_000);
