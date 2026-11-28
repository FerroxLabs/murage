// Test fixture for lane I (memory V2 retention, migration runner, compatibility). Owner: lane I. Neutral names only.
// Rows come from the real write paths: notebook imports through previewMemoryImport/commitMemoryImport and turns through
// captureSource, with the clock moved by the caller (vi.setSystemTime).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { database } from "../../database.ts";
import { ensureWorkspace } from "../../workspace.ts";
import { ownerMemoryTicket } from "../authority.ts";
import { captureSource } from "../capture.ts";
import { commitMemoryImport, previewMemoryImport } from "../import.ts";
import { storeAnchorMessage } from "./anchor-message.ts";

export const FIXTURE_BOT = "a";
export const fixtureRoster = { bots: [{ id: FIXTURE_BOT, threadId: "thread-a" }], groups: [] };

export const notebookLine = (i: number) => `Line ${String(i).padStart(5, "0")}: a durable fixture note the routine keeps.`;

/** Writes the bot notebook with `lines` lines and imports it (tracked), as the owner's import does. */
export function importNotebook(lines: number): void {
  importNotebookText(Array.from({ length: lines }, (_, i) => notebookLine(i)));
}

/** Writes the bot notebook with exactly these lines and imports it (an edited line supersedes the record it published). */
export function importNotebookText(lines: readonly string[]): void {
  const root = ensureWorkspace(FIXTURE_BOT), ticket = ownerMemoryTicket();
  writeFileSync(join(root, "MEMORY.md"), lines.join("\n") + "\n");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: FIXTURE_BOT }], fixtureRoster).previewId, fixtureRoster, true);
}

/** Writes a topic file of the bot notebook (memory/<topic>, its own source) and imports it. */
export function importTopicText(topic: string, lines: readonly string[]): void {
  const dir = join(ensureWorkspace(FIXTURE_BOT), "memory"), ticket = ownerMemoryTicket();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, topic), lines.join("\n") + "\n");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: FIXTURE_BOT, topic }], fixtureRoster).previewId, fixtureRoster, true);
}

/** One turn: the reply is captured while working, then settled (a new revision cancels the first job). */
export function captureTurn(n: number, text = `fixture turn ${n} settled reply`): void {
  const db = database(), messageId = `turn-message-${n}`, id = `turn-source-${n}`;
  storeAnchorMessage(db, "thread-a", messageId, text);
  captureSource(db, { id, threadId: "thread-a", messageId, origin: { kind: "attended" }, kind: "text", speaker: "bot", outcome: "working", text: `${text} (draft)` });
  captureSource(db, { id, threadId: "thread-a", messageId, origin: { kind: "attended" }, kind: "text", speaker: "bot", outcome: "recorded", text });
}

/** Rows lane I must never delete or alter, as one comparable digest (4.10 "never deleted" list). */
export function protectedDigest(db: DatabaseSync = database()): Record<string, unknown> {
  const all = (sql: string) => JSON.stringify(db.prepare(sql).all());
  const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return {
    tombstones: all("SELECT target_type,target_id,revision,content_hash FROM memory_tombstones ORDER BY 1,2,3,4"),
    versions: all("SELECT source_id,revision,content_hash FROM memory_source_versions ORDER BY 1,2"),
    evidence: all("SELECT record_id,record_version,source_id,source_revision,start_byte,end_byte FROM memory_evidence ORDER BY 1,2,3,4,5"),
    records: all("SELECT id,version,state,text FROM memory_records ORDER BY 1,2"),
    deny: count("memory_deny") + count("memory_deny_point") + count("memory_deny_range") + count("memory_deny_session") + count("memory_deny_object"),
    // one read (lane C's P4-a pins every file holding the pending tables' names as bare literals; this fixture only counts them)
    pending: Number(db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n),
    checkpoints: count("memory_checkpoint_heads") + count("memory_checkpoint_members") + count("memory_checkpoint_publications") + count("memory_checkpoint_exclusions"),
    openJobs: all("SELECT source_id,source_revision,stage,status FROM memory_jobs WHERE status IN ('pending','leased','partial','deferred') ORDER BY 1,2,3"),
    publishingJobs: all(`SELECT j.source_id,j.source_revision,j.stage FROM memory_jobs j WHERE EXISTS (SELECT 1 FROM memory_evidence_by_source e
      WHERE e.source_id=j.source_id AND e.source_revision=j.source_revision) ORDER BY 1,2,3`),
    currentCapture: all(`SELECT j.source_id,j.source_revision FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
      WHERE s.state!='deleted' AND j.stage='capture' AND j.status='complete' ORDER BY 1,2`),
  };
}

export const schemaRows = (db: DatabaseSync = database()) =>
  JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all());
