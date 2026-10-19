// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 (ATTACHMENT-CAP-DESIGN.md): Files keeps copies until the disk is
// nearly full, by the same rule as attachments, instead of a fixed 512 MiB
// and 10,000 files. A crash-left `.candidate-*` copy is cleared at start-up.
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});
const realWriteFileSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).writeFileSync;
// The test setup loads artifacts.ts (through the message store) before this
// file's mock applies; a fresh registry gives this file the mocked copy.
vi.resetModules();

import type { ArtifactAccess } from "./artifacts.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const { artifactsRequest, artifactStorageBytes, initializeArtifacts, registerArtifact, sweepArtifactCandidates } = await import("./artifacts.ts");
const { DISK_FLOOR_BYTES, __resetOutstandingBytesForTests, __setFreeDiskProbeForTests, addOutstandingBytes } = await import("./disk-space.ts");
const { DISK_FULL_MESSAGE, DISK_UNKNOWN_MESSAGE } = await import("../shared/attachment-storage.ts");

const PLENTY = 200 * 1024 * 1024 * 1024;
const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => {
  vi.mocked(writeFileSync).mockReset().mockImplementation(realWriteFileSync);
  __setFreeDiskProbeForTests(undefined);
  __resetOutstandingBytesForTests();
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-artifact-disk-")); roots.push(root);
  const workspace = join(root, "workspace"), storage = join(root, "artifact-files"); mkdirSync(workspace);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db); initializeArtifacts(db);
  const access: ArtifactAccess = { owner: true, scopes: [{ botId: "bot", botName: "Research bot", threadId: "thread", runId: "run", workspaceRoot: workspace }] };
  const input = { botId: "bot", threadId: "thread", relativePath: "report.html", name: "Weekly report" };
  realWriteFileSync(join(workspace, input.relativePath), "<!doctype html><h1>Verified weekly result</h1>");
  return { root, workspace, storage, db, access, input };
}
const candidates = (storage: string) => readdirSync(storage).filter((name) => name.startsWith(".candidate-"));

it("saves past 512 MiB of existing copies when the disk has room", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => PLENTY);
  mkdirSync(f.storage, { mode: 0o700 });
  const existing = join(f.storage, "a".repeat(64) + ".bin"), fd = openSync(existing, "w"); ftruncateSync(fd, 600 * 1024 * 1024); closeSync(fd);
  const saved = registerArtifact(f.db, f.storage, f.input, f.access);
  expect(saved.name).toBe("Weekly report");
  expect(artifactStorageBytes(f.storage)).toBeGreaterThan(600 * 1024 * 1024);
});

it("refuses with the shared disk-full words and code when the disk is under the floor", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => DISK_FLOOR_BYTES + 10);
  expect(() => registerArtifact(f.db, f.storage, f.input, f.access)).toThrow(DISK_FULL_MESSAGE);
  const answer = artifactsRequest(f.db, f.storage, { method: "POST", path: "/api/artifacts/register", body: f.input }, f.access);
  expect(answer).toEqual({ status: 507, body: { error: DISK_FULL_MESSAGE, code: "disk-full" } });
  expect(readdirSync(f.storage)).toEqual([]);
});

it("subtracts bytes attachments are still streaming, so both stores cannot take the same last space", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => DISK_FLOOR_BYTES + 1024 * 1024);
  addOutstandingBytes(1024 * 1024 - 10);
  expect(() => registerArtifact(f.db, f.storage, f.input, f.access)).toThrow(DISK_FULL_MESSAGE);
  __resetOutstandingBytesForTests();
  expect(registerArtifact(f.db, f.storage, f.input, f.access).name).toBe("Weekly report");
});

it("refuses when the free space cannot be read", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => { throw Object.assign(new Error("statfs failed"), { code: "EIO" }); });
  const answer = artifactsRequest(f.db, f.storage, { method: "POST", path: "/api/artifacts/register", body: f.input }, f.access);
  expect(answer).toEqual({ status: 507, body: { error: DISK_UNKNOWN_MESSAGE, code: "disk-unknown" } });
});

it("answers a copy that runs out of disk (ENOSPC) with the disk-full refusal and leaves no candidate", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => PLENTY);
  vi.mocked(writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); });
  let refusal: unknown;
  try { registerArtifact(f.db, f.storage, f.input, f.access); } catch (error) { refusal = error; }
  expect(refusal).toMatchObject({ status: 507, reason: "disk-full", message: DISK_FULL_MESSAGE });
  expect(candidates(f.storage)).toEqual([]);
});

it("start-up sweep removes crash-left candidates and keeps saved copies", () => {
  const f = fixture();
  __setFreeDiskProbeForTests(() => PLENTY);
  const saved = registerArtifact(f.db, f.storage, f.input, f.access);
  const leftover = join(f.storage, ".candidate-0f2a1c3e-1111-4222-8333-944455566677");
  realWriteFileSync(leftover, "half a copy");
  const notOurs = join(f.storage, ".candidate-notes");
  realWriteFileSync(notOurs, "not a candidate name");
  expect(sweepArtifactCandidates(f.storage)).toBe(1);
  expect(existsSync(leftover)).toBe(false);
  expect(existsSync(notOurs)).toBe(true);
  expect(readdirSync(f.storage).some((name) => name.startsWith(saved.sha256))).toBe(true);
  expect(sweepArtifactCandidates(join(f.root, "missing"))).toBe(0);
});
