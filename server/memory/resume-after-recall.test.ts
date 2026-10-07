// A resumed turn awaits recall after its continuation check. Thread B's branch
// change can retire a source thread A's session was shown on an earlier turn in
// that window; B revokes only B's receipts, so the receipt-state probe misses it.
// The whole session is rechecked after the await, before the prompt goes out.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureBranchChange, captureSource } from "./capture.ts";
import { continuationMemoryRevoked } from "./disclosures.ts";
import { buildMemoryBundleAfterReset, MemoryDispatchReceipt, memorySessionRevoked, resumedSessionInvalidAfterRecall } from "./dispatch.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { databaseStamp } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
const registry = new InternalCapabilities();
function access() {
  registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };

/** Thread A's session s1 was shown a record resting on thread B's ("older") message m1. */
async function shownSession() {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.sessionStarted("s1");
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-1");
}

it("thread B retires a source shown to A while A awaits recall: A does not resume with it", async () => {
  await shownSession();
  const turn = access();
  // The dispatch step's check passes and its stamp is taken.
  expect(continuationMemoryRevoked("chat", "engine", "s1", turn)).toBe(false);
  const checked = databaseStamp();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let searching!: () => void;
  const started = new Promise<void>(resolve => { searching = resolve; });
  const bridge = { async search() { searching(); await gate; return { hits: [], vectorRows: 0, coverageComplete: false }; } };
  const recall = buildMemoryBundle("what is the alarm code", turn, bridge);
  await started;
  // Thread B's branch change: its message m1 leaves the branch, B's receipts are revoked, A's are not.
  captureBranchChange(database(), "older", null);
  expect(String(database().prepare("SELECT state FROM memory_sources WHERE id='message:older:m1'").get()!.state)).toBe("retired");
  release();
  const bundle = await recall;
  // The new bundle omits the source and A's receipts are still delivered: the state probe passes.
  expect(JSON.stringify(bundle.sourceVersions)).not.toContain("message:older:m1");
  expect(memorySessionRevoked("chat", "engine", "s1")).toBe(false);
  const why: { reason?: string } = {};
  expect(resumedSessionInvalidAfterRecall("chat", "engine", "s1", turn, checked, why)).toBe(true);
  expect(why.reason).toMatch(/^memory-changed/);
});

it("an unmoved database skips the recheck, and a session that still holds resumes", async () => {
  await shownSession();
  const turn = access();
  expect(continuationMemoryRevoked("chat", "engine", "s1", turn)).toBe(false);
  const checked = databaseStamp();
  expect(resumedSessionInvalidAfterRecall("chat", "engine", "s1", turn, checked)).toBe(false);
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
  expect(resumedSessionInvalidAfterRecall("chat", "engine", "s1", turn, checked)).toBe(false);
});

it("the dispatch path rechecks after the recall await and before the receipt is made", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const awaitAt = source.indexOf("bundle=await buildMemoryBundle(query,access,memoryWorker,memoryOptions)");
  const recheckAt = source.indexOf("resumedSessionInvalidAfterRecall(threadId,instanceId,String(resumeCursor),access,checkedStamp");
  const resetAt = source.indexOf("bundle=await buildMemoryBundleAfterReset(");
  const receiptAt = source.indexOf("memoryReceipt=new MemoryDispatchReceipt(bundle,access,instanceId)");
  expect(awaitAt).toBeGreaterThan(0);
  expect(recheckAt).toBeGreaterThan(awaitAt);
  expect(resetAt).toBeGreaterThan(recheckAt);
  expect(receiptAt).toBeGreaterThan(resetAt);
});

it("thread B retires a source shown to A during the image await: the last pre-submit check refuses the stale session", async () => {
  await shownSession();
  const turn = access();
  // A's resumed turn: the after-recall check passed and its receipt resumes s1.
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.resumes("s1");
  expect(() => receipt.assertCurrent()).not.toThrow();
  // While A awaits image collection, B's branch change retires m1; A's receipts stay delivered.
  captureBranchChange(database(), "older", null);
  expect(memorySessionRevoked("chat", "engine", "s1")).toBe(false);
  // The check after the image await, and the submission boundary, both run the full validation.
  expect(() => receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => receipt.accepted()).toThrow("MEMORY_CONTEXT_REVOKED");
  // The refusal is persisted: the once-only re-dispatch finds the session revoked and resets.
  expect(memorySessionRevoked("chat", "engine", "s1")).toBe(true);
});

it("a steer into a running session whose disclosed source was retired is refused", async () => {
  await shownSession();
  const turn = access();
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.resumes("s1");
  receipt.sessionStarted("s1");
  expect(receipt.steerable()).toBe(true);
  captureBranchChange(database(), "older", null);
  expect(memorySessionRevoked("chat", "engine", "s1")).toBe(false);
  expect(receipt.steerable()).toBe(false);
});

it("the image-await check and the live steer both go through the full session validation", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const imagesAt = source.indexOf("await collectTurnImages(instance.driverKind, threadId, bot.id, text)");
  const afterImages = source.indexOf("memoryReceipt?.assertCurrent();", imagesAt);
  expect(imagesAt).toBeGreaterThan(0);
  expect(afterImages).toBeGreaterThan(imagesAt);
  // the steer gate runs the receipt's full check, or with no receipt the
  // retained session's own (memory off), and the same gate is the steer's
  // write fence, run again right before a late write (round 3)
  const holdsAt = source.indexOf("const steerSessionHolds = (): boolean => {");
  expect(source.slice(holdsAt, holdsAt + 600)).toMatch(/receipt\.steerable\(\)[\s\S]*retainedSessionInvalid\(/);
  const gateAt = source.indexOf("const memorySessionHolds = steerSessionHolds();");
  const steerAt = source.indexOf("!isEngineCommand && !unprovenSend && memorySessionHolds,", gateAt);
  expect(gateAt).toBeGreaterThan(holdsAt);
  expect(steerAt).toBeGreaterThan(gateAt);
  expect(source.slice(steerAt, steerAt + 200)).toContain("holds: steerSessionHolds,");
  const lineage = readFileSync(new URL("../steer-lineage.ts", import.meta.url), "utf8");
  expect(lineage).toContain("if (!opts.holds()) throw new Error(\"MEMORY_CONTEXT_REVOKED\");");
  const dispatch = readFileSync(new URL("./dispatch.ts", import.meta.url), "utf8");
  expect(dispatch).toMatch(/private assertSessionCurrent\(\) \{[\s\S]*?resumedSessionInvalid\(/);
});

// Room (group) member turns never resume a retained session that carries
// disclosures, so they need no resumed-session check: with memory active the
// engine session is always reset before the bundle is built, no resume cursor
// reaches the engine, and no steer reaches a room thread. Pinned here.
it("a room member turn resets the engine session before its bundle and never resumes or is steered", async () => {
  const order: string[] = [];
  const bridge = { async search() { order.push("recall"); return { hits: [], vectorRows: 0, coverageComplete: false }; } };
  await buildMemoryBundleAfterReset("alarm code", access(), bridge, async () => { order.push("reset"); });
  expect(order[0]).toBe("reset");
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runGroupMemberTurn(");
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  const room = source.slice(start, end);
  // memory active: the bundle is built only after the adapter reset (or the turn is refused)
  expect(room).toContain("const resetRoomMemberSession = async () => {\n    if(instance.adapter.resetSession)await instance.adapter.resetSession(threadId);");
  expect(room).toContain("const bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker,resetRoomMemberSession,");
  // and the engine is told so explicitly, in every memory mode (round 3)
  expect(room).toContain("...(roomSessionMoved || roomMemoryReset ? { sessionReset: true } : {}),");
  expect(room).toContain("MEMORY_SESSION_RESET_UNAVAILABLE");
  expect(room).not.toContain("buildMemoryBundle(query");
  // no resume cursor reaches the engine, and the receipt never resumes a session
  expect(room).not.toMatch(/resumeCursor/);
  expect(room).not.toMatch(/\.resumes\(/);
  expect(room).not.toMatch(/steerBusyDesk|steerWithQuoteLineage|\.steer\(/);
  // the one steer call is the direct-message route, limited to the bot's own task threads
  expect(source.split("steerBusyDesk(").length - 1).toBe(0);
  expect(source.split("steerWithQuoteLineage(").length - 1).toBe(1);
  const route = source.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);");
  const direct = source.indexOf("const bot = requestedDirectBot(m[1],body.threadId);", route);
  const steer = source.indexOf("steerWithQuoteLineage(", route);
  expect(route).toBeGreaterThan(0);
  expect(direct).toBeGreaterThan(route);
  expect(steer).toBeGreaterThan(direct);
  expect(source).toContain("const threadId=requireDirectThreadTarget(store.tasks(botId).map(task=>task.threadId),requested);");
});
