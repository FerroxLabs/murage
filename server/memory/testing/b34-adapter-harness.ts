// B34 adapter harness: test support (not a *.test.ts). It lets a Vitest file
// run one join adapter against the isolated fake-engine server the way Claude
// 5's runner scripts/b34-receipt-matrix.ts (v3, sha256 69fbb75f…9c78) does,
// before the runner joins it:
//   loadAdapter 528-540     export shape and row must be usable
//   runServer 916-1026      launch with launch.instrumentationSource, desktop
//                           handshake, refresh after restart, the Ctx methods the
//                           adapter context delegates to, "scenario-completed" on
//                           a thrown error, fixture always closed
//   runAdapter 1029-1070    adapter context, runner-observed requests, read-only
//                           view, Q14 lease snapshots immediately before and after
//                           adapter.run, adapter-recorded-behavioural-checks,
//                           adapter-artifacts-valid
//   verifyAdapterArtifacts 1072-1151 for all four rows (Q14: one skill and one
//                           routine variant, renamed q14-<kind>-* checks and the
//                           four q14-lease-* checks)
//   verifyQ14Readbacks 1153-1200 runner re-read of every Q14 readback
// Receipt-only runner behaviour is not mirrored: no receipt, inputs, engines,
// limitations or deliveredMemory are written, and no server log is copied
// anywhere. The verification connection is read-only. Nothing is logged;
// check details keep the runner's rule of identifiers, counts and HTTP statuses,
// never bodies, headers or secrets. Runner receipts remain Claude 5's and
// root's; results here are Claude 4 lane evidence only.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../../../scripts/control-murage.ts";
import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE } from "../../../shared/memory.ts";
import type { AdapterArtifacts as MirroredAdapterArtifacts, AdapterRow, Api, B34Adapter, B34AdapterContext, Bot, Check, Dump, SetupVerify } from "./b34-adapter-types.ts";

/** One request the runner would have observed through ctx.send (with its thread) or ctx.dispatched (thread null). */
export type Observed = { threadId: string | null; content: string; system: string; memory: string[] };
export interface AdapterHarnessProbe {
  dataDir: string; observed: readonly Observed[];
  /** The harness's read-only profile connection. */
  db(): DatabaseSync;
  api(method: string, path: string, body?: unknown): Promise<Api>;
}
export interface AdapterHarnessOptions {
  /** The row the runner's matrix joins this export to (defaults to adapter.row); a mismatch is the runner's "Adapter unusable" outcome. */
  row?: AdapterRow;
  /** Test-only look at the live profile after the runner-equivalent checks, before the fixture closes. It never adds checks; a throw is rethrown after close. */
  inspect?: (probe: AdapterHarnessProbe) => void | Promise<void>;
}
export interface AdapterHarnessResult {
  checks: Array<{ name: string; status: "PASS" | "FAIL"; detail?: string }>;
  /** Artifacts that passed the mirrored strict validation, or null when run() threw or validation failed. */
  artifacts: MirroredAdapterArtifacts | null;
  observedCount: number;
  /** The fixture profile directory. It is removed when the fixture closes and is never persisted. */
  dataDir?: string;
  /** harness: diagnostics only. The Q14 lease snapshots taken around adapter.run (null for other rows or when unreadable); they never add checks. */
  lease?: LeaseWindow;
}

interface HarnessCtx {
  dataDir: string;
  /** harness: the one array every check lands in (the runner's receipt.checks). */
  checks: Check[];
  api(method: string, path: string, body?: unknown): Promise<Api>;
  action(body: Record<string, unknown>): Promise<Api>;
  setup(name: string | null, method: string, path: string, body: unknown, expected: number, verify?: SetupVerify): Promise<Api>;
  db(): DatabaseSync; closeDb(): void; restart(): Promise<void>;
  bot(name: string): Promise<Bot>;
  send(bot: Bot, text: string, hold?: boolean, threadId?: string): Promise<Dump>;
  settled(kind: "bot" | "channel", id: string): Promise<void>;
  until<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeout?: number): Promise<T>;
  check(name: string, ok: boolean, detail?: string): void;
}

/** Mirrors the runner's loadAdapter usability rule (lines 535-538); the runner writes a BLOCKED receipt with no checks. */
function unusable(adapter: B34Adapter, row: AdapterRow): string | null {
  const loaded = adapter as Partial<B34Adapter> | undefined;
  const launch = loaded?.launch;
  if (!loaded || typeof loaded.run !== "function" || loaded.row !== row
    || (launch !== undefined && (typeof launch !== "object" || launch === null || (launch.instrumentationSource !== undefined && typeof launch.instrumentationSource !== "string"))))
    return `Adapter unusable: export is not { row: "${row}", run(ctx), launch?: { instrumentationSource?: string } }; no behavioural attempt made.`;
  return null;
}

/** Runs one adapter the way the runner's isolated-server tier does and returns the checks the runner would record. */
export async function runAdapterLikeRunner(adapter: B34Adapter, opts: AdapterHarnessOptions = {}): Promise<AdapterHarnessResult> {
  const row = opts.row ?? adapter?.row;
  const blocked = unusable(adapter, row);
  if (blocked) throw new Error(blocked);
  const checks: Check[] = [], observed: Observed[] = [], result: HarnessRunResult = { artifacts: null, lease: { before: null, after: null } };
  const instrumentationSource = adapter.launch?.instrumentationSource;
  const fixture = instrumentationSource === undefined ? await launchVerificationServer() : await launchVerificationServer(process.env, undefined, { instrumentationSource });
  const dataDir = fixture.info.dataDir;
  let database: DatabaseSync | undefined, headers: Record<string, string> = {};
  async function refreshDesktopAuthority() {
    const response = await fetch(`${fixture.info.url}/api/desktop-secret`, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) throw new Error(`desktop fixture handshake HTTP ${response.status}`);
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("desktop fixture handshake invalid JSON"); }
    const secret = value && typeof value === "object" && "secret" in value ? value.secret : undefined;
    if (typeof secret !== "string" || !secret.trim()) throw new Error("desktop fixture handshake missing secret");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }
  const ctx: HarnessCtx = {
    dataDir, checks,
    async api(method, path, body) {
      const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(15_000) };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(`${fixture.info.url}${path}`, init);
      const text = await response.text();
      try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
    },
    action: body => ctx.api("POST", "/api/memory/action", body),
    // harness: read-only. The runner opens this verification connection writable
    // (foreign_keys=ON, busy_timeout=5000) but only runs SELECTs through it for adapters.
    db() {
      if (!database) { database = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true }); database.exec("PRAGMA busy_timeout=5000"); }
      return database;
    },
    closeDb() { database?.close(); database = undefined; },
    // harness: the runner also queues the pre-restart server log for copying into its receipt directory; nothing is copied here.
    async restart() { ctx.closeDb(); await fixture.restart(); await refreshDesktopAuthority(); },
    async setup(name, method, path, body, expected, verify) {
      const response = await ctx.api(method, path, body);
      const outcome = setupOutcome(name, method, path, response, expected, verify);
      if (outcome.check) checks.push(outcome.check);
      if (outcome.error) throw new Error(outcome.error);
      return response;
    },
    async bot(name) {
      const made = await ctx.setup(null, "POST", "/api/bots", { name, section: "B34Fixture" }, 201);
      return made.body.bot as Bot;
    },
    async send(bot, text, hold = false, threadId) {
      rmSync(fixture.fixtureDumpPath, { force: true });
      await ctx.setup(null, "POST", `/api/bots/${bot.id}/messages`, threadId === undefined ? { text } : { threadId, text }, 202);
      const dump = await ctx.until<Dump>(`fake provider accepted ${text}`, () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump; } catch { return undefined; } });
      if (!hold) await ctx.settled("bot", bot.id);
      return dump;
    },
    async settled(kind, id) {
      const settled = await runControlMurage(["wait", `--${kind}`, id, "--timeout", "30", "--url", fixture.info.url]) as { status: string };
      if (settled.status !== "settled") throw new Error(`${kind} ${id} did not settle`);
    },
    async until(label, read, timeout = 15_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(done => setTimeout(done, 50));
      }
    },
    check(name, ok, detail) { checks.push({ name, status: ok ? "PASS" : "FAIL", ...(detail === undefined ? {} : { detail }) }); },
  };
  let inspectFailed = false, inspectError: unknown;
  try {
    await refreshDesktopAuthority();
    await runAdapter(row, adapter, ctx, fixture, observed, result);
    if (opts.inspect) {
      try { await opts.inspect({ dataDir, observed, db: () => ctx.db(), api: ctx.api }); }
      catch (error) { inspectFailed = true; inspectError = error; }
    }
  } catch (error) {
    checks.push({ name: "scenario-completed", status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    ctx.closeDb();
    await fixture.close();
  }
  if (inspectFailed) throw inspectError;
  return { checks, artifacts: result.artifacts, observedCount: observed.length, dataDir, lease: result.lease };
}

/** Throws a compact list of failing check names and details; a run with no checks is the runner's BLOCKED outcome and also throws. */
export function expectAllPass(result: Pick<AdapterHarnessResult, "checks">): void {
  if (!result.checks.length) throw new Error("B34 harness recorded no checks (the runner would write a BLOCKED receipt)");
  const failed = result.checks.filter(check => check.status !== "PASS");
  if (failed.length) {
    throw new Error(`B34 harness checks failed (${failed.length}/${result.checks.length}): ${failed.map(check => check.detail === undefined ? check.name : `${check.name} [${check.detail.slice(0, 300)}]`).join("; ")}`);
  }
}

// harness: `ctx.checks` is the one array every ctx.check and named ctx.setup step
// pushes into (the runner's receipt.checks); `result` receives the artifacts the
// runner would store as receipt.sideEffects.artifacts, plus the lease window for diagnostics.
type HarnessRunResult = { artifacts: MirroredAdapterArtifacts | null; lease: LeaseWindow };
async function runAdapter(row: AdapterRow, adapter: B34Adapter, ctx: HarnessCtx, fixture: VerificationServer, observed: Observed[], result: HarnessRunResult) {
  // harness: the runner's receipt.inputs (module and instrumentation sha256) is receipt-only and not mirrored.
  const { checks } = ctx;
  let view: DatabaseSync | undefined;
  const closeView = () => { view?.close(); view = undefined; };
  const record = (dump: Dump, threadId: string | null) => {
    const content = String(dump.prompt?.message?.content ?? "");
    observed.push({ threadId, content, system: String(dump.systemPrompt ?? ""), memory: frame(content) });
    return dump;
  };
  const context: B34AdapterContext = {
    row, url: fixture.info.url, dataDir: ctx.dataDir, fixtureDumpPath: fixture.fixtureDumpPath, fixtureFinishGateDir: fixture.fixtureFinishGateDir,
    api: ctx.api, action: ctx.action, setup: ctx.setup, bot: ctx.bot, settled: ctx.settled, until: ctx.until, check: ctx.check,
    async send(bot, text, hold, threadId) { return record(await ctx.send(bot, text, hold, threadId), threadId ?? bot.threadId); },
    async dispatched(match, timeout = 30_000) {
      return record(await ctx.until<Dump>("fake provider received the adapter turn", () => {
        try { const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump; return JSON.stringify(dump.prompt ?? null).includes(match) ? dump : undefined; } catch { return undefined; }
      }, timeout), null);
    },
    async restart() { closeView(); await ctx.restart(); },
    db() { if (!view) { view = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); view.exec("PRAGMA busy_timeout=5000"); } return view; },
  };
  // Q14 lease evidence is snapshotted by the runner itself, immediately around adapter.run.
  const leaseSnapshot = () => {
    if (row !== "Q14") return null;
    let handle: DatabaseSync | undefined;
    try { handle = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); handle.exec("PRAGMA busy_timeout=5000"); return readQ14LeaseSnapshot(handle); }
    catch { return null; } finally { handle?.close(); }
  };
  const before = checks.length, leaseBefore = leaseSnapshot();
  result.lease = { before: leaseBefore, after: null };
  let value: unknown;
  try { value = await adapter.run(context); } finally { closeView(); }
  const leaseAfter = leaseSnapshot();
  result.lease = { before: leaseBefore, after: leaseAfter };
  ctx.check("adapter-recorded-behavioural-checks", checks.length > before, `${checks.length - before} adapter checks`);
  let artifacts: AdapterArtifacts;
  try { artifacts = validateAdapterArtifacts(row, value); }
  catch (error) { ctx.check("adapter-artifacts-valid", false, (error instanceof Error ? error.message : String(error)).slice(0, 300)); return; }
  ctx.check("adapter-artifacts-valid", true);
  // harness: the runner stores these as receipt.sideEffects.artifacts before verifying; the harness returns them.
  result.artifacts = artifacts;
  await verifyAdapterArtifacts(artifacts, ctx, observed, { before: leaseBefore, after: leaseAfter });
}

// ---------------------------------------------------------------------------
// BEGIN faithful copy of scripts/b34-receipt-matrix.ts (Claude 5 runner v3,
// Q14-CONTRACT-R6 PASS, sha256
// 69fbb75fef1c9aee6c928347f30c94965b654c1b9cfd95498831185251029c78):
//   149-165 identifier, revisionId, recordRef, distilledRecord, marked,
//           Q14_READBACK_FACTS, Q14ReadbackFact, readbackValue, apiReadback,
//           sqliteReadback, Q14_READBACK, Q14Readback
//   167-208 apiPathRefusal, jsonPointerRefusal, IDENT, SELECT_SHAPE, selectShape,
//           selectRefusal, readbackRefusal
//   209-277 ADAPTER_ARTIFACTS, routinePair, AdapterArtifacts, validateAdapterArtifacts
//   279-437 ReadbackOutcome, Q14Artifacts, Q14Variant, FactRule, INDEX,
//           SHARED_RULES, Q14_FACT_RULES, routineSiblingPointers, LEDGER_TABLE,
//           LEDGER_SELECT, ledgerBindingRefusal, readLedgerOutput, decodeToken,
//           scalarOutcome, pointedValue, resolveTaskPinRevision,
//           Q14ReadbackEvidence, compareQ14Readbacks
//   439-526 LeaseTally, Q14LeaseSnapshot, LEASE_CHARGES_MISSING, leaseKey, count,
//           readQ14LeaseSnapshot, Q14ReviewEvidence, compareQ14LeaseEvidence
//   570 sha256;  621-627 setupOutcome;  661-667 frame, has
//   1072-1151 LeaseWindow, verifyAdapterArtifacts;  1153-1200 verifyQ14Readbacks
// Deviations are marked "harness:". Runner receipts remain Claude 5's and root's;
// if the runner changes, this block must be re-copied from the new sha256.
// ---------------------------------------------------------------------------

// Adapter artifacts: identifiers and synthetic canaries only, never bodies, test
// reports or secrets. Strict objects refuse any extra field (such as copied test results).
const identifier = z.string().min(1).max(200), revisionId = z.string().min(1).max(200);
const recordRef = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const distilledRecord = z.object({ record: recordRef, sourceIds: z.array(identifier).min(1) }).strict();
const marked = z.object({ match: z.string().min(8).max(200), canary: z.string().min(6).max(120) }).strict();
// Q14 readback (contract v2): each entry names one product fact, how to read it
// and the value the adapter observed. The runner re-reads every entry itself.
export const Q14_READBACK_FACTS = ["current-revision", "published-revision-in-history", "earlier-task-pin", "next-task-pin", "post-rollback-task-pin", "rollback-history-entry", "budget-lease-charge"] as const;
export type Q14ReadbackFact = typeof Q14_READBACK_FACTS[number];
const readbackValue = z.string().min(1).max(400);
const apiReadback = z.object({ fact: z.enum(Q14_READBACK_FACTS), via: z.literal("api"), method: z.literal("GET"),
  path: z.string().max(400).refine(path => apiPathRefusal(path) === null, "API readback path refused"),
  pointer: z.string().max(400).refine(pointer => jsonPointerRefusal(pointer) === null, "API readback pointer refused"), observed: readbackValue }).strict();
const sqliteReadback = z.object({ fact: z.enum(Q14_READBACK_FACTS), via: z.literal("sqlite"),
  sql: z.string().max(1000).refine(sql => selectRefusal(sql) === null, "SQL readback refused"),
  params: z.array(z.union([z.string().max(400), z.number().int()])).max(8), column: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), observed: readbackValue }).strict();
export const Q14_READBACK = z.union([apiReadback, sqliteReadback]);
export type Q14Readback = z.infer<typeof Q14_READBACK>;

/** A GET route under /api/ only; never the desktop handshake or another credential route. */
export function apiPathRefusal(path: string): string | null {
  if (!path.startsWith("/api/")) return "path must start with /api/";
  if (/[\s#\\]|\.\.|\/\//.test(path)) return "path must be a plain route";
  if (/secret|token|credential|password|api-?key/i.test(path)) return "path may not address a credential route";
  return null;
}
export function jsonPointerRefusal(pointer: string): string | null {
  return /^(?:\/(?:[^~/]|~[01])*)+$/.test(pointer) ? null : "pointer must be an RFC 6901 JSON pointer with at least one token";
}
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const SELECT_SHAPE = new RegExp(`^select\\s+(?:(${IDENT}(?:\\.${IDENT})?)|json_extract\\(\\s*${IDENT}(?:\\.${IDENT})?\\s*,\\s*'\\$(?:\\.${IDENT}|\\[\\d{1,3}\\])+'\\s*\\))(?:\\s+as\\s+(${IDENT}))?\\s+from\\s+(${IDENT})(?:\\s+(?!where\\b)${IDENT})?(?:\\s+where\\s+([\\s\\S]+))?$`, "i");
/** One single-table SELECT whose value comes from a stored column, so no literal or parameter can become the observed value. */
function selectShape(sql: string): { output: string } | string {
  const text = sql.trim();
  if (/;|--|\/\*/.test(text)) return "SQL must be one statement without comments";
  if (/\b(?:pragma|attach|detach)\b/i.test(text)) return "SQL may not use PRAGMA, ATTACH or DETACH";
  const shape = SELECT_SHAPE.exec(text);
  if (!shape) return "SQL must be SELECT <column | json_extract(column,'$.path')> [AS name] FROM <table> [WHERE predicate]";
  if (/^(?:sqlite_|pragma_)/i.test(shape[3] ?? "")) return "SQL may not read SQLite internal tables";
  const predicate = (shape[4] ?? "").replace(/'(?:[^']|'')*'/g, "''");
  if (/\b(?:select|union|intersect|except|join|values|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b|[:@$][A-Za-z_]|\?\d/i.test(predicate))
    return "SQL predicate may not contain subqueries, joins, compound or write keywords, or named parameters";
  const output = shape[2] ?? shape[1]?.split(".").at(-1);
  return output ? { output } : "json_extract readback needs AS <name>";
}
export function selectRefusal(sql: string): string | null {
  const shape = selectShape(sql);
  return typeof shape === "string" ? shape : null;
}
/** Everything a readback must satisfy before it is trusted; the runner re-checks before executing it. */
export function readbackRefusal(entry: Q14Readback): string | null {
  if (entry.via === "api") {
    if (entry.method !== "GET") return "method must be GET";
    return apiPathRefusal(entry.path) ?? jsonPointerRefusal(entry.pointer) ?? (entry.path.includes(entry.observed) ? "observed value echoes the request path" : null);
  }
  const shape = selectShape(entry.sql);
  if (typeof shape === "string") return shape;
  if ((entry.sql.match(/\?/g) ?? []).length !== entry.params.length) return "parameter count differs from placeholders";
  if (entry.column !== shape.output) return "column is not the selected output name";
  return entry.params.some(param => String(param) === entry.observed) ? "observed value echoes a query parameter" : null;
}
export const ADAPTER_ARTIFACTS = {
  Q03: z.object({ row: z.literal("Q03"), extractorInstanceId: identifier, distilled: z.array(distilledRecord).min(1),
    correction: z.object({ superseded: recordRef, current: recordRef }).strict(),
    refused: z.array(z.object({ sourceId: identifier, outcome: z.enum(["failed", "cancelled", "interrupted"]) }).strict()).min(1),
    reuse: marked, staleWithheld: marked }).strict(),
  Q06: z.object({ row: z.literal("Q06"), readiness: z.object({ sourceId: identifier, sourceRevision: z.number().int().nonnegative(), indexed: recordRef }).strict(),
    distractorSourceIds: z.array(identifier).min(1), supplied: marked, isolation: z.array(z.object({ match: z.string().min(8).max(200) }).strict()).min(1) }).strict(),
  Q13: z.object({ row: z.literal("Q13"), extractorInstanceId: identifier,
    budget: z.object({ sourceId: identifier, deferredReason: z.literal("budget-exhausted"), withheldWhileExhausted: marked, recovered: distilledRecord }).strict() }).strict(),
  // Contract v3: one learned skill variant and one learned routine variant, each a complete v2 evaluation.
  Q14: z.object({ row: z.literal("Q14"), variants: z.array(z.object({ reviewId: z.string().regex(/^procedure-review:/).max(400), receiptId: identifier, evaluator: identifier,
    heldout: z.object({ corpusDigest: z.string().regex(/^[0-9a-f]{64}$/), untouched: z.literal(true), cases: z.number().int().positive(), baseline: z.number(), candidate: z.number(), regressions: z.literal(0) }).strict(),
    budget: z.object({ authorityReference: identifier, costKnown: z.literal(true), actualCostUsd: z.literal(0), leaseCharge: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict(),
    publication: z.object({ kind: z.enum(["skill", "routine"]), artifactId: identifier, baseRevision: revisionId, publishedRevision: revisionId }).strict(),
    earlierTask: z.object({ threadId: identifier, revisionAfterPublication: revisionId, revisionAfterRollback: revisionId }).strict(),
    nextTask: z.object({ threadId: identifier, revision: revisionId }).strict(),
    rollback: z.object({ fromRevision: revisionId, toRevision: revisionId, nextTask: z.object({ threadId: identifier, revision: revisionId }).strict() }).strict(),
    readback: z.array(Q14_READBACK).length(Q14_READBACK_FACTS.length) }).strict()).length(2) }).strict(),
};
/** A routine review revision is the JSON pair [instructionRevision, updatedAt] (procedure-review-host.ts routineBase). */
export function routinePair(value: string): [string, number] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || !parsed[0] || parsed[0].length > 200 || !Number.isSafeInteger(parsed[1]) || (parsed[1] as number) < 0) return null;
    return JSON.stringify(parsed) === value ? [parsed[0], parsed[1] as number] : null;
  } catch { return null; }
}
export type AdapterArtifacts = { [K in AdapterRow]: z.infer<typeof ADAPTER_ARTIFACTS[K]> }[AdapterRow];

/** Shape plus internal consistency; the runner separately cross-checks the live profile. */
export function validateAdapterArtifacts(row: AdapterRow, value: unknown): AdapterArtifacts {
  const schema: z.ZodType = ADAPTER_ARTIFACTS[row];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Adapter artifacts invalid: ${parsed.error.issues.map(issue => `${issue.path.map(String).join(".") || "root"} ${issue.code}`).join("; ").slice(0, 300)}`);
  const a = parsed.data as AdapterArtifacts;
  const rule = (ok: boolean, message: string) => { if (!ok) throw new Error(`Adapter artifacts invalid: ${message}`); };
  const same = (x: { id: string; version: number }, y: { id: string; version: number }) => x.id === y.id && x.version === y.version;
  if (a.row === "Q03") {
    rule(a.distilled.some(item => same(item.record, a.correction.current)), "current correction was not distilled from captured sources");
    rule(!same(a.correction.superseded, a.correction.current), "superseded and current correction are the same record version");
    rule(a.reuse.canary !== a.staleWithheld.canary, "reuse and stale canaries must differ");
    rule(!a.reuse.match.includes(a.reuse.canary), "reuse query carries the answer");
  } else if (a.row === "Q06") {
    rule(!a.distractorSourceIds.includes(a.readiness.sourceId), "distractor sources must differ from the intended source");
    rule(!a.supplied.match.includes(a.supplied.canary), "supplied query carries the answer");
  } else if (a.row === "Q13") {
    rule(a.budget.recovered.sourceIds.includes(a.budget.sourceId), "recovered learning must cite the deferred source");
  } else {
    rule(a.variants.map(item => item.publication.kind).sort().join(",") === "routine,skill", "Q14 needs exactly one skill variant and one routine variant");
    rule(a.variants[0]!.reviewId !== a.variants[1]!.reviewId && a.variants[0]!.receiptId !== a.variants[1]!.receiptId, "Q14 variants must come from separate reviews and receipts");
    for (const v of a.variants) {
      const at = (message: string) => `${v.publication.kind} variant: ${message}`;
      rule(v.heldout.candidate > v.heldout.baseline, at("held-out candidate must beat the baseline"));
      rule(v.publication.publishedRevision !== v.publication.baseRevision, at("publication must change the revision"));
      rule(v.earlierTask.revisionAfterPublication === v.publication.baseRevision && v.earlierTask.revisionAfterRollback === v.publication.baseRevision, at("earlier task version must stay at the base revision"));
      // A routine's runs share its one conversation; each run re-pins there.
      rule(v.nextTask.revision === v.publication.publishedRevision && (v.publication.kind === "routine" ? v.nextTask.threadId === v.earlierTask.threadId : v.nextTask.threadId !== v.earlierTask.threadId), at(v.publication.kind === "routine" ? "next run must use the published revision in the routine's conversation" : "next task must use the published revision in a new task"));
      rule(v.rollback.fromRevision === v.publication.publishedRevision && v.rollback.toRevision !== v.publication.publishedRevision
        && v.rollback.nextTask.revision === v.rollback.toRevision
        && (v.publication.kind === "routine" ? v.rollback.nextTask.threadId === v.earlierTask.threadId : ![v.earlierTask.threadId, v.nextTask.threadId].includes(v.rollback.nextTask.threadId)),
        at(v.publication.kind === "routine" ? "rollback must leave the published revision for the routine's next run" : "rollback must leave the published revision for a new task"));
      if (v.publication.kind === "routine") rule([v.publication.baseRevision, v.publication.publishedRevision, v.rollback.toRevision].every(value => routinePair(value) !== null)
        && routinePair(v.rollback.toRevision)![0] !== routinePair(v.publication.publishedRevision)![0], at("routine revisions must be distinct [instructionRevision, updatedAt] pairs"));
      rule(Q14_READBACK_FACTS.every(fact => v.readback.filter(entry => entry.fact === fact).length === 1), at("readback must claim each Q14 fact exactly once"));
      for (const [index, entry] of v.readback.entries()) {
        const refusal = readbackRefusal(entry);
        rule(refusal === null, at(`readback ${index} ${entry.fact} refused: ${refusal}`));
      }
    }
  }
  return a;
}

export type ReadbackOutcome = { ok: true; value: string } | { ok: false; reason: string };
type Q14Artifacts = Extract<AdapterArtifacts, { row: "Q14" }>;
export type Q14Variant = Q14Artifacts["variants"][number];
type FactRule = { field: string; value(v: Q14Variant): string; via: "api" | "sqlite"; path?: string; pointer?: RegExp; leaves?: string[]; within?: RegExp; ledger?: true; pinThread?(v: Q14Variant): string };
const INDEX = "(?:0|[1-9]\\d*)";
const SHARED_RULES: Record<"earlier-task-pin" | "next-task-pin" | "post-rollback-task-pin" | "budget-lease-charge", FactRule> = {
  "earlier-task-pin": { field: "earlierTask.revisionAfterRollback", value: v => v.earlierTask.revisionAfterRollback, via: "api", leaves: ["bundleId"], pinThread: v => v.earlierTask.threadId },
  "next-task-pin": { field: "nextTask.revision", value: v => v.nextTask.revision, via: "api", leaves: ["bundleId"], pinThread: v => v.nextTask.threadId },
  "post-rollback-task-pin": { field: "rollback.nextTask.revision", value: v => v.rollback.nextTask.revision, via: "api", leaves: ["bundleId"], pinThread: v => v.rollback.nextTask.threadId },
  "budget-lease-charge": { field: "budget.leaseCharge", value: v => v.budget.leaseCharge, via: "sqlite", ledger: true },
};
/** Concrete product store per fact and publication kind (contract v3): skill history route, routine store, task pin bundle ids, extraction ledger row. */
export const Q14_FACT_RULES: Record<"skill" | "routine", Record<Q14ReadbackFact, FactRule>> = {
  skill: {
    "current-revision": { field: "rollback.toRevision", value: v => v.rollback.toRevision, via: "api", leaves: ["currentRevision"] },
    "published-revision-in-history": { field: "publication.publishedRevision", value: v => v.publication.publishedRevision, via: "api", within: new RegExp(`/revisions/${INDEX}/(?:revision|id)$`) },
    "rollback-history-entry": { field: "publication.baseRevision", value: v => v.publication.baseRevision, via: "api", leaves: ["rollbackOf"] },
    ...SHARED_RULES,
  },
  // Routine revisions are [instructionRevision, updatedAt] pairs; the store, history and pins carry the instruction revision.
  routine: {
    "current-revision": { field: "rollback.toRevision", value: v => v.rollback.toRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionRevision$`) },
    "published-revision-in-history": { field: "publication.publishedRevision", value: v => v.publication.publishedRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionHistory/${INDEX}/id$`) },
    "rollback-history-entry": { field: "publication.baseRevision", value: v => v.publication.baseRevision, via: "api", path: "/api/routines", pointer: new RegExp(`^/routines/${INDEX}/instructionHistory/${INDEX}/rollbackOf$`) },
    ...SHARED_RULES,
    // A routine's runs share one conversation, whose task pin is the latest
    // run's; each earlier run keeps the bundle it pinned on its run record.
    "earlier-task-pin": { ...SHARED_RULES["earlier-task-pin"], path: "/api/routines", pointer: new RegExp(`^/runs/${INDEX}/procedureBundleId$`), leaves: undefined },
    "next-task-pin": { ...SHARED_RULES["next-task-pin"], path: "/api/routines", pointer: new RegExp(`^/runs/${INDEX}/procedureBundleId$`), leaves: undefined },
  },
};
/** Sibling scalars the runner reads from the same GET /api/routines body to bind a routine fact to its routine and history entry. */
export function routineSiblingPointers(fact: Q14ReadbackFact, pointer: string): Record<string, string> | null {
  const current = new RegExp(`^(/routines/${INDEX})/instructionRevision$`).exec(pointer);
  const history = new RegExp(`^(/routines/${INDEX})(/instructionHistory/${INDEX})/(?:id|rollbackOf)$`).exec(pointer);
  if (fact === "current-revision" && current) return { routineId: `${current[1]}/id`, updatedAt: `${current[1]}/updatedAt` };
  if (fact === "published-revision-in-history" && history) return { routineId: `${history[1]}/id`, author: `${history[1]}${history[2]}/author`, receiptId: `${history[1]}${history[2]}/evaluationReceiptId` };
  if (fact === "rollback-history-entry" && history) return { routineId: `${history[1]}/id`, author: `${history[1]}${history[2]}/author`, entryId: `${history[1]}${history[2]}/id` };
  return null;
}
export const LEDGER_TABLE = "memory_scope_bindings";
const LEDGER_SELECT = /^select\s+json_extract\(\s*intent\s*,\s*'\$\.output'\s*\)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+memory_scope_bindings\s+where\s+id\s*=\s*\?\s+and\s+subject_id\s*=\s*\?$/i;
/** The budget fact may name only the product's daily extraction ledger row and its output field. */
export function ledgerBindingRefusal(entry: Q14Readback): string | null {
  if (entry.via !== "sqlite") return "the ledger fact is read through sqlite";
  const shape = LEDGER_SELECT.exec(entry.sql.trim());
  if (!shape || shape[1] !== entry.column) return "SQL must be SELECT json_extract(intent,'$.output') AS <column> FROM memory_scope_bindings WHERE id=? AND subject_id=?";
  if (entry.params.length !== 2 || typeof entry.params[0] !== "string" || !/^extract-budget:\d{4}-\d{2}-\d{2}$/.test(entry.params[0]) || entry.params[1] !== "extract-budget")
    return "params must be [extract-budget:<UTC yyyy-mm-dd>, extract-budget]";
  return null;
}
/** The runner's own fixed ledger query; adapter SQL is never executed for the budget fact. */
export function readLedgerOutput(db: DatabaseSync, id: string): ReadbackOutcome {
  try {
    const rows = db.prepare("SELECT json_extract(intent,'$.output') AS output FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='extract-budget'").all(id);
    return rows.length === 1 ? scalarOutcome(rows[0]!.output) : { ok: false, reason: `${rows.length} ledger rows` };
  } catch { return { ok: false, reason: "ledger query refused by SQLite" }; }
}
const decodeToken = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
const scalarOutcome = (value: unknown): ReadbackOutcome => typeof value === "string" ? { ok: true, value }
  : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || typeof value === "bigint" ? { ok: true, value: String(value) }
  : { ok: false, reason: "value is missing or not a scalar" };
/** Resolves an RFC 6901 pointer to one scalar; nothing else from the body is kept. */
export function pointedValue(body: unknown, pointer: string): ReadbackOutcome {
  if (jsonPointerRefusal(pointer) !== null) return { ok: false, reason: "pointer refused" };
  let value: unknown = body;
  for (const token of pointer.slice(1).split("/").map(decodeToken)) {
    if (Array.isArray(value) ? !/^(?:0|[1-9]\d*)$/.test(token) : !(value !== null && typeof value === "object" && Object.hasOwn(value, token))) return { ok: false, reason: "pointer does not resolve" };
    value = (value as Record<string, unknown>)[token];
  }
  return scalarOutcome(value);
}
/** A task pin is a content-addressed bundle: its bytes must hash to the pinned id and name the task thread.
 * Skill pins yield imported[name=artifactId].revision; routine pins yield routine.instructionRevision for routine.id=artifactId. */
export function resolveTaskPinRevision(dataDir: string, threadId: string, bundleId: string, kind: "skill" | "routine", artifactId: string): ReadbackOutcome {
  const fail = (reason: string): ReadbackOutcome => ({ ok: false, reason });
  if (!/^[a-f0-9]{64}$/.test(bundleId)) return fail("pin readback is not a task bundle id");
  if (!/^[\w-]+$/.test(threadId)) return fail("task thread is not a plain identifier");
  const root = join(dataDir, "skill-state");
  let owners: string[];
  try { owners = readdirSync(root).filter(name => /^[\w-]+$/.test(name) && existsSync(join(root, name, "task-bundles", threadId, `${bundleId}.json`))); } catch { return fail("task bundle store unavailable"); }
  if (owners.length !== 1) return fail(`${owners.length} task bundles match the pin`);
  try {
    const bytes = readFileSync(join(root, owners[0]!, "task-bundles", threadId, `${bundleId}.json`));
    if (sha256(bytes) !== bundleId) return fail("task bundle bytes do not match the pinned id");
    const bundle = JSON.parse(bytes.toString("utf8")) as { schema?: unknown; botId?: unknown; threadId?: unknown; imported?: unknown; routine?: { id?: unknown; instructionRevision?: unknown } };
    if (bundle.schema !== 1 || bundle.botId !== owners[0] || bundle.threadId !== threadId) return fail("task bundle names another task");
    if (kind === "routine") {
      const routine = bundle.routine;
      return routine?.id === artifactId && typeof routine.instructionRevision === "string" && routine.instructionRevision ? { ok: true, value: routine.instructionRevision } : fail("task bundle pins no instruction revision for the routine");
    }
    const item = Array.isArray(bundle.imported) ? (bundle.imported as Array<{ name?: unknown; revision?: unknown }>).find(entry => entry?.name === artifactId) : undefined;
    return typeof item?.revision === "string" && item.revision ? { ok: true, value: item.revision } : fail("task bundle pins no revision for the artifact");
  } catch { return fail("task bundle unreadable"); }
}
export interface Q14ReadbackEvidence {
  /** The runner's own re-read of each claimed readback, index-aligned with variant.readback (the ledger fact holds the runner's ledger query). */
  reread: ReadbackOutcome[];
  /** For pin facts, the revision resolved from the pinned task bundle; null for every other fact. */
  pins: Array<ReadbackOutcome | null>;
  /** For routine history facts, sibling scalars from the same GET body (routineSiblingPointers); null otherwise. */
  siblings: Array<Record<string, ReadbackOutcome> | null>;
  /** The runner's fixed query of the bound extract-budget row, with the UTC days its lease snapshots were taken on. */
  ledger: { id: string; windowDays: string[]; value: ReadbackOutcome } | null;
  /** The runner's lookup of the evaluation session written inside the inference lease. */
  session: { reviewId: string; grantId: string } | null;
}
/** Pure comparison for one variant: re-read equals observed, and observed (or the pinned revision) equals the artifact field.
 * Routine fields compare on the instruction revision of their [instructionRevision, updatedAt] pair. */
export function compareQ14Readbacks(v: Q14Variant, evidence: Q14ReadbackEvidence): Check[] {
  const kind = v.publication.kind, rules = Q14_FACT_RULES[kind];
  return Q14_READBACK_FACTS.map(fact => {
    const rule = rules[fact], name = `q14-${kind}-readback-${fact}`;
    const fail = (detail: string): Check => ({ name, status: "FAIL", detail: detail.slice(0, 300) });
    const claims = [...v.readback.entries()].filter(([, entry]) => entry.fact === fact);
    if (claims.length !== 1) return fail(claims.length ? `${fact} claimed ${claims.length} times` : "missing claim");
    const [index, entry] = claims[0]!;
    const label = entry.via === "api" ? `api GET ${entry.path} ${entry.pointer}`
      : rule.ledger && ledgerBindingRefusal(entry) === null ? `sqlite ${LEDGER_TABLE} extract-budget $.output (column ${entry.column})` : `sqlite column ${entry.column}`;
    const refusal = readbackRefusal(entry);
    if (refusal !== null) return fail(`${label}: refused (${refusal})`);
    if (entry.via !== rule.via) return fail(`${label}: ${fact} must be read through ${rule.via}`);
    if (entry.via === "api") {
      const leaf = decodeToken(entry.pointer.slice(entry.pointer.lastIndexOf("/") + 1));
      if ((rule.path && entry.path !== rule.path) || (rule.pointer && !rule.pointer.test(entry.pointer)) || (rule.leaves && !rule.leaves.includes(leaf)) || (rule.within && !rule.within.test(entry.pointer)))
        return fail(`${label}: pointer does not address the ${kind} ${fact} field${rule.path ? ` under GET ${rule.path}` : ""}`);
    }
    if (rule.ledger) {
      const binding = ledgerBindingRefusal(entry), ledger = evidence.ledger;
      if (binding !== null) return fail(`${label}: not bound to the extract-budget ledger row in ${LEDGER_TABLE} (${binding})`);
      if (!ledger || entry.via !== "sqlite" || ledger.id !== entry.params[0]) return fail(`${label}: runner query of the ${LEDGER_TABLE} extract-budget row missing`);
      if (!ledger.windowDays.includes(ledger.id.slice("extract-budget:".length))) return fail(`${label}: ${ledger.id} is outside the scenario window days`);
      if (!ledger.value.ok) return fail(`${label}: runner ledger query of ${ledger.id} failed (${ledger.value.reason})`);
      if (ledger.value.value !== entry.observed) return fail(`${label}: runner ledger query of ${ledger.id} differs from observed`);
    } else {
      const reread = evidence.reread[index];
      if (!reread) return fail(`${label}: not re-read by the runner`);
      if (!reread.ok) return fail(`${label}: re-read failed (${reread.reason})`);
      if (reread.value !== entry.observed) return fail(`${label}: re-read differs from observed`);
    }
    let claimed = entry.observed;
    if (rule.pinThread) {
      const pin = evidence.pins[index];
      if (!pin?.ok) return fail(`${label}: pinned bundle ${pin ? pin.reason : "not resolved"}`);
      claimed = pin.value;
    }
    const pair = kind === "routine" && !rule.ledger ? routinePair(rule.value(v)) : null;
    if (kind === "routine" && !rule.ledger && !pair) return fail(`${label}: ${rule.field} is not an [instructionRevision, updatedAt] pair`);
    if (claimed !== (pair ? pair[0] : rule.value(v))) return fail(`${label}: ${rule.pinThread ? "pinned revision" : "observed"} differs from ${rule.field}${pair ? " instruction revision" : ""}`);
    if (kind === "routine" && entry.via === "api" && !rule.pinThread) {
      const near = evidence.siblings[index], sibling = (key: string) => { const item = near?.[key]; return item?.ok ? item.value : undefined; };
      const toRevision = routinePair(v.rollback.toRevision);
      if (sibling("routineId") !== v.publication.artifactId) return fail(`${label}: routine at the pointer is not publication.artifactId`);
      if (fact === "current-revision" && sibling("updatedAt") !== String(toRevision?.[1])) return fail(`${label}: routine updatedAt differs from rollback.toRevision`);
      if (fact === "published-revision-in-history" && (sibling("author") !== "learned" || sibling("receiptId") !== v.receiptId)) return fail(`${label}: history entry is not the learned revision with evaluationReceiptId receiptId`);
      if (fact === "rollback-history-entry" && (sibling("author") !== "rollback" || sibling("entryId") !== toRevision?.[0])) return fail(`${label}: history entry is not the rollback revision named by rollback.toRevision`);
    }
    const session = evidence.session;
    if (rule.ledger && (!session || session.reviewId !== v.reviewId || session.grantId !== v.budget.authorityReference))
      return fail(`${label}: evaluation session inside the inference lease ${session ? "names another review or authority" : "missing"}`);
    return { name, status: "PASS", detail: `${label}: ${rule.ledger ? "runner ledger query" : "re-read"} matches observed and ${rule.field}` };
  });
}

// Lease evidence (contract v3). The runner snapshots these product rows itself
// before adapter.run and after it returns; nothing here comes from the adapter.
export type LeaseTally = { calls: number; input: number; output: number };
export interface Q14LeaseSnapshot {
  /** UTC day (the product's extract-budget key) when the snapshot was taken. */
  day: string;
  /** extract-budget:<day> rows in memory_scope_bindings, by day. */
  ledger: Record<string, { input: number; output: number }>;
  /** memory_learning_config revision and the daily output limit that caps each reservation. */
  learning: { revision: number; outputLimit: number } | null;
  /** procedure-evaluation-session rows, by row id. */
  sessions: Record<string, { reviewId: string; grantId: string }>;
  /** procedure-evaluation-charges rows (proposed shared patch SP-Q14-LEASE-CHARGES), by row id. */
  charges: Record<string, { reviewId: string; grantId: string; evaluation: LeaseTally; reflection: LeaseTally; refusals: Record<string, number> }>;
}
export const LEASE_CHARGES_MISSING = "product records no per-callback lease charge or refusal: extract.ts withMemoryInferenceLease/reserveExtraction and procedure-evaluator.ts evaluate() persist nothing per lease.request (shared patch SP-Q14-LEASE-CHARGES)";
const leaseKey = (prefix: "procedure-evaluation-session" | "procedure-evaluation-charges", reviewId: string) => `${prefix}:${sha256(JSON.stringify(reviewId))}`;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
/** Reads the lease evidence rows through a read-only handle; unreadable tables yield empty sections. */
export function readQ14LeaseSnapshot(db: DatabaseSync, now = Date.now()): Q14LeaseSnapshot {
  const snapshot: Q14LeaseSnapshot = { day: new Date(now).toISOString().slice(0, 10), ledger: {}, learning: null, sessions: {}, charges: {} };
  const rows = (subject: string) => { try { return db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(subject); } catch { return []; } };
  const parse = (text: unknown): Record<string, any> | null => { try { const value = JSON.parse(String(text)); return value && typeof value === "object" ? value : null; } catch { return null; } };
  const tally = (value: any): LeaseTally | null => { const calls = count(value?.calls), input = count(value?.input), output = count(value?.output); return calls === null || input === null || output === null ? null : { calls, input, output }; };
  for (const row of rows("extract-budget")) {
    const day = /^extract-budget:(\d{4}-\d{2}-\d{2})$/.exec(String(row.id))?.[1], intent = parse(row.intent), input = count(intent?.input), output = count(intent?.output);
    if (day && input !== null && output !== null) snapshot.ledger[day] = { input, output };
  }
  try {
    const row = db.prepare("SELECT revision,settings FROM memory_learning_config WHERE id=1").get();
    const revision = count(row?.revision), outputLimit = count(parse(row?.settings)?.outputLimit);
    if (revision !== null && outputLimit !== null) snapshot.learning = { revision, outputLimit };
  } catch { snapshot.learning = null; }
  for (const row of rows("procedure-evaluation-session")) {
    const intent = parse(row.intent);
    if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string") snapshot.sessions[String(row.id)] = { reviewId: intent.reviewId, grantId: intent.grantId };
  }
  for (const row of rows("procedure-evaluation-charges")) {
    const intent = parse(row.intent), evaluation = tally(intent?.evaluation), reflection = tally(intent?.reflection);
    const refusals = Object.fromEntries(Object.entries(intent?.refusals ?? {}).flatMap(([reason, n]): Array<[string, number]> => /^[a-z-]{1,40}$/.test(reason) && count(n) !== null ? [[reason, n as number]] : []));
    if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string" && evaluation && reflection) snapshot.charges[String(row.id)] = { reviewId: intent.reviewId, grantId: intent.grantId, evaluation, reflection, refusals };
  }
  return snapshot;
}
/** What the runner read from each variant's stored review row. */
export interface Q14ReviewEvidence { kind: "skill" | "routine"; reviewId: string; authorityReference: string; complete: boolean; learningRevision: number | null; metricCalls: number | null; reflectionCalls: number | null }
/** Pure comparison of the runner's own before/after lease snapshots with the callbacks each stored receipt claims.
 * Each evaluation callback reserves min(2000, outputLimit) and each reflection min(8000, outputLimit) (procedure-evaluator.ts request). */
export function compareQ14LeaseEvidence(reviews: Q14ReviewEvidence[], before: Q14LeaseSnapshot | null, after: Q14LeaseSnapshot | null): Check[] {
  const check = (name: string, ok: boolean, detail: string): Check => ({ name, status: ok ? "PASS" : "FAIL", detail: detail.slice(0, 300) });
  const names = ["q14-lease-sessions-recorded-in-window", "q14-lease-ledger-delta-matches-receipt-callbacks", "q14-lease-charges-attributable-to-sessions", "q14-lease-budget-refusal-resume-no-double-charge"];
  if (!before || !after) return names.map(name => check(name, false, "runner lease snapshot unavailable before or after adapter.run"));
  const sessions = reviews.map(r => {
    const key = leaseKey("procedure-evaluation-session", r.reviewId), row = after.sessions[key];
    return { kind: r.kind, ok: !before.sessions[key] && row?.reviewId === r.reviewId && row.grantId === r.authorityReference, state: before.sessions[key] ? "existed before" : row ? (row.grantId === r.authorityReference ? "new" : "other authority") : "missing" };
  });
  const days = [...new Set([...Object.keys(before.ledger), ...Object.keys(after.ledger)])];
  const delta = days.reduce((sum, day) => ({ input: sum.input + (after.ledger[day]?.input ?? 0) - (before.ledger[day]?.input ?? 0), output: sum.output + (after.ledger[day]?.output ?? 0) - (before.ledger[day]?.output ?? 0) }), { input: 0, output: 0 });
  const limit = after.learning?.outputLimit, each = (r: Q14ReviewEvidence) => limit === undefined || r.metricCalls === null || r.reflectionCalls === null ? null
    : { evaluation: r.metricCalls * Math.min(2000, limit), reflection: r.reflectionCalls * Math.min(8000, limit) };
  const unknown = reviews.filter(r => r.metricCalls === null || r.reflectionCalls === null).map(r => r.kind);
  const fenced = limit === undefined ? reviews.map(r => r.kind) : reviews.filter(r => r.learningRevision === null || r.learningRevision !== after.learning?.revision).map(r => r.kind);
  const expected = reviews.reduce((sum, r) => sum + (each(r)?.evaluation ?? 0) + (each(r)?.reflection ?? 0), 0);
  const ledgerDetail = `${LEDGER_TABLE} extract-budget output delta ${delta.output}, input delta ${delta.input}; receipt callbacks expect output ${expected}`;
  const deltaReason = limit === undefined ? "; memory_learning_config unreadable" : unknown.length ? `; stored receipt accounting lacks callback counts (${unknown.join(",")})`
    : fenced.length ? `; learning settings changed after the ${fenced.join(",")} review snapshot` : "";
  const results = [
    check(names[0]!, sessions.every(item => item.ok), `${LEDGER_TABLE} procedure-evaluation-session: ${sessions.map(item => `${item.kind} ${item.state}`).join(", ")}`),
    check(names[1]!, !unknown.length && !fenced.length && expected > 0 && delta.output === expected && delta.input > 0, `${ledgerDetail}${deltaReason}`),
  ];
  if (!Object.keys(after.charges).length) return [...results, check(names[2]!, false, LEASE_CHARGES_MISSING), check(names[3]!, false, LEASE_CHARGES_MISSING)];
  const exact = (r: Q14ReviewEvidence) => {
    const key = leaseKey("procedure-evaluation-charges", r.reviewId), row = after.charges[key], want = each(r);
    return Boolean(row && want && !before.charges[key] && row.reviewId === r.reviewId && row.grantId === r.authorityReference
      && row.evaluation.calls === r.metricCalls && row.reflection.calls === r.reflectionCalls && row.evaluation.output === want.evaluation && row.reflection.output === want.reflection);
  };
  const charged = Object.entries(after.charges).reduce((sum, [key, row]) => {
    const prior = before.charges[key], was = (part: "evaluation" | "reflection", field: "input" | "output") => prior?.[part][field] ?? 0;
    return { input: sum.input + row.evaluation.input + row.reflection.input - was("evaluation", "input") - was("reflection", "input"), output: sum.output + row.evaluation.output + row.reflection.output - was("evaluation", "output") - was("reflection", "output") };
  }, { input: 0, output: 0 });
  const refused = reviews.filter(r => (after.charges[leaseKey("procedure-evaluation-charges", r.reviewId)]?.refusals["budget-exhausted"] ?? 0) > 0);
  return [...results,
    check(names[2]!, !unknown.length && !fenced.length && reviews.every(exact) && charged.input === delta.input && charged.output === delta.output,
      `procedure-evaluation-charges output ${charged.output}, input ${charged.input}; ${LEDGER_TABLE} extract-budget delta output ${delta.output}, input ${delta.input}; exact per-session callbacks: ${reviews.map(r => `${r.kind} ${exact(r) ? "yes" : "no"}`).join(", ")}`),
    check(names[3]!, refused.length > 0 && refused.every(r => r.complete && exact(r)),
      refused.length ? `budget-exhausted refusal recorded for ${refused.map(r => r.kind).join(",")}; resumed review complete with each callback charged once: ${refused.every(r => r.complete && exact(r)) ? "yes" : "no"}` : "no budget-exhausted refusal recorded for either evaluation session; the refusal-then-resume path was not exercised"),
  ];
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

// harness: export keywords only differ from the runner here (kept from the previous mirror): setupOutcome is
// module-private (runner exports it) and frame is exported (runner keeps it private). Bodies are identical.
/** Setup HTTP step outcome: the detail is only "METHOD path HTTP status" plus a caller note, never a body or header. */
function setupOutcome(name: string | null, method: string, path: string, response: Api, expected: number, verify?: SetupVerify): { check: Check | null; error: string | null } {
  const extra = verify?.(response);
  const detail = `${method} ${path} HTTP ${response.status}${extra?.note === undefined ? "" : `; ${extra.note}`}`;
  return { check: name === null ? null : { name, status: response.status === expected && (extra?.ok ?? true) ? "PASS" : "FAIL", detail },
    error: response.status === expected ? null : `setup failed: ${detail}` };
}

/** Lines inside the remembered-context frame of one request (runner frame()). */
export function frame(text: string | null | undefined): string[] {
  const start = `${MEMORY_REFERENCE_PREAMBLE}\n${MEMORY_REFERENCE_OPEN}\n`, at = text?.indexOf(start) ?? -1;
  if (!text || at < 0) return [];
  const end = text.indexOf(`\n${MEMORY_REFERENCE_CLOSE}`, at + start.length);
  return end < 0 ? [] : text.slice(at + start.length, end).split("\n");
}
const has = (lines: string[], canary: string) => lines.some(line => line.includes(canary));

/** Cross-checks adapter claims against the runner's own profile database and the requests it observed. */
type LeaseWindow = { before: Q14LeaseSnapshot | null; after: Q14LeaseSnapshot | null };
// harness: ctx is the harness's read-only view, api, check, dataDir and checks array instead of the runner Ctx.
type VerifyCtx = Pick<HarnessCtx, "db" | "api" | "check" | "dataDir" | "checks">;
async function verifyAdapterArtifacts(a: AdapterArtifacts, ctx: VerifyCtx, observed: Observed[], lease: LeaseWindow = { before: null, after: null }) {
  const db = ctx.db();
  const one = (sql: string, ...values: Array<string | number>) => db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  const all = (sql: string, ...values: Array<string | number>) => db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  // Captured by the server itself: not a runner pin, and its capture job completed.
  const captured = (sourceId: string) => {
    const source = one("SELECT thread_id,message_id FROM memory_sources WHERE id=? AND state='active'", sourceId);
    return source && !String(source.message_id ?? "").startsWith("fixture-message-")
      && one("SELECT 1 AS ok FROM memory_jobs WHERE source_id=? AND stage='capture' AND status='complete'", sourceId) ? source : undefined;
  };
  const distilled = (item: { record: { id: string; version: number }; sourceIds: string[] }) => {
    const record = one("SELECT kind,owner_pinned FROM memory_records WHERE id=? AND version=?", item.record.id, item.record.version);
    const evidence = new Set(all("SELECT DISTINCT source_id FROM memory_evidence WHERE record_id=? AND record_version=?", item.record.id, item.record.version).map(row => String(row.source_id)));
    return record?.kind === "fact" && Number(record.owner_pinned) === 0 && evidence.size === new Set(item.sourceIds).size && item.sourceIds.every(id => evidence.has(id) && captured(id) !== undefined);
  };
  const delivered = (claim: { match: string; canary: string }) => observed.find(item => item.threadId !== null && item.content.includes(claim.match) && has(item.memory, claim.canary));
  const withheld = (match: string, canary: string) => { const item = observed.find(entry => entry.content.includes(match)); return Boolean(item && !`${item.content}\n${item.system}`.includes(canary)); };
  const seeded = Number(one("SELECT count(*) AS n FROM memory_sources WHERE message_id LIKE 'fixture-message-%'")?.n ?? 0);
  if (a.row === "Q03" || a.row === "Q13") {
    const status = await ctx.api("GET", "/api/memory/status"), selected = status.body?.configuration?.extractorInstanceId;
    ctx.check("deterministic-extractor-selected", status.status === 200 && selected === a.extractorInstanceId && !String(selected).startsWith("@murage/flux-"), `GET /api/memory/status HTTP ${status.status}`);
  }
  if (a.row !== "Q14") ctx.check("no-runner-pinned-memory", seeded === 0, `${seeded} runner pins`);
  if (a.row === "Q03") {
    ctx.check("distillation-provenance", a.distilled.every(distilled), `${a.distilled.length} distilled records`);
    const { superseded, current } = a.correction;
    const old = one("SELECT state,valid_to FROM memory_records WHERE id=? AND version=?", superseded.id, superseded.version);
    const now = one("SELECT state,text,supersedes_id FROM memory_records WHERE id=? AND version=?", current.id, current.version);
    const lineage = Boolean(one("SELECT 1 AS ok FROM memory_derivations WHERE parent_id=? AND parent_version=? AND child_id=? AND child_version=?", superseded.id, superseded.version, current.id, current.version))
      || now?.supersedes_id === superseded.id;
    ctx.check("correction-supersedes-with-history", old?.state === "superseded" && old.valid_to !== null && now?.state === "active" && lineage, `${String(old?.state ?? "missing")} -> ${String(now?.state ?? "missing")}`);
    ctx.check("failure-outcomes-not-current-facts", a.refused.every(item => {
      const source = one("SELECT thread_id,turn_id,outcome FROM memory_sources WHERE id=?", item.sourceId);
      const settledAs = source?.outcome === item.outcome || Boolean(source?.turn_id
        && one("SELECT 1 AS ok FROM memory_sources WHERE kind='turn' AND thread_id=? AND turn_id=? AND outcome=?", String(source.thread_id), String(source.turn_id), item.outcome));
      return settledAs && !one("SELECT 1 AS ok FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND r.kind='fact' AND r.state='active'", item.sourceId);
    }), `${a.refused.length} refused sources`);
    const sourceThreads = new Set(all("SELECT DISTINCT s.thread_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?", current.id, current.version).map(row => String(row.thread_id)));
    const reuse = delivered(a.reuse);
    ctx.check("correction-reused-in-another-task", Boolean(reuse && reuse.threadId !== null && !sourceThreads.has(reuse.threadId) && String(now?.text ?? "").includes(a.reuse.canary)));
    ctx.check("superseded-fact-withheld", withheld(a.staleWithheld.match, a.staleWithheld.canary));
    // harness: runner receipt-only `ctx.receipt.deliveredMemory = reuse?.memory ?? []` not mirrored.
  } else if (a.row === "Q13") {
    ctx.check("distillation-provenance", distilled(a.budget.recovered), `${a.budget.recovered.sourceIds.length} sources`);
    ctx.check("exhausted-budget-withheld-learning", withheld(a.budget.withheldWhileExhausted.match, a.budget.withheldWhileExhausted.canary));
  } else if (a.row === "Q06") {
    const { sourceId, sourceRevision, indexed } = a.readiness;
    const source = captured(sourceId);
    const job = one("SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'", sourceId, sourceRevision);
    const chunk = one("SELECT r.kind,r.state FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.id=? AND r.version=? AND e.source_id=? AND e.source_revision=?", indexed.id, indexed.version, sourceId, sourceRevision);
    ctx.check("intended-source-processed-and-indexed", Boolean(source) && job?.status === "complete" && chunk?.kind === "source" && chunk.state === "active", `capture job ${String(job?.status ?? "missing")}; indexed ${String(chunk?.kind ?? "missing")}`);
    const createdAt = (id: string) => Number(one("SELECT v.created_at FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?", id)?.created_at ?? Number.NaN);
    ctx.check("unrelated-recent-context-present", a.distractorSourceIds.every(id => captured(id) !== undefined && createdAt(id) >= createdAt(sourceId)), `${a.distractorSourceIds.length} distractor sources`);
    const supplied = delivered(a.supplied);
    ctx.check("old-evidence-supplied-to-later-task", Boolean(supplied && source && supplied.threadId !== String(source.thread_id)));
    ctx.check("isolation-preserved", a.isolation.every(item => withheld(item.match, a.supplied.canary)), `${a.isolation.length} isolated requests`);
    // harness: runner receipt-only `ctx.receipt.deliveredMemory = supplied?.memory ?? []` not mirrored.
  } else {
    const reviews: Q14ReviewEvidence[] = [];
    for (const v of a.variants) {
      const kind = v.publication.kind;
      const intent = one("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-review'", v.reviewId);
      let review: any = null;
      try { review = intent ? JSON.parse(String(intent.intent)) : null; } catch { review = null; }
      const stored = review?.receipt, target = review?.snapshot?.target;
      const heldout = v.heldout;
      ctx.check(`q14-${kind}-evaluator-receipt-recorded-by-runtime`, review?.status === "complete" && stored?.id === v.receiptId && stored?.evaluator === v.evaluator && stored?.decision === "accepted"
        && (["corpusDigest", "untouched", "cases", "baseline", "candidate", "regressions"] as const).every(key => stored?.heldout?.[key] === heldout[key]), `review ${String(review?.status ?? "missing")}`);
      ctx.check(`q14-${kind}-budget-respected-at-known-zero-cost`, stored?.budgetRespected === true && stored?.cancelled === false
        && (stored?.accounting === undefined || (stored.accounting.costKnown === true && stored.accounting.actualCostUsd === 0)));
      ctx.check(`q14-${kind}-publication-target-matches-review`, target?.kind === v.publication.kind && target?.artifactId === v.publication.artifactId && target?.baseRevision === v.publication.baseRevision);
      reviews.push({ kind, reviewId: v.reviewId, authorityReference: v.budget.authorityReference, complete: review?.status === "complete" && stored?.id === v.receiptId,
        learningRevision: count(review?.snapshot?.learningRevision), metricCalls: count(stored?.accounting?.metricCalls), reflectionCalls: count(stored?.accounting?.reflectionCalls) });
    }
    await verifyQ14Readbacks(a, ctx, lease);
    // harness: runner `ctx.receipt.checks.push(...)`; the harness pushes into the same checks array ctx.check writes.
    ctx.checks.push(...compareQ14LeaseEvidence(reviews, lease.before, lease.after));
  }
}

/** Re-executes every Q14 readback after the adapter returned: API through the runner's desktop authority, SQL on a fresh read-only handle,
 * and the budget fact through the runner's own fixed extract-budget ledger query. */
async function verifyQ14Readbacks(a: Q14Artifacts, ctx: VerifyCtx, lease: LeaseWindow) {
  let view: DatabaseSync | undefined;
  try { view = new DatabaseSync(join(ctx.dataDir, "messages.db"), { readOnly: true }); view.exec("PRAGMA busy_timeout=5000"); } catch { view = undefined; }
  try {
    const windowDays = [...new Set([lease.before?.day, lease.after?.day].filter((day): day is string => typeof day === "string"))];
    for (const v of a.variants) {
      const rules = Q14_FACT_RULES[v.publication.kind];
      const reread: ReadbackOutcome[] = [], pins: Array<ReadbackOutcome | null> = [], siblings: Q14ReadbackEvidence["siblings"] = [];
      let ledger: Q14ReadbackEvidence["ledger"] = null;
      for (const entry of v.readback) {
        const rule = rules[entry.fact];
        let outcome: ReadbackOutcome, near: Record<string, ReadbackOutcome> | null = null;
        if (readbackRefusal(entry) !== null) outcome = { ok: false, reason: "refused" };
        else if (rule.ledger) {
          if (entry.via !== "sqlite" || ledgerBindingRefusal(entry) !== null) outcome = { ok: false, reason: "not bound to the extract-budget ledger" };
          else {
            const id = String(entry.params[0]);
            outcome = view ? readLedgerOutput(view, id) : { ok: false, reason: "read-only database unavailable" };
            ledger = { id, windowDays, value: outcome };
          }
        } else if (entry.via === "api") {
          const response = await ctx.api("GET", entry.path).catch(() => undefined);
          outcome = !response ? { ok: false, reason: "request failed" } : response.status === 200 ? pointedValue(response.body, entry.pointer) : { ok: false, reason: `HTTP ${response.status}` };
          const pointers = v.publication.kind === "routine" && response?.status === 200 ? routineSiblingPointers(entry.fact, entry.pointer) : null;
          if (pointers) near = Object.fromEntries(Object.entries(pointers).map(([key, pointer]): [string, ReadbackOutcome] => [key, pointedValue(response!.body, pointer)]));
        } else if (!view) outcome = { ok: false, reason: "read-only database unavailable" };
        else {
          try {
            const rows = view.prepare(entry.sql).all(...entry.params);
            outcome = rows.length === 1 ? scalarOutcome(rows[0]![entry.column]) : { ok: false, reason: `${rows.length} rows` };
          } catch { outcome = { ok: false, reason: "query refused by SQLite" }; }
        }
        reread.push(outcome); siblings.push(near);
        const thread = rule.pinThread?.(v);
        pins.push(thread === undefined ? null : outcome.ok ? resolveTaskPinRevision(ctx.dataDir, thread, outcome.value, v.publication.kind, v.publication.artifactId) : { ok: false, reason: "pin not re-read" });
      }
      let session: Q14ReadbackEvidence["session"] = null;
      try {
        const row = view?.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='procedure-evaluation-session'").get(leaseKey("procedure-evaluation-session", v.reviewId));
        const intent = row ? JSON.parse(String(row.intent)) as { reviewId?: unknown; grantId?: unknown } : null;
        if (typeof intent?.reviewId === "string" && typeof intent.grantId === "string") session = { reviewId: intent.reviewId, grantId: intent.grantId };
      } catch { session = null; }
      // harness: runner `ctx.receipt.checks.push(...)`; the harness pushes into the same checks array ctx.check writes.
      ctx.checks.push(...compareQ14Readbacks(v, { reread, pins, siblings, ledger, session }));
    }
  } finally { view?.close(); }
}
// ---------------------------------------------------------------------------
// END faithful copy of scripts/b34-receipt-matrix.ts (sha256 69fbb75f…9c78)
// ---------------------------------------------------------------------------

// harness: compile-time guard that the type-only mirror in b34-adapter-types.ts
// and the copied runner schemas describe the same artifacts in both directions.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ExpectTrue<T extends true> = T;
export type B34ArtifactMirrorMatchesRunnerSchemas = ExpectTrue<MutuallyAssignable<MirroredAdapterArtifacts, AdapterArtifacts>>;
