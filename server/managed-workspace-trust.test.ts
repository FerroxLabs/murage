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
import { deskComponents, managedThreadDesk, managedWorkspaceAutoTrust } from "./managed-workspace-trust.ts";
import { partitionRoots, type Partition } from "./execution-audience.ts";
import type { BotRecord } from "./store.ts";
import { createProcedurePin, preparePinnedProcedures } from "./procedure-bundles.ts";
import { installSkill, migrateSkillDiscoveryToTasks, setSkillEnabled } from "./skills.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { ensureTaskWorkspace } from "./workspace.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// Murage links skills with directory symlinks, and with junctions on Windows
// (skills.ts), because a Windows directory symlink needs a privilege a
// standard user lacks. A junction is the same kind of link to every check this
// module makes (lstat reports a symbolic link, realpath follows it), so the
// suite makes the link the platform makes and runs on every OS.
const LINK = process.platform === "win32" ? "junction" : "dir";
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
    symlinkSync(join(bundleRoot, "skills", name), join(at, dir, name), LINK);
  }
}

const input = (bundleIds: string[] = [BUNDLE]) => ({ dataDir, botId: BOT, threadId: THREAD, bundleIds });
const decide = (folder: string, bundleIds?: string[]) => managedWorkspaceAutoTrust(folder, scanFolderTrustSources(folder), input(bundleIds));

describe("managed thread desk auto-trust", () => {
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
    symlinkSync(outside, linkedDesk, LINK);
    const scan = scanFolderTrustSources(linkedDesk);
    expect(managedWorkspaceAutoTrust(linkedDesk, scan, { ...input(), botId: "bot_2" })).toBe(false);
    // a symlinked `threads` dir fails the same way
    const threadsTarget = join(root, "threads-elsewhere");
    mkdirSync(join(threadsTarget, THREAD), { recursive: true });
    pinSkill(join(threadsTarget, THREAD), "review");
    mkdirSync(join(dataDir, "workspaces", "bot_3"), { recursive: true });
    symlinkSync(threadsTarget, join(dataDir, "workspaces", "bot_3", "threads"), LINK);
    const viaThreads = join(dataDir, "workspaces", "bot_3", "threads", THREAD);
    expect(managedWorkspaceAutoTrust(viaThreads, scanFolderTrustSources(viaThreads), { ...input(), botId: "bot_3" })).toBe(false);
  });

  it("a skill link that escapes the desk's pinned bundle is refused", () => {
    pinSkill(desk, "review");
    // a link to a skill outside the desk
    const foreign = join(root, "foreign-skill");
    mkdirSync(foreign);
    symlinkSync(foreign, join(desk, ".claude", "skills", "evil"), LINK);
    expect(decide(desk)).toBe(false);
  });

  it("a skill link into a bundle this turn did not pin, or an unpublished bundle, is refused", () => {
    pinSkill(desk, "review", "bundle_old");
    expect(decide(desk, [BUNDLE])).toBe(false);
    expect(decide(desk, ["bundle_old"])).toBe(true);
    // a link whose name differs from the skill it points at
    symlinkSync(join(desk, ".murage-procedures", "bundle_old", "skills", "review"), join(desk, ".agents", "skills", "renamed"), LINK);
    expect(decide(desk, ["bundle_old"])).toBe(false);
  });

  it("an unpublished bundle (no .complete) is refused", () => {
    pinSkill(desk, "review");
    rmSync(join(desk, ".murage-procedures", BUNDLE, ".complete"));
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
    symlinkSync(join(desk, ".murage-procedures", BUNDLE, "skills", "review"), join(elsewhere, "skills", "review"), LINK);
    symlinkSync(elsewhere, join(desk, ".claude"), LINK);
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

describe("managed thread desk auto-trust on a real pinned bundle", () => {
  it("preparePinnedProcedures(native) leaves a desk that is trusted only for its own pin", () => {
    const id = `managed-trust-${randomUUID()}`;
    try {
      const md = "---\nname: checked-method\ndescription: Check a result\n---\nCheck it.\n";
      expect(installSkill(id, "fixture", [{ path: "SKILL.md", content: md }])).not.toHaveProperty("error");
      setSkillEnabled(id, "checked-method", true);
      const thread = "task-one";
      const pin = createProcedurePin(id, thread, [], [],undefined,undefined,{ownerTurn:true,shipped:()=>true});
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
      removeTempDirSync(join(DATA_DIR, "workspaces", id));
      removeTempDirSync(join(DATA_DIR, "skill-state", id));
    }
  });
});

// 1.0.8 THREAD-TRUST-108: a hand-off to a team member or a project desk runs
// in the desk Murage made under the bot's partition root, not under
// `workspaces/<botId>/threads`. Such a desk holding only Murage's links is
// trusted the same as the home desk; anything the owner pointed Murage at,
// another bot's desk, or a path that escapes through a symlink is not.
describe("partitioned thread desks (1.0.8 thread trust)", () => {
  const partitions: Array<[string, Partition]> = [
    ["team", { kind: "team", teamId: "team_a" }],
    ["project", { kind: "project", groupId: "group_a", homeMember: false }],
    ["room", { kind: "room", groupId: "room_a" }],
    ["isolated", { kind: "isolated", threadId: "thread-x" }],
    ["general", { kind: "general" }],
  ];
  /** The desk `taskWorkspacePath` names for a partitioned thread: the real
   * partition root, then `threads/<threadId>`. */
  const partitionDesk = (partition: Partition, botId = BOT) => join(partitionRoots({ id: botId } as BotRecord, partition, dataDir)[0]!, "threads", THREAD);
  const decideAt = (folder: string, deskPath: string, bundleIds = [BUNDLE]) => managedWorkspaceAutoTrust(folder, scanFolderTrustSources(folder), { ...input(bundleIds), desk: deskPath });

  for (const [label, partition] of partitions) {
    it(`a ${label} desk holding only Murage skill links is trusted, like the home desk`, () => {
      const at = partitionDesk(partition);
      mkdirSync(at, { recursive: true });
      pinSkill(at, "review");
      expect(scanFolderTrustSources(at).sources).toEqual([".agents/skills", ".claude/skills"]);
      expect(decideAt(at, at)).toBe(true);
      // the home desk keeps its answer, with or without the desk named
      pinSkill(desk, "review");
      expect(decide(desk)).toBe(true);
      expect(decideAt(desk, desk)).toBe(true);
      // and the partition desk still needs Murage's own name for it
      expect(decide(at)).toBe(false);
    });
  }

  it("a partition desk with a foreign source next to the links keeps the card", () => {
    const at = partitionDesk({ kind: "team", teamId: "team_a" });
    mkdirSync(at, { recursive: true });
    pinSkill(at, "review");
    writeFileSync(join(at, "AGENTS.md"), "x");
    expect(decideAt(at, at)).toBe(false);
  });

  it("an owner-chosen folder is never the desk, even when Murage's desk is named alongside it", () => {
    const at = partitionDesk({ kind: "project", groupId: "group_a", homeMember: false });
    mkdirSync(at, { recursive: true });
    pinSkill(at, "review");
    const project = join(root, "owner-project");
    mkdirSync(project);
    pinSkill(project, "review");
    expect(decideAt(project, at)).toBe(false);
    // an owner folder that merely looks like a desk (`.../threads/<id>`) outside the data dir
    const lookalike = join(root, "owner", "workspaces", BOT, "threads", THREAD);
    mkdirSync(lookalike, { recursive: true });
    pinSkill(lookalike, "review");
    expect(decideAt(lookalike, lookalike)).toBe(false);
    expect(deskComponents(dataDir, lookalike, BOT, THREAD)).toBeNull();
  });

  it("only this bot's desk shapes qualify", () => {
    const other = partitionDesk({ kind: "team", teamId: "team_a" }, "bot_2");
    mkdirSync(other, { recursive: true });
    pinSkill(other, "review");
    expect(decideAt(other, other)).toBe(false);
    expect(deskComponents(dataDir, other, BOT, THREAD)).toBeNull();
    // a prefix of the bot id is not the bot, and an unknown suffix is not a partition
    expect(deskComponents(dataDir, join(dataDir, "workspaces", "bot_1x.teams", "team_a", "threads", THREAD), BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, join(dataDir, "workspaces", "bot_1.notes", "k", "threads", THREAD), BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, join(dataDir, "workspaces", "bot_1.general", "k", "threads", THREAD), BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, join(dataDir, "workspaces", BOT, "threads", "thread-2"), BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, join(dataDir, "workspaces", BOT, "threads", THREAD, "sub"), BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, `${join(dataDir, "workspaces", "bot_1.teams", "team_a")}/../team_b/threads/${THREAD}`, BOT, THREAD)).toBeNull();
    expect(deskComponents(dataDir, join(dataDir, "workspaces", "bot_1.teams", "team_a", "threads", THREAD), BOT, THREAD)).toEqual(["workspaces", "bot_1.teams", "team_a", "threads", THREAD]);
  });

  it("a partition root or key folder that is a symlink out of the data dir is refused", () => {
    // `<botId>.teams/<teamId>` linked to a folder outside
    const outside = join(root, "outside-team");
    mkdirSync(join(outside, "threads", THREAD), { recursive: true });
    pinSkill(join(outside, "threads", THREAD), "review");
    mkdirSync(join(dataDir, "workspaces", "bot_1.teams"), { recursive: true });
    symlinkSync(outside, join(dataDir, "workspaces", "bot_1.teams", "team_a"), LINK);
    const viaKey = join(dataDir, "workspaces", "bot_1.teams", "team_a", "threads", THREAD);
    expect(decideAt(viaKey, viaKey)).toBe(false);
    // `<botId>.projects` itself linked out
    const outsideRoot = join(root, "outside-projects");
    mkdirSync(join(outsideRoot, "group_a", "threads", THREAD), { recursive: true });
    pinSkill(join(outsideRoot, "group_a", "threads", THREAD), "review");
    symlinkSync(outsideRoot, join(dataDir, "workspaces", "bot_1.projects"), LINK);
    const viaRoot = join(dataDir, "workspaces", "bot_1.projects", "group_a", "threads", THREAD);
    expect(decideAt(viaRoot, viaRoot)).toBe(false);
    // a desk that is a symlink to the real home desk is not the desk either
    pinSkill(desk, "review");
    const roomThreads = join(dataDir, "workspaces", "bot_1.rooms", "room_a", "threads");
    mkdirSync(roomThreads, { recursive: true });
    symlinkSync(desk, join(roomThreads, THREAD), LINK);
    const viaDesk = join(roomThreads, THREAD);
    expect(decideAt(viaDesk, viaDesk)).toBe(false);
  });

  it("an empty or relative desk name matches nothing", () => {
    pinSkill(desk, "review");
    expect(decideAt(desk, "")).toBe(false);
    expect(decideAt(desk, join("workspaces", BOT, "threads", THREAD))).toBe(false);
  });
});
