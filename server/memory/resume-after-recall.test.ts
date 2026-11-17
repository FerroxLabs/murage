import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
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
import { appendMessage, closeMessageDb } from "../message-db.ts";
import { lineageLive } from "./deny-read.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureBranchChange, captureSource } from "./capture.ts";
import { continuationMemoryRevoked } from "./disclosures.ts";
import { buildMemoryBundleAfterReset, CONTENT_SESSION_READER, MemoryDispatchReceipt, memorySessionRevoked, retainedSessionInvalid, resumedSessionInvalidAfterRecall } from "./dispatch.ts";
import { prepareRecallContextSync } from "./recall-view.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { databaseStamp } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { noteSessionFrame } from './session-proof-schema.ts';
import { initializeFreshSessionProof } from './session-proof.ts';
import { WritetimeFixture, stampFreshSession } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => { thawRootSetWritesForTest(false); closeMessageDb(); });

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
const registry = new InternalCapabilities();
function access() {
  registry.begin("bot", "chat", "g");
  prepareRecallContextSync("bot", "chat", roster);
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };

/** Thread A's session s1 was shown a record resting on thread B's ("older") message m1. */
async function shownSession() {
  const text = "The alarm code is 4812.";
  storeAnchorMessage(database(), "older", "m1", text); captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  // MAIN RULING 1115-RECALL-DESIGN-GROK: a cited message needs the real writer's line row.
  new WritetimeFixture(database()).lineage('older','m1',2,{generated:false,turnLsn:null});
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()}), turn, "engine");
  // MAIN RULING 1115-RECALL-DESIGN-GROK: model the fresh provider event's durable state before the receipt binds.
  stampFreshSession(database(), "chat", "engine", "s1");
  noteSessionFrame(database(),{threadId:'chat',driverInstance:'engine',nativeSession:'s1'},false);
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
  // MAIN RULING 1115-RECALL-HELD-REPLACE: an old cite changed in the durable log; the same session is refused.
  expect(why.reason).toMatch(/^(memory-changed|changed:source)/);
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
  const receiptAt = source.indexOf("memoryReceipt=new MemoryDispatchReceipt(bundle,access,instanceId,turnLineage)");
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
  // MAIN RULING 1115-RECALL-HELD-REPLACE: the recall-free steer check uses the unified proof.
  expect(source.slice(holdsAt, holdsAt + 1100)).toMatch(/receipt\.steerable\(\)[\s\S]*proveRetainedSession\(/);
  // (1.0.2: only for an engine that can take the line mid-turn; any other
  // queues it, and that turn's own pre-submit check decides)
  const gateAt = source.indexOf("const memorySessionHolds = steerable && steerSessionHolds();");
  const steerAt = source.indexOf("memorySessionHolds, {", gateAt);
  // MAIN RULING INT-CONFLICT-DEFAULT and 1115-SOURCE-PINS (A7): retain the exact owner/command/isolation gate and the integrated refusal checks.
  expect(source.slice(gateAt - 350, gateAt)).toContain('const steerable = !isEngineCommand && !unprovenSend && (!directRuns.get(threadId)?.isolated || answerTurnLive()) && Boolean(steerAdapter && cardSteeringMode(steerAdapter) === "steer");');
  expect(source).toContain("reason=steer-refused sealed");
  expect(source).toContain('noteContinuationReset(threadId, currentAtStart.modelSelection.instanceId, "steer-refused session-invalid");');
  expect(gateAt).toBeGreaterThan(holdsAt);
  expect(steerAt).toBeGreaterThan(gateAt);
  expect(source.slice(steerAt, steerAt + 200)).toContain("holds: steerSessionHolds,");
  const lineage = readFileSync(new URL("../steer-lineage.ts", import.meta.url), "utf8");
  expect(lineage).toContain("if (!opts.holds()) throw new Error(\"MEMORY_CONTEXT_REVOKED\");");
  const dispatch = readFileSync(new URL("./dispatch.ts", import.meta.url), "utf8");
  // MAIN RULING 1115-RECALL-GROK-Q1Q2: pin the explicit submission-only waiver switch and retain the ordinary live-access proof assertion.
  expect(dispatch).toMatch(/private assertSessionCurrent\(submission=false\) \{[\s\S]*?proveRetainedSession\(/);
});

// Room members resume a retained session only after proveRetainedSession
// returns resume. A failed proof resets and replays the allowed transcript;
// rooms are never steered.
it("a room member resets only invalid sessions, resumes valid sessions and is never steered", async () => {
  const order: string[] = [];
  const bridge = { async search() { order.push("recall"); return { hits: [], vectorRows: 0, coverageComplete: false }; } };
  await buildMemoryBundleAfterReset("alarm code", access(), bridge, async () => { order.push("reset"); }, {allowance: LineageAllowance.tool(1_000_000_000)});
  expect(order[0]).toBe("reset");
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  // MAIN RULING INT-CONFLICT-DEFAULT: the integrated turn wrapper delegates to this same checked dispatch body.
  const start = source.indexOf("async function runGroupMemberTurnDispatch(");
  const end = source.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  const room = source.slice(start, end);
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: valid room sessions survive readiness/checking recovery; a decided reset still precedes recall.
  expect(room).toContain("const resetRoomMemberSession = async () => {\n    if(instance.adapter.resetSession)await instance.adapter.resetSession(threadId);");
  expect(room).toContain("const bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker,undefined,");
  // and the engine is told so explicitly, in every memory mode (round 3)
  expect(room).toContain("...(roomSessionMoved || roomMemoryReset ? { sessionReset: true } : {}),");
  expect(room).toContain("MEMORY_SESSION_RESET_UNAVAILABLE");
  expect(room).not.toContain("buildMemoryBundle(query");
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: validated retained room
  // sessions must reach the driver too, or idle process eviction discards them.
  expect(room).toContain('...(roomContinuedSession && !roomMemoryReset && !roomSessionMoved ? { resumeCursor: roomContinuedSession } : {}),');
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: recovery count alone cannot reset;
  // the existing retained-session checks still decide genuine resets.
  expect(room).not.toContain("if (memoryRedispatch >= 1)");
  expect(room).toContain("const sessionBad=");
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: disclosure alone is never a reset cause.
  // MAIN RULING 2026-11-17T10:41Z: the room's last-resort rebuild (roomLastResort) is the one further allowed reset cause (d9142cfa38).
  expect(room).toContain("if(sessionBad||rootsBad||roomSessionMoved||roomLastResort){");
  expect(room).not.toMatch(/if\([^)]*disclosed[^)]*\)\{\s*const reason=/);
  // a last-resort rebuild starts on a fresh session; a normal room resume keeps the validated one
  expect(room).toContain('roomLastResort?"last-resort":"output-roots"');
  expect(room).toContain("const roomLastResort = memoryLastResort;");
  expect(room).toContain("} else if(!roomMemoryReset) roomContinuedSession=keptSession;");
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: retained receipt validation now covers room recovery too.
  // MAIN RULING 1115-RECALL-HELD-REPLACE: room receipts retain their live proof context.
  expect(room).toContain("memoryReceipt.retains(roomContinuedSession,{access,disclosed:Boolean(retained?.disclosed)})");
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
  // (U22 G20 #8: the backup gate may refuse first and return its refusal; it never reaches the resend either)
  // MAIN RULING INT-CONFLICT-DEFAULT: 12a1e5046b -> f61c62cf35 adds the reviewed failover application/ticket metadata; all task/ordering guards below remain.
  const failOver = source.indexOf("function failOverThread(turn: { botId: string; threadId: string; selection: ModelSelection; sourceMessageId: string; phoneHeld?: boolean; rowId?: string; application?: LimitApplication; ticket?: object }, to: ModelSelection, resetsAt: number | null, now: number): FailoverRow | { refused: BackupRefusal } | null {");
  expect(failOver).toBeGreaterThan(0);
  const failOverEnd = source.indexOf("\n}\n", failOver);
  const taskCheck = source.indexOf("\n  const task = store.taskByThread(turn.botId, turn.threadId);\n  if (!task) return null;", failOver);
  const resendCall = source.indexOf("\n  resendFailover(row);", failOver);
  expect(taskCheck).toBeGreaterThan(failOver);
  expect(resendCall).toBeGreaterThan(taskCheck);
  expect(resendCall).toBeLessThan(failOverEnd);
  // QW Q1: acceptBotSend admits through admitDirectSend, which holds the one steer (an ask_user answer shares it)
  const accept = source.indexOf("async function acceptBotSend(");
  const admit = source.indexOf("return admitDirectSend({ bot, threadId, row, text, replyTo, sendId, origin, unprovenSend, ownerActs: ownerActsFact, ...(phoneCarry ? { phoneCarry } : {}), ...(row.queueOnly ? { queueOnly: true } : {})", accept); // VENUE-POST appends its postTo pick after this
  const admitter = source.indexOf("function admitDirectSend(");
  const steer = source.indexOf("steerWithQuoteLineage(", admitter);
  expect(accept).toBeGreaterThan(0);
  expect(admit).toBeGreaterThan(accept);
  expect(admit).toBeLessThan(source.indexOf("\n}\n", accept));
  expect(admitter).toBeGreaterThan(0);
  expect(steer).toBeGreaterThan(admitter);
  expect(steer).toBeLessThan(source.indexOf("\n}\n", admitter));
  // MAIN RULING INT-CONFLICT-DEFAULT: 12a1e5046b -> f61c62cf35 uses the indexed own-task target query, with the same required target guard.
  expect(source).toContain("const threadId=requireDirectThreadTarget(store.directTaskTargets(botId),requested);");
});

useOutsideStoreFixture();

it("a valid held room session needs no direct replay proof, and a later durable denial still refuses its receipt", async () => {
  // Use the real line writer: a legacy file with no lineage rows deliberately
  // uses the legacy predicate and cannot exercise a write-time session denial.
  closeMessageDb();
  appendMessage("chat", { id: "held-owner", role: "user", kind: "text", text: "Fixture held room input.", at: 1 });
  expect(lineageLive(database())).toBe(true);
  const turn = access();
  stampFreshSession(database(), "chat", "engine", "held-room");
  expect(retainedSessionInvalid(LineageAllowance.tool(), "chat", "engine", "held-room", {}, CONTENT_SESSION_READER)).toBe(false);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, { allowance: LineageAllowance.tool() }), turn, "engine");
  // MAIN RULING 1115-RECALL-HELD-REPLACE: live access proves an undisclosed room session.
  // MAIN RULING 1115-RECALL-DESIGN-GROK: a warm recall-free session carries the checkpoint established at its fresh start.
  noteSessionFrame(database(),{threadId:'chat',driverInstance:'engine',nativeSession:'held-room'},false);
  initializeFreshSessionProof({threadId:'chat',driverInstance:'engine',nativeSession:'held-room'},turn);
  receipt.retains("held-room", {access:turn,disclosed:false});
  expect(() => receipt.assertCurrent()).not.toThrow();
  database().prepare("INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES('chat','engine','held-room',700004)").run();
  database().exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
  expect(() => receipt.assertCurrent()).toThrow("MEMORY_CONTEXT_REVOKED");
});

// MAIN RULING 2026-11-17T10:41Z: exercise the shipped room-reset block, including normal resume.
it.each([true,false])('room last-resort=%s resets only the rebuild session',async roomLastResort=>{
 const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
 const start=source.indexOf('    if(sessionBad||rootsBad||roomSessionMoved');
 const end=source.indexOf('    if(roomMemoryMode',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const run=new Function('roomLastResort',`return (async()=>{
  const sessionBad=false,rootsBad=false,roomSessionMoved=false,sessionWhy={};
  const threadId='thread',instance={instanceId:'engine'},roomStoredMemoryMode='active';
  const memoryState=()=>({mode:'active'}),allowance={renew(){}},noteContinuationReset=()=>{},console={warn(){}};
  let resets=0;const resetRoomMemberSession=async()=>{resets++;};
  const roomRetainedKey='member',roomRetainedMemory=new Map([['member',{}]]),keptSession='kept-session';
  let roomMemoryReset=false,roomContinuedSession;
  ${source.slice(start,end)}
  return {resets,roomMemoryReset,roomContinuedSession,retained:roomRetainedMemory.has(roomRetainedKey)};
 })()`);
 expect(await run(roomLastResort)).toEqual(roomLastResort
  ?{resets:1,roomMemoryReset:true,roomContinuedSession:undefined,retained:false}
  :{resets:0,roomMemoryReset:false,roomContinuedSession:'kept-session',retained:true});
});
