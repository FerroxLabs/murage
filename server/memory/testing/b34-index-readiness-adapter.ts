// B34 Q06 join adapter (Claude 4 lane, T2): old episodic evidence with
// unrelated recent context, through the runner's isolated server (scripted fake
// Claude CLI, keyword index, no model, no network). Loaded by Claude 5's runner
// scripts/b34-receipt-matrix.ts as `b34Q06Adapter` per lane-5
// B34-ADAPTER-CONTRACT.md; returns the strict Q06 artifact only.
//
// Readiness is waited on from evidence, never a timer or a saved-row wait:
//   - the owner message is captured as memory_sources speaker 'owner'
//     (capture.ts:45-58) with a memory_jobs capture row (capture.ts:39-40);
//   - the worker publishes it: job 'complete' with coverage, a kind='source'
//     record whose id is sha256(sourceId:revision:start:end) with evidence to
//     that (source, revision) (jobs.ts:111-124);
//   - the projection receipt is lexical_status 'indexed' (worker-controller.ts:103-108),
//     which also removes it from the unindexed recent fallback (recent.ts:35);
//   - GET /api/memory/status health.processed counts it and its lastAt covers
//     it (health.ts:36-38, 44; settings.ts:163).
// Supply: a later task's frame carries it as "(the owner said; source)"
// (bundle.ts:106-118) at a handle whose position names the same record in the
// delivered disclosure receipt (bundle.ts:221-223, disclosures.ts:26-32, the
// receipt is accepted in beforeSubmit, index.ts:4681-4684 via dispatch.ts:36-39), and health.supplied
// reflects the delivery (health.ts:39, 46).
// Degradation: the engine's memory capability search reports
// local-model-unavailable or semantic-index-unavailable (worker.ts:22-33,
// routes.ts:51-54) because the fresh profile has no semantic model.
// Abstention: thread checkpoints are delivered regardless of the query
// (bundle.ts:173-180, consolidate.ts:70), so an unsupported question is judged
// on recalled evidence lines: none may be anything but a checkpoint.
// Isolation: another bot's request and a room request lack the canary.
//
// Canary semantics: the canary is part of the old owner statement itself. Q06
// checks its presence in a later task's frame and its absence from other-bot
// and room requests, not supersession, so a captured source carrying it is the
// intended evidence.
//
// Not covered, never claimed: person isolation is unreachable at the
// isolated-server tier because human bindings exist only through the channel
// services (index.ts:5235-5344 via human-principals.ts); it stays an unmet gap
// for root. Named-model answers, semantic paraphrase retrieval, wall-clock
// ageing and long-history scale are also outside this tier.
//
// No pin, no database write (ctx.db() is read-only), no receipt access, no
// Vitest. Check details carry identifiers, counts and statuses only. Turn text
// avoids opaque references (word_word, ABC-1, paths, URLs; relevance.ts:9-11)
// except the fake CLI's own hold marker on the held capability turn.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../../../shared/memory.ts";
import type { AdapterArtifactsFor, AdapterRecordRef, B34Adapter, B34AdapterContext, Bot, Dump } from "./b34-adapter-types.ts";

// Wording from server/memory/testing/corpus.json: source-00 (old evidence),
// source-01..03 (unrelated recent context), exact-00 (later question) and
// none-00 (abstention question). Isolation questions are fixture-authored.
const OLD_STATEMENT = "Releases require two reviewers before production deployment.";
const CANARY = "two reviewers";
const DISTRACTORS = [
  "Database backups run at 02:00 UTC and are retained for 30 days.",
  "The application stores authoritative records in SQLite.",
  "Refund requests must include the original purchase receipt.",
] as const;
const SUPPLIED_QUESTION = "How many people must approve a production rollout?";
const ABSTAIN_QUESTION = "Nobody decided to replace the release rule with automatic approval. What approved replacement exists?";
// The fake CLI holds a turn open when the marker is the prompt's last line (fake-claude-cli.ts:104, 534-553).
const HELD_TEXT = "Check the notes before answering this one.\n__fixture_hold_authority__";
const OTHER_BOT_QUESTION = "For this bot only, how many people must approve a production rollout?";
const ROOM_QUESTION = "For this room, how many people must approve a production rollout?";
const DEGRADATION_REASONS = new Set(["local-model-unavailable", "semantic-index-unavailable"]);
const MEMORY_MODES = new Set(["off", "capture", "active", "paused"]);
const READY_TIMEOUT_MS = 45_000;

type Row = Record<string, unknown>;
type SourceState = {
  sourceId: string; revision: number; createdAt: number; owner: boolean; runnerPin: boolean;
  job: string | null; record: AdapterRecordRef | null; derived: boolean; lexical: string | null; embedding: string | null;
};
type Counters = { processedSources: number; processedAt: number | null; suppliedTurns: number; suppliedReferences: number; suppliedAt: number | null };
type Readiness = { source: SourceState | null; health: Counters | null };
type FrameLine = { position: number; attribution: string; kind: string; pinned: boolean; text: string | null };

const dumpContent = (dump: Dump) => String(dump.prompt?.message?.content ?? "");
const sameRecord = (left: AdapterRecordRef | null, right: AdapterRecordRef) => left !== null && left.id === right.id && left.version === right.version;

/** ctx.until, except a timeout returns null so the caller can record a failed check with its evidence. */
async function eventually<T>(ctx: B34AdapterContext, label: string, read: () => T | undefined | Promise<T | undefined>, timeout: number): Promise<T | null> {
  try { return await ctx.until(label, read, timeout); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out: ")) return null;
    throw error;
  }
}

/** The captured owner text source in a thread, its capture job, the worker-published source record and its projection. */
function readSource(ctx: B34AdapterContext, threadId: string, text: string): SourceState | null {
  const db = ctx.db();
  const source = db.prepare(`SELECT s.id,s.revision,s.speaker,s.message_id,v.created_at FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id=? AND s.kind='text' AND s.state='active' AND json_extract(v.payload,'$.text')=?
    ORDER BY v.created_at DESC LIMIT 1`).get(threadId, text) as Row | undefined;
  if (!source) return null;
  const sourceId = String(source.id), revision = Number(source.revision), bytes = Buffer.byteLength(text);
  const job = db.prepare("SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'").get(sourceId, revision) as Row | undefined;
  const found = db.prepare(`SELECT r.id,r.version FROM memory_records r
    JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version
    WHERE e.source_id=? AND e.source_revision=? AND e.start_byte=0 AND e.end_byte=? AND r.kind='source' AND r.state='active'
    ORDER BY r.version DESC LIMIT 1`).get(sourceId, revision, bytes) as Row | undefined;
  const record = found ? { id: String(found.id), version: Number(found.version) } : null;
  const projection = record
    ? db.prepare("SELECT lexical_status,embedding_status FROM memory_projection_receipts WHERE record_id=? AND record_version=? ORDER BY index_generation DESC LIMIT 1").get(record.id, record.version) as Row | undefined
    : undefined;
  return {
    sourceId, revision, createdAt: Number(source.created_at), owner: source.speaker === "owner",
    runnerPin: String(source.message_id ?? "").startsWith("fixture-message-"), job: job ? String(job.status) : null, record,
    // jobs.ts:114: the worker derives a chunk record id from the source revision and byte span.
    derived: record !== null && record.id === createHash("sha256").update(`${sourceId}:${revision}:0:${bytes}`).digest("hex"),
    lexical: projection ? String(projection.lexical_status) : null, embedding: projection ? String(projection.embedding_status) : null,
  };
}
const indexedSource = (source: SourceState | null): source is SourceState & { record: AdapterRecordRef } =>
  source !== null && source.owner && !source.runnerPin && source.job === "complete" && source.record !== null && source.derived && source.lexical === "indexed";

async function readHealth(ctx: B34AdapterContext): Promise<Counters | null> {
  const status = await ctx.api("GET", "/api/memory/status");
  const health = status.status === 200 ? status.body?.health : undefined;
  if (!health || typeof health !== "object") return null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    processedSources: number(health.processed?.sources) ?? 0, processedAt: number(health.processed?.lastAt),
    suppliedTurns: number(health.supplied?.turns) ?? 0, suppliedReferences: number(health.supplied?.references) ?? 0, suppliedAt: number(health.supplied?.lastAt),
  };
}
const processedCovers = (readiness: Readiness, sources: number) => readiness.source !== null && readiness.health !== null
  && readiness.health.processedSources >= sources && readiness.health.processedAt !== null && readiness.health.processedAt >= readiness.source.createdAt;
const processedDetail = (readiness: Readiness) => `processed ${readiness.health ? readiness.health.processedSources : "unavailable"} sources; lastAt ${readiness.health?.processedAt === null || !readiness.health ? "missing" : "present"}`;

/** Waits until the owner text is captured no earlier than notBefore, processed, worker-derived, lexically indexed and counted by health. */
async function waitIndexed(ctx: B34AdapterContext, label: string, threadId: string, text: string, notBefore: number, processedSources: number): Promise<Readiness> {
  let last: Readiness = { source: null, health: null };
  const ready = await eventually(ctx, label, async () => {
    const source = readSource(ctx, threadId, text);
    last = { source, health: indexedSource(source) ? await readHealth(ctx) : null };
    return indexedSource(source) && source.createdAt >= notBefore && processedCovers(last, processedSources) ? last : undefined;
  }, READY_TIMEOUT_MS);
  return ready ?? last;
}

/** Lines inside the remembered-context frame (runner frame()), parsed as "- mN (attribution; kind[; pinned by the owner]) "text"". */
function frameLines(text: string): Array<FrameLine | null> {
  const start = `${MEMORY_REFERENCE_PREAMBLE}\n${MEMORY_REFERENCE_OPEN}\n`, at = text.indexOf(start);
  if (at < 0) return [];
  const end = text.indexOf(`\n${MEMORY_REFERENCE_CLOSE}`, at + start.length);
  if (end < 0) return [];
  return text.slice(at + start.length, end).split("\n").map(line => {
    const head = /^- m([1-9]\d{0,2}) \(/.exec(line);
    // Remembered text is one JSON string literal, so its own quotes are escaped and the first ') "' closes the label.
    const close = line.indexOf(") \"");
    if (!head || close < head[0].length) return null;
    const parts = line.slice(head[0].length, close).split("; ");
    const pinned = parts.at(-1) === "pinned by the owner";
    if (pinned) parts.pop();
    const kind = parts.pop() ?? "";
    let value: unknown = null;
    try { value = JSON.parse(line.slice(close + 2)); } catch { value = null; }
    return { position: Number(head[1]), attribution: parts.join("; "), kind, pinned, text: typeof value === "string" ? value : null };
  });
}

/** The memory capability env the harness mounted for a held turn (recall-journey.test.ts:52-58). */
function memoryCapability(config: unknown): { url: string; token: string } | null {
  if (!config || typeof config !== "object") return null;
  const env = (config as { env?: unknown }).env;
  if (env && typeof env === "object") {
    const { MURAGE_MEMORY_TOKEN: token, MURAGE_HARNESS_URL: url } = env as Row;
    if (typeof token === "string" && token && typeof url === "string" && url) return { url, token };
  }
  for (const child of Object.values(config)) {
    const found = memoryCapability(child);
    if (found) return found;
  }
  return null;
}

async function createTask(ctx: B34AdapterContext, bot: Bot, title: string): Promise<string> {
  const path = `/api/bots/${bot.id}/tasks`;
  const made = await ctx.setup(null, "POST", path, { title }, 201);
  const threadId: unknown = made.body?.task?.threadId;
  if (typeof threadId !== "string" || !threadId) throw new Error(`setup failed: POST ${path} HTTP ${made.status}; no task thread`);
  return threadId;
}

/** The request is the one the runner will locate by match, and neither its content nor its system prompt carries the canary. */
const isolated = (dump: Dump, match: string) => dumpContent(dump).includes(match) && !`${dumpContent(dump)}\n${dump.systemPrompt ?? ""}`.includes(CANARY);

async function runQ06(ctx: B34AdapterContext): Promise<AdapterArtifactsFor<"Q06">> {
  await ctx.setup("memory-mode-active", "GET", "/api/memory/status", undefined, 200, response => {
    const mode: unknown = response.body?.mode;
    return { ok: mode === "active", note: `mode ${typeof mode === "string" && MEMORY_MODES.has(mode) ? mode : "unrecognised"}` };
  });
  const recaller = await ctx.bot("B34 Q06 recaller"), other = await ctx.bot("B34 Q06 other");
  // Same bot settings as the accepted recall journey on this candidate (recall-journey.test.ts:80-84).
  for (const bot of [recaller, other]) await ctx.setup(null, "PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, 200);

  // 1. The old owner statement in the recaller's main thread, waited on until processed and indexed.
  await ctx.send(recaller, OLD_STATEMENT);
  const old = await waitIndexed(ctx, "old owner statement processed and indexed", recaller.threadId, OLD_STATEMENT, 0, 1);
  const oldSource = old.source;
  ctx.check("old-source-captured-as-owner-statement", Boolean(oldSource && oldSource.owner && !oldSource.runnerPin), oldSource ? `source revision ${oldSource.revision}` : "source missing");
  ctx.check("old-source-capture-job-complete", oldSource?.job === "complete", `capture job ${oldSource?.job ?? "missing"}`);
  ctx.check("old-source-record-derived-by-worker", Boolean(oldSource?.record && oldSource.derived),
    oldSource?.record ? `source record version ${oldSource.record.version}; derived id ${oldSource.derived ? "matches" : "differs"}` : "source record missing");
  ctx.check("old-source-lexically-indexed", oldSource?.lexical === "indexed", `lexical ${oldSource?.lexical ?? "missing"}; embedding ${oldSource?.embedding ?? "missing"}`);
  ctx.check("health-processed-reflects-old-source", processedCovers(old, 1), processedDetail(old));
  if (!indexedSource(oldSource) || !processedCovers(old, 1)) throw new Error("Q06 readiness not reached for the old owner statement");
  const indexed = oldSource.record;

  // 2. Unrelated recent turns, captured after the old statement, each waited on the same way.
  const distractors: SourceState[] = [];
  let latest: Readiness = old;
  for (const text of DISTRACTORS) {
    await ctx.send(recaller, text);
    latest = await waitIndexed(ctx, "unrelated recent turn processed and indexed", recaller.threadId, text, oldSource.createdAt, distractors.length + 2);
    if (!indexedSource(latest.source) || latest.source.createdAt < oldSource.createdAt) break;
    distractors.push(latest.source);
  }
  ctx.check("recent-distractors-processed-and-indexed", distractors.length === DISTRACTORS.length, `${distractors.length}/${DISTRACTORS.length} distractor sources complete, indexed and not earlier`);
  ctx.check("health-processed-reflects-distractors", distractors.length === DISTRACTORS.length && processedCovers(latest, DISTRACTORS.length + 1), processedDetail(latest));
  if (distractors.length !== DISTRACTORS.length) throw new Error("Q06 readiness not reached for the unrelated recent turns");

  // 3. The engine's memory capability on a held turn: the index serves the old record, with keyword-only degradation reported.
  const notesThread = await createTask(ctx, recaller, "Notes check");
  const held = await ctx.send(recaller, HELD_TEXT, true, notesThread);
  const capability = memoryCapability((held as Dump & { mcpConfig?: unknown }).mcpConfig);
  let searchStatus = 0, servedByIndex = false, lexicalBefore: string | null = null, reason: string | undefined;
  try {
    if (capability) {
      lexicalBefore = readSource(ctx, recaller.threadId, OLD_STATEMENT)?.lexical ?? null;
      const response = await fetch(new URL("/api/internal/memory/search", capability.url), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability.token}` },
        body: JSON.stringify({ query: SUPPLIED_QUESTION }), signal: AbortSignal.timeout(15_000),
      });
      searchStatus = response.status;
      const body: unknown = await response.json().catch(() => null);
      const result = (body && typeof body === "object" ? body : {}) as { hits?: unknown; degradedReason?: unknown };
      reason = typeof result.degradedReason === "string" ? result.degradedReason : undefined;
      // An indexed record is excluded from the unindexed recent fallback (recent.ts:35), so a hit on it came from the index.
      servedByIndex = searchStatus === 200 && lexicalBefore === "indexed" && Array.isArray(result.hits)
        && result.hits.some(hit => Boolean(hit) && typeof hit === "object" && (hit as Row).id === indexed.id && (hit as Row).version === indexed.version);
    }
  } finally {
    writeFileSync(join(ctx.fixtureFinishGateDir, String(held.pid)), "");
    await ctx.settled("bot", recaller.id);
  }
  ctx.check("memory-capability-mounted", capability !== null, capability ? "memory capability present" : "memory capability missing");
  ctx.check("capability-search-served-indexed-record", servedByIndex, `search HTTP ${searchStatus}; lexical before search ${lexicalBefore ?? "missing"}`);
  const degraded = reason !== undefined && DEGRADATION_REASONS.has(reason);
  ctx.check("keyword-only-degradation-reported", searchStatus === 200 && degraded, `search HTTP ${searchStatus}; degradation ${degraded ? reason : reason === undefined ? "none" : "unrecognised"}`);

  // 4. A later task asks without the canary; its frame carries the old owner statement, tied to the delivered receipt and health.
  const suppliedThread = await createTask(ctx, recaller, "Follow-up task");
  const beforeQuestion = readSource(ctx, recaller.threadId, OLD_STATEMENT);
  ctx.check("old-source-indexed-before-supplied-question", indexedSource(beforeQuestion) && sameRecord(beforeQuestion.record, indexed), `lexical ${beforeQuestion?.lexical ?? "missing"}`);
  const suppliedDump = await ctx.send(recaller, SUPPLIED_QUESTION, false, suppliedThread);
  const suppliedLines = frameLines(dumpContent(suppliedDump));
  const sourceLine = suppliedLines.find(line => line?.attribution === "the owner said" && line.kind === "source" && !line.pinned
    && line.text === OLD_STATEMENT && line.text.includes(CANARY) && !SUPPLIED_QUESTION.includes(CANARY)) ?? null;
  ctx.check("old-evidence-source-line-supplied", sourceLine !== null, `${suppliedLines.length} frame lines; owner source line ${sourceLine ? `m${sourceLine.position}` : "missing"}`);
  const disclosedAt = sourceLine === null ? null : await eventually(ctx, "delivered disclosure receipt names the supplied line", () => {
    const rows = ctx.db().prepare("SELECT record_versions,created_at FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY created_at DESC").all(suppliedThread) as Row[];
    for (const row of rows) {
      let versions: unknown;
      try { versions = JSON.parse(String(row.record_versions)); } catch { continue; }
      const named = Array.isArray(versions) ? versions[sourceLine.position - 1] as Row | undefined : undefined;
      if (named && named.id === indexed.id && named.version === indexed.version) return Number(row.created_at);
    }
    return undefined;
  }, 10_000);
  ctx.check("supplied-line-matches-disclosure-receipt", disclosedAt !== null,
    disclosedAt !== null ? "delivered receipt names the indexed record at the line position" : "no delivered receipt names the indexed record at the line position");
  const supplied = disclosedAt === null ? null : await eventually(ctx, "health supplied reflects the delivery", async () => {
    const health = await readHealth(ctx);
    return health && health.suppliedTurns >= 1 && health.suppliedReferences >= 1 && health.suppliedAt !== null && health.suppliedAt >= disclosedAt ? health : undefined;
  }, 10_000);
  ctx.check("health-supplied-reflects-delivery", supplied !== null, supplied ? `${supplied.suppliedTurns} turns; ${supplied.suppliedReferences} references` : "supplied counters do not reflect the delivery");

  // 5. Abstention: nothing captured supports an approved replacement, so no recalled evidence line (anything but a checkpoint) is supplied.
  const abstainThread = await createTask(ctx, recaller, "Open question");
  const abstainLines = frameLines(dumpContent(await ctx.send(recaller, ABSTAIN_QUESTION, false, abstainThread)));
  const recalled = abstainLines.filter(line => line === null || line.kind !== "checkpoint").length;
  ctx.check("abstain-question-gets-no-supporting-line", recalled === 0, `${recalled} recalled evidence lines; ${abstainLines.length - recalled} checkpoint lines`);

  // 6. Isolation: another bot, then a room with the recaller as responder.
  const otherDump = await ctx.send(other, OTHER_BOT_QUESTION);
  ctx.check("other-bot-request-lacks-canary", isolated(otherDump, OTHER_BOT_QUESTION), `${frameLines(dumpContent(otherDump)).length} frame lines`);
  const room = await ctx.setup("room-created", "POST", "/api/groups", { name: "B34 Q06 room", memberIds: [recaller.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: recaller.id } } }, 201);
  const roomId: unknown = room.body?.group?.id;
  if (typeof roomId !== "string" || !roomId) throw new Error(`setup failed: POST /api/groups HTTP ${room.status}; no room id`);
  await ctx.setup(null, "POST", `/api/groups/${roomId}/messages`, { text: ROOM_QUESTION }, 202);
  const roomDump = await ctx.dispatched(ROOM_QUESTION, 30_000);
  await ctx.settled("channel", roomId);
  ctx.check("room-request-lacks-canary", isolated(roomDump, ROOM_QUESTION), `${frameLines(dumpContent(roomDump)).length} frame lines`);

  return {
    row: "Q06",
    readiness: { sourceId: oldSource.sourceId, sourceRevision: oldSource.revision, indexed: { id: indexed.id, version: indexed.version } },
    distractorSourceIds: distractors.map(source => source.sourceId),
    supplied: { match: SUPPLIED_QUESTION, canary: CANARY },
    isolation: [{ match: OTHER_BOT_QUESTION }, { match: ROOM_QUESTION }],
  };
}

export const b34Q06Adapter: B34Adapter = {
  row: "Q06",
  launch: { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" },
  run: runQ06,
};
