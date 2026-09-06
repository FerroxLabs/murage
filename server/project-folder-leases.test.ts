import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFolderLeases } from "./project-folder-leases.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-folder-leases-"))); roots.push(root);
  const project = join(root, "Project"), nested = join(project, "nested"), sibling = join(root, "Project-other");
  mkdirSync(nested, { recursive: true }); mkdirSync(sibling);
  const alias = join(root, "alias"); symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  return { root, project, nested, sibling, alias, leases: new ProjectFolderLeases() };
}
describe("canonical project folder lease registry", () => {
  it("allows overlapping writers and refuses restores on same, alias, parent and child paths", () => {
    const f = fixture();
    const first = f.leases.acquireWriter("one", f.project);
    f.leases.acquireWriter("two", f.nested);
    expect(f.leases.acquireWriter("one", f.alias)).toEqual(first);
    for (const path of [f.project, f.alias, f.root, f.nested]) {
      expect(() => f.leases.acquireRestore("restore", path)).toThrow("conflict");
      expect(f.leases.conflicts(path, "restore")).toHaveLength(2);
    }
    expect(f.leases.conflicts(f.project, "writer")).toEqual([]);
    expect(f.leases.acquireRestore("sibling", f.sibling).canonicalPath).toBe(f.sibling);
    const caseAlias = join(f.root, "project");
    if (existsSync(caseAlias)) expect(() => f.leases.acquireRestore("case", caseAlias)).toThrow("conflict");
  });
  it("pins restores to physical paths and releases only the named owner", () => {
    const f = fixture(); const restore = f.leases.acquireRestore("restore", f.alias);
    expect(restore.canonicalPath).toBe(f.project);
    expect(() => f.leases.acquireWriter("writer", f.nested)).toThrow("conflict");
    expect(() => f.leases.acquireRestore("restore", f.sibling)).toThrow("owner-in-use");
    expect(() => f.leases.acquireWriter("restore", f.project)).toThrow("owner-in-use");
    expect(f.leases.release("other")).toBe(false);
    expect(f.leases.conflicts(f.project, "writer")).toHaveLength(1);
    expect(f.leases.release("restore")).toBe(true);
    expect(f.leases.acquireWriter("writer", f.project).mode).toBe("writer");
  });
  it("refuses missing/files and detects replacement of the pinned namespace", () => {
    const f = fixture(); const file = join(f.root, "file.txt"); writeFileSync(file, "fixture");
    for (const path of [join(f.root, "absent"), file, ""]) expect(() => f.leases.acquireWriter("invalid", path)).toThrow("invalid-path");
    f.leases.acquireRestore("restore", f.project);
    renameSync(f.project, join(f.root, "moved")); mkdirSync(f.project);
    expect(() => f.leases.assertCurrent("restore")).toThrow("stale");
    expect(() => f.leases.acquireRestore("restore", f.project)).toThrow("stale");
  });
  it("detects symlink retargeting and keeps returned lease views isolated", () => {
    const f = fixture(); const lease = f.leases.acquireWriter("writer", f.alias);
    lease.canonicalPath = f.sibling;
    expect(f.leases.assertCurrent("writer").canonicalPath).toBe(f.project);
    rmSync(f.alias); symlinkSync(f.sibling, f.alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => f.leases.assertCurrent("writer")).toThrow("stale");
    expect(() => f.leases.assertCurrent("unknown")).toThrow("unknown-owner");
  });
});
