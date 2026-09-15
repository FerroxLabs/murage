// B34 Q03 and Q13 join adapters (Claude 4 lane) for Claude 5's runner
// (lane-5/B34-ADAPTER-CONTRACT.md; runner sha256 06576480…b67a).
//
// Tier: isolated-server with the scripted fake Claude CLI and the scripted
// deterministic extractor in ./b34-scripted-extractor.ts, installed in the
// server process by launch.instrumentationSource. Known zero cost; no network,
// model or credential. Extraction and grounding answers are frozen fixture
// decisions; everything else is product behaviour: capture, the worker's
// consolidation, span validation, grounding, activation, supersession,
// budget deferral, indexing and dispatch.
//
// Memory arises only from turns sent through ctx.send; setup HTTP goes
// through ctx.setup; the database is only read. Canaries appear only in
// distilled fact text, never in a sent message (lane-5/CLAUDE4-ADAPTER-HANDOFF.md
// note 2). Check details carry identifiers, counts and states only.
//
// Importing this module has no side effect. The types come from the local
// structural mirror because scripts/b34-receipt-matrix.ts is absent here.
import { personalityImprint } from "../../../shared/bot-identity.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../../../shared/memory.ts";
import type { AdapterArtifactsFor, AdapterRecordRef, B34Adapter, B34AdapterContext, Bot, Dump } from "./b34-adapter-types.ts";
import { B34_EXTRACTOR_INSTANCE_ID, B34_Q03, B34_Q13, b34Sha256, readB34ExtractorLedger, type B34LedgerEntry, type B34RuleId } from "./b34-scripted-extractor.ts";

const EXTRACTOR_MODULE_URL = new URL("./b34-scripted-extractor.ts", import.meta.url).href;
/** Preload source: dump every fake Claude turn, then install the scripted extractor. */
export const B34_EXTRACTOR_INSTRUMENTATION = [
  "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';",
  `const b34Extractor=await import(${JSON.stringify(EXTRACTOR_MODULE_URL)});`,
  "await b34Extractor.installB34ScriptedExtractor();",
].join("\n");

/** Room for every turn's extraction and grounding. The defaults are 6 calls per minute and a
 * 20000 daily output reservation (learning-policy.ts:12-13), and each call reserves 2000 (extract.ts:81,86). */
const OPEN_BUDGET = Object.freeze({ callsPerMinute: 60, inputLimit: 10_000_000, outputLimit: 2_000_000 });
const OWNER_FACT_LINE = "(the owner said; fact)";
const BUDGET_LIMITED_REASON = "A configured token or call limit prevents synthesis.";

type Row = Record<string, unknown>;
interface SourceRow { id: string; revision: number; threadId: string; turnId: string | null; speaker: string; outcome: string }
interface RecordRow { id: string; version: number; kind: string; state: string; text: string; assertion: string; validTo: number | null; supersedesId: string | null; ownerPinned: number; partition: string | null; entities: string | null; basis: string | null }
interface Intent { status?: string; reason?: string; retryAfter?: number | null; updatedAt?: number }

const one = (ctx: B34AdapterContext, sql: string, ...values: Array<string | number>) => ctx.db().prepare(sql).get(...values) as Row | undefined;
const all = (ctx: B34AdapterContext, sql: string, ...values: Array<string | number>) => ctx.db().prepare(sql).all(...values) as Row[];
const ref = (record: { id: string; version: number }): AdapterRecordRef => ({ id: record.id, version: record.version });
const utcDay = () => new Date().toISOString().slice(0, 10);
const sameSet = (left: string[], right: string[]) => new Set(left).size === new Set(right).size && right.every(item => left.includes(item));

/** Lines inside the remembered-context frame of one request (same parsing as the runner's frame()). */
function frame(text: string | null | undefined): string[] {
  const start = `${MEMORY_REFERENCE_PREAMBLE}\n${MEMORY_REFERENCE_OPEN}\n`, at = text?.indexOf(start) ?? -1;
  if (!text || at < 0) return [];
  const end = text.indexOf(`\n${MEMORY_REFERENCE_CLOSE}`, at + start.length);
  return end < 0 ? [] : text.slice(at + start.length, end).split("\n");
}
const content = (dump: Dump) => String(dump.prompt?.message?.content ?? "");
const system = (dump: Dump) => String(dump.systemPrompt ?? "");

function sourceByText(ctx: B34AdapterContext, threadId: string, text: string, owner: boolean): SourceRow | undefined {
  const row = one(ctx, `SELECT s.id,s.revision,s.thread_id,s.turn_id,s.speaker,s.outcome FROM memory_sources s
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.thread_id=? AND s.state='active' AND s.kind='text' AND ${owner ? "s.speaker='owner'" : "s.speaker!='owner'"}
    AND json_extract(v.payload,'$.text')=? ORDER BY v.created_at DESC LIMIT 1`, threadId, text);
  return row && { id: String(row.id), revision: Number(row.revision), threadId: String(row.thread_id), turnId: row.turn_id === null ? null : String(row.turn_id), speaker: String(row.speaker), outcome: String(row.outcome) };
}
const sourceText = (ctx: B34AdapterContext, source: SourceRow) =>
  one(ctx, "SELECT json_extract(payload,'$.text') AS text FROM memory_source_versions WHERE source_id=? AND revision=?", source.id, source.revision)?.text;
const captureComplete = (ctx: B34AdapterContext, source: SourceRow) =>
  Boolean(one(ctx, "SELECT 1 AS ok FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture' AND status='complete'", source.id, source.revision));
/** Consolidation intent persisted by consolidate.ts:127 (subject consolidation or consolidation-pending). */
function intentFor(ctx: B34AdapterContext, sourceId: string): Intent | undefined {
  const row = one(ctx, "SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('consolidation','consolidation-pending') AND json_extract(intent,'$.sourceId')=? ORDER BY rowid DESC LIMIT 1", sourceId);
  if (!row) return undefined;
  try { return JSON.parse(String(row.intent)) as Intent; } catch { return undefined; }
}
function recordsCiting(ctx: B34AdapterContext, sourceId: string): RecordRow[] {
  return all(ctx, `SELECT DISTINCT r.id,r.version,r.kind,r.state,r.text,r.assertion,r.valid_to,r.supersedes_id,r.owner_pinned,d.partition,d.entities,d.confidence_basis
    FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version
    LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE e.source_id=?`, sourceId).map(row => ({
    id: String(row.id), version: Number(row.version), kind: String(row.kind), state: String(row.state), text: String(row.text), assertion: String(row.assertion),
    validTo: row.valid_to === null ? null : Number(row.valid_to), supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id), ownerPinned: Number(row.owner_pinned),
    partition: row.partition === null ? null : String(row.partition), entities: row.entities === null ? null : String(row.entities), basis: row.confidence_basis === null ? null : String(row.confidence_basis),
  }));
}
const evidenceSources = (ctx: B34AdapterContext, record: { id: string; version: number }) =>
  all(ctx, "SELECT DISTINCT source_id FROM memory_evidence WHERE record_id=? AND record_version=?", record.id, record.version).map(row => String(row.source_id));
const lexicalStatus = (ctx: B34AdapterContext, record: { id: string; version: number }) =>
  one(ctx, "SELECT lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=? ORDER BY index_generation DESC LIMIT 1", record.id, record.version)?.lexical_status;
const pendingConsolidations = (ctx: B34AdapterContext, status?: string) => Number(status === undefined
  ? one(ctx, "SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='consolidation-pending'")?.n
  : one(ctx, "SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='consolidation-pending' AND json_extract(intent,'$.status')=?", status)?.n);

const ledger = (ctx: B34AdapterContext) => readB34ExtractorLedger(ctx.dataDir);
const requests = (entries: B34LedgerEntry[], family: "extract" | "ground", rule?: B34RuleId) =>
  entries.filter(entry => entry.family === family && (rule === undefined || entry.rules.includes(rule)));
/** No request other than catalog, extraction and grounding reached the extractor, all within the product's output cap, from one install. */
function checkExtractorBounds(ctx: B34AdapterContext) {
  const entries = ledger(ctx), billable = entries.filter(entry => entry.family === "extract" || entry.family === "ground");
  const installs = entries.filter(entry => entry.family === "install").length, refused = entries.filter(entry => entry.family === "refused").length;
  ctx.check("extractor-requests-scripted-and-bounded", installs === 1 && refused === 0 && billable.length > 0
    && billable.every(entry => Number.isSafeInteger(entry.maxTokens) && Number(entry.maxTokens) >= 1 && Number(entry.maxTokens) <= 2000),
  `${billable.length} extraction/grounding requests; ${refused} refused; ${installs} installs`);
}

async function verificationModel(ctx: B34AdapterContext): Promise<string> {
  const response = await ctx.setup(null, "GET", "/api/instances", undefined, 200);
  const engines = response.body?.instances as Array<{ instanceId?: unknown; models?: { options?: Array<{ id?: unknown }> } }> | undefined;
  const model = engines?.find(engine => engine.instanceId === "verification")?.models?.options?.[0]?.id;
  if (typeof model !== "string") throw new Error("verification engine has no model option");
  return model;
}
/** Explicit fake-Claude selection: the scripted extractor is also a chat-capable instance. */
async function createBot(ctx: B34AdapterContext, name: string, model: string): Promise<Bot> {
  const made = await ctx.setup(null, "POST", "/api/bots", { name, section: "B34Fixture", modelSelection: { instanceId: "verification", model } }, 201);
  const bot = made.body?.bot as Bot | undefined;
  if (!bot || typeof bot.id !== "string" || typeof bot.threadId !== "string") throw new Error("bot create returned no bot");
  await ctx.setup(null, "PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, 200);
  return bot;
}
async function createTask(ctx: B34AdapterContext, bot: Bot, title: string): Promise<string> {
  const made = await ctx.setup(null, "POST", `/api/bots/${bot.id}/tasks`, { title }, 201);
  const threadId = made.body?.task?.threadId;
  if (typeof threadId !== "string") throw new Error("task create returned no thread");
  return threadId;
}
async function memoryStatus(ctx: B34AdapterContext) {
  const response = await ctx.api("GET", "/api/memory/status");
  if (response.status !== 200) throw new Error(`GET /api/memory/status HTTP ${response.status}`);
  return response.body;
}
async function personaOf(ctx: B34AdapterContext, botId: string): Promise<string | null> {
  const response = await ctx.api("GET", "/api/bots?messages=0");
  if (response.status !== 200) throw new Error(`GET /api/bots HTTP ${response.status}`);
  const bot = (response.body?.bots as Array<{ id?: unknown; persona?: unknown }> | undefined)?.find(item => item.id === botId);
  if (!bot) throw new Error("bot missing from roster");
  return typeof bot.persona === "string" ? bot.persona : null;
}

/** Owner selection of the scripted extractor through the configure action (settings.ts:68,243-254), eligible only when listed (:245). */
async function selectExtractor(ctx: B34AdapterContext, learning: Record<string, number>, checkName: string, expectedState: "configured" | "budget-limited") {
  const listed = await ctx.setup("scripted-extractor-listed-eligible", "GET", "/api/memory/status", undefined, 200, response => {
    const entry = (response.body?.extractors as Array<{ instanceId?: unknown; eligible?: unknown }> | undefined)?.find(item => item.instanceId === B34_EXTRACTOR_INSTANCE_ID);
    return { ok: entry?.eligible === true && response.body?.mode === "active", note: `listed ${entry ? "yes" : "no"}; eligible ${String(entry?.eligible ?? false)}; mode ${String(response.body?.mode ?? "missing")}` };
  });
  const learningRevision = Number(listed.body?.learning?.revision);
  if (!Number.isSafeInteger(learningRevision)) throw new Error("memory status carried no learning revision");
  await ctx.setup(checkName, "POST", "/api/memory/action", { action: "configure", extractorInstanceId: B34_EXTRACTOR_INSTANCE_ID, learning, learningRevision }, 200, response => {
    const body = response.body;
    const ok = body?.configuration?.extractorInstanceId === B34_EXTRACTOR_INSTANCE_ID && body?.health?.synthesis?.state === expectedState
      && Object.entries(learning).every(([key, value]) => body?.learning?.[key] === value);
    return { ok, note: `synthesis ${String(body?.health?.synthesis?.state ?? "missing")}` };
  });
}

async function waitSource(ctx: B34AdapterContext, label: string, threadId: string, text: string, owner = true): Promise<SourceRow> {
  return ctx.until(label, () => sourceByText(ctx, threadId, text, owner), 30_000);
}
/** Thrown-message fragments: identifiers, states and counts only (never bodies, prompts or secrets). */
const code = (value: unknown) => value === null || value === undefined ? "-" : String(value).replace(/[^\w.:-]/g, "_").slice(0, 32);
const flag = (value: unknown) => value === true ? "1" : value === false ? "0" : "-";
/** Turn settlement sources of one thread: "working" at turn.started (index.ts:2990), the terminal outcome
 * upserted on the same or a new row, and every working row of the thread swept to it (settlement.ts:5-13, capture.ts:33-35). */
const turnSettlement = (ctx: B34AdapterContext, threadId: string) => {
  const row = one(ctx, "SELECT count(*) AS n,coalesce(sum(outcome='working'),0) AS working FROM memory_sources WHERE kind='turn' AND thread_id=?", threadId);
  return { turns: Number(row?.n ?? 0), working: Number(row?.working ?? 0) };
};
/** Compact stall state for a timed-out evidence wait, discriminator (job/rv/in) first because
 * expectAllPass keeps 300 detail characters (b34-adapter-harness.ts:166). Each part has its own try. */
async function stallDetail(ctx: B34AdapterContext, botId: string, threadId: string, source?: SourceRow): Promise<string> {
  const parts: string[] = [];
  const part = async (key: string, read: () => string | Promise<string>) => { try { parts.push(`${key}=${await read()}`); } catch { parts.push(`${key}=?`); } };
  if (source) {
    let jobId: string | undefined;
    await part("job", () => {
      const row = one(ctx, "SELECT id,status,attempts,error FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture' ORDER BY rowid DESC LIMIT 1", source.id, source.revision);
      if (!row) return "none";
      jobId = String(row.id);
      return `${code(row.status)}/${code(row.attempts)}/${code(row.error)}`;
    });
    await part("rv", () => {
      if (jobId === undefined) return "nojob";
      const row = one(ctx, "SELECT json_extract(intent,'$.status') AS s FROM memory_scope_bindings WHERE id=?", `reveal-capture:${jobId}`);
      return row ? code(row.s) : "none";
    });
    await part("in", () => { const intent = intentFor(ctx, source.id); return intent ? `${code(intent.status)}/${code(intent.reason)}` : "none"; });
    await part("rev", () => { const row = one(ctx, "SELECT revision,state FROM memory_sources WHERE id=?", source.id); return `${source.revision}/${row ? `${code(row.revision)}/${code(row.state)}` : "none"}`; });
  }
  await part("ci", () => all(ctx, "SELECT subject_id,json_extract(intent,'$.status') AS s,count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('consolidation','consolidation-pending') GROUP BY 1,2")
    .slice(0, 4).map(row => `${row.subject_id === "consolidation" ? "c" : "p"}:${code(row.s)}:${code(row.n)}`).join(",") || "none");
  await part("m", () => { const row = one(ctx, "SELECT mode,policy_revision FROM memory_meta WHERE id=1"); return row ? `${code(row.mode)}/${code(row.policy_revision)}` : "none"; });
  await part("pol", () => { const row = one(ctx, "SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'"); return row ? code(row.state) : "none"; });
  let status: any;
  try { status = await memoryStatus(ctx); } catch { parts.push("st=?"); }
  if (status) {
    const reads: Array<[string, () => string]> = [
      ["we", () => code(status.workerError)],
      ["rt", () => `${flag(status.runtime?.running)}/${flag(status.runtime?.ready)}/${flag(status.runtime?.indexing)}`],
      ["bl", () => `${code(status.backlog?.pending)}/${code(status.backlog?.leased)}/${code(status.backlog?.deferred)}/${code(status.backlog?.failed)}`],
      ["sy", () => code(status.health?.synthesis?.state)],
      ["x", () => flag(status.configuration?.extractorInstanceId === B34_EXTRACTOR_INSTANCE_ID)],
      ["c", () => code(status.cost?.callsThisMinute)],
      ["lr", () => code(status.learning?.revision)],
    ];
    for (const [key, read] of reads) await part(key, read);
  }
  await part("L", () => { const entries = ledger(ctx); return (["install", "models", "extract", "ground", "refused"] as const).map(family => entries.filter(entry => entry.family === family).length).join("/"); });
  await part("t", async () => {
    const response = await ctx.api("GET", "/api/bots?messages=0");
    if (response.status !== 200) return `http${response.status}`;
    type Live = { id?: unknown; threadId?: unknown; busy?: unknown; activity?: unknown; tasks?: Array<{ threadId?: unknown; busy?: unknown; activity?: unknown }> };
    const bot = (response.body?.bots as Live[] | undefined)?.find(item => item.id === botId);
    if (!bot) return "nobot";
    const task = bot.tasks?.find(item => item.threadId === threadId);
    return `${flag(bot.threadId === threadId)}/${task ? `${flag(task.busy)}/${code(task.activity)}` : "notask"}`;
  });
  await part("tn", () => { const now = turnSettlement(ctx, threadId); return `${now.turns}/${now.working}`; });
  return parts.join(" ");
}
/** ctx.until with the same label, predicate and timeout; only its "Timed out: " error gains the stall state. */
async function stalled<T>(ctx: B34AdapterContext, label: string, read: () => T | undefined, timeout: number, detail: () => Promise<string>): Promise<T> {
  try { return await ctx.until(label, read, timeout); } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Timed out: ")) throw error;
    let extra: string;
    try { extra = await detail(); } catch { extra = "detail=?"; }
    throw new Error(`${error.message} {${extra}}`);
  }
}
/** Evidence wait: capture job complete and the source's consolidation intent complete (activation commits in the same transaction, consolidate.ts:166-206). */
async function consolidated(ctx: B34AdapterContext, label: string, source: SourceRow, botId: string, timeout = 45_000): Promise<Intent> {
  return stalled(ctx, label, () => {
    if (!captureComplete(ctx, source)) return undefined;
    const intent = intentFor(ctx, source.id);
    return intent?.status === "complete" ? intent : undefined;
  }, timeout, () => stallDetail(ctx, botId, source.threadId, source));
}
/** ctx.send unchanged (same text, not held, same thread, its own bot settle), then the sent task thread's own
 * settlement by evidence: a new turn source exists and none of the thread's turn sources is still working.
 * ctx.settled waits on the bot's active thread only (mcp-server.ts:1022,1053-1055), while a direct run on
 * another owned task is live independently (index.ts:955-959). */
async function sendToTask(ctx: B34AdapterContext, bot: Bot, text: string, threadId: string, label: string): Promise<Dump> {
  const before = turnSettlement(ctx, threadId).turns;
  const dump = await ctx.send(bot, text, false, threadId);
  await stalled(ctx, label, () => {
    const now = turnSettlement(ctx, threadId);
    return now.turns > before && now.working === 0 ? true : undefined;
  }, 30_000, async () => `tb=${before} ${await stallDetail(ctx, bot.id, threadId)}`);
  return dump;
}

async function runQ03(ctx: B34AdapterContext): Promise<AdapterArtifactsFor<"Q03">> {
  const model = await verificationModel(ctx);
  await selectExtractor(ctx, OPEN_BUDGET, "scripted-extractor-configured", "configured");
  // Settings, bots and tasks all change before the first owner turn: configure and roster
  // changes move the policy revision, which revokes an in-flight consolidation (settings.ts:251, consolidate.ts:170).
  const learner = await createBot(ctx, "B34 Q03 learner", model);
  const failing = await createBot(ctx, "B34 Q03 failing turn", model);
  const sourceTask = await createTask(ctx, learner, "B34 Q03 billing");
  const reuseTask = await createTask(ctx, learner, "B34 Q03 next invoice");
  const personaBefore = await personaOf(ctx, learner.id);

  // 1. The owner states a fact in task A; the extractor distils a grounded paraphrase.
  // sourceTask is not the active thread (reuseTask was created after it, store.ts:2092,2102-2105), so each send also waits on its own settlement.
  const factDump = await sendToTask(ctx, learner, B34_Q03.factMessage, sourceTask, "Q03 owner fact turn settled on its task");
  const factSource = await waitSource(ctx, "Q03 owner fact captured", sourceTask, B34_Q03.factMessage);
  await consolidated(ctx, "Q03 owner fact consolidated", factSource, learner.id);
  const staleFacts = recordsCiting(ctx, factSource.id).filter(record => record.kind === "fact" && record.state === "active");
  const stale = staleFacts[0];
  const afterFact = ledger(ctx);
  ctx.check("owner-fact-distilled-by-grounded-paraphrase", staleFacts.length === 1 && stale.assertion === "owner-statement" && stale.ownerPinned === 0
    && String(stale.basis ?? "").startsWith("Source-entailed owner statement") && stale.text.includes(B34_Q03.staleCanary)
    && stale.entities === JSON.stringify(["owner", "invoice-currency"]) && sameSet(evidenceSources(ctx, stale), [factSource.id])
    && requests(afterFact, "extract", "q03-fact").some(entry => entry.sourceSha256 === b34Sha256(B34_Q03.factMessage))
    && requests(afterFact, "ground", "q03-fact").some(entry => entry.supported === true && entry.previousClaim === false),
  `${staleFacts.length} active facts; ${requests(afterFact, "extract", "q03-fact").length} extraction and ${requests(afterFact, "ground", "q03-fact").length} grounding requests`);
  if (!stale) throw new Error("Q03 owner fact was not activated; the correction step needs it");

  // 2. A temporary instruction. The extractor classifies it as an inference (fixture decision).
  await sendToTask(ctx, learner, B34_Q03.temporaryMessage, sourceTask, "Q03 temporary instruction turn settled on its task");
  const temporarySource = await waitSource(ctx, "Q03 temporary instruction captured", sourceTask, B34_Q03.temporaryMessage);
  await consolidated(ctx, "Q03 temporary instruction consolidated", temporarySource, learner.id);
  const temporaryRecords = recordsCiting(ctx, temporarySource.id);
  const proposed = temporaryRecords.filter(record => record.kind === "fact" && record.state === "candidate");
  const durable = temporaryRecords.filter(record => !["source", "checkpoint"].includes(record.kind) && record.state !== "candidate");
  ctx.check("temporary-instruction-not-durable", proposed.length === 1 && durable.length === 0
    && temporaryRecords.every(record => record.partition !== "identity" && record.partition !== "procedural")
    && requests(ledger(ctx), "extract", "q03-temporary").some(entry => entry.sourceSha256 === b34Sha256(B34_Q03.temporaryMessage)),
  `fixture classification (inference); ${proposed.length} candidate; ${durable.length} durable records`);

  // 3. The owner corrects the fact in a later turn of the same task.
  await sendToTask(ctx, learner, B34_Q03.correctionMessage, sourceTask, "Q03 owner correction turn settled on its task");
  const correctionSource = await waitSource(ctx, "Q03 owner correction captured", sourceTask, B34_Q03.correctionMessage);
  await consolidated(ctx, "Q03 owner correction consolidated", correctionSource, learner.id);
  const currentFacts = recordsCiting(ctx, correctionSource.id).filter(record => record.kind === "fact" && record.state === "active");
  const current = currentFacts[0];
  const old = one(ctx, "SELECT state,valid_to,text FROM memory_records WHERE id=? AND version=?", stale.id, stale.version);
  const lineage = current ? Boolean(one(ctx, "SELECT 1 AS ok FROM memory_derivations WHERE parent_id=? AND parent_version=? AND child_id=? AND child_version=?", stale.id, stale.version, current.id, current.version)) : false;
  const afterCorrection = ledger(ctx);
  ctx.check("correction-grounded-against-previous-claim", requests(afterCorrection, "extract", "q03-correction").some(entry => entry.sourceSha256 === b34Sha256(B34_Q03.correctionMessage))
    && requests(afterCorrection, "ground", "q03-correction").some(entry => entry.previousClaim === true && entry.supported === true),
  `${requests(afterCorrection, "ground", "q03-correction").length} correction grounding requests`);
  ctx.check("correction-superseded-with-history", currentFacts.length === 1 && current.supersedesId === stale.id && current.assertion === "owner-statement"
    && current.text.includes(B34_Q03.currentCanary) && !current.text.includes(B34_Q03.staleCanary) && sameSet(evidenceSources(ctx, current), [correctionSource.id])
    && old?.state === "superseded" && old.valid_to !== null && String(old.text).includes(B34_Q03.staleCanary) && lineage,
  `prior ${String(old?.state ?? "missing")}; ${currentFacts.length} active corrections; lineage ${lineage}`);
  if (!current) throw new Error("Q03 correction was not activated; reuse needs it");
  ctx.check("owner-messages-carry-no-canary", [factSource, temporarySource, correctionSource].every(source => {
    const text = sourceText(ctx, source);
    return typeof text === "string" && ![B34_Q03.staleCanary, B34_Q03.currentCanary].some(canary => text.includes(canary));
  }), "3 owner sources");
  await ctx.until("Q03 current and superseded projections indexed", () =>
    lexicalStatus(ctx, current) === "indexed" && lexicalStatus(ctx, stale) === "indexed" ? true : undefined, 45_000);

  // 4. A failed turn on another bot whose assistant text the extractor proposes as an observation.
  await ctx.send(failing, B34_Q03.failedTurnMessage, false, failing.threadId);
  const claim = await waitSource(ctx, "Q03 failed-turn assistant text captured", failing.threadId, B34_Q03.failedTurnReply, false);
  await consolidated(ctx, "Q03 failed-turn assistant text consolidated", claim, failing.id);
  const settledFailed = Boolean(claim.turnId && one(ctx, "SELECT 1 AS ok FROM memory_sources WHERE kind='turn' AND thread_id=? AND turn_id=? AND outcome='failed'", claim.threadId, claim.turnId));
  const failedRecords = recordsCiting(ctx, claim.id);
  const failedExtractions = requests(ledger(ctx), "extract", "q03-failed-claim").filter(entry => entry.sourceSha256 === b34Sha256(B34_Q03.failedTurnReply)).length;
  ctx.check("failed-turn-claim-proposed-and-refused", settledFailed && failedExtractions > 0 && failedRecords.some(record => record.kind === "fact" && record.state === "candidate")
    && !failedRecords.some(record => ["fact", "procedure", "character-canon"].includes(record.kind) && record.state === "active"),
  `turn failed ${settledFailed}; ${failedExtractions} extraction requests; ${failedRecords.filter(record => record.state === "candidate").length} candidates`);

  // 5. A different task asks a question that names neither the answer nor an opaque reference.
  const reuseDump = await ctx.send(learner, B34_Q03.question, false, reuseTask);
  const lines = frame(content(reuseDump));
  ctx.check("corrected-fact-delivered-to-other-task", reuseTask !== sourceTask && lines.some(line => line.includes(B34_Q03.currentCanary) && line.includes(OWNER_FACT_LINE)),
    `${lines.length} frame lines`);
  ctx.check("stale-fact-withheld-from-other-task", lines.length > 0 && !`${content(reuseDump)}\n${system(reuseDump)}`.includes(B34_Q03.staleCanary),
    `${lines.length} frame lines`);
  const personaAfter = await personaOf(ctx, learner.id);
  const imprint = `Personality: ${personalityImprint(personaBefore)}`;
  const identityRecords = Number(one(ctx, "SELECT count(*) AS n FROM memory_record_details WHERE partition='identity'")?.n ?? -1);
  ctx.check("temporary-instruction-not-personality", personaAfter === personaBefore && identityRecords === 0
    && [factDump, reuseDump].every(dump => system(dump).includes(imprint) && !system(dump).includes(B34_Q03.temporaryMessage)),
  `persona unchanged ${personaAfter === personaBefore}; ${identityRecords} identity records`);
  checkExtractorBounds(ctx);

  return {
    row: "Q03", extractorInstanceId: B34_EXTRACTOR_INSTANCE_ID,
    distilled: [{ record: ref(stale), sourceIds: [factSource.id] }, { record: ref(current), sourceIds: [correctionSource.id] }],
    correction: { superseded: ref(stale), current: ref(current) },
    refused: [{ sourceId: claim.id, outcome: "failed" }],
    reuse: { match: B34_Q03.question, canary: B34_Q03.currentCanary },
    staleWithheld: { match: B34_Q03.question, canary: B34_Q03.staleCanary },
  };
}

async function runQ13(ctx: B34AdapterContext): Promise<AdapterArtifactsFor<"Q13">> {
  const day = utcDay();
  const model = await verificationModel(ctx);
  // Processing budget exhausted through owner learning settings: zero calls per minute (learning-policy.ts:8; extract.ts:86).
  await selectExtractor(ctx, { ...OPEN_BUDGET, callsPerMinute: 0 }, "exhausted-budget-configured", "budget-limited");
  const bot = await createBot(ctx, "B34 Q13 budget", model);
  const questionTask = await createTask(ctx, bot, "B34 Q13 schedule question");
  const followUpTask = await createTask(ctx, bot, "B34 Q13 schedule follow-up");

  // bot.threadId and questionTask are not the active thread (each later createTask activates, store.ts:2092,2102-2105).
  await sendToTask(ctx, bot, B34_Q13.statement, bot.threadId, "Q13 owner statement turn settled on its thread");
  const source = await waitSource(ctx, "Q13 owner statement captured", bot.threadId, B34_Q13.statement);
  const stall = () => stallDetail(ctx, bot.id, bot.threadId, source);
  const deferred = await stalled(ctx, "Q13 consolidation deferred", () => {
    if (!captureComplete(ctx, source)) return undefined;
    const intent = intentFor(ctx, source.id);
    return intent && intent.status !== "running" && intent.status !== "partial" ? intent : undefined;
  }, 20_000, stall);
  const whileDeferred = await memoryStatus(ctx);
  const retryAfter = Number(deferred.retryAfter), updatedAt = Number(deferred.updatedAt);
  ctx.check("budget-deferral-recorded", deferred.status === "deferred" && deferred.reason === "budget-exhausted"
    && Number.isSafeInteger(retryAfter) && retryAfter % 60_000 === 0 && retryAfter - updatedAt > -1_000 && retryAfter - updatedAt <= 60_000,
  `${String(deferred.status)}; ${String(deferred.reason)}`);
  const text = sourceText(ctx, source);
  ctx.check("owner-statement-carries-no-canary", typeof text === "string" && !text.includes(B34_Q13.canary), "1 owner source");
  const exhaustedRequests = ledger(ctx).filter(entry => entry.family === "extract" || entry.family === "ground").length;
  ctx.check("no-extractor-call-while-exhausted", exhaustedRequests === 0 && whileDeferred?.cost?.callsThisMinute === 0, `${exhaustedRequests} extractor requests`);
  ctx.check("health-reports-budget-limited", whileDeferred?.health?.synthesis?.state === "budget-limited" && whileDeferred?.health?.synthesis?.reason === BUDGET_LIMITED_REASON
    && whileDeferred?.learning?.callsPerMinute === 0 && whileDeferred?.configuration?.extractorInstanceId === B34_EXTRACTOR_INSTANCE_ID,
  `synthesis ${String(whileDeferred?.health?.synthesis?.state ?? "missing")}`);

  // A question in another task while the budget is exhausted.
  const withheldDump = await sendToTask(ctx, bot, B34_Q13.question, questionTask, "Q13 question turn settled on its task");
  const factsWhileExhausted = recordsCiting(ctx, source.id).filter(record => record.kind === "fact").length;
  const requestsWhileExhausted = ledger(ctx).filter(entry => entry.family === "extract" || entry.family === "ground").length;
  // A boundary retry can hold the intent "running" for an instant before it defers again (consolidate.ts:146,174).
  ctx.check("no-fact-while-exhausted", factsWhileExhausted === 0 && intentFor(ctx, source.id)?.status !== "complete", `${factsWhileExhausted} fact records`);
  ctx.check("question-while-exhausted-lacks-canary", requestsWhileExhausted === 0 && !`${content(withheldDump)}\n${system(withheldDump)}`.includes(B34_Q13.canary),
    `${frame(content(withheldDump)).length} frame lines; ${requestsWhileExhausted} extractor requests`);

  // Restore the budget. A settings change revokes a running consolidation (consolidate.ts:170), so none may be running.
  await stalled(ctx, "Q13 no consolidation running before restore", () => pendingConsolidations(ctx, "running") === 0 ? true : undefined, 20_000, stall);
  const learningRevision = Number((await memoryStatus(ctx))?.learning?.revision);
  if (!Number.isSafeInteger(learningRevision)) throw new Error("memory status carried no learning revision");
  await ctx.setup("restored-budget-configured", "POST", "/api/memory/action", { action: "configure", learning: { callsPerMinute: OPEN_BUDGET.callsPerMinute }, learningRevision }, 200, response => ({
    ok: response.body?.learning?.callsPerMinute === OPEN_BUDGET.callsPerMinute && response.body?.health?.synthesis?.state === "configured"
      && response.body?.configuration?.extractorInstanceId === B34_EXTRACTOR_INSTANCE_ID,
    note: `synthesis ${String(response.body?.health?.synthesis?.state ?? "missing")}`,
  }));
  // Deferred budget work retries at the next minute boundary (consolidate.ts:118) through the idle poll
  // (worker-controller.ts:57-63); the bound also covers one revoked 65 s lease (consolidate.ts:146).
  const recovered = await stalled(ctx, "Q13 deferred source learned after restore", () => {
    if (intentFor(ctx, source.id)?.status !== "complete") return undefined;
    return recordsCiting(ctx, source.id).filter(record => record.kind === "fact");
  }, 125_000, stall);
  const fact = recovered.find(record => record.state === "active");
  ctx.check("recovered-learning-cites-source", recovered.length === 1 && Boolean(fact) && fact!.assertion === "owner-statement" && fact!.ownerPinned === 0
    && fact!.text.includes(B34_Q13.canary) && String(fact!.basis ?? "").startsWith("Source-entailed owner statement") && sameSet(evidenceSources(ctx, fact!), [source.id]),
  `${recovered.length} fact records; active ${Boolean(fact)}`);
  if (!fact) throw new Error("Q13 deferred source was not learned after the budget was restored");

  // Positive control for the withheld request: the same kind of question now receives the learned fact.
  await ctx.until("Q13 recovered fact indexed", () => lexicalStatus(ctx, fact) === "indexed" ? true : undefined, 30_000);
  const followUpDump = await ctx.send(bot, B34_Q13.followUp, false, followUpTask);
  const followUpLines = frame(content(followUpDump));
  ctx.check("recovered-fact-delivered-after-restore", followUpLines.some(line => line.includes(B34_Q13.canary) && line.includes(OWNER_FACT_LINE)), `${followUpLines.length} frame lines`);

  // Quiesce on evidence, then count: the deferred source was extracted and grounded exactly once.
  await stalled(ctx, "Q13 consolidation queue drained", () => pendingConsolidations(ctx) === 0 ? true : undefined, 60_000, stall);
  const final = ledger(ctx);
  const extractions = requests(final, "extract").filter(entry => entry.sourceSha256 === b34Sha256(B34_Q13.statement));
  const groundings = requests(final, "ground", "q13-fact");
  ctx.check("recovered-source-extracted-once", extractions.length === 1 && extractions[0].rules.includes("q13-fact") && groundings.length === 1 && groundings[0].supported === true,
    `${extractions.length} extraction and ${groundings.length} grounding requests for the deferred source`);
  const status = await memoryStatus(ctx);
  // The product's daily reservation ledger is keyed by UTC day (extract.ts:75,82); compare only within one day.
  if (utcDay() === day && status?.cost?.day === day) {
    const billable = final.filter(entry => entry.family === "extract" || entry.family === "ground");
    const input = billable.reduce((sum, entry) => sum + Number(entry.inputBytes ?? 0), 0), output = billable.reduce((sum, entry) => sum + Number(entry.maxTokens ?? 0), 0);
    ctx.check("reservations-match-extractor-requests", status.cost.inputReserved === input && status.cost.outputReserved === output, `${billable.length} billable requests`);
  }
  checkExtractorBounds(ctx);

  return {
    row: "Q13", extractorInstanceId: B34_EXTRACTOR_INSTANCE_ID,
    budget: {
      sourceId: source.id, deferredReason: "budget-exhausted",
      withheldWhileExhausted: { match: B34_Q13.question, canary: B34_Q13.canary },
      recovered: { record: ref(fact), sourceIds: [source.id] },
    },
  };
}

export const b34Q03Adapter: B34Adapter = { row: "Q03", launch: { instrumentationSource: B34_EXTRACTOR_INSTRUMENTATION }, run: runQ03 };
export const b34Q13Adapter: B34Adapter = { row: "Q13", launch: { instrumentationSource: B34_EXTRACTOR_INSTRUMENTATION }, run: runQ13 };
