import { prepareRecallContextSync } from "./recall-view.ts";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { captureSendReplayProof, confirmFreshReplaySession, recordSessionRoots, sendReplaySessionCurrent, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import * as warm from "./lineage-warm.ts";
import { lineageWarmTestSurface } from "./lineage-warm-surface.ts";

const roster = { memoryRosterRevision: 1, bots: [{ id: "bot", threadId: "chat" }], groups: [] };
function access() {
  const registry = new InternalCapabilities(), generation = registry.begin("bot", "chat");
  const token = registry.mint({ botId: "bot", threadId: "chat", generation, kind: "memory", depth: 0, skillAuthoring: false });
  prepareRecallContextSync("bot", "chat", roster);
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
beforeEach(() => {
  warm.resetLineageWarmForTest(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); resetSessionHolds(); thawRootSetWritesForTest(true);
  database().exec(`CREATE TABLE IF NOT EXISTS send_replay_exclusions (
    thread_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT,reason TEXT NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(thread_id,message_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS send_replay_epochs(thread_id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL);`);
});
afterEach(() => { lineageWarmTestSurface().useSources(null); warm.resetLineageWarmForTest(); thawRootSetWritesForTest(false); closeDatabase(); });

it("F7-WARM: an already-kept native-session hold cannot survive a replay exclusion", () => {
  const db = database(), who = access();
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('receipt','chat','engine','session','[]','[]','[]',?,?,0,'delivered',1)").run(who.policyRevision, who.deletionEpoch);
  recordSessionRoots("chat", "engine", "session", { roots: new Set(), over: false });
  stampFreshSession(db, "chat", "engine", "session");
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "session", who)).toBe(false);
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "session", who)).toBe(false);
  db.exec("INSERT INTO send_replay_exclusions VALUES('chat','failed','attempt','uncertain',1); INSERT INTO send_replay_epochs VALUES('chat',1)");
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "session", who, why)).toBe(true);
  expect(why.reason).toBe("send-replay-changed");
});

it("F7-WARM: confirmed warm proof invalidates on same-connection exclusion changes without message writes", () => {
  const db = database();
  db.exec(`INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','history',1,'user','text','history','{"id":"history","role":"user","kind":"text","text":"history","at":1}')`);
  lineageWarmTestSurface().useSources({ mint: () => access() });
  warm.bumpLineageWarm("chat"); warm.kickLineageWarm();
  let steps = 0;
  while (warm.lineageWarmStep(25)) if (++steps > 10000) throw new Error("warm did not settle");
  expect(warm.lineageThreadState("chat")).toBe("warm");
  db.exec("INSERT INTO send_replay_exclusions VALUES('chat','history','attempt','not_submitted',1); INSERT INTO send_replay_epochs VALUES('chat',1)");
  expect(warm.lineageThreadState("chat")).not.toBe("warm");
});

it("F7-WARM: a positively fresh session keeps its proof until a source revision changes, then restart fails closed", () => {
  const db = database();
  db.exec("INSERT INTO send_replay_epochs VALUES('chat',1)");
  const proof = captureSendReplayProof("chat", []);
  expect(sendReplaySessionCurrent("chat", "engine", "old")).toBe(false);
  confirmFreshReplaySession("chat", "engine", "fresh", proof);
  expect(sendReplaySessionCurrent("chat", "engine", "fresh")).toBe(true);
  db.exec("UPDATE send_replay_epochs SET revision=2 WHERE thread_id='chat'");
  expect(sendReplaySessionCurrent("chat", "engine", "fresh")).toBe(false);
  expect(() => confirmFreshReplaySession("chat", "engine", "stale", proof)).toThrow("SEND_REPLAY_CHANGED");
  closeDatabase(); database();
  expect(sendReplaySessionCurrent("chat", "engine", "fresh")).toBe(false);
});
