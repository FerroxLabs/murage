// B34 Q14 join adapter (Claude 4 lane) for Claude 5's runner v3
// (scripts/b34-receipt-matrix.ts sha256 69fbb75f; lane-5/B34-ADAPTER-CONTRACT.md Contract v3).
//
// Tier: isolated-server with the scripted fake Claude CLI and the scripted
// procedure evaluator in ./b34-evaluator-runtime.ts, installed in the server
// process by launch.instrumentationSource through the root-integrated
// verification hook. Its loopback transport serves only 127.0.0.1: no provider,
// no Flux, no credential, no native GEPA. Known zero cost applies to this tier
// only; production and provider cost stay unknown.
//
// Product behaviour exercised: owner card approval of a learned skill, task
// procedure pins, routine runs, review discovery, owner preview/authorize/retry,
// the inference lease and its per-review charges row, the held-out gate,
// scoped skill publication, routine instruction promotion, and both rollbacks.
// Fixture decisions (labelled): the loopback's scripted answers, and a skill
// review's first attempt, where the scripted controller claims acceptance for a
// measured, non-improving candidate so the product's held-out gate must refuse it.
//
// Ledger isolation: consolidation charges the shared extract-budget ledger for
// every captured source while any extractor is selected, regardless of
// automaticFacts (consolidate.ts:135-151, extract.ts:79). The evaluator is
// therefore selected only between the last earlier turn and the second review,
// with no turn in that window. Learning settings change once, before any review.
//
// Setup HTTP goes through ctx.setup, turns through ctx.send, and the database is
// only read. Check details carry identifiers, states and counts only.
// Importing this module has no side effect.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterArtifactsFor, B34Adapter, B34AdapterContext, Bot, Dump, Q14Readback, Q14ReadbackFact, Q14Variant } from "./b34-adapter-types.ts";
import { B34_EVALUATOR_INSTANCE_ID, B34_Q14, readB34EvaluatorCalls, readB34EvaluatorReviews, type B34CallFamily } from "./b34-evaluator-runtime.ts";

const RUNTIME_MODULE_URL = new URL("./b34-evaluator-runtime.ts", import.meta.url).href;
/** Preload source: dump every fake Claude turn, then install the scripted evaluator runtime. */
export const B34_EVALUATOR_INSTRUMENTATION = [
  "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';",
  `const b34Evaluator=await import(${JSON.stringify(RUNTIME_MODULE_URL)});`,
  "await b34Evaluator.installB34EvaluatorRuntime();",
].join("\n");

/** Leaves the harness time to verify and close the fixture inside the 600 s round cap. */
const JOURNEY_BUDGET_MS = 470_000;
const HOLD_MARKER = "__fixture_hold_authority__";
/** Set once, before any review snapshot (learning-policy.ts:4-10). Five calls per minute put the routine refusal on its first callback. */
const LEARNING = Object.freeze({ automaticFacts: false, automaticProcedures: true, reviewMode: false, callsPerMinute: 5, inputLimit: 10_000_000, outputLimit: 2_000_000, dailyCostUsd: null });
/** Per-callback reservations (procedure-evaluator.ts:103, extract.ts:82). */
const EVALUATION_OUTPUT = 2000, REFLECTION_OUTPUT = 8000;
const TOTAL_OUTPUT = 5 * EVALUATION_OUTPUT + 3 * REFLECTION_OUTPUT;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOTS_PATH = "/api/bots?messages=0", ROUTINES_PATH = "/api/routines";
const LEDGER_SQL = "SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_id=?";
const FAMILIES: B34CallFamily[] = ["install", "models", "evaluation", "reflection", "unexpected-extract", "unexpected-ground", "refused"];
/** Routine definition fields other than the instruction; routines carry no recipients or permissions fields (routines.ts:71-96). */
const ROUTINE_FIELDS = ["name", "target", "botId", "groupId", "runOn", "enabled", "schedule", "durationMinutes", "timeoutMinutes", "attachments", "sourceThreadId", "watch", "nextRunAt", "createdAt"] as const;

// Untyped JSON from the product API and stored intents.
type Json = any;
type Row = Record<string, unknown>;
interface Binding { id: string; subject: string; state: string; intent: Json }
interface JourneyState { S?: string; T?: string; runId?: string }
interface PinRef { i: number; j: number; bundleId: string }
interface Bundle { audienceKey?: unknown; imported?: Array<{ name?: unknown; revision?: unknown; sha256?: unknown; editable?: unknown }>; routine?: { id?: unknown; instructionRevision?: unknown } }

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Session and charges rows are keyed by sha256(JSON.stringify(reviewId)) (procedure-evaluator.ts:16,84,97). */
const leaseHash = (reviewId: string) => sha256(JSON.stringify(reviewId));
const code = (value: unknown) => value === null || value === undefined ? "-" : String(value).replace(/[^\w.:-]/g, "_").slice(0, 32);
const flag = (value: unknown) => value ? "1" : "0";
const minute = () => Math.floor(Date.now() / 60_000);
const utcDay = () => new Date().toISOString().slice(0, 10);
const num = (value: unknown) => Number.isSafeInteger(value) ? value as number : 0;
const parse = (text: unknown): Json => { try { return JSON.parse(String(text)); } catch { return null; } };
/** Exactly these keys with strictly equal scalar values. */
const exact = (value: Json, expected: Record<string, unknown>) => Boolean(value) && typeof value === "object"
  && Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([key, item]) => value[key] === item);
/** One per-review lease tally: calls and reserved output exact, reserved input present exactly when calls were charged. */
const tally = (value: Json, calls: number, output: number) => value?.calls === calls && value?.output === output
  && Number.isSafeInteger(value?.input) && (calls === 0 ? value.input === 0 : value.input > 0);

const one = (ctx: B34AdapterContext, sql: string, ...values: Array<string | number>) => ctx.db().prepare(sql).get(...values) as Row | undefined;
const all = (ctx: B34AdapterContext, sql: string, ...values: Array<string | number>) => ctx.db().prepare(sql).all(...values) as Row[];
const countOf = (ctx: B34AdapterContext, sql: string, ...values: Array<string | number>) => Number(one(ctx, sql, ...values)?.n ?? -1);
const toBinding = (row: Row): Binding => ({ id: String(row.id), subject: String(row.subject_id), state: String(row.state), intent: parse(row.intent) });
function binding(ctx: B34AdapterContext, id: string): Binding | undefined {
  const row = one(ctx, "SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE id=? AND subject_type='system'", id);
  return row ? toBinding(row) : undefined;
}
const subjectRows = (ctx: B34AdapterContext, subject: string) =>
  all(ctx, "SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=? ORDER BY id", subject).map(toBinding);
const reviewRows = (ctx: B34AdapterContext) =>
  all(ctx, "SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND id LIKE 'procedure-review:%' ORDER BY rowid").map(toBinding);
const sessionOf = (ctx: B34AdapterContext, reviewId: string) => binding(ctx, `procedure-evaluation-session:${leaseHash(reviewId)}`);
const chargesOf = (ctx: B34AdapterContext, reviewId: string) => binding(ctx, `procedure-evaluation-charges:${leaseHash(reviewId)}`);
/** The shared daily extract-budget ledger {input, output, minute, calls} (extract.ts:83-89). */
const ledgerDay = (ctx: B34AdapterContext, day = utcDay()) => binding(ctx, `extract-budget:${day}`)?.intent as Json;
const ledgerTotals = (ctx: B34AdapterContext) => subjectRows(ctx, "extract-budget").reduce((sum, row) => ({ input: sum.input + num(row.intent?.input), output: sum.output + num(row.intent?.output) }), { input: 0, output: 0 });
const activeJobs = (ctx: B34AdapterContext) => countOf(ctx, "SELECT count(*) AS n FROM memory_jobs WHERE status IN ('pending','partial','leased','deferred')");
const pendingTriggers = (ctx: B34AdapterContext) => countOf(ctx, "SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='procedure-review-pending' AND json_extract(intent,'$.trigger') IS NOT NULL");
const consolidationRows = (ctx: B34AdapterContext) => countOf(ctx, "SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('consolidation','consolidation-pending')");
function families(ctx: B34AdapterContext): Record<B34CallFamily, number> {
  const entries = readB34EvaluatorCalls(ctx.dataDir);
  return Object.fromEntries(FAMILIES.map(family => [family, entries.filter(entry => entry.family === family).length])) as Record<B34CallFamily, number>;
}
const familyDetail = (counts: Record<B34CallFamily, number>) => FAMILIES.map(family => counts[family]).join("/");

async function get(ctx: B34AdapterContext, path: string, label: string): Promise<Json> {
  const response = await ctx.api("GET", path);
  if (response.status !== 200) throw new Error(`http:${response.status}:${label}`);
  return response.body;
}
/** Owner memory action under test (settings.ts:44-46,68); a non-200 status stops the journey with a code-only error. */
async function ownerAction(ctx: B34AdapterContext, body: Record<string, unknown>, label: string): Promise<Json> {
  const response = await ctx.action(body);
  if (response.status !== 200) throw new Error(`http:${response.status}:${label}`);
  return response.body;
}
/** Named owner setup step: recorded by ctx.setup with its verification note; a failed verification stops the journey. */
async function named(ctx: B34AdapterContext, name: string, method: string, path: string, body: unknown, verify: (body: Json) => { ok: boolean; note: string }): Promise<Json> {
  const response = await ctx.setup(name, method, path, body, 200, result => verify(result.body));
  if (!verify(response.body).ok) throw new Error(`${name} failed`);
  return response.body;
}
/** Every later phase depends on each adapter check, so a failed check stops the journey after it is recorded. */
function gate(ctx: B34AdapterContext, name: string, ok: unknown, detail: string): void {
  ctx.check(name, Boolean(ok), detail);
  if (!ok) throw new Error(`${name} failed`);
}

async function verificationModel(ctx: B34AdapterContext): Promise<string> {
  const response = await ctx.setup(null, "GET", "/api/instances", undefined, 200);
  const engines = response.body?.instances as Array<{ instanceId?: unknown; models?: { options?: Array<{ id?: unknown }> } }> | undefined;
  const model = engines?.find(engine => engine.instanceId === "verification")?.models?.options?.[0]?.id;
  if (typeof model !== "string") throw new Error("verification engine has no model option");
  return model;
}
/** Explicit fake-Claude selection: the loopback openai-compat instance could also chat. */
async function createBot(ctx: B34AdapterContext, name: string, model: string): Promise<Bot> {
  const made = await ctx.setup(null, "POST", "/api/bots", { name, section: "B34Fixture", modelSelection: { instanceId: "verification", model } }, 201);
  const bot = made.body?.bot as Bot | undefined;
  if (!bot || typeof bot.id !== "string" || typeof bot.threadId !== "string") throw new Error("bot create returned no bot");
  await ctx.setup(null, "PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false }, 200);
  return bot;
}
/** A new task is prepended and becomes the bot's active thread (store.ts:2092-2104). */
async function createTask(ctx: B34AdapterContext, bot: Bot, title: string): Promise<string> {
  const made = await ctx.setup(null, "POST", `/api/bots/${bot.id}/tasks`, { title }, 201);
  const threadId = made.body?.task?.threadId;
  if (typeof threadId !== "string") throw new Error("task create returned no thread");
  return threadId;
}

/** ctx.until with its label, predicate and timeout; a timeout gains code-only stall state. */
async function stalled<T>(ctx: B34AdapterContext, label: string, read: () => T | undefined | Promise<T | undefined>, timeout: number, detail: () => Promise<string>): Promise<T> {
  try { return await ctx.until(label, read, timeout); } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Timed out: ")) throw error;
    let extra: string;
    try { extra = await detail(); } catch { extra = "detail=?"; }
    throw new Error(`${error.message} {${extra}}`);
  }
}
function diagnostics(ctx: B34AdapterContext, state: JourneyState): () => Promise<string> {
  return async () => {
    const parts: string[] = [];
    const part = async (key: string, read: () => string | Promise<string>) => { try { parts.push(`${key}=${await read()}`); } catch { parts.push(`${key}=?`); } };
    for (const [key, id] of [["S", state.S], ["T", state.T]] as const) {
      if (id) await part(key, () => { const row = binding(ctx, id), intent = row?.intent; return row ? `${code(intent?.status)}/${code(intent?.reason)}/${code(intent?.attempts ?? 0)}/${flag(intent?.snapshot)}` : "none"; });
    }
    await part("L", () => { const ledger = ledgerDay(ctx); return ledger ? `${code(ledger.minute)}/${code(ledger.calls)}/${code(ledger.output)}` : "none"; });
    await part("F", () => familyDetail(families(ctx)));
    await part("jobs", () => String(activeJobs(ctx)));
    await part("trig", () => String(pendingTriggers(ctx)));
    await part("rv", () => String(reviewRows(ctx).length));
    await part("m", () => { const row = one(ctx, "SELECT mode,policy_revision FROM memory_meta WHERE id=1"); return row ? `${code(row.mode)}/${code(row.policy_revision)}` : "none"; });
    if (state.runId) await part("run", async () => code(runIn(await get(ctx, ROUTINES_PATH, "routines"), state.runId!)?.status));
    return parts.join(" ");
  };
}

/** Turn settlement rows of one thread: "working" at turn start, then the terminal outcome (settlement.ts:5-13). */
const turnSettlement = (ctx: B34AdapterContext, threadId: string) => {
  const row = one(ctx, "SELECT count(*) AS n,coalesce(sum(outcome='working'),0) AS working FROM memory_sources WHERE kind='turn' AND thread_id=?", threadId);
  return { turns: Number(row?.n ?? 0), working: Number(row?.working ?? 0) };
};
/** ctx.send to a task thread, then that thread's own settlement by evidence (b34-extractor-adapter.ts:236-248). */
async function sendToTask(ctx: B34AdapterContext, bot: Bot, text: string, threadId: string, label: string, detail: () => Promise<string>): Promise<Dump> {
  const before = turnSettlement(ctx, threadId).turns;
  const dump = await ctx.send(bot, text, false, threadId);
  await stalled(ctx, label, () => {
    const now = turnSettlement(ctx, threadId);
    return now.turns > before && now.working === 0 ? true : undefined;
  }, 30_000, async () => `tb=${before} ${await detail()}`);
  return dump;
}

/** The engine capability of a held turn, read from its MCP config (precedent: recall-journey.test.ts:44-66), only if it targets this fixture. */
function agentsCapability(config: unknown, fixtureUrl: string): { url: string; token: string } | undefined {
  const seen = new Set<unknown>();
  const find = (value: unknown, depth: number): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return undefined;
    seen.add(value);
    const env = (value as { env?: unknown }).env;
    if (env && typeof env === "object") {
      const vars = env as Record<string, unknown>;
      if (typeof vars.MURAGE_COMMS_TOKEN === "string" && vars.MURAGE_SKILL_AUTHORING_ENABLED === "1") return vars;
    }
    for (const child of Object.values(value)) { const found = find(child, depth + 1); if (found) return found; }
    return undefined;
  };
  const vars = find(config, 0);
  if (!vars || typeof vars.MURAGE_HARNESS_URL !== "string") return undefined;
  try {
    const target = new URL(vars.MURAGE_HARNESS_URL), fixture = new URL(fixtureUrl);
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== fixture.port) return undefined;
  } catch { return undefined; }
  return { url: vars.MURAGE_HARNESS_URL, token: String(vars.MURAGE_COMMS_TOKEN) };
}

function pinOf(body: Json, botId: string, threadId: string): PinRef | undefined {
  const bots = body?.bots;
  if (!Array.isArray(bots)) return undefined;
  const i = bots.findIndex(bot => bot?.id === botId);
  const tasks = i < 0 ? undefined : bots[i]?.tasks;
  if (!Array.isArray(tasks)) return undefined;
  const j = tasks.findIndex(task => task?.threadId === threadId);
  const bundleId = j < 0 ? undefined : tasks[j]?.procedurePin?.bundleId;
  return typeof bundleId === "string" && HEX64.test(bundleId) ? { i, j, bundleId } : undefined;
}
/** A content-addressed task bundle (procedure-bundles.ts:94-103): bytes hash to the pin and name the task. */
function bundleAt(dataDir: string, botId: string, threadId: string, bundleId: string | undefined): Bundle | undefined {
  if (!bundleId || !HEX64.test(bundleId) || !/^[\w-]+$/.test(botId) || !/^[\w-]+$/.test(threadId)) return undefined;
  try {
    const bytes = readFileSync(join(dataDir, "skill-state", botId, "task-bundles", threadId, `${bundleId}.json`));
    if (sha256(bytes) !== bundleId) return undefined;
    const bundle = JSON.parse(bytes.toString("utf8")) as Bundle & { schema?: unknown; botId?: unknown; threadId?: unknown };
    return bundle.schema === 1 && bundle.botId === botId && bundle.threadId === threadId ? bundle : undefined;
  } catch { return undefined; }
}
const skillEntry = (bundle: Bundle | undefined, name: string) => Array.isArray(bundle?.imported) ? bundle.imported.find(item => item?.name === name) : undefined;
async function waitPin(ctx: B34AdapterContext, botId: string, threadId: string, label: string, detail: () => Promise<string>): Promise<PinRef> {
  return stalled(ctx, label, async () => pinOf(await get(ctx, BOTS_PATH, "bots"), botId, threadId), 15_000, detail);
}
async function pinnedBundle(ctx: B34AdapterContext, botId: string, threadId: string): Promise<{ pin?: PinRef; bundle?: Bundle }> {
  const pin = pinOf(await get(ctx, BOTS_PATH, "bots"), botId, threadId);
  return { pin, bundle: bundleAt(ctx.dataDir, botId, threadId, pin?.bundleId) };
}

const routineIn = (body: Json, id: string): Json => (Array.isArray(body?.routines) ? body.routines : []).find((item: Json) => item?.id === id);
const runIn = (body: Json, id: string): Json => (Array.isArray(body?.runs) ? body.runs : []).find((item: Json) => item?.id === id);
const routineFields = (routine: Json) => JSON.stringify(ROUTINE_FIELDS.map(key => [key, routine?.[key] ?? null]));
/** A manual run (routines.ts:1024-1046) dispatched to a detached task and marked completed when its turn ends. */
async function runRoutine(ctx: B34AdapterContext, state: JourneyState, routineId: string, label: string, detail: () => Promise<string>): Promise<Json> {
  const made = await ctx.setup(null, "POST", `/api/routines/${routineId}/run`, undefined, 201);
  const runId = made.body?.run?.id;
  if (typeof runId !== "string") throw new Error("routine run returned no run");
  state.runId = runId;
  return stalled(ctx, label, async () => {
    const run = runIn(await get(ctx, ROUTINES_PATH, "routines"), runId);
    if (run && ["failed", "cancelled", "missed"].includes(run.status)) throw new Error(`routine-run:${code(run.status)}`);
    return run?.status === "completed" && typeof run.threadId === "string" ? run : undefined;
  }, 45_000, detail);
}

const apiRead = (fact: Q14ReadbackFact, path: string, pointer: string, observed: string): Q14Readback => ({ fact, via: "api", method: "GET", path, pointer, observed });
const ledgerRead = (day: string, observed: string): Q14Readback => ({ fact: "budget-lease-charge", via: "sqlite", sql: LEDGER_SQL, params: [`extract-budget:${day}`, "extract-budget"], column: "output", observed });
const POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
/** RFC 6901 scalar lookup, as the runner resolves readback pointers (runner:338-346). */
function pointed(body: unknown, pointer: string): string | undefined {
  if (!POINTER.test(pointer)) return undefined;
  let value: unknown = body;
  for (const token of pointer.slice(1).split("/").map(item => item.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(value) ? !/^(?:0|[1-9]\d*)$/.test(token) : !(value !== null && typeof value === "object" && Object.hasOwn(value, token))) return undefined;
    value = (value as Record<string, unknown>)[token];
  }
  return typeof value === "string" ? value : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? String(value) : undefined;
}
/** Local statement of the runner v3 readback refusal rules this adapter must satisfy (runner:167-208, 318-325). */
function readbackRefused(entry: Q14Readback): boolean {
  if (entry.observed.length < 1 || entry.observed.length > 400) return true;
  if (entry.via === "api") {
    return entry.path.length > 400 || entry.pointer.length > 400 || !entry.path.startsWith("/api/") || /[\s#\\]|\.\.|\/\//.test(entry.path)
      || /secret|token|credential|password|api-?key/i.test(entry.path) || !POINTER.test(entry.pointer) || entry.path.includes(entry.observed);
  }
  return entry.sql !== LEDGER_SQL || entry.column !== "output" || entry.params.length !== 2 || typeof entry.params[0] !== "string"
    || !/^extract-budget:\d{4}-\d{2}-\d{2}$/.test(entry.params[0]) || entry.params[1] !== "extract-budget" || entry.params.some(param => String(param) === entry.observed);
}
interface Claim { entry: Q14Readback; expected: string; field: string; pin?: { botId: string; threadId: string }; siblings?: Array<[string, string]> }
/** One final readback: refusal rules, a fresh re-read equal to observed, and (for pins, the resolved bundle revision) equal to the independently expected product value and the artifact field. */
function claimFailure(ctx: B34AdapterContext, claim: Claim, kind: "skill" | "routine", artifactId: string, bodies: Record<string, Json>): string | null {
  const { entry } = claim;
  if (readbackRefused(entry)) return "refused";
  let value: string | undefined;
  if (entry.via === "api") value = pointed(bodies[entry.path], entry.pointer);
  else {
    const output = one(ctx, "SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='extract-budget'", String(entry.params[0]))?.output;
    value = output === undefined || output === null ? undefined : String(output);
  }
  if (value !== entry.observed) return "reread";
  let resolved = entry.observed;
  if (claim.pin) {
    const bundle = bundleAt(ctx.dataDir, claim.pin.botId, claim.pin.threadId, entry.observed);
    const revision = kind === "skill" ? skillEntry(bundle, artifactId)?.revision : bundle?.routine?.id === artifactId ? bundle.routine.instructionRevision : undefined;
    if (typeof revision !== "string") return "pin";
    resolved = revision;
  }
  if (resolved !== claim.expected || claim.expected !== claim.field) return "value";
  if (entry.via === "api" && claim.siblings?.some(([pointer, expected]) => pointed(bodies[entry.path], pointer) !== expected)) return "sibling";
  return null;
}
const routinePairFirst = (pair: string) => { try { const value = JSON.parse(pair) as unknown; return Array.isArray(value) && typeof value[0] === "string" && JSON.stringify(value) === pair ? value[0] : ""; } catch { return ""; } };

async function runQ14(ctx: B34AdapterContext): Promise<AdapterArtifactsFor<"Q14">> {
  const startedAt = Date.now(), state: JourneyState = {}, diag = diagnostics(ctx, state);
  const phase = (name: string) => { if (Date.now() - startedAt > JOURNEY_BUDGET_MS) throw new Error(`journey-budget:${name}`); };
  const { skillName, skillOriginal, routineBase } = B34_Q14;
  const learnedSkill = skillOriginal.replace(B34_Q14.seedStep, B34_Q14.learnedStep);
  const learnedRoutine = routineBase.replace(B34_Q14.seedStep, B34_Q14.learnedStep);

  // ── Phase A: setup, no extractor selected ──────────────────────────────
  phase("A");
  const model = await verificationModel(ctx);
  // Learned skills require the owner feature flag (config.ts:222,481-483; index.ts:9030).
  await ctx.setup("q14-owner-enables-learned-skills", "PATCH", "/api/config", { features: { skillRecorder: true } }, 200);
  const status0 = await get(ctx, "/api/memory/status", "memory-status");
  const r0 = Number(status0?.learning?.revision);
  const listed = (Array.isArray(status0?.extractors) ? status0.extractors : []).find((item: Json) => item?.instanceId === B34_EVALUATOR_INSTANCE_ID);
  const installed = families(ctx);
  const unselected0 = Boolean(status0?.configuration) && status0.configuration.extractorInstanceId == null;
  gate(ctx, "q14-scripted-evaluator-installed", Number.isSafeInteger(r0) && unselected0 && listed?.eligible === true && installed.install === 1 && installed.refused === 0,
    `mode ${code(status0?.mode)}; loopback evaluator listed ${flag(listed)} eligible ${flag(listed?.eligible === true)}; none selected ${flag(unselected0)}; installs ${installed.install}; refused ${installed.refused}`);
  const configured = await named(ctx, "q14-owner-learning-configured-before-reviews", "POST", "/api/memory/action",
    { action: "configure", mode: "capture", learning: LEARNING, learningRevision: r0 }, body => ({
      ok: body?.mode === "capture" && body?.configuration?.extractorInstanceId == null && body?.learning?.revision === r0 + 1
        && Object.entries(LEARNING).every(([key, value]) => body?.learning?.[key] === value),
      note: `mode ${code(body?.mode)}; learning revision ${code(Number(body?.learning?.revision) - r0)} after; limits ${flag(Object.entries(LEARNING).every(([key, value]) => body?.learning?.[key] === value))}`,
    }));
  const L1 = Number(configured.learning.revision);
  const botA = await createBot(ctx, "Q14 Skill Owner", model), botB = await createBot(ctx, "Q14 Routine Owner", model);
  if (botA.modelSelection?.instanceId !== "verification" || botB.modelSelection?.instanceId !== "verification") throw new Error("q14-bots:model-selection");

  // ── Phase B: earlier tasks, extractor still unselected ─────────────────
  phase("B");
  // B1. The engine stages the skill from a held turn, through the turn's own authoring capability.
  const held = await ctx.send(botA, `${B34_Q14.authoringTurn}\n${HOLD_MARKER}`, true);
  const promptCarriesTurn = String(held.prompt?.message?.content ?? "").includes(B34_Q14.authoringTurn);
  let capability = false, stageStatus = 0, stagedName = false;
  try {
    const found = agentsCapability((held as Dump & { mcpConfig?: unknown }).mcpConfig, ctx.url);
    capability = found !== undefined;
    if (found && promptCarriesTurn) {
      const response = await fetch(new URL("/api/internal/skills/stage", found.url), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${found.token}` },
        body: JSON.stringify({ fromBotId: botA.id, fromThreadId: botA.threadId, action: "create", skill_md: skillOriginal, source: "conversation", gist: B34_Q14.gist }),
        signal: AbortSignal.timeout(15_000),
      });
      stageStatus = response.status;
      const body = await response.json().catch(() => null) as { name?: unknown } | null;
      stagedName = body?.name === skillName;
    }
  } finally {
    writeFileSync(join(ctx.fixtureFinishGateDir, String(held.pid)), "");
  }
  // The released turn ends on the same busy flag ctx.settled polls (index.ts:4279; mcp-server.ts:1065). ctx.settled itself runs
  // after the approval: while the staged card is unanswered it reports needs-user, never settled (mcp-server.ts:646-653,1036-1043).
  await stalled(ctx, "Q14 held authoring turn ended", async () => {
    const bots = (await get(ctx, BOTS_PATH, "bots"))?.bots;
    return (Array.isArray(bots) ? bots : []).find((bot: Json) => bot?.id === botA.id)?.busy === false ? true : undefined;
  }, 30_000, diag);
  const stageDetail = `held prompt ${flag(promptCarriesTurn)}; authoring capability ${flag(capability)}; stage HTTP ${stageStatus}; staged name ${flag(stagedName)}`;
  if (stageStatus !== 201 || !stagedName) gate(ctx, "q14-skill-learned-through-owner-card", false, stageDetail);

  // B2. The owner approves the exact card.
  const page = await get(ctx, `/api/threads/${botA.threadId}/messages?limit=50`, "thread-messages");
  const card = (Array.isArray(page?.messages) ? page.messages : []).map((message: Json) => message?.card).find((item: Json) => item?.skillRequest?.name === skillName && !item.answered && !item.dismissed);
  const requestId = card?.requestId, reviewedSha = card?.skillRequest?.sha256;
  if (typeof requestId !== "string" || typeof reviewedSha !== "string") gate(ctx, "q14-skill-learned-through-owner-card", false, `${stageDetail}; approval card missing`);
  const cardShaIsOriginal = reviewedSha === sha256(skillOriginal);
  await named(ctx, "q14-skill-owner-approves-card", "POST", `/api/bots/${botA.id}/respond`, { threadId: botA.threadId, requestId, behavior: "allow", reviewedSha256: reviewedSha },
    body => ({ ok: body?.outcome === "allowed-once" && cardShaIsOriginal, note: `outcome ${code(body?.outcome)}; card sha is the staged SKILL.md ${flag(cardShaIsOriginal)}` }));
  await ctx.settled("bot", botA.id);

  // B3. The learned skill's global revision.
  const globalHistoryPath = `/api/bots/${botA.id}/skills/${skillName}/history`;
  const history0 = await get(ctx, globalHistoryPath, "skill-history");
  const S0: string = history0?.currentRevision;
  gate(ctx, "q14-skill-learned-through-owner-card", typeof S0 === "string" && S0.length > 0 && S0.length <= 200 && !S0.startsWith("evaluated:") && !S0.startsWith("rollback:") && history0?.current?.sha256 === reviewedSha,
    `${stageDetail}; card approved; base revision present ${flag(typeof S0 === "string" && S0.length > 0)}; origin ${code(history0?.current?.origin)}`);

  // B4. An earlier skill task pins the base revision at its first dispatch (index.ts:4289-4291).
  const TE = await createTask(ctx, botA, "Q14 earlier skill task");
  await sendToTask(ctx, botA, B34_Q14.earlierSkillTurn, TE, "Q14 earlier skill task turn settled", diag);
  const tePin = await waitPin(ctx, botA.id, TE, "Q14 earlier skill task pinned", diag);
  const teBundle = bundleAt(ctx.dataDir, botA.id, TE, tePin.bundleId), teSkill = skillEntry(teBundle, skillName);
  gate(ctx, "q14-skill-earlier-task-pins-base", teBundle?.audienceKey === `bot:${botA.id}:owner` && teSkill?.revision === S0 && teSkill?.editable === true && teSkill?.sha256 === reviewedSha,
    `bundle verified ${flag(teBundle)}; owner audience ${flag(teBundle?.audienceKey === `bot:${botA.id}:owner`)}; imports base ${flag(teSkill?.revision === S0)}; editable ${flag(teSkill?.editable === true)}`);
  const TE_BUNDLE = tePin.bundleId;

  // B5. The routine, created disabled with an owner instruction (routines.ts:766-800).
  const createdRoutine = await ctx.setup(null, "POST", ROUTINES_PATH, { name: B34_Q14.routineName, botId: botB.id, prompt: routineBase, target: "bot", runOn: "ember", enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() }, durationMinutes: 30 }, 201);
  const routine0 = createdRoutine.body?.routine;
  const routineId: string = routine0?.id, B0: string = routine0?.instructionRevision, U0: number = routine0?.updatedAt;
  const routineShape = typeof routineId === "string" && routine0.prompt === routineBase && typeof B0 === "string" && HEX64.test(B0) && Number.isSafeInteger(U0) && routine0.nextRunAt === null
    && Array.isArray(routine0.instructionHistory) && routine0.instructionHistory.length === 1 && routine0.instructionHistory[0]?.id === B0 && routine0.instructionHistory[0]?.author === "owner";
  if (!routineShape) gate(ctx, "q14-routine-earlier-run-pins-base", false, "routine create returned no owner instruction revision");
  const FIELDS0 = routineFields(routine0);
  const routineBasePair = JSON.stringify([B0, U0]);

  // B6. An earlier routine run pins the base instruction in its run task bundle (index.ts:14376-14379).
  const run1 = await runRoutine(ctx, state, routineId, "Q14 earlier routine run completed", diag);
  const R1: string = run1.threadId;
  const r1Pin = await waitPin(ctx, botB.id, R1, "Q14 earlier routine run pinned", diag);
  const r1Bundle = bundleAt(ctx.dataDir, botB.id, R1, r1Pin.bundleId);
  gate(ctx, "q14-routine-earlier-run-pins-base", run1.prompt === routineBase && run1.instructionRevision === B0 && run1.instructionEvidence === undefined
    && r1Bundle?.routine?.id === routineId && r1Bundle.routine.instructionRevision === B0 && Array.isArray(r1Bundle.imported) && r1Bundle.imported.length === 0,
    `run instruction is base ${flag(run1.prompt === routineBase && run1.instructionRevision === B0)}; bundle verified ${flag(r1Bundle)}; bundle routine revision is base ${flag(r1Bundle?.routine?.instructionRevision === B0)}; imported ${code(r1Bundle?.imported?.length)}`);
  const R1_BUNDLE = r1Pin.bundleId;

  // B7. Both reviews are discovered and wait without a selected model (procedure-evaluator.ts:50; procedure-review.ts:216-218).
  const waiting = await stalled(ctx, "Q14 reviews waiting without a selected model", () => {
    if (activeJobs(ctx) !== 0 || pendingTriggers(ctx) !== 0) return undefined;
    const rows = reviewRows(ctx);
    if (rows.length !== 2) return undefined;
    const skill = rows.find(row => row.intent?.target?.kind === "skill" && row.intent.target.artifactId === skillName && row.intent.target.threadId === TE && row.intent.target.baseRevision === S0);
    const routine = rows.find(row => row.intent?.target?.kind === "routine" && row.intent.target.artifactId === routineId && row.intent.target.threadId === R1 && row.intent.target.baseRevision === routineBasePair);
    const parked = (row: Binding | undefined) => row?.subject === "procedure-review-pending" && row.intent.status === "deferred" && row.intent.reason === "PROCEDURE_MODEL_UNAVAILABLE"
      && !row.intent.snapshot && (row.intent.attempts ?? 0) === 0;
    return skill && routine && parked(skill) && parked(routine) ? { S: skill.id, T: routine.id } : undefined;
  }, 60_000, diag);
  const S = waiting.S, T = waiting.T;
  state.S = S; state.T = T;
  const status1 = await get(ctx, "/api/memory/status", "memory-status");
  const listedReviews: Json[] = Array.isArray(status1?.procedureEvolution?.reviews) ? status1.procedureEvolution.reviews : [];
  const listedUnstarted = [S, T].every(id => listedReviews.some(item => item?.id === id && item.started === false));
  const failedJobs = countOf(ctx, "SELECT count(*) AS n FROM memory_jobs WHERE status='failed'");
  const consolidation1 = consolidationRows(ctx);
  const leaseRows1 = countOf(ctx, "SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('procedure-evaluation-session','procedure-evaluation-charges','extract-budget')");
  const f1 = families(ctx), completions1 = f1.evaluation + f1.reflection + f1["unexpected-extract"] + f1["unexpected-ground"];
  gate(ctx, "q14-reviews-wait-without-selected-model", listedUnstarted && failedJobs === 0 && consolidation1 === 0 && leaseRows1 === 0 && completions1 === 0,
    `2 reviews deferred PROCEDURE_MODEL_UNAVAILABLE, attempts 0; listed unstarted ${flag(listedUnstarted)}; failed jobs ${failedJobs}; consolidation rows ${consolidation1}; lease rows ${leaseRows1}; loopback completions ${completions1}`);
  let canonical = false;
  try { const pair = JSON.parse(routineBasePair) as unknown; canonical = Array.isArray(pair) && pair.length === 2 && pair[0] === B0 && pair[1] === U0 && JSON.stringify(pair) === routineBasePair; } catch { canonical = false; }
  gate(ctx, "q14-routine-review-targets-canonical-pair", canonical && binding(ctx, T)?.intent?.target?.baseRevision === routineBasePair,
    `routine review base is the canonical [instructionRevision, updatedAt] pair ${flag(canonical)}`);

  // ── Phase C: evaluation window (no turns, no task or bot changes) ──────
  phase("C");
  await named(ctx, "q14-owner-selects-scripted-evaluator", "POST", "/api/memory/action", { action: "configure", extractorInstanceId: B34_EVALUATOR_INSTANCE_ID },
    body => ({ ok: body?.configuration?.extractorInstanceId === B34_EVALUATOR_INSTANCE_ID && body?.learning?.revision === L1 && body?.learning?.callsPerMinute === LEARNING.callsPerMinute,
      note: `selected ${flag(body?.configuration?.extractorInstanceId === B34_EVALUATOR_INSTANCE_ID)}; learning revision unchanged ${flag(body?.learning?.revision === L1)}` }));
  // Both skill attempts and the routine refusal must share one UTC minute (extract.ts:76,86-87).
  if (Date.now() % 60_000 > 25_000) {
    const next = (minute() + 1) * 60_000;
    await ctx.until("Q14 next UTC minute", () => Date.now() >= next ? true : undefined, 40_000);
  }
  const M = minute();

  // C3. Skill preview and authorization.
  phase("C3");
  const previewS = await ownerAction(ctx, { action: "procedure-evaluation-preview", reviewId: S }, "skill-preview");
  const previewSOk = previewS?.instruction === skillOriginal && previewS.eventEvidenceIncluded === false && previewS.eligible === true && previewS.reusableGrant === false
    && previewS.target?.kind === "skill" && previewS.corpus?.id === "procedure-outcome-groups" && String(previewS.model?.identity ?? "").startsWith(`${B34_EVALUATOR_INSTANCE_ID}:`);
  const authS = await ownerAction(ctx, { action: "procedure-evaluation-authorize", previewId: previewS?.previewId }, "skill-authorize");
  gate(ctx, "q14-skill-owner-preview-authorize", previewSOk && authS?.authorized === true && authS.reviewId === S,
    `preview shows exact instruction, synthetic corpus and loopback model ${flag(previewSOk)}; authorized ${flag(authS?.authorized === true)}`);

  // C4. Attempt 1 is the held-out probe: measured through three charged callbacks, then refused by the product gate.
  const probe = await stalled(ctx, "Q14 skill held-out probe settled", () => {
    const row = binding(ctx, S);
    return row?.intent?.snapshot && !["pending", "running"].includes(row.intent.status) ? row : undefined;
  }, 30_000, diag);
  const sessionS = sessionOf(ctx, S), G_S: string = sessionS?.intent?.grantId;
  const grantS1 = typeof G_S === "string" ? binding(ctx, G_S) : undefined, chargesS1 = chargesOf(ctx, S);
  const runtimeS1 = readB34EvaluatorReviews(ctx.dataDir).filter(line => line.requestId === S);
  const probeAttempt = runtimeS1.find(line => line.event === "attempt" && line.attempt === 1);
  const probeCallbacks = runtimeS1.filter(line => line.event === "callback" && line.attempt === 1);
  const probeBase = probeCallbacks.find(line => line.phase === "baseline"), probeBad = probeCallbacks.find(line => line.phase === "candidate-probe");
  const f2 = families(ctx), ledger1 = ledgerDay(ctx);
  const teHistory1 = await get(ctx, `${globalHistoryPath}?threadId=${TE}`, "skill-history-earlier-task");
  const global1 = await get(ctx, globalHistoryPath, "skill-history");
  const te1 = await pinnedBundle(ctx, botA.id, TE);
  const status2 = await get(ctx, "/api/memory/status", "memory-status");
  const listedStarted = (Array.isArray(status2?.procedureEvolution?.reviews) ? status2.procedureEvolution.reviews : []).some((item: Json) => item?.id === S && item.started === true);
  const refusedByGate = probe.subject === "procedure-review-pending" && probe.intent.status === "deferred" && probe.intent.reason === "PROCEDURE_HELDOUT_REJECTED"
    && probe.intent.attempts === 1 && probe.intent.retryAfter === null && !probe.intent.receipt && listedStarted;
  const measuredProbe = probeAttempt?.outcome === "returned" && probeAttempt.plan === "heldout-probe" && probeAttempt.decision === "accepted"
    && JSON.stringify(probeCallbacks.map(line => line.phase)) === JSON.stringify(["reflect-probe", "baseline", "candidate-probe"]) && probeCallbacks.every(line => line.loopbackHit === true)
    && probeBase?.score === 0 && probeBad?.score === 0 && probeBase.hardPass === false && probeBad.hardPass === false;
  const chargedProbe = typeof G_S === "string" && grantS1?.intent?.currentRevision === S0 && chargesS1?.intent?.grantId === G_S
    && tally(chargesS1.intent.evaluation, 2, 2 * EVALUATION_OUTPUT) && tally(chargesS1.intent.reflection, 1, REFLECTION_OUTPUT) && exact(chargesS1.intent.refusals, {})
    && f2.evaluation === 2 && f2.reflection === 1;
  const nothingPublished = teHistory1?.currentRevision === S0 && Array.isArray(teHistory1.revisions) && teHistory1.revisions.length === 0 && global1?.currentRevision === S0
    && te1.pin?.bundleId === TE_BUNDLE && skillEntry(te1.bundle, skillName)?.revision === S0;
  const probeLedger = ledger1?.output === 2 * EVALUATION_OUTPUT + REFLECTION_OUTPUT && (ledger1.minute !== M || ledger1.calls === 3);
  gate(ctx, "q14-skill-heldout-bad-candidate-refused", refusedByGate && measuredProbe && chargedProbe && nothingPublished && probeLedger,
    `review ${code(probe.intent.status)} ${code(probe.intent.reason)} attempts ${code(probe.intent.attempts)}; scripted acceptance claim on measured non-improving candidate ${flag(measuredProbe)}; charged 2 evaluation + 1 reflection ${flag(chargedProbe)}; nothing published, earlier task at base ${flag(nothingPublished)}; ledger ${flag(probeLedger)}`);
  const sessionS1 = JSON.stringify(sessionS?.intent);

  // C5. The owner retry resumes the same review; attempt 2 reuses the measured baseline and publishes scoped bytes.
  phase("C5");
  const retryS = await ownerAction(ctx, { action: "procedure-evaluation-retry", reviewId: S }, "skill-retry");
  if (retryS?.authorized !== true) throw new Error("q14-skill-retry:not-authorized");
  const doneS = await stalled(ctx, "Q14 skill review evaluated after owner retry", () => {
    const row = binding(ctx, S), intent = row?.intent;
    if (!intent || intent.status === "pending" || intent.status === "running") return undefined;
    return intent.status === "deferred" && intent.reason === "PROCEDURE_HELDOUT_REJECTED" && intent.attempts === 1 ? undefined : row;
  }, 30_000, diag);
  const receiptS = doneS.intent?.receipt;
  const RID_S = `b34-scripted:${leaseHash(S)}`, EVALUATED_S = `evaluated:${RID_S}`;
  const chargesS2 = chargesOf(ctx, S), grantS2 = binding(ctx, G_S), ledger2 = ledgerDay(ctx);
  const teHistory2 = await get(ctx, `${globalHistoryPath}?threadId=${TE}`, "skill-history-earlier-task");
  const global2 = await get(ctx, globalHistoryPath, "skill-history");
  const heldoutCore = (value: Json) => value ? { untouched: value.untouched, cases: value.cases, baseline: value.baseline, candidate: value.candidate, regressions: value.regressions } : null;
  const receiptSOk = doneS.subject === "procedure-review" && doneS.intent.status === "complete" && doneS.intent.reason === "accepted" && receiptS?.id === RID_S && receiptS.decision === "accepted"
    && /^b34-scripted-procedure-controller:[a-f0-9]{64}$/.test(String(receiptS.evaluator)) && receiptS.candidate === learnedSkill && HEX64.test(String(receiptS.heldout?.corpusDigest))
    && exact(heldoutCore(receiptS.heldout), { untouched: true, cases: 1, baseline: 0, candidate: 1, regressions: 0 })
    && exact(receiptS.accounting, { costLimitUsd: null, actualCostUsd: 0, costKnown: true, authorityReference: G_S, metricCalls: 3, reflectionCalls: 2 });
  const chargedS = chargesS2?.intent?.grantId === G_S && tally(chargesS2.intent.evaluation, 3, 3 * EVALUATION_OUTPUT) && tally(chargesS2.intent.reflection, 2, 2 * REFLECTION_OUTPUT)
    && exact(chargesS2.intent.refusals, {}) && JSON.stringify(sessionOf(ctx, S)?.intent) === sessionS1;
  const publishedS = teHistory2?.currentRevision === EVALUATED_S && global2?.currentRevision === S0 && grantS2?.intent?.currentRevision === EVALUATED_S && grantS2.intent.lastReceiptId === RID_S;
  const skillLedger = ledger2?.output === 3 * EVALUATION_OUTPUT + 2 * REFLECTION_OUTPUT && (ledger2.minute !== M || ledger2.calls === 5);
  gate(ctx, "q14-skill-retry-evaluates-and-publishes-scoped", receiptSOk && chargedS && publishedS && skillLedger,
    `receipt accepted, held-out 0 -> 1, 3 evaluation + 2 reflection callbacks ${flag(receiptSOk)}; charges exact, session unchanged ${flag(chargedS)}; scoped audience revision published, global base kept, grant advanced ${flag(publishedS)}; ledger ${flag(skillLedger)}`);

  // C6. Routine preview; the refusal is only meaningful inside minute M with the per-minute calls spent.
  phase("C6");
  const previewT = await ownerAction(ctx, { action: "procedure-evaluation-preview", reviewId: T }, "routine-preview");
  const previewTOk = previewT?.instruction === routineBase && previewT.target?.kind === "routine" && previewT.eligible === true && previewT.reusableGrant === false && previewT.eventEvidenceIncluded === false;
  const spent = ledgerDay(ctx);
  if (minute() !== M || Date.now() % 60_000 > 55_000 || spent?.minute !== M || spent.calls !== LEARNING.callsPerMinute)
    gate(ctx, "q14-routine-budget-refusal-on-first-callback", false, `minute-rolled:${M}/${minute()}; ledger calls ${code(spent?.calls)}`);
  const authT = await ownerAction(ctx, { action: "procedure-evaluation-authorize", previewId: previewT?.previewId }, "routine-authorize");
  gate(ctx, "q14-routine-owner-preview-authorize", previewTOk && authT?.authorized === true && authT.reviewId === T,
    `preview shows exact routine instruction ${flag(previewTOk)}; authorized ${flag(authT?.authorized === true)}`);

  // C7. The first routine callback is refused by the lease: zero charge, refusal counted, no attempt consumed.
  const refusedT = await stalled(ctx, "Q14 routine review refused on its first callback", () => {
    const row = binding(ctx, T);
    return row?.intent?.snapshot && !["pending", "running"].includes(row.intent.status) ? row : undefined;
  }, 30_000, diag);
  const G_T: string = sessionOf(ctx, T)?.intent?.grantId, chargesT1 = chargesOf(ctx, T);
  const ledger3 = ledgerDay(ctx), f3 = families(ctx);
  const runtimeT1 = readB34EvaluatorReviews(ctx.dataDir).filter(line => line.requestId === T);
  const routines3 = await get(ctx, ROUTINES_PATH, "routines");
  const leaseRefusal = refusedT.subject === "procedure-review-pending" && refusedT.intent.status === "deferred" && refusedT.intent.reason === "GEPA_CALL_NOT_STARTED"
    && (refusedT.intent.attempts ?? 0) === 0 && refusedT.intent.retryAfter === null && !refusedT.intent.receipt;
  const zeroCharge = typeof G_T === "string" && G_T !== G_S && chargesT1?.intent?.grantId === G_T && tally(chargesT1.intent.evaluation, 0, 0) && tally(chargesT1.intent.reflection, 0, 0)
    && exact(chargesT1.intent.refusals, { "budget-exhausted": 1 });
  const ledgerHeld = ledger3?.minute === M && ledger3.calls === 5 && ledger3.output === 3 * EVALUATION_OUTPUT + 2 * REFLECTION_OUTPUT && f3.evaluation === 3 && f3.reflection === 2;
  const noCallback = runtimeT1.length === 1 && runtimeT1[0]!.event === "attempt" && runtimeT1[0]!.outcome === "threw" && runtimeT1[0]!.errorCode === "GEPA_CALL_NOT_STARTED";
  const routineStill = routineIn(routines3, routineId)?.prompt === routineBase;
  gate(ctx, "q14-routine-budget-refusal-on-first-callback", leaseRefusal && zeroCharge && ledgerHeld && noCallback && routineStill,
    `review ${code(refusedT.intent.status)} ${code(refusedT.intent.reason)} attempts ${code(refusedT.intent.attempts ?? 0)}; charges 0 calls, refusals budget-exhausted 1 ${flag(zeroCharge)}; ledger and loopback unchanged ${flag(ledgerHeld)}; no callback ran ${flag(noCallback)}; routine unchanged ${flag(routineStill)}`);

  // C8. After the minute boundary, the owner retry resumes the same snapshot; each callback is charged once.
  phase("C8");
  await ctx.until("Q14 UTC minute after the refusal", () => minute() > M ? true : undefined, 65_000);
  const retryT = await ownerAction(ctx, { action: "procedure-evaluation-retry", reviewId: T }, "routine-retry");
  if (retryT?.authorized !== true) throw new Error("q14-routine-retry:not-authorized");
  const doneT = await stalled(ctx, "Q14 routine review evaluated after the minute boundary", () => {
    const row = binding(ctx, T), intent = row?.intent;
    if (!intent || intent.status === "pending" || intent.status === "running") return undefined;
    return readB34EvaluatorReviews(ctx.dataDir).filter(line => line.requestId === T && line.event === "attempt").length >= 2 ? row : undefined;
  }, 30_000, diag);
  const receiptT = doneT.intent?.receipt, RID_T = `b34-scripted:${leaseHash(T)}`;
  const routines4 = await get(ctx, ROUTINES_PATH, "routines"), routine4 = routineIn(routines4, routineId);
  const L: string = routine4?.instructionRevision, P1: number = routine4?.updatedAt;
  const learnedEntry = (Array.isArray(routine4?.instructionHistory) ? routine4.instructionHistory : []).find((item: Json) => item?.id === L);
  const run1Now = runIn(routines4, run1.id);
  const chargesT2 = chargesOf(ctx, T), grantT2 = typeof G_T === "string" ? binding(ctx, G_T) : undefined, ledger4 = ledgerDay(ctx), totals4 = ledgerTotals(ctx);
  const PUBLISHED_T = JSON.stringify([L, P1]);
  const receiptTOk = doneT.subject === "procedure-review" && doneT.intent.status === "complete" && doneT.intent.reason === "accepted" && receiptT?.id === RID_T && receiptT.decision === "accepted"
    && receiptT.candidate === learnedRoutine && exact(heldoutCore(receiptT.heldout), { untouched: true, cases: 1, baseline: 0, candidate: 1, regressions: 0 })
    && exact(receiptT.accounting, { costLimitUsd: null, actualCostUsd: 0, costKnown: true, authorityReference: G_T, metricCalls: 2, reflectionCalls: 1 });
  const chargedT = chargesT2?.intent?.grantId === G_T && tally(chargesT2.intent.evaluation, 2, 2 * EVALUATION_OUTPUT) && tally(chargesT2.intent.reflection, 1, REFLECTION_OUTPUT)
    && exact(chargesT2.intent.refusals, { "budget-exhausted": 1 });
  const instructionOnly = routine4?.prompt === learnedRoutine && typeof L === "string" && UUID.test(L) && L !== B0 && Number.isSafeInteger(P1) && P1 > U0
    && learnedEntry?.parentId === B0 && learnedEntry.author === "learned" && learnedEntry.evaluationReceiptId === RID_T && Array.isArray(learnedEntry.evidence) && learnedEntry.evidence.length > 0
    && routineFields(routine4) === FIELDS0 && !("recipients" in routine4) && !("permissions" in routine4)
    && run1Now?.prompt === routineBase && run1Now.instructionRevision === B0 && grantT2?.intent?.currentRevision === PUBLISHED_T;
  const resumeLedger = totals4.output === TOTAL_OUTPUT && ledger4?.minute > M && ledger4.calls === 3;
  gate(ctx, "q14-routine-resume-after-minute-publishes-instruction-only", receiptTOk && chargedT && instructionOnly && resumeLedger,
    `receipt accepted, 2 evaluation + 1 reflection ${flag(receiptTOk)}; charges exact with the refusal kept ${flag(chargedT)}; only prompt, instructionRevision, instructionHistory and updatedAt changed (compared ${ROUTINE_FIELDS.length} other fields; routines carry no recipients or permissions fields), earlier run kept base ${flag(instructionOnly)}; ledger ${flag(resumeLedger)}`);

  // C9. Unselect the evaluator before any later turn.
  await named(ctx, "q14-owner-unselects-evaluator-after-reviews", "POST", "/api/memory/action", { action: "configure", extractorInstanceId: null },
    body => ({ ok: body?.configuration?.extractorInstanceId == null && body?.learning?.revision === L1, note: `unselected ${flag(body?.configuration?.extractorInstanceId == null)}; learning revision unchanged ${flag(body?.learning?.revision === L1)}` }));
  const sessions = subjectRows(ctx, "procedure-evaluation-session"), chargeRows = subjectRows(ctx, "procedure-evaluation-charges");
  const leaseIds = (prefix: string) => JSON.stringify([`${prefix}:${leaseHash(S)}`, `${prefix}:${leaseHash(T)}`].sort());
  const sessionsOk = JSON.stringify(sessions.map(row => row.id).sort()) === leaseIds("procedure-evaluation-session");
  const chargeRowsOk = JSON.stringify(chargeRows.map(row => row.id).sort()) === leaseIds("procedure-evaluation-charges");
  const charged = chargeRows.reduce((sum, row) => ({
    input: sum.input + num(row.intent?.evaluation?.input) + num(row.intent?.reflection?.input),
    output: sum.output + num(row.intent?.evaluation?.output) + num(row.intent?.reflection?.output),
  }), { input: 0, output: 0 });
  const totals5 = ledgerTotals(ctx), f4 = families(ctx), consolidation5 = consolidationRows(ctx);
  const status5 = await get(ctx, "/api/memory/status", "memory-status");
  const loopbackOk = f4.install === 1 && f4.evaluation === 5 && f4.reflection === 3 && f4["unexpected-extract"] === 0 && f4["unexpected-ground"] === 0 && f4.refused === 0;
  const fenced = doneS.intent?.snapshot?.learningRevision === L1 && doneT.intent?.snapshot?.learningRevision === L1 && status5?.learning?.revision === L1;
  const runtimeAll = readB34EvaluatorReviews(ctx.dataDir);
  const callbacksHit = runtimeAll.filter(line => line.event === "callback").every(line => line.loopbackHit === true)
    && !runtimeAll.some(line => line.event === "callback-failed" || line.outcome === "guard");
  gate(ctx, "q14-lease-window-attributable", sessionsOk && chargeRowsOk && charged.output === TOTAL_OUTPUT && charged.output === totals5.output && charged.input === totals5.input && totals5.input > 0
    && loopbackOk && consolidation5 === 0 && fenced && callbacksHit,
    `sessions ${sessions.length}; charges rows ${chargeRows.length}; charges output ${charged.output} = ledger ${totals5.output}; input equal ${flag(charged.input === totals5.input)}; loopback ${familyDetail(f4)}; consolidation rows ${consolidation5}; learning fence ${flag(fenced)}; callbacks all loopback ${flag(callbacksHit)}`);
  const allHitFor = (reviewId: string) => {
    const lines = runtimeAll.filter(line => line.requestId === reviewId && (line.event === "callback" || line.event === "callback-failed"));
    return lines.length > 0 && lines.every(line => line.event === "callback" && line.loopbackHit === true);
  };
  gate(ctx, "q14-known-zero-cost-scripted-loopback-only", receiptS.accounting.costKnown === true && receiptS.accounting.actualCostUsd === 0 && receiptT.accounting.costKnown === true
    && receiptT.accounting.actualCostUsd === 0 && allHitFor(S) && allHitFor(T) && f4.install === 1,
    "known zero only because every counted callback of both reviews was answered by the 127.0.0.1 scripted loopback; production and provider cost stay unknown and untouched");
  const chargesAtWindowEnd = JSON.stringify(chargeRows.map(row => [row.id, row.intent]));

  // ── Phase D: next task and rollback (extractor unselected) ────────────
  phase("D");
  // D1. A next skill task pins the published audience revision (skills.ts:1846-1863).
  const TN = await createTask(ctx, botA, "Q14 next skill task");
  await sendToTask(ctx, botA, B34_Q14.nextSkillTurn, TN, "Q14 next skill task turn settled", diag);
  const tnPin = await waitPin(ctx, botA.id, TN, "Q14 next skill task pinned", diag);
  const tnSkill = skillEntry(bundleAt(ctx.dataDir, botA.id, TN, tnPin.bundleId), skillName);
  const te5 = await pinnedBundle(ctx, botA.id, TE);
  const teRevisionAfterPublication = skillEntry(te5.bundle, skillName)?.revision;
  gate(ctx, "q14-skill-next-task-pins-published", tnSkill?.revision === EVALUATED_S && tnSkill.sha256 === receiptS.candidateHash && te5.pin?.bundleId === TE_BUNDLE && teRevisionAfterPublication === S0,
    `next task imports published revision ${flag(tnSkill?.revision === EVALUATED_S)} with candidate bytes ${flag(tnSkill?.sha256 === receiptS.candidateHash)}; earlier task pin unchanged at base ${flag(te5.pin?.bundleId === TE_BUNDLE && teRevisionAfterPublication === S0)}`);

  // D2. The owner rolls the audience revision back to the retained base (skills.ts:1938-1957).
  await named(ctx, "q14-skill-owner-rollback", "POST", `/api/bots/${botA.id}/skills/${skillName}/rollback`, { expectedRevision: EVALUATED_S, targetRevision: S0, threadId: TN },
    body => ({ ok: body?.skill?.name === skillName, note: `skill ${flag(body?.skill?.name === skillName)}` }));
  const tnHistory = await get(ctx, `${globalHistoryPath}?threadId=${TN}`, "skill-history-next-task");
  const ROLLBACK: string = tnHistory?.currentRevision;
  const retained = (Array.isArray(tnHistory?.revisions) ? tnHistory.revisions : []).map((item: Json) => item?.revision);
  const global3 = await get(ctx, globalHistoryPath, "skill-history");
  gate(ctx, "q14-skill-rollback-restores-base", typeof ROLLBACK === "string" && ROLLBACK.startsWith("rollback:") && tnHistory.current?.origin === "rollback" && tnHistory.current?.rollbackOf === S0
    && retained.length === 2 && retained.includes(S0) && retained.includes(EVALUATED_S) && global3?.currentRevision === S0,
    `current rollback revision ${flag(typeof ROLLBACK === "string" && ROLLBACK.startsWith("rollback:"))}; rollbackOf base ${flag(tnHistory?.current?.rollbackOf === S0)}; retained ${retained.length}; global base kept ${flag(global3?.currentRevision === S0)}`);

  // D3. A post-rollback skill task pins the rollback revision with the base bytes.
  const TR = await createTask(ctx, botA, "Q14 post rollback skill task");
  await sendToTask(ctx, botA, B34_Q14.postRollbackSkillTurn, TR, "Q14 post rollback skill task turn settled", diag);
  const trPin = await waitPin(ctx, botA.id, TR, "Q14 post rollback skill task pinned", diag);
  const trSkill = skillEntry(bundleAt(ctx.dataDir, botA.id, TR, trPin.bundleId), skillName);
  const tn6 = await pinnedBundle(ctx, botA.id, TN), te6 = await pinnedBundle(ctx, botA.id, TE);
  gate(ctx, "q14-skill-post-rollback-task-pins-rollback", trSkill?.revision === ROLLBACK && trSkill.sha256 === reviewedSha
    && tn6.pin?.bundleId === tnPin.bundleId && skillEntry(tn6.bundle, skillName)?.revision === EVALUATED_S && te6.pin?.bundleId === TE_BUNDLE && skillEntry(te6.bundle, skillName)?.revision === S0,
    `post-rollback task imports rollback revision with base bytes ${flag(trSkill?.revision === ROLLBACK && trSkill?.sha256 === reviewedSha)}; next task kept published ${flag(skillEntry(tn6.bundle, skillName)?.revision === EVALUATED_S)}; earlier task kept base ${flag(skillEntry(te6.bundle, skillName)?.revision === S0)}`);

  // D4. A next routine run carries the published instruction and its evidence (routines.ts:1316-1318, 1568-1576).
  const run2 = await runRoutine(ctx, state, routineId, "Q14 next routine run completed", diag);
  const R2: string = run2.threadId;
  const r2Pin = await waitPin(ctx, botB.id, R2, "Q14 next routine run pinned", diag);
  const r2Bundle = bundleAt(ctx.dataDir, botB.id, R2, r2Pin.bundleId), r1Now = await pinnedBundle(ctx, botB.id, R1);
  gate(ctx, "q14-routine-next-run-uses-published", run2.prompt === learnedRoutine && run2.instructionRevision === L && run2.instructionEvaluationReceiptId === RID_T
    && Array.isArray(run2.instructionEvidence) && run2.instructionEvidence.length > 0 && r2Bundle?.routine?.id === routineId && r2Bundle.routine.instructionRevision === L
    && r1Now.pin?.bundleId === R1_BUNDLE && r1Now.bundle?.routine?.instructionRevision === B0,
    `next run uses published instruction and receipt ${flag(run2.instructionRevision === L && run2.instructionEvaluationReceiptId === RID_T)}; run bundle pins it ${flag(r2Bundle?.routine?.instructionRevision === L)}; earlier run kept base ${flag(r1Now.bundle?.routine?.instructionRevision === B0)}`);

  // D5. The owner rolls the routine instruction back to the base (routines.ts:912-931).
  const current8 = routineIn(await get(ctx, ROUTINES_PATH, "routines"), routineId);
  if (current8?.instructionRevision !== L || current8.updatedAt !== P1) gate(ctx, "q14-routine-rollback-restores-base-instruction", false, "routine changed before rollback");
  await named(ctx, "q14-routine-owner-rollback", "POST", `/api/routines/${routineId}/instructions/rollback`, { expectedRevision: L, expectedUpdatedAt: P1, targetRevision: B0 },
    body => ({ ok: body?.routine?.id === routineId && body.routine.instructionRevision !== L, note: `routine ${flag(body?.routine?.id === routineId)}; revision moved ${flag(body?.routine?.instructionRevision !== L)}` }));
  const routine9 = routineIn(await get(ctx, ROUTINES_PATH, "routines"), routineId);
  const K: string = routine9?.instructionRevision, T1: number = routine9?.updatedAt;
  const rollbackEntry = (Array.isArray(routine9?.instructionHistory) ? routine9.instructionHistory : []).find((item: Json) => item?.id === K);
  gate(ctx, "q14-routine-rollback-restores-base-instruction", routine9?.prompt === routineBase && typeof K === "string" && UUID.test(K) && K !== L && K !== B0 && Number.isSafeInteger(T1) && T1 > P1
    && rollbackEntry?.parentId === L && rollbackEntry.author === "rollback" && rollbackEntry.rollbackOf === B0 && rollbackEntry.evidence === undefined && rollbackEntry.evaluationReceiptId === undefined
    && routineFields(routine9) === FIELDS0,
    `base instruction restored as a new revision ${flag(routine9?.prompt === routineBase && K !== L && K !== B0)}; entry rollbackOf base without evidence ${flag(rollbackEntry?.rollbackOf === B0 && rollbackEntry?.evidence === undefined)}; other ${ROUTINE_FIELDS.length} fields unchanged ${flag(routineFields(routine9) === FIELDS0)}`);

  // D6. A post-rollback routine run pins the rollback revision.
  const run3 = await runRoutine(ctx, state, routineId, "Q14 post rollback routine run completed", diag);
  const R3: string = run3.threadId;
  const r3Pin = await waitPin(ctx, botB.id, R3, "Q14 post rollback routine run pinned", diag);
  const r3Bundle = bundleAt(ctx.dataDir, botB.id, R3, r3Pin.bundleId);
  const r1Later = await pinnedBundle(ctx, botB.id, R1), r2Later = await pinnedBundle(ctx, botB.id, R2);
  gate(ctx, "q14-routine-post-rollback-run-uses-rollback", run3.instructionRevision === K && run3.prompt === routineBase && run3.instructionEvidence === undefined
    && r3Bundle?.routine?.id === routineId && r3Bundle.routine.instructionRevision === K && r1Later.pin?.bundleId === R1_BUNDLE && r1Later.bundle?.routine?.instructionRevision === B0
    && r2Later.pin?.bundleId === r2Pin.bundleId && r2Later.bundle?.routine?.instructionRevision === L,
    `post-rollback run uses rollback revision ${flag(run3.instructionRevision === K && run3.prompt === routineBase)}; run bundle pins it ${flag(r3Bundle?.routine?.instructionRevision === K)}; earlier runs kept base and published ${flag(r1Later.bundle?.routine?.instructionRevision === B0 && r2Later.bundle?.routine?.instructionRevision === L)}`);

  // D7. Later turns settle; their reviews are never evaluated.
  await stalled(ctx, "Q14 later turns and reviews quiesced", async () => {
    if (activeJobs(ctx) !== 0 || pendingTriggers(ctx) !== 0) return undefined;
    const routines = await get(ctx, ROUTINES_PATH, "routines");
    if ((Array.isArray(routines?.runs) ? routines.runs : []).some((run: Json) => ["queued", "running", "waiting"].includes(run?.status))) return undefined;
    const bots = await get(ctx, BOTS_PATH, "bots");
    const busy = (Array.isArray(bots?.bots) ? bots.bots : []).filter((bot: Json) => bot?.id === botA.id || bot?.id === botB.id)
      .some((bot: Json) => bot.busy === true || (Array.isArray(bot.tasks) ? bot.tasks : []).some((task: Json) => task?.busy === true));
    return busy ? undefined : true;
  }, 30_000, diag);
  const later = reviewRows(ctx).filter(row => row.id !== S && row.id !== T);
  const sessions7 = subjectRows(ctx, "procedure-evaluation-session"), f7 = families(ctx), totals7 = ledgerTotals(ctx);
  const chargesUnchanged = JSON.stringify(subjectRows(ctx, "procedure-evaluation-charges").map(row => [row.id, row.intent])) === chargesAtWindowEnd;
  gate(ctx, "q14-later-reviews-not-evaluated", later.length > 0 && later.every(row => !row.intent?.snapshot && !row.intent?.receipt)
    && JSON.stringify(sessions7.map(row => row.id).sort()) === leaseIds("procedure-evaluation-session") && chargesUnchanged && totals7.output === TOTAL_OUTPUT && familyDetail(f7) === familyDetail(f4),
    `${later.length} later reviews, none with snapshot or receipt ${flag(later.every(row => !row.intent?.snapshot && !row.intent?.receipt))}; sessions ${sessions7.length}; charges unchanged ${flag(chargesUnchanged)}; ledger output ${totals7.output}; loopback ${familyDetail(f7)}`);

  // ── Phase E: final readbacks (nothing mutates after this point) ────────
  phase("E");
  const skillPath = `/api/bots/${botA.id}/skills/${skillName}/history?threadId=${TN}`;
  const routinesBody = await get(ctx, ROUTINES_PATH, "routines"), botsBody = await get(ctx, BOTS_PATH, "bots"), histBody = await get(ctx, skillPath, "skill-history-next-task");
  const ledgerDays = subjectRows(ctx, "extract-budget").map(row => ({ day: row.id.slice("extract-budget:".length), output: num(row.intent?.output) })).filter(item => item.output > 0);
  // The product keys the ledger by UTC day (extract.ts:75); a split day is an environment outcome, never forced.
  if (ledgerDays.length !== 1 || ledgerDays[0]!.output !== TOTAL_OUTPUT) gate(ctx, "q14-final-readbacks-asserted", false, ledgerDays.length > 1 ? `utc-day-split:${ledgerDays.length} ledger days` : `ledger output ${ledgerDays[0]?.output ?? 0}`);
  const day = ledgerDays[0]!.day, leaseCharge = String(ledgerDays[0]!.output);

  const pinTE = pinOf(botsBody, botA.id, TE), pinTN = pinOf(botsBody, botA.id, TN), pinTR = pinOf(botsBody, botA.id, TR);
  const pinR1 = pinOf(botsBody, botB.id, R1), pinR2 = pinOf(botsBody, botB.id, R2), pinR3 = pinOf(botsBody, botB.id, R3);
  const N = (Array.isArray(histBody?.revisions) ? histBody.revisions : []).findIndex((item: Json) => item?.revision === EVALUATED_S);
  const n = (Array.isArray(routinesBody?.routines) ? routinesBody.routines : []).findIndex((item: Json) => item?.id === routineId);
  const finalRoutine = n < 0 ? undefined : routinesBody.routines[n];
  const historyOf = Array.isArray(finalRoutine?.instructionHistory) ? finalRoutine.instructionHistory as Json[] : [];
  const mL = historyOf.findIndex(item => item?.id === L), mK = historyOf.findIndex(item => item?.id === K);
  if (!pinTE || !pinTN || !pinTR || !pinR1 || !pinR2 || !pinR3 || N < 0 || !finalRoutine || mL < 0 || mK < 0)
    gate(ctx, "q14-final-readbacks-asserted", false, `final indexes: task pins ${[pinTE, pinTN, pinTR, pinR1, pinR2, pinR3].filter(Boolean).length}/6; history ${N}; routine ${n}; entries ${mL}/${mK}`);
  const pinPointer = (pin: PinRef) => `/bots/${pin.i}/tasks/${pin.j}/procedurePin/bundleId`;
  const revisionOfPin = (botId: string, threadId: string, pin: PinRef | undefined, kind: "skill" | "routine") => {
    const bundle = bundleAt(ctx.dataDir, botId, threadId, pin?.bundleId);
    const revision = kind === "skill" ? skillEntry(bundle, skillName)?.revision : bundle?.routine?.id === routineId ? bundle.routine.instructionRevision : undefined;
    return typeof revision === "string" ? revision : "";
  };
  const finalK: string = finalRoutine.instructionRevision, finalT1: number = finalRoutine.updatedAt;
  const reviewT = binding(ctx, T)?.intent, reviewS = binding(ctx, S)?.intent;

  const skillVariant: Q14Variant = {
    reviewId: S, receiptId: RID_S, evaluator: String(reviewS?.receipt?.evaluator),
    heldout: reviewS?.receipt?.heldout,
    budget: { authorityReference: G_S, costKnown: true, actualCostUsd: 0, leaseCharge },
    publication: { kind: "skill", artifactId: skillName, baseRevision: S0, publishedRevision: EVALUATED_S },
    earlierTask: { threadId: TE, revisionAfterPublication: String(teRevisionAfterPublication), revisionAfterRollback: revisionOfPin(botA.id, TE, pinTE, "skill") },
    nextTask: { threadId: TN, revision: revisionOfPin(botA.id, TN, pinTN, "skill") },
    rollback: { fromRevision: EVALUATED_S, toRevision: String(histBody?.currentRevision), nextTask: { threadId: TR, revision: revisionOfPin(botA.id, TR, pinTR, "skill") } },
    readback: [
      apiRead("current-revision", skillPath, "/currentRevision", String(pointed(histBody, "/currentRevision"))),
      apiRead("published-revision-in-history", skillPath, `/revisions/${N}/revision`, String(pointed(histBody, `/revisions/${N}/revision`))),
      apiRead("rollback-history-entry", skillPath, "/current/rollbackOf", String(pointed(histBody, "/current/rollbackOf"))),
      apiRead("earlier-task-pin", BOTS_PATH, pinPointer(pinTE!), pinTE!.bundleId),
      apiRead("next-task-pin", BOTS_PATH, pinPointer(pinTN!), pinTN!.bundleId),
      apiRead("post-rollback-task-pin", BOTS_PATH, pinPointer(pinTR!), pinTR!.bundleId),
      ledgerRead(day, leaseCharge),
    ],
  };
  const routineBaseRevision = String(reviewT?.snapshot?.target?.baseRevision);
  const rollbackPair = JSON.stringify([finalK, finalT1]);
  const routineRoot = `/routines/${n}`, learnedAt = `${routineRoot}/instructionHistory/${mL}`, rollbackAt = `${routineRoot}/instructionHistory/${mK}`;
  const routineVariant: Q14Variant = {
    reviewId: T, receiptId: RID_T, evaluator: String(reviewT?.receipt?.evaluator),
    heldout: reviewT?.receipt?.heldout,
    budget: { authorityReference: G_T, costKnown: true, actualCostUsd: 0, leaseCharge },
    publication: { kind: "routine", artifactId: routineId, baseRevision: routineBaseRevision, publishedRevision: PUBLISHED_T },
    earlierTask: { threadId: R1, revisionAfterPublication: routineBaseRevision, revisionAfterRollback: routineBaseRevision },
    nextTask: { threadId: R2, revision: PUBLISHED_T },
    rollback: { fromRevision: PUBLISHED_T, toRevision: rollbackPair, nextTask: { threadId: R3, revision: rollbackPair } },
    readback: [
      apiRead("current-revision", ROUTINES_PATH, `${routineRoot}/instructionRevision`, String(pointed(routinesBody, `${routineRoot}/instructionRevision`))),
      apiRead("published-revision-in-history", ROUTINES_PATH, `${learnedAt}/id`, String(pointed(routinesBody, `${learnedAt}/id`))),
      apiRead("rollback-history-entry", ROUTINES_PATH, `${rollbackAt}/rollbackOf`, String(pointed(routinesBody, `${rollbackAt}/rollbackOf`))),
      apiRead("earlier-task-pin", BOTS_PATH, pinPointer(pinR1!), pinR1!.bundleId),
      apiRead("next-task-pin", BOTS_PATH, pinPointer(pinR2!), pinR2!.bundleId),
      apiRead("post-rollback-task-pin", BOTS_PATH, pinPointer(pinR3!), pinR3!.bundleId),
      ledgerRead(day, leaseCharge),
    ],
  };

  // E3. Every readback is re-read from fresh product bodies and bundle files and compared with values established earlier in the journey.
  const bodies: Record<string, Json> = { [skillPath]: await get(ctx, skillPath, "skill-history-next-task"), [BOTS_PATH]: await get(ctx, BOTS_PATH, "bots"), [ROUTINES_PATH]: await get(ctx, ROUTINES_PATH, "routines") };
  const [sCurrent, sPublished, sRollback, sEarlier, sNext, sPost, sLedger] = skillVariant.readback as [Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback];
  const [rCurrent, rPublished, rRollback, rEarlier, rNext, rPost, rLedger] = routineVariant.readback as [Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback, Q14Readback];
  const skillClaims: Claim[] = [
    { entry: sCurrent, expected: ROLLBACK, field: skillVariant.rollback.toRevision },
    { entry: sPublished, expected: EVALUATED_S, field: skillVariant.publication.publishedRevision },
    { entry: sRollback, expected: S0, field: skillVariant.publication.baseRevision },
    { entry: sEarlier, expected: S0, field: skillVariant.earlierTask.revisionAfterRollback, pin: { botId: botA.id, threadId: TE } },
    { entry: sNext, expected: EVALUATED_S, field: skillVariant.nextTask.revision, pin: { botId: botA.id, threadId: TN } },
    { entry: sPost, expected: ROLLBACK, field: skillVariant.rollback.nextTask.revision, pin: { botId: botA.id, threadId: TR } },
    { entry: sLedger, expected: String(TOTAL_OUTPUT), field: skillVariant.budget.leaseCharge },
  ];
  const routineClaims: Claim[] = [
    { entry: rCurrent, expected: K, field: routinePairFirst(routineVariant.rollback.toRevision), siblings: [[`${routineRoot}/id`, routineId], [`${routineRoot}/updatedAt`, String(T1)]] },
    { entry: rPublished, expected: L, field: routinePairFirst(routineVariant.publication.publishedRevision), siblings: [[`${routineRoot}/id`, routineId], [`${learnedAt}/author`, "learned"], [`${learnedAt}/evaluationReceiptId`, RID_T]] },
    { entry: rRollback, expected: B0, field: routinePairFirst(routineVariant.publication.baseRevision), siblings: [[`${routineRoot}/id`, routineId], [`${rollbackAt}/author`, "rollback"], [`${rollbackAt}/id`, K]] },
    { entry: rEarlier, expected: B0, field: routinePairFirst(routineVariant.earlierTask.revisionAfterRollback), pin: { botId: botB.id, threadId: R1 } },
    { entry: rNext, expected: L, field: routinePairFirst(routineVariant.nextTask.revision), pin: { botId: botB.id, threadId: R2 } },
    { entry: rPost, expected: K, field: routinePairFirst(routineVariant.rollback.nextTask.revision), pin: { botId: botB.id, threadId: R3 } },
    { entry: rLedger, expected: String(TOTAL_OUTPUT), field: routineVariant.budget.leaseCharge },
  ];
  const failures = [
    ...skillClaims.map(claim => [`skill ${claim.entry.fact}`, claimFailure(ctx, claim, "skill", skillName, bodies)] as const),
    ...routineClaims.map(claim => [`routine ${claim.entry.fact}`, claimFailure(ctx, claim, "routine", routineId, bodies)] as const),
  ].filter(([, failure]) => failure !== null);
  const pairsConsistent = routineBaseRevision === routineBasePair && finalK === K && finalT1 === T1 && skillVariant.earlierTask.revisionAfterPublication === S0
    && reviewS?.receipt?.id === RID_S && reviewT?.receipt?.id === RID_T && sessionOf(ctx, S)?.intent?.grantId === G_S && sessionOf(ctx, T)?.intent?.grantId === G_T;
  gate(ctx, "q14-final-readbacks-asserted", failures.length === 0 && pairsConsistent,
    `${skillClaims.length + routineClaims.length - failures.length}/${skillClaims.length + routineClaims.length} readbacks re-read and matched${failures.length ? `; failed ${failures.map(([label, failure]) => `${label}:${failure}`).join(",").slice(0, 160)}` : ""}; revision pairs and sessions consistent ${flag(pairsConsistent)}`);

  return { row: "Q14", variants: [skillVariant, routineVariant] };
}

export const b34Q14Adapter: B34Adapter = { row: "Q14", launch: { instrumentationSource: B34_EVALUATOR_INSTRUMENTATION }, run: runQ14 };
