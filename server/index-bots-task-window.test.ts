// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot carries a window of its tasks (server/task-window.ts), not every one it
// ever had. Through the real server: GET /api/bots costs the same bytes and
// statements at 500 and 5,000 tasks per bot; the totals the interface used to
// add up from the list (task count, usage, grants) are the full-list values;
// an old task is found by its thread id; the older tasks page back to the
// oldest; and the delta stream stays correct while tasks enter and leave the
// window.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countControlSource, sendCountCommand } from "./testing/bounded-reads.ts";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { ROSTER_TASK_WINDOW, TASK_WINDOW } from "./task-window.ts";

const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const sqlite=await import('node:sqlite');
  const dir=process.env.MURAGE_DATA_DIR;let on=false;let n=0;let by={};
  const proto=sqlite.StatementSync.prototype;
  for(const name of ['all','get','iterate','run']){const original=proto[name];proto[name]=function(...args){if(on){n++;const key=String(this.sourceSQL).replace(/\\s+/g,' ').slice(0,140);by[key]=(by[key]??0)+1;}return original.apply(this,args);};}
  ${countControlSource(`(c)=>{
    if(c.start){n=0;by={};on=true;fs.writeFileSync(path.join(dir,'count-started'),'1');}
    else{on=false;fs.writeFileSync(path.join(dir,'counts.json'),JSON.stringify({statements:n,by}));}}`)}
`;

let fixture: VerificationServer | undefined;
let headers: Record<string, string> = {};
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture!.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const file = (name: string) => join(fixture!.info.dataDir, name);
const signal = (command: object) => sendCountCommand(fixture!.info.dataDir, command);
const until = async (check: () => boolean) => { const end = Date.now() + 5_000; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const authHeaders = async () => { headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret }; };

const AT = 1_700_000_000_000;
const usageOf = (i: number) => ({ input: 100 + i, output: 10, cachedInput: 50, costUsd: 0.01, turns: 1 });
const grantOf = (i: number) => `Bash:cmd${i % 11}`;

/** A server whose one bot holds `count` tasks (the oldest first on disk, newest created last), then restarted to read them. */
async function launchWith(count: number) {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
  await authHeaders();
  const model = (await call("GET", "/api/instances")).body.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
  const bot = (await call("POST", "/api/bots", { name: "Window bot", modelSelection: { instanceId: "verification", model } })).body.bot as { id: string; threadId: string };
  await fixture.stop();
  const path = file("bots.json");
  const records = JSON.parse(readFileSync(path, "utf8")) as any[];
  const record = records.find((entry) => entry.id === bot.id);
  const tasks = Array.from({ length: count }, (_, i) => ({
    threadId: `old-${String(i).padStart(5, "0")}`, title: `Task ${i}`, createdAt: AT + i, resumeCursors: {},
    usage: usageOf(i), alwaysAllow: [grantOf(i)],
    ...(i === 3 ? { pinned: true } : {}), ...(i === 4 ? { unread: true } : {}),
  }));
  // the bot's open task is the newest-but-one; the first-made task stays, as it does for any bot
  record.tasks = [...tasks, ...record.tasks.filter((task: any) => task.threadId === record.threadId).map((task: any) => ({ ...task, createdAt: AT - 1 }))];
  writeFileSync(path, JSON.stringify(records));
  await fixture.restart();
  await authHeaders();
  return { bot, count, grants: new Set(tasks.map((_, i) => grantOf(i))) };
}

/** The server does work of its own after it starts listening (a pass over every task, for one); count only once it is quiet. */
async function quiet() {
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const name of ["counts.json", "count-started"]) rmSync(file(name), { force: true });
    signal({ start: true });
    await until(() => existsSync(file("count-started")));
    await new Promise((r) => setTimeout(r, 1_000));
    signal({ dump: true });
    await until(() => existsSync(file("counts.json")));
    if ((JSON.parse(readFileSync(file("counts.json"), "utf8")) as { statements: number }).statements < 5) return;
  }
  throw new Error("the server never went quiet");
}

async function measured(read: () => Promise<{ status: number; text: string; body: any }>) {
  for (const name of ["counts.json", "count-started"]) rmSync(file(name), { force: true });
  signal({ start: true });
  await until(() => existsSync(file("count-started")));
  const answer = await read();
  signal({ dump: true });
  await until(() => existsSync(file("counts.json")));
  const dump = JSON.parse(readFileSync(file("counts.json"), "utf8")) as { statements: number; by: Record<string, any> };
  return { answer, statements: dump.statements };
}

describe("the roster carries a window of each bot's tasks", () => {
  it("costs the same bytes and statements at 500 and at 5,000 tasks, and a small bot is sent whole", async () => {
    const ran: Record<number, { bytes: number; statements: number; tasks: number; botBytes: number }> = {};
    for (const count of [10, 500, 5000]) {
      const { bot } = await launchWith(count);
      await call("GET", "/api/bots?messages=0"); // warm process-wide caches
      await quiet();
      const { answer, statements } = await measured(() => call("GET", "/api/bots?messages=0"));
      expect(answer.status).toBe(200);
      const wired = answer.body.bots.find((entry: any) => entry.id === bot.id);
      ran[count] = { bytes: answer.text.length, statements, tasks: wired.tasks.length, botBytes: JSON.stringify(wired).length };
      await fixture!.close();
      fixture = undefined;
    }
    // 10 tasks (+ the first-made one) are all sent; a big bot sends its window, not its history
    expect(ran[10]!.tasks).toBe(11);
    expect(ran[500]!.tasks).toBe(ran[5000]!.tasks);
    expect(ran[5000]!.tasks).toBeLessThanOrEqual(60);
    expect(ran[5000]!.botBytes).toBeLessThan(ran[500]!.botBytes * 1.05);
    expect(ran[5000]!.bytes).toBeLessThan(ran[500]!.bytes * 1.05);
    // one statement per sent row (its last activity) and no more: 4,500 more tasks cost nothing
    expect(Math.abs(ran[5000]!.statements - ran[500]!.statements)).toBeLessThanOrEqual(4);
    expect(ran[5000]!.statements).toBeLessThanOrEqual(ran[10]!.statements + (ran[5000]!.tasks - ran[10]!.tasks) + 4);
  }, 600_000);

  it("sends the totals the interface used to add up, equal to the full-list values, and keeps what it must", async () => {
    const { bot, count, grants } = await launchWith(5000);
    const roster = await call("GET", "/api/bots?messages=0");
    const wired = roster.body.bots.find((entry: any) => entry.id === bot.id);
    const ids = new Set(wired.tasks.map((task: any) => task.threadId));
    expect(wired.tasksTotal).toBe(count + 1);
    // the full-list sums
    const turns = count, input = Array.from({ length: count }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
    expect(wired.usageTotal).toEqual({ input, output: 10 * count, cachedInput: 50 * count, costUsd: expect.closeTo(0.01 * count, 6), turns });
    expect(new Set(wired.grantsAll)).toEqual(grants);
    // pinned, unread, the open task and the newest are in; an ordinary old one is not
    for (const id of ["old-00003", "old-00004", bot.threadId, "old-04999"]) expect(ids.has(id), id).toBe(true);
    expect(ids.has("old-00005")).toBe(false);
    expect(typeof wired.tasksOlder).toBe("string");
    // the roster carries the small window (10 newest + the 3 it must keep); a bot's own answers carry the full window of 50 + the same 3
    expect(wired.tasks.length).toBe(ROSTER_TASK_WINDOW + 3);
    const one = await call("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}?messages=0`);
    expect(one.body.bot.tasks.length).toBe(TASK_WINDOW + 3);
    expect(one.body.bot.tasksTotal).toBe(count + 1);
  }, 300_000);

  it("finds an old task by its thread id, and says whose a thread is", async () => {
    const { bot } = await launchWith(1000);
    const found = await call("GET", `/api/bots/${bot.id}/tasks/old-00007`);
    expect(found.status).toBe(200);
    expect(found.body.task).toMatchObject({ threadId: "old-00007", title: "Task 7" });
    expect(found.body.task.resumeCursors).toBeUndefined();
    expect((await call("GET", `/api/bots/${bot.id}/tasks/not-a-task`)).status).toBe(404);
    expect((await call("GET", "/api/bots/not-a-bot/tasks/old-00007")).status).toBe(404);
    expect((await call("GET", "/api/threads/old-00007/owner")).body).toEqual({ botId: bot.id });
    expect((await call("GET", "/api/threads/not-a-task/owner")).status).toBe(404);
  }, 300_000);

  it("pages the older tasks back to the oldest, each once, and the window plus the pages are every task", async () => {
    const { bot, count } = await launchWith(1000);
    const roster = await call("GET", "/api/bots?messages=0");
    const wired = roster.body.bots.find((entry: any) => entry.id === bot.id);
    const seen = new Map<string, number>();
    for (const task of wired.tasks) seen.set(task.threadId, 1);
    let cursor: string | null = wired.tasksOlder;
    let pages = 0;
    while (cursor !== null) {
      const page = await call("GET", `/api/bots/${bot.id}/tasks?before=${encodeURIComponent(cursor)}&limit=120`);
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(count + 1);
      expect(page.body.tasks.length).toBeLessThanOrEqual(120);
      for (const task of page.body.tasks) seen.set(task.threadId, (seen.get(task.threadId) ?? 0) + 1);
      cursor = page.body.next;
      pages++;
    }
    expect(seen.size).toBe(count + 1);
    // the only task in both the window and a page is one the window kept past its age
    expect([...seen.values()].filter((times) => times > 1).length).toBeLessThanOrEqual(3);
    expect(seen.has("old-00000")).toBe(true);
    expect(pages).toBeGreaterThan(5);
    expect((await call("GET", `/api/bots/${bot.id}/tasks?before=garbage`)).status).toBe(400);
    expect((await call("GET", `/api/bots/${bot.id}/tasks?limit=0`)).status).toBe(400);
  }, 300_000);

  it("keeps the delta stream correct while tasks enter and leave the window, and never makes one look deleted", async () => {
    const { bot, count } = await launchWith(300);
    const frames: any[] = [];
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${fixture!.info.url}/api/events?tasks=delta`, { headers, signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) { const frame = JSON.parse(line.slice(6)); if (frame.kind === "bot" && frame.bot.id === bot.id) frames.push(frame.bot); }
          }
        }
      } catch { /* aborted */ }
    })();
    try {
      const waitFor = async (check: () => boolean) => { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) throw new Error("no frame"); await new Promise((r) => setTimeout(r, 50)); } };
      const before = frames.length;
      // an old task is pinned: it joins the window, so the set changed and the frame is whole
      expect((await call("PATCH", `/api/bots/${bot.id}/tasks/old-00010`, { pinned: true })).status).toBe(200);
      await waitFor(() => frames.slice(before).some((frame) => frame.tasks?.some((task: any) => task.threadId === "old-00010")));
      const joined = frames.slice(before).find((frame) => frame.tasks?.some((task: any) => task.threadId === "old-00010"));
      expect(joined.tasksTotal).toBe(count + 1);
      expect(joined.tasksDelta).toBeUndefined();
      // and unpinned: it leaves the window, and the total says nothing was deleted
      const middle = frames.length;
      expect((await call("PATCH", `/api/bots/${bot.id}/tasks/old-00010`, { pinned: false })).status).toBe(200);
      await waitFor(() => frames.slice(middle).some((frame) => frame.tasks && !frame.tasks.some((task: any) => task.threadId === "old-00010")));
      const left = frames.slice(middle).find((frame) => frame.tasks && !frame.tasks.some((task: any) => task.threadId === "old-00010"));
      expect(left.tasksTotal).toBe(count + 1);
      expect((await call("GET", `/api/bots/${bot.id}/tasks/old-00010`)).status).toBe(200);
      // a row that changes inside the window is a delta whose count is the window's, with the totals beside it
      const settled = frames.length;
      expect((await call("PATCH", `/api/bots/${bot.id}/tasks/old-00299`, { title: "Renamed" })).status).toBe(200);
      await waitFor(() => frames.slice(settled).length > 0);
      const frame = frames.slice(settled).at(-1);
      const rows = frame.tasks ?? null;
      if (frame.tasksDelta) {
        expect(frame.tasksDelta.count).toBe(left.tasks.length);
        expect(frame.tasksTotal).toBe(count + 1);
        expect(frame.tasksDelta.upsert.find((task: any) => task.threadId === "old-00299")?.title).toBe("Renamed");
      } else expect(rows.find((task: any) => task.threadId === "old-00299").title).toBe("Renamed");
      // a resync (the roster) sends the same bounded set the stream does (one shared window), with the same total
      const roster = (await call("GET", "/api/bots?messages=0")).body.bots.find((entry: any) => entry.id === bot.id);
      expect(roster.tasks.length).toBe(left.tasks.length);
      expect(roster.tasks.length).toBeLessThanOrEqual(ROSTER_TASK_WINDOW + 3);
      expect(roster.tasksTotal).toBe(count + 1);
    } finally { controller.abort(); }
  }, 300_000);
});
