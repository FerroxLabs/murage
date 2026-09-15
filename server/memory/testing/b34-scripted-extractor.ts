// B34 Q03/Q13 scripted deterministic extractor (Claude 4 lane test support).
//
// Loaded inside the isolated verification server by launch.instrumentationSource
// (scripts/control-murage.ts:320-324), never by the runner process: importing
// this module has no side effect; installB34ScriptedExtractor() does the work.
// It starts a node:http OpenAI-compatible endpoint on 127.0.0.1 (ephemeral
// port) and registers it as the loopback openai-compat instance "b34-extractor"
// in the profile config.json. The driver gives a loopback endpoint the
// placeholder key "local" (server/drivers/openai-compat.ts:26,110), so no
// credential exists anywhere; it is never @murage/flux-*. The preload re-runs
// on every restart (control-murage.ts:322-330) and rewrites the new port.
//
// Answers are fixture decisions, not model judgment: extraction proposes the
// frozen rule whose owner sentence occurs in the product-built source, and
// grounding supports only the frozen paraphrase (plus previousClaim for the
// correction). Distilled fact text carries synthetic canaries that never occur
// in any owner message, so a canary in a dispatched frame can only come from
// the product's own distil -> ground -> activate -> dispatch path.
//
// Every request is appended to <dataDir>/b34-extractor-calls.jsonl with its
// prompt family, the matched rule ids, the sha256 of the extraction source and
// the byte/token sizes the product reserves (extract.ts:72-88). No prompt or
// source body is written.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";

export const B34_EXTRACTOR_INSTANCE_ID = "b34-extractor";
export const B34_EXTRACTOR_MODEL = "b34-scripted-extractor";
export const B34_EXTRACTOR_LEDGER = "b34-extractor-calls.jsonl";
/** Opening words of the product's own system instructions (server/memory/extract.ts:19 and :14). */
export const B34_EXTRACTION_PREFIX = "Extract only potentially durable factual assertions";
export const B34_GROUNDING_PREFIX = "Independently judge whether the claim is entailed";
const ROUTE = "/b34/v1";
const MAX_REQUEST_BYTES = 262_144;
/** Ordinary extraction and grounding output cap (extract.ts:27). */
const MAX_OUTPUT_TOKENS = 2000;

/** Owner messages, questions and canaries. No canary occurs in any text a turn sends. */
export const B34_Q03 = Object.freeze({
  staleCanary: "B34_Q03_STALE_EURO_CANARY",
  currentCanary: "B34_Q03_CURRENT_DOLLAR_CANARY",
  factMessage: "Please bill all of my client invoices in euros.",
  temporaryMessage: "For this reply only, answer in three short bullet points.",
  correctionMessage: "Correction: bill my client invoices in US dollars from now on, not euros.",
  /** The fake CLI fails the turn after writing a fixed assistant text (server/testing/fake-claude-cli.ts:523-529). */
  failedTurnMessage: "Draft the supplier summary now. __fixture_fail_turn__",
  failedTurnReply: "fixture turn failed after writing",
  question: "Which currency should my next client invoice use?",
});
export const B34_Q13 = Object.freeze({
  canary: "B34_Q13_BANGKOK_CANARY",
  statement: "Please schedule my weekly reports for Bangkok morning time.",
  question: "Which timezone should my weekly reports use?",
  followUp: "Remind me which timezone my weekly reports follow.",
});

export type B34RuleId = "q03-fact" | "q03-temporary" | "q03-correction" | "q03-failed-claim" | "q13-fact";
export interface B34ScriptRule {
  id: B34RuleId;
  /** Exact sentence that must occur in the extraction source. */
  trigger: string;
  /** Distilled candidate text returned for it. */
  text: string;
  claimType: "owner-statement" | "observation" | "inference";
  subject?: string; predicate?: string; update?: true;
  /** Correction rules are supported only when previousClaim is this rule's text. */
  groundsAgainst?: B34RuleId;
  /** The fixture decision this rule encodes, stated for honest labelling. */
  decision: string;
}

export const B34_SCRIPT: readonly B34ScriptRule[] = Object.freeze([
  { id: "q03-fact", trigger: B34_Q03.factMessage, text: `Client invoice currency for the owner: euros (ledger tag ${B34_Q03.staleCanary}).`,
    claimType: "owner-statement", subject: "owner", predicate: "invoice-currency", decision: "grounded paraphrase of an owner statement" },
  { id: "q03-temporary", trigger: B34_Q03.temporaryMessage, text: B34_Q03.temporaryMessage,
    claimType: "inference", decision: "fixture classification: a one-reply instruction is proposed only as an inference" },
  { id: "q03-correction", trigger: B34_Q03.correctionMessage, text: `Client invoice currency for the owner: US dollars (ledger tag ${B34_Q03.currentCanary}).`,
    claimType: "owner-statement", subject: "owner", predicate: "invoice-currency", update: true, groundsAgainst: "q03-fact", decision: "grounded owner correction of the same subject and property" },
  { id: "q03-failed-claim", trigger: B34_Q03.failedTurnReply, text: B34_Q03.failedTurnReply,
    claimType: "observation", decision: "fixture proposes the failed turn's assistant text as an observation" },
  { id: "q13-fact", trigger: B34_Q13.statement, text: `Weekly report timezone for the owner: Bangkok morning time (ledger tag ${B34_Q13.canary}).`,
    claimType: "owner-statement", subject: "owner", predicate: "report-timezone", decision: "grounded paraphrase of an owner statement" },
] satisfies B34ScriptRule[]);

export interface B34Candidate { text: string; quote: string; startByte: number; endByte: number; claimType: B34ScriptRule["claimType"]; subject?: string; predicate?: string; update?: boolean }

/** The candidates for one product-built extraction source (candidate shape: extract.ts:8, exact byte spans: extract.ts:111-115). */
export function b34ScriptedExtraction(source: string): { candidates: B34Candidate[]; rules: B34RuleId[] } {
  const candidates: B34Candidate[] = [], rules: B34RuleId[] = [];
  for (const rule of B34_SCRIPT) {
    const at = source.indexOf(rule.trigger);
    if (at < 0) continue;
    const startByte = Buffer.byteLength(source.slice(0, at));
    candidates.push({ text: rule.text, quote: rule.trigger, startByte, endByte: startByte + Buffer.byteLength(rule.trigger), claimType: rule.claimType,
      ...(rule.subject && rule.predicate ? { subject: rule.subject, predicate: rule.predicate } : {}), ...(rule.update ? { update: true } : {}) });
    rules.push(rule.id);
  }
  return { candidates, rules };
}

/** The verdict for one product-built grounding input (MemoryGroundingInput, extract.ts:9). */
export function b34ScriptedGrounding(input: unknown): { supported: boolean; rule: B34RuleId | null; previousClaim: boolean } {
  const claim = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rule = B34_SCRIPT.find(item => item.text === claim.text && item.trigger === claim.quote) ?? null;
  const previousClaim = typeof claim.previousClaim === "string";
  const expected = rule?.groundsAgainst ? B34_SCRIPT.find(item => item.id === rule.groundsAgainst)?.text : undefined;
  const supported = Boolean(rule && rule.claimType === "owner-statement" && rule.text !== rule.trigger && claim.speaker === "owner" && claim.purpose === undefined
    && (expected === undefined ? !previousClaim : claim.previousClaim === expected));
  return { supported, rule: rule?.id ?? null, previousClaim };
}

export interface B34LedgerEntry {
  at: number; pid: number;
  family: "install" | "models" | "extract" | "ground" | "refused";
  rules: string[];
  sourceSha256?: string; supported?: boolean; previousClaim?: boolean;
  inputBytes?: number; maxTokens?: number; reason?: string;
}
export const b34Sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Complete ledger lines only; a line still being appended is skipped. */
export function readB34ExtractorLedger(dataDir: string): B34LedgerEntry[] {
  let raw: string;
  try { raw = readFileSync(join(dataDir, B34_EXTRACTOR_LEDGER), "utf8"); } catch { return []; }
  const entries: B34LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line) as B34LedgerEntry); } catch { /* partial trailing line */ }
  }
  return entries;
}

let installed: Promise<{ port: number }> | undefined;
/** Preload entry: refuses to run outside an isolated verification profile. */
export function installB34ScriptedExtractor(): Promise<{ port: number }> {
  installed ??= install();
  return installed;
}

async function install(): Promise<{ port: number }> {
  const dataDir = process.env.MURAGE_DATA_DIR;
  // control-murage.ts:272 names the profile murage-verify-data-*, and :320-321 writes the instrumentation file into it.
  if (!dataDir || !basename(dataDir).startsWith("murage-verify-data-") || !existsSync(join(dataDir, ".verification-instrumentation.mjs")))
    throw new Error("B34 scripted extractor runs only inside an isolated verification profile");
  const ledger = join(dataDir, B34_EXTRACTOR_LEDGER);
  const record = (entry: Omit<B34LedgerEntry, "at" | "pid">) => appendFileSync(ledger, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`, { mode: 0o600 });
  const server = createServer((request, response) => {
    handle(request, response, record).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  const file = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as { instances?: Record<string, unknown> };
  config.instances = { ...config.instances, [B34_EXTRACTOR_INSTANCE_ID]: {
    driver: "openai-compat", displayName: "B34 scripted extractor",
    config: { url: `http://127.0.0.1:${port}${ROUTE}`, model: B34_EXTRACTOR_MODEL },
  } };
  const temporary = `${file}.b34-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  record({ family: "install", rules: [] });
  return { port };
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0, over = false;
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_REQUEST_BYTES) over = true; else parts.push(chunk); });
    request.on("end", () => resolve(over ? null : Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

function reply(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  response.end(text);
}

/** Response shape the product accepts: exactly one choice, stop, no tool calls (extract.ts:49-51). */
function completion(response: ServerResponse, content: string) {
  reply(response, 200, { id: `b34-${Date.now()}`, object: "chat.completion", model: B34_EXTRACTOR_MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });
}

async function handle(request: IncomingMessage, response: ServerResponse, record: (entry: Omit<B34LedgerEntry, "at" | "pid">) => void) {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const refuse = async (status: number, reason: string) => { record({ family: "refused", rules: [], reason }); reply(response, status, { error: reason }); };
  if (request.method === "GET" && path === `${ROUTE}/models`) {
    request.resume();
    record({ family: "models", rules: [] });
    return reply(response, 200, { object: "list", data: [{ id: B34_EXTRACTOR_MODEL, object: "model" }] });
  }
  if (request.method !== "POST" || path !== `${ROUTE}/chat/completions`) { request.resume(); return refuse(404, "route"); }
  const raw = await readBody(request);
  if (raw === null) return refuse(413, "body-limit");
  if (request.headers.authorization !== "Bearer local") return refuse(401, "not-loopback-placeholder");
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return refuse(400, "invalid-json"); }
  const messages = body.messages;
  if (body.model !== B34_EXTRACTOR_MODEL || body.stream !== false || body.tools !== undefined || !Array.isArray(messages) || messages.length !== 2
    || messages[0]?.role !== "system" || typeof messages[0]?.content !== "string" || messages[1]?.role !== "user" || typeof messages[1]?.content !== "string"
    || !Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) < 1 || Number(body.max_tokens) > MAX_OUTPUT_TOKENS) return refuse(400, "request-shape");
  const system = String(messages[0].content), user = String(messages[1].content);
  const sizes = { inputBytes: Buffer.byteLength(JSON.stringify(messages)), maxTokens: Number(body.max_tokens) };
  if (system.startsWith(B34_EXTRACTION_PREFIX)) {
    let source: unknown;
    try { source = (JSON.parse(user) as { source?: unknown }).source; } catch { source = undefined; }
    if (typeof source !== "string") return refuse(400, "extraction-source");
    const { candidates, rules } = b34ScriptedExtraction(source);
    record({ family: "extract", rules, sourceSha256: b34Sha256(source), ...sizes });
    return completion(response, JSON.stringify(candidates));
  }
  if (system.startsWith(B34_GROUNDING_PREFIX)) {
    let input: unknown;
    try { input = JSON.parse(user); } catch { return refuse(400, "grounding-input"); }
    const verdict = b34ScriptedGrounding(input);
    record({ family: "ground", rules: verdict.rule ? [verdict.rule] : [], supported: verdict.supported, previousClaim: verdict.previousClaim, ...sizes });
    return completion(response, JSON.stringify({ supported: verdict.supported }));
  }
  return refuse(400, "prompt-family");
}
