// J (email design r9 section 8): the mailbox read path on a booted server. A bot connected to its own mail server calls email_read
// through the production internal route during a real turn (W wiring -> M3 local reader), which seals the thread first: the durable
// ledger completes, pre-seal history leaves the generic plane and the stored rows, and only the computer's sealed route (V) shows it.
// The account row and the fetched message are written at the storage boundary M2 (Connect) and M1 (IMAP fetch) own; neither is built.
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../../scripts/control-murage.ts";
import { withTurnSecrets } from "../../testing/fixture-dump.ts";

const SUBJECT = "Zq7 fixture subject line";
const BODY = "Zq7 fixture body words";
const PRE = "Zq7 pre-seal owner line";
const companionProof = "c".repeat(64);
const phone = { "x-murage-companion": "1", "x-murage-companion-token": companionProof, "x-murage-door-token": companionProof };
const instrumentation = `
await import(${JSON.stringify(new URL("../../testing/idle-load-preload.mjs", import.meta.url).href)});
process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
process.env.FAKE_CLAUDE_MODE='hang';
`;
// The fixed lines of the I-5 refusals (mailbox/sealed-turn.ts), spelled here so the base build fails at the behaviour, not at an import.
const WRITE_LINE = "Email conversations can't save anything outside this conversation (memory, routines, projects, the Inbox or other conversations).";
const VOICE_LINE = "Voice notes aren't available in email conversations.";
const TARGET_LINE = "That bot's conversation holds email, so other bots can't ask it or hand it work there.";
const PAUSED_LINE = "Email privacy setup hasn't finished; this conversation is paused.";
// a 1x1 PNG with a trailing byte of its own, as an owner upload before the seal (a managed file the conversation names)
const PICTURE = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64"), Buffer.from([0x37])]);
const SEED_ROWS = 2100; // more than one call's 4 x 500 seal batches
let fixture: VerificationServer, desktop: Record<string, string>, bot: { id: string; threadId: string }, asker: { id: string; threadId: string }, long: { id: string; threadId: string }, retry: { id: string; threadId: string };

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = desktop, deadlineMs?: number): Promise<{ status: number; body: any; text: string }> {
  let response: Response;
  try {
    response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(deadlineMs ? { signal: AbortSignal.timeout(deadlineMs) } : {}) });
  } catch (error) {
    // a call that is held (an own-write card waiting for the owner) instead of answered: status 0, so the row fails at its assertion
    if (deadlineMs && (error as Error)?.name === "TimeoutError") return { status: 0, body: { error: "held past the deadline" }, text: "" };
    throw error;
  }
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text answer */ }
  return { status: response.status, body: parsed, text };
}

/** The same request from another loopback-range source address (127.0.0.2): every term but isLoopback holds. */
function fromOtherLoopback(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(fixture.info.url + path);
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method, localAddress: "127.0.0.2", headers: { ...headers, "content-type": "application/json" } }, res => {
      let text = "";
      res.setEncoding("utf8").on("data", chunk => { text += chunk; }).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function ledgerState(threadId: string): unknown {
  return withDb(db => db.prepare("SELECT state FROM mailbox_sealed_threads WHERE thread_id=?").get(threadId)?.state, true);
}

/** Rows written before the seal (a long conversation), with a word that must leave the generic table when the seal completes. */
function seedRows(threadId: string, word: string) {
  withDb(db => {
    const put = db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?)");
    const at = Date.parse("2026-11-19T10:00:00Z");
    db.exec("BEGIN");
    for (let i = 0; i < SEED_ROWS; i++) {
      const id = `seed-${i}`, text = `${word} line ${i}`;
      put.run(threadId, id, at + i, text, JSON.stringify({ id, at: at + i, role: "user", kind: "text", text }));
    }
    db.exec("COMMIT");
  });
}

function withDb<T>(fn: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly });
  try { db.exec("PRAGMA busy_timeout=10000"); return fn(db); } finally { db.close(); }
}

/** The mailbox M2 would have connected and the message M1 would have fetched, as their tables hold them. */
function connectFixtureMailbox(botId: string) {
  withDb(db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_accounts (bot_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE, read_enabled INTEGER NOT NULL CHECK (read_enabled IN (0, 1)));
      CREATE TABLE IF NOT EXISTS mailbox_messages (inbox_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, received_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (inbox_id, message_id));
    `);
    db.prepare("INSERT INTO mailbox_accounts(bot_id, inbox_id, read_enabled) VALUES (?, 'fixture-inbox', 1)").run(botId);
    const at = Date.parse("2026-11-20T10:00:00Z");
    db.prepare("INSERT INTO mailbox_messages(inbox_id, message_id, thread_id, received_at, json) VALUES ('fixture-inbox', 'fixture-mail', 'fixture-mail-thread', ?, ?)")
      .run(at, JSON.stringify({ id: "fixture-mail", thread_id: "fixture-mail-thread", direction: "inbound", from: "sender@example.test", to: ["owner@example.test"], cc: [], subject: SUBJECT, text: BODY, received_at: new Date(at).toISOString() }));
  });
}

/** The fixture engine's dump of the turn whose prompt carries `marker`, if that turn started. */
function dumpOf(marker: string): any {
  const line = existsSync(fixture.fixtureDumpLogPath) ? readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").find(row => row.includes(marker)) : undefined;
  return line ? JSON.parse(line) : undefined;
}

/** The turn's capability tokens, from the fixture engine's dump line that carries `marker`. */
async function turnTokens(marker: string): Promise<{ dump: any; comms: Record<string, string>; memory?: Record<string, string> }> {
  let dump: any;
  await expect.poll(() => {
    try {
      const line = readFileSync(fixture.fixtureDumpLogPath, "utf8").trim().split("\n").find(row => row.includes(marker));
      if (!line) return false;
      dump = withTurnSecrets(JSON.parse(line));
      return !!dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;
    } catch { return false; }
  }, { timeout: 30000 }).toBe(true);
  const memoryToken = Object.values(dump.mcpConfig.mcpServers as Record<string, { env?: Record<string, string> }>).map(server => server.env?.MURAGE_MEMORY_TOKEN).find(Boolean);
  return { dump, comms: { authorization: "Bearer " + dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN }, ...(memoryToken ? { memory: { authorization: "Bearer " + memoryToken } } : {}) };
}

async function release(dump: any, who: { id: string; threadId: string }) {
  if (dump?.pid) writeFileSync(join(fixture.fixtureFinishGateDir, String(dump.pid)), "");
  await api("POST", `/api/bots/${who.id}/interrupt`, { threadId: who.threadId });
  await expect.poll(async () => !(await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === who.id)?.busy, { timeout: 30000 }).toBe(true);
}

async function duringTurn(marker: string, run: (auth: Record<string, string>, tokens: Awaited<ReturnType<typeof turnTokens>>) => Promise<void>, who = bot, extra = "") {
  expect((await api("POST", `/api/bots/${who.id}/messages`, { threadId: who.threadId, text: `${marker} ${PRE} __fixture_hold_authority__${extra}` })).status).toBe(202);
  let dump: any;
  try {
    const tokens = await turnTokens(marker);
    dump = tokens.dump;
    await run(tokens.comms, tokens);
  } finally {
    await release(dump, who);
  }
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: companionProof }, instrumentationSource: instrumentation, dumpLog: true });
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
  const instances = (await api("GET", "/api/instances")).body.instances, model = instances.find((x: any) => x.instanceId === "verification").models.options[0].id;
  // a name with a " (...)" suffix, so an ask can name it by the short form the ask route also resolves (coordination-target.ts)
  bot = (await api("POST", "/api/bots", { name: "Mailbox fixture (Inbox)", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  connectFixtureMailbox(bot.id);
  asker = (await api("POST", "/api/bots", { name: "Asker fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${asker.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  long = (await api("POST", "/api/bots", { name: "Long mailbox fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${long.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  withDb(db => db.prepare("INSERT INTO mailbox_accounts(bot_id, inbox_id, read_enabled) VALUES (?, 'fixture-inbox-3', 1)").run(long.id));
  retry = (await api("POST", "/api/bots", { name: "Retry mailbox fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${retry.id}`, { computer: "off", browser: false, composio: false, autoReview: "off" })).status).toBe(200);
  withDb(db => db.prepare("INSERT INTO mailbox_accounts(bot_id, inbox_id, read_enabled) VALUES (?, 'fixture-inbox-4', 1)").run(retry.id));
}, 120000);

afterAll(async () => { await fixture?.close(); });

it("email_read on the internal route returns local mailbox mail only after the thread's seal completed and moved its history", async () => {
  // a picture the owner attached before the seal: a managed file on the generic plane, named by a pre-seal row
  const uploaded = await fetch(`${fixture.info.url}/api/attachments?threadId=${bot.threadId}`, { method: "POST", headers: { ...desktop, "content-type": "image/png" }, body: PICTURE });
  expect(uploaded.status).toBe(201);
  const picturePath = String((await uploaded.json() as { path: string }).path), picture = basename(picturePath);
  expect((await api("GET", `/api/attachments/${picture}`)).status, "control: the picture is served before the seal").toBe(200);
  let read: { status: number; body: any } | undefined;
  await duringTurn("J-READ-1", async (auth, tokens) => {
    read = await api("POST", "/api/internal/email/email_read", { message_id: "fixture-mail" }, auth);
    // I-5, in the same owner turn right after the read sealed this conversation: nothing of Murage's is written outside it.
    // Each row is soft, so every refusal is checked at its own line.
    const routine = await api("POST", "/api/internal/routine-requests", { title: `${SUBJECT} routine`, prompt: BODY }, auth);
    expect.soft([routine.status, routine.body?.error], "a routine is refused with the fixed line").toEqual([403, WRITE_LINE]);
    // (a bot id that does not exist, so a build without the refusal answers without starting a turn the next test would wait on)
    const other = await api("POST", "/api/internal/ask-bot", { toBotId: "fixture-no-such-bot", message: BODY }, auth);
    expect.soft([other.status, other.body?.error], "a line into another conversation is refused").toEqual([403, WRITE_LINE]);
    const voice = await api("POST", "/api/internal/voice-note", { text: BODY }, auth);
    expect.soft([voice.status, voice.body?.error], "a voice note is refused before synthesis").toEqual([403, VOICE_LINE]);
    expect(tokens.memory, "the turn mounts memory").toBeTruthy();
    const memory = await api("POST", "/api/internal/memory/save", { text: BODY }, tokens.memory, 10000);
    expect.soft([memory.status, memory.body?.error], "a memory note is refused").toEqual([403, WRITE_LINE]);
  }, bot, ` <attached-image path="${picturePath}" />`);
  expect(read!.status, JSON.stringify(read!.body)).toBe(200);
  expect(String(read!.body.text), "the W -> M3 read path answers the stored mail").toContain(BODY);
  expect(String(read!.body.text)).toContain(SUBJECT);
  const ledger = withDb(db => db.prepare("SELECT state FROM mailbox_sealed_threads WHERE thread_id=?").get(bot.threadId), true);
  expect(ledger?.state, "the seal completed before the tool returned").toBe("complete");
  const atRest = withDb(db => db.prepare("SELECT json FROM messages WHERE thread_id=?").all(bot.threadId).map(row => String(row.json)).join("\n"), true);
  expect(atRest, "the pre-seal rows were rewritten to the projection").not.toContain(PRE);
  const generic = await api("GET", `/api/threads/${bot.threadId}/messages`);
  expect(generic.status).toBe(200);
  expect(generic.text, "the computer's generic read shows the projection").not.toContain(PRE);
  expect(generic.text).toContain("Email conversation");
  // 3.6 step 2: the picture moved into sealed custody before the seal completed; the generic plane no longer has it
  expect((await api("GET", `/api/attachments/${picture}`)).status, "the generic attachment route no longer serves the sealed picture").toBe(404);
  expect(existsSync(picturePath), "the generic file left the attachments folder").toBe(false);
  const sealedPicture = await api("POST", "/api/mailbox/sealed/media", { threadId: bot.threadId, name: picture });
  expect(sealedPicture.status, sealedPicture.text).toBe(200);
  expect(Buffer.from(String(sealedPicture.body.base64), "base64").equals(PICTURE), "sealed custody holds the same bytes").toBe(true);
  expect(sealedPicture.body.sha256).toBe(createHash("sha256").update(PICTURE).digest("hex"));
  const offPicture = await fromOtherLoopback("POST", "/api/mailbox/sealed/media", desktop, { threadId: bot.threadId, name: picture });
  expect(offPicture.status, "the sealed media route has the sealed guard").toBe(404);
}, 120000);

it("the sealed route shows the moved history to the owner's computer only", async () => {
  const ids = withDb(db => db.prepare("SELECT id FROM messages WHERE thread_id=?").all(bot.threadId).map(row => String(row.id)), true);
  const request = { threadId: bot.threadId, ids: ids.slice(0, 50) };
  const local = await api("POST", "/api/mailbox/sealed/read", request);
  expect(local.status, local.text).toBe(200);
  expect(local.text, "the computer's sealed plane shows the original").toContain(PRE);
  // The paired phone is an owner surface (it reads the generic thread), but the companion allow-list refuses this path before routing.
  expect((await api("GET", `/api/threads/${bot.threadId}/messages`, undefined, phone)).status, "the paired phone passes owner auth").toBe(200);
  for (const headers of [phone, { "x-murage-surface": "desktop", "x-murage-surface-secret": "not-the-secret" }] as Record<string, string>[]) {
    const other = await api("POST", "/api/mailbox/sealed/read", request, headers);
    expect(other.status, `surface ${JSON.stringify(headers)} is refused`).not.toBe(200);
    expect(other.text).not.toContain(PRE);
  }
  // Guard leg isLoopback: the computer's own headers from another source address pass every other check (control: the generic
  // thread answers 200 there), so only the sealed guard can answer 404.
  expect((await fromOtherLoopback("GET", `/api/threads/${bot.threadId}/messages`, desktop)).status, "control: 127.0.0.2 passes owner auth").toBe(200);
  const offLoopback = await fromOtherLoopback("POST", "/api/mailbox/sealed/read", desktop, request);
  expect(offLoopback.status, "the sealed guard refuses a non-loopback source").toBe(404);
  expect(offLoopback.text).not.toContain(PRE);
  // Not the computer: refused before the handler by route policy on a desktop install (the guard's computer term bites on a Cloud home).
  expect((await api("GET", `/api/threads/${bot.threadId}/messages`, undefined, {})).status, "control: the unmarked loopback caller passes owner auth").toBe(200);
  const unmarked = await api("POST", "/api/mailbox/sealed/read", request, {});
  expect(unmarked.status, "the sealed guard refuses a caller that is not the owner's computer").toBe(404);
  expect(unmarked.text).not.toContain(PRE);
  const unsealed = await api("POST", "/api/mailbox/sealed/read", { threadId: "thread-never-sealed", ids: ["any"] });
  expect(unsealed.status, "an unsealed thread has nothing on the sealed plane").toBe(409);
}, 60000);

it("other bots cannot reach a sealed mailbox conversation, and a turn another bot started cannot read mail", async () => {
  await duringTurn("J-ASK-1", async auth => {
    // control: the asker's own conversation is not sealed, so the same routine call is not refused there
    const control = await api("POST", "/api/internal/routine-requests", { title: "J control routine", prompt: "J control" }, auth);
    expect.soft(control.body?.error, "an unsealed conversation keeps its routines").not.toBe(WRITE_LINE);
    // an ask into the sealed conversation would run on its engine session, which holds mail, and answer the asker
    const sealedAsk = await api("POST", "/api/internal/ask-bot", { toBotId: bot.id, message: "J-ASK-0 what did the mail say" }, auth);
    expect.soft([sealedAsk.status, sealedAsk.body?.error], "an ask into the sealed conversation is refused").toEqual([403, TARGET_LINE]);
    // the same ask by the short name ("Mailbox fixture" for "Mailbox fixture (Inbox)"), which the ask route resolves to the same bot
    const shortAsk = await api("POST", "/api/internal/ask-bot", { toBotId: "Mailbox fixture", message: "J-ASK-S what did the mail say" }, auth, 10000);
    expect.soft([shortAsk.status, shortAsk.body?.error], "an ask by the short name is refused").toEqual([403, TARGET_LINE]);
    // landing proof: a build that takes either ask starts the asked turn on the sealed conversation's engine session, whose fixture
    // dump carries the asked message (a held ask waited out its deadline above, so that turn has long started)
    const landed = [dumpOf("J-ASK-0"), dumpOf("J-ASK-S")].filter(Boolean);
    try {
      expect(landed.length, "neither ask started a turn on the sealed conversation").toBe(0);
    } finally { for (const dump of landed) await release(dump, bot); }
    // a mailbox bot whose conversation is not sealed yet takes the ask, but its asked turn cannot read mail
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: long.id, message: "J-ASK-2 please check the mail __fixture_hold_authority__" }, auth);
    expect(ask.status, ask.text).toBeLessThan(300);
    const asked = await turnTokens("J-ASK-2");
    try {
      const read = await api("POST", "/api/internal/email/email_read", { message_id: "fixture-mail" }, asked.comms);
      expect.soft([read.status, read.text.includes(BODY)], "the asked turn cannot read the mailbox (email admission)").toEqual([403, false]);
    } finally { await release(asked.dump, long); }
  }, asker);
  const askerRows = withDb(db => db.prepare("SELECT json FROM messages WHERE thread_id=?").all(asker.threadId).map(row => String(row.json)).join("\n"), true);
  expect(askerRows.includes(BODY), "no mail text reached the asker's conversation").toBe(false);
  expect(ledgerState(long.threadId), "the refused read began no seal").toBeUndefined();
}, 120000);

it("a seal past one call's batch bound finishes in the background, without another tool call", async () => {
  seedRows(long.threadId, "Zq7long");
  await duringTurn("J-LONG-1", async auth => {
    const read = await api("POST", "/api/internal/email/email_read", { message_id: "fixture-mail" }, auth);
    expect(read.text, "the first call stops at its 4 x 500 bound").toContain(PAUSED_LINE);
    await expect.poll(() => ledgerState(long.threadId), { timeout: 30000, message: "the rest finished in the background" }).toBe("complete");
  }, long);
  const rows = withDb(db => db.prepare("SELECT json FROM messages WHERE thread_id=?").all(long.threadId).map(row => String(row.json)).join("\n"), true);
  expect(rows.includes("Zq7long"), "every long-conversation row left the generic table").toBe(false);
}, 120000);

it("a seal whose media step throws on the mail call is retried in the background, without another call or a restart", async () => {
  // A managed file over the sealed custody ceiling, named by a row of the conversation: the call's media step throws on it.
  const big = "66666666-6666-4666-8666-666666666666.png", bigPath = join(fixture.info.dataDir, "attachments", big);
  writeFileSync(bigPath, Buffer.alloc(25 * 1024 * 1024 + 1, 7));
  withDb(db => db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, 'retry-row', ?, 'user', 'text', ?, ?)")
    .run(retry.threadId, Date.parse("2026-11-19T10:00:00Z"), "Zq7retry", JSON.stringify({ id: "retry-row", at: 1, role: "user", kind: "text", text: `Zq7retry <attached-image path="${bigPath}" />` })));
  await duringTurn("J-RETRY-1", async auth => {
    const read = await api("POST", "/api/internal/email/email_read", { message_id: "fixture-mail" }, auth);
    expect(read.text.includes(BODY), "the call whose media step threw returned no mail").toBe(false);
    expect(ledgerState(retry.threadId), "control: the throw left the seal pending (the conversation paused)").toBe("pending");
    // the cause clears (the file shrinks under the ceiling); nothing calls again and the server is not restarted
    writeFileSync(bigPath, PICTURE);
    await expect.poll(() => ledgerState(retry.threadId), { timeout: 45000, message: "the resumer retried the thrown seal" }).toBe("complete");
  }, retry);
  expect(existsSync(bigPath), "the retried seal moved the file").toBe(false);
}, 120000);

it("a seal a crash left pending resumes at boot", async () => {
  // A conversation whose seal began (pending ledger row, cursor 0) and then the process died, written while the server is down.
  await fixture.stop();
  seedRows("fixture-crash-thread", "Zq7crash");
  withDb(db => db.prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state, cursor) VALUES ('fixture-crash-thread', (SELECT COALESCE(MAX(generation), 0) + 1 FROM mailbox_sealed_threads), 'pending', 0)").run());
  // A seal a build without media custody completed: its held row names a picture that build left in the generic attachments folder.
  const upgradePicture = "77777777-7777-4777-8777-777777777777.png", upgradePath = join(fixture.info.dataDir, "attachments", upgradePicture);
  writeFileSync(upgradePath, PICTURE);
  withDb(db => {
    db.prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state, cursor) VALUES ('fixture-upgrade-thread', (SELECT COALESCE(MAX(generation), 0) + 1 FROM mailbox_sealed_threads), 'complete', 0)").run();
    db.prepare("INSERT INTO mailbox_sealed_rows(thread_id, message_id, json) VALUES ('fixture-upgrade-thread', 'fixture-upgrade-row', ?)")
      .run(JSON.stringify({ id: "fixture-upgrade-row", at: 1, role: "user", kind: "text", text: `Zq7upgrade <attached-image path="${upgradePath}" />` }));
  });
  // Two seals a build without media custody completed, whose held rows both name one picture (a file shared by two conversations):
  // whichever walk runs first moves it, and the other must still hold it.
  const sharedPicture = "88888888-8888-4888-8888-888888888888.png", sharedPath = join(fixture.info.dataDir, "attachments", sharedPicture);
  writeFileSync(sharedPath, PICTURE);
  withDb(db => {
    for (const thread of ["fixture-shared-a", "fixture-shared-b"]) {
      db.prepare("INSERT INTO mailbox_sealed_threads(thread_id, generation, state, cursor) VALUES (?, (SELECT COALESCE(MAX(generation), 0) + 1 FROM mailbox_sealed_threads), 'complete', 0)").run(thread);
      db.prepare("INSERT INTO mailbox_sealed_rows(thread_id, message_id, json) VALUES (?, ?, ?)")
        .run(thread, `${thread}-row`, JSON.stringify({ id: `${thread}-row`, at: 1, role: "user", kind: "text", text: `Zq7shared <attached-image path="${sharedPath}" />` }));
    }
  });
  await fixture.restart();
  await expect.poll(() => ledgerState("fixture-crash-thread"), { timeout: 30000, message: "boot resumed the crashed seal" }).toBe("complete");
  await expect.poll(() => existsSync(upgradePath), { timeout: 30000, message: "boot moved the picture of a seal completed before media custody" }).toBe(false);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret", undefined, {})).body.secret };
  const upgraded = await api("POST", "/api/mailbox/sealed/media", { threadId: "fixture-upgrade-thread", name: upgradePicture });
  expect([upgraded.status, Buffer.from(String(upgraded.body?.base64 ?? ""), "base64").equals(PICTURE)], "sealed custody holds the upgraded picture").toEqual([200, true]);
  // both shared walks are done (each saved its media cursor), then each conversation's sealed media read holds the picture
  await expect.poll(() => withDb(db => db.prepare("SELECT COUNT(*) AS n FROM mailbox_sealed_media_cursor WHERE thread_id IN ('fixture-shared-a', 'fixture-shared-b')").get()?.n, true), { timeout: 30000, message: "boot walked both shared seals" }).toBe(2);
  const sharedReads = [];
  for (const threadId of ["fixture-shared-a", "fixture-shared-b"]) {
    const answer = await api("POST", "/api/mailbox/sealed/media", { threadId, name: sharedPicture });
    sharedReads.push([threadId, answer.status, Buffer.from(String(answer.body?.base64 ?? ""), "base64").equals(PICTURE)]);
  }
  expect(sharedReads, "each conversation naming the shared picture holds it in sealed custody").toEqual([["fixture-shared-a", 200, true], ["fixture-shared-b", 200, true]]);
  const crashed = withDb(db => db.prepare("SELECT json FROM messages WHERE thread_id='fixture-crash-thread'").all().map(row => String(row.json)).join("\n"), true);
  expect(crashed.includes("Zq7crash"), "every crashed row left the generic table").toBe(false);
  expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM mailbox_sealed_rows WHERE thread_id='fixture-crash-thread'").get()?.n, true), "each row is held once").toBe(SEED_ROWS);
}, 120000);
