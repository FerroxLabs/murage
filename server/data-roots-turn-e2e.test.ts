// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S5-DATADIR-PATHS r4.1 D2, D6 and D19 end to end (gate relay 16 repro): a task whose stored folder names an old
// data folder, driven through the real direct turn (startTurn: admitTaskStoredCwd -> pinTaskCwd -> admitFinalCwd ->
// BOTH workspaceResource admissions, index.ts ~:12539 and ~:12550). Real server and the repository's fake Claude CLI.
// The fixture's boot preload applies the "data folder moved or copied" edits before the store loads, and spies every
// fs write under the old folders (fs, fs/promises and their ESM bindings), so "nothing written there" is asserted
// inside the server, not inferred.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { removeTempDir } from "./testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { readPersistedRecords } from "./persisted-state.ts";

// turn-paths.ts WORKING_FOLDER_MISSING_TEXT (inlined so the file loads on a base without the module)
const WORKING_FOLDER_TEXT = "This conversation's working folder is missing or cannot be opened, so the turn did not start.";
// design section 6, the link-below-a-root working-folder text (data-roots.ts)
const LINK_BELOW_ROOT_TEXT = "A folder in this bot's workspace is a link or is not a folder, and Murage never writes through a link there";

const PRELOAD = `
// D7's control forces only the audience input; the cwd overwrite and engine dispatch stay real.
const { registerHooks } = await import('node:module');
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/server/index.ts')) return loaded;
  const source = String(loaded.source);
  const anchor = '  const humanIsOwner=turnAudienceIsOwner(threadId);';
  if (!source.includes(anchor)) throw new Error('D7 audience fixture anchor moved');
  return { ...loaded, source: source.replace(anchor, '  if(text === "D7 forced desk control") opts = {...opts, commsDepth: 1};\\n  const humanIsOwner=text === "D7 forced desk control" ? false : turnAudienceIsOwner(threadId);') };
}});
const fs = await import('node:fs'); const path = await import('node:path'); const mod = await import('node:module');
const dataDir = process.env.MURAGE_DATA_DIR;
const writeRaw = fs.appendFileSync;
const cfgFile = path.join(dataDir, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.instances.verification.environment = { ...(cfg.instances.verification.environment ?? {}), FAKE_CLAUDE_DUMP_EACH_TURN: '1' };
fs.writeFileSync(cfgFile, JSON.stringify(cfg));
const planFile = path.join(dataDir, 's5-plan.json');
if (fs.existsSync(planFile)) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); fs.rmSync(planFile);
  const botsFile = path.join(dataDir, 'bots.json'); const bots = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
  for (const [threadId, cwd] of Object.entries(plan.cwds ?? {})) for (const bot of bots) for (const task of bot.tasks ?? []) if (task.threadId === threadId) task.cwd = cwd;
  fs.writeFileSync(botsFile, JSON.stringify(bots, null, 2));
  if (plan.record) fs.writeFileSync(path.join(dataDir, '.murage-root.json'), JSON.stringify(plan.record, null, 2), { mode: 0o600 });
  for (const link of plan.links ?? []) { fs.rmSync(link.path, { recursive: true, force: true }); fs.symlinkSync(link.target, link.path, 'dir'); }
}
const watchFile = path.join(dataDir, 's5-watch.json');
const watched = fs.existsSync(watchFile) ? JSON.parse(fs.readFileSync(watchFile, 'utf8')) : [];
if (watched.length) {
  const require = mod.createRequire(import.meta.url);
  const cjs = require('node:fs'); const prom = require('node:fs/promises');
  const text = (p) => typeof p === 'string' ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : '';
  const hit = (p) => { const s = text(p); return Boolean(s) && watched.some(root => s === root || s.startsWith(root + path.sep)); };
  const note = (op, args) => { for (const a of args.slice(0, 2)) if (hit(a)) writeRaw(path.join(dataDir, 's5-spy.jsonl'), JSON.stringify({ op, path: text(a) }) + '\\n'); };
  const writes = ['mkdir', 'writeFile', 'appendFile', 'rename', 'copyFile', 'symlink', 'rm', 'rmdir', 'unlink', 'cp', 'link', 'truncate', 'chmod', 'utimes', 'mkdtemp'];
  const wrap = (obj, names, tag) => { for (const n of names) { const orig = obj[n]; if (typeof orig !== 'function') continue; obj[n] = function (...args) { note(tag + n, args); return orig.apply(this, args); }; } };
  wrap(cjs, [...writes.map(n => n + 'Sync'), ...writes, 'createWriteStream'], 'fs.');
  wrap(prom, writes, 'fsp.');
  const { O_WRONLY, O_RDWR, O_CREAT } = cjs.constants;
  const writing = (f) => typeof f === 'number' ? (f & (O_WRONLY | O_RDWR | O_CREAT)) !== 0 : typeof f === 'string' && !['r', 'rs', 'sr'].includes(f);
  for (const [obj, tag] of [[cjs, 'fs.'], [prom, 'fsp.']]) for (const n of tag === 'fs.' ? ['openSync', 'open'] : ['open']) {
    const orig = obj[n]; obj[n] = function (p, flags, ...rest) { if (writing(flags)) note(tag + n, [p]); return orig.call(this, p, flags, ...rest); };
  }
  mod.syncBuiltinESMExports();
}
`;

type Bot = { id: string; threadId: string };
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, scratch = "";
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
// The server's DATA_DIR is canonical (the lease resolves it): on macOS tmpdir() /var/... is /private/var/..., so the stored
// desks and the root record use the canonical spelling. Linux tmp is already canonical.
const dataDir = () => realpathSync.native(fixture.info.dataDir);
const storedTask = (threadId: string) => (JSON.parse(readFileSync(join(dataDir(), "bots.json"), "utf8")) as any[]).flatMap(bot => bot.tasks ?? []).find((task: any) => task.threadId === threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const busy = async (bot: Bot) => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id)?.tasks?.find((task: any) => task.threadId === bot.threadId)?.busy;
const dumps = () => existsSync(fixture.fixtureDumpLogPath) ? readFileSync(fixture.fixtureDumpLogPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const dumpFor = (text: string) => dumps().filter(dump => JSON.stringify(dump.prompt).includes(text));
const spyHits = () => existsSync(join(dataDir(), "s5-spy.jsonl")) ? readFileSync(join(dataDir(), "s5-spy.jsonl"), "utf8").split("\n").filter(Boolean) : [];
const refusedLines = (threadId: string) => readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("turn-setup-refused") && line.includes(threadId));
const send = async (bot: Bot, text: string) => {
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
};
/** a wait usable in beforeAll too (expect.poll is test-only) */
const waitUntil = async (what: string, check: () => Promise<boolean> | boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`timed out waiting for ${what}`);
};
const settled = async (bot: Bot, text: string) => {
  await waitUntil(`${text}: a dump or a failure row`, async () => dumpFor(text).length > 0 || (await messages(bot.threadId)).some(message => message.kind === "activity" && message.tool?.ok === false));
  await waitUntil(`${text}: idle`, async () => (await busy(bot)) === false);
};
const failureRows = async (bot: Bot) => (await messages(bot.threadId)).filter(message => message.kind === "activity" && message.tool?.ok === false);
/** names, sizes and mtimes of every entry under a folder (lstat, links not followed) */
const tree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { const full = join(dir, name); const st = lstatSync(full); out.push(`${full.slice(root.length)} ${st.isDirectory() ? "d" : st.size} ${st.mtimeMs}`); if (st.isDirectory()) walk(full); } };
  walk(root); return out;
};
const deskUnder = (root: string, bot: Bot) => join(root, "workspaces", bot.id, "threads", bot.threadId);

posixOnly("D2 end to end: a stored desk under an old data folder, through the real turn path", () => {
  const bots: Record<"moved" | "userGone" | "linked" | "rebased" | "copied" | "plain" | "forced", Bot> = {} as never;
  const desk: Record<string, string> = {};
  const keysBefore: Record<string, string[]> = {};
  let roomie: Bot, room: { id: string; threadId: string };
  beforeAll(async () => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-d2e2e-")));
    fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 49_000, span: 900 }, instrumentationSource: PRELOAD, dumpLog: true });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options;
    for (const name of ["moved", "userGone", "linked", "rebased", "copied", "plain", "forced"] as const) {
      const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0].id } });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      bots[name] = made.body.bot as Bot;
      await send(bots[name], `first turn ${name}`);
      await settled(bots[name], `first turn ${name}`);
      desk[name] = storedTask(bots[name].threadId).cwd;
      expect(desk[name], name).toBe(deskUnder(dataDir(), bots[name]));
      expect(dumpFor(`first turn ${name}`)[0]?.cwd, name).toBe(realpathSync.native(desk[name]!));
      keysBefore[name] = Object.keys(storedTask(bots[name].threadId)).sort();
    }
    // D5b: a room member's first room turn makes its desk; the group turn path is index.ts ~:18530
    const made = await api("POST", "/api/bots", { name: "roomie", modelSelection: { instanceId: "verification", model: models[0].id } });
    roomie = made.body.bot as Bot;
    room = (await api("POST", "/api/groups", { name: "S5 room", memberIds: [roomie.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: roomie.id } } })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "first room turn" })).status).toBeLessThan(300);
    await waitUntil("the first room turn", () => dumpFor("first room turn").length > 0);
  }, 180_000);
  afterAll(async () => { await fixture?.close(); if (scratch) await removeTempDir(scratch); });

  it("NO record: a moved root's desk, a gone user folder and a linked managed desk each end in the working-folder card, one activity row and one turn-setup-refused line; nothing escapes, nothing is written", async () => {
    const oldMoved = join(scratch, "old-moved-root"); // absent: the folder was moved away
    const elsewhere = join(scratch, "elsewhere"); mkdirSync(elsewhere);
    const roomTarget = join(scratch, "room-memory-elsewhere"); mkdirSync(roomTarget);
    const storedMoved = deskUnder(oldMoved, bots.moved), storedUser = join(scratch, "user-project-gone");
    writeFileSync(join(dataDir(), "s5-watch.json"), JSON.stringify([oldMoved, elsewhere, storedUser, roomTarget]));
    writeFileSync(join(dataDir(), "s5-plan.json"), JSON.stringify({
      cwds: { [bots.moved.threadId]: storedMoved, [bots.userGone.threadId]: storedUser },
      links: [{ path: desk.linked, target: elsewhere }, { path: join(dataDir(), "workspaces", roomie.id, "memory"), target: roomTarget }],
    }));
    await fixture.restart();
    // D5b through the group turn: the member's memory folder is now a link -> refused, nothing written through it, the engine never starts
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "room turn through a link" })).status).toBeLessThan(300);
    await waitUntil("the room failure row", async () => (await messages(room.threadId)).some(message => message.kind === "activity" && message.tool?.ok === false));
    const roomRows = (await messages(room.threadId)).filter(message => message.kind === "activity" && message.tool?.ok === false);
    expect(roomRows.map(row => row.tool.localFailure)).toEqual(["working-folder"]);
    expect(roomRows[0].tool.name).toContain(LINK_BELOW_ROOT_TEXT.slice(0, 80));
    expect(dumpFor("room turn through a link")).toEqual([]);
    expect(readdirSync(roomTarget)).toEqual([]);
    for (const [name, text, card] of [["moved", "after the move, no record", WORKING_FOLDER_TEXT], ["userGone", "user folder gone", WORKING_FOLDER_TEXT], ["linked", "desk is a link", LINK_BELOW_ROOT_TEXT]] as const) {
      await send(bots[name], text);
      await settled(bots[name], text);
      const rows = await failureRows(bots[name]);
      expect(rows, name).toHaveLength(1);
      expect(rows[0].tool.localFailure, name).toBe("working-folder");
      expect(rows[0].tool.name, name).toContain(card.slice(0, 120));
      expect(dumpFor(text), `${name}: the engine never started`).toEqual([]);
      expect(refusedLines(bots[name].threadId), `${name}: D19 one line, no path`).toEqual([`turn-setup-refused code=working-folder thread=${bots[name].threadId}`]);
    }
    // D2: the stored folders are preserved exactly; D6: the user's folder is never created
    expect(storedTask(bots.moved.threadId).cwd).toBe(storedMoved);
    expect(storedTask(bots.userGone.threadId).cwd).toBe(storedUser);
    expect(existsSync(oldMoved)).toBe(false);
    expect(existsSync(storedUser)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(spyHits()).toEqual([]);
    // nothing escaped the turn: the server still answers, no unhandled rejection or uncaught error was logged
    expect((await api("GET", "/api/bots?messages=0")).status).toBe(200);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toMatch(/unhandled ?rejection|uncaught ?exception/i);
  }, 180_000);

  it("D7 control: a non-owner turn overwrites a forced old cwd with its new privateWorkspace and runs without a card", async () => {
    const bot = bots.forced;
    const oldDesk = deskUnder(join(scratch, "d7-old-root"), bot);
    writeFileSync(join(dataDir(), "s5-plan.json"), JSON.stringify({ cwds: { [bot.threadId]: oldDesk } }));
    await fixture.restart();
    expect(storedTask(bot.threadId).cwd).toBe(oldDesk);
    const text = "D7 forced desk control";
    await send(bot, text); await settled(bot, text);
    expect(await failureRows(bot)).toEqual([]);
    expect(storedTask(bot.threadId).cwd).toBe(desk.forced);
    expect(dumpFor(text)).toHaveLength(1);
    expect(dumpFor(text)[0].cwd).toBe(realpathSync.native(desk.forced!));
    expect(refusedLines(bot.threadId)).toEqual([]);
    expect(existsSync(oldDesk)).toBe(false);
  }, 180_000);

  it("WITH the root record: a moved root's desk runs in the rebased new desk; a copied root (old still present) runs in the new desk and nothing is written under the old one", async () => {
    const oldMoved = join(scratch, "old-rebased-root"); // absent
    const oldCopied = join(scratch, "old-copied-root");
    const copiedDesk = deskUnder(oldCopied, bots.copied);
    mkdirSync(copiedDesk, { recursive: true });
    writeFileSync(join(copiedDesk, "old-root-marker.txt"), "the copy left behind\n");
    mkdirSync(join(oldCopied, "workspaces", bots.copied.id, "memory"), { recursive: true });
    writeFileSync(join(oldCopied, "workspaces", bots.copied.id, "MEMORY.md"), "# Memory\nold copy\n");
    const before = tree(oldCopied);
    const at = new Date().toISOString();
    writeFileSync(join(dataDir(), "s5-watch.json"), JSON.stringify([oldMoved, oldCopied]));
    rmSync(join(dataDir(), "s5-spy.jsonl"), { force: true });
    writeFileSync(join(dataDir(), "s5-plan.json"), JSON.stringify({
      cwds: { [bots.rebased.threadId]: deskUnder(oldMoved, bots.rebased), [bots.copied.threadId]: copiedDesk },
      record: { schema: 1, root: dataDir(), previous: [{ root: oldMoved, at, source: "start" }, { root: oldCopied, at, source: "start" }] },
    }));
    await new Promise(resolve => setTimeout(resolve, 20)); // mtime granularity: a write under the old copy would move a stamp
    await fixture.restart();
    // D12 control: a never-moved task's second turn gives the fields a second turn writes at this build
    await send(bots.plain, "plain second turn");
    await settled(bots.plain, "plain second turn");
    const controlKeys = Object.keys(storedTask(bots.plain.threadId)).sort();
    for (const name of ["rebased", "copied"] as const) {
      const text = `after the ${name} data folder, with its record`;
      await send(bots[name], text);
      await settled(bots[name], text);
      expect(await failureRows(bots[name]), name).toEqual([]);
      const ran = dumpFor(text);
      expect(ran, name).toHaveLength(1);
      expect(ran[0].cwd, `${name}: runs in the NEW desk`).toBe(realpathSync.native(desk[name]!));
      expect(ran[0].cwdEntries, name).not.toContain("old-root-marker.txt");
      expect(storedTask(bots[name].threadId).cwd, `${name}: the record now names the new desk`).toBe(desk[name]);
      // D12: the rebased record keeps the 1.0.17 shape (persisted-state.ts is unchanged since f28a6bad8): only the fields
      // a never-moved task has after the same second turn, no new one, and the 1.0.17 loader reads the file
      expect(Object.keys(storedTask(bots[name].threadId)).sort().filter(key => !controlKeys.includes(key)), `${name}: D12 no unknown field`).toEqual([]);
      expect(keysBefore[name]!.every(key => key in storedTask(bots[name].threadId)), name).toBe(true);
      expect(readPersistedRecords<{ id: string }>(join(dataDir(), "bots.json")).length).toBeGreaterThan(0);
      expect(refusedLines(bots[name].threadId), name).toEqual([]);
    }
    expect(existsSync(oldMoved)).toBe(false);
    expect(spyHits(), "no fs write under either old root").toEqual([]);
    expect(tree(oldCopied)).toEqual(before);
    expect(statSync(join(copiedDesk, "old-root-marker.txt")).size).toBe(21);
  }, 180_000);
});
