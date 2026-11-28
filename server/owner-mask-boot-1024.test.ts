// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1024-ownermaskboot (MAIN HIGH, new in 1.0.23; owner-chat-no-holds). Owners: lane q1024-ownermaskboot-fable owns these witnesses and
// the change to the one owner-zone rule (redact.ts ownerZoneGrade); the rule's users = owner-display.ts ownerMaskedReplyText,
// harness/masked-values.ts (the recorder's credential grade), store.ts and transcript-page.ts (the owner view); rulings = MAIN.
//
// Field report: right after a quit and restart the owner's own chat showed his test value as a redaction marker, cut the reply off
// mid-sentence, and showed the next reply whole as one marker. The cause is the SHAPE of those replies, not the restart (BOOT-pre
// below fails on the base before any restart): a short labelled value with words after it on the same line (inline code, then the
// sentence goes on). The scanner cannot bound such a value and hands the rest of the line in; the owner-zone rule graded that whole
// rest by its length (16 or more: a credential), so (1) the reply lost everything after the label, (2) the turn's recorder marked the
// line credential grade and every bare repeat of the short value was masked as a part of it, (3) a reply that repeated it more than
// once was masked whole (fail closed).
//
// Real server (scripts/control-murage.ts), real dispatch (POST /api/bots/:id/messages), the real Claude driver over the fake CLI, a real
// server restart (fixture.restart: the same data dir, a new process). Read back three ways: the live SSE message frame, the
// transcript read (GET /api/threads/:id/messages) and the saved row (messages.db).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";
import { redactOwnerZone } from "./redact.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const WS = mkdtempSync(join(tmpdir(), "ownermaskboot-ws-"));
// generated fixture values, assembled at run time
const SHORT = ["D", "4821"].join("-");
const LONG24 = "Hy3Pz8Qa" + "5Rc1Vb6M" + "n2Ks7Lx4";
const NOTES = join(WS, "test-notes.txt");
writeFileSync(NOTES, `token: ${SHORT}\n`);
// the reply of the first owner turn after the restart, as the field report has it
const AFTER = `Yes, I'm still here, and this chat carried over through the restart. The token you asked me to save is ${SHORT}, and your test pet's name is Pickle. I also reopened the test notes file in this chat's outputs folder, and the line \`token: ${SHORT}\` is still there, unchanged.`;
// the reply of the turn after it: the value quoted twice with words after it, and once spelled apart before that (on base the
// recorder graded the quoted line a credential, no single word repeats it but the reply as a whole does, so the WHOLE reply became
// one marker: owner-display.ts maskRepeatsInPlace, fail closed)
const PROBE = `Spelled out, the value is ${SHORT.split("-").join(" - ")}. (a) Your earlier message has \`token: ${SHORT}\` and (b) the file has \`token: ${SHORT}\` when I open it now.`;
// the recorder alone: a TOOL prints the line with words after the value, the reply repeats the bare value under no label
const TOOL_OUT = `checked the notes: the line \`token: ${SHORT}\` is still there, unchanged.\n`;
const BARE = `I checked, and the value is ${SHORT} as before.`;
// guards: a real key under the label keeps its mask whatever follows it, and a key-like token later on the label's line counts
const KEYED = `The notes still have \`token: ${LONG24}\` in them, unchanged.`;
const LATER = `The config still has \`token: old ${LONG24}\` in it, unchanged.`;
// MAIN-RULING ownermask 2026-11-27. H1: the mask replaces only the secret; the words after it stay. H2: a password label always
// masks its value in place, whatever its length or shape.
const mark = (n: number) => `«redacted ${n} chars»`;
const KEYED_SHOWN = `The notes still have \`token: ${mark(24)}\` in them, unchanged.`;
const LATER_SHOWN = `The config still has \`token: ${mark(28)}\` in it, unchanged.`;
const PHRASE = ["correct", "horse", "battery", "staple"].join(" ");
const PASS = `Saved. The line \`password: ${PHRASE}\` is in the notes now, and your test pet is still Pickle.`;
const PASS_SHOWN = `Saved. The line \`password: ${mark(28)}\` is in the notes now, and your test pet is still Pickle.`;
const TINY = ["hu", "nt2"].join("");
const SHORTPASS = `The notes say \`password: ${TINY}\` and \`token: ${SHORT}\`, both unchanged.`;
const SHORTPASS_SHOWN = `The notes say \`password: ${mark(5)}\` and \`token: ${SHORT}\`, both unchanged.`;
// the recorder with a REAL key: a tool prints the labelled key with words after it, the reply repeats the key bare among words
const KEY_TOOL_OUT = `checked the notes: the line \`token: ${LONG24}\` is still there, unchanged.\n`;
const KEY_BARE = `I checked: the key is ${LONG24} and the line is still there, unchanged.`;
const KEY_BARE_SHOWN = `I checked: the key is ${mark(24)} and the line is still there, unchanged.`;
// H1 at the recorder and the repeat mask (owner-display.ts maskRepeatsInPlace). REPEAT: the reply after a short password repeats it
// inside a link (the recorder read the two replies as one line and took the password plus the next reply's first word for the secret,
// so the next reply was masked whole). SPREAD: a reply spells a key a tool printed in spaced groups (no single word repeats it).
const REPEAT_A = `Your password: ${TINY}`;
const REPEAT_B = `Next: open https://example.invalid/cb?token=${TINY} and sign in.`;
const REPEAT_SHOWN = [`Your password: ${mark(5)}`, `Next: open https://example.invalid/cb?token=${mark(5)} and sign in.`];
// (five groups, 5+5+5+5+4: the smallest runs that repeat pair four of them, and the last group must not be left in clear beside them)
const SPREAD = `Spelled out, the key is ${LONG24.match(/.{1,5}/g)!.join(" ")} and the line is unchanged.`;
const SPREAD_SHOWN = `Spelled out, the key is ${mark(28)} and the line is unchanged.`;
// H2 on the real path for the labels the strict scanner does not know: the strict projection of this reply is clean
const PIN = ["48", "21"].join(""), PWD = ["abc", "7"].join(""), QUOTED = ["blue", "sky", "nine"].join(" ");
const PINS = `Saved all three.\nYour door pin: ${PIN} is set.\nThe wifi passphrase: "${QUOTED}" (the old one).\nAnd pwd=${PWD} for the printer, as before.`;
// r5: an undelimited value runs up to the punctuation after it (` is set`, ` for the printer` are masked with it: no word ends a
// password, fail closed under ruling H2 "ALWAYS ... whatever its length or shape"); the quoted one loses only itself
const PINS_SHOWN = `Saved all three.\nYour door pin: ${mark(11)}.\nThe wifi passphrase: "${mark(13)}" (the old one).\nAnd pwd=${mark(20)}, as before.`;
// H1 + H2 for an undelimited password of more than one word (lane D4): the whole passphrase is masked, in prose as on a record line,
// and a password with a sentence going on after it loses only itself
// a passphrase that holds words a sentence could go on with (`is`, `here`): no word ends an undelimited password, punctuation does
const WORDY = ["summer", "is", "here", "2024"].join(" ");
// third line (H1): a real key under a password label is the whole value by itself, the words after it are kept; fourth and fifth: the phrase ends before the next secret label (where its name starts); sixth: a password of punctuation only
const PHRASES = `Your password: ${PHRASE}\nPassword: ${WORDY}, and tell me when you are done.\nSet it as password: ${LONG24} and then restart\n${["DB", "PASSWORD"].join("_")}=${TINY}xyz and ${["BUILD", "TOKEN"].join("_")}=shortval9\nPassword: ${TINY} and token = shortval9\nYour pwd: !!!!`;
const PHRASES_SHOWN = `Your password: ${mark(28)}\nPassword: ${mark(19)}, and tell me when you are done.\nSet it as password: ${mark(24)} and then restart\n${["DB", "PASSWORD"].join("_")}=${mark(12)} ${["BUILD", "TOKEN"].join("_")}=shortval9\nPassword: ${mark(9)} token = shortval9\nYour pwd: ${mark(4)}`;
type Step = [kind: "text" | "tool" | "read" | "quote", text: string];
const again = (steps: Step[]) => [steps, steps, steps, steps];
// one engine instance per row; the script is the same for every turn of an instance (a restarted server starts a new engine process)
const SCRIPTS: Record<string, Step[][]> = {
  boot: again([["read", NOTES], ["text", AFTER]]),
  probe: again([["read", NOTES], ["text", PROBE]]),
  bare: again([["tool", TOOL_OUT], ["text", BARE]]),
  keyed: again([["text", KEYED]]),
  later: again([["text", LATER]]),
  pass: again([["text", PASS]]),
  shortpass: again([["text", SHORTPASS]]),
  keytool: again([["tool", KEY_TOOL_OUT], ["text", KEY_BARE]]),
  repeat: again([["text", REPEAT_A], ["text", REPEAT_B]]),
  spread: again([["tool", KEY_TOOL_OUT], ["text", SPREAD]]),
  pins: again([["text", PINS]]),
  phrases: again([["text", PHRASES]]),
};

let fixture: VerificationServer, headers: Record<string, string> = {}, stream: SseRecorder;
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); } finally { db.close(); }
}
async function poll<T>(read: () => Promise<T | null> | T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 300)); }
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
async function connect() {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  stream = await openSse(`${fixture.info.url}/api/events`, headers);
}
async function turn(bot: { id: string; threadId: string }, text: string, n: number) {
  const threadId = bot.threadId;
  const seeded = new Set((await transcript(threadId)).map(m => m.id));
  const framesFrom = stream.frames.length;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= n && still >= 4 ? rows : null;
  }, 90_000);
  const read = engineReplies(ended ?? (await transcript(threadId)).filter(m => !seeded.has(m.id)));
  const stored = engineReplies(storedRows(threadId).filter(m => !seeded.has(m.id)));
  const frameOf = (id: string) => stream.frames.slice(framesFrom).filter(f => (f?.kind === "message" || f?.kind === "message.patch") && f.threadId === threadId && f.message?.id === id).at(-1)?.message?.text;
  return { ended: ended !== null, read: read.map(m => String(m.text ?? "")), rows: stored, live: read.map(m => String(frameOf(m.id) ?? "<no frame>")) };
}

async function createBot(script: string) {
  const created = await api("POST", "/api/bots", { name: `Fixture ${script}`, modelSelection: { instanceId: script, model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** What the owner reads of the turn's one reply, three ways; `strict` is the saved row's `text`, which every other reader takes. */
const views = (t: Awaited<ReturnType<typeof turn>>) => ({ read: t.read, live: t.live, saved: t.rows.map(m => String(m.ownerText?.text ?? m.text ?? "")) });
const strict = (t: Awaited<ReturnType<typeof turn>>) => t.rows.map(m => String(m.text ?? "")).join("\n");
const all = (reply: string) => ({ read: [reply], live: [reply], saved: [reply] });

describe("q1024-ownermaskboot, real turn path over a real restart: the owner's own chat never masks a short labelled value or cuts the reply after it", () => {
  let boot: { id: string; threadId: string }, probe: { id: string; threadId: string };
  let first: Awaited<ReturnType<typeof turn>> | undefined, second: Awaited<ReturnType<typeof turn>> | undefined;
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    const instances = Object.fromEntries(Object.entries(SCRIPTS).map(([name, turns]) => [name, { driver: "claudeAgent", displayName: `Claude fixture ${name}`, config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_SCRIPT: JSON.stringify(turns) } }]));
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs'); const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      Object.assign(cfg.instances, ${JSON.stringify(instances)});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    await connect();
  }, 90_000);
  afterAll(async () => { stream?.close(); await fixture?.close(); rmSync(WS, { recursive: true, force: true }); });

  it("BOOT-pre before any restart: the reply that quotes `token: D-4821` in inline code and goes on is read word for word (the cause is the reply, not the restart)", async () => {
    boot = await createBot("boot"); probe = await createBot("probe");
    const t = await turn(boot, `Save this for my test notes and repeat it back exactly: token: ${SHORT}`, 1);
    expect(t.ended).toBe(true);
    expect(views(t)).toEqual(all(AFTER));
    // the probe bot's chat exists before the restart too, so BOOT-second below is a turn of a carried chat
    expect((await turn(probe, "Read the notes file once.", 1)).ended).toBe(true);
  }, 240_000);

  it("BOOT-first restart, then the first owner turn: the value is shown and the reply is whole", async () => {
    stream.close();
    await fixture.restart();
    await connect();
    const t = first = await turn(boot, "I just quit and restarted. Still with me? What was the token value I asked you to save, and the pet's name?", 1);
    expect(t.ended).toBe(true);
    // base b8f09bb216: `... is «redacted 6 chars», ... and the line \`token: «redacted 35 chars»` (the value masked, the reply cut)
    expect(views(t)).toEqual(all(AFTER));
  }, 240_000);

  it("BOOT-second the turn after it: a reply that quotes the value twice with words after each is never one whole marker", async () => {
    const t = second = await turn(probe, "Your last reply showed the token as a redaction placeholder and cut off. Quote exactly what you see.", 1);
    expect(t.ended).toBe(true);
    // base b8f09bb216: «redacted N chars» for the whole reply
    expect(views(t)).toEqual(all(PROBE));
  }, 240_000);

  it("STRICT every other reader of those two saved rows (search, recall, quotes, a share) still gets the labelled value masked", () => {
    const saved = [first, second].map(t => (t?.rows ?? []).map(m => String(m.text ?? "")).join("\n"));
    expect(saved.map(text => text.length > 0 && !text.includes(`token: ${SHORT}`))).toEqual([true, true]);
  });

  it("BARE the recorder alone: a tool printed the line with words after the value; the reply's bare value under no label is shown", async () => {
    const t = await turn(await createBot("bare"), "Check the notes line for me.", 1);
    expect(t.ended).toBe(true);
    // base b8f09bb216: `... the value is «redacted 6 chars» as before.` (the tool's whole line was recorded credential grade)
    expect(views(t)).toEqual(all(BARE));
  }, 240_000);

  it("KEYED (H1) a 24-char labelled key with words after it: only the key is replaced, the words after it are kept, read, live and saved", async () => {
    const t = await turn(await createBot("keyed"), "Is the key still in the config?", 1);
    expect(t.ended).toBe(true);
    // base: `... \`token: «redacted 44 chars»` (everything after the label lost)
    expect(views(t)).toEqual(all(KEYED_SHOWN));
    expect(strict(t)).not.toContain(LONG24);
  }, 240_000);

  it("LATER (H1) a key later in a short label's inline code is masked in place and the sentence after it is kept", async () => {
    const t = await turn(await createBot("later"), "Where is the token?", 1);
    expect(t.ended).toBe(true);
    expect(views(t)).toEqual(all(LATER_SHOWN));
    expect(strict(t)).not.toContain(LONG24);
  }, 240_000);

  it("PASS (H2) a password label masks a passphrase of short words in place, and the reply after it is whole", async () => {
    const t = await turn(await createBot("pass"), "Save my passphrase line.", 1);
    expect(t.ended).toBe(true);
    expect(views(t)).toEqual(all(PASS_SHOWN));
    expect(strict(t)).not.toContain(PHRASE);
  }, 240_000);

  it("SHORTPASS (H2) a 5-char value under a password label is masked; the short value under the token label beside it is shown", async () => {
    const t = await turn(await createBot("shortpass"), "What do the notes say?", 1);
    expect(t.ended).toBe(true);
    expect(views(t)).toEqual(all(SHORTPASS_SHOWN));
    expect(strict(t)).not.toContain(TINY);
  }, 240_000);

  it("KEYTOOL (H1, recorder) a tool printed a labelled key with words after it; the reply's bare key is masked in place, never the whole reply", async () => {
    const t = await turn(await createBot("keytool"), "Check the key line for me.", 1);
    expect(t.ended).toBe(true);
    expect(views(t)).toEqual(all(KEY_BARE_SHOWN));
    expect(strict(t)).not.toContain(LONG24);
  }, 240_000);

  it("REPEAT (H1, recorder) the reply after a short password repeats it inside a link: masked in place there, the link and the words kept, never the whole reply", async () => {
    const t = await turn(await createBot("repeat"), "What is my password, and where do I sign in?", 2);
    expect(t.ended).toBe(true);
    // base: both shown as typed (a short password was not masked); lane tip 77e3c47cca: the second reply one whole marker
    expect(views(t)).toEqual({ read: REPEAT_SHOWN, live: REPEAT_SHOWN, saved: REPEAT_SHOWN });
    expect(strict(t)).not.toContain(TINY);
  }, 240_000);

  it("SPREAD (H1, repeat mask) a reply spells a key a tool printed in spaced groups: the groups are masked in place and every other word is kept", async () => {
    const t = await turn(await createBot("spread"), "Spell the key out for me.", 1);
    expect(t.ended).toBe(true);
    // base: the whole reply is one «redacted N chars» (maskRepeatsInPlace failed closed to the whole text)
    expect(views(t)).toEqual(all(SPREAD_SHOWN));
    for (const group of LONG24.match(/.{1,5}/g)!) expect(Object.values(views(t)).flat().join("\n")).not.toContain(group);
  }, 240_000);

  it("PINS (H2) pin, passphrase and pwd, labels the strict scanner does not know: each value is masked in place on the real path, the other lines and the words after its punctuation kept", async () => {
    const t = await turn(await createBot("pins"), "Save my door pin, wifi passphrase and printer pwd.", 1);
    expect(t.ended).toBe(true);
    // base: shown as typed (the projection is clean, the owner zone never ran)
    expect(views(t)).toEqual(all(PINS_SHOWN));
    for (const value of [PIN, QUOTED, PWD]) expect(strict(t)).not.toContain(value);
  }, 240_000);

  it("PHRASES (H2) an undelimited passphrase is masked whole, whatever words it holds, up to the punctuation after it; the words after that are kept", async () => {
    const t = await turn(await createBot("phrases"), "What are my two passwords?", 1);
    expect(t.ended).toBe(true);
    // base: shown as typed; lane tip e536b6bfc8: `horse battery staple` shown; lane tip 37ac990cb5 (a word list ended the password
    // at `is`): `is here 2024` shown. MAIN-RULING ownermask 2026-11-27 (H2): "Labels password/passphrase/passwd/pwd/pin/secret/private
    // key ALWAYS mask their value in place, whatever its length or shape."
    expect(views(t)).toEqual(all(PHRASES_SHOWN));
    for (const value of [PHRASE, WORDY, LONG24]) expect(strict(t)).not.toContain(value);
  }, 240_000);
});

// The rule's own table, one row per reply shape (a pin of each clause of the ruling, not a witness of the field report: the real-path
// rows above are). redactOwnerZone is the function owner-display.ts, store.ts and transcript-page.ts call for the owner's own chat.
describe("q1024-ownermaskboot, the owner zone masks only the secret's own characters (MAIN-RULING ownermask 2026-11-27)", () => {
  const K = LONG24, PW = ["DB", "PASSWORD"].join("_"), TK = ["API", "TOKEN"].join("_");
  const ROWS: Array<[name: string, text: string, shown: string]> = [
    ["H2 record line, bold label, passphrase", `- **Password:** ${PHRASE}`, `- **Password:** ${mark(28)}`],
    // r5 (fail closed, H2 over the H1 edge; was: `hunt2` only, by a word list): no word ends an undelimited password, punctuation does
    ["H2 prose, undelimited, words run on after it: masked up to the punctuation", `The password: ${TINY} is what I set, and more.`, `The password: ${mark(19)}, and more.`],
    ["H2 a passphrase of sentence words: all of it", `Your password: to be or not`, `Your password: ${mark(12)}`],
    ["H2 a passphrase with sentence words, then punctuation and the sentence", `Password: ${WORDY}; then log in.`, `Password: ${mark(19)}; then log in.`],
    ["H1 a real key under a password label, words after it: the key only", `Set it as password: ${K} and then restart`, `Set it as password: ${mark(24)} and then restart`],
    ["H1 a delimited password with words after it loses only itself", `Password: \`${TINY}\` expires Friday`, `Password: \`${mark(5)}\` expires Friday`],
    ["H2 prose, undelimited passphrase: all of it", `Your password: ${PHRASE}`, `Your password: ${mark(28)}`],
    ["H2 record line, words run on after the password with no punctuation: masked with it (fail closed)", `Password: ${TINY} then log in`, `Password: ${mark(17)}`],
    ["H2 passphrase, then punctuation and the sentence", `- **Password:** ${PHRASE}, as before.`, `- **Password:** ${mark(28)}, as before.`],
    ["H2 pin beside a short token", `\`pin: 4821\` and \`token: ${SHORT}\` are both saved.`, `\`pin: ${mark(4)}\` and \`token: ${SHORT}\` are both saved.`],
    ["H2 quoted passphrase", `passphrase: "blue sky nine" (the old one)`, `passphrase: "${mark(13)}" (the old one)`],
    ["H2 pwd= beside order and ref: masked up to the punctuation (fail closed; r4: `abc` only)", `pwd=abc and order: 7781 then ref: A-1`, `pwd=${mark(13)}: 7781 then ref: A-1`],
    ["H2 pwd=, punctuation, then order and ref", `pwd=abc, and order: 7781 then ref: A-1`, `pwd=${mark(3)}, and order: 7781 then ref: A-1`],
    ["H2 key=value names, no punctuation between: the phrase ends before the next secret label, which keeps its own rule", `${PW}=${TINY}xyz and ${TK}=shortval9`, `${PW}=${mark(12)} ${TK}=shortval9`],
    ["H2 the phrase ends where the next label's NAME starts: a spaced separator", `Password: ${TINY} and token = shortval9`, `Password: ${mark(9)} token = shortval9`],
    ["H2 the phrase ends where the next label's NAME starts: a two-word label", `pin: 4821 then private key: ${TINY}`, `pin: ${mark(9)} private key: ${mark(5)}`],
    ["H2 a password of punctuation only is masked", `Your pwd: !!!! and the rest.`, `Your pwd: ${mark(4)} and the rest.`],
    ["H1 edge (D15, the ruling's `a real key with words after it keeps those words`): a key-like first token is the whole value, words after it shown", `Password: ${K} blue sky`, `Password: ${mark(24)} blue sky`],
    ["H2 key=value names, punctuation between", `${PW}=${TINY}xyz; ${TK}=shortval9`, `${PW}=${mark(8)}; ${TK}=shortval9`],
    ["H2 the lines after a password line stay", `Password: ${TINY}\nThe next line stays.`, `Password: ${mark(5)}\nThe next line stays.`],
    ["H1 key on the line below its label", `token:\n${K}\nand the rest is kept.`, `token:\n${mark(24)}\nand the rest is kept.`],
    ["H1 bold label, key, then a sentence", `**Token:** ${K} is still valid, unchanged.`, `**Token:** ${mark(24)} is still valid, unchanged.`],
    ["H1 two labels on one line", `\`token: ${K}\` then \`secret: ${TINY}\` and the words after.`, `\`token: ${mark(24)}\` then \`secret: ${mark(5)}\` and the words after.`],
    ["short values under other labels are shown", `\`token: ${SHORT}\` is still there and code: 4821, id: 77, unchanged.`, `\`token: ${SHORT}\` is still there and code: 4821, id: 77, unchanged.`],
  ];
  it.each(ROWS)("ZONE %s", (_name, text, shown) => { expect(redactOwnerZone(text)).toBe(shown); });
});
