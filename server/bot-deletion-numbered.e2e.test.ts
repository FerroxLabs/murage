// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §4 through the real server: a deletion is a numbered change (its frame, its DELETE answer, a retried
// DELETE's `alreadyDeleted`, the roster's `removed[]` all carry the same number), DELETEs of one bot run one at a time and
// re-check at the commit (P11), a failure after the commit answers 200 with a warning (P13, server half), the roster's ledger
// is filtered by who asks (P12, H-r6-1), a deletion recorded before a restart still answers `alreadyDeleted` (P16), and every
// answer that carries a bot carries its number, never cached.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const PHONE_TOKEN = "d".repeat(64);
const posixOnly = describe.skipIf(process.platform === "win32");

// In the server: a deletion can be held inside its awaits (before the commit) while a flag file exists, until a gate file is
// written, and the step after the commit (the conversation-deletion finish) can be made to fail.
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const {pathToFileURL}=await import('node:url');
  const dir=process.env.MURAGE_DATA_DIR;const server=${JSON.stringify(SERVER)};
  const {ConversationDeletions}=await import(pathToFileURL(path.join(server,'conversation-deletion.ts')).href);
  const collect=ConversationDeletions.prototype.collectLogSessions;
  ConversationDeletions.prototype.collectLogSessions=async function(...args){
    if(fs.existsSync(path.join(dir,'delete-hold'))){
      fs.rmSync(path.join(dir,'delete-hold'));fs.writeFileSync(path.join(dir,'delete-held'),'1');
      while(!fs.existsSync(path.join(dir,'delete-gate')))await new Promise(r=>setTimeout(r,10));
      fs.rmSync(path.join(dir,'delete-gate'));
    }
    return collect.apply(this,args);
  };
  const finish=ConversationDeletions.prototype.finish;
  ConversationDeletions.prototype.finish=async function(...args){
    if(fs.existsSync(path.join(dir,'finish-fail'))){fs.rmSync(path.join(dir,'finish-fail'));throw new Error('fixture: the step after the deletion failed');}
    return finish.apply(this,args);
  };
`;

posixOnly("numbered bot deletions", () => {
  let fixture: VerificationServer;
  let desktop: Record<string, string> = {};
  const phone = { "x-murage-companion": "1", "x-murage-companion-token": PHONE_TOKEN };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = desktop) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as any };
  };
  const flag = (name: string) => writeFileSync(join(fixture.info.dataDir, name), "1");
  const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
  const newBot = async (name: string) => { const made = await call("POST", "/api/bots", { name }); expect(made.status).toBeLessThan(300); return made.body.bot as { id: string; tasksSeq: number; tasksEpoch: string }; };
  const roster = async (headers = desktop) => (await call("GET", "/api/bots?view=sidebar", undefined, headers)).body;

  function openStream() {
    const controller = new AbortController();
    const frames: any[] = [];
    void (async () => {
      try {
        const res = await fetch(`${fixture.info.url}/api/events`, { headers: desktop, signal: controller.signal });
        const reader = res.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    return { frames, close: () => controller.abort() };
  }

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, env: { MURAGE_COMPANION_TOKEN: PHONE_TOKEN } });
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret", undefined, {})).body.secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("the deletion's frame, its answer, a retried DELETE and the roster carry one number; answers are never cached", async () => {
    const stream = openStream();
    const bot = await newBot("Numbered");
    expect(typeof bot.tasksSeq).toBe("number");
    expect(typeof bot.tasksEpoch).toBe("string");
    await until(() => stream.frames.some((frame) => frame.kind === "hello"));
    const deleted = await call("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(deleted.body).toMatchObject({ ok: true, tasksEpoch: bot.tasksEpoch });
    expect(deleted.body.tasksSeq).toBeGreaterThanOrEqual(bot.tasksSeq);
    expect(deleted.body.alreadyDeleted).toBeUndefined();
    await until(() => stream.frames.some((frame) => frame.kind === "bot.deleted" && frame.botId === bot.id));
    const frame = stream.frames.find((candidate) => candidate.kind === "bot.deleted" && candidate.botId === bot.id);
    expect(frame).toMatchObject({ tasksSeq: deleted.body.tasksSeq, tasksEpoch: bot.tasksEpoch });
    expect(frame.audience).toBeUndefined();
    stream.close();
    // a retried DELETE (its first answer lost) learns what happened, with the same number
    expect((await call("DELETE", `/api/bots/${bot.id}`)).body).toEqual({ ok: true, alreadyDeleted: true, tasksSeq: deleted.body.tasksSeq, tasksEpoch: bot.tasksEpoch });
    const listed = await roster();
    expect(listed.tasksEpoch).toBe(bot.tasksEpoch);
    expect(listed.removed).toContainEqual({ id: bot.id, tasksSeq: deleted.body.tasksSeq, tasksEpoch: bot.tasksEpoch, kind: "deleted" });
    expect((await call("DELETE", "/api/bots/never-existed")).status).toBe(404);
  }, 60_000);

  it("two DELETEs of one bot run one at a time: the second re-runs and meets alreadyDeleted", async () => {
    const bot = await newBot("Twice");
    flag("delete-hold");
    const first = call("DELETE", `/api/bots/${bot.id}`);
    await until(() => existsSync(join(fixture.info.dataDir, "delete-held")));
    const second = call("DELETE", `/api/bots/${bot.id}`);
    await new Promise((r) => setTimeout(r, 200));
    rmSync(join(fixture.info.dataDir, "delete-held"));
    flag("delete-gate");
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200); expect(a.body.alreadyDeleted).toBeUndefined();
    expect(b.status).toBe(200); expect(b.body).toMatchObject({ ok: true, alreadyDeleted: true, tasksSeq: a.body.tasksSeq, tasksEpoch: a.body.tasksEpoch });
  }, 60_000);

  it("P11 / Astra r5 order 6: a restore sent during an archived delete's awaits waits for the delete; it never lands between its teardown and its commit", async () => {
    const bot = await newBot("Restored");
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);
    flag("delete-hold");
    const archivedDelete = call("DELETE", `/api/bots/${bot.id}?ifArchived=1`);
    await until(() => existsSync(join(fixture.info.dataDir, "delete-held")));
    // the DELETE is inside its awaits, past its preconditions and mid-teardown
    let restoreAnswered = false;
    const restore = call("PATCH", `/api/bots/${bot.id}`, { hidden: false }).then((answer) => { restoreAnswered = true; return answer; });
    await new Promise((r) => setTimeout(r, 500));
    expect(restoreAnswered).toBe(false); // it waits: no 200 for a restore the commit would then refuse, with the teardown already done
    const plainDelete = call("DELETE", `/api/bots/${bot.id}`);
    rmSync(join(fixture.info.dataDir, "delete-held"));
    flag("delete-gate");
    // what the person confirmed was an archived bot, and it still was when the delete committed
    const deleted = await archivedDelete;
    expect(deleted.status).toBe(200);
    expect(deleted.body.alreadyDeleted).toBeUndefined();
    // the restore met the deletion: there is no bot to restore, and no bot is left stripped of its facilities
    expect((await restore).status).toBe(404);
    // the plain DELETE waited behind it and ran its own checks: it meets alreadyDeleted
    expect((await plainDelete).body).toMatchObject({ ok: true, alreadyDeleted: true });
    expect((await roster()).bots.some((row: any) => row.id === bot.id)).toBe(false);
  }, 60_000);

  it("P11: a restore that comes first defeats a later archived delete before any teardown", async () => {
    const bot = await newBot("RestoredFirst");
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { hidden: false })).status).toBe(200);
    const refused = await call("DELETE", `/api/bots/${bot.id}?ifArchived=1`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("no longer archived");
    expect((await roster()).bots.some((row: any) => row.id === bot.id)).toBe(true);
    expect((await call("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  }, 60_000);

  it("P13 (server half): a failure after the deletion committed answers 200 with a warning and the deletion's number", async () => {
    const bot = await newBot("Warned");
    flag("finish-fail");
    const answer = await call("DELETE", `/api/bots/${bot.id}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, tasksEpoch: bot.tasksEpoch });
    expect(answer.body.warning).toContain("the step after the deletion failed");
    expect(typeof answer.body.tasksSeq).toBe("number");
    expect((await roster()).bots.some((row: any) => row.id === bot.id)).toBe(false);
    // a refusal before the commit is the server's own JSON error, and nothing is removed
    const kept = await newBot("Kept");
    const notArchived = await call("DELETE", `/api/bots/${kept.id}?ifArchived=1`);
    expect(notArchived.status).toBe(409);
    expect(typeof notArchived.body.error).toBe("string");
    expect((await roster()).bots.some((row: any) => row.id === kept.id)).toBe(true);
  }, 60_000);

  it("H-r6-1 and P12: the desktop keeps an archived bot and gets no hide entry; the phone gets the hide; a grant gets no ledger", async () => {
    const archived = await newBot("Archived");
    const visible = await newBot("Seen by phone");
    expect((await roster(phone)).bots.some((row: any) => row.id === visible.id)).toBe(true);
    const hidden = await call("PATCH", `/api/bots/${archived.id}`, { hidden: true });
    expect(hidden.status).toBe(200);
    const deleted = await call("DELETE", `/api/bots/${visible.id}`);
    expect(deleted.status).toBe(200);

    const desk = await roster();
    expect(desk.bots.find((row: any) => row.id === archived.id)).toMatchObject({ hidden: true });
    expect(desk.removed.some((entry: any) => entry.id === archived.id)).toBe(false);
    expect(desk.removed.every((entry: any) => entry.kind === "deleted")).toBe(true);
    expect(desk.removed.some((entry: any) => entry.id === visible.id)).toBe(true);

    const scoped = await roster(phone);
    expect(scoped.bots.some((row: any) => row.id === archived.id)).toBe(false);
    expect(scoped.tasksEpoch).toBe(desk.tasksEpoch);
    expect(scoped.removed).toContainEqual(expect.objectContaining({ id: archived.id, kind: "hidden" }));
    expect(scoped.removed).toContainEqual(expect.objectContaining({ id: visible.id, kind: "deleted" }));

    const kept = await newBot("Scripted");
    const grant = await call("POST", "/api/mcp-grants", { botId: kept.id });
    expect(grant.status).toBe(201);
    const scripted = await call("GET", "/api/bots", undefined, { authorization: `Bearer ${grant.body.token}` });
    expect(scripted.status).toBe(200);
    expect(scripted.body.bots.map((row: any) => row.id)).toEqual([kept.id]);
    expect(scripted.body).not.toHaveProperty("removed");
    expect(scripted.body).not.toHaveProperty("tasksEpoch");
    // Nested owner metadata stays with the owner (astra-botint H1): the script's full roster and its bot's transcript page
    // carry no numbering and no turn ids, while the owner's surfaces keep theirs.
    const scriptedFull = await call("GET", "/api/bots?messages=20", undefined, { authorization: `Bearer ${grant.body.token}` });
    expect(scriptedFull.status).toBe(200);
    expect(scriptedFull.headers.get("cache-control")).toBe("no-store");
    expect(scriptedFull.body.bots).toHaveLength(1);
    expect(JSON.stringify(scriptedFull.body)).not.toMatch(/"(tasksEpoch|tasksSeq|turnId|dispatchedIn|removed)"/);
    const scriptedPage = await call("GET", `/api/threads/${scriptedFull.body.bots[0].threadId}/messages`, undefined, { authorization: `Bearer ${grant.body.token}` });
    expect(scriptedPage.status).toBe(200);
    expect(JSON.stringify(scriptedPage.body)).not.toMatch(/"(tasksEpoch|tasksSeq|turnId|dispatchedIn)"/);
    expect((await roster(phone)).bots.find((row: any) => row.id === kept.id)).toMatchObject({ tasksEpoch: desk.tasksEpoch });
    expect((await roster()).bots.find((row: any) => row.id === kept.id)).toHaveProperty("tasksSeq");
  }, 60_000);

  it("P16: a deletion from before a restart answers alreadyDeleted with this run's epoch and number 0", async () => {
    const bot = await newBot("Before restart");
    const deleted = await call("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    await fixture.restart();
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret", undefined, {})).body.secret };
    const epoch = (await roster()).tasksEpoch;
    expect(epoch).not.toBe(bot.tasksEpoch);
    expect((await call("DELETE", `/api/bots/${bot.id}`)).body).toEqual({ ok: true, alreadyDeleted: true, tasksSeq: 0, tasksEpoch: epoch });
  }, 120_000);
});
