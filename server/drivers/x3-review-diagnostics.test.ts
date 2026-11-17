import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.resetModules(); });
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync), readSync: vi.fn(actual.readSync), opendirSync: vi.fn(actual.opendirSync) };
});
import { execDiagCount, execDiagPath, newestShellSnapshot } from "./murage-exec.ts";
const dirs: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(join(tmpdir(), "x3-diagnostics-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
it("X3 dispatch diagnostics bound log reads independently of history size", () => {
  const env = join(fixture(), "env");
  fs.writeFileSync(execDiagPath(env), "keep-mismatch\n".repeat(100_000));
  vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  expect(execDiagCount(env)).toBeGreaterThan(0);
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.readSync).toHaveBeenCalled();
  expect(vi.mocked(fs.readSync).mock.calls.reduce((sum, call) => sum + call[1].byteLength, 0)).toBeLessThanOrEqual(65_536);
});
it("X3 dispatch diagnostics bound snapshot enumeration and stats", () => {
  const root = fixture(), dir = join(root, "shell-snapshots"); fs.mkdirSync(dir);
  for (let i = 0; i < 300; i++) fs.writeFileSync(join(dir, `snapshot-${i}.sh`), "export PATH='/bin'\n");
  vi.mocked(fs.readdirSync).mockClear(); vi.mocked(fs.statSync).mockClear();
  const native = vi.mocked(fs.opendirSync).getMockImplementation()!;
  let entries = 0;
  vi.mocked(fs.opendirSync).mockImplementation(((...args: Parameters<typeof fs.opendirSync>) => {
    const dir = native(...args);
    const read = dir.readSync.bind(dir); dir.readSync = () => { entries++; return read(); }; return dir;
  }) as typeof fs.opendirSync);
  try {
    expect(newestShellSnapshot(root)).toBeNull();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(vi.mocked(fs.statSync).mock.calls.length).toBeLessThanOrEqual(64);
    expect(entries).toBeLessThanOrEqual(65);
  } finally { vi.mocked(fs.opendirSync).mockImplementation(native); }
});
it("X3 dispatch diagnostics bound the selected snapshot's bytes", () => {
  const root = fixture(), dir = join(root, "shell-snapshots"); fs.mkdirSync(dir);
  fs.writeFileSync(join(dir, "snapshot-large.sh"), "#".repeat(1_000_000));
  vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  expect(newestShellSnapshot(root)).toBeNull();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(vi.mocked(fs.readSync).mock.calls.reduce((sum, call) => sum + call[1].byteLength, 0)).toBeLessThanOrEqual(65_536);
});
it("X3 dispatch diagnostics retain small-file counts and newest snapshot selection", () => {
  const root = fixture(), env = join(root, "env"), dir = join(root, "shell-snapshots"); fs.mkdirSync(dir);
  fs.writeFileSync(execDiagPath(env), "keep-mismatch\nother\nkeep-mismatch\n");
  expect(execDiagCount(env)).toBe(2);
  fs.writeFileSync(join(dir, "snapshot-old.sh"), "old"); fs.utimesSync(join(dir, "snapshot-old.sh"), 1, 1);
  fs.writeFileSync(join(dir, "snapshot-new.sh"), "new");
  expect(newestShellSnapshot(root)).toBe("new");
});
