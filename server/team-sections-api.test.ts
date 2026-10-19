// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Team management through the real HTTP routes on a verification server with
// its own data directory: the desktop gate, rename, members and lead, and
// delete. The rules themselves are pinned in team-sections.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, owner: Record<string, string> = {};

const call = async (method: string, path: string, body?: unknown, headers = owner) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

const team = async (name: string) => (await call("GET", `/api/team-sections?section=${encodeURIComponent(name)}`)).body.team;

it("renames, changes members and lead, and deletes a team, and only for the desktop owner", async () => {
  const bots = [];
  for (const name of ["Ava", "Ben", "Cal"]) bots.push((await call("POST", "/api/bots", { name })).body.bot);
  const [ava, ben, cal] = bots;
  expect((await call("POST", "/api/sidebar-sections", { name: "Operations", botIds: [ava.id, ben.id] })).status).toBe(200);

  // Not from a phone, and not with a made-up surface marker.
  const phone = await call("GET", "/api/team-sections?section=Operations", undefined, {});
  expect(phone.status).toBe(404);
  const spoofed = await call("POST", "/api/team-sections/rename", { section: "Operations", name: "X", revision: "0".repeat(64) }, { "x-murage-surface": "desktop" });
  expect(spoofed.status).toBe(404);

  // The team's channel: its answer carries the room's number, as every answer carrying a room does (CI-OVERLAY-DESIGN I-H2).
  const created = await call("POST", "/api/groups", { name: "Operations", memberIds: [ava.id, ben.id], section: "Operations" });
  expect(created.status).toBe(201);
  expect(created.body.group).toMatchObject({ section: "Operations" });
  expect(created.body.group.recordSeq).toBeGreaterThanOrEqual(1);
  expect(typeof created.body.group.recordEpoch).toBe("string");

  let current = await team("Operations");
  expect(current.members.map((bot: any) => bot.id).sort()).toEqual([ava.id, ben.id].sort());

  const renamed = await call("POST", "/api/team-sections/rename", { section: "Operations", name: "Ops", revision: current.revision });
  expect(renamed.status).toBe(200);
  expect(renamed.body.team.name).toBe("Ops");
  // The rename's own row for the channel is numbered at the rename's frame, past the create's, so a client holding a later
  // change drops it and one holding the create applies it.
  const row = renamed.body.changed.groups.find((group: any) => group.id === created.body.group.id);
  expect(row).toMatchObject({ name: "Ops", section: "Ops", recordEpoch: created.body.group.recordEpoch });
  expect(row.recordSeq).toBeGreaterThan(created.body.group.recordSeq);
  const listedRoster = (await call("GET", "/api/bots?messages=0")).body;
  expect(listedRoster.groups.find((group: any) => group.id === created.body.group.id)).toMatchObject({ recordSeq: row.recordSeq });
  // The roster is the horizon: every statement numbered at or below roomClock was made before it and is in its rows.
  expect(listedRoster.roomClock).toBeGreaterThanOrEqual(row.recordSeq);
  expect(listedRoster.tasksEpoch).toBe(created.body.group.recordEpoch);

  // The old revision is now stale.
  const stale = await call("POST", "/api/team-sections/members", { section: "Ops", revision: current.revision, add: [cal.id] });
  expect(stale.status).toBe(409);

  current = await team("Ops");
  const changed = await call("POST", "/api/team-sections/members", { section: "Ops", revision: current.revision, add: [cal.id], remove: [ben.id] });
  expect(changed.status).toBe(200);
  expect(changed.body.team.members.map((bot: any) => bot.id).sort()).toEqual([ava.id, cal.id].sort());

  const listed = await call("GET", "/api/bots?messages=0");
  expect(listed.body.bots.find((bot: any) => bot.id === ben.id).section ?? "").toBe("");

  const deleted = await call("POST", "/api/team-sections/delete", { section: "Ops", revision: changed.body.team.revision, bots: "keep" });
  expect(deleted).toMatchObject({ status: 200, body: { ok: true, bots: 2 } });
  expect((await call("GET", "/api/team-sections?section=Ops")).status).toBe(404);
  const after = (await call("GET", "/api/bots?messages=0")).body.bots;
  for (const id of [ava.id, cal.id]) expect(after.find((bot: any) => bot.id === id).hidden ?? false).toBe(false);
}, 60000);

it("ROOM-ORDER R1 (static): every `group` broadcast is built by id and numbered by the registry's builders; every removal frame takes a number", () => {
  const source = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
  // a bounded page (task switch, new or deleted task) goes through broadcastGroupPage, which numbers once for both shapes
  expect(source.match(/broadcastPage\("group"/g)).toHaveLength(1);
  expect(source).toMatch(/function broadcastGroupPage\(groupId: string,[\s\S]{0,500}broadcastPage\("group", \(beside\) => \(\{ \.\.\.page\(group, beside\), \.\.\.numbers \}\)\)/);
  // no call site hands either builder a record: they take an id and re-read the registry
  const calls = [...source.matchAll(/^(?!\s*function ).*\b(groupFrame|broadcastGroupPage)\(([^,)]*)/gm)].map((match) => match[2]!.trim());
  expect(calls.length).toBeGreaterThanOrEqual(4);
  for (const argument of calls) expect(argument, argument).toMatch(/^(groupId|(group|switched|updated)\.id)$/);
  expect(source.match(/broadcastGroupPage\((group|switched|updated)\.id, /g)).toHaveLength(3);
  // `kind: "group"` is built only by groupFrame; `kind: "group.deleted"` only by groupDeletedFrame, numbered
  expect(source.match(/kind: "group" as const/g)).toHaveLength(1);
  expect(source).not.toMatch(/broadcast\(\{ kind: "group\.deleted"/);
  expect(source.match(/kind: "group\.deleted" as const/g)).toHaveLength(1);
  expect(source).toMatch(/const groupDeletedFrame = \(groupId: string, seq: number, audience\?: "remote"\) => \(\{ kind: "group\.deleted" as const, groupId, [^\n]*recordSeq: seq, recordEpoch: taskDelta\.epoch \}\)/);
  expect(source.match(/broadcast\(groupDeletedFrame\(/g)).toHaveLength(2);
});
