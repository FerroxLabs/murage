// SPDX-License-Identifier: AGPL-3.0-or-later
// BOT-VENUE-AWARENESS-106 Part 1 ("Where I belong"), tests T1 to T15 (T7's working-context half is in
// working-context.test.ts, T11 is in venue-awareness.partition.test.ts, T3's surface register is in owner-audience.test.ts).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { botShapeRows, lastTurnShapes, recordTurnShapes, shapeLayer, withLearned } from "./bot-shapes.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { turnAudienceIsOwner } from "./owner-audience.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { MAX_VENUES, resetVenueWarningForTest, VENUE_BLOCK_BYTES, venueBlock, venueFacts, venueThreads, venueTurnBlock, venueTurnContext, VENUE_EMPTY_LINE, VENUE_UNAVAILABLE_LINE, type VenueInput } from "./venue-awareness.ts";
import { withVenues, withWorkingContext, workingContextBlock, workingContextForTurn } from "./working-context.ts";

const ROOT = join(import.meta.dirname, "..");
type Group = VenueInput["groups"][number];
type Bot = VenueInput["bots"][number];

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  resetVenueWarningForTest();
});
afterEach(() => vi.restoreAllMocks());

const ember: Bot = { id: "ember", name: "Ember", threadId: "ember-direct", section: "Ops" };
const reed: Bot = { id: "reed", name: "Reed", threadId: "reed-direct" };
const sol: Bot = { id: "sol", name: "Sol", threadId: "sol-direct" };

function channel(id: string, name: string, memberIds: string[], extra: Partial<Group> = {}): Group {
  return { id, name, threadId: `${id}-room`, memberIds, ...extra };
}
function project(id: string, name: string, memberIds: string[], opts: { goal?: string; status?: "active" | "paused" | "done"; lead?: string | null } = {}, extra: Partial<Group> = {}): Group {
  channelToProjectRows(database(), { groupId: id, bulletin: "", leadBotId: opts.lead === undefined ? memberIds[0] ?? null : opts.lead, now: 1 });
  return channel(id, name, memberIds, { channelProject: { goal: opts.goal ?? `the goal of ${name}`, status: opts.status ?? "active", startedAt: 1, updatedAt: 1 }, ...extra });
}
const input = (groups: Group[], extra: Partial<VenueInput> = {}): VenueInput => ({ botId: "ember", currentThreadId: "ember-direct", bots: [ember, reed, sol], groups, toolMounted: true, ...extra });

/** A database whose statements are counted (and, with `fail`, made to throw). */
function counted(fail?: RegExp) {
  const db = database();
  const prepared: string[] = [];
  const settingsReads: string[] = [];
  const proxy = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      prepared.push(sql);
      if (fail?.test(sql)) throw new Error("settings read failed");
      const statement = target.prepare(sql);
      if (!/FROM project_settings WHERE group_id/.test(sql)) return statement;
      return new Proxy(statement, { get(statement, method) {
        if (method === "get") return (groupId: string) => { settingsReads.push(groupId); return statement.get(groupId); };
        const value = Reflect.get(statement, method);
        return typeof value === "function" ? value.bind(statement) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }) as DatabaseSync;
  return { db: proxy, prepared, settingsReads };
}

describe("Where I belong (BOT-VENUE-AWARENESS-106 Part 1)", () => {
  it("T1: Ember, sole member and lead of a project, sees it on her owner direct turn (the design's rendered example)", () => {
    const groups = [project("g_7f2", "Launch week", ["ember"], { goal: "ship the launch newsletter and landing page" }), channel("g_1a9", "Design reviews", ["reed", "ember", "sol"])];
    expect(venueTurnBlock(database(), true, input(groups))).toBe([
      "Where you belong, as of this turn.",
      "Your team: Ops",
      `- Project "Launch week": goal: ship the launch newsletter and landing page. status: active. lead: you. other members: none, just you. id: g_7f2`,
      `- Channel "Design reviews": other members: Reed, Sol. id: g_1a9`,
      "Read any of these with venue_read_messages (venue_id). Each page is in order, oldest to newest; the first page is the newest; pass its before value to go further back.",
    ].join("\n"));
  });

  it("T2: projects come before channels; other members by stored name; without the tool the owner can bring lines in", () => {
    const groups = [channel("c1", "Alpha chat", ["ember", "reed"]), project("p1", "Zeta", ["ember", "sol"], { lead: "sol" })];
    const lines = venueBlock(database(), input(groups, { toolMounted: false })).split("\n");
    expect(lines[2]).toBe(`- Project "Zeta": goal: the goal of Zeta. status: active. lead: Sol. other members: Sol. id: p1`);
    expect(lines[3]).toBe(`- Channel "Alpha chat": other members: Reed. id: c1`);
    expect(lines.at(-1)).toBe("The owner can bring lines from any of these into this chat.");
  });

  it("T3: a channel person's thread on Slack, Discord and Telegram, and unproven words, get nothing", () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot({ section: "Ops" });
    const groups = [project("p1", "Secret launch", [bot.id], { goal: "GOAL_CANARY" }), channel("c1", "Hidden channel", [bot.id, "reed"])];
    const venue = (threadId: string, owner: boolean) => venueTurnBlock(database(), owner, { botId: bot.id, currentThreadId: threadId, bots: [{ id: bot.id, name: "Dax", threadId: bot.threadId }, reed], groups, toolMounted: true });
    expect(venue(bot.threadId, turnAudienceIsOwner(bot.threadId))).toContain("GOAL_CANARY");
    for (const platform of ["slack", "discord", "telegram"] as const) {
      const bindingId = observeVerifiedHuman({ platform, connectionId: `${platform}-connection`, authorityId: "TEAM", userId: `U-${platform}` });
      linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
      const task = store.createTask(bot.id, "Channel conversation", false)!;
      bindHumanThread(task.threadId, resolveHumanBinding(bindingId));
      expect(venue(task.threadId, turnAudienceIsOwner(task.threadId)), platform).toBe("");
      expect(venue(bot.threadId, turnAudienceIsOwner(bot.threadId, { rootThreadId: task.threadId })), `${platform} delegation`).toBe("");
    }
    expect(venue(bot.threadId, turnAudienceIsOwner(bot.threadId, { origin: "unproven" }))).toBe("");
    // a delegated turn with notOwnerAudience: the direct turn's surfacesForOwner folds that bit in, and the block is built from it alone
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    expect(index).toMatch(/const surfacesForOwner=turnAudienceIsOwner\(threadId,\{origin:opts\?\.origin,rootThreadId:opts\?\.chainRootThreadId\}\)[\s\S]{0,400}&&opts\?\.notOwnerAudience!==true;/);
    expect(index).toContain(`venueTurnContext(database(), surfacesForOwner, {`);
    const denied = counted(/./);
    expect(venueTurnBlock(denied.db, false, input(groups))).toBe("");
    expect(denied.prepared).toEqual([]);
  });

  it("T4: a membership change reaches the next turn; the last one removed gives the empty line", () => {
    const x = channel("x", "Venue X", ["ember", "reed"]);
    const y = channel("y", "Venue Y", ["ember"]);
    const turn = () => withVenues("hello", venueTurnBlock(database(), true, input([x, y])));
    expect(turn()).toContain(`"Venue X"`);
    x.memberIds = ["reed"];
    const second = turn();
    expect(second).not.toContain("Venue X");
    expect(second).toContain(`"Venue Y"`);
    y.memberIds = [];
    expect(turn()).toBe("<where-i-belong>\nYou are not in any project or channel right now.\n</where-i-belong>\n\nhello");
  });

  it("T5: every turn carries the block, a fresh or driver-recreated session included (no delivered cache)", () => {
    const groups = [channel("c1", "Design reviews", ["ember", "reed"])];
    const first = venueTurnBlock(database(), true, input(groups));
    expect(venueTurnBlock(database(), true, input(groups))).toBe(first);
    expect(withVenues("hello", first)).toBe(`<where-i-belong>\n${first}\n</where-i-belong>\n\nhello`);
    expect(withVenues("hello", "")).toBe("hello");
    // A resumed driver can recreate its session without changing the server's session key.
    // Only the working block is deduplicated; the venue list still rides all three messages.
    for (const fresh of [true, false, false]) {
      const working = workingContextForTurn("venue-T5-session", "recent work", fresh);
      const message = withVenues(withLearned(withWorkingContext("hello", working), "lesson"), venueTurnBlock(database(), true, input(groups)));
      expect(message).toBe(`<where-i-belong>\n${first}\n</where-i-belong>\n\nlesson\n\n${fresh ? "<working-context>\nrecent work\n</working-context>\n\n" : ""}hello`);
    }
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    // built on every direct turn and handed straight to the message: never through workingContextForTurn or learnedForTurn
    expect(index).toMatch(/const venues = engineCommand \|\| memoryLastResort \? \{ text: "", kindOf: null \} : pre\.sync\("where-i-belong", \(\) => venueTurnContext\(/);
    expect(index).toContain("const venueBlock = venues.text;");
    expect(index).toContain("venueKinds: venues.kindOf");
    expect(index).not.toMatch(/ForTurn\([^;\n]*venueBlock/);
    // message order: where-i-belong, learned, working-context, the person's text
    expect(index).toContain("withVenues(withLearned(withWorkingContext(");
    expect(index.match(/shapeLayer\("where-i-belong", venueBlock\)/g)).toHaveLength(2);
    expect(index.match(/venueTurnContext\(database\(\)/g)).toHaveLength(1);
  });

  it("T6: a pair room and an archived room are never named", () => {
    const groups = [channel("pair", "Ember and Reed", ["ember", "reed"], { dm: true }), channel("old", "Old channel", ["ember"], { hidden: true }), channel("c1", "Live", ["ember"])];
    const text = venueBlock(database(), input(groups));
    expect(text).not.toContain("Ember and Reed");
    expect(text).not.toContain("Old channel");
    expect(text).toContain(`"Live"`);
    expect(venueFacts(database(), input(groups)).kindOf.size).toBe(3);
    expect(venueBlock(database(), input(groups.slice(0, 2)))).toBe(VENUE_EMPTY_LINE);
  });

  it("T7: an ended project, and one with no settings row or table, is a channel: no goal, lead or status", () => {
    const ended = project("p1", "Ended one", ["ember"], { goal: "ENDED_GOAL" });
    database().prepare("UPDATE project_settings SET ended_at=5 WHERE group_id='p1'").run();
    const rowless = channel("p2", "No row", ["ember"], { channelProject: { goal: "ROWLESS_GOAL", status: "active", startedAt: 1, updatedAt: 1 } });
    Object.defineProperty(ended.channelProject!, "goal", { get: () => { throw new Error("ended goal must not be read"); } });
    Object.defineProperty(rowless.channelProject!, "status", { get: () => { throw new Error("rowless status must not be read"); } });
    const text = venueBlock(database(), input([ended, rowless]));
    expect(text).toContain(`- Channel "Ended one": other members: none, just you. id: p1`);
    expect(text).toContain(`- Channel "No row": other members: none, just you. id: p2`);
    expect(text).not.toMatch(/ENDED_GOAL|ROWLESS_GOAL|status:|lead:/);
    expect(venueFacts(database(), input([ended, rowless])).kindOf).toEqual(new Map([["p1", "channel"], ["p2", "channel"]]));
    database().exec("DROP TABLE project_settings");
    expect(venueBlock(database(), input([rowless]))).toContain(`- Channel "No row"`);
    expect(venueBlock(database(), input([rowless]))).not.toMatch(/ROWLESS_GOAL|status:|lead:/);
  });

  it("T8: a paused run or paused status reads paused; a closed project reads closed", () => {
    const groups = [project("p1", "Run paused", ["ember"]), project("p2", "Status paused", ["ember"], { status: "paused" }), project("p3", "Closed", ["ember"])];
    database().prepare("UPDATE project_settings SET run_state='paused' WHERE group_id='p1'").run();
    database().prepare("UPDATE project_settings SET closed_at=9 WHERE group_id='p3'").run();
    database().prepare("UPDATE project_settings SET run_state='paused' WHERE group_id='p3'").run();
    const text = venueBlock(database(), input(groups));
    expect(text).toMatch(/"Run paused": .* status: paused\./);
    expect(text).toMatch(/"Status paused": .* status: paused\./);
    expect(text).toMatch(/"Closed": .* status: closed\./);
  });

  it("T9: the lead is none, a current member's name, none once it left, and a member id with no bot is a member", () => {
    const groups = [
      project("p1", "No lead", ["ember"], { lead: null }),
      project("p2", "Reed leads", ["ember", "reed"], { lead: "reed" }),
      project("p3", "Lead left", ["ember"], { lead: "sol" }),
      project("p4", "Ghost lead", ["ember", "ghost"], { lead: "ghost" }),
    ];
    const text = venueBlock(database(), input(groups));
    expect(text).toMatch(/"No lead": .* lead: none\./);
    expect(text).toMatch(/"Reed leads": .* lead: Reed\. other members: Reed\./);
    expect(text).toMatch(/"Lead left": .* lead: none\./);
    expect(text).toMatch(/"Ghost lead": .* lead: a member\. other members: a member\./);
  });

  it("T10: twenty projects: each settings row read once, twelve listed in order, the rest counted, caps and one-line names", () => {
    const statuses = ["active", "paused", "done"] as const;
    const groups: Group[] = [];
    for (let i = 0; i < 20; i++) groups.push(project(`p${String(i).padStart(2, "0")}`, `P${String(i).padStart(2, "0")}`, ["ember"], { status: statuses[i % 3], goal: "g" }));
    database().prepare("UPDATE project_settings SET closed_at=1 WHERE group_id='p00'").run();
    const { db, prepared, settingsReads } = counted();
    const text = venueBlock(db, input(groups));
    expect(prepared.filter(sql => /FROM project_settings WHERE group_id/.test(sql))).toHaveLength(20);
    expect(settingsReads).toEqual(groups.map(group => group.id));
    expect(prepared.some(sql => /\bmessages\b/.test(sql))).toBe(false);
    const listed = text.split("\n").filter(line => line.startsWith("- "));
    expect(listed).toHaveLength(MAX_VENUES);
    expect(text).toContain("...and 8 more. Ask the owner which one matters now.");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(VENUE_BLOCK_BYTES);
    // active (0,3,6,9,12,15,18), then paused (1,4,7,10,13), closed p00 last
    expect(listed.map(line => line.match(/"(P\d+)"/)![1])).toEqual(["P03", "P06", "P09", "P12", "P15", "P18", "P01", "P04", "P07", "P10", "P13", "P16"]);
    expect(venueFacts(database(), input(groups)).venues.map(venue => venue.id)).toEqual([
      "p03", "p06", "p09", "p12", "p15", "p18", "p01", "p04", "p07", "p10", "p13", "p16", "p19",
      "p02", "p05", "p08", "p11", "p14", "p17", "p00",
    ]);
    // the byte cap cuts the list too, with the same ending
    const long = Array.from({ length: 12 }, (_, i) => channel(`c${i}`, "N".repeat(60), ["ember", ...Array.from({ length: 6 }, (_, j) => `m${j}`)]));
    const bots = [ember, ...Array.from({ length: 6 }, (_, j) => ({ id: `m${j}`, name: "M".repeat(40), threadId: `m${j}` }))];
    const capped = venueBlock(database(), input(long, { bots }));
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(VENUE_BLOCK_BYTES);
    expect(capped).toMatch(/\.\.\.and \d+ more\. Ask the owner which one matters now\./);
    const shown = capped.split("\n").filter(line => line.startsWith("- ")).length;
    expect(shown).toBeLessThan(12);
    expect(capped).toContain(`...and ${12 - shown} more.`);
    // long and tagged text on one line, cut
    const tagged = project("t1", "Bad <b>name</b>\nsecond line", ["ember", "reed"], { goal: "x".repeat(2000) });
    const oneLine = venueBlock(database(), input([tagged], { bots: [{ ...ember, section: "Ops <i>\nteam" }, { ...reed, name: "Re<ed>\nB" }] }));
    expect(oneLine).toContain(`goal: ${"x".repeat(160)}. status:`);
    expect(oneLine).not.toMatch(/[<>]/);
    expect(oneLine).toContain(`- Project "Bad bname/b second line"`);
    expect(oneLine).toContain("Your team: Ops i team");
    expect(oneLine).toContain("other members: Reed B.");
    expect(oneLine.split("\n")).toHaveLength(4);
    tagged.channelProject!.goal = "<goal>first</goal>\nSECOND_LINE_CANARY";
    expect(venueBlock(database(), input([tagged]))).toContain("goal: goalfirst/goal. status:");
    expect(venueBlock(database(), input([tagged]))).not.toContain("SECOND_LINE_CANARY");
    const unicode = venueBlock(database(), input(long, { bots: bots.map(bot => ({ ...bot, name: "界".repeat(40) })) }));
    expect(Buffer.byteLength(unicode)).toBeLessThanOrEqual(VENUE_BLOCK_BYTES);
    expect(unicode).not.toContain("\uFFFD");
    expect(unicode).toContain(`...and ${12 - unicode.split("\n").filter(line => line.startsWith("- ")).length} more.`);
  });

  it("T12: a webhook turn gets nothing; a routine turn gets the block", () => {
    const groups = [channel("c1", "Design reviews", ["ember"])];
    expect(venueTurnBlock(database(), true, { ...input(groups), automationSource: "webhook" })).toBe("");
    expect(venueTurnBlock(database(), true, { ...input(groups), automationSource: "schedule" })).toContain(`"Design reviews"`);
    expect(venueTurnBlock(database(), true, { ...input(groups), automationSource: "manual" })).toContain(`"Design reviews"`);
    const denied = counted(/./);
    expect(venueTurnBlock(denied.db, true, { ...input(groups), automationSource: "webhook" })).toBe("");
    expect(denied.prepared).toEqual([]);
  });

  it("T13: a settings read that throws gives the unavailable line, one warning per boot, and the turn goes on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = [project("p1", "Launch", ["ember"])];
    const { db } = counted(/FROM project_settings WHERE group_id/);
    expect(venueBlock(db, input(groups))).toBe(VENUE_UNAVAILABLE_LINE);
    const context = venueTurnContext(db, true, input(groups));
    expect(context.text).toBe(VENUE_UNAVAILABLE_LINE);
    expect(context.kindOf).toBeNull();
    // The direct path passes this map to the working builder. It must not retry the failing read.
    const unavailable = counted(/./);
    const working = workingContextBlock(LineageAllowance.tool(), true, { ...input(groups), venueKinds: context.kindOf, routines: [], now: 1 }, unavailable.db);
    expect(working.text).toBe("");
    expect(unavailable.prepared).toEqual([]);
    expect(withVenues(withWorkingContext("hello", working.text), context.text)).toBe("<where-i-belong>\nYour list of projects and channels is not available this turn.\n</where-i-belong>\n\nhello");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(venueTurnBlock(database(), true, input(groups))).toContain('Project "Launch"');
  });

  it("T14: scale: 500 rooms it is not in, a busy venue: no messages statement, settings read only for its own projects", () => {
    const groups: Group[] = Array.from({ length: 500 }, (_, i) => channel(`other${i}`, `Other ${i}`, ["reed"], { channelProject: { goal: "g", status: "active", startedAt: 1, updatedAt: 1 } }));
    groups.push(project("p1", "Mine", ["ember"]), channel("c1", "Busy", ["ember"], { tasks: Array.from({ length: 200 }, (_, i) => ({ threadId: `t${i}`, title: `T${i}` })) as unknown as Group["tasks"] }));
    const { db, prepared } = counted();
    const text = venueBlock(db, input(groups));
    expect(text).toContain(`"Mine"`);
    expect(text).toContain(`"Busy"`);
    expect(prepared.some(sql => /\bmessages\b/.test(sql))).toBe(false);
    expect(prepared.filter(sql => /FROM project_settings WHERE group_id/.test(sql))).toHaveLength(1);
    const emptyStatements = [...prepared];
    transaction(() => {
      const insert = database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
      for (let i = 0; i < 10_000; i++) {
        const message = { id: `scale-${i}`, at: i, role: "bot", kind: "text", text: "HISTORY_CANARY" };
        insert.run(i % 2 ? "p1-room" : "c1-room", message.id, i, message.role, message.kind, message.text, JSON.stringify(message));
      }
    });
    prepared.length = 0;
    expect(venueBlock(db, input(groups))).toBe(text);
    // Equal work, independent of history, without a flaky wall-clock threshold on shared CI.
    expect(prepared).toEqual(emptyStatements);
    expect(prepared.some(sql => /\bmessages\b/.test(sql))).toBe(false);
  });

  it("T15: two projects of equal status sort by name, byte-identical across builds and input orders", () => {
    const a = project("pa", "Bravo", ["ember"]);
    const b = project("pb", "Alpha", ["ember"]);
    const first = venueBlock(database(), input([a, b]));
    expect(first.indexOf(`"Alpha"`)).toBeLessThan(first.indexOf(`"Bravo"`));
    expect(venueBlock(database(), input([b, a]))).toBe(first);
    expect(venueBlock(database(), input([a, b]))).toBe(first);
    const tied = project("pc", "Alpha", ["ember"]);
    expect(venueFacts(database(), input([tied, a, b])).venues.map(venue => venue.id)).toEqual(["pb", "pc", "pa"]);
    expect(venueBlock(database(), input([tied, a, b]))).toBe(venueBlock(database(), input([b, tied, a])));
  });

  it("filed under shows only when the room's section differs from the team label", () => {
    const groups = [channel("c1", "Same", ["ember"], { section: "Ops" }), channel("c2", "Other", ["ember"], { section: "Sales" })];
    const text = venueBlock(database(), input(groups));
    expect(text).toContain(`- Channel "Same": other members: none, just you. id: c1`);
    expect(text).toContain(`- Channel "Other": other members: none, just you. filed under: Sales. id: c2`);
  });

  it("V4: names are bounded, only six other members are named, and a missing team has no header", () => {
    const bots = [{ ...ember, section: undefined }, ...Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, name: String(i).repeat(50), threadId: `m${i}` }))];
    const groups = [channel("c1", "N".repeat(100), ["ember", ...bots.slice(1).map(bot => bot.id)], { section: "S".repeat(50) })];
    const text = venueBlock(database(), input(groups, { bots, toolMounted: false }));
    expect(text).toBe([
      "Where you belong, as of this turn.",
      `- Channel "${"N".repeat(60)}": other members: ${Array.from({ length: 6 }, (_, i) => String(i).repeat(40)).join(", ")} and 2 more. filed under: ${"S".repeat(40)}. id: c1`,
      "The owner can bring lines from any of these into this chat.",
    ].join("\n"));
  });

  it("T10 / 3.4: the working context uses all lifecycle facts from the turn, even beyond the venue cap", () => {
    const groups = Array.from({ length: 20 }, (_, i) => project(`p${i}`, `P${String(i).padStart(2, "0")}`, ["ember"], { goal: "g" }));
    const { db, prepared } = counted();
    const context = venueTurnContext(db, true, input(groups));
    expect(context.kindOf?.size).toBe(20);
    expect(context.kindOf?.get("p19")).toBe("project");
    expect(context.text).not.toContain('"P19"');
    expect(prepared.filter(sql => /FROM project_settings WHERE group_id/.test(sql))).toHaveLength(20);
    prepared.length = 0;
    const working = workingContextBlock(LineageAllowance.tool(), true, { ...input(groups), venueKinds: context.kindOf, routines: [], now: 1 }, db);
    expect(working.text).toBe("");
    expect(prepared.filter(sql => /FROM project_settings WHERE group_id/.test(sql))).toEqual([]);
  });

  it("D2 / D6: the inspector shows the venue message layer, never in its system text", () => {
    const text = venueTurnBlock(database(), true, input([channel("c1", "Design reviews", ["ember"])]));
    const current = { houseRules: { on: true, text: "rules" }, persona: "Ember", teamBrief: null, memory: "", chiefGuide: null, skills: [] };
    const pending = botShapeRows(current, null);
    expect(pending.find(row => row.id === "where-i-belong")).toMatchObject({
      group: "turn", label: "Where it belongs", locked: true, switchable: false, text: null,
      what: "The projects and channels it is a member of, so it knows them when you talk to it one to one. Only when it is talking with you.",
    });
    expect(pending.findIndex(row => row.id === "where-i-belong")).toBeLessThan(pending.findIndex(row => row.id === "working-context"));
    recordTurnShapes("venue-inspector", { where: "chat", threadId: "direct", layers: [shapeLayer("persona", "Ember"), shapeLayer("where-i-belong", text), shapeLayer("working-context", "work")] });
    const last = lastTurnShapes("venue-inspector")!;
    expect(last.text).toBe("Ember");
    expect(botShapeRows(current, last).find(row => row.id === "where-i-belong")?.text).toBe(text);
    recordTurnShapes("venue-inspector", { where: "chat", threadId: "contact", layers: [shapeLayer("persona", "Ember"), shapeLayer("where-i-belong", "")] });
    expect(botShapeRows(current, lastTurnShapes("venue-inspector")).some(row => row.id === "where-i-belong")).toBe(false);
  });

  it("venueThreads: a live project's room, tasks and member desks; an ended project's or a channel's room and tasks only", () => {
    const p = project("p1", "Launch", ["ember"], {}, { tasks: [{ threadId: "p1-task", title: "T" }] as unknown as Group["tasks"] });
    const c = channel("c1", "Chat", ["ember"], { tasks: [{ threadId: "c1-task", title: "T" }] as unknown as Group["tasks"] });
    const roster = { groups: [p, c], bots: [{ ...ember, tasks: [{ threadId: "ember-desk", title: "Desk", channelProjectDesk: { groupId: "p1" } }] }] } as unknown as Parameters<typeof venueThreads>[1];
    expect(venueThreads(database(), roster, "p1")).toEqual(new Set(["p1-room", "p1-task", "ember-desk"]));
    expect(venueThreads(database(), roster, "c1")).toEqual(new Set(["c1-room", "c1-task"]));
    database().prepare("UPDATE project_settings SET ended_at=5 WHERE group_id='p1'").run();
    expect(venueThreads(database(), roster, "p1")).toEqual(new Set(["p1-room", "p1-task"]));
    expect(venueThreads(database(), roster, "nope")).toEqual(new Set());
  });
});
