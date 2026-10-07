import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSendError, type ChannelRuns } from "../durable-delivery.ts";
import type { GroupsPolicy } from "./core/access.ts";
import type { InboundEnvelope } from "./core/protocol.ts";
import { WhatsAppService, chatKeyOf, type ChatContext, type TransportContext, type WhatsAppSettings } from "./service.ts";
import type { HealthEvent, LinkEvent, StatusNote, TransportHandlers, WhatsAppTransport } from "./transport.ts";

const T = 1_700_000_000_000;
const OWNER = "15550001111@s.whatsapp.net";
const OWNER_LID = "99887766@lid";
const BOB = "15550002222@s.whatsapp.net";
const CAROL = "15550003333@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const KEY = "ef".repeat(32);
const roots: string[] = [], services: WhatsAppService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.stop().catch(() => undefined); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const noGroups: GroupsPolicy = { policy: "disabled", allow: [], senders: "members" };

interface World {
  dir: string; now: number; chief: boolean;
  settings: WhatsAppSettings;
  handlers?: TransportHandlers; linkListener?: (e: LinkEvent) => void;
  results: Map<string, { status: string; output?: string }>;
  contexts: ChatContext[]; enqueued: Array<{ chat: string; deliveryId: string; prompt: string }>;
}
function world(dir?: string): World {
  const d = dir ?? mkdtempSync(join(tmpdir(), "murage-wa-service-"));
  if (!dir) roots.push(d);
  return { dir: d, now: T, chief: true, settings: { mode: "self-chat", allowFrom: [], groups: noGroups, readReceipts: false, quoteReplies: "off" },
    results: new Map(), contexts: [], enqueued: [] };
}

function build(w: World, over: { people?: Partial<ReturnType<typeof peopleMock>>; receipts?: Map<string, { id: string }> } = {}) {
  let n = 0, rand = 0;
  const reserve = vi.fn(async (_i: { chatId: string; text: string }) => ({ ids: [`WA${++n}`] }));
  const sendText = vi.fn(async (i: { chatId: string; text: string; ids: string[] }) => ({ ids: i.ids }));
  const transportStop = vi.fn(async () => {}), unlink = vi.fn(async () => {}), link = vi.fn(async () => {}), markRead = vi.fn();
  const transport: WhatsAppTransport = {
    capabilities: { linking: "qr-or-code", groups: true, presence: true, readReceipts: true, lidResolution: true, ownSendEcho: true },
    start: async h => { w.handlers = h;
      const dir = join(w.dir, "whatsapp", "outbound"), file = join(dir, `${connectionId(w)}.json`);
      mkdirSync(dir, { recursive: true }); if (!existsSync(file)) writeFileSync(file, JSON.stringify({ records: [] }));
    }, onLink: l => { w.linkListener = l; }, link, stop: transportStop, unlink, revoke: vi.fn(),
    self: () => ({ pn: OWNER }), resolve: { pnForLid: async () => undefined, lidForPn: async () => undefined },
    reserve, sendText: sendText as WhatsAppTransport["sendText"], markRead,
  };
  const factory = vi.fn((_context: TransportContext) => transport);
  const people = { ...peopleMock(), ...over.people };
  const wipeData = vi.fn(async () => {});
  const revokeRuns = vi.fn(async () => {});
  const addAllowFrom = vi.fn((entry: string) => { w.settings = { ...w.settings, allowFrom: [...w.settings.allowFrom, entry] }; });
  const service = new WhatsAppService({
    dataDir: w.dir, chosen: { chiefBotId: "chief" }, settings: () => w.settings, transport: factory, authKey: { get: async () => KEY },
    isCurrentChief: () => w.chief, now: () => w.now, random: () => (rand = (rand + 1) % 31), people, wipeData, revokeRuns, addAllowFrom,
    runs: (ctx): ChannelRuns => {
      w.contexts.push(ctx);
      return {
        enqueue: ({ deliveryId, prompt }) => {
          const retained = over.receipts?.get(`${ctx.chatKey}:${deliveryId}`);
          if (retained) return retained;
          w.enqueued.push({ chat: ctx.chatJid, deliveryId, prompt }); return { id: "run:" + deliveryId };
        },
        result: id => w.results.get(id) ?? { status: "completed", output: "answer to " + ctx.chatJid },
      };
    },
  });
  services.push(service);
  const health = (e: HealthEvent) => { w.handlers!.onHealth(e); };
  const note = (n: StatusNote) => w.handlers!.onNote?.(n);
  const connect = async (self = { pn: OWNER, lid: OWNER_LID }) => { await service.link({ method: "qr" }); health({ state: "connected", self }); await flush(); };
  const deliver = async (e: Partial<InboundEnvelope> & { messageId: string }, ack = vi.fn(async () => {})) => {
    w.handlers!.onEnvelope({ chatJid: BOB, fromMe: false, timestampMs: w.now, upsertType: "notify", mentionedJids: [], text: "hello", ...e } as InboundEnvelope, ack);
    await flush(); return ack;
  };
  const toSelf = (messageId: string, text = "hi me") => deliver({ messageId, chatJid: OWNER, fromMe: true, upsertType: "append", text });
  return { service, transport, factory, reserve, sendText, unlink, link, markRead, transportStop, people, wipeData, revokeRuns, addAllowFrom, health, note, connect, deliver, toSelf };
}
function peopleMock() {
  return {
    linkOwner: vi.fn(async () => {}),
    linkContact: vi.fn(async (i: { userId: string }) => ({ personId: "person-" + i.userId })),
    observe: vi.fn(),
    enableGroup: vi.fn(),
  };
}
const read = (w: World, ...parts: string[]) => readFileSync(join(w.dir, "channels", "whatsapp", ...parts), "utf8");
const connectionId = (w: World) => JSON.parse(read(w, "connection.json")).connectionId as string;

it.each([false, true])("dedupes owner aliases without bridge history, LID first %s", async lidFirst => {
  const w = world(), f = build(w); await f.connect();
  await f.deliver({ messageId: "OWNER-ALIAS", chatJid: lidFirst ? OWNER_LID : OWNER, fromMe: true });
  await f.service.stop(); await f.service.resume();
  await f.deliver({ messageId: "OWNER-ALIAS", chatJid: lidFirst ? OWNER : OWNER_LID, fromMe: true });
  expect(w.enqueued).toHaveLength(1);
  const chats = JSON.parse(read(w, connectionId(w), "chats.json")).chats;
  expect(Object.keys(chats)).toEqual([chatKeyOf(OWNER)]);
  expect(chats[chatKeyOf(OWNER)].aliases).toEqual(expect.arrayContaining([OWNER, OWNER_LID]));
});

it.each(["self", "dm"])("consolidates split %s receipts on load and preserves pending work across repeated loads", async kind => {
  const w = world(), receipts = new Map<string, { id: string }>(), f = build(w, { receipts }); await f.connect(); await f.service.stop();
  const pn = kind === "self" ? OWNER : BOB, lid = kind === "self" ? OWNER_LID : "222@lid";
  if (kind === "dm") { w.settings.mode = "contacts"; w.settings.allowFrom = [pn]; }
  const c = connectionId(w), dir = join(w.dir, "channels/whatsapp", c);
  receipts.set(`${chatKeyOf(lid)}:${lid}:PENDING-LID`, { id: "retained-lid-run" });
  mkdirSync(dir, { recursive: true });
  const chats = Object.fromEntries([pn, lid].map(jid => [chatKeyOf(jid), { jid, kind, userId: pn,
    conversationKey: `${kind === "self" ? "self" : "dm"}:${pn}`, state: "active", ...(kind === "dm" ? { pn } : {}) }]));
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  for (const jid of [pn, lid]) {
    const records = [{ deliveryId: `${jid}:PENDING-${jid === pn ? "PN" : "LID"}`, prompt: "pending", occurredAt: T, attempts: 0, state: "accepted" },
      { deliveryId: `${jid}:DUPLICATE`, prompt: "duplicate", occurredAt: T, attempts: 0, state: "accepted" }];
    writeFileSync(join(dir, `${chatKeyOf(jid)}.json`), JSON.stringify({ version: 1,
      bindingKey: createHash("sha256").update(JSON.stringify({ c, j: jid })).digest("hex"), recipient: jid, records,
      tombstones: [{ deliveryId: `${jid}:DONE-${jid === pn ? "PN" : "LID"}`, occurredAt: T }] }));
  }
  await f.service.resume();
  expect(Object.keys(JSON.parse(read(w, c, "chats.json")).chats)).toEqual([chatKeyOf(pn)]);
  const merged = read(w, c, `${chatKeyOf(pn)}.json`);
  expect(JSON.parse(merged).records).toHaveLength(4);
  expect(JSON.parse(merged).tombstones).toHaveLength(2);
  // Replay a crash after the merged ledger was written but before the chat list.
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  await f.service.stop(); await f.service.resume();
  expect(read(w, c, `${chatKeyOf(pn)}.json`)).toBe(merged);
  for (const messageId of ["DONE-PN", "DONE-LID", "DUPLICATE"]) {
    await f.deliver({ messageId, chatJid: lid, fromMe: kind === "self" });
  }
  await f.service.tick();
  expect(w.enqueued.map(row => row.deliveryId)).toEqual([`${pn}:PENDING-PN`]);
  expect(JSON.parse(read(w, c, `${chatKeyOf(pn)}.json`)).records).toContainEqual(expect.objectContaining({ deliveryId: `${lid}:PENDING-LID`, runId: "retained-lid-run", state: "sent" }));
  await f.deliver({ messageId: "NEXT", chatJid: pn, fromMe: kind === "self" });
  await f.deliver({ messageId: "PENDING-LID", chatJid: pn, fromMe: kind === "self" });
  expect(w.enqueued).toHaveLength(2);
});

it.each([false, true])("resumes two 6000-tombstone ledgers with pending receipts, overlapping %s", async overlapping => {
  const w = world(), f = build(w); await f.connect(); await f.service.stop();
  const c = connectionId(w), dir = join(w.dir, "channels/whatsapp", c);
  mkdirSync(dir, { recursive: true });
  const chats = Object.fromEntries([OWNER, OWNER_LID].map(jid => [chatKeyOf(jid), {
    jid, kind: "self", userId: OWNER, conversationKey: `self:${OWNER}`, state: "active",
  }]));
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  for (const [index, jid] of [OWNER, OWNER_LID].entries()) {
    writeFileSync(join(dir, `${chatKeyOf(jid)}.json`), JSON.stringify({ version: 1,
      bindingKey: createHash("sha256").update(JSON.stringify({ c, j: jid })).digest("hex"), recipient: jid,
      records: [{ deliveryId: `${jid}:PENDING-${index}`, prompt: "pending", occurredAt: T, attempts: 0, state: "accepted" }],
      tombstones: Array.from({ length: 6000 }, (_, i) => ({ deliveryId: `${jid}:DONE-${i + (overlapping ? 0 : index * 6000)}`,
        occurredAt: i < 10 ? T - 8 * 86400000 : T - index })),
    }));
  }
  const mergedRows = () => {
    const file = join(dir, `${chatKeyOf(OWNER)}.json`), root = JSON.parse(readFileSync(file, "utf8"));
    return [root, ...(root.overflow ?? []).map((part: string) => JSON.parse(readFileSync(`${file}.${part}`, "utf8")))];
  };
  await f.service.resume();
  expect(f.service.status()).toMatchObject({ enabled: true, error: null, pending: 2 });
  const stones = mergedRows().flatMap(page => page.tombstones);
  expect(stones).toHaveLength(overlapping ? 5990 : 11980);
  expect(new Set(stones.map(row => row.dedupeId)).size).toBe(stones.length);
  expect(stones.every(row => row.occurredAt >= T - 7 * 86400000)).toBe(true);
  // Retry the migration after only the ledger commit survived a crash.
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  await f.service.stop(); await f.service.resume(); await f.service.tick();
  expect(f.service.status()).toMatchObject({ enabled: true, error: null, pending: 0 });
  expect(w.enqueued.map(row => row.deliveryId).sort()).toEqual([`${OWNER}:PENDING-0`, `${OWNER_LID}:PENDING-1`].sort());
  expect(mergedRows().flatMap(page => page.records).every(row => row.state === "sent")).toBe(true);
  await f.service.stop(); await f.service.resume(); await f.service.tick();
  expect(w.enqueued).toHaveLength(2);
  await f.toSelf("DONE-100");
  expect(w.enqueued).toHaveLength(2);
});

it.each(["approve", "dismiss"] as const)("%s works on a migrated LID pairing, including interrupted migration", async action => {
  const w = world(); w.settings.mode = "contacts";
  const f = build(w); await f.connect(); await f.service.stop();
  const c = connectionId(w), dir = join(w.dir, "channels/whatsapp", c), lid = "222@lid", code = "ABC234";
  mkdirSync(dir, { recursive: true });
  const chats = { [chatKeyOf(lid)]: { jid: lid, kind: "dm", userId: BOB, conversationKey: `dm:${BOB}`, state: "pairing" } };
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  const connection = JSON.parse(read(w, "connection.json"));
  connection.pairing = [{ hash: createHash("sha256").update(code).digest("hex"), expiresAt: T + 3600000, createdAt: T,
    chatKey: chatKeyOf(lid), userId: BOB, senderJid: BOB }];
  writeFileSync(join(w.dir, "channels/whatsapp/connection.json"), JSON.stringify(connection));
  writeFileSync(join(dir, `${chatKeyOf(lid)}.json`), JSON.stringify({ version: 1,
    bindingKey: createHash("sha256").update(JSON.stringify({ c, j: lid })).digest("hex"), recipient: lid,
    records: [{ deliveryId: `${lid}:PAIR`, prompt: "", response: `Pairing code ${code}`, occurredAt: T, attempts: 1, state: "queued", retryAt: T + 5000 }], tombstones: [],
  }));
  await f.service.resume();
  expect(JSON.parse(read(w, c, "chats.json")).chats[chatKeyOf(BOB)]).toMatchObject({ state: "pairing" });
  // Recover both cross-file states: new references with old chats, then old references with new chats.
  await f.service.stop();
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ version: 1, chats }));
  await f.service.resume(); await f.service.stop();
  writeFileSync(join(w.dir, "channels/whatsapp/connection.json"), JSON.stringify(connection));
  await f.service.resume();
  await f.service[action](code);
  expect(JSON.parse(read(w, c, "chats.json")).chats[chatKeyOf(BOB)].state).toBe(action === "approve" ? "active" : "dismissed");
  expect(f.service.status().pairing).toHaveLength(0);
  w.now += 6000; await f.service.tick();
  if (action === "approve") {
    await f.deliver({ messageId: "APPROVED", chatJid: BOB });
    expect(w.enqueued).toHaveLength(1);
    expect(w.contexts.at(-1)).toMatchObject({ role: "contact", chatKey: chatKeyOf(BOB) });
  } else {
    expect(f.sendText).not.toHaveBeenCalled();
    expect(JSON.parse(read(w, c, `${chatKeyOf(BOB)}.json`)).records[0].state).toBe("cancelled");
    await f.service.stop(); await f.service.resume(); await f.service.tick();
    expect(f.sendText).not.toHaveBeenCalled();
  }
});

it("retains a transport after shutdown failure and blocks replacement and unlink deletion", async () => {
  const w = world(), f = build(w); await f.connect();
  f.transportStop.mockRejectedValue(new Error("exit not confirmed"));
  w.settings.readReceipts = true;
  await expect(f.service.applySettings()).rejects.toThrow("exit not confirmed");
  await f.service.resume();
  expect(f.factory).toHaveBeenCalledTimes(1);
  await expect(f.service.unlink()).rejects.toThrow();
  expect(f.wipeData).not.toHaveBeenCalled();
  expect(JSON.parse(read(w, "connection.json")).binding).not.toBeNull();
  f.transportStop.mockResolvedValue();
  await f.service.unlink();
  expect(f.wipeData).toHaveBeenCalledTimes(1);
});

it("links with a QR that exists only while linking, then binds the linked number as the only owner", async () => {
  const w = world(), f = build(w);
  await f.service.link({ method: "qr" });
  w.linkListener!({ kind: "qr", text: "2@secret-qr", version: 1, issuedAt: T });
  expect(f.service.status()).toMatchObject({ state: "linking", linked: false, qr: { text: "2@secret-qr" } });
  f.health({ state: "connected", self: { pn: OWNER, lid: OWNER_LID } }); await flush();
  const status = f.service.status();
  expect(status).toMatchObject({ state: "connected", linked: true }); expect(status).not.toHaveProperty("qr");
  expect(read(w, "connection.json")).not.toContain("secret-qr");
  expect(JSON.parse(read(w, "connection.json")).binding).toMatchObject({ linkedPn: OWNER, linkedLid: OWNER_LID, chiefBotId: "chief" });
  expect(f.people.linkOwner).toHaveBeenCalledWith(expect.objectContaining({ linkedPn: OWNER }));
  expect(f.service.ownerRecipients()).toEqual([OWNER, OWNER_LID]);
  expect(f.link).toHaveBeenCalledWith({ method: "qr" });
});
it("shows a pairing code for 60 seconds and validates the phone number", async () => {
  const w = world(), f = build(w);
  await expect(f.service.link({ method: "code", phone: "123" })).rejects.toThrow("country code");
  await f.service.link({ method: "code", phone: "+1 (555) 000-1111" });
  expect(f.link).toHaveBeenCalledWith({ method: "code", phone: "15550001111" });
  w.linkListener!({ kind: "pairing-code", code: "ABCD1234", phone: "15550001111" });
  expect(f.service.status()).toMatchObject({ pairingCode: { code: "ABCD1234" } });
  w.now += 61_000;
  expect(f.service.status()).not.toHaveProperty("pairingCode");
});
it("answers an owner self-chat message on the owner principal, writing the receipt before the ack", async () => {
  const w = world(), f = build(w); await f.connect();
  const ack = vi.fn(async () => {
    const id = connectionId(w), file = readdirSync(join(w.dir, "channels/whatsapp", id)).find(n => n !== "chats.json")!;
    expect(read(w, id, file)).toContain("SELF1");
    expect(w.enqueued).toHaveLength(0);
  });
  await f.deliver({ messageId: "SELF1", chatJid: OWNER, fromMe: true, upsertType: "append", text: "hi me" }, ack);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(w.contexts.at(-1)).toMatchObject({ role: "owner", principal: { kind: "owner-self" }, notOwnerAudience: false, conversationKey: `self:${OWNER}` });
  expect(w.enqueued[0].prompt).toMatch(/^\[UNTRUSTED WHATSAPP CHANNEL MESSAGE\]/);
  expect(f.reserve).toHaveBeenCalledWith({ chatId: OWNER, text: "answer to " + OWNER });
  expect(f.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: OWNER, ids: ["WA1"] }));
});
it("dedupes a redelivered message and a lost ack retains one run", async () => {
  const w = world(), f = build(w); await f.connect();
  const lost = vi.fn(async () => { throw new Error("lost ack"); });
  await f.toSelf("DUP", "same"); await f.deliver({ messageId: "DUP", chatJid: OWNER, fromMe: true, upsertType: "append", text: "same" }, lost);
  await f.service.tick();
  expect(w.enqueued).toHaveLength(1); expect(f.sendText).toHaveBeenCalledTimes(1);
});
it("in self-chat mode a stranger gets no reply and starts nothing", async () => {
  const w = world(), f = build(w); await f.connect();
  const ack = await f.deliver({ messageId: "S1" });
  expect(ack).toHaveBeenCalledTimes(1); expect(w.enqueued).toHaveLength(0); expect(f.sendText).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});
it("refuses approval-like chat text from the owner and never starts a task", async () => {
  const w = world(), f = build(w); await f.connect();
  await f.toSelf("A1", "/approve");
  expect(w.enqueued).toHaveLength(0);
  expect(f.reserve).toHaveBeenCalledWith({ chatId: OWNER, text: "Review approvals in Murage. WhatsApp messages cannot approve actions." });
});

it("contacts mode: one pairing reply with a hashed code, a cap of three pending, and expiry after an hour", async () => {
  const w = world(); w.settings.mode = "contacts";
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "P1", text: "hi", pushName: "Bob" });
  const reply = f.reserve.mock.calls[0][0].text;
  const code = /code ([A-Z2-9]{6})/.exec(reply)![1];
  expect(reply).toContain("Ask its owner to approve");
  expect(read(w, "connection.json")).not.toContain(code);
  expect(JSON.parse(read(w, "connection.json")).pairing[0].hash).toMatch(/^[a-f0-9]{64}$/);
  expect(w.enqueued).toHaveLength(0);
  await f.deliver({ messageId: "P2", text: "again?" });
  expect(f.reserve).toHaveBeenCalledTimes(1);
  await f.deliver({ messageId: "P3", chatJid: CAROL }); await f.deliver({ messageId: "P4", chatJid: "15550004444@s.whatsapp.net" });
  await f.deliver({ messageId: "P5", chatJid: "15550005555@s.whatsapp.net" });
  expect(f.reserve).toHaveBeenCalledTimes(3);
  expect(f.service.status().pairing).toHaveLength(3);
  expect(JSON.stringify(f.service.status())).not.toContain(code);
  w.now += 61 * 60_000;
  expect(f.service.status().pairing).toHaveLength(0);
  await f.deliver({ messageId: "P6", chatJid: "15550005555@s.whatsapp.net", timestampMs: w.now });
  expect(f.reserve).toHaveBeenCalledTimes(4);
});
it("approval links a NON-owner person, allows the number, and the contact then runs as that person with no owner audience", async () => {
  const w = world(); w.settings.mode = "contacts";
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "C1", pushName: "Bob" });
  const code = /code ([A-Z2-9]{6})/.exec(f.reserve.mock.calls[0][0].text)![1];
  await expect(f.service.approve("ZZZZZZ")).rejects.toThrow("not pending");
  const approved = await f.service.approve(code.toLowerCase(), { personId: "p-existing" });
  expect(approved).toMatchObject({ userId: BOB, name: "Bob" });
  expect(f.people.linkContact).toHaveBeenCalledWith(expect.objectContaining({ userId: BOB, senderJid: BOB, personId: "p-existing" }));
  expect(f.people.linkContact.mock.calls[0][0]).not.toHaveProperty("as");
  expect(f.addAllowFrom).toHaveBeenCalledWith("15550002222");
  await expect(f.service.approve(code)).rejects.toThrow("not pending");
  f.sendText.mockClear(); f.reserve.mockClear();
  await f.deliver({ messageId: "C2", text: "now do a thing" });
  expect(w.contexts.at(-1)).toMatchObject({ role: "contact", principal: { kind: "sender", userId: BOB }, notOwnerAudience: true, conversationKey: `dm:${BOB}` });
  expect(w.enqueued).toHaveLength(1);
  expect(f.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: BOB }));
});
it("keeps the request when the person cannot be linked, so a failed approval allows nothing", async () => {
  const w = world(); w.settings.mode = "contacts";
  const f = build(w, { people: { linkContact: vi.fn(async () => { throw new Error("HUMAN_BINDING_REVOKED"); }) } }); await f.connect();
  await f.deliver({ messageId: "F1" });
  const code = /code ([A-Z2-9]{6})/.exec(f.reserve.mock.calls[0][0].text)![1];
  await expect(f.service.approve(code)).rejects.toThrow();
  expect(f.addAllowFrom).not.toHaveBeenCalled(); expect(f.service.status().pairing).toHaveLength(1);
  await f.service.dismiss(code);
  expect(f.service.status().pairing).toHaveLength(0);
  await f.deliver({ messageId: "F2" });
  expect(w.enqueued).toHaveLength(0);
});
it("a pairing chat can never start a task even if its ledger is asked to", async () => {
  const w = world(); w.settings.mode = "contacts";
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "N1" });
  // The run factory is never even asked for a pairing chat; its ledger gets a runs object that throws.
  expect(w.contexts).toHaveLength(0);
  expect(w.enqueued).toHaveLength(0);
  expect(f.reserve).toHaveBeenCalledTimes(1);
});

it("two DMs and the owner chat never exchange replies, across a restart", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = ["15550002222", "15550003333"];
  const f = build(w); await f.connect();
  w.results.set(`run:${BOB}:B1`, { status: "running" });
  await f.deliver({ messageId: "B1", text: "from bob" });
  await f.deliver({ messageId: "C1", chatJid: CAROL, text: "from carol" });
  await f.toSelf("O1", "from owner");
  const sentTo = f.sendText.mock.calls.map(c => [c[0].chatId, c[0].text]);
  expect(sentTo).toEqual(expect.arrayContaining([[CAROL, "answer to " + CAROL], [OWNER, "answer to " + OWNER]]));
  expect(sentTo.some(([chat]) => chat === BOB)).toBe(false);
  expect(readdirSync(join(w.dir, "channels/whatsapp", connectionId(w))).filter(n => n !== "chats.json")).toHaveLength(3);
  await f.service.stop();
  // Restart: a fresh service reopens the three ledgers from chats.json; only Bob's pending reply is outstanding.
  const g = build(w); await g.service.resume();
  w.results.delete(`run:${BOB}:B1`);
  g.sendText.mockClear();
  await g.service.tick();
  expect(g.sendText.mock.calls.map(c => c[0].chatId)).toEqual([BOB]);
  expect(g.sendText.mock.calls[0][0].text).toBe("answer to " + BOB);
  expect(w.enqueued.filter(e => e.deliveryId.includes("B1"))).toHaveLength(1);
});
it("a removed contact is revoked: queued runs are cancelled, nothing is sent, and the revision moves on", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = ["15550002222"];
  const f = build(w); await f.connect();
  w.results.set(`run:${BOB}:R1`, { status: "running" });
  await f.deliver({ messageId: "R1", text: "slow task" });
  const ctx = w.contexts.at(-1)!, binding = JSON.parse(read(w, "connection.json")).binding;
  expect(f.service.isCurrent(binding, ctx.accessRevision)).toBe(true);
  expect(ctx.allowed()).toBe(true);
  w.settings = { ...w.settings, allowFrom: [] };
  expect(ctx.allowed()).toBe(false); // live: no settings bump needed, so the run factory refuses an enqueue at once
  await f.service.applySettings();
  expect(f.revokeRuns).toHaveBeenCalledWith(binding.connectionId, [`run:${BOB}:R1`]);
  expect(f.service.isCurrent(binding, ctx.accessRevision)).toBe(false);
  expect(f.service.status().accessRevision).toBe(ctx.accessRevision + 1);
  w.results.set(`run:${BOB}:R1`, { status: "completed", output: "late answer" });
  await f.service.tick();
  expect(f.sendText).not.toHaveBeenCalled();
  await f.deliver({ messageId: "R2", text: "still there?" });
  expect(f.reserve).toHaveBeenCalledTimes(1); // a fresh pairing reply, not a task
  expect(w.enqueued).toHaveLength(1);
});
it("a ledger whose chat is no longer allowed refuses to send even before the owner's change is applied", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = ["15550002222"];
  const f = build(w); await f.connect();
  w.results.set(`run:${BOB}:L1`, { status: "running" });
  await f.deliver({ messageId: "L1" });
  w.results.set(`run:${BOB}:L1`, { status: "completed", output: "x" });
  w.settings = { ...w.settings, allowFrom: [] };
  await f.service.tick();
  expect(f.sendText).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});
it("a receipt that cannot be written is loud: no ack, no task, and an intact retry works", async () => {
  const w = world(); const f = build(w); await f.connect();
  await f.toSelf("W1");
  const id = connectionId(w), key = chatKeyOf(OWNER), path = join(w.dir, "channels/whatsapp", id, key + ".json");
  const original = readFileSync(path, "utf8");
  rmSync(path); mkdirSync(path);
  const ack = await f.deliver({ messageId: "W2", chatJid: OWNER, fromMe: true, upsertType: "append", text: "second" });
  expect(ack).not.toHaveBeenCalled(); expect(w.enqueued).toHaveLength(1);
  expect(f.service.status().error).toBe("ledger-write-failed");
  rmSync(path, { recursive: true }); writeFileSync(path, original);
  const retry = await f.deliver({ messageId: "W2", chatJid: OWNER, fromMe: true, upsertType: "append", text: "second" });
  expect(retry).toHaveBeenCalledTimes(1); expect(w.enqueued).toHaveLength(2);
});
it("offline catch-up: an append after lastSeenAt arrives once, an older history append is dropped", async () => {
  const w = world(); const f = build(w);
  await f.service.link({ method: "qr" });
  f.health({ state: "connected", self: { pn: OWNER, lid: OWNER_LID } }); await flush();
  await f.deliver({ messageId: "WATERMARK", chatJid: OWNER, fromMe: true, timestampMs: T - 3_600_000 });
  f.note({ kind: "admitted", at: T - 3_600_000 });
  await f.service.stop(); w.enqueued.length = 0; await f.service.resume();
  f.health({ state: "connected", self: { pn: OWNER, lid: OWNER_LID } }); await flush();
  await f.deliver({ messageId: "H1", chatJid: OWNER, fromMe: true, upsertType: "append", text: "old", timestampMs: T - 2 * 3_600_000 });
  expect(w.enqueued).toHaveLength(0);
  await f.deliver({ messageId: "H2", chatJid: OWNER, fromMe: true, upsertType: "append", text: "while closed", timestampMs: T - 1_800_000 });
  expect(w.enqueued).toHaveLength(1);
  expect(JSON.parse(read(w, "connection.json")).lastSeenAt).toBe(T - 3_600_000);
});
it("drops a message older than the seven day admission window without looping on it", async () => {
  const w = world(); const f = build(w); await f.connect();
  const ack = await f.deliver({ messageId: "OLD", chatJid: OWNER, fromMe: true, upsertType: "notify", text: "ancient", timestampMs: T - 8 * 86_400_000 });
  expect(ack).toHaveBeenCalledTimes(1); expect(w.enqueued).toHaveLength(0);
});
it("groups: an allowed group runs on its own guest principal with the not-owner flag, quoting the trigger; others are dropped", async () => {
  const w = world(); w.settings.groups = { policy: "allowlist", allow: [{ jid: GROUP, name: "Team", activation: "mention" }], senders: "members" };
  w.settings.quoteReplies = "groups";
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "G0", chatJid: GROUP, participant: BOB, text: "unaddressed chatter" });
  expect(w.enqueued).toHaveLength(0);
  await f.deliver({ messageId: "G1", chatJid: GROUP, participant: BOB, text: "@bot what is up", mentionedJids: [OWNER], pushName: "Bob" });
  expect(w.contexts.at(-1)).toMatchObject({ role: "group", principal: { kind: "group-guest", groupJid: GROUP }, notOwnerAudience: true, conversationKey: `group:${GROUP}`, chatJid: GROUP });
  expect(w.enqueued[0].prompt).toContain("Group: Team");
  expect(f.people.observe).toHaveBeenCalledWith(expect.objectContaining({ userId: BOB, groupJid: GROUP }));
  expect(f.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: GROUP, quote: expect.objectContaining({ id: "G1", text: "@bot what is up" }) }));
  await f.deliver({ messageId: "G2", chatJid: "120363999999999999@g.us", participant: BOB, text: "x", mentionedJids: [OWNER] });
  expect(w.enqueued).toHaveLength(1);
});
it("a reply quoting one of the bot's own messages activates a group turn (flag from the bridge journal)", async () => {
  const w = world(); w.settings.groups = { policy: "allowlist", allow: [{ jid: GROUP, activation: "mention" }], senders: "members" };
  const f = build(w); await f.connect();
  const dir = join(w.dir, "whatsapp", "outbound"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${connectionId(w)}.json`), JSON.stringify({ records: [{ id: "WA-bot-1", chats: [GROUP], state: "sent", at: T }] }));
  await f.deliver({ messageId: "Q1", chatJid: GROUP, participant: BOB, text: "and then?", quoted: { id: "WA-bot-1", participant: OWNER, outbound: true } });
  expect(w.enqueued).toHaveLength(1);
});
it("enabling a group creates its guest principal once; a disabled group is ignored and creates nothing", async () => {
  const w = world(); const f = build(w); await f.connect();
  await f.deliver({ messageId: "D1", chatJid: GROUP, participant: BOB, text: "hi", mentionedJids: [OWNER] });
  expect(w.enqueued).toHaveLength(0); expect(f.people.enableGroup).not.toHaveBeenCalled();
  w.settings.groups = { policy: "allowlist", allow: [{ jid: GROUP, name: "Team", activation: "mention" }], senders: "members" };
  await f.service.applySettings();
  expect(f.people.enableGroup).toHaveBeenCalledWith(expect.objectContaining({ groupJid: GROUP, name: "Team" }));
  await f.deliver({ messageId: "D2", chatJid: GROUP, participant: BOB, text: "hi", mentionedJids: [OWNER] });
  expect(w.enqueued).toHaveLength(1);
  w.settings.groups = { policy: "disabled", allow: [], senders: "members" };
  await f.service.applySettings();
  await f.deliver({ messageId: "D3", chatJid: GROUP, participant: BOB, text: "hi", mentionedJids: [OWNER] });
  expect(w.enqueued).toHaveLength(1);
});
it("the owner typing in an enabled group runs as a group turn, never as the owner", async () => {
  const w = world(); w.settings.groups = { policy: "allowlist", allow: [{ jid: GROUP, name: "Team", activation: "mention" }], senders: "members" };
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "O1", chatJid: GROUP, fromMe: true, upsertType: "append", text: "@bot summarise", mentionedJids: [OWNER] });
  expect(w.contexts.at(-1)).toMatchObject({ role: "group", notOwnerAudience: true, principal: { kind: "group-guest", groupJid: GROUP } });
  expect(w.enqueued).toHaveLength(1);
});
it("pauses and sends nothing when the Chief changes", async () => {
  const w = world(); const f = build(w); await f.connect();
  w.chief = false;
  await f.toSelf("X1");
  expect(w.enqueued).toHaveLength(0);
  expect(f.service.status()).toMatchObject({ state: "blocked", enabled: false, error: "chief-changed" });
  expect(f.revokeRuns).toHaveBeenCalled();
});
it("revoke cancels the ledgers, stops the transport and asks the host to revoke runs", async () => {
  const w = world(); const f = build(w); await f.connect();
  w.results.set(`run:${OWNER}:V1`, { status: "running" });
  await f.toSelf("V1");
  await f.service.revoke();
  expect(f.transportStop).toHaveBeenCalled(); expect(f.revokeRuns).toHaveBeenCalledWith(connectionId(w));
  w.results.set(`run:${OWNER}:V1`, { status: "completed", output: "late" });
  await f.service.tick();
  expect(f.sendText).not.toHaveBeenCalled();
  expect(JSON.parse(read(w, "connection.json"))).toMatchObject({ enabled: false, paused: true });
});
it("unlink logs out, wipes the bridge data, revokes runs and forgets the binding under a new connection id", async () => {
  const w = world(); const f = build(w); await f.connect();
  const before = connectionId(w);
  await f.service.unlink();
  expect(f.unlink).toHaveBeenCalled(); expect(f.wipeData).toHaveBeenCalledWith(before, "all"); expect(f.revokeRuns).toHaveBeenCalledWith(before);
  const saved = JSON.parse(read(w, "connection.json"));
  expect(saved).toMatchObject({ binding: null, enabled: false, pairing: [] }); expect(saved.connectionId).not.toBe(before);
  expect(f.service.status()).toMatchObject({ linked: false, state: "idle" });
  expect(f.service.ownerRecipients()).toEqual([]);
});
it("refuses to relink a live session, wipes a dead one first, and blocks a different phone", async () => {
  const w = world(); const f = build(w); await f.connect();
  await expect(f.service.link({ method: "qr" })).rejects.toThrow("Unlink it first");
  f.health({ state: "logged-out" }); await flush();
  expect(f.service.status()).toMatchObject({ state: "logged-out", error: "logged-out" });
  await f.service.link({ method: "qr" });
  expect(f.wipeData).toHaveBeenCalledWith(connectionId(w), "auth");
  f.health({ state: "connected", self: { pn: "15559998888@s.whatsapp.net" } }); await flush();
  expect(f.service.status()).toMatchObject({ state: "blocked", error: "identity-mismatch" });
  expect(f.service.isCurrent(JSON.parse(read(w, "connection.json")).binding)).toBe(false);
});
it("resume brings a saved connection back without linking, and a paused one stays paused", async () => {
  const w = world(); const f = build(w); await f.connect(); await f.service.stop();
  const g = build(w); await g.service.resume();
  expect(g.factory).toHaveBeenCalledTimes(1); expect(g.link).not.toHaveBeenCalled();
  expect(g.factory.mock.calls[0][0]).toMatchObject({ connectionId: connectionId(w), mode: "self-chat" });
  w.chief = false; await g.service.stop();
  const h = build(w); await h.service.resume();
  expect(h.factory).not.toHaveBeenCalled(); expect(h.service.status()).toMatchObject({ enabled: false, error: "chief-changed" });
});
it("blocks with the key reason when the credential store refuses, and passes a validated key to the bridge", async () => {
  const w = world(); const f = build(w);
  await f.service.link({ method: "qr" });
  const ctx = f.factory.mock.calls[0][0] as { getAuthKey: () => Promise<string> };
  expect(await ctx.getAuthKey()).toBe(KEY);
  const bad = new WhatsAppService({ dataDir: w.dir, chosen: { chiefBotId: "chief" }, settings: () => w.settings, authKey: { get: async () => "short" },
    transport: c => { void c.getAuthKey().catch(() => undefined); return f.transport; }, isCurrentChief: () => true, runs: () => ({ enqueue: () => ({ id: "x" }), result: () => null }),
    revokeRuns: async () => {}, people: peopleMock(), wipeData: async () => {}, addAllowFrom: () => {} });
  services.push(bad);
  await f.service.stop();
  await bad.link({ method: "qr" }); await flush();
  expect(bad.status()).toMatchObject({ state: "blocked", blockedReason: "credential-store" });
});
it("shows ingress write failures and truncated catch-up in status, never message text", async () => {
  const w = world(); const f = build(w); await f.connect();
  f.note({ kind: "ingress-write-failed", remoteJid: BOB, id: "I1" }); f.note({ kind: "catch-up-truncated" });
  const status = f.service.status();
  expect(status).toMatchObject({ ingressWriteFailed: true, catchUpTruncated: true, error: "ingress-write-failed" });
  expect(JSON.stringify(status)).not.toContain(BOB);
});
it("a mode change restarts the bridge, which reads its mode once", async () => {
  const w = world(); const f = build(w); await f.connect();
  w.settings = { ...w.settings, mode: "contacts" };
  await f.service.applySettings();
  expect(f.factory).toHaveBeenCalledTimes(2);
  expect(f.factory.mock.calls[1][0]).toMatchObject({ mode: "contacts" });
});
it("reads receipts only for approved contacts and only when enabled", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = ["15550002222"]; w.settings.readReceipts = true;
  const f = build(w); await f.connect();
  await f.deliver({ messageId: "RR1" });
  expect(f.markRead).toHaveBeenCalledWith([{ remoteJid: BOB, id: "RR1", fromMe: false }]);
  await f.toSelf("RR2");
  expect(f.markRead).toHaveBeenCalledTimes(1);
});

it("freezes the previous receipt watermark while admitting offline catch-up", async () => {
  const w = world(), first = build(w); await first.connect(); await first.toSelf("BEFORE"); first.note({ kind: "admitted", at: T }); await first.service.stop();
  w.now += 30 * 60_000;
  const second = build(w); await second.service.resume();
  second.health({ state: "connected", self: { pn: OWNER }, lastSeenAtMs: w.now }); await flush();
  await second.deliver({ messageId: "OFFLINE", chatJid: OWNER, fromMe: true, upsertType: "append", timestampMs: T + 120_000 });
  expect(w.enqueued.some(row => row.deliveryId.endsWith(":OFFLINE"))).toBe(true);
});

it("dedupes PN and LID deliveries across persisted chat aliases", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [BOB];
  const first = build(w); await first.connect();
  await first.deliver({ messageId: "ALIAS", chatJid: BOB });
  await first.deliver({ messageId: "ALIAS", chatJid: "123@lid", chatJidAlt: BOB });
  await first.service.stop(); const second = build(w); await second.service.resume();
  await second.deliver({ messageId: "ALIAS", chatJid: "123@lid" });
  expect(w.enqueued).toHaveLength(1);
  expect(new Set(w.contexts.map(c => c.chatKey)).size).toBe(1);
});

it("classifies owner echoes from the durable outbound ledger and preserves corrupt evidence", async () => {
  const w = world(), f = build(w); await f.connect();
  const dir = join(w.dir, "whatsapp", "outbound"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${connectionId(w)}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, records: [{ id: "BOT", chats: ["unknown@lid"], state: "reserved", at: T }] }));
  await f.toSelf("BOT"); expect(w.enqueued).toHaveLength(0);
  writeFileSync(path, '{'); const ack = await f.toSelf("HUMAN");
  expect(ack).not.toHaveBeenCalled(); expect(w.enqueued).toHaveLength(0); expect(readFileSync(path, "utf8")).toBe('{');
});

it("restarts with saved receipt and quoting options", async () => {
  const w = world(), f = build(w); await f.connect();
  w.settings.readReceipts = true; w.settings.quoteReplies = "all";
  await f.service.applySettings();
  expect(f.transportStop).toHaveBeenCalled();
  expect(f.factory.mock.calls.at(-1)![0].bridgeOptions).toMatchObject({ readReceipts: true, quoteReplies: "all" });
});

it("clears a pairing code from the receipt as soon as sending settles", async () => {
  const w = world(); w.settings.mode = "contacts"; const f = build(w); await f.connect();
  await f.deliver({ messageId: "PAIR" }); await f.service.tick();
  const code = /code ([A-Z2-9]{6})/.exec(f.reserve.mock.calls[0][0].text)![1];
  expect(read(w, connectionId(w), `${chatKeyOf(BOB)}.json`)).not.toContain(code);
});

it("blocks owner intake when outbound history disappears", async () => {
  const w = world(), f = build(w); await f.connect();
  rmSync(join(w.dir, "whatsapp", "outbound", `${connectionId(w)}.json`));
  const ack = await f.toSelf("MISSING-HISTORY");
  expect(ack).not.toHaveBeenCalled(); expect(w.enqueued).toHaveLength(0);
});

it("rejects a delivery when the stored audience role differs", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [OWNER];
  const f = build(w); await f.connect(); await f.toSelf("OWNER-FIRST");
  const ack = await f.deliver({ messageId: "CONTACT-NEXT", chatJid: OWNER, fromMe: false });
  expect(ack).toHaveBeenCalledOnce();
  expect(w.enqueued.map(e => e.deliveryId)).toEqual([`${OWNER}:OWNER-FIRST`]);
  expect(f.service.status().error).toBe("audience-mismatch");
});
it("rejects a delivery when the stored sender principal differs", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [BOB, CAROL];
  const f = build(w); f.transport.resolve.pnForLid = async () => BOB;
  await f.connect(); await f.deliver({ messageId: "FIRST", chatJid: "222@lid" });
  await f.service.stop();
  const path = join(w.dir, "channels/whatsapp", connectionId(w), "chats.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  Object.values(saved.chats).forEach((entry: any) => { entry.userId = CAROL; entry.conversationKey = `dm:${CAROL}`; });
  writeFileSync(path, JSON.stringify(saved));
  await f.service.resume(); await f.deliver({ messageId: "SECOND", chatJid: "222@lid" });
  expect(w.enqueued).toHaveLength(1);
  expect(f.service.status().error).toBe("audience-mismatch");
});
it.each([false, true])("dedupes resolved aliases without alternate fields, LID first %s", async lidFirst => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [BOB];
  const f = build(w), lid = "222@lid";
  f.transport.resolve.pnForLid = async () => BOB;
  f.transport.resolve.lidForPn = async () => lid;
  await f.connect();
  await f.deliver({ messageId: "ALIASED", chatJid: lidFirst ? lid : BOB });
  await f.service.stop(); await f.service.resume();
  await f.deliver({ messageId: "ALIASED", chatJid: lidFirst ? BOB : lid });
  expect(w.enqueued).toHaveLength(1);
  const chats = JSON.parse(read(w, connectionId(w), "chats.json")).chats;
  expect(Object.values(chats)).toEqual([expect.objectContaining({ aliases: expect.arrayContaining([BOB, lid]) })]);
});
it("revokes a timed-out chat before awaiting run cancellation", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [BOB];
  const f = build(w); await f.connect();
  f.sendText.mockRejectedValueOnce(new ChannelSendError("timeout", true));
  await f.deliver({ messageId: "TIMED-OUT" });
  w.results.set(`run:${BOB}:PENDING`, { status: "running" });
  await f.deliver({ messageId: "PENDING" });
  let finish!: () => void;
  f.revokeRuns.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  w.settings.allowFrom = [];
  const applying = f.service.applySettings(); await flush();
  try { expect(f.transport.revoke).toHaveBeenCalledWith(BOB); }
  finally { finish(); await applying; }
});
it.each(["link", "resume"])("reconciles options changed during %s setup", async action => {
  const w = world(), f = build(w);
  if (action === "resume") { await f.connect(); await f.service.stop(); }
  const original = f.transport.start;
  let finish!: () => void;
  f.transport.start = async h => { await original(h); await new Promise<void>(resolve => { finish = resolve; }); };
  const starting = action === "link" ? f.service.link({ method: "qr" }) : f.service.resume();
  await flush(); w.settings.readReceipts = true; await f.service.applySettings();
  f.transport.start = original; finish(); await starting;
  if (action === "link") { f.health({ state: "connected", self: { pn: OWNER, lid: OWNER_LID } }); await flush(); }
  expect(f.factory.mock.calls.at(-1)![0].bridgeOptions.readReceipts).toBe(true);
});

it("revokes owner work before rejecting a contact-classified delivery", async () => {
  const w = world(); w.settings.mode = "contacts"; w.settings.allowFrom = [OWNER];
  const f = build(w); await f.connect();
  w.results.set(`run:${OWNER}:OWNER-PENDING`, { status: "running" });
  await f.toSelf("OWNER-PENDING"); const context = w.contexts.at(-1)!;
  await f.deliver({ messageId: "CONTACT-NEXT", chatJid: OWNER, fromMe: false });
  expect(context.allowed()).toBe(false);
  expect(f.revokeRuns).toHaveBeenCalledWith(connectionId(w), [`run:${OWNER}:OWNER-PENDING`]);
  w.results.delete(`run:${OWNER}:OWNER-PENDING`); await f.service.tick();
  expect(f.sendText).not.toHaveBeenCalled();
});

it("retains a LID principal when its PN becomes available after restart", async () => {
  const w = world(), lid = "222@lid"; w.settings.mode = "contacts"; w.settings.allowFrom = [lid];
  const f = build(w); await f.connect(); await f.deliver({ messageId: "ORIGINAL", chatJid: lid });
  await f.service.stop(); await f.service.resume();
  f.transport.resolve.lidForPn = async () => lid; f.transport.resolve.pnForLid = async () => BOB;
  await f.deliver({ messageId: "ORIGINAL", chatJid: BOB });
  await f.deliver({ messageId: "NEXT", chatJid: BOB });
  expect(w.enqueued).toHaveLength(2);
  expect(w.contexts.every(c => c.principal.kind === "sender" && c.principal.userId === `lid:${lid}`)).toBe(true);
  expect(Object.keys(JSON.parse(read(w, connectionId(w), "chats.json")).chats)).toHaveLength(1);
});
