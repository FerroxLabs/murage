// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a witness (designs/1021-m2-w0 r3 D1.6 "write then fsync"; Opus r2 Medium): a custody record is durable only once
// the directory entry of the file that holds it is, both when the file is first created and after the reap's atomic
// rewrite. Owner: O1 m2 S1a builder lane (fix/1022-o1m2). The fs wrapper records calls and runs the real ones.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const fdPath = new Map<number, string>();
  const openSync = ((path: string, ...rest: unknown[]) => { const fd = (fs.openSync as (...a: unknown[]) => number)(path, ...rest); fdPath.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  const fsyncSync = ((fd: number) => { calls.push(`fsync ${fdPath.get(fd)}`); fs.fsyncSync(fd); }) as typeof fs.fsyncSync;
  const renameSync = ((from: string, to: string) => { calls.push(`rename ${to}`); fs.renameSync(from, to); }) as typeof fs.renameSync;
  const wrapped = { ...fs, openSync, fsyncSync, renameSync };
  return { ...wrapped, default: wrapped };
});
const { appendCustodyRecord, hostedCustodyPath, reapCustody, reapDeps } = await import("./custody.ts");
const { removeTempDir } = await import("../testing/cleanup.ts");

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await removeTempDir(dir); });
beforeEach(() => { calls.length = 0; });
const record = { boot_id: "fixture-boot", kboot: "fixture-kboot", inc: 1, role: "engine" as const, pid: 424_242, start: "1", pgid: 424_242 };

describe.skipIf(process.platform === "win32")("custody durability (directory fsync)", () => {
  it("fsyncs the data dir after the record that created the custody file", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-s1a-durable-"));
    dirs.push(dir);
    appendCustodyRecord(dir, record);
    expect(calls).toEqual([`fsync ${hostedCustodyPath(dir)}`, `fsync ${dir}`]);
  });

  it("fsyncs the data dir after the atomic rewrite of unresolved records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-s1a-durable-"));
    dirs.push(dir);
    appendCustodyRecord(dir, record);
    calls.length = 0;
    const stuck = { ...reapDeps, kboot: () => "fixture-kboot", identity: (pid: number) => ({ pid, start: "1" }), kill: () => {} };
    expect(await reapCustody(dir, stuck, 60)).toEqual({ reaped: 0, unresolved: 1 });
    expect(calls.slice(calls.indexOf(`rename ${hostedCustodyPath(dir)}`))).toEqual([`rename ${hostedCustodyPath(dir)}`, `fsync ${dir}`]);
  });
});
