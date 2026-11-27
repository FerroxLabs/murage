// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 cause B, design section 4 (W9) on the real path. Owners: lane deep1022-causeB-fable owns this witness; the carry of a
// refused attempt's masked values = harness (bus.ts admitNewTurn, audience-collector.ts carriedValues); the flag that says "this
// admission is the same owner message dispatched again" = index.ts (startTurn -> admitLedgerLease); rulings = MAIN.
//
// ASTRA 4f1bc47bb3 + 1a61faff0d, MAIN-RULING 2026-11-24T22:48:06Z: the bus rows of W9 pass `redispatch` themselves, so they stay green
// if index.ts stops passing it. Here nothing is passed by the test: a real server, POST /api/bots/:id/messages, an engine that hands
// its turn id back and writes its prompt late behind the send fence (as ACP and Codex do; it declares fencedWrites, which is what lets
// the server prove the refused write unwritten and rebuild). The first attempt completes one message that holds a credential (a resumed
// session replaying what it holds), then its late write is refused because the owner changed the bot's memory section in that wait
// (a real revoke), and the server rebuilds the same owner message (index.ts late-memory ticket -> rebuildRefusedDirectTurn -> startTurn
// with memoryRedispatch and rebuildOf -> admitLedgerLease(redispatch)). The rebuilt attempt repeats the value bare: no label, no
// provider shape, so only the list carried from the refused attempt can hold it back.
// Rig notes: the 122 pending legacy revoke jobs are the fixture of direct-rebuild-hold-late-api.test.ts (the owner's edit stays a
// revoke still being walked); SETTLE_MS lets that edit reach the send fence before the late write is released, so the write is refused
// as a revoked context (released at once, a scope check can refuse it first and the turn ends on a card: then the "rebuilt" assertion
// fails, never the carry assertion).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PEM_LINES, PEM_QUOTE } from "./testing/heldbound-fixtures-1023.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const V = "FIXTUREVALUE" + "7731abQZ";
// an unlabelled value of the same length, never printed after a credential label (MAIN-RULING 23:37:25Z W9 guard: stays shown)
const W = "FIXTUREOTHER" + "5520cdRT";
const REPEAT = `The value it printed was ${V}, as you saw; the build id is ${W}.`;
const NEXT = "Anything else you want me to look into?";
const FIRST = `Reading the config again: api_key=${V}`;
// q1023-rcready (MAIN-RULING 2026-11-26T21:44:41Z): the refused attempt printed a PEM file; the rebuilt one quotes 40 chars of it
const PEM_TEXT = ["Reading the key again:", "-----BEGIN " + "PRIVATE KEY-----", ...PEM_LINES.slice(15, 26), "-----END " + "PRIVATE KEY-----"].join("\n");
const SAID_PEM = (quote: string) => `The key line has ${quote} in it.`;
const SETTLE_MS = 2500;
let fixture: VerificationServer, headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); } finally { db.close(); }
}
const shown = (row: any): string => JSON.stringify([row.text ?? "", row.tool ?? "", row.card ?? ""]);
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const rebuilds = (threadId: string) => log().split(`context revoked at a late submission on thread ${threadId}; re-preparing`).length - 1;
const texts = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage").map(m => String(m.text ?? ""));

const LEGACY_JOBS = 122, FIRST_LEGACY_ID = 720001;
const pendingLegacy = () => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return Number((db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id BETWEEN ? AND ? AND state='active'").get(FIRST_LEGACY_ID, FIRST_LEGACY_ID + LEGACY_JOBS - 1) as { n: number }).n); }
  finally { db.close(); }
};
const ensureLegacyJobs = async () => {
  if (pendingLegacy() < LEGACY_JOBS) {
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=10000");
    const root = JSON.stringify({ kind: "receipt", bundleId: "legacy-receipt", cause: "receipt-revoked" });
    const job = db.prepare("INSERT OR IGNORE INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'receipt',?,1,1,'mark','','active')");
    const audience = db.prepare("INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)");
    const pending = db.prepare("INSERT OR IGNORE INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
    const frontier = db.prepare("INSERT OR IGNORE INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{unreadable')");
    db.exec("BEGIN");
    for (let n = 0; n < LEGACY_JOBS; n++) { const id = FIRST_LEGACY_ID + n; job.run(id, root); audience.run(id); pending.run(id); frontier.run(id); }
    db.exec("COMMIT");
    db.close();
    await fixture.restart();
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }
};

/** One owner line to the instance's bot. `revoke`: the owner edits the bot's memory section while the first attempt waits at its
 * late write, so that write is refused and the server rebuilds the message. Every later write is let through. */
async function turn(instance: string, revoke: boolean) {
  const gate = join(fixture.info.dataDir, `${instance}-gate`);
  const waiting = () => { try { return readFileSync(`${gate}.waiting`, "utf8"); } catch { return ""; } };
  const created = await api("POST", "/api/bots", { name: `Fixture ${instance}`, modelSelection: { instanceId: instance, model: "late-1" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture owner line: read the config and tell me how it went." })).status).toBe(202);
  const seen = new Set<string>();
  let rows: any[] = [];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const id = waiting();
    if (id && !seen.has(id)) {
      if (revoke && seen.size === 0) expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Revoke before the late write" })).status).toBe(200);
      if (revoke && seen.size === 0) await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      seen.add(id); writeFileSync(gate, "");
    }
    rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    if (texts(rows).includes(NEXT) || rows.some(m => String(m.tool?.name ?? '').startsWith('error:'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  return { threadId: bot.threadId, sends: seen.size, read: texts(rows), kept: texts(stored), all: [...rows, ...stored].map(shown).join("\n"),
    diag: `sends ${seen.size} rows ${JSON.stringify(rows.map(m => [m.role, m.kind, shown(m).slice(0, 160)]))} log ${log().split("\n").filter(line => line.includes(bot.threadId) && /re-preparing|\[redact\]/.test(line)).map(line => line.split(V).join("<value>")).join(" | ").slice(-900)}` };
}

describe.skipIf(process.platform === "win32")("1.0.22 cause B, real path: a rebuilt owner message carries what its refused attempt masked", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
      const dir=process.env.MURAGE_DATA_DIR, file=path.join(dir,'config.json'), cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.computer={...cfg.computer,defaultForNewBots:'off'};
      const late=name=>({FAKE_LATE_HANDBACK:'1',FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,name+'-gate'),FAKE_LATE_REPLIES:${JSON.stringify(JSON.stringify([REPEAT, NEXT]))}});
      cfg.instances.carried={driver:'fakeLateTerminal',environment:{...late('carried'),FAKE_LATE_TEXT_FIRST:${JSON.stringify(FIRST)}}};
      cfg.instances.carriedpem={driver:'fakeLateTerminal',environment:{...late('carriedpem'),FAKE_LATE_REPLIES:${JSON.stringify(JSON.stringify([SAID_PEM(PEM_QUOTE), NEXT]))},FAKE_LATE_TEXT_FIRST:${JSON.stringify(PEM_TEXT)}}};
      cfg.instances.rebuiltclean={driver:'fakeLateTerminal',environment:{...late('rebuiltclean'),FAKE_LATE_TEXT_FIRST:'Reading the config again, one moment.'}};
      cfg.instances.unrefused={driver:'fakeLateTerminal',environment:{...late('unrefused'),FAKE_LATE_TEXT_FIRST:'Reading the config again, one moment.'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    await ensureLegacyJobs();
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  // MAIN-RULING 2026-11-26T23:37:25Z W9 option (2): a value right after a credential label (api_key=) is masked IN PLACE in the owner
  // chat, never held: the reply is read and stored, the value absent, a redacted marker in its place; the unlabelled same-length value
  // beside it is shown word for word
  it("W9 the first attempt printed a labelled credential and was refused at its late write: the rebuilt attempt's reply that repeats the value is shown with the value masked in place, the unlabelled same-length value and its harmless reply word for word", async () => {
    const t = await turn("carried", true);
    // the message really was dispatched twice: refused once at its late write, then rebuilt by the server
    expect(rebuilds(t.threadId), t.diag).toBeGreaterThanOrEqual(1);
    expect(t.sends, t.diag).toBeGreaterThanOrEqual(2);
    // the clean later reply of the rebuilt attempt is read and stored word for word
    expect({ read: t.read.includes(NEXT), stored: t.kept.includes(NEXT) }, t.diag).toEqual({ read: true, stored: true });
    // base a45ea55d0c (labelled value not credential grade): the repeat is read and stored with the value in clear; index.ts not
    // passing the re-dispatch on: the rebuilt attempt starts with an empty list and the repeat is stored raw
    const said = (rows: string[]) => rows.filter(text => text.startsWith("The value it printed was «redacted ") && text.endsWith(`as you saw; the build id is ${W}.`)).length;
    expect({ read: said(t.read), stored: said(t.kept), held: t.read.concat(t.kept).filter(text => /held back this message/i.test(text)).length, clear: t.all.includes(V) }, t.diag).toEqual({ read: 1, stored: 1, held: 0, clear: false });
    expect(log()).not.toContain(V);
  }, 180_000);

  it("W9-PEM owner chat: the refused attempt printed a PEM file; the rebuilt attempt's quote of 40 chars of it is masked in place, never shown in clear", async () => {
    const t = await turn("carriedpem", true);
    expect(rebuilds(t.threadId), t.diag).toBeGreaterThanOrEqual(1);
    const said = SAID_PEM(`«redacted ${PEM_QUOTE.length} chars»`);
    // base 33801294e7: the quote is read and stored in clear; a carry that drops the credential-shape mark does the same
    expect({ read: t.read.includes(said), stored: t.kept.includes(said) }, t.diag).toEqual({ read: true, stored: true });
    expect(t.all, t.diag).not.toContain(PEM_QUOTE);
    expect(log()).not.toContain(PEM_QUOTE);
  }, 180_000);

  it("W9 controls: the same rebuild with nothing masked before it, and the same replies with no refusal, are shown word for word", async () => {
    const clean = await turn("rebuiltclean", true);
    expect(rebuilds(clean.threadId), clean.diag).toBeGreaterThanOrEqual(1);
    expect(clean.sends, clean.diag).toBeGreaterThanOrEqual(2);
    // the bare value is no finding by itself: with nothing masked in the refused attempt the rebuilt attempt is an ordinary turn
    expect({ read: clean.read.slice(-2), stored: [REPEAT, NEXT].map(text => clean.kept.includes(text)) }, clean.diag).toEqual({ read: [REPEAT, NEXT], stored: [true, true] });
    const plain = await turn("unrefused", false);
    expect(rebuilds(plain.threadId), plain.diag).toBe(0);
    expect(plain.read.slice(-2), plain.diag).toEqual([REPEAT, NEXT]);
  }, 240_000);
});
