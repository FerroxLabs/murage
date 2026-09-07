import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, updateMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { searchMemory, type MemorySearchBridge } from "./search.ts";
import type { IndexHit } from "./index.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function fixture() {
  let now = 1000;
  const roster = { bots: [{ id: "a", threadId: "thread", section: "alpha" }, { id: "b", threadId: "private", section: "beta" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities({ now: () => now, orphanMs: 100 });
  registry.begin("a", "thread", "generation");
  const token = registry.mint({ botId: "a", threadId: "thread", generation: "generation", depth: 0, kind: "memory", skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const add = (id: string, scopeId = ensureScope("bot", "a"), version = 1, state = "active") => {
    database().prepare("INSERT INTO memory_records VALUES(?,?,?,'constraint',?,'owner-statement',?,1,1,NULL,NULL,1)").run(id, version, scopeId, `text:${id}:${version}`, state);
    return { id, version, score: 1 };
  };
  return { registry, access, add, expire: () => { now = 1100; } };
}
const bridgeFor = (hits: IndexHit[], beforeReturn?: () => void): MemorySearchBridge => ({
  async search() { beforeReturn?.(); return { hits, vectorRows: 0, degradedReason: "fixture-lexical" }; },
});

it("hydrates repeated and distinct allowed scopes without changing record order or versions", async () => {
  const f = fixture();
  const hits = [f.add("one"), f.add("two"), f.add("team", ensureScope("team", "alpha"), 2)];
  const result = await searchMemory("allowed records", f.access, bridgeFor(hits));
  expect(result.hits.map(hit => [hit.id, hit.version, hit.text, hit.pinned, hit.evidence])).toEqual([
    ["one", 1, "text:one:1", true, []], ["two", 1, "text:two:1", true, []], ["team", 2, "text:team:2", true, []],
  ]);
  expect(result.degradedReason).toBe("fixture-lexical");
});

it("rejects a mixed allowed/private response instead of returning any private text", async () => {
  const f = fixture();
  const hits = [f.add("allowed"), f.add("allowed-two"), f.add("PRIVATE_CANARY", ensureScope("bot", "b"))];
  await expect(searchMemory("mixed response", f.access, bridgeFor(hits))).rejects.toThrow("MEMORY_SCOPE_DENIED");
});

it("keeps per-record active version and source revision checks within a shared scope", async () => {
  const f = fixture(); setMemoryMode("capture");
  appendMessage("thread", { id: "source-message", at: 1, role: "user", kind: "text", text: "original" });
  const source = database().prepare("SELECT id,revision FROM memory_sources WHERE message_id='source-message'").get()!;
  const hits = [f.add("current"), f.add("stale-source"), f.add("old-version", undefined, 1, "superseded"), { id: "missing", version: 9, score: 1 }];
  database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,8)").run("stale-source", source.id, source.revision);
  updateMessage("thread", { id: "source-message", at: 1, role: "user", kind: "text", text: "corrected" });
  const result = await searchMemory("current only", f.access, bridgeFor(hits));
  expect(result.hits.map(hit => hit.id)).toEqual(["current"]);
});

it.each(["expired", "revoked", "policy"])("rechecks %s authority after the worker response", async reason => {
  const f = fixture(); const hit = f.add("allowed");
  const bridge = bridgeFor([hit], () => {
    if (reason === "expired") f.expire();
    else if (reason === "revoked") f.registry.revokeThread("thread");
    else database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  });
  await expect(searchMemory(`after worker ${reason}`, f.access, bridge)).rejects.toThrow(reason === "policy" ? "MEMORY_CONTEXT_REVOKED" : "MEMORY_UNAUTHORIZED");
});

it("performs a final fresh check when capability expiry occurs during synchronous hydration", async () => {
  const f = fixture(); const hit = f.add("allowed");
  // The bridge fixture advances its fake clock when score is copied into the
  // hydrated result, after scope validation. No authorization function is mocked.
  const expiresWhileHydrating = { id: hit.id, version: hit.version, get score() { f.expire(); return 1; } };
  await expect(searchMemory("expires at delivery", f.access, bridgeFor([expiresWhileHydrating]))).rejects.toThrow("MEMORY_UNAUTHORIZED");
});
