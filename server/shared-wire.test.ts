// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-X 12.3: the desktop wire bot carries `sharedWith` and `partitionedAt`;
// every other projection (responses, live `bot` frames and replay) strips
// both and carries `shared` and, for the owner's phone, `sharedRows`.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { foreignBody, remoteBody, remoteWireBot, scopedBotFrame, sharedRowsFor, sharingTeams, sharingWire, wireSharedWork } from "./shared-wire.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), carl = make("Carl", "Design"); make("Sam", "Sales"); make("Tia", "Support");
  // `all` mode set straight on the record, as a restored or older file has it:
  // no team has an identity yet and no work thread exists (cold start).
  iris.sharedWith = { mode: "all", teams: [] }; iris.partitionedAt = 5;
  return { store, iris, carl };
}
const wire = (bot: object) => JSON.parse(JSON.stringify(bot)) as Record<string, unknown> & { id: string };

it("cold start in all mode: the phone gets one row per covered team with no thread yet, and never sharedWith", () => {
  const { store, iris } = fixture();
  const phone = remoteWireBot(wire(iris), store, true);
  expect(phone).not.toHaveProperty("sharedWith");
  expect(phone).not.toHaveProperty("partitionedAt");
  expect(phone.shared).toBe(true);
  expect(phone.sharedRows.map(row => [row.teamName, row.threadId])).toEqual([["Sales", null], ["Support", null]]);
  // a read never mints (3.1): a team nobody named in sharing has no id yet
  expect(phone.sharedRows.map(row => row.teamId)).toEqual([null, null]);
  expect(database().prepare("SELECT count(*) AS n FROM team_identities").get()!.n).toBe(0);
  // once a team has an identity its row carries it
  const sales = teamIdFor("Sales");
  expect(sharedRowsFor(store, iris).map(row => row.teamId)).toEqual([sales, null]);
  // an unproven remote caller learns that the bot is shared, and nothing else
  expect(remoteWireBot(wire(iris), store, false)).toMatchObject({ shared: true, sharedRows: [] });
});

it("once the owner opens a work thread its row carries the thread, and the task carries only the team and its state", () => {
  const { store, iris } = fixture(); const sales = teamIdFor("Sales");
  const task = store.createSharedWorkTask(iris.id, sales)!;
  expect(sharedRowsFor(store, iris).find(row => row.teamId === sales)?.threadId).toBe(task.threadId);
  task.sharedWork!.closedAt = 9; task.sharedWork!.closedReason = "revoked"; task.sharedWork!.finishing = { requestId: "secret-request" };
  const projected = wireSharedWork(task.sharedWork!);
  expect(projected).toEqual({ teamId: sales, teamName: "Sales", createdAt: task.sharedWork!.createdAt, closedAt: 9, closedReason: "revoked" });
  expect(JSON.stringify(projected)).not.toContain("secret-request");
});

it("an unshared bot is not shared and has no rows; the home team and General are never rows", () => {
  const { store, iris, carl } = fixture();
  expect(remoteWireBot(wire(carl), store, true)).toMatchObject({ shared: false, sharedRows: [] });
  const teams = sharingTeams(store, iris);
  expect(teams.find(team => team.name === "Design")).toMatchObject({ covered: false, selectable: false, reason: "home" });
  expect(teams.some(team => team.name === "" || team.name === "General")).toBe(false);
});

it("responses: every bot inside a body is projected, transcripts are passed through untouched", () => {
  const { store, iris, carl } = fixture();
  const messages = [{ id: "m1", text: "CANARY sharedWith partitionedAt", sharedWith: "a message field is never a bot" }];
  const body = { bots: [{ ...wire(iris), messages }, wire(carl)], groups: [], bot: wire(iris) };
  const projected = remoteBody(body, store, true) as any;
  expect(JSON.stringify(projected.bots[0]).includes('"partitionedAt"')).toBe(false);
  expect(projected.bots[0]).not.toHaveProperty("sharedWith");
  expect(projected.bots[0].messages).toBe(messages);
  expect(projected.bots[0].sharedRows).toHaveLength(2);
  expect(projected.bot).not.toHaveProperty("sharedWith");
  expect(projected.bots[1]).toMatchObject({ shared: false, sharedRows: [] });
  // nothing to project: the same object back
  const plain = { ok: true, list: [1, 2] };
  expect(remoteBody(plain, store, true)).toBe(plain);
});

it("live and replayed bot frames are projected; every other frame is untouched", () => {
  const { store, iris } = fixture();
  const frame = `id: s:7\ndata: ${JSON.stringify({ kind: "bot", bot: wire(iris), seq: 7 })}\n\n`;
  const scoped = scopedBotFrame(frame, store, true);
  expect(scoped.startsWith("id: s:7\ndata: ")).toBe(true);
  const payload = JSON.parse(scoped.slice(scoped.indexOf("data: ") + 6));
  expect(payload.seq).toBe(7);
  expect(payload.bot).not.toHaveProperty("sharedWith");
  expect(payload.bot).not.toHaveProperty("partitionedAt");
  expect(payload.bot.sharedRows.map((row: { teamName: string }) => row.teamName)).toEqual(["Sales", "Support"]);
  const other = `id: s:8\ndata: ${JSON.stringify({ kind: "message", threadId: "t", message: { sharedWith: 1 } })}\n\n`;
  expect(scopedBotFrame(other, store, true)).toBe(other);
});

it("a legacy team label longer than 60 characters never breaks a read, and no read or frame mints", () => {
  const { store, iris } = fixture();
  const long = "L".repeat(61);
  const legacy = store.createBot(); store.patchBot(legacy.id, { name: "Old", section: long });
  const before = database().prepare("SELECT count(*) AS n FROM team_identities").get()!.n;
  // what index.ts wireBot spreads into every desktop bot, GET /api/bots included
  const desk = sharingWire(iris, store);
  expect(desk.shared).toBe(true);
  expect(desk.sharedRows.map(row => row.teamName)).toEqual([long, "Sales", "Support"]);
  expect(desk.sharedRows.every(row => row.teamId === null)).toBe(true);
  // the phone's projection and a bot frame
  expect(remoteWireBot(wire(iris), store, true).sharedRows).toHaveLength(3);
  scopedBotFrame(`data: ${JSON.stringify({ kind: "bot", bot: wire(iris) })}\n\n`, store, true);
  expect(database().prepare("SELECT count(*) AS n FROM team_identities").get()!.n).toBe(before);
  // the owner's sharing list, which may mint, leaves the long label out rather than failing
  expect(sharingTeams(store, iris).some(team => team.name === long)).toBe(false);
});

describe("foreignBody (astra-botint H1: owner-only metadata at the response boundary)", () => {
  it("cuts the numbering, the ledger and turn ids from nested bots and transcript rows, and keeps everything else", () => {
    const row = (id: string, extra: Record<string, unknown>) => ({ id, role: "user", content: "hi", createdAt: 1, ...extra });
    const body = {
      tasksEpoch: "e1",
      removed: [{ id: "gone", kind: "deleted", tasksSeq: 3 }],
      bots: [{
        id: "b1", threadId: "t1", name: "Bot", modelSelection: {}, tasksSeq: 7, tasksEpoch: "e1",
        messages: [row("m1", { dispatchedIn: "turn-1" }), { ...row("m2", { turnId: "turn-1", turnTerminal: true }), role: "assistant" }],
        tasks: { items: [{ id: "task", tasksSeq: 2 }] },
      }],
      messages: [row("m3", { dispatchedIn: "turn-2", turnId: "turn-2" })],
      bot: { id: "b2", threadId: "t2", name: "Two", modelSelection: {}, tasksSeq: 1, tasksEpoch: "e1" },
    };
    const out = foreignBody(body) as any;
    expect(JSON.stringify(out)).not.toMatch(/"(tasksEpoch|tasksSeq|turnId|dispatchedIn|removed)"/);
    expect(out.bots[0]).toMatchObject({ id: "b1", threadId: "t1", name: "Bot" });
    expect(out.bots[0].messages[0]).toEqual({ id: "m1", role: "user", content: "hi", createdAt: 1 });
    expect(out.bots[0].messages[1]).toMatchObject({ id: "m2", role: "assistant", turnTerminal: true });
    expect(out.messages[0]).toEqual({ id: "m3", role: "user", content: "hi", createdAt: 1 });
    expect(out.bot).toEqual({ id: "b2", threadId: "t2", name: "Two", modelSelection: {} });
    // the owner's body is never touched
    expect(body.bots[0].tasksSeq).toBe(7);
    expect((body.messages[0] as Record<string, unknown>).dispatchedIn).toBe("turn-2");
  });

  it("leaves a body with nothing owner-only as the same object, and a `turnId` outside a transcript row alone", () => {
    const plain = { ok: true, bots: [{ id: "b", name: "x" }] };
    expect(foreignBody(plain)).toBe(plain);
    expect(foreignBody({ session: { turnId: "t" } })).toEqual({ session: { turnId: "t" } });
  });
});
