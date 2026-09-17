import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TurnResources, workspaceResource } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" }, b = { threadId: "b", generation: "2" };
it("holds shared resources for one generation and admits independent resources", () => {
  const leases = new TurnResources();
  expect(leases.claim("computer:host", a)).toBe(true);
  expect(leases.claim("computer:host", a)).toBe(true);
  expect(leases.claim("computer:host", b)).toBe(false);
  expect(leases.claim("browser:other", b)).toBe(true);
  leases.release(a);
  expect(leases.claim("computer:host", b)).toBe(true);
  leases.release(a);
  expect(leases.owns("computer:host", b)).toBe(true);
});
it("does not retain partial claims or let a stale generation release the replacement", () => {
  const leases = new TurnResources();
  leases.claim("computer:host", a);
  expect(leases.claimAll(["browser:one", "computer:host"], b)).toBe(false);
  expect(leases.owns("browser:one", b)).toBe(false);
  const next = { ...a, generation: "next" };
  expect(leases.claim("computer:host", next)).toBe(false);
  leases.release(a);expect(leases.claim("computer:host", next)).toBe(true);
  leases.release(a);expect(leases.owns("computer:host", next)).toBe(true);
});
it("serializes ancestor and symlink workspaces while allowing siblings", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-thread-resources-"));
  try {
    mkdirSync(join(root, "Project", "nested"), { recursive: true });mkdirSync(join(root, "sibling"));
    symlinkSync(join(root, "Project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const leases = new TurnResources();
    expect(leases.claim(workspaceResource(join(root, "Project")), a)).toBe(true);
    expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
    expect(leases.claim(workspaceResource(join(root, "Project", "nested")), b)).toBe(false);
    expect(leases.claim(workspaceResource(root), b)).toBe(false);
    expect(leases.claim(workspaceResource(join(root, "sibling")), b)).toBe(true);
    if (existsSync(join(root, "project"))) expect(workspaceResource(join(root, "project"))).toBe(workspaceResource(join(root, "Project")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("reports what a generation holds and who blocks a request, for release-then-wait", () => {
  const leases = new TurnResources();
  leases.claimAll(["workspace:/a/project", "screen:bot:x"], a);
  expect(leases.heldBy(a).sort()).toEqual(["screen:bot:x", "workspace:/a/project"]);
  expect(leases.heldBy(b)).toEqual([]);
  expect(leases.conflicts(["workspace:/a/project/nested", "browser:free", "screen:bot:x"], b))
    .toEqual([{ resource: "workspace:/a/project/nested", owner: a }, { resource: "screen:bot:x", owner: a }]);
  expect(leases.conflicts(["screen:bot:x"], a)).toEqual([]);
  leases.release(a);
  expect(leases.heldBy(a)).toEqual([]);
});
