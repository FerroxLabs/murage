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
