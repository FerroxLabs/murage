// Windows only: the link a Windows desk really holds. Murage links pinned skills
// with junctions there (skills.ts: a directory symlink needs a privilege a
// standard user lacks), and a managed thread desk may auto-trust only while every
// skill entry is such a link into its own pinned bundle. The shared suite
// (managed-workspace-trust.test.ts) makes this same link on Windows; this file
// pins the junction facts the decision rests on, and runs on the Windows CI job
// alone (ci/gate-tests.txt: "windows").
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanFolderTrustSources } from "./folder-trust.ts";
import { managedThreadDesk, managedWorkspaceAutoTrust } from "./managed-workspace-trust.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const windowsOnly = describe.skipIf(process.platform !== "win32");
const BOT = "bot_1";
const THREAD = "thread-1";
const BUNDLE = "bundle_a";

let root: string;
let dataDir: string;
let desk: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-managed-junction-")));
  dataDir = join(root, "data");
  desk = join(dataDir, "workspaces", BOT, "threads", THREAD);
  mkdirSync(desk, { recursive: true });
});
afterEach(() => removeTempDir(root));

const input = () => ({ dataDir, botId: BOT, threadId: THREAD, bundleIds: [BUNDLE] });
function pinWithJunction(name: string): string {
  const bundleRoot = join(desk, ".murage-procedures", BUNDLE);
  mkdirSync(join(bundleRoot, "skills", name), { recursive: true });
  writeFileSync(join(bundleRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  writeFileSync(join(bundleRoot, ".complete"), BUNDLE);
  mkdirSync(join(desk, ".claude", "skills"), { recursive: true });
  const link = join(desk, ".claude", "skills", name);
  symlinkSync(join(bundleRoot, "skills", name), link, "junction");
  return link;
}

windowsOnly("managed thread desk auto-trust with Windows junctions", () => {
  it("a junction reads as a link to lstat and resolves into the pinned bundle, and the desk is trusted", () => {
    const link = pinWithJunction("review");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(link)).toBe(join(realpathSync.native(desk), ".murage-procedures", BUNDLE, "skills", "review"));
    expect(managedWorkspaceAutoTrust(desk, scanFolderTrustSources(desk), input())).toBe(true);
  });

  it("a junction to a folder outside the pinned bundle keeps the card", () => {
    pinWithJunction("review");
    const foreign = join(root, "foreign-skill");
    mkdirSync(foreign);
    symlinkSync(foreign, join(desk, ".claude", "skills", "evil"), "junction");
    expect(managedWorkspaceAutoTrust(desk, scanFolderTrustSources(desk), input())).toBe(false);
  });

  it("a thread desk that is itself a junction out of the workspace is refused", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const threads = join(dataDir, "workspaces", "bot_2", "threads");
    mkdirSync(threads, { recursive: true });
    const linkedDesk = join(threads, THREAD);
    symlinkSync(outside, linkedDesk, "junction");
    expect(managedThreadDesk(linkedDesk, { dataDir, botId: "bot_2", threadId: THREAD })).toBeNull();
  });
});
