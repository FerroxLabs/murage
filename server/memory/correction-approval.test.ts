// Owner approval of an agent-proposed memory correction (audit C1, decision
// U-16). Before approval the proposal changes nothing about the target. On
// approval the exact recorded target version is validated, only that target
// is superseded, the replacement becomes the one current fact, and a pinned
// target needs an explicit transfer/unpin choice. Stale, forgotten, archived,
// ambiguous and repeated cases fail without partial mutation.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { memoryAgentRoute } from "./routes.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { correctMemory, ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { CURRENT_MEMORY, HISTORICAL_MEMORY } from "./eligibility.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function fixture() {
  const roster = { bots: [{ id: "bot", threadId: "thread" }, { id: "other", threadId: "private" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m", at: 1, role: "user", kind: "text", text: "The deploy window is Tuesday" });
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  const target = String(database().prepare("SELECT id FROM memory_records").get()!.id);
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  // Owner decisions bump the policy revision, which revokes older contexts.
  const access = () => memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
  const evidence = [{ sourceId: work.sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(work.text) }];
  const owner = ownerMemoryTicket();
  const propose = async (key: string, replacement = "The deploy window is Thursday", version = 1) =>
    (await memoryAgentRoute("/api/internal/memory/propose-correction", { id: target, version, replacement, evidence, idempotencyKey: key }, access(), bridge) as { candidateId: string }).candidateId;
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster);
  const row = (id: string, version = 1) => database().prepare("SELECT text,state,owner_pinned,valid_to FROM memory_records WHERE id=? AND version=?").get(id, version) as { text: string; state: string; owner_pinned: number; valid_to: number | null };
  const current = () => database().prepare(`SELECT r.id,r.version,r.text FROM memory_records r WHERE ${CURRENT_MEMORY} ORDER BY r.id`).all().map(r => ({ id: String(r.id), version: Number(r.version), text: String(r.text) }));
  const pin = () => database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=1").run(target);
  return { roster, target, access, bridge, evidence, owner, propose, act, row, current, pin };
}

describe("correction proposal before approval", () => {
  it("leaves the pinned target and its pin unchanged and exposes the exact target for review", async () => {
    const f = fixture(); f.pin();
    const candidate = await f.propose("proposal");
    expect(f.row(f.target)).toMatchObject({ text: "The deploy window is Tuesday", state: "active", owner_pinned: 1, valid_to: null });
    expect(f.row(candidate)).toMatchObject({ state: "candidate", owner_pinned: 0 });
    const inspection = await f.act({ action: "inspect", id: candidate, version: 1 }) as { correction: unknown };
    expect(inspection.correction).toEqual({
      status: "current",
      target: { id: f.target, version: 1, text: "The deploy window is Tuesday", state: "active", ownerPinned: true, scopeId: expect.any(String) },
    });
    const bundle = await buildMemoryBundle("deploy window", f.access(), f.bridge);
    expect(bundle.pinned.map(record => record.text)).toEqual(["The deploy window is Tuesday"]);
  });

  it("rejects a replay of the same proposal key against a later target version", async () => {
    const f = fixture();
    const candidate = await f.propose("replayed");
    correctMemory(f.owner, f.target, 1, "The deploy window is Tuesday (owner wording)");
    await expect(f.propose("replayed", "The deploy window is Thursday", 2)).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
    expect(database().prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=1").all(candidate))
      .toEqual([{ parent_id: f.target, parent_version: 1 }]);
  });
});

describe("owner approval of a correction", () => {
  it("requires an explicit pin choice for a pinned target, then transfers the pin and supersedes only that target", async () => {
    const f = fixture(); f.pin();
    const candidate = await f.propose("transfer");
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_PIN_CHOICE_REQUIRED");
    expect(f.row(f.target)).toMatchObject({ state: "active", owner_pinned: 1 });
    expect(f.row(candidate)).toMatchObject({ state: "candidate" });
    await expect(f.act({ action: "approve", id: candidate, version: 1, correctionPin: "keep-both" })).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");

    const approved = await f.act({ action: "approve", id: candidate, version: 1, correctionPin: "transfer" }) as { record: { state: string; ownerPinned: boolean } };
    expect(approved.record).toMatchObject({ state: "active", ownerPinned: true });
    expect(f.row(f.target)).toMatchObject({ text: "The deploy window is Tuesday", state: "superseded" });
    expect(f.row(f.target).valid_to).toEqual(expect.any(Number));
    expect(f.current()).toEqual([{ id: candidate, version: 1, text: "The deploy window is Thursday" }]);
    const historical = database().prepare(`SELECT r.id FROM memory_records r WHERE ${HISTORICAL_MEMORY} ORDER BY r.id`).all().map(r => String(r.id));
    expect(historical.sort()).toEqual([candidate, f.target].sort());
    const bundle = await buildMemoryBundle("deploy window", f.access(), f.bridge);
    expect(bundle.pinned.map(record => ({ id: record.id, text: record.text }))).toEqual([{ id: candidate, text: "The deploy window is Thursday" }]);
  });

  it("unpins on an explicit unpin choice and leaves no pinned fact", async () => {
    const f = fixture(); f.pin();
    const candidate = await f.propose("unpin");
    await f.act({ action: "approve", id: candidate, version: 1, correctionPin: "unpin" });
    expect(f.row(candidate)).toMatchObject({ state: "active", owner_pinned: 0 });
    expect(f.row(f.target)).toMatchObject({ state: "superseded" });
    expect(f.current().map(record => record.id)).toEqual([candidate]);
    expect((await buildMemoryBundle("deploy window", f.access(), f.bridge)).pinned).toEqual([]);
  });

  it("approves an unpinned target without a choice and refuses a stale pin choice", async () => {
    const f = fixture();
    const candidate = await f.propose("plain");
    await expect(f.act({ action: "approve", id: candidate, version: 1, correctionPin: "transfer" })).rejects.toThrow("MEMORY_CORRECTION_PIN_CHANGED");
    expect(f.row(f.target)).toMatchObject({ state: "active" });
    await f.act({ action: "approve", id: candidate, version: 1 });
    expect(f.row(candidate)).toMatchObject({ state: "active", owner_pinned: 0 });
    expect(f.current().map(record => record.id)).toEqual([candidate]);
  });

  it("refuses repeated approval without touching either record again", async () => {
    const f = fixture();
    const candidate = await f.propose("repeat");
    await f.act({ action: "approve", id: candidate, version: 1 });
    const before = [f.row(f.target), f.row(candidate)];
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect([f.row(f.target), f.row(candidate)]).toEqual(before);
    expect(f.current().map(record => record.id)).toEqual([candidate]);
  });

  it("refuses a proposal whose target was corrected after it was proposed", async () => {
    const f = fixture();
    const candidate = await f.propose("stale");
    expect(correctMemory(f.owner, f.target, 1, "The deploy window is Wednesday")).toBe(2);
    const inspection = await f.act({ action: "inspect", id: candidate, version: 1 }) as { correction: { status: string } };
    expect(inspection.correction.status).toBe("changed");
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_TARGET_CHANGED");
    expect(f.row(f.target, 2)).toMatchObject({ text: "The deploy window is Wednesday", state: "active" });
    expect(f.row(candidate)).toMatchObject({ state: "candidate" });
  });

  it("refuses a competing proposal once another correction replaced the same target", async () => {
    const f = fixture();
    const first = await f.propose("first", "The deploy window is Thursday");
    const second = await f.propose("second", "The deploy window is Friday");
    await f.act({ action: "approve", id: first, version: 1 });
    await expect(f.act({ action: "approve", id: second, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_TARGET_CHANGED");
    expect(f.row(second)).toMatchObject({ state: "candidate" });
    expect(f.current().map(record => record.text)).toEqual(["The deploy window is Thursday"]);
  });

  it("fails safely when the target was forgotten before approval", async () => {
    const f = fixture();
    const candidate = await f.propose("forgotten");
    forgetMemory(f.owner, { kind: "record", id: f.target });
    // Forgetting cascades to derived records, so the proposal is gone too.
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_VERSION_CONFLICT");
    expect(f.row(candidate).state).toBe("deleted");
    expect(f.current()).toEqual([]);
  });

  it("refuses a proposal whose target was archived before approval", async () => {
    const f = fixture();
    const candidate = await f.propose("archived");
    archiveMemoryRecord(f.owner, f.target, 1);
    const inspection = await f.act({ action: "inspect", id: candidate, version: 1 }) as { correction: { status: string } };
    expect(inspection.correction.status).toBe("unavailable");
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_TARGET_UNAVAILABLE");
    expect(f.row(f.target)).toMatchObject({ state: "archived" });
    expect(f.row(candidate)).toMatchObject({ state: "candidate" });
  });

  it("refuses when the candidate's evidence was retired after proposal", async () => {
    const f = fixture();
    const candidate = await f.propose("retired");
    database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(f.evidence[0]!.sourceId);
    await expect(f.act({ action: "approve", id: candidate, version: 1 })).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
    expect(f.row(f.target)).toMatchObject({ state: "active" });
    expect(f.row(candidate)).toMatchObject({ state: "candidate" });
  });

  it("refuses a proposal whose recorded target version is ambiguous", async () => {
    const f = fixture();
    const ambiguous = await f.propose("ambiguous");
    correctMemory(f.owner, f.target, 1, "The deploy window is Wednesday");
    database().prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(f.target, 2, ambiguous);
    const inspection = await f.act({ action: "inspect", id: ambiguous, version: 1 }) as { correction: unknown };
    expect(inspection.correction).toEqual({ status: "unavailable", target: null });
    await expect(f.act({ action: "approve", id: ambiguous, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_TARGET_UNAVAILABLE");
    expect(f.row(f.target, 2)).toMatchObject({ state: "active" });
    expect(f.row(ambiguous)).toMatchObject({ state: "candidate" });
  });

  it("refuses a proposal whose target now belongs to another audience", async () => {
    const f = fixture();
    const moved = await f.propose("moved");
    database().prepare("UPDATE memory_records SET scope_id=? WHERE id=? AND version=1").run(ensureScope("bot", "other"), f.target);
    await expect(f.act({ action: "approve", id: moved, version: 1 })).rejects.toThrow("MEMORY_CORRECTION_SCOPE_MISMATCH");
    expect(f.row(f.target)).toMatchObject({ state: "active" });
    expect(f.row(moved)).toMatchObject({ state: "candidate" });
  });
});

describe("ordinary candidate approval", () => {
  it("is unchanged and rejects a correction pin choice", async () => {
    const f = fixture(); f.pin();
    const saved = await memoryAgentRoute("/api/internal/memory/save", { text: "Standups are at 9", evidence: f.evidence, idempotencyKey: "ordinary" }, f.access(), f.bridge) as { candidateId: string };
    const inspection = await f.act({ action: "inspect", id: saved.candidateId, version: 1 }) as { correction: unknown };
    expect(inspection.correction).toBeNull();
    await expect(f.act({ action: "approve", id: saved.candidateId, version: 1, correctionPin: "transfer" })).rejects.toThrow("MEMORY_CORRECTION_PIN_CHOICE_INVALID");
    await f.act({ action: "approve", id: saved.candidateId, version: 1 });
    expect(f.row(saved.candidateId)).toMatchObject({ state: "active", owner_pinned: 0 });
    expect(f.row(f.target)).toMatchObject({ state: "active", owner_pinned: 1 });
    expect(f.current().map(record => record.id).sort()).toEqual([saved.candidateId, f.target].sort());
  });
});

it("editing a held correction atomically replaces its original target",async()=>{
 const f=fixture(),candidate=await f.propose("r6-edit");
 await f.act({action:"correct",id:candidate,version:1,text:"The deploy window is Friday"});
 expect(f.row(f.target).state).toBe("superseded");
 expect(f.row(candidate,2)).toMatchObject({state:"active",text:"The deploy window is Friday"});
 expect(f.current()).toEqual([{id:candidate,version:2,text:"The deploy window is Friday"}]);
});
it.each(["transfer","unpin"])("editing a pinned correction requires and honors %s",async correctionPin=>{
 const f=fixture();f.pin();const candidate=await f.propose("r6-pin");
 await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday"})).rejects.toThrow("Choose whether to transfer or remove the current memory’s pin.");
 expect(f.row(f.target).state).toBe("active");expect(f.row(candidate).state).toBe("candidate");
 await f.act({action:"correct",id:candidate,version:1,text:"Friday",correctionPin});
 expect(f.row(f.target).state).toBe("superseded");expect(f.row(candidate,2)).toMatchObject({state:"active",owner_pinned:correctionPin==="transfer"?1:0});
});

it("editing a correction refuses a changed exact target without partial writes",async()=>{
 const f=fixture(),candidate=await f.propose("r6-stale-edit");
 correctMemory(f.owner,f.target,1,"The deploy window is Wednesday");
 await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday"})).rejects.toThrow("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
 expect(f.row(candidate).state).toBe("candidate");expect(f.row(candidate,2)).toBeUndefined();
 expect(f.row(f.target,2).state).toBe("active");
});

it("refuses editing a superseded target beside its active successor",async()=>{
 const f=fixture(),candidate=await f.propose("r7-replaced");
 await f.act({action:"approve",id:candidate,version:1});
 await expect(f.act({action:"correct",id:f.target,version:1,text:"Friday"})).rejects.toThrow("This was replaced; edit the current version.");
 expect(f.row(f.target,2)).toBeUndefined();expect(f.current().map(r=>r.id)).toEqual([candidate]);
});
it("editing a held correction with an archived target returns a plain refusal",async()=>{
 const f=fixture(),candidate=await f.propose("r7-archived");
 archiveMemoryRecord(f.owner,f.target,1);
 await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday"})).rejects.toThrow("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
 expect(f.row(candidate,2)).toBeUndefined();expect(f.row(candidate).state).toBe("candidate");
});
it.each(["current","changed","pinned","edit-archived"])("restore after automatic correction Undo handles a %s target atomically",async state=>{
 const f=fixture(),db=database();
 db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','attended') WHERE source_id=?").run(f.evidence[0].sourceId);
 const extractor=Object.assign(async()=>"[]",{ground:async()=>'{"supported":true}'});
 const {candidateId:candidate}=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.target,version:1,replacement:"The deploy window is Tuesday",evidence:f.evidence,idempotencyKey:"r7-undo"},f.access(),f.bridge,undefined,extractor) as {candidateId:string};
 expect(f.row(candidate).state).toBe("active");
 const event=db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? AND kind='superseded'").get(candidate)!;
 await f.act({action:"learning-undo",eventId:event.id});
 expect(f.row(f.target).state).toBe("active");expect(f.row(candidate).state).toBe("archived");
 if(state==="changed")correctMemory(f.owner,f.target,1,"Wednesday");
 if(state==="pinned")f.pin();
 if(state==="edit-archived"){
  await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday"})).rejects.toThrow("Restore this memory before editing it.");
  expect(f.row(candidate,2)).toBeUndefined();expect(f.current().map(r=>r.id)).toEqual([f.target]);
 }else if(state==="current"){
  await f.act({action:"restore-archive",id:candidate,version:1});
  expect(f.row(f.target).state).toBe("superseded");expect(f.current().map(r=>r.id)).toEqual([candidate]);
 }else{
  await expect(f.act({action:"restore-archive",id:candidate,version:1})).rejects.toThrow(state==="changed"?"The memory this corrects has changed.":"Unpin the current memory before restoring this correction.");
  expect(f.row(candidate).state).toBe("archived");expect(f.current().map(r=>r.id)).toEqual([f.target]);
 }
});

it("editing a retained proposal whose target is deleted returns the plain stale refusal",async()=>{
 const f=fixture(),candidate=await f.propose("r7-deleted-target");
 // Exercise the held-proposal boundary; normal forgetting also deletes descendants.
 database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(f.target);
 await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday"})).rejects.toThrow("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
 expect(f.row(candidate,2)).toBeUndefined();expect(f.row(candidate).state).toBe("candidate");
});

 it("restores an archived owner edit at its latest version",async()=>{
  const f=fixture();
  await f.act({action:"correct",id:f.target,version:1,text:"Wednesday"});
  await f.act({action:"archive",id:f.target,version:2});
  await f.act({action:"restore-archive",id:f.target,version:2});
  expect(f.current()).toEqual([{id:f.target,version:2,text:"Wednesday"}]);
 });
 it("restores an archived approved correction while its target stays superseded",async()=>{
  const f=fixture(),candidate=await f.propose("r9-approved");
  await f.act({action:"approve",id:candidate,version:1});
  await f.act({action:"archive",id:candidate,version:1});
  await f.act({action:"restore-archive",id:candidate,version:1});
  expect(f.row(f.target).state).toBe("superseded");expect(f.current().map(r=>r.id)).toEqual([candidate]);
 });
 it("refuses restore when another correction is active for the superseded target",async()=>{
  const f=fixture(),first=await f.propose("r9-first"),second=await f.propose("r9-second");
  await f.act({action:"approve",id:first,version:1});
  // Retained archived competing proposal exercises restore without an Undo revival.
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(second);
  await expect(f.act({action:"restore-archive",id:second,version:1})).rejects.toThrow("The memory this corrects has changed.");
  expect(f.current().map(r=>r.id)).toEqual([first]);
 });
 it.each(["correct","restore-archive"].flatMap(action=>["identity","audience"].map(reason=>({action,reason}))))("$action uses a plain $reason refusal",async ({action,reason})=>{
  const f=fixture(),candidate=await f.propose("r9-copy");
  if(action==="restore-archive")database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(candidate);
  const body={action,id:candidate,version:1,...(action==="correct"?{text:"Friday"}:{})};
  if(reason==="identity"){
  database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id=?").run(f.target);
  await expect(f.act(body)).rejects.toThrow("Use identity settings to change this memory.");
  }else{
  database().prepare("UPDATE memory_records SET scope_id=? WHERE id=?").run(ensureScope("bot","other"),f.target);
  await expect(f.act(body)).rejects.toThrow("This correction and the current memory have different audiences.");
  }
  expect(f.row(candidate,2)).toBeUndefined();expect(f.row(f.target).state).toBe("active");
 });
 it("editing a held correction describes a stale pin choice plainly",async()=>{
  const f=fixture(),candidate=await f.propose("r9-pin-copy");
  await expect(f.act({action:"correct",id:candidate,version:1,text:"Friday",correctionPin:"transfer"})).rejects.toThrow("The current memory’s pin changed. Review it and try again.");
  expect(f.row(candidate,2)).toBeUndefined();expect(f.row(f.target).state).toBe("active");
 });


describe("Round 10 restore ancestry and plain errors",()=>{
 it.each([1,2])("refuses a competing restore after %i owner edits of a correction",async edits=>{
  const f=fixture(),db=database();
  db.prepare("UPDATE memory_source_versions SET payload=json_set(payload,'$.origin.kind','attended') WHERE source_id=?").run(f.evidence[0].sourceId);
  const extractor=Object.assign(async()=>"[]",{ground:async()=>'{"supported":true}'});
  const {candidateId:first}=await memoryAgentRoute("/api/internal/memory/propose-correction",{id:f.target,version:1,replacement:"The deploy window is Tuesday",evidence:f.evidence,idempotencyKey:"r10-undo"},f.access(),f.bridge,undefined,extractor) as {candidateId:string};
  expect(f.row(first).state).toBe("active");expect(f.row(f.target).state).toBe("superseded");
  const event=db.prepare("SELECT id FROM memory_learning_events WHERE record_id=? AND kind='superseded'").get(first)!;
  await f.act({action:"learning-undo",eventId:event.id});
  expect(f.row(first).state).toBe("archived");expect(f.row(f.target).state).toBe("active");
  const second=await f.propose("r10-second");
  await f.act({action:"approve",id:second,version:1});
  for(let version=1;version<=edits;version++)await f.act({action:"correct",id:second,version,text:"Friday"});
  const version=edits+1;
  await f.act({action:"archive",id:second,version});
  // Unopposed restoration must remain possible for an edited correction.
  await f.act({action:"restore-archive",id:second,version});
  expect(f.current()).toEqual([{id:second,version,text:"Friday"}]);
  await f.act({action:"archive",id:second,version});
  await f.act({action:"restore-archive",id:first,version:1});
  expect(f.current().map(r=>r.id)).toEqual([first]);
  await expect(f.act({action:"restore-archive",id:second,version})).rejects.toThrow("The memory this corrects has changed.");
  expect(f.row(second,version).state).toBe("archived");
  expect(f.current().map(r=>r.id)).toEqual([first]);
 });
 it.each([
  {action:"restore-archive",reason:"source",message:"The source for this memory is no longer available."},
  {action:"restore-archive",reason:"evidence",message:"The evidence for this memory is no longer available."},
  {action:"correct",reason:"evidence",message:"The evidence for this memory is no longer available."},
  {action:"restore-archive",reason:"version",message:"This memory changed. Refresh and try again."},
  {action:"correct",reason:"version",message:"This memory changed. Refresh and try again."},
 ])("$action describes unavailable $reason plainly",async ({action,reason,message})=>{
  const f=fixture(),candidate=await f.propose("r10-copy"),db=database();
  if(action==="restore-archive")db.prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(candidate);
  if(reason==="source")db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(f.evidence[0].sourceId);
  if(reason==="evidence")db.prepare("DELETE FROM memory_evidence WHERE record_id=?").run(candidate);
  const before=f.row(candidate);
  await expect(f.act({action,id:candidate,version:reason==="version"?2:1,...(action==="correct"?{text:"Friday"}:{})})).rejects.toThrow(message);
  expect(f.row(candidate)).toEqual(before);expect(f.row(candidate,2)).toBeUndefined();
  expect(f.row(f.target).state).toBe("active");
 });
});


describe("Round 12 unavailable correction originals",()=>{
 it.each([0,1].flatMap(edits=>["tombstone","deleted"].map(unavailable=>({edits,unavailable}))))("restores a retained correction with $edits owner edits and a $unavailable original",async({edits,unavailable})=>{
  const f=fixture(),candidate=await f.propose("r12-unavailable"),db=database();
  await f.act({action:"approve",id:candidate,version:1});
  if(edits)await f.act({action:"correct",id:candidate,version:1,text:"Friday"});
  const version=edits+1;
  // Retained-correction boundary: real Forget and conversation deletion also
  // delete descendants. Inject only the original's unavailable state here.
  if(unavailable==="tombstone")db.prepare("INSERT INTO memory_tombstones VALUES('r12-forgotten','record',?,NULL,NULL,1,'owner-forget',1)").run(f.target);
  else db.prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(f.target);
  const original=f.row(f.target);
  await f.act({action:"archive",id:candidate,version});
  expect(f.current()).toEqual([]);
  await f.act({action:"restore-archive",id:candidate,version});
  expect(f.current()).toEqual([{id:candidate,version,text:edits?"Friday":"The deploy window is Thursday"}]);
  expect(f.row(f.target)).toEqual(original);
  expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()?.n).toBe(1);
 });
});
