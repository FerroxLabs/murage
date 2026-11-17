// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// T58 (CROSS-CHAT-PAIRED-DM-1019): venue_read_messages from the owner's own paired Telegram/Slack/Discord DM. Each refusal first proves
// the positive path on the same fixture, so a base that never mounts cannot pass vacuously.
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, pairedOwnerBinding, resolveHumanBinding, revokeHumanConnection } from "./human-principals.ts";
import { appendMessage } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { registerProjectMemoryTools } from "./project-memory-tools.ts";
import { turnRequestByGeneration } from "./project-tool-routing.ts";
import type { BotRecord, GroupRecord, Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { venuePostMounts } from "./venue-post.ts";
import { normalizeSlackMessage } from "./channels/slack/event.ts";
import { normalizeDiscordMessage } from "./channels/discord/event.ts";
import { forgetAllVenueReadTurns, pairedVenueReadMounts, recordVenueReadTurn, serveVenueRead, setVenueReadLive, venueReadMounts, venueReadTurns,
  VENUE_READ_UNAVAILABLE as L1, VENUE_NOT_AVAILABLE as L2, VENUE_READ_LIMIT as L3 } from "./venue-read.ts";

const NOW = 1_790_000_000_000;
const claim = { botId: "dax", threadId: "dm", generation: "turn" };
let roster: { bots: BotRecord[]; groups: GroupRecord[] };
let runs: Map<string, { bindingId: string; revision: number }>;
let serial = 0;
type Platform = "telegram" | "slack" | "discord" | "whatsapp";

function say(threadId: string, text: string) {
  const message = { id: `p${++serial}`, role: "bot", kind: "text", text, at: NOW + serial, from: { botId: "finch", name: "Finch", color: "blue" } } as Message;
  appendMessage(threadId, message); return message;
}
/** A verified channel account linked as the owner (or a person), its DM thread bound, and its live channel run. */
function pair(platform: Platform = "telegram", as: "owner" | "person" = "owner", thread = "dm") {
  const userId = platform === "whatsapp" ? "15550000000" : "sean";
  const bindingId = observeVerifiedHuman({ platform, connectionId: "conn", authorityId: platform === "whatsapp" ? userId : "team", userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as });
  const principal = resolveHumanBinding(bindingId);
  bindHumanThread(thread, principal);
  runs.set(thread, { bindingId, revision: principal.revision });
  return { bindingId, revision: principal.revision };
}
const mountInput = (extra: Record<string, unknown> = {}) => ({ surfacesForOwner: true, directOwnerAudience: true, origin: undefined,
  automationSource: "channel", automationThread: true, bot: roster.bots[0]!, threadId: "dm", agentsMcp: true, ...extra });
/** What runTurn does: decide the paired mount, then record it for the generation. */
function mount(extra: Record<string, unknown> = {}) {
  const paired = pairedVenueReadMounts(mountInput(extra) as Parameters<typeof pairedVenueReadMounts>[0], runs.get("dm") ?? null, database());
  if (paired) recordVenueReadTurn(claim.generation, { botId: "dax", threadId: "dm", origin: "paired", paired });
  return paired;
}
const read = () => serveVenueRead(database(), claim, { venueId: "venue" });
function reads() {
  const response = read(); expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).toContain("ROOM-LINE");
}
function refused() {
  const response = read();
  expect(response).toEqual({ status: 403, body: { error: L1 } });
  expect(JSON.stringify(response)).not.toContain("ROOM-LINE");
}

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  serial = 0; forgetAllVenueReadTurns(); turnRequestByGeneration.clear(); runs = new Map();
  roster = {
    bots: [
      { id: "dax", name: "Dax", threadId: "direct", section: "Ops", tasks: [{ threadId: "dm" }, { threadId: "other-dm" }] },
      { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
    ],
    // an owner-only room: no person thread is bound in it
    groups: [{ id: "venue", name: "Venue", threadId: "room", section: "Ops", memberIds: ["dax", "finch"], tasks: [] }],
  } as unknown as typeof roster;
  setExecutionStore({ ...roster, bot: (id: string) => roster.bots.find(bot => bot.id === id), group: (id: string) => roster.groups.find(group => group.id === id) } as Store);
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
  setVenueReadLive({ ownerSurface: () => true, notOwnerAudience: () => false, roster: () => roster, pairedRun: id => runs.get(id) ?? null });
  registerProjectMemoryTools({ roster: () => roster, note: () => {}, shown: vi.fn(), read: vi.fn() });
  say("room", "ROOM-LINE");
});
afterEach(() => {
  vi.restoreAllMocks(); setVenueReadLive(null); forgetAllVenueReadTurns(); turnRequestByGeneration.clear();
  setExecutionStore(undefined as never); closeDatabase();
});

describe("T58 paired owner DM reads its rooms", () => {
  it("T58a an admitted paired generation reads an owner-only room", () => {
    const paired = pair();
    recordVenueReadTurn(claim.generation, { botId: "dax", threadId: "dm", origin: "paired", paired });
    reads();
  });

  it.each(["telegram", "slack", "discord"] as const)("T58a a paired owner %s DM mounts and reads an owner-only room", platform => {
    const binding = pair(platform);
    expect(venueReadMounts({ ...mountInput(), origin: undefined } as Parameters<typeof venueReadMounts>[0])).toBe(false);  // the desktop predicate stays closed
    expect(mount()).toEqual(binding);
    reads();
  });

  it("T58b a DM bound to another person never mounts, and a forged paired record is refused", () => {
    pair("telegram", "person");
    expect(mount()).toBeNull();
    const binding = runs.get("dm")!;
    recordVenueReadTurn(claim.generation, { botId: "dax", threadId: "dm", origin: "paired", paired: binding });
    refused();
  });

  it("T58b an unbound thread never qualifies through the OWNER default", () => {
    const binding = pair();  // proves the fixture mounts on its own thread
    expect(mount()).toEqual(binding); reads();
    forgetAllVenueReadTurns();
    // other-dm has no human-thread row: threadHumanPrincipal would answer OWNER, the paired check never does
    expect(pairedOwnerBinding("other-dm", binding, database())).toBeNull();
    expect(pairedVenueReadMounts({ ...mountInput(), threadId: "other-dm" } as Parameters<typeof pairedVenueReadMounts>[0], binding, database())).toBeNull();
    recordVenueReadTurn(claim.generation, { botId: "dax", threadId: "other-dm", origin: "paired", paired: binding });
    runs.set("other-dm", binding);
    expect(serveVenueRead(database(), { ...claim, threadId: "other-dm" }, { venueId: "venue" })).toEqual({ status: 403, body: { error: L1 } });
  });

  it("T58b WhatsApp, a different run principal, no run, and every non-channel shape stay closed", () => {
    const binding = pair();
    expect(mount()).toEqual(binding); reads(); forgetAllVenueReadTurns();
    for (const extra of [{ automationSource: undefined }, { automationSource: "webhook" }, { origin: "desktop" }, { origin: "companion" }, { origin: "unproven" }, { surfacesForOwner: false },
      { directOwnerAudience: false }, { notOwnerAudience: true }, { chainNotOwner: true }, { chainRootThreadId: "root" }, { projectCardRun: {} },
      { sharedWorkRun: {} }, { agentsMcp: false }, { bot: { threadId: "foreign" } },
      { bot: { threadId: "direct", tasks: [{ threadId: "dm", channelProjectDesk: {} }] } },
      { bot: { threadId: "direct", tasks: [{ threadId: "dm", sharedWork: {} }] } }, { cardContinuation: {} }, { askerWake: {} }]) expect(mount(extra)).toBeNull();
    runs.set("dm", { bindingId: binding.bindingId, revision: binding.revision + 1 }); expect(mount()).toBeNull();
    runs.delete("dm"); expect(mount()).toBeNull();
    // a record whose run is gone is refused at the read
    runs.set("dm", binding); expect(mount()).toEqual(binding); runs.delete("dm"); refused();
  });

  it("T58b a WhatsApp owner binding is not a paired DM", () => {
    pair("whatsapp");
    expect(mount()).toBeNull();
  });

  it("T58c the binding disconnected mid-turn: the next read is refused", () => {
    pair(); expect(mount()).not.toBeNull(); reads();
    revokeHumanConnection("telegram", "conn");
    refused();
  });

  it("T58c the binding unlinked mid-turn: the next read is refused", () => {
    const binding = pair(); expect(mount()).not.toBeNull(); reads();
    linkHumanBinding(ownerMemoryTicket(), { bindingId: binding.bindingId, expectedRevision: binding.revision, as: "unlink" });
    refused();
  });

  it("T58d venue_post is never listed on a paired turn", () => {
    pair(); expect(mount()).not.toBeNull();
    const message = { id: "m1", role: "user", kind: "text", text: "post this", postTo: { groupId: "venue" } } as unknown as Message;
    expect(venuePostMounts({ ...mountInput(), botId: "dax", message } as unknown as Parameters<typeof venuePostMounts>[0])).toBeNull();
  });

  it("T58e runTurn: the paired mount is decided after the phone skill and before phoneJobs, and gates both", () => {
    const code = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const phone = code.indexOf("integrations.phone = phoneIntegration();");
    const paired = code.indexOf("const pairedVenue = integrations.phone ? null : pairedVenueReadMounts({");
    const jobs = code.indexOf("if (!pairedVenue && instance.adapter.capabilities.agentsMcp === true && driverMountsPhoneJobs(instance.driverKind)) {");
    const record = code.indexOf('else if (pairedVenue) recordVenueReadTurn(dispatchClaimId, { botId: bot.id, threadId, origin: "paired", paired: pairedVenue });');
    expect(phone).toBeGreaterThan(0); expect(paired).toBeGreaterThan(phone); expect(jobs).toBeGreaterThan(paired); expect(record).toBeGreaterThan(jobs);
    expect(code.indexOf("integrations.phoneJobs = phoneJobsMount", paired)).toBeGreaterThan(jobs);
    expect(code).toContain("pairedRun: threadId => pairedChannelRun(threadId),");
    // MAIN RULING INT-CONFLICT-DEFAULT 04f61b4b858 06dc4742a0:
    // the indexed Store is the share reader's producer; keep the paired gate
    // and prove its short circuit against the actual executable expression.
    const gate = /(!pairedVenue && Boolean\(shareMounts\(database\(\), store, bot.id, threadId\)\)), phoneVerdict.mounted\);/.exec(code);
    expect(gate).not.toBeNull();
    const allowsShare = new Function("pairedVenue", "shareMounts", "database", "store", "bot", "threadId", `return ${gate![1]};`);
    for (const paired of [false, true]) for (const shared of [false, true]) {
      let reads = 0;
      const indexedStore = {}, db = {}, bot = { id: "fixture-bot" };
      const result = allowsShare(paired, (actualDb: object, actualStore: object, botId: string, threadId: string) => {
        reads++; expect(actualDb).toBe(db); expect(actualStore).toBe(indexedStore);
        expect(botId).toBe(bot.id); expect(threadId).toBe("fixture-thread"); return shared;
      }, () => db, indexedStore, bot, "fixture-thread");
      expect(result).toBe(!paired && shared); expect(reads).toBe(paired ? 0 : 1);
    }
  });

  it.each([
    "missing thread", "null thread", "missing binding id", "local owner", "foreign binding id",
    "missing person", "fractional revision", "missing binding", "null binding", "inactive",
    "another person", "new revision", "unsupported platform", "missing origin",
  ])("T58g %s fails closed after a successful read", change => {
    const paired = pair(); expect(mount()).toEqual(paired); reads();
    const db = database();
    const threadId = "human-thread:dm";
    const set = (id: string, key: string, value: string | number | null) => db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,?,?) WHERE id=?").run("$." + key, value, id);
    if (change === "missing thread") db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(threadId);
    if (change === "null thread") db.prepare("UPDATE memory_scope_bindings SET intent='null' WHERE id=?").run(threadId);
    if (change === "missing binding id") set(threadId, "bindingId", null);
    if (change === "local owner") set(threadId, "bindingId", "local");
    if (change === "foreign binding id") set(threadId, "bindingId", "foreign");
    if (change === "missing person") set(threadId, "personId", null);
    if (change === "fractional revision") set(threadId, "revision", paired.revision + 0.5);
    if (change === "missing binding") db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(paired.bindingId);
    if (change === "null binding") db.prepare("UPDATE memory_scope_bindings SET intent='null' WHERE id=?").run(paired.bindingId);
    if (change === "inactive") set(paired.bindingId, "active", 0);
    if (change === "another person") set(paired.bindingId, "personId", "another-person");
    if (change === "new revision") set(paired.bindingId, "revision", paired.revision + 1);
    if (change === "unsupported platform") set(paired.bindingId, "origin.platform", "whatsapp");
    if (change === "missing origin") set(paired.bindingId, "origin", null);
    expect(pairedOwnerBinding("dm", paired, db)).toBeNull();
    expect(mount()).toBeNull(); refused();
  });

  it.each(["human-thread:dm", "binding"])("T58g malformed %s or unavailable binding storage refuses", row => {
    const paired = pair(); expect(mount()).toEqual(paired); reads();
    const db = new DatabaseSync(":memory:");
    try {
      // A damaged legacy row bypasses the current schema's json_valid constraint.
      db.exec("CREATE TABLE memory_scope_bindings(id TEXT, subject_type TEXT, intent TEXT)");
      for (const value of database().prepare("SELECT id,subject_type,intent FROM memory_scope_bindings WHERE subject_type IN ('human-thread','human-binding')").all())
        db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?)").run(String(value.id), String(value.subject_type), String(value.intent));
      expect(pairedOwnerBinding("dm", paired, db)).toEqual(paired);
      db.prepare("UPDATE memory_scope_bindings SET intent='{' WHERE id=?").run(row === "binding" ? paired.bindingId : row);
      expect(pairedOwnerBinding("dm", paired, db)).toBeNull();
      expect(serveVenueRead(db, claim, { venueId: "venue" })).toEqual({ status: 403, body: { error: L1 } });
      db.exec("DROP TABLE memory_scope_bindings");
      expect(pairedOwnerBinding("dm", paired, db)).toBeNull();
      expect(serveVenueRead(db, claim, { venueId: "venue" })).toEqual({ status: 403, body: { error: L1 } });
    } finally { db.close(); }
  });

  it.each(["no callback", "no live state", "wrong run binding", "wrong run revision", "missing proof", "chain", "no owner surface", "not owner", "no record", "other bot", "room thread", "project desk", "shared work"])(
    "T58h %s cannot reuse a paired read", change => {
      const paired = pair(); expect(mount()).toEqual(paired); reads();
      if (change === "no callback") setVenueReadLive({ ownerSurface: () => true, notOwnerAudience: () => false, roster: () => roster });
      if (change === "no live state") setVenueReadLive(null);
      if (change === "wrong run binding") runs.set("dm", { ...paired, bindingId: "human-binding:other" });
      if (change === "wrong run revision") runs.set("dm", { ...paired, revision: paired.revision + 1 });
      if (change === "missing proof") delete venueReadTurns.get(claim.generation)!.paired;
      if (change === "chain") venueReadTurns.get(claim.generation)!.rootThreadId = "direct";
      if (change === "no owner surface" || change === "not owner") setVenueReadLive({
        ownerSurface: () => change === "no owner surface" ? undefined : true,
        notOwnerAudience: () => change === "not owner", roster: () => roster, pairedRun: id => runs.get(id) ?? null,
      });
      if (change === "no record") forgetAllVenueReadTurns();
      if (change === "other bot") roster.bots[1]!.tasks = [{ threadId: "dm" }] as BotRecord["tasks"];
      if (change === "room thread") roster.groups[0]!.tasks = [{ threadId: "dm" }] as GroupRecord["tasks"];
      if (change === "project desk") roster.bots[0]!.tasks![0]!.channelProjectDesk = { groupId: "venue" };
      if (change === "shared work") roster.bots[0]!.tasks![0]!.sharedWork = {} as NonNullable<BotRecord["tasks"]>[number]["sharedWork"];
      refused();
    });

  it("T58h a new binding or revision never replaces a generation's frozen proof", () => {
    const paired = pair(); expect(mount()).toEqual(paired); reads();
    runs.set("dm", { ...paired, bindingId: "human-binding:other" }); expect(mount()).toBeNull();
    runs.set("dm", paired);
    linkHumanBinding(ownerMemoryTicket(), { bindingId: paired.bindingId, expectedRevision: paired.revision, as: "unlink" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId: paired.bindingId, expectedRevision: paired.revision + 1, as: "owner" });
    const current = resolveHumanBinding(paired.bindingId);
    expect(() => bindHumanThread("dm", current)).toThrow("HUMAN_THREAD_IMMUTABLE");
    runs.set("dm", current);
    refused(); // relinking cannot revive the old thread or generation
    expect(mount()).toBeNull();
  });

  it.each(["not a member", "archived", "pair room", "memory off", "another person", "unknown audience", "isolated"])(
    "T58i a paired DM cannot read a room with %s", change => {
      pair(); expect(mount()).not.toBeNull(); reads();
      if (change === "not a member") roster.groups[0]!.memberIds = ["finch"];
      if (change === "archived") roster.groups[0]!.hidden = true;
      if (change === "pair room") roster.groups[0]!.dm = true;
      if (change === "memory off") database().prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)")
        .run(ensureScope("conversation", "direct"), JSON.stringify({ excludedThreadIds: ["room"] }));
      if (change === "another person" || change === "unknown audience") {
        roster.groups[0]!.tasks = [{ threadId: "room-task" }] as GroupRecord["tasks"];
        pair("slack", "person", "room-task");
        if (change === "unknown audience") database().prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.personId',NULL) WHERE id='human-thread:room-task'").run();
      }
      if (change === "isolated") {
        const isolated = { ...roster.bots[0]!, partitionedAt: NOW, threadId: "different", tasks: [] };
        setExecutionStore({ ...roster, bot: () => isolated } as unknown as Store);
      }
      expect(read()).toEqual({ status: 403, body: { error: L2 } });
    });

  it("T58i the paired exception keeps the six-attempt budget and refuses foreign targets", () => {
    pair(); expect(mount()).not.toBeNull(); reads();
    expect(serveVenueRead(database(), claim, { venueId: "venue", venueThreadId: "direct" })).toEqual({ status: 403, body: { error: L2 } });
    for (let i = 0; i < 4; i++) reads();
    expect(read()).toEqual({ status: 403, body: { error: L3 } });
  });

  it("T58f admission is DM-only on all three platforms, so the owner principal never carries group or channel traffic", () => {
    // Slack: a valid owner DM parses; the same event from a channel, or a non-D channel id, does not
    const slackIdentity = { teamId: "T1", appId: "A1", botUserId: "UBOT", botId: "B1", ownerUserId: "UOWNER" };
    const slack = (event: Record<string, unknown> = {}) => normalizeSlackMessage({ type: "events_api", body: { type: "event_callback", team_id: "T1", api_app_id: "A1",
      event_id: "Ev1", event_time: 1, authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
      event: { type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "hi", ...event } } }, slackIdentity);
    expect(slack()).toMatchObject({ dmId: "D1" });
    expect(slack({ channel_type: "channel", channel: "C1" })).toBeNull();
    expect(slack({ channel_type: "group" })).toBeNull();
    expect(slack({ channel_type: "mpim" })).toBeNull();
    expect(slack({ channel: "C1" })).toBeNull();
    // Discord: a valid owner DM parses; a guild channel or a non-DM channel type does not
    const discordIdentity = { applicationId: "100000000000000001", botUserId: "100000000000000002", ownerUserId: "100000000000000003" };
    const discord = (patch: Record<string, unknown> = {}) => normalizeDiscordMessage({ applicationId: "100000000000000001", botUserId: "100000000000000002",
      id: "100000000000000005", dmId: "100000000000000004", channelType: 1, authorId: "100000000000000003", authorBot: false, guildId: null, webhookId: null,
      type: 0, content: "hi", occurredAt: 1, attachments: 0, components: 0, forwarded: false, ...patch }, discordIdentity);
    expect(discord()).toMatchObject({ dmId: "100000000000000004" });
    expect(discord({ channelType: 0, guildId: "100000000000000009" })).toBeNull();
    expect(discord({ channelType: 0 })).toBeNull();
    expect(discord({ guildId: "100000000000000009" })).toBeNull();
    expect(discord({ channelType: 3 })).toBeNull();
    // the service-level checks: Telegram admits only an unforwarded private chat and then only the bound sender AND chat; Slack and Discord
    // drop any DM other than the bound one
    const telegram = readFileSync(new URL("./telegram-channel.ts", import.meta.url), "utf8");
    expect(telegram).toContain('const message = update.kind === "message" && update.chatType === "private" && !update.forwarded ? update : null;');
    expect(telegram).toContain("this.state.binding?.senderId === message.senderId && this.state.binding.chatId === message.chatId");
    expect(readFileSync(new URL("./channels/slack/service.ts", import.meta.url), "utf8")).toContain("} else if (message.dmId !== c.binding.dmId) { await ack(); return; }");
    expect(readFileSync(new URL("./channels/discord/service.ts", import.meta.url), "utf8")).toContain("} else if (message.dmId !== c.binding.dmId) { return; }");
  });
});
