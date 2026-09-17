// 0.1.54 option C: a Murage-managed thread desk whose only trust-sensitive
// sources are Murage's links to the skills this turn pinned runs trusted with
// no card. Everything else keeps the card exactly as before: user folders,
// symlink or `..` escapes, foreign skill sources, and any desk whose Fuigo
// grant would reach past the desk itself.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { scanFolderTrustSources, upstreamTrustsFolder } from "./folder-trust.ts";
import { managedThreadDesk, managedWorkspaceAutoTrust } from "./managed-workspace-trust.ts";
import { createProcedurePin, preparePinnedProcedures } from "./procedure-bundles.ts";
import { installSkill, migrateSkillDiscoveryToTasks, setSkillEnabled } from "./skills.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const BOT = "bot_1";
const THREAD = "thread-1";
const BUNDLE = "bundle_a";

let root: string;
let dataDir: string;
let desk: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-managed-trust-")));
  dataDir = join(root, "data");
  desk = join(dataDir, "workspaces", BOT, "threads", THREAD);
  mkdirSync(desk, { recursive: true });
});
afterEach(() => removeTempDir(root));

/** The layout `preparePinnedProcedures(native=true)` leaves in a desk. */
function pinSkill(at: string, name: string, bundle = BUNDLE, dirs = [".claude/skills", ".agents/skills", ".grok/skills"]): void {
  const bundleRoot = join(at, ".murage-procedures", bundle);
  mkdirSync(join(bundleRoot, "skills", name), { recursive: true });
  writeFileSync(join(bundleRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  writeFileSync(join(bundleRoot, ".complete"), bundle);
  for (const dir of dirs) {
    mkdirSync(join(at, dir), { recursive: true });
    symlinkSync(join(bundleRoot, "skills", name), join(at, dir, name), "dir");
  }
}

const input = (bundleIds: string[] = [BUNDLE]) => ({ dataDir, botId: BOT, threadId: THREAD, bundleIds });
const decide = (folder: string, bundleIds?: string[]) => managedWorkspaceAutoTrust(folder, scanFolderTrustSources(folder), input(bundleIds));

posixOnly("managed thread desk auto-trust", () => {
  it("a managed thread desk holding only Murage skill links is trusted, and the card's sources are exactly those links", () => {
    pinSkill(desk, "review");
    pinSkill(desk, "deploy");
    expect(scanFolderTrustSources(desk).sources).toEqual([".agents/skills", ".claude/skills"]);
    expect(decide(desk)).toBe(true);
  });

  it("a desk with no linked skills needs no trust at all (no sources, so no auto-trust either)", () => {
    expect(scanFolderTrustSources(desk).sources).toEqual([]);
    expect(decide(desk)).toBe(false);
  });

  it("a user-chosen project folder with the very same links is not trusted", () => {
    const project = join(root, "project");
    mkdirSync(project);
    pinSkill(project, "review");
    expect(decide(project)).toBe(false);
    // not even when the ids happen to match the turn
    expect(managedThreadDesk(project, input())).toBeNull();
    // nor the bot's own (legacy room) workspace root
    const botRoot = join(dataDir, "workspaces", BOT);
    pinSkill(botRoot, "review");
    expect(decide(botRoot)).toBe(false);
  });

  it("another thread's desk is not this turn's desk", () => {
    const other = join(dataDir, "workspaces", BOT, "threads", "thread-2");
    mkdirSync(other, { recursive: true });
    pinSkill(other, "review");
    expect(decide(other)).toBe(false);
  });

  it("a `..` spelling of the desk is refused, even though it resolves to the desk", () => {
    pinSkill(desk, "review");
    const dotted = `${join(dataDir, "workspaces", BOT, "threads", "x")}/../${THREAD}`;
    mkdirSync(join(dataDir, "workspaces", BOT, "threads", "x"));
    expect(realpathSync.native(dotted)).toBe(desk);
    expect(managedWorkspaceAutoTrust(dotted, scanFolderTrustSources(desk), input())).toBe(false);
  });

  it("a thread desk that is itself a symlink out of the workspace is refused", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    pinSkill(outside, "review");
    const threads = join(dataDir, "workspaces", "bot_2", "threads");
    mkdirSync(threads, { recursive: true });
    const linkedDesk = join(threads, THREAD);
    symlinkSync(outside, linkedDesk, "dir");
    const scan = scanFolderTrustSources(linkedDesk);
    expect(managedWorkspaceAutoTrust(linkedDesk, scan, { ...input(), botId: "bot_2" })).toBe(false);
    // a symlinked `threads` dir fails the same way
    const threadsTarget = join(root, "threads-elsewhere");
    mkdirSync(join(threadsTarget, THREAD), { recursive: true });
    pinSkill(join(threadsTarget, THREAD), "review");
    mkdirSync(join(dataDir, "workspaces", "bot_3"), { recursive: true });
    symlinkSync(threadsTarget, join(dataDir, "workspaces", "bot_3", "threads"), "dir");
    const viaThreads = join(dataDir, "workspaces", "bot_3", "threads", THREAD);
    expect(managedWorkspaceAutoTrust(viaThreads, scanFolderTrustSources(viaThreads), { ...input(), botId: "bot_3" })).toBe(false);
  });

  it("a skill link that escapes the desk's pinned bundle is refused", () => {
    pinSkill(desk, "review");
    // a link to a skill outside the desk
    const foreign = join(root, "foreign-skill");
    mkdirSync(foreign);
    symlinkSync(foreign, join(desk, ".claude", "skills", "evil"), "dir");
    expect(decide(desk)).toBe(false);
  });

  it("a skill link into a bundle this turn did not pin, or an unpublished bundle, is refused", () => {
    pinSkill(desk, "review", "bundle_old");
    expect(decide(desk, [BUNDLE])).toBe(false);
    expect(decide(desk, ["bundle_old"])).toBe(true);
    // a link whose name differs from the skill it points at
    symlinkSync(join(desk, ".murage-procedures", "bundle_old", "skills", "review"), join(desk, ".agents", "skills", "renamed"), "dir");
    expect(decide(desk, ["bundle_old"])).toBe(false);
  });

  it("an unpublished bundle (no .complete) is refused", () => {
    pinSkill(desk, "review");
    execFileSync("rm", [join(desk, ".murage-procedures", BUNDLE, ".complete")]);
    expect(decide(desk)).toBe(false);
  });

  it("a workspace with any non-Murage skill source keeps the card", () => {
    pinSkill(desk, "review");
    expect(decide(desk)).toBe(true);
    // a real directory next to Murage's links
    mkdirSync(join(desk, ".claude", "skills", "handmade"));
    expect(decide(desk)).toBe(false);
  });

  for (const [label, make] of [
    ["AGENTS.md", (d: string) => writeFileSync(join(d, "AGENTS.md"), "x")],
    [".mcp.json", (d: string) => writeFileSync(join(d, ".mcp.json"), "{}")],
    [".fuigo/skills", (d: string) => mkdirSync(join(d, ".fuigo", "skills"), { recursive: true })],
    [".claude/commands", (d: string) => mkdirSync(join(d, ".claude", "commands"), { recursive: true })],
    [".fuigo/hooks", (d: string) => mkdirSync(join(d, ".fuigo", "hooks"), { recursive: true })],
    [".claude/settings.json", (d: string) => writeFileSync(join(d, ".claude", "settings.json"), "{}")],
    ["a foreign entry in .grok/skills", (d: string) => mkdirSync(join(d, ".grok", "skills", "other"))],
  ] as const) {
    it(`a desk that also holds ${label} keeps the card`, () => {
      pinSkill(desk, "review");
      make(desk);
      expect(decide(desk)).toBe(false);
    });
  }

  it("a symlinked .claude directory is refused even when its links look right", () => {
    const elsewhere = join(root, "claude-elsewhere");
    mkdirSync(join(elsewhere, "skills"), { recursive: true });
    pinSkill(desk, "review", BUNDLE, [".agents/skills"]);
    symlinkSync(join(desk, ".murage-procedures", BUNDLE, "skills", "review"), join(elsewhere, "skills", "review"), "dir");
    symlinkSync(elsewhere, join(desk, ".claude"), "dir");
    expect(decide(desk)).toBe(false);
  });

  it("grant scope is the exact desk: a git repository above it (the grant would cover a parent) is refused", () => {
    pinSkill(desk, "review");
    execFileSync("git", ["init", "-q", join(dataDir, "workspaces", BOT)]);
    const scan = scanFolderTrustSources(desk);
    expect(scan.key).toBe(join(dataDir, "workspaces", BOT));
    expect(managedWorkspaceAutoTrust(desk, scan, input())).toBe(false);
  });

  it("grant scope is the exact desk: the key is the desk, and a Fuigo record for it covers neither its parent, a sibling desk nor a subfolder", () => {
    pinSkill(desk, "review");
    const scan = scanFolderTrustSources(desk);
    expect(scan.key).toBe(desk);
    expect(decide(desk)).toBe(true);
    // what `fuigo --trust` records for this cwd (workspace_key = the desk)
    const records = new Map([[scan.key, true]]);
    const threads = join(dataDir, "workspaces", BOT, "threads");
    const sibling = join(threads, "thread-2");
    const sub = join(desk, "sub");
    mkdirSync(sibling);
    mkdirSync(sub);
    expect(upstreamTrustsFolder(records, desk)).toBe(true);
    expect(upstreamTrustsFolder(records, threads)).toBe(false);
    expect(upstreamTrustsFolder(records, join(dataDir, "workspaces", BOT))).toBe(false);
    expect(upstreamTrustsFolder(records, sibling)).toBe(false);
    expect(upstreamTrustsFolder(records, sub)).toBe(false);
  });

  it("a desk that is its own git root still keys on itself and may be trusted", () => {
    pinSkill(desk, "review");
    execFileSync("git", ["init", "-q", desk]);
    expect(scanFolderTrustSources(desk).key).toBe(desk);
    expect(decide(desk)).toBe(true);
  });

  it("unsafe ids never match", () => {
    pinSkill(desk, "review");
    expect(managedWorkspaceAutoTrust(desk, scanFolderTrustSources(desk), { ...input(), botId: "../x" })).toBe(false);
    expect(managedWorkspaceAutoTrust(desk, scanFolderTrustSources(desk), { ...input(), bundleIds: ["../bundle_a"] })).toBe(false);
  });
});

// The layout the real procedure publisher writes, not a hand-made copy of it.

posixOnly("managed thread desk auto-trust on a real pinned bundle", () => {
  it("preparePinnedProcedures(native) leaves a desk that is trusted only for its own pin", () => {
    const id = `managed-trust-${randomUUID()}`;
    try {
      const md = "---\nname: checked-method\ndescription: Check a result\n---\nCheck it.\n";
      expect(installSkill(id, "fixture", [{ path: "SKILL.md", content: md }])).not.toHaveProperty("error");
      setSkillEnabled(id, "checked-method", true);
      const thread = "task-one";
      const pin = createProcedurePin(id, thread, [], []);
      const deskPath = ensureTaskWorkspace(id, thread);
      migrateSkillDiscoveryToTasks(id);
      preparePinnedProcedures(id, thread, pin, true);
      const scan = scanFolderTrustSources(deskPath);
      expect(scan.sources).toEqual([".agents/skills", ".claude/skills"]);
      const real = { dataDir: DATA_DIR, botId: id, threadId: thread };
      expect(managedWorkspaceAutoTrust(deskPath, scan, { ...real, bundleIds: [pin.bundleId] })).toBe(true);
      expect(managedWorkspaceAutoTrust(deskPath, scan, { ...real, bundleIds: ["some-other-bundle"] })).toBe(false);
      expect(managedWorkspaceAutoTrust(deskPath, scan, { ...real, threadId: "task-two", bundleIds: [pin.bundleId] })).toBe(false);
    } finally {
      rmSync(join(DATA_DIR, "workspaces", id), { recursive: true, force: true });
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    }
  });
});
