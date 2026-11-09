import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { FolderTrustStore } from "./folder-trust.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";
import { cwdConstructors } from "./turn-paths.ts";

const old = join(DATA_DIR, "previous");
const file = join(DATA_DIR, "folder-trust.json");
const bot = { id: "bot", threadId: "main", partitionedAt: 1, tasks: [
  { threadId: "task" }, { threadId: "shared", sharedWork: { teamId: "team", createdAt: 1 } },
  { threadId: "project", channelProjectDesk: { groupId: "project" } },
] } as BotRecord;
const group = { id: "room", threadId: "room-main", memberIds: [bot.id], tasks: [{ threadId: "room-task" }] } as GroupRecord;
const store = { bots: [bot], groups: [group] } as Pick<Store, "bots" | "groups">;
const pair = (thread: string) => [cwdConstructors(bot, thread)(old)[0]!, cwdConstructors(bot, thread)(DATA_DIR)[0]!] as const;
const record = (folder: string, decision: "trust" | "reject" = "trust") => ({ folder, decision, source: "card", decidedAt: 42, consent: 2 });
function setup(folders: Record<string, unknown>, previous = true) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: previous ? old : DATA_DIR, previous: [] }));
  bootDataRoots();
  writeFileSync(file, JSON.stringify({ version: 1, seededFrom: "0.1.52", folders }, null, 2));
  return new FolderTrustStore(file);
}
const disk = () => JSON.parse(readFileSync(file, "utf8"));

it("S5 site 12 migrates a key and folder together and preserves a stored reject (a,c)", async () => {
  const [key, next] = pair("task");
  const trust = setup({ [key]: record(key, "reject") });
  await trust.rebaseFromStore(store);
  expect(disk().folders).toEqual({ [next]: record(next, "reject") });
  expect(trust.list()).toEqual([{ key: next, ...record(next, "reject") }]);
});

it("S5 site 12 preserves mismatched folders, unmatched Git roots and unrecorded roots byte-identically (b,e)", async () => {
  const [key] = pair("task");
  for (const [folders, previous] of [
    [{ [key]: record(join(key, "child")), [join(old, "git-root")]: record(join(old, "git-root")) }, true],
    [{ [key]: record(key) }, false],
  ] as const) {
    const trust = setup(folders, previous);
    const before = readFileSync(file);
    await trust.rebaseFromStore(store);
    expect(readFileSync(file)).toEqual(before);
  }
});

it.each([false, true])("S5 site 12 handles matched, unmatched and collision keys together in either order (%s) (d)", async reverse => {
  const [matched, moved] = pair("main");
  const [collision, current] = pair("task");
  const unmatched = join(old, "git-root");
  const entries = [[matched, record(matched)], [unmatched, record(unmatched)], [collision, record(collision)], [current, record(current, "reject")]] as const;
  const trust = setup(Object.fromEntries(reverse ? [...entries].reverse() : entries));
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await trust.rebaseFromStore(store);
    expect(disk()).toEqual({ version: 1, seededFrom: "0.1.52", folders: { [moved]: record(moved), [unmatched]: record(unmatched), [current]: record(current, "reject") } });
    expect(log.mock.calls).toEqual([["data-dir-rebase kind=folder-trust count=1 collisions=1"]]);
    const before = readFileSync(file);
    await trust.rebaseFromStore(store);
    expect(readFileSync(file)).toEqual(before);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});

it("S5 site 12 derives bot, task, partition, shared-work and room constructors from the live inventory", async () => {
  const constructors = [cwdConstructors(bot, "main"), cwdConstructors(bot, "task"),
    cwdConstructors(bot, "shared", { partition: { kind: "team", teamId: "team" }, sharedTeamId: "team" }),
    cwdConstructors(bot, "project", { partition: { kind: "project", groupId: "project", homeMember: false } }),
    cwdConstructors(bot, "room-main", { groupId: group.id }), cwdConstructors(bot, "room-task", { groupId: group.id })];
  const paths = constructors.flatMap(make => make(old).flatMap((key, i) => key ? [[key, make(DATA_DIR)[i]!] as const] : []));
  const trust = setup(Object.fromEntries(paths.map(([key]) => [key, record(key)])));
  await trust.rebaseFromStore(store);
  expect(disk().folders).toEqual(Object.fromEntries(paths.map(([, next]) => [next, record(next)])));
});
