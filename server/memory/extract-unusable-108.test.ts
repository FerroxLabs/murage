import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { extractCandidates, memoryExtractionMessages, reportMemoryUsage, requestMemoryExtraction, type TextOnlyExtractor } from "./extract.ts";
import { EXTRACTION_FAILURE_REASONS, EXTRACTION_SUMMARY_MS, extractionOutcomes } from "./extraction-outcomes.ts";
import { resolveLearningConnection, resolveMemoryExtractor } from "./extractor-connections.ts";

// server/testing/setup.ts supplies a disposable home; all transport replies are fake.
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  extractionOutcomes.clear();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected fetch"); }));
});
afterEach(() => {
  extractionOutcomes.clear(); closeDatabase();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const source = "PRIVATE_SOURCE_SENTINEL";
const signal = () => new AbortController().signal;
const fake = (reply: () => string | Promise<string>, id = "fixture", model = "flux-fast") => Object.assign(vi.fn(async () => {
  reportMemoryUsage({ prompt_tokens: 10, completion_tokens: 5 });
  return reply();
}), { learningConnection: id, learningModel: () => model });
const run = (extractor: TextOnlyExtractor) => extractCandidates(source, extractor, signal());
const envelope = (content: unknown = "[]", extra: Record<string, unknown> = {}) => ({
  usage: { prompt_tokens: 10, completion_tokens: 2000 },
  choices: [{ finish_reason: "stop", message: { content }, ...extra }],
});
function http(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetcher);
  const extractor: TextOnlyExtractor = (text, maximum, abort, dispatch) => requestMemoryExtraction(
    { url: "https://fixture.invalid/v1", apiKey: "PRIVATE_KEY_SENTINEL", model: "flux-fast" }, text, maximum, abort, dispatch?.messages,
  );
  extractor.learningConnection = "@murage/flux-fast"; extractor.learningModel = () => "flux-fast";
  return { extractor, fetcher };
}
function expectReason(reason: string) {
  expect(console.warn).toHaveBeenLastCalledWith(expect.stringContaining(`reason=${reason} `));
  const logs = JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls]);
  for (const secret of [source, "PRIVATE_REPLY_SENTINEL", "PRIVATE_KEY_SENTINEL", "PRIVATE_ERROR_SENTINEL"]) expect(logs).not.toContain(secret);
}

it.each([
  ["empty-reply", "   "], ["not-json", "PRIVATE_REPLY_SENTINEL"],
  ["schema-mismatch", '{"PRIVATE_REPLY_SENTINEL":true}'],
  ["schema-mismatch", '[{"text":"PRIVATE_REPLY_SENTINEL"}]'],
] as const)("classifies a fake text extractor's %s without logging content", async (reason, reply) => {
  expect(await run(fake(() => reply))).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  expectReason(reason);
});

it.each([
  ["empty-reply", ""], ["empty-reply", envelope(null)], ["empty-reply", envelope("  ")],
  ["not-json", "PRIVATE_REPLY_SENTINEL"], ["schema-mismatch", { choices: [] }],
  ["schema-mismatch", envelope("[]", { message: { content: "[]", tool_calls: [{}] } })],
  ["refusal", envelope(null, { message: { content: null, refusal: "PRIVATE_REPLY_SENTINEL" } })],
  ["refusal", envelope(null, { finish_reason: "content_filter" })],
] as const)("classifies HTTP %s before losing envelope metadata", async (reason, reply) => {
  expect(await run(http(reply).extractor)).toMatchObject({ status: "deferred" });
  expectReason(reason);
});

it.each(["length", "max_tokens"])("reports finish_reason=%s as cut-off even with null or otherwise valid content", async finish => {
  for (const content of [null, "[]", '[{"text":"PRIVATE_REPLY_SENTINEL"']) {
    expect(await run(http(envelope(content, { finish_reason: finish })).extractor)).toMatchObject({ status: "deferred" });
    expectReason("cut-off");
  }
  // Paid cut-off replies still settle the provider's usage, once per call.
  const spend = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'learning-spend:%'").get()!;
  expect(JSON.parse(String(spend.intent))).toMatchObject({ input: 30, output: 6000 });
});

it.each(["choice", "top-level"])("detects stop_reason=max_tokens at %s", async where => {
  const body = where === "choice" ? envelope(null, { stop_reason: "max_tokens" }) : { ...envelope(null), stop_reason: "max_tokens" };
  await run(http(body).extractor); expectReason("cut-off");
});

it.each([401, 403, 429, 500])("classifies HTTP status %s without logging the response body", async status => {
  await run(http("PRIVATE_REPLY_SENTINEL", status).extractor);
  expectReason(status === 401 || status === 403 ? "refusal" : "transport-error");
});

it("classifies transport exceptions and never prints an arbitrary Error message or name", async () => {
  const error = new Error("PRIVATE_ERROR_SENTINEL"); error.name = "PRIVATE_REPLY_SENTINEL";
  vi.stubGlobal("fetch", vi.fn(async () => { throw error; }));
  const extractor: TextOnlyExtractor = (text, maximum, abort) => requestMemoryExtraction({ url: "https://fixture.invalid", apiKey: "fake", model: "fake" }, text, maximum, abort);
  await run(extractor); expectReason("transport-error");
});

it("reports transport failures without opening reply backoff", async () => {
  const extractor = fake(() => { throw new Error("provider down"); });
  for (let i = 0; i < 7; i++) {
    // The sixth immediate attempt proves no reply backoff; the seventh needs a new six-call budget window.
    if (i === 6) vi.advanceTimersByTime(60_000);
    expect(await run(extractor)).toMatchObject({ reason: "extraction-incomplete" });
  }
  expect(extractor).toHaveBeenCalledTimes(7);
  vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS - 60_000);
  expect(console.info).toHaveBeenLastCalledWith(expect.stringContaining("transport-error=7"));
  expect(console.info).toHaveBeenLastCalledWith(expect.stringContaining("consecutive=0 backoff_ms=0 retry_in_ms=0"));
});

it.each([0, 1])("omits expired retryAfter on transport failure %s ms after backoff expires", async elapsed => {
  let transportFailure = false;
  const extractor = fake(() => {
    if (transportFailure) throw new Error("provider down");
    return "PRIVATE_REPLY_SENTINEL";
  });
  for (let i = 0; i < 5; i++) await run(extractor);
  const deadline = Date.now() + 60_000;
  expect(await run(extractor)).toMatchObject({ reason: "extractor-backoff", retryAfter: deadline });
  vi.advanceTimersByTime(60_000 + elapsed);
  transportFailure = true;
  expect(await run(extractor)).toMatchObject({
    status: "deferred", reason: "extraction-incomplete", retryAfter: undefined,
  });
  expect(extractor).toHaveBeenCalledTimes(6);
  expectReason("transport-error");
});

it("backs off after five failures, doubles to one hour, skips reservations, and resets after success", async () => {
  let reply = "PRIVATE_REPLY_SENTINEL";
  const extractor = fake(() => reply), charged = vi.fn();
  const attempt = () => extractCandidates(source, extractor, signal(), undefined, charged);
  for (let i = 0; i < 5; i++) expect(await attempt()).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  expect(charged).toHaveBeenCalledTimes(5);
  let calls = 5;
  for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]) {
    const deadline = Date.now() + delay;
    expect(await attempt()).toMatchObject({ reason: "extractor-backoff", retryAfter: deadline });
    vi.advanceTimersByTime(delay - 1);
    expect(await attempt()).toMatchObject({ reason: "extractor-backoff", retryAfter: deadline });
    expect(extractor).toHaveBeenCalledTimes(calls); expect(charged).toHaveBeenCalledTimes(calls);
    vi.advanceTimersByTime(1);
    expect(await attempt()).toMatchObject({ reason: "extraction-incomplete" }); calls++;
  }
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("backoff_ms=3600000"));
  vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
  reply = "[]"; expect(await attempt()).toMatchObject({ status: "complete", candidates: [] });
  reply = "bad"; expect(await attempt()).toMatchObject({ reason: "extraction-incomplete" });
  expect(await attempt()).toMatchObject({ reason: "extraction-incomplete" }); // first failure after success did not re-open backoff
  vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
  expect(console.info).toHaveBeenLastCalledWith(expect.stringContaining("consecutive=2 backoff_ms=0 retry_in_ms=0"));
});

it("keeps backoff across fresh resolver closures and isolates other models and extractors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(envelope("bad")))));
  const resolve = () => resolveLearningConnection({ selected: null, instances: [], readKey: () => "fake", defaultOn: true }).extractor!;
  for (let i = 0; i < 5; i++) await run(resolve());
  expect(await run(resolve())).toMatchObject({ reason: "extractor-backoff" });
  expect(await run(resolveMemoryExtractor("@murage/flux-fast", [], () => "fake")!)).toMatchObject({ reason: "extractor-backoff" });
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(await run(fake(() => "[]", "@murage/flux-fast", "another-model"))).toMatchObject({ status: "complete" });
  vi.advanceTimersByTime(60_000);
  expect(await run(fake(() => "[]", "another-extractor", "flux-fast"))).toMatchObject({ status: "complete" });
});

it("logs one hourly summary per pair, including successes, each failure reason and deferred backoff", async () => {
  const cases = [envelope(""), envelope("bad"), envelope("{}"), envelope(null, { finish_reason: "length" }), envelope(null, { finish_reason: "content_filter" })];
  for (const body of cases) await run(http(body).extractor);
  expect(await run(http("[]").extractor)).toMatchObject({ reason: "extractor-backoff" });
  const success = fake(() => "[]", "successful-extractor");
  expect(await run(success)).toMatchObject({ status: "complete" });
  expect(console.info).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  await run(http("error", 500).extractor);
  vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS - 60_000 - 1);
  expect(console.info).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(console.info).toHaveBeenCalledTimes(2);
  const failed = vi.mocked(console.info).mock.calls.map(call => String(call[0])).find(line => line.includes("extractor=@murage/flux-fast"))!;
  expect(failed).toContain("completed=0 deferred=1 unusable=6");
  for (const reason of EXTRACTION_FAILURE_REASONS) expect(failed).toContain(`${reason}=1`);
  expect(failed).toContain("consecutive=5 backoff_ms=60000");
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining("completed=1 deferred=0 unusable=0"));
  // Counters reset for the next window; an idle pair emits no repetitive zero line.
  await run(success); vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
  expect(console.info).toHaveBeenCalledTimes(3);
  expect(console.info).toHaveBeenLastCalledWith(expect.stringContaining("completed=1 deferred=0 unusable=0"));
  expectReason("transport-error");
});

it("requests compact, complete JSON without raising the 2,000-token reservation", async () => {
  const { extractor, fetcher } = http(envelope("[]"));
  expect(await run(extractor)).toMatchObject({ status: "complete", candidates: [] });
  const init = (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1];
  expect(JSON.parse(String(init.body))).toMatchObject({ model: "flux-fast", max_tokens: 2000, stream: false });
  const prompt = memoryExtractionMessages(source)[0].content;
  expect(prompt).toContain("compact JSON"); expect(prompt).toContain("at most 5");
  expect(prompt).toContain("shortest exact quote"); expect(prompt).toContain("entire closed JSON array");
  expect(prompt).toContain("Keep claimType and applicable subject and predicate keys");
  expect(prompt).toContain("omit only byte offsets and unnecessary optional extras");
});
