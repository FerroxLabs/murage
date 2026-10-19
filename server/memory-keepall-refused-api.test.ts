// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 P0: after "Keep all" every turn was refused, silently (P0-KEEPALL-REFUSED). Keep all itself revokes nothing; the install-wide revoke
// that follows it (a roster change: persistMemoryRoster -> revokeAllDisclosures) flips every receipt. On an engine that hands its turn id back
// before it writes the prompt (ACP: Fuigo, the default; Codex; openai-chat) three defects chained: the owner's session was reset on
// audience-only marks (F1), the session row written at session.started held the turn's own prompt and the fence refused it (F2), and the one
// re-dispatch did the same and ended silently (F3, F4). These run the real server with the late-handback fixture engine, which reports its
// session at session.started before the late write, as ACP does, and reads the working context of the bot's other task (a cross-thread line).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { MEMORY_REPAIRS_FILE } from "./memory/keepall-unwedge.ts";

let fixture: VerificationServer, dump: string, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const rowsOf = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const count = (text: string, needle: string) => text.split(needle).length - 1;
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text === "Hello from late").length;
/** One owner turn, answered: the reply lands and the bot is idle again. */
const turn = async (botId: string, threadId: string, text: string) => {
  const before = await replies(threadId);
  await api("POST", `/api/bots/${botId}/messages`, { threadId, text });
  await expect.poll(async () => await replies(threadId), { timeout: 30000 }).toBe(before + 1);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy === true, { timeout: 15000 }).toBe(false);
};

describe.skipIf(process.platform === "win32")("Keep all, then an install-wide revoke: every later turn runs", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.keep={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'keep-dump')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    dump = join(fixture.info.dataDir, "keep-dump");
    await login();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  let botId = "", threadId = "";
  it("five turns after the revoke: each runs and replies, at most one session reset, nothing refused", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Keeper", modelSelection: { instanceId: "keep", model: "late-1" } })).bot;
    botId = bot.id; threadId = bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    // the bot's other task: its lines reach the owner's chat as working context (a line of another thread in the prompt)
    const side = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Side work" })).task;
    await turn(bot.id, side.threadId, "side question");
    // two turns with memory output in the owner's chat
    await turn(bot.id, threadId, "first question");
    await turn(bot.id, threadId, "second question");
    // the install-wide revoke a roster change makes (what follows Keep all on the rig): every receipt flips
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Keeper renamed" });
    const marks = { resets: count(log(), `memory continuation reset thread=${threadId}`), refused: count(log(), `context revoked at a late submission on thread ${threadId}`) };
    for (let n = 1; n <= 5; n++) await turn(bot.id, threadId, `question ${n} after the revoke`);
    const after = log();
    expect(count(after, `memory continuation reset thread=${threadId}`) - marks.resets).toBeLessThanOrEqual(1);
    expect(count(after, `context revoked at a late submission on thread ${threadId}`) - marks.refused).toBe(0);
    const mine = rowsOf(dump).filter(row => row.threadId === threadId);
    // every dispatch wrote its prompt: none was refused at its late write
    expect(mine.filter(row => !row.prompt).length).toBe(mine.filter(row => row.prompt).length);
    const all = await messages(threadId);
    expect(all.filter(message => String(message.tool?.name ?? "").startsWith("error:"))).toEqual([]);
    expect(all.some(message => /without remembered context/.test(String(message.tool?.name ?? "")))).toBe(false);
  }, 240000);

  it("a data dir 1.0.2 left wedged is repaired once at start, and its first turn runs", async () => {
    expect(threadId).not.toBe("");
    // 1.0.2's marks on the owner's current session: an audience-only revoke's deny_session (a receipt flip's walk), as on the rig
    const file = join(fixture.info.dataDir, "messages.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=10000");
    const session = db.prepare("SELECT driver_instance AS d,native_session AS s FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1").get(threadId) as { d: string; s: string };
    expect(session).toBeDefined();
    const revoke = 900001;
    db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(revoke);
    db.prepare("INSERT OR IGNORE INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,?)").run(threadId, session.d, session.s, revoke);
    db.close();
    // an install upgraded from 1.0.2 has never run the repair
    rmSync(join(fixture.info.dataDir, MEMORY_REPAIRS_FILE), { force: true });
    await fixture.restart();
    await login();
    await expect.poll(() => /\[memory\] keep-all repair: owner-chat session marks removed=1 /.test(log()), { timeout: 30000 }).toBe(true);
    const repairs = JSON.parse(readFileSync(join(fixture.info.dataDir, MEMORY_REPAIRS_FILE), "utf8"));
    expect(repairs.keepallUnwedge103?.installationId).toMatch(/^[a-f0-9-]{36}$/);
    const check = new DatabaseSync(file, { readOnly: true });
    expect(Number((check.prepare("SELECT count(*) AS n FROM memory_deny_session WHERE revoke_id=?").get(revoke) as { n: number }).n)).toBe(0);
    check.close();
    const resets = count(log(), `memory continuation reset thread=${threadId}`);
    await turn(botId, threadId, "first question after the restart");
    expect(count(log(), `memory continuation reset thread=${threadId}`) - resets).toBeLessThanOrEqual(1);
    expect(count(log(), `context revoked at a late submission on thread ${threadId}`)).toBe(0);
    // a second start does nothing
    await fixture.restart();
    await login();
    await turn(botId, threadId, "a question after the second restart");
    expect(count(log(), "[memory] keep-all repair:")).toBe(0);
  }, 240000);
});
