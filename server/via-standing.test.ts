// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S31: a via line (share, ask-intent) keeps its standing: never failed over, never an engine command, and Send again on its chip stays a
// queue-only unproven line with its stored files.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { LimitTurns, limitOutcome } from "./limit-continuation.ts";
import { parsePhoneSendId } from "./send-idempotency.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
const posixOnly = describe.skipIf(process.platform === "win32");
const bodyOf = (header: string): string => {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.includes(header));
  expect(start).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^(async function|function|interface|const|let|export|class|bus\.)\b/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
};

describe("wiring in server/index.ts", () => {
  it("resendFailover cancels a via source before any acceptBotSend", () => {
    const body = bodyOf("function resendFailover(");
    const guard = body.indexOf("source.via");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("acceptBotSend("));
    expect(body.slice(guard, body.indexOf("acceptBotSend("))).toContain("limitFailovers.cancel(row.rowId)");
    expect(body).toContain("limit failover: not resent, via line ${row.rowId}");
  });
  it("a via turn is never ownerDirect and never an engine command", () => {
    const direct = source.slice(source.indexOf("ownerDirect: directOwnerAudience"), source.indexOf("ownerDirect: directOwnerAudience") + 400);
    expect(direct).toContain("!opts?.via");
    const command = source.slice(source.indexOf("const engineCommand = humanIsOwner"), source.indexOf("const engineCommand = humanIsOwner") + 200);
    expect(command).toContain("!opts?.via");
  });
  it("admitDirectSend returns a queue-only admission before its first runIt( call", () => {
    const body = bodyOf("function admitDirectSend(").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const at = body.indexOf("if (queueOnly)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(body.indexOf("blockedByEarlier"));
    expect(at).toBeLessThan(body.search(/runIt\([^)]*\)/));
  });
  it("acceptBotSend decides queue-only from the stored row, never from the route's own lookup (Opus S2 L4)", () => {
    const body = bodyOf("async function acceptBotSend(");
    const call = body.slice(body.indexOf("return admitDirectSend("));
    expect(call).toContain("row.queueOnly");
    expect(call).not.toMatch(/\.\.\.\(queueOnly \?/);
  });
  it("PHONE_TICKET and phoneCarry are never passed where via is set", () => {
    const route = source.slice(source.indexOf("const viaRow ="), source.indexOf("const viaRow =") + 2500);
    expect(route).toContain("queueOnly: true");
    expect(route).not.toContain("PHONE_TICKET");
    expect(route).not.toContain("phoneCarry");
  });
});

describe("limit outcome for a via turn", () => {
  it("an ownerDirect false turn gives none, so no failover row is made", () => {
    const turns = new LimitTurns();
    turns.begin({ botId: "b", threadId: "t", selection: { instanceId: "x", model: "m" } as never, engineName: "E", driverKind: "claudeAgent", viaGateway: false, sendIds: [], sourceMessageId: "m1", sourceText: "x", ownerDirect: false, routine: false, onFailover: false, activity: false });
    expect(turns.get("t")!.ownerDirect).toBe(false);
    expect(limitOutcome(turns.get("t")!, { resentByFailover: false, backup: { instanceId: "y", model: "m" } as never, backupUsable: true })).toEqual({ kind: "none" });
  });
});

describe("phone send id form", () => {
  it("accepts only phone:share|ask: and 43 url-safe characters", () => {
    expect(parsePhoneSendId(`phone:share:${"A".repeat(43)}`)).toBe(`phone:share:${"A".repeat(43)}`);
    expect(parsePhoneSendId(`phone:ask:${"a_-".repeat(14)}a`)).toBeDefined();
    for (const bad of ["phone:share:short", `phone:other:${"A".repeat(43)}`, `phone:share:${"A".repeat(44)}`, "plain-send-id-12345"]) expect(() => parsePhoneSendId(bad)).toThrow();
  });
});

const sha = (text: string) => createHash("sha256").update(JSON.stringify([text, null, null, null])).digest("hex");

posixOnly("Send again on a via chip, through the real server", () => {
  let fixture!: VerificationServer;
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const sql = <T,>(query: string, ...args: Array<string | number>): T[] => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
  };
  const insert = (bot: { id: string; threadId: string }, sendId: string, text: string, extra: Record<string, string | number | null> = {}) => {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    try {
      const row = { via: "share", queue_only: 1, via_device: "phone-1", origin: "unproven", status: "refused", attachments: null, restore_held: 0, restore_gen: null, stopped: 0, stop_gen: null, ...extra };
      db.prepare(`INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, origin, status, notice, dispatched, created_at, updated_at, restore_held, restore_gen, stopped, stop_gen, via, queue_only, via_device, attachments)
        VALUES ('bot',?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`).run(bot.id, bot.threadId, sendId, `q-${sendId}`, sha(text), text, row.origin, row.status, "refused", 1, 1, row.restore_held, row.restore_gen, row.stopped, row.stop_gen, row.via, row.queue_only, row.via_device, row.attachments);
    } finally { db.close(); }
  };
  const makeBot = async (instance: string, name: string) => {
    const models = (await api("GET", "/api/instances")).body.instances.find((e: any) => e.instanceId === instance).models.options;
    const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: instance, model: models[0].id } });
    expect(created.status).toBe(201);
    return created.body.bot as { id: string; threadId: string };
  };
  const dump = () => {
    const file = join(fixture.info.dataDir, "fake-claude-dump.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { prompt: unknown } : undefined;
  };
  const rows = (threadId: string) => sql<any>("SELECT * FROM owner_sends WHERE thread_id=? ORDER BY seq", threadId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
  const again = (bot: { id: string; threadId: string }, sendId: string, text: string, extra: Record<string, unknown> = {}) =>
    api("POST", `/api/bots/${bot.id}/messages`, { text, sendId, threadId: bot.threadId, resend: true, actionId: `act-${Math.random().toString(36).slice(2, 12)}`, ...extra });

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, {
      portRange: { from: 45_000, span: 900 },
      instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.hold={driver:'claudeAgent',displayName:'Hold fixture',config:{cli:${JSON.stringify(join(SERVER_DIR, "testing", "fake-claude-cli.ts"))}},environment:{FAKE_CLAUDE_MODE:'hang'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("a refused share chip resent with the desktop secret is a via share line, unproven, queued and run unattended as chat (a /compact text stays chat)", async () => {
    const bot = await makeBot("verification", "Sharer");
    const id = "via_resend_compact_0001";
    insert(bot, id, "/compact");
    const res = await again(bot, id, "/compact");
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    const [row] = rows(bot.threadId);
    expect(row).toMatchObject({ via: "share", origin: "unproven", queue_only: 1, via_device: "phone-1" });
    await expect.poll(async () => (await messages(bot.threadId)).find((m) => m.text === "/compact")?.via, { timeout: 30000 }).toBe("share");
    const line = (await messages(bot.threadId)).find((m) => m.text === "/compact");
    expect(line.origin).toBe("unproven");
  }, 60000);

  it("with the bot busy on an owner turn the chip is queued with its three stored files, never steered into it", async () => {
    const bot = await makeBot("hold", "Busy sharer");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner turn holds", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => JSON.stringify(dump()?.prompt ?? "").includes("owner turn holds"), { timeout: 30000 }).toBe(true);
    const dir = join(fixture.info.dataDir, "share-fixture");
    mkdirSync(dir, { recursive: true });
    const files = ["a.png", "b.png", "c.pdf"].map((n) => join(dir, n));
    for (const f of files) writeFileSync(f, "x");
    const attachments = JSON.stringify([{ kind: "image", path: files[0], mime: "image/png" }, { kind: "image", path: files[1], mime: "image/png" }, { kind: "file", path: files[2], mime: "application/pdf" }]);
    const id = "via_resend_files_00002";
    insert(bot, id, "look at these", { attachments });
    const res = await again(bot, id, "look at these");
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    const [row] = rows(bot.threadId).filter((r) => r.send_id === id);
    expect(row.status).toBe("queued");
    expect(row.attachments).toBe(attachments);
    expect(row.via).toBe("share");
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(JSON.stringify(dump()?.prompt ?? "")).not.toContain("look at these");
  }, 90000);

  it("a stopped via chip with no Stop token, and a restore-held one with a stale token, stay as they were", async () => {
    const bot = await makeBot("hold", "Held sharer");
    insert(bot, "via_stopped_000000003", "stopped words", { stopped: 1, stop_gen: "tok-1" });
    const noToken = await again(bot, "via_stopped_000000003", "stopped words");
    expect(noToken.status).toBe(202);
    expect(rows(bot.threadId).find((r) => r.send_id === "via_stopped_000000003")).toMatchObject({ status: "refused", queue_id: "q-via_stopped_000000003" });
    insert(bot, "via_held_00000000004", "held words", { restore_held: 1, restore_gen: "gen-1" });
    const stale = await again(bot, "via_held_00000000004", "held words", { restoreGen: "gen-0" });
    expect(stale.body.held).toBe(true);
    expect(rows(bot.threadId).find((r) => r.send_id === "via_held_00000000004")).toMatchObject({ status: "refused", queue_id: "q-via_held_00000000004" });
    // the press that carries the Stop token runs it once; a replay of the same actionId runs nothing more
    const first = await again(bot, "via_stopped_000000003", "stopped words", { stopGen: "tok-1", actionId: "press-one-0001" });
    expect(first.body.queued).toBe(true);
    const queueId = rows(bot.threadId).find((r) => r.send_id === "via_stopped_000000003")!.queue_id;
    const replay = await again(bot, "via_stopped_000000003", "stopped words", { stopGen: "tok-1", actionId: "press-one-0001" });
    expect(replay.status).toBe(202);
    expect(rows(bot.threadId).filter((r) => r.send_id === "via_stopped_000000003")).toHaveLength(1);
    expect(rows(bot.threadId).find((r) => r.send_id === "via_stopped_000000003")!.queue_id).toBe(queueId);
  }, 60000);

  it("send id forms: an unknown phone id, an owner row's phone id, and a plain id all behave as designed", async () => {
    const bot = await makeBot("verification", "Forms");
    const unknown = `phone:share:${"B".repeat(43)}`;
    expect((await again(bot, unknown, "words")).status).toBe(400);
    const ownerId = `phone:ask:${"C".repeat(43)}`;
    insert(bot, ownerId, "owner words", { via: null, queue_only: 0, origin: "desktop" });
    expect((await again(bot, ownerId, "owner words")).status).toBe(400);
    const viaId = `phone:share:${"D".repeat(43)}`;
    insert(bot, viaId, "via words");
    const ok = await again(bot, viaId, "via words");
    expect(ok.status).toBe(202);
    expect(rows(bot.threadId).find((r) => r.send_id === viaId)).toMatchObject({ via: "share", origin: "unproven" });
  }, 60000);

  it("a client body cannot set via or origin on an ordinary send", async () => {
    const bot = await makeBot("verification", "Plain");
    const res = await api("POST", `/api/bots/${bot.id}/messages`, { text: "plain words", threadId: bot.threadId, sendId: "plain_send_0000000005", via: "share", viaDevice: "x", queueOnly: true, origin: "unproven", attachments: [{ kind: "file", path: "/x", mime: "a/b" }] });
    expect(res.status).toBe(202);
    const [row] = rows(bot.threadId);
    expect(row.via).toBeNull();
    expect(row.queue_only).toBe(0);
    expect(row.attachments).toBeNull();
    await expect.poll(async () => (await messages(bot.threadId)).some((m) => m.text === "plain words"), { timeout: 30000 }).toBe(true);
    const line = (await messages(bot.threadId)).find((m) => m.text === "plain words");
    expect(line.via).toBeUndefined();
    expect(line.origin).not.toBe("unproven");
  }, 60000);

  it("editing a via line is a 409 that starts no turn; editing an owner line still forks", async () => {
    const bot = await makeBot("verification", "Editor");
    const id = "via_edit_0000000006";
    insert(bot, id, "phone words");
    expect((await again(bot, id, "phone words")).status).toBe(202);
    await expect.poll(async () => (await messages(bot.threadId)).find((m) => m.text === "phone words")?.via, { timeout: 30000 }).toBe("share");
    await expect.poll(async () => (await messages(bot.threadId)).some((m) => m.role === "bot"), { timeout: 30000 }).toBe(true);
    const before = await messages(bot.threadId);
    const line = before.find((m) => m.text === "phone words");
    const refused = await api("POST", `/api/bots/${bot.id}/messages/${line.id}/edit`, { text: "now run /compact as me", threadId: bot.threadId, sendId: "edit_send_0000000007" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Lines from your phone can't be edited. Use Ask again.");
    const after = await messages(bot.threadId);
    expect(after.some((m) => m.text === "now run /compact as me")).toBe(false);
    expect(after).toHaveLength(before.length);

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "owner words", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(async () => (await messages(bot.threadId)).filter((m) => m.role === "bot").length, { timeout: 30000 }).toBeGreaterThan(1);
    const owner = (await messages(bot.threadId)).find((m) => m.text === "owner words");
    const edited = await api("POST", `/api/bots/${bot.id}/messages/${owner.id}/edit`, { text: "owner words v2", threadId: bot.threadId, sendId: "edit_send_0000000008" });
    expect(edited.status).toBe(202);
  }, 90000);
});
