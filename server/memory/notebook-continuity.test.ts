import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket, correctMemory } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { forgetMemory } from "./forget.ts";
import { availableMemoryNotebooks, commitMemoryImport, memoryNotebookLinks, previewMemoryImport, stopTrackingMemoryNotebook, syncTrackedMemoryImports, migrateDetectedMemoryNotebooks } from "./import.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
});
function seed(text = "Original notebook") {
  const root = ensureWorkspace("a"), path = join(root, "MEMORY.md"), ticket = ownerMemoryTicket();
  writeFileSync(path, text);
  const preview = previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster);
  commitMemoryImport(ticket, preview.previewId, roster, true);
  return { root, path, ticket };
}
function poll() {
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  syncTrackedMemoryImports(roster);
}

it("imports the entire long notebook and topics without altering originals", () => {
  const text = Array.from({ length: 230 }, (_, index) => `Line ${index}: durable owner context.`).join("\n");
  const { root, path, ticket } = seed(text);
  writeFileSync(join(root, "memory", "detail.md"), "Topic detail");
  const inventory = availableMemoryNotebooks(ticket, roster);
  expect(inventory.selections).toContainEqual({ kind: "bot", botId: "a", topic: "detail.md" });
  const preview = previewMemoryImport(ticket, inventory.selections, roster);
  expect(preview.items.find(item => item.selection.kind === "bot" && !item.selection.topic)?.text).toBe(text);
  expect(commitMemoryImport(ticket, preview.previewId, roster)).toMatchObject({ imported: 1, skipped: 1 });
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions WHERE json_extract(payload,'$.text')=?").get(text)?.n).toBe(1);
});

it("tracks changed files after restart, remains idempotent, and stops on owner request", () => {
  const { path, ticket } = seed();
  closeDatabase(); writeFileSync(path, "Updated notebook"); poll();
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(2);
  expect(database().prepare("SELECT text,assertion FROM memory_records WHERE state='active'").get()).toMatchObject({ text: "Updated notebook", assertion: "unverified-import" });
  poll(); expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions").get()?.n).toBe(2);
  stopTrackingMemoryNotebook(ticket, memoryNotebookLinks()[0].id);
  writeFileSync(path, "Do not import this"); poll();
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(2);
});

it.each(["pinned", "archived", "corrected"])("reports %s conflicts without replacing owner decisions", kind => {
  const { path } = seed();
  if (kind === "pinned") database().exec("UPDATE memory_records SET owner_pinned=1");
  if (kind === "archived") database().exec("UPDATE memory_records SET state='archived'");
  if (kind === "corrected") database().exec("UPDATE memory_records SET assertion='owner-statement'");
  writeFileSync(path, "Conflicting file update"); poll();
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(1);
  expect(memoryNotebookLinks()[0]).toMatchObject({ status: "needs-review", error: "MEMORY_IMPORT_REVIEW_CONFLICT" });
});

it("never resurrects a forgotten source when its file is recreated", () => {
  const { path, ticket } = seed();
  const source = String(database().prepare("SELECT id FROM memory_sources").get()!.id);
  forgetMemory(ticket, { kind: "source", id: source });
  rmSync(path); writeFileSync(path, "Recreated changed file"); poll();
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()?.n).toBe(0);
  expect(memoryNotebookLinks()[0].status).toBe("needs-review");
});

it("pauses tracking with memory and reports missing or symlink files", () => {
  const { path, root } = seed();
  database().exec("UPDATE memory_meta SET mode='paused'"); writeFileSync(path, "Paused update"); poll();
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(1);
  database().exec("UPDATE memory_meta SET mode='active'"); rmSync(path); poll();
  expect(memoryNotebookLinks()[0].error).toBe("MEMORY_IMPORT_FILE_UNREADABLE");
  const target = join(root, "target.txt"); writeFileSync(target, "Linked bytes"); symlinkSync(target, path); poll();
  expect(memoryNotebookLinks()[0].error).toBe("MEMORY_IMPORT_SYMLINK");
});

it("recognizes a real owner correction as a tracking conflict", () => {
  const { path, ticket } = seed();
  const record=database().prepare("SELECT id,version FROM memory_records").get()!;
  correctMemory(ticket,String(record.id),Number(record.version),"Owner corrected knowledge");
  writeFileSync(path,"File changed after the correction");poll();
  expect(memoryNotebookLinks()[0]).toMatchObject({status:"needs-review",error:"MEMORY_IMPORT_REVIEW_CONFLICT"});
  expect(database().prepare("SELECT text FROM memory_records WHERE state='active'").get()?.text).toBe("Owner corrected knowledge");
});

it("migrates four detected private files at a time and resumes without duplicate versions", () => {
  const root=ensureWorkspace("a");
  writeFileSync(join(root,"MEMORY.md"),"Detected private notebook");
  for(let n=0;n<6;n++)writeFileSync(join(root,"memory",`topic-${n}.md`),`Private topic ${n}`);
  const foreign=ensureWorkspace("not-in-roster");writeFileSync(join(foreign,"MEMORY.md"),"Unrelated store must stay outside");
  const first=migrateDetectedMemoryNotebooks(roster);
  expect(first).toMatchObject({imported:4,paused:false});expect(first.nextCursor).toBeTruthy();
  closeDatabase();
  const second=migrateDetectedMemoryNotebooks(roster,first.nextCursor);
  expect(second).toMatchObject({imported:3});expect(second.nextCursor).toBeUndefined();
  expect(migrateDetectedMemoryNotebooks(roster)).toMatchObject({imported:0,skipped:4});
  expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions").get()?.n).toBe(7);
  expect(database().prepare("SELECT count(DISTINCT scope_id) AS n FROM memory_records").get()?.n).toBe(1);
  expect(database().prepare("SELECT DISTINCT assertion,owner_pinned FROM memory_records").all()).toEqual([{assertion:"unverified-import",owner_pinned:0}]);
  expect(readFileSync(join(root,"MEMORY.md"),"utf8")).toBe("Detected private notebook");
});

it.each(["off","paused","capture"])("does not automatically migrate in %s mode", mode => {
  const root=ensureWorkspace("a");writeFileSync(join(root,"MEMORY.md"),"Not consented for automatic recall");
  database().prepare("UPDATE memory_meta SET mode=?").run(mode);
  expect(migrateDetectedMemoryNotebooks(roster)).toMatchObject({paused:true,imported:0});
  expect(database().prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(0);
});

it("ignores the generated seed and preserves a revoked tracking choice", () => {
  const root=ensureWorkspace("a");expect(migrateDetectedMemoryNotebooks(roster)).toMatchObject({imported:0});
  writeFileSync(join(root,"MEMORY.md"),"Real notes");migrateDetectedMemoryNotebooks(roster);
  stopTrackingMemoryNotebook(ownerMemoryTicket(),memoryNotebookLinks()[0].id);
  writeFileSync(join(root,"MEMORY.md"),"Owner stopped automatic updates");
  expect(migrateDetectedMemoryNotebooks(roster)).toMatchObject({imported:0,skipped:1});
  expect(memoryNotebookLinks()).toEqual([]);
  expect(database().prepare("SELECT revision FROM memory_sources").get()?.revision).toBe(1);
});

it("automatic migration retains forgotten-source and symlink review receipts", () => {
  const {path,ticket,root}=seed();
  const source=String(database().prepare("SELECT id FROM memory_sources").get()!.id);
  forgetMemory(ticket,{kind:"source",id:source});writeFileSync(path,"Recreated source");
  const target=join(root,"external.txt");writeFileSync(target,"External source");symlinkSync(target,join(root,"memory","linked.md"));
  expect(migrateDetectedMemoryNotebooks(roster)).toMatchObject({imported:0,needsReview:2});
  expect(memoryNotebookLinks().map(link=>link.error).sort()).toEqual(["MEMORY_IMPORT_FORGOTTEN","MEMORY_IMPORT_SYMLINK"]);
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()?.n).toBe(0);
});
