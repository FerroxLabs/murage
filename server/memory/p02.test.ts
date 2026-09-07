import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { correctMemory, ownerMemoryTicket, pinMemory, saveMemoryCandidate, renameMemoryTeam } from "./authority.ts";
import { memoryState } from "./repository.ts";
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
