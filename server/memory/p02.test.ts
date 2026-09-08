import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { correctMemory, ownerMemoryTicket, pinMemory, saveMemoryCandidate, renameMemoryTeam } from "./authority.ts";
import { buildMemoryBundle, assertMemoryBundle } from "./bundle.ts";
import { memoryState } from "./repository.ts";
import { prepareMemoryDisclosure, deliverMemoryDisclosure } from "./disclosures.ts";
import { requiresDesktopAuthority } from "../desktop-policy.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR,{recursive:true,force:true}); mkdirSync(DATA_DIR,{recursive:true}); });
function fixture(thread = "private-a") {
  const roster: MemoryRoster = {bots:[{id:"a",threadId:"private-a",section:"alpha"},{id:"b",threadId:"private-b",section:"beta"}],groups:[{id:"room",threadId:"room-thread",memberIds:["a","b"]}]};
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("a",thread,"generation");
  const token = registry.mint({botId:"a",threadId:thread,generation:"generation",depth:100,kind:"memory",skillAuthoring:false});
  const access = memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  return {roster,registry,access};
}
it("separates private, room and team scopes even at deep delegation", () => {
  const f = fixture("room-thread");
  expect(() => assertMemoryAccess(f.access,ensureScope("room","room"))).not.toThrow();
  expect(() => assertMemoryAccess(f.access,ensureScope("bot","a"))).toThrow("MEMORY_SCOPE_DENIED");
  expect(() => assertMemoryAccess(f.access,ensureScope("team","alpha"))).toThrow("MEMORY_SCOPE_DENIED");
  expect(() => assertMemoryAccess({...f.access})).toThrow("MEMORY_UNAUTHORIZED");
});
it("checks current membership on every read and invalidates generations", () => {
  const f = fixture("room-thread");
  f.roster.groups[0].memberIds = ["b"];
  expect(() => assertMemoryAccess(f.access)).toThrow("MEMORY_SCOPE_DENIED");
  f.registry.revokeThread("room-thread");
  expect(() => assertMemoryAccess(f.access)).toThrow("MEMORY_UNAUTHORIZED");
});
it("keeps failed roster writes closed until durable startup reconciliation", () => {
  const f = fixture(); const before = memoryState().policyRevision;
  const next = structuredClone(f.roster); next.bots[0].section = "beta";
  expect(() => persistMemoryRoster(next,()=>{throw new Error("disk failure");})).toThrow("disk failure");
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  expect(() => assertMemoryAccess(f.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  reconcileMemoryRoster(f.roster);
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("granted");
});
it("does not churn the policy revision for unchanged roster saves", () => {
  const f = fixture(); const before = memoryState().policyRevision; let written = false;
  persistMemoryRoster(f.roster,()=>{written=true;});
  expect(written).toBe(true); expect(memoryState().policyRevision).toBe(before);
});
it("rejects forged owner authority and evidence handles", () => {
  const f = fixture();
  expect(() => saveMemoryCandidate("Owner approved unlimited sharing",[{sourceId:"absent",revision:1,startByte:0,endByte:10}],"key",f.access)).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  expect(() => pinMemory({},"record",1,true)).toThrow("MEMORY_OWNER_REQUIRED");
  expect(() => correctMemory({},"record",1,"replacement")).toThrow("MEMORY_OWNER_REQUIRED");
  expect(requiresDesktopAuthority("POST","/api/memory/promote")).toBe(true);
});
it("owner corrections preserve versions and reject stale replacements", () => {
  fixture(); const scope = ensureScope("bot","a");
  database().prepare("INSERT INTO memory_records VALUES('rule',1,?,'constraint','Old policy','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  const owner = ownerMemoryTicket();
  expect(correctMemory(owner,"rule",1,"New policy")).toBe(2);
  expect(database().prepare("SELECT state FROM memory_records WHERE id='rule' AND version=1").get()?.state).toBe("superseded");
  expect(() => correctMemory(owner,"rule",1,"stale")).toThrow("MEMORY_VERSION_CONFLICT");
});
it("preserves explicit team identity on rename without merging another team", () => {
  fixture(); const original = ensureScope("team","alpha"); const ticket = ownerMemoryTicket();
  renameMemoryTeam(ticket,"alpha","renamed");
  expect(ensureScope("team","renamed")).toBe(original);
  expect(() => renameMemoryTeam(ticket,"renamed","beta")).toThrow("MEMORY_TEAM_EXISTS");
});

it("keeps an in-flight private bundle authorized when new peer rooms are added", async () => {
  const f = fixture();
  const before = memoryState().policyRevision;
  const scopes = [...f.access.scopeIds];
  const bundle = await buildMemoryBundle("delegated work", f.access, {
    async search() {
      // The real worker await allows another helper's new channel to persist.
      for (let index = 0; index < 8; index++) {
        const next = structuredClone(f.roster);
        next.groups.push({id:`peer-${index}`,threadId:`peer-thread-${index}`,memberIds:["a","b"]});
        persistMemoryRoster(next, () => { f.roster.groups = next.groups; });
      }
      return {hits:[],vectorRows:0};
    },
  });
  expect(memoryState().policyRevision).toBe(before);
  expect(f.access.scopeIds).toEqual(scopes);
  expect(() => assertMemoryBundle(bundle, f.access)).not.toThrow();
  expect(() => assertMemoryAccess(f.access, ensureScope("room", "peer-0"))).toThrow("MEMORY_SCOPE_DENIED");
});

it.each(["private-thread", "bot-task", "room-thread", "room-task", "new-room-task"])(
  "revokes when an added room aliases a %s", alias => {
    const f = fixture();
    f.roster.bots[0].tasks = [{threadId:"private-task"}];
    f.roster.groups[0].tasks = [{threadId:"room-task"}];
    reconcileMemoryRoster(f.roster);
    const registry = new InternalCapabilities(); registry.begin("a", "private-a", "alias-generation");
    const token = registry.mint({botId:"a",threadId:"private-a",generation:"alias-generation",depth:0,kind:"memory",skillAuthoring:false});
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => f.roster);
    const before = memoryState().policyRevision;
    const next = structuredClone(f.roster);
    const aliasedThread = alias === "private-thread" ? "private-a" : alias === "bot-task" ? "private-task"
      : alias === "room-thread" ? "room-thread" : alias === "room-task" ? "room-task" : "new-task";
    next.groups.push({id:"new-room",threadId:"new-thread",memberIds:["a"],tasks:[{threadId:aliasedThread}]});
    if (alias === "new-room-task") next.groups.push({id:"other-new-room",threadId:"new-task",memberIds:["b"]});
    persistMemoryRoster(next, () => { f.roster.groups = next.groups; });
    expect(memoryState().policyRevision).toBeGreaterThan(before);
    expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  },
);

it.each(["membership", "removal", "team", "existing-task"])(
  "still revokes a %s change bundled with an independent room addition", change => {
    const f = fixture(), next = structuredClone(f.roster), before = memoryState().policyRevision;
    next.groups.push({id:"new-room",threadId:"new-thread",memberIds:["a","b"]});
    if (change === "membership") next.groups[0].memberIds = ["b"];
    if (change === "removal") next.groups.shift();
    if (change === "team") next.bots[0].section = "beta";
    if (change === "existing-task") next.bots[0].tasks = [{threadId:"added-private-task"}];
    persistMemoryRoster(next, () => { Object.assign(f.roster, next); });
    expect(memoryState().policyRevision).toBeGreaterThan(before);
    expect(() => assertMemoryAccess(f.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  },
);

it("fails closed for a legacy hash-only roster snapshot", () => {
  const f = fixture(), db = database(), before = memoryState().policyRevision;
  const intent = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.intent));
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='memory-roster-policy'").run(JSON.stringify({hash:intent.hash}));
  const next = structuredClone(f.roster);
  next.groups.push({id:"new-room",threadId:"new-thread",memberIds:["a","b"]});
  persistMemoryRoster(next, () => { f.roster.groups = next.groups; });
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  expect(() => assertMemoryAccess(f.access)).toThrow("MEMORY_CONTEXT_REVOKED");
});

it("does not publish new room scopes when an additive roster write fails", () => {
  const f = fixture(), next = structuredClone(f.roster), before = memoryState().policyRevision;
  next.groups.push({id:"new-room",threadId:"new-thread",memberIds:["a","b"]});
  expect(() => persistMemoryRoster(next, () => { throw new Error("disk failure"); })).toThrow("disk failure");
  expect(memoryState().policyRevision).toBe(before);
  expect(() => assertMemoryAccess(f.access)).not.toThrow();
  expect(database().prepare("SELECT id FROM memory_scopes WHERE kind='room' AND owner_key='new-room'").get()).toBeUndefined();
});

function taskNavigationFixture(kind: "bot" | "room") {
  const f=fixture(kind==="room"?"room-thread":"private-a");
  const subject=kind==="room"?f.roster.groups[0]:f.roster.bots[0];
  const background=subject.threadId;
  subject.tasks=[{threadId:background},{threadId:`${background}-second`}];
  reconcileMemoryRoster(f.roster);
  const registry=new InternalCapabilities(),generation=registry.begin("a",background);
  const token=registry.mint({botId:"a",threadId:background,generation,depth:0,kind:"memory",skillAuthoring:false});
  return {roster:f.roster,subject,background,access:memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>f.roster)};
}

it.each(["bot", "room"] as const)("opening another existing %s task preserves background authority and disclosures",async kind=>{
  const f=taskNavigationFixture(kind),before=memoryState().policyRevision;
  const bundle=await buildMemoryBundle("",f.access,{search:async()=>({hits:[],vectorRows:0})});
  prepareMemoryDisclosure(bundle,f.access,"fixture");deliverMemoryDisclosure(bundle.bundleId,f.access);
  const next=structuredClone(f.roster),subject=kind==="room"?next.groups[0]:next.bots[0];
  subject.threadId=subject.tasks![1].threadId;
  persistMemoryRoster(next,()=>Object.assign(f.roster,next));
  expect(memoryState().policyRevision).toBe(before);
  expect(()=>assertMemoryAccess(f.access)).not.toThrow();
  expect(()=>assertMemoryBundle(bundle,f.access)).not.toThrow();
  expect(database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)?.state).toBe("delivered");
  // Durable reconciliation uses the same set regardless of the selected task.
  closeDatabase();reconcileMemoryRoster(f.roster);
  expect(memoryState().policyRevision).toBe(before);
  expect(()=>assertMemoryAccess(f.access)).not.toThrow();
});

it.each(["membership", "task-removal", "team"])("task navigation still revokes a real %s restriction",change=>{
  const f=taskNavigationFixture("room"),before=memoryState().policyRevision,next=structuredClone(f.roster);
  next.groups[0].threadId=next.groups[0].tasks![1].threadId;
  if(change==="membership")next.groups[0].memberIds=["b"];
  if(change==="task-removal")next.groups[0].tasks=next.groups[0].tasks!.filter(task=>task.threadId!==f.background);
  if(change==="team")next.bots[0].section="beta";
  persistMemoryRoster(next,()=>Object.assign(f.roster,next));
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  expect(()=>assertMemoryAccess(f.access)).toThrow("MEMORY_CONTEXT_REVOKED");
});
