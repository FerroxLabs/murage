// A resumed turn awaits recall after its continuation check. Thread B's branch
// change can retire a source thread A's session was shown on an earlier turn in
// that window; B revokes only B's receipts, so the receipt-state probe misses it.
// The whole session is rechecked after the await, before the prompt goes out.
import { mkdirSync, readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
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
import { LineageAllowance } from "./lineage-allowance.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
const registry = new InternalCapabilities();
function access() {
  registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };

/** Thread A's session s1 was shown a record resting on thread B's ("older") message m1. */
async function shownSession() {
  const text = "The alarm code is 4812.";
  storeAnchorMessage(database(), "older", "m1", text); captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()}), turn, "engine");
  receipt.sessionStarted("s1");
  stampFreshSession(database(), "chat", "engine", "s1"); // a 1.0.3 fresh start leaves its lineage row stamped (S6 rule 26)
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  receipt.output("reply-1");
}

it("thread B retires a source shown to A while A awaits recall: A does not resume with it", async () => {
  await shownSession();
  const turn = access();
  // The dispatch step's check passes and its stamp is taken.
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "s1", turn)).toBe(false);
  const checked = databaseStamp();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let searching!: () => void;
  const started = new Promise<void>(resolve => { searching = resolve; });
  const bridge = { async search() { searching(); await gate; return { hits: [], vectorRows: 0, coverageComplete: false }; } };
  const recall = buildMemoryBundle("what is the alarm code", turn, bridge, {allowance: LineageAllowance.tool()});
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
  expect(resumedSessionInvalidAfterRecall(LineageAllowance.tool(), "chat", "engine", "s1", turn, checked, why)).toBe(true);
  expect(why.reason).toMatch(/^memory-changed/);
});

it("an unmoved database skips the recheck, and a session that still holds resumes", async () => {
  await shownSession();
  const turn = access();
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "s1", turn)).toBe(false);
  const checked = databaseStamp();
  expect(resumedSessionInvalidAfterRecall(LineageAllowance.tool(), "chat", "engine", "s1", turn, checked)).toBe(false);
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
  expect(resumedSessionInvalidAfterRecall(LineageAllowance.tool(), "chat", "engine", "s1", turn, checked)).toBe(false);
});

it("the dispatch path rechecks after the recall await and before the receipt is made", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const awaitAt = source.indexOf("bundle=await buildMemoryBundle(query,access,memoryWorker,memoryOptions)");
  const recheckAt = source.indexOf("resumedSessionInvalidAfterRecall(allowance,threadId,instanceId,resumeKey().nativeSession,access,checkedStamp");
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
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()}), turn, "engine");
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
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()}), turn, "engine");
  receipt.resumes("s1");
  receipt.sessionStarted("s1");
  expect(receipt.steerable()).toBe(true);
  captureBranchChange(database(), "older", null);
  expect(memorySessionRevoked("chat", "engine", "s1")).toBe(false);
  expect(receipt.steerable()).toBe(false);
});

it("the image-await check and the live steer both go through the full session validation", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const imagesAt = source.indexOf("await collectTurnImages(instance.driverKind, threadId, bot.id, imageText)");
  const afterImages = source.indexOf("memoryReceipt?.assertCurrent();", imagesAt);
  expect(imagesAt).toBeGreaterThan(0);
  expect(afterImages).toBeGreaterThan(imagesAt);
  // the steer gate runs the receipt's full check, or with no receipt the
  // retained session's own (memory off), and the same gate is the steer's
  // write fence, run again right before a late write (round 3)
  const holdsAt = source.indexOf("const steerSessionHolds = (): boolean => {");
  expect(source.slice(holdsAt, holdsAt + 800)).toMatch(/receipt\.steerable\(\)[\s\S]*retainedSessionInvalid\(/);
  // (1.0.2: only for an engine that can take the line mid-turn; any other
  // queues it, and that turn's own pre-submit check decides)
  const gateAt = source.indexOf("const memorySessionHolds = steerable && steerSessionHolds();");
  const steerAt = source.indexOf("memorySessionHolds, {", gateAt);
  expect(source.slice(gateAt - 300, gateAt)).toMatch(/const steerable = !isEngineCommand && !unprovenSend && Boolean\(instance && cardSteeringMode\(instance\.adapter\) === "steer"\);/);
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
  await buildMemoryBundleAfterReset("alarm code", access(), bridge, async () => { order.push("reset"); }, {allowance: LineageAllowance.tool(1_000_000_000)});
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
  // the one steer call is the owner's send to a bot's own chat (acceptBotSend, 1.0.4 SL-I I4), limited to the bot's own task threads:
  // reached only from the direct-message route, after the bot and its task are resolved, and from a limit failover's resend of the
  // owner's own message into the same task
  expect(source.split("steerBusyDesk(").length - 1).toBe(0);
  expect(source.split("steerWithQuoteLineage(").length - 1).toBe(1);
  const route = source.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);");
  const direct = source.indexOf("const bot = requestedDirectBot(m[1],body.threadId);", route);
  const ownTask = source.indexOf("if (!store.taskByThread(bot.id, threadId)) {", direct);
  expect(route).toBeGreaterThan(0);
  expect(direct).toBeGreaterThan(route);
  expect(ownTask).toBeGreaterThan(direct);
  // the direct route (after its own-task check) and a limit failover's resend are the only two ways into acceptBotSend
  const callers = [...source.matchAll(/acceptBotSend\(\{/g)].map(match => match.index!);
  expect(callers).toHaveLength(2);
  expect(callers.filter(at => at > ownTask && at < source.indexOf("\n    m = path.match(", ownTask))).toHaveLength(1);
  const resend = source.indexOf("function resendFailover(row: FailoverRow): void {");
  expect(resend).toBeGreaterThan(0);
  expect(callers.filter(at => at > resend && at < source.indexOf("\n}\n", resend))).toHaveLength(1);
  // the failover's thread is a task of the bot it fails over (failOverThread resolves it before the resend)
  expect(source).toContain("function failOverThread(turn: { botId: string; threadId: string; selection: ModelSelection; sourceMessageId: string; phoneHeld?: boolean }, to: ModelSelection, resetsAt: number | null, now: number): FailoverRow | null {\n  const task = store.taskByThread(turn.botId, turn.threadId);\n  if (!task) return null;");
  // QW Q1: acceptBotSend admits through admitDirectSend, which holds the one steer (an ask_user answer shares it)
  const accept = source.indexOf("async function acceptBotSend(");
  const admit = source.indexOf("return admitDirectSend({ bot, threadId, row, text, replyTo, sendId, origin, unprovenSend, ownerActs: ownerActsFact, ...(phoneCarry ? { phoneCarry } : {}) });", accept);
  const admitter = source.indexOf("function admitDirectSend(");
  const steer = source.indexOf("steerWithQuoteLineage(", admitter);
  expect(accept).toBeGreaterThan(0);
  expect(admit).toBeGreaterThan(accept);
  expect(admit).toBeLessThan(source.indexOf("\n}\n", accept));
  expect(admitter).toBeGreaterThan(0);
  expect(steer).toBeGreaterThan(admitter);
  expect(steer).toBeLessThan(source.indexOf("\n}\n", admitter));
  expect(source).toContain("const threadId=requireDirectThreadTarget(store.tasks(botId).map(task=>task.threadId),requested);");
});
