// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// One write path for memory_records (PASTE-CAPTURE-FIX r2.7): every insert
// goes through insertMemoryRecord, which redacts and masks the text, so a row
// copied from an older unscrubbed row, or built from a raw payload excerpt,
// is stored without its digits.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import { approveMemory, ownerMemoryTicket } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { readBotIdentity, writeBotIdentity } from "./identity.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "bot", threadId: "thread" }, { id: "other", threadId: "thread-other" }], groups: [{ id: "room", threadId: "room-thread", memberIds: ["bot", "other"] }] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });

const SERVER = fileURLToPath(new URL("..", import.meta.url));
function sourceFiles(dir: string, out: string[] = []): string[] {
  // hidden folders are other tests' temporary fixtures (made and removed while this walk runs), never source
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name, path = join(dir, name);
    if (name.startsWith(".") || name === "node_modules" || name === "testing" || name === "testdata") continue;
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.isFile() && /\.(ts|mts|mjs)$/.test(name) && !/\.test\.|\.bench\./.test(name)) out.push(path);
  }
  return out;
}

it("only record-write.ts spells an insert into memory_records", () => {
  const spelled = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+memory_records\b/;
  const hits = sourceFiles(SERVER).filter((path) => spelled.test(readFileSync(path, "utf8"))).map((path) => relative(SERVER, path));
  expect(hits).toEqual([]);
  expect(readFileSync(join(SERVER, "memory", "record-write.ts"), "utf8")).toContain("INTO memory_records VALUES");
});

it("insertMemoryRecord masks the text and keeps its byte length", () => {
  const db = database();
  const scopeId = ensureScope("bot", "bot");
  insertMemoryRecord(db, { id: "r1", version: 1, scopeId, kind: "fact", text: "Pays rent from the account ending 4471", assertion: "owner-statement", state: "active", validFrom: 1, createdAt: 1 });
  const text = String(db.prepare("SELECT text FROM memory_records WHERE id='r1'").get()!.text);
  expect(text).toBe("Pays rent from the account ending ****");
  expect(Buffer.byteLength(text)).toBe(Buffer.byteLength("Pays rent from the account ending 4471"));
  // A second write of the same row is ignored when asked, as the chunk publisher asks.
  expect(insertMemoryRecord(db, { id: "r1", version: 1, scopeId, kind: "fact", text: "x", assertion: "owner-statement", state: "active", validFrom: 1, createdAt: 1 }, { orIgnore: true }).changes).toBe(0);
});

it("redaction of the whole chain is idempotent, so a caller that redacts first changes nothing", () => {
  for (const text of ["account ending 4471", "token=abcdefghijkl and card 4111 1111 1111 1111", "SSN 123-45-6789", "nothing here"]) {
    expect(redactSecretsInText(redactSecretsInText(text))).toBe(redactSecretsInText(text));
  }
});

it("keeps a pre-redacted marker and the following prose through a record save and restart", () => {
  const text = "token=abcdefghijkl and card 4111 1111 1111 1111";
  const expected = "token=«redacted 12 chars» and card **** **** **** ****";
  const scopeId = ensureScope("bot", "bot");
  const safe = redactSecretsInText(text);
  expect(safe).toBe(expected);
  insertMemoryRecord(database(), { id: "marker-record", version: 1, scopeId, kind: "fact", text: safe, assertion: "owner-statement", state: "active", validFrom: 1, createdAt: 1 });
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get("marker-record")!.text);
  expect(stored).toBe(expected);
  expect(redactSecretsInText(stored)).toBe(expected);
});

it.each([",", ";", ".", "!", "?", ":", ")", "]", "}", "'", '"', "`", "*", "—", "’"])("keeps generated marker punctuation %s through record save, reload and resave", (punctuation) => {
  const text = `token=abcdefghijkl${punctuation} then the meeting moved to 3pm`;
  const expected = punctuation === "." ? text.replace("abcdefghijkl.", "«redacted 13 chars»") : text.replace("abcdefghijkl", "«redacted 12 chars»");
  const scopeId = ensureScope("bot", "bot");
  const record = { id: "punctuation-record", version: 1, scopeId, kind: "fact" as const, text: redactSecretsInText(text), assertion: "owner-statement" as const, state: "active" as const, validFrom: 1, createdAt: 1 };
  expect(record.text).toBe(expected);
  insertMemoryRecord(database(), record);
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(record.id)!.text);
  expect(stored).toBe(expected);
  insertMemoryRecord(database(), { ...record, id: "punctuation-resaved", text: stored });
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get("punctuation-resaved")!.text).toBe(expected);
});

it.each([
  "token: «redacted 12 chars» then the meeting moved to 3pm",
  "token=abcdefghijkl then the meeting moved to 3pm",
  "token: «redacted 12 chars», then the meeting moved to 3pm",
  "token=abcdefghijkl, then the meeting moved to 3pm",
])("keeps prose through identity save, read, restart and resave: %s", (text) => {
  const ticket = ownerMemoryTicket();
  const expected = text.replace("abcdefghijkl", "«redacted 12 chars»");
  const input = { action: "identity-write" as const, botId: "bot", kind: "continuity-brief" as const, key: "core", expectedVersion: 0, text, basis: "fiction" as const, audience: "owner-private" as const };
  const saved = writeBotIdentity(ticket, input, roster);
  expect(readBotIdentity(ticket, "bot", roster).records[0].text).toBe(expected);
  closeDatabase();
  const read = readBotIdentity(ticket, "bot", roster).records[0];
  expect(read.text).toBe(expected);
  writeBotIdentity(ticket, { ...input, expectedVersion: 1, expectedId: saved.id, text: String(read.text) }, roster);
  expect(readBotIdentity(ticket, "bot", roster).records[0].text).toBe(expected);
});

it.each([
  ["wNonAsciiFollower", "token=abcdefghijklé then the meeting moved to 3pm", "token=«redacted 12 chars»é then the meeting moved to 3pm"],
  ["wMidLineMarker", `the old key ${"sk" + "-" + "q".repeat(24)} was revoked; password: see the vault entry\nnext line kept`, "the old key «redacted 27 chars» was revoked; password: see the vault entry\nnext line kept"],
  ["wFoldedAwsGluedFollower", `the old key ${"AK" + "IA" + "A".repeat(8) + "\n" + "A".repeat(8)}Z; password: see the vault entry\nnext line kept`, "the old key «redacted 21 chars»Z; password: see the vault entry\nnext line kept"],
  ["wGluedValueLongHead", `password=${"AK" + "IA" + "A".repeat(8) + "\n" + "A".repeat(8)}Z; rest of the note\nnext line kept`, "password=«redacted 22 chars»; rest of the note\nnext line kept"],
  ["wGluedValueStep", `password=${"AK" + "IA\n" + "A".repeat(16)}Z; see step 2\nnext line kept`, "password=«redacted 22 chars»; see step 2\nnext line kept"],
  ["wGluedValuePan", `password=${"AK" + "IA" + "A".repeat(15)}\nPAN ABCDE1234F`, "password= «redacted 34 chars»"],
  ["wGluedValueStatic", `password=${"AK" + "IA\n" + "A".repeat(16)}Z; rest\nnext line kept`, "password=«redacted 22 chars»; rest\nnext line kept"],
  // A bearer token after the glued letters is masked with them, never left readable (C6 precedence).
  ["wGluedValueBearer", `password=${"AK" + "IA" + "A".repeat(15)}\nBearer ${"q".repeat(24)}`, "password= «redacted 51 chars»"],
])("%s keeps prose through identity save, read, restart and resave", (_name, text, expected) => {
  const ticket = ownerMemoryTicket();
  const input = { action: "identity-write" as const, botId: "bot", kind: "continuity-brief" as const, key: "core", expectedVersion: 0, text, basis: "fiction" as const, audience: "owner-private" as const };
  const saved = writeBotIdentity(ticket, input, roster);
  expect(readBotIdentity(ticket, "bot", roster).records[0].text).toBe(expected);
  closeDatabase();
  const read = readBotIdentity(ticket, "bot", roster).records[0];
  expect(read.text).toBe(expected);
  writeBotIdentity(ticket, { ...input, expectedVersion: 1, expectedId: saved.id, text: String(read.text) }, roster);
  expect(readBotIdentity(ticket, "bot", roster).records[0].text).toBe(expected);
});

it("wSaveReload: a record write redacts twice and keeps the prose after a generated marker", () => {
  const scopeId = ensureScope("bot", "bot");
  const text = `the old key ${"sk" + "-" + "q".repeat(24)} was revoked; password: see the vault entry\nnext line kept`;
  const expected = "the old key «redacted 27 chars» was revoked; password: see the vault entry\nnext line kept";
  const record = { id: "marker-midline", version: 1, scopeId, kind: "fact" as const, text: redactSecretsInText(text), assertion: "owner-statement" as const, state: "active" as const, validFrom: 1, createdAt: 1 };
  insertMemoryRecord(database(), record);
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(record.id)!.text);
  expect(stored).toBe(expected);
  insertMemoryRecord(database(), { ...record, id: "marker-midline-resaved", text: stored });
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get("marker-midline-resaved")!.text).toBe(expected);
});

it("wSaveReload wFoldedAwsGluedFollower: a record write redacts twice and keeps the prose after a marker glued to a letter", () => {
  const scopeId = ensureScope("bot", "bot");
  const text = `the old key ${"AK" + "IA" + "A".repeat(8) + "\n" + "A".repeat(8)}Z; password: see the vault entry\nnext line kept`;
  const expected = "the old key «redacted 21 chars»Z; password: see the vault entry\nnext line kept";
  const record = { id: "marker-aws-glued", version: 1, scopeId, kind: "fact" as const, text: redactSecretsInText(text), assertion: "owner-statement" as const, state: "active" as const, validFrom: 1, createdAt: 1 };
  expect(record.text).toBe(expected);
  insertMemoryRecord(database(), record);
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(record.id)!.text);
  expect(stored).toBe(expected);
  insertMemoryRecord(database(), { ...record, id: "marker-aws-glued-resaved", text: stored });
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get("marker-aws-glued-resaved")!.text).toBe(expected);
});

it.each(["é", "中", "٣"])("wSaveReload wNonAsciiFollower %s: a record write redacts twice and keeps the prose after a generated marker", (follower) => {
  const scopeId = ensureScope("bot", "bot");
  const text = `token=abcdefghijkl${follower} then the meeting moved to 3pm`;
  const expected = `token=«redacted 12 chars»${follower} then the meeting moved to 3pm`;
  const record = { id: "marker-non-ascii", version: 1, scopeId, kind: "fact" as const, text: redactSecretsInText(text), assertion: "owner-statement" as const, state: "active" as const, validFrom: 1, createdAt: 1 };
  expect(record.text).toBe(expected);
  insertMemoryRecord(database(), record);
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(record.id)!.text);
  expect(stored).toBe(expected);
  insertMemoryRecord(database(), { ...record, id: "marker-non-ascii-resaved", text: stored });
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get("marker-non-ascii-resaved")!.text).toBe(expected);
});

/** A source captured, then given the raw 1.0.3 payload (the same byte length), and its capture job published. */
function legacySource(raw: string) {
  const db = database();
  captureSource(db, { id: "legacy", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: raw });
  db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.text',?) WHERE source_id='legacy'").run(raw);
  let id = "";
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) {
    id = work.id;
    publishMemoryWork(work, "fixture", captureWork(work));
  }
  return id;
}

it("a checkpoint consolidated from an unscrubbed 1.0.3 source holds no digit of the card", () => {
  const raw = "Use card 4111 1111 1111 1111 for the deposit at Frost Bank.";
  const job = legacySource(raw);
  const db = database();
  expect(String(db.prepare("SELECT json_extract(payload,'$.text') AS t FROM memory_source_versions WHERE source_id='legacy'").get()!.t)).toContain("4111");
  expect(refreshMemoryCheckpoint(job)).toMatchObject({ status: "updated" });
  const checkpoint = String(db.prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").get()!.text);
  expect(checkpoint).toContain("**** **** **** ****");
  expect(checkpoint).not.toMatch(/4111/);
  // The chunk the worker cut from the raw payload is masked too.
  const chunk = String(db.prepare("SELECT text FROM memory_records WHERE kind='source'").get()!.text);
  expect(chunk).toBe("Use card **** **** **** **** for the deposit at Frost Bank.");
  // Refreshed again on the same evidence it is unchanged, not a new version each time.
  expect(refreshMemoryCheckpoint(job)).toMatchObject({ status: "unchanged" });
});

it("promote and scope copy of an unscrubbed record store a masked copy", async () => {
  const db = database();
  const ticket = ownerMemoryTicket();
  const scope = ensureScope("bot", "bot"), room = ensureScope("room", "room");
  // Rows as 1.0.3 wrote them: raw digits, written with SQL as the old code did.
  db.prepare("INSERT INTO memory_records VALUES('old-fact',1,?,'fact','Routing 021000021 for payroll','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  db.prepare("INSERT INTO memory_records VALUES('old-candidate',1,?,'fact','Visa ending in 1234 is the backup card','assistant-inference','candidate',0,1,NULL,NULL,1)").run(scope);
  const promoted = await memoryOwnerRoute("/api/memory/action", { action: "promote", id: "old-fact", version: 1, scopeId: room }, ticket, roster) as { record: { id: string } };
  expect(String(db.prepare("SELECT text FROM memory_records WHERE id=?").get(promoted.record.id)!.text)).toBe("Routing ********* for payroll");
  const copy = approveMemory(ticket, "old-candidate", 1, { scopeId: room });
  expect(String(db.prepare("SELECT text FROM memory_records WHERE id=?").get(copy)!.text)).toBe("Visa ending in **** is the backup card");
});

it.each([
  ["wGluedValueLongHead", `password=${"AK" + "IA" + "A".repeat(8) + "\n" + "A".repeat(8)}Z; rest of the note\nnext line kept`, "password=«redacted 22 chars»; rest of the note\nnext line kept"],
  ["wGluedValueStep", `password=${"AK" + "IA\n" + "A".repeat(16)}Z; see step 2\nnext line kept`, "password=«redacted 22 chars»; see step 2\nnext line kept"],
  ["wGluedValuePan", `password=${"AK" + "IA" + "A".repeat(15)}\nPAN ABCDE1234F`, "password= «redacted 34 chars»"],
  ["wGluedValueStatic", `password=${"AK" + "IA\n" + "A".repeat(16)}Z; rest\nnext line kept`, "password=«redacted 22 chars»; rest\nnext line kept"],
  // A bearer token after the glued letters is masked with them, never left readable (C6 precedence).
  ["wGluedValueBearer", `password=${"AK" + "IA" + "A".repeat(15)}\nBearer ${"q".repeat(24)}`, "password= «redacted 51 chars»"],
])("wSaveReload %s: a record write redacts twice and keeps the prose after a folded AWS ID value glued to a letter", (name, text, expected) => {
  const scopeId = ensureScope("bot", "bot");
  const record = { id: `marker-${name}`, version: 1, scopeId, kind: "fact" as const, text: redactSecretsInText(text), assertion: "owner-statement" as const, state: "active" as const, validFrom: 1, createdAt: 1 };
  expect(record.text).toBe(expected);
  insertMemoryRecord(database(), record);
  closeDatabase();
  const stored = String(database().prepare("SELECT text FROM memory_records WHERE id=?").get(record.id)!.text);
  expect(stored).toBe(expected);
  insertMemoryRecord(database(), { ...record, id: `marker-${name}-resaved`, text: redactSecretsInText(stored) });
  expect(database().prepare("SELECT text FROM memory_records WHERE id=?").get(`marker-${name}-resaved`)!.text).toBe(expected);
});
