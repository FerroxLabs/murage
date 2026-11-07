// S5-DATADIR-PATHS r4.1 section 7 D2b, D8, D8b, D9: stored cwds through the real constructors (turn-paths.ts cwdConstructors).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BotRecord } from "./store.ts";
import type { Partition } from "./execution-audience.ts";
import { partitionRoots } from "./execution-audience.ts";
import { rebaseStoredPath } from "./stored-paths.ts";
import { cwdConstructors } from "./turn-paths.ts";

const OLD = "/gone/old/.murage", NEW = "/new/home/.murage";
const ctx = { dataDir: NEW, previous: [OLD], platform: "linux" as const };
const bot = { id: "bot-a", partitionedAt: 1 } as unknown as BotRecord;
const desk = (root: string, partition: Partition, threadId: string) => join(partitionRoots(bot, partition, root)[0]!, "threads", threadId);

describe("D8: partitioned team, project and rooms threads, and a shared-work task, each rebase to their own constructor", () => {
  const cases: Array<[string, Partition]> = [
    ["team", { kind: "team", teamId: "team-1" } as Partition],
    ["project", { kind: "project", groupId: "group-1", homeMember: false }],
    ["rooms", { kind: "isolated", threadId: "room-1" }],
  ];
  for (const [label, partition] of cases) {
    it(`a ${label} thread desk under the recorded previous root is rebased to the same partition under DATA_DIR`, () => {
      expect(rebaseStoredPath(desk(OLD, partition, "t1"), cwdConstructors(bot, "t1", { partition }), ctx)).toEqual({ path: desk(NEW, partition, "t1") });
    });
  }
  it("a shared-work task cwd (the team root itself) is rebased through the sharedTeamId constructor", () => {
    const team = { kind: "team", teamId: "team-1" } as Partition;
    const root = (base: string) => partitionRoots(bot, team, base)[0]!;
    expect(rebaseStoredPath(root(OLD), cwdConstructors(bot, "t1", { sharedTeamId: "team-1" }), ctx)).toEqual({ path: root(NEW) });
  });
});

describe("D8b: a team path whose team key differs from the task's -> data-dir-moved (refused, record untouched)", () => {
  it("refuses, never rebases to another team's folder", () => {
    const stored = desk(OLD, { kind: "team", teamId: "team-OTHER" } as Partition, "t1");
    expect(rebaseStoredPath(stored, cwdConstructors(bot, "t1", { partition: { kind: "team", teamId: "team-1" } as Partition }), ctx)).toEqual({ refused: true });
  });
});

describe("D9: a room pinnedCwd under the recorded previous root is rebased through the group constructors", () => {
  it("project and rooms roots of the group rebase; another group's root refuses", () => {
    const project = (base: string) => partitionRoots(bot, { kind: "project", groupId: "group-1", homeMember: false }, base)[0]!;
    const room = (base: string) => partitionRoots(bot, { kind: "isolated", threadId: "group-1" }, base)[0]!;
    const ctor = cwdConstructors(bot, "room-thread", { groupId: "group-1" });
    expect(rebaseStoredPath(project(OLD), ctor, ctx)).toEqual({ path: project(NEW) });
    expect(rebaseStoredPath(room(OLD), ctor, ctx)).toEqual({ path: room(NEW) });
    const other = partitionRoots(bot, { kind: "project", groupId: "group-2", homeMember: false }, OLD)[0]!;
    expect(rebaseStoredPath(other, ctor, ctx)).toEqual({ refused: true });
  });
});

describe("D2b control: a user-chosen cwd outside DATA_DIR that only looks like a desk", () => {
  it("with no recorded previous root it is kept untouched; with a record that is not its prefix it is kept too", () => {
    const lookalike = "/Users/me/work/workspaces/bot-a/threads/t1";
    expect(rebaseStoredPath(lookalike, cwdConstructors(bot, "t1"), { ...ctx, previous: [] })).toEqual({ keep: true });
    expect(rebaseStoredPath(lookalike, cwdConstructors(bot, "t1"), ctx)).toEqual({ keep: true });
  });
});
