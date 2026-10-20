// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rules 23 and 24, test 36 (aggregate part): a legacy memory source anchored at a Murage-voice message is withheld from a
// bot reader at every revision, and so is every aggregate citing it (evidence records, derived records, receipt lines, a project summary).
// The read writes nothing. The anchor check lives in its own leaf module, so the door (deny-read.ts) reaches it without importing bot-read.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { channelToProjectRows } from "../project-settings.ts";
import { projectSummaryLayer, type ProjectMemberView } from "../project-layers.ts";
import { memoryLookup, refsLookup } from "./deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const thread = "anchor-t", NOW = 1_700_000_000_000;
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const message = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `words ${id}`, at: NOW, from: { botId: "b", name: "B", color: "#000" }, ...extra });

/** Two messages (a Murage line and a plain bot reply), a source anchored at each with revisions 1 and 2, records resting on them and a
 * derived chain: plain-child <- murage-parent (evidence: the Murage source), grand <- mid <- murage-parent. */
function fixture() {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  appendMessage(thread, message("plain"));
  appendMessage(thread, message("line", { murageLine: true } as Partial<Message>));
  const db = database(), scope = ensureScope("conversation", thread);
  db.exec("BEGIN");
  const source = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,2,'hash','text','bot:b','settled',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,?,'hash','{}',1)");
  for (const [id, anchor] of [["s-plain", "plain"], ["s-line", "line"]] as const) { source.run(id, scope, thread, anchor); version.run(id, 1); version.run(id, 2); }
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact',?,'a','active',0,1,NULL,NULL,1)");
  const evidence = db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,?,0,1)");
  const derive = db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,?,1)");
  for (const id of ["r-plain", "r-line", "r-mixed", "r-child", "r-mid", "r-grand", "r-clean-child"]) record.run(id, scope, `text ${id}`);
  evidence.run("r-plain", "s-plain", 2);
  evidence.run("r-line", "s-line", 1);                                      // an older revision of the Murage source: still its anchor
  evidence.run("r-mixed", "s-plain", 2); evidence.run("r-mixed", "s-line", 2);
  derive.run("r-line", "r-child");
  derive.run("r-line", "r-mid"); derive.run("r-mid", "r-grand");
  derive.run("r-plain", "r-clean-child");
  const receipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'drv','sess',?,?,'[]',0,0,0,'delivered',9)");
  receipt.run("rc-plain", thread, JSON.stringify([{ id: "r-plain", version: 1 }]), JSON.stringify([{ id: "s-plain", revision: 2 }]));
  receipt.run("rc-source", thread, "[]", JSON.stringify([{ id: "s-plain", revision: 2 }, { id: "s-line", revision: 1 }]));
  receipt.run("rc-record", thread, JSON.stringify([{ id: "r-grand", version: 1 }]), "[]");
  db.exec("COMMIT");
  return db;
}
const verdictOf = (db: ReturnType<typeof database>, ref: MemoryRef) => memoryLookup(db, [ref], { audience: null }).get(memoryRefKey(ref));
const anchorWithheld = { state: "withheld", reason: "murage-anchor" };

/** Everything the read might write: deny marks, revoke jobs, the deny generation, the lsn allocator, a summary's stale flag. */
function written(db: ReturnType<typeof database>) {
  const one = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return [one("SELECT * FROM memory_deny_memory"), one("SELECT * FROM memory_revoke_jobs"), one("SELECT * FROM memory_lineage_lsn_meta ORDER BY key"),
    one("SELECT * FROM memory_lsn"), one("SELECT group_id,version,stale FROM project_summaries ORDER BY version")];
}

it("rule 24: a source anchored at a Murage-voice message reads withheld('murage-anchor') at every revision; a plain source is shown", () => {
  const db = fixture();
  for (const version of [undefined, 1, 2]) {
    expect(verdictOf(db, { kind: "source", id: "s-line", ...(version ? { version } : {}) }), `revision ${version}`).toEqual(anchorWithheld);
    expect(verdictOf(db, { kind: "source", id: "s-plain", ...(version ? { version } : {}) }), `revision ${version}`).toEqual({ state: "shown" });
  }
});

it("rule 23: a record whose evidence cites a Murage-anchored source is withheld, on the batched (versioned) and the single path", () => {
  const db = fixture();
  for (const id of ["r-line", "r-mixed"]) {
    expect(verdictOf(db, { kind: "record", id, version: 1 }), id).toEqual(anchorWithheld);
    expect(verdictOf(db, { kind: "record", id }), id).toEqual(anchorWithheld);
  }
  expect(verdictOf(db, { kind: "record", id: "r-plain", version: 1 })).toEqual({ state: "shown" });
  expect(verdictOf(db, { kind: "record", id: "r-plain" })).toEqual({ state: "shown" });
  // one lookup over several refs keys each on its own
  const many = memoryLookup(db, [{ kind: "record", id: "r-plain", version: 1 }, { kind: "record", id: "r-line", version: 1 }], { audience: null });
  expect(many.get(memoryRefKey({ kind: "record", id: "r-plain", version: 1 }))).toEqual({ state: "shown" });
  expect(many.get(memoryRefKey({ kind: "record", id: "r-line", version: 1 }))).toEqual(anchorWithheld);
});

it("rule 23: a derived record follows its parents' citations through the derivation chain", () => {
  const db = fixture();
  expect(verdictOf(db, { kind: "record", id: "r-child", version: 1 })).toEqual(anchorWithheld);
  expect(verdictOf(db, { kind: "record", id: "r-grand", version: 1 })).toEqual(anchorWithheld);
  expect(verdictOf(db, { kind: "record", id: "r-grand" })).toEqual(anchorWithheld);
  expect(verdictOf(db, { kind: "record", id: "r-clean-child", version: 1 })).toEqual({ state: "shown" });
});

it("rule 23: a derivation cycle ends, and a chain longer than the bound reads 'checking', never shown", () => {
  const db = fixture();
  db.exec("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES('r-clean-child',1,'r-plain',1)");
  expect(verdictOf(db, { kind: "record", id: "r-clean-child", version: 1 })).toEqual({ state: "shown" });
  const scope = String((db.prepare("SELECT scope_id FROM memory_records WHERE id='r-plain'").get() as { scope_id: string }).scope_id);
  db.exec("BEGIN");
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES(?,1,?,'fact','x','a','active',0,1,NULL,NULL,1)");
  const derive = db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,1,?,1)");
  let parent = "r-plain";
  for (let n = 0; n < 300; n++) { record.run(`long-${n}`, scope); derive.run(parent, `long-${n}`); parent = `long-${n}`; }
  db.exec("COMMIT");
  expect(verdictOf(db, { kind: "record", id: parent, version: 1 })?.state).toBe("checking");
});

it("rule 23: a receipt line citing a Murage-anchored source, or a record resting on one, is withheld from the bot reader", () => {
  const db = fixture();
  const receipt = (bundleId: string) => refsLookup(db, [{ kind: "receipt", bundleId, lsn: Number.MAX_SAFE_INTEGER, scopeIds: [] }], { audience: null });
  expect(receipt("rc-plain")).toEqual({ state: "shown" });
  expect(receipt("rc-source")).toEqual(anchorWithheld);
  expect(receipt("rc-record")).toEqual(anchorWithheld);
});

it("rule 23: a project summary citing a Murage-voice message is withheld from the bot (the deterministic summary instead); the thread comes from the project's threads", () => {
  const db = fixture();
  channelToProjectRows(db, { groupId: "p1", bulletin: "B", leadBotId: "finch", now: NOW });
  const names = new Map([["finch", "Finch"], ["dax", "Dax"]]);
  const view = (threads?: ReadonlySet<string>): ProjectMemberView => ({ groupId: "p1", botId: "dax", names, ...(threads ? { threads } : {}) });
  db.prepare("INSERT INTO project_summaries(group_id, version, text, source_message_ids, made_by, at, stale) VALUES('p1',1,'CLEAN_SUMMARY','[\"plain\"]','finch',?,0)").run(NOW);
  expect(projectSummaryLayer(db, view(new Set(["other", thread])), true)).toContain("CLEAN_SUMMARY");
  db.prepare("INSERT INTO project_summaries(group_id, version, text, source_message_ids, made_by, at, stale) VALUES('p1',2,'MURAGE_SUMMARY','[\"plain\",\"line\"]','finch',?,0)").run(NOW);
  const before = written(db);
  const cited = new Set<string>();
  const text = projectSummaryLayer(db, view(new Set(["other", thread])), true, undefined, cited);
  expect(text).not.toContain("MURAGE_SUMMARY");
  expect(cited.size, "a withheld summary cites nothing").toBe(0);
  // a message id the project's threads do not hold is an unknown anchor, not admissible (fail closed); with no project threads known the
  // summary cannot be proved either
  expect(projectSummaryLayer(db, view(new Set(["other"])), true)).not.toContain("MURAGE_SUMMARY");
  expect(projectSummaryLayer(db, view(), true)).not.toContain("MURAGE_SUMMARY");
  expect(written(db)).toEqual(before);
  // the reader never scans messages by id alone: it seeks (thread_id, id) for each project thread
  const layers = readFileSync(join(here, "..", "project-layers.ts"), "utf8");
  expect(layers).not.toMatch(/FROM messages WHERE id=/);
});

it("test 36: the bot read writes nothing (deny marks, revoke jobs, deny generation, lsn allocator, stale flags)", () => {
  const db = fixture();
  const before = written(db);
  for (const id of ["r-line", "r-mixed", "r-child", "r-grand"]) { verdictOf(db, { kind: "record", id, version: 1 }); verdictOf(db, { kind: "record", id }); }
  verdictOf(db, { kind: "source", id: "s-line" });
  refsLookup(db, [{ kind: "receipt", bundleId: "rc-source", lsn: 1, scopeIds: [] }], { audience: null });
  expect(written(db)).toEqual(before);
});

it("rule 23: the anchor seek is a leaf module (no import cycle with the door), and bot-read.ts re-exports it", () => {
  const leaf = readFileSync(join(here, "..", "murage-anchor.ts"), "utf8");
  expect(leaf.match(/^import .* from "(.*)";$/gm)?.map(line => line.replace(/^.* from "(.*)";$/, "$1")).sort()).toEqual(["./murage-voice.ts", "node:sqlite"]);
  expect(readFileSync(join(here, "deny-read.ts"), "utf8")).toMatch(/from "\.\.\/murage-anchor\.ts"/);
  expect(readFileSync(join(here, "deny-read.ts"), "utf8")).not.toMatch(/from "\.\.\/bot-read\.ts"/);
  expect(readFileSync(join(here, "..", "bot-read.ts"), "utf8")).toMatch(/export \{ anyMurageAnchor, murageAnchor \} from "\.\/murage-anchor\.ts"/);
});
