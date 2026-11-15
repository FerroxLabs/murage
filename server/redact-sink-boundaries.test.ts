// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// L5a slice 3B: actual serialized exits. No redactor mock or test-side masking.
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { expect, it } from "vitest";
import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { closeThreadLog } from "./harness/event-log.ts";
import { wireThread, type SeqStore } from "./transcript-page.ts";
import { ToolResults } from "./tool-results.ts";
import { insertMemoryRecord } from "./memory/record-write.ts";

const SECRET = "hunter2\nTAILSECRET";
const LABEL = `**password**: ${SECRET}`;
const RAW = "PRIVATE_EXECUTION_ONLY";
const UNKNOWN = "PRIVATE_UNKNOWN_KEY";
let next = 0;
function event(fields: Record<string, unknown>): RuntimeEvent {
  return { eventId: `event-${++next}`, provider: "fake", providerInstanceId: "fixture",
    threadId: `l5a-${next}`, createdAt: "2026-11-10T00:00:00.000Z", ...fields } as RuntimeEvent;
}

// PROVISIONAL INTERFACE: F4 names/signatures are frozen, but are absent on c12aaad93.
// Only the test adapter falls back to the base raw subscriber, so base produces
// a behavioral leak assertion (never a missing-import RED). Remove fallback
// after Wave 1B integration. It does not sanitize, fabricate output or skip tests.
type WireBus = EventBus & {
  subscribeAudience?: (listener: (emission: unknown) => void, options?: { durable?: boolean }) => () => void;
  subscribeExecution?: (listener: (event: RuntimeEvent) => void, options?: { durable?: boolean }) => () => void;
};
function audience(bus: EventBus, listener: (value: unknown) => void, durable = false) {
  const current = bus as WireBus;
  if (current.subscribeAudience) return current.subscribeAudience(listener, { durable });
  return (bus as unknown as { subscribe: (fn: (e: RuntimeEvent) => void, options: { durable: boolean }) => () => void })
    .subscribe(listener, { durable });
}
function execution(bus: EventBus, listener: (value: RuntimeEvent) => void) {
  const current = bus as WireBus;
  if (current.subscribeExecution) return current.subscribeExecution(listener, { durable: false });
  return (bus as unknown as { subscribe: (fn: (e: RuntimeEvent) => void, options: { durable: boolean }) => () => void })
    .subscribe(listener, { durable: false });
}
function safe(bytes: string) {
  for (const sentinel of ["hunter2", "TAILSECRET", RAW, UNKNOWN]) expect(bytes).not.toContain(sentinel);
}

const question = { id: "provider-question", question: LABEL, header: LABEL,
  options: [{ label: LABEL, description: LABEL }], multiSelect: true, allowOther: true, secret: false };
const permission = { type: "request.opened", requestType: "permission", requestId: "provider-request",
  tool: LABEL, summary: LABEL, choices: [LABEL], questions: [question], toolInput: LABEL, reason: LABEL,
  toolKind: LABEL, toolIdentity: { namespace: LABEL, name: LABEL, kind: LABEL },
  filePaths: [LABEL], toolResultDirs: [LABEL], folderTrust: { key: RAW, folder: LABEL, sources: [LABEL] },
  toolCall: { name: RAW, input: { original: RAW } }, execEnv: { ORIGINAL: RAW }, mcpMounts: [{ private: RAW }] };
// Every concrete (type,itemType/streamKind/requestType) row in M01–M29.
// These fixtures test unadmitted intake: absence of host authority must mask
// text even when a provider supplies familiar structural names or well-shaped IDs.
const MANIFEST = [
  ["M01", { type: "turn.diagnostic", category: "rate_limit", quietMs: 1 }],
  ["M02", { type: "session.started", sessionId: RAW, model: LABEL }],
  ["M03", { type: "turn.subtask", subtask: { id: RAW, label: LABEL, status: "running" }, subtasks: [{ id: RAW, label: LABEL, status: "done" }] }],
  ["M04", { type: "session.exited", reason: LABEL }],
  ["M05", { type: "turn.started" }],
  ["M06", { type: "turn.retrying", reason: LABEL, attempt: 1, delayMs: 0 }],
  ["M07", { type: "turn.completed", ok: true, stopReason: LABEL, denials: [LABEL], toolsUnavailable: [LABEL] }],
  ["M08", { type: "item.started", itemType: "tool", origin: "engine", title: LABEL, summary: LABEL, spoken: LABEL, input: { [LABEL]: LABEL }, toolKind: LABEL, toolIdentity: { name: LABEL, namespace: LABEL, kind: LABEL } }],
  ["M09", { type: "item.started", itemType: "reasoning", title: LABEL, summary: LABEL, input: { [LABEL]: LABEL }, toolKind: LABEL, toolIdentity: { name: LABEL, namespace: LABEL, kind: LABEL } }],
  ["M10", { type: "item.updated", itemType: "tool", tokens: 3 }],
  ["M11", { type: "item.updated", itemType: "reasoning", tokens: 3 }],
  ["M12", { type: "item.completed", itemType: "tool", ok: true, detail: LABEL, result: { [LABEL]: LABEL } }],
  ["M13", { type: "item.completed", itemType: "assistant_text", origin: "engine", text: LABEL }],
  ["M14", { type: "item.completed", itemType: "assistant_image", alt: LABEL, data: RAW }],
  ["M15", { type: "content.delta", streamKind: "assistant_text", delta: LABEL }],
  ["M16", { type: "content.delta", streamKind: "reasoning_text", delta: LABEL }],
  ["M17", { type: "content.reset", streamKind: "assistant_text" }],
  ["M18", { type: "content.reset", streamKind: "reasoning_text" }],
  ["M19", { type: "plan.updated", entries: [{ content: LABEL, status: "pending" }] }],
  ["M20", { type: "engine.commands", commands: [{ name: LABEL, description: LABEL, hint: LABEL, takesArguments: true }] }],
  ["M21", { type: "steer.confirmed", interjectionId: RAW }],
  ["M22", { type: "question.async", questions: [question] }],
  ["M23", permission],
  ["M24", { ...permission, requestType: "question" }],
  ["M25", { type: "request.resolved", requestId: RAW, behavior: "answer", source: "user", decidedBy: LABEL }],
  ["M26", { type: "thread.token-usage.updated", input: 1, output: 2 }],
  ["M27", { type: "turn.served-model", routed: LABEL, requested: LABEL }],
  ["M28", { type: "runtime.error", message: LABEL, details: LABEL, errorKind: LABEL, engineCode: LABEL, gatewayCode: LABEL, localFailureEngine: LABEL, providerError: { providerSaid: LABEL, providerTeam: LABEL }, diagnostic: { method: RAW } }],
  ["M29", { type: "unknown.provider.variant", [UNKNOWN]: SECRET }],
] as const;

// Compile-time coverage: adding a RuntimeEvent discriminator requires a row.
const VARIANTS = {
  "turn.diagnostic": true, "session.started": true, "turn.subtask": true, "session.exited": true,
  "turn.started": true, "turn.retrying": true, "turn.completed": true, "item.started": true,
  "item.updated": true, "item.completed": true, "content.delta": true, "content.reset": true,
  "plan.updated": true, "engine.commands": true, "steer.confirmed": true, "question.async": true,
  "request.opened": true, "request.resolved": true, "thread.token-usage.updated": true,
  "turn.served-model": true, "runtime.error": true,
} satisfies Record<RuntimeEvent["type"], true>;

it("manifest.exhaustive", () => {
  expect(MANIFEST.map(([id]) => id)).toEqual(Array.from({ length: 29 }, (_, n) => `M${String(n + 1).padStart(2, "0")}`));
  expect([...new Set(MANIFEST.slice(0, -1).map(([, row]) => row.type))].sort()).toEqual(Object.keys(VARIANTS).sort());
});

for (const [id, fields] of MANIFEST) {
  it(`manifest.${id}.serialized`, () => {
    const logs: string[] = [];
    const bus = new EventBus((_path, data) => { logs.push(String(data)); });
    const live: string[] = [], durable: string[] = [];
    const offLive = audience(bus, value => live.push(JSON.stringify(value)));
    const offDurable = audience(bus, value => durable.push(JSON.stringify(value)), true);
    const input = event({ ...fields, raw: { source: "fixture", payload: { original: RAW } }, [UNKNOWN]: SECRET });
    try {
      bus.publish(input);
      // No vacuous "safe" verdict when a broken subscriber emitted nothing.
      expect(live.length).toBeGreaterThan(0);
      expect(durable).toEqual(live);
      safe(JSON.stringify({ live, durable, logs }));
      // Reconnect/HTTP/SSE routing is tested by 1B/2B; this is actual bus JSON,
      // not a claim that formatting it here exercises those transports.
    } finally { offLive(); offDurable(); bus.detachAll(); }
  });
  it(`manifest.${id}.execution-unchanged`, () => {
    const bus = new EventBus(() => {});
    const input = event({ ...fields, raw: { source: "fixture", payload: { original: RAW } } });
    const original = structuredClone(input);
    const seen: RuntimeEvent[] = [];
    const off = execution(bus, value => seen.push(value));
    try {
      bus.publish(input);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(input);
      expect(seen[0]).toEqual(original);
      expect(input).toEqual(original);
    } finally { off(); bus.detachAll(); }
  });
}

it.each(["ordinary", "no-log", "closed-log", "live-only"])("serialized.bus-all-branches.%s", branch => {
  const logs: string[] = [];
  const bus = new EventBus((_path, data) => { logs.push(String(data)); });
  const input = event(branch === "live-only" ? { type: "content.delta", streamKind: "assistant_text", delta: LABEL }
    : { type: "item.completed", itemType: "assistant_text", origin: "engine", text: LABEL });
  if (branch === "no-log") bus.omitLog(() => true);
  if (branch === "closed-log") closeThreadLog(input.threadId);
  const live: unknown[] = [];
  const off = audience(bus, value => live.push(value));
  try {
    bus.publish(input);
    expect(live.length).toBeGreaterThan(0);
    if (branch !== "ordinary") expect(logs).toEqual([]);
    safe(JSON.stringify({ live, logs }));
  } finally { off(); bus.detachAll(); }
});

it("serialized.bus-warning", () => {
  const bus = new EventBus(() => { throw new Error(LABEL); });
  const originalError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => { captured.push(args.map(arg => arg instanceof Error ? arg.stack : arg)); };
  try {
    bus.publish(event({ type: "turn.started" }));
    expect(captured.length).toBeGreaterThan(0);
    safe(JSON.stringify(captured));
  } finally { console.error = originalError; bus.detachAll(); }
});

const seqStore: SeqStore = { threadNumbered: () => true, newestSeq: () => 7, messageSeq: () => 7 };
for (const field of ["message", "messages", "openCards"] as const) {
  for (const slim of [true, false]) for (const legacy of [true, false]) {
    it(`historical.${field}.slim-${slim}.legacy-${legacy}`, () => {
      // Seed an old row directly, never through append/patch's new sanitizer.
      const row = { id: "old-row", kind: "text", role: "bot", text: LABEL, seq: 7, parentId: "parent" };
      const before = structuredClone(row);
      const body = field === "message" ? { message: row } : { [field]: [row] };
      const out = wireThread(seqStore, "thread", body, { slim, legacy });
      expect(row).toEqual(before);
      expect(JSON.stringify(out)).toContain("old-row");
      expect(JSON.stringify(out)).toContain("parent");
      expect(out.newestSeq).toBe(legacy ? undefined : 7);
      safe(JSON.stringify(out));
    });
  }
}
it("historical.owner-and-storage-unchanged", () => {
  const owner = { id: "owner-row", kind: "text", role: "user", origin: "desktop", text: LABEL, seq: 7 };
  const copy = structuredClone(owner);
  const out = wireThread(seqStore, "thread", { message: owner });
  expect(out.message).toEqual(owner);
  expect(owner).toEqual(copy);
});

it("serialized.model-tool-result", () => {
  const results = new ToolResults(() => 1);
  const owner = { botId: "bot", threadId: "thread" };
  const saved = results.save(owner, `prefix\n${LABEL}\n${"later-secret ".repeat(20_000)}`);
  const pages = [];
  for (let offset = 0; ;) {
    const page = results.read(owner, saved.id, offset);
    expect(page).not.toBeNull();
    pages.push(page);
    if (!page || page.nextOffset >= page.length) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
  safe(JSON.stringify(pages));
  expect(JSON.stringify(pages)).not.toContain("later-secret");
  expect(results.read({ ...owner, threadId: "other" }, saved.id, 0)).toBeNull();
});

it("serialized.memory-record-write", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE memory_records(id,version,scopeId,kind,text,assertion,state,ownerPinned,validFrom,validTo,supersedesId,createdAt)");
    const row = { id: "memory", version: 1, scopeId: "scope", kind: "fact", text: LABEL,
      assertion: "owner-statement", state: "active" as const, validFrom: 1, createdAt: 1 };
    const original = structuredClone(row);
    insertMemoryRecord(db, row);
    const stored = db.prepare("SELECT * FROM memory_records").get();
    expect(stored).toMatchObject({ id: "memory", scopeId: "scope", assertion: "owner-statement" });
    expect(row).toEqual(original);
    safe(JSON.stringify(stored));
  } finally { db.close(); }
});

// Inventory is a review guard, not a substitute for any named output fixture.
const ROOT = new URL("..", import.meta.url);
function productionFiles(dir = new URL("server/", ROOT)): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".") || ["testing", "testdata", "node_modules"].includes(entry.name)) return [];
    const url = new URL(entry.name, dir);
    if (entry.isDirectory()) return productionFiles(new URL(`${entry.name}/`, dir));
    return entry.isFile() && /\.(ts|mjs|mts)$/.test(entry.name) && !/\.(test|bench|base-reference|legacy-reference)\./.test(entry.name)
      ? [url.pathname] : [];
  }).sort();
}
function calls(path: string, visit: (node: ts.CallExpression, file: ts.SourceFile) => void) {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  function walk(node: ts.Node) { if (ts.isCallExpression(node)) visit(node, file); ts.forEachChild(node, walk); }
  walk(file);
}

it("subscription.inventory", () => {
  const found: Record<string, number> = {};
  for (const path of productionFiles()) calls(path, node => {
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr)) return;
    if (expr.name.text !== "onEvent") return;
    const name = relative(ROOT.pathname, path).replaceAll("\\", "/");
    found[name] = (found[name] ?? 0) + 1;
  });
  expect(found).toEqual({
    // R3: hidden-session execution only; outward error.engineLine crosses S17.
    "server/drivers/cli-memory-learning.ts": 2,
    "server/channels/signal/process-host.ts": 1, // transport lifecycle; never a provider output subscriber
    "server/drivers/request-delivery.ts": 1, // native release receipt/lifecycle authority only
    "server/index.ts": 1, // subprocess delegation to a private handler, with channel output sanitized separately
    "server/harness/bus.ts": 1, // sole execution/audience intake
    "server/harness/instance-holds.ts": 1, // R3 lifecycle-only accounting
    "server/harness/memory-adapter.ts": 1, // execution session/context forwarding
  });
  const ambiguous: string[] = [];
  const typedExecutionIngress: string[] = [];
  for (const path of productionFiles()) calls(path, (node, file) => {
    const expr = node.expression;
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === "subscribe" &&
      /^(bus|presentedRequests)$/.test(expr.expression.getText(file))) {
      let owner: ts.Node | undefined = node;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      const typed = owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'installRequestIngress'
        && owner.parameters.some(parameter => parameter.name.getText(file) === 'bus' && parameter.type?.getText(file) === 'T.RequestIngress');
      if (typed && relative(ROOT.pathname, path) === 'server/decision/implementation.ts') { typedExecutionIngress.push('server/decision/implementation.ts:installRequestIngress'); return; }
      ambiguous.push(`${relative(ROOT.pathname, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
    }
  });
  expect(typedExecutionIngress).toEqual(["server/decision/implementation.ts:installRequestIngress"]);
  expect(ambiguous, "F4: every EventBus subscriber must choose execution or audience").toEqual([]);
});

// Sinks discovered beyond the design's original short inventory are named
// explicitly here. This classifies their source family; it does NOT claim
// that this inventory assertion supplies their missing output fixtures.
const SINK_FILES: Record<string, string> = {
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5: classify integrated sinks with real output coverage; no inventory exemption.
  "server/flux-memory-capture.ts": "S13 external capture; flux-memory-capture.test.ts serialized request body",
  "server/move-in-found.ts": "S04 imported roster names; move-in-found.test.ts credential-name exclusion",
  "server/memory/settings.ts": "S13 legacy inspect quotes; redact-output-boundaries.test.ts memory-inspect",
  "server/own-write-holds.ts": "S01 frozen writer preview and bounded result",
  "server/index.ts": "S02-S09,S17 route/fold/channel/console boundaries",
  "server/engine-commands.ts": "S04 scanned command labels; opaque execution handles",
  "server/gateway-busy-repeat.ts": "S17 gateway diagnostic presentation",
  "server/host-power.ts": "S17 bounded host capability notices",
  "server/procs.ts": "S17 subprocess diagnostic presentation",
  "server/redact.ts": "F7 shared implementation (not an output fixture)",
  "server/store.ts": "S01 stored bot display", "server/transcript-page.ts": "S02 historical copies",
  "server/inbox.ts": "S03 inbox", "server/routines.ts": "S03 routines",
  "server/tool-results.ts": "S05 model tool result", "server/tts/speech-source.ts": "S06 speech",
  "server/drivers/pi.ts": "S07 driver notices", "server/drivers/acp/core.ts": "S07 driver notices",
  "server/drivers/native.ts": "S10 native log", "server/artifacts.ts": "S12 artifact metadata",
  "server/memory/record-write.ts": "S13 records", "server/memory/capture.ts": "S13 capture",
  "server/memory/import.ts": "S13 import", "server/memory/consolidate.ts": "S13 consolidate",
  "server/memory/feedback.ts": "S14 feedback", "server/memory/pip-reflect.ts": "S14 reflection",
  "server/memory/review.ts": "S14 review", "server/memory/outcomes.ts": "S14 outcomes",
  "server/memory/authority.ts": "S15 authority", "server/memory/bring-in.ts": "S15 bring-in",
  "server/memory/reveal-capture.ts": "S15 reveal", "server/memory/identity.ts": "S15 identity",
  "server/auto-approve.ts": "S16 exact-grant execution policy", "server/done-when.ts": "S16 done-when policy",
  "server/engine-reply-check.ts": "S17 engine setup-check",
  "server/approval-text.ts": "S01 approval display", "server/approval-grant-request.ts": "S01 approval display",
  "server/routine-requests.ts": "S03 routine cards", "server/routine-detail-line.ts": "S03 routine details",
  "server/routine-permissions.ts": "S03 routine permission display", "server/loop-nudge.ts": "S04 notices",
  "server/refused-start.ts": "S04 refused-start notices", "server/feedback-relay.ts": "S04 feedback output",
  "server/project-memory-tools.ts": "S05 memory tool output", "server/working-context.ts": "S05 model context",
  "server/skills.ts": "S05 skill output", "server/browser-output-redaction.ts": "S05 browser tool output",
  "server/drivers/agents-result.ts": "S05 model tool output", "server/drivers/openai-chat-tools.ts": "S05 model tool output",
  "server/image-delivery.ts": "S05 image display", "server/image-generation.ts": "S05 image output",
  "server/image-operations.ts": "S05 image operation output",
  "server/drivers/muse-code.ts": "S07 driver output", "server/drivers/mcp-readiness.ts": "S07 driver notices",
  "server/drivers/codex-unsupported-calls.ts": "S07 driver notices", "server/drivers/lifecycle-diagnostic.ts": "S07 diagnostics",
};
it("redact-callsite.inventory", () => {
  const unclassified: string[] = [];
  let count = 0;
  for (const path of productionFiles()) calls(path, (node, file) => {
    const expression = node.expression;
    const name = ts.isIdentifier(expression) ? expression.text
      : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
    if (!/^(redactSecretsInText|redactSecretsForCard|redactSecretsForSink|sanitizeBotDisplayMessage)$/.test(name)) return;
    count++;
    const key = relative(ROOT.pathname, path).replaceAll("\\", "/");
    if (!SINK_FILES[key]) unclassified.push(`${key}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}:${name}`);
  });
  expect(count).toBeGreaterThan(50);
  expect(unclassified, "new redactor output needs a sink classification and actual output fixture").toEqual([]);
});
