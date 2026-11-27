// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-26T22:27:29Z D2: "owner turns read the durable deny rows directly ... no pending window").
// Owners: the recall read for the owner's own turn = q1023-denyfable (bundle.ts options.ownerTurn -> its readings and its search call,
// search.ts readOptions, readable.ts readRecord); the windows of every other read = deny-read.ts, unchanged; rulings = MAIN.
//
// Entry points: bundle.ts buildMemoryBundle (what index.ts builds for a direct turn, with ownerTurn = ownerMayKeepPending) and
// search.ts searchMemory (the bundle's own recall search), over a real captured record (messages appended through the store, the capture
// job leased and published) and pending windows written by the real commitRevoke with its walk left to the paced runner.
// RED on d2c1083fbc at each W-RC row's owner-turn assertion: the record was left out of the owner's own bundle and search ("checking").
import { beforeEach, describe, expect, it } from "vitest";
import { database } from "../database.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { ownerDirectChat } from "./disclosures.ts";
import { LineageAllowance } from "./replay-lineage.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { searchMemory } from "./search.ts";
import { access, append, bot, hits, person, QUERY, recordFrom, resetWorld, runJobs } from "./testing/xthread-world.ts";

const DETAIL = "GATE-5150";
const big = () => LineageAllowance.tool(1_000_000_000);
const unfinished = () => Number(database().prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone','folded')").get()!.n);
type Options = Record<string, unknown>;
const bundleHas = async (reader: ReturnType<typeof access>, record: { id: string; version: number }, options: Options = {}) =>
  (await buildMemoryBundle(QUERY, reader, hits([record]), { allowance: big(), ...options } as Parameters<typeof buildMemoryBundle>[3])).text.includes(DETAIL);
const searchHas = async (reader: ReturnType<typeof access>, record: { id: string; version: number }, options: Options = {}) =>
  (await searchMemory(QUERY, reader, hits([record]), { allowance: big(), ...options } as Parameters<typeof searchMemory>[3])).hits.map(hit => hit.id).includes(record.id);

beforeEach(() => resetWorld());

/** Three owner lines in Dax's chat, then the owner tells Finch a detail in Finch's own direct chat (captured: a record). `revoke`: each of
 * the three lines is then revoked by the real writer with its walk unfinished, which opens the windows the record sits in. */
function remembered(revoke: boolean): { id: string; version: number } {
  for (let i = 0; i < 3; i++) append("dax-direct", person(`line-${i}`, `an unrelated note ${i}`));
  append("finch-direct", person("x", `The side gate code is ${DETAIL}.`));
  append("finch-direct", bot("y", { text: "Noted.", from: { botId: "finch" } } as never));
  runJobs();
  const record = recordFrom("finch-direct", "x");
  if (revoke) for (let i = 0; i < 3; i++) commitRevoke(database(), { kind: "line", threadId: "dax-direct", messageIds: [`line-${i}`], cause: "edit" }, { inline: false });
  return record;
}

describe("W-RC the owner's own turn recalls through an unfinished revoke walk (bundle and search); every other read still waits", () => {
  it("G-RC-SOUND with no revoke in flight the record is recalled either way (the fixture is sound)", async () => {
    const record = remembered(false);
    expect(await bundleHas(access("finch", "finch-direct"), record)).toBe(true);
    expect(await searchHas(access("finch", "finch-direct"), record)).toBe(true);
  });
  it("W-RC-BUNDLE buildMemoryBundle: the record is in the owner turn's bundle, and left out of a bundle not built for the owner's own turn", async () => {
    const record = remembered(true);
    expect(unfinished()).toBe(3);
    expect(ownerDirectChat("finch-direct", access("finch", "finch-direct"))).toBe(true);
    expect(await bundleHas(access("finch", "finch-direct"), record, { ownerTurn: true })).toBe(true);
    expect(await bundleHas(access("finch", "finch-direct"), record)).toBe(false);
    expect(await bundleHas(access("finch", "finch-direct"), record, { ownerTurn: false })).toBe(false);
  });
  it("W-RC-SEARCH searchMemory (the bundle's recall search): the record is a hit for the owner's own turn only", async () => {
    const record = remembered(true);
    expect(unfinished()).toBe(3);
    expect(await searchHas(access("finch", "finch-direct"), record, { ownerTurn: true })).toBe(true);
    expect(await searchHas(access("finch", "finch-direct"), record)).toBe(false);
  });
  it("G-RC-NOTOWNER the same conversation read by a turn whose words were not proven the owner's never gets the settled view, flag or not", async () => {
    const record = remembered(true);
    const other = () => access("finch", "finch-direct", { notOwnerAudience: true });
    expect(ownerDirectChat("finch-direct", other())).toBe(false);
    expect(await bundleHas(other(), record, { ownerTurn: true })).toBe(false);
    expect(await searchHas(other(), record, { ownerTurn: true })).toBe(false);
  });
});
