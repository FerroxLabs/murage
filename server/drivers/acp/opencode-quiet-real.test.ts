import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenCodeDriver } from "./opencode-go.ts";
import { recordEvents } from "../../testing/events.ts";

// OPENCODE-QUIET-1023 W8 (qualification): the real OpenCode binary, offline, through the real driver, with the
// loopback provider in long-retry mode (capture.mjs --long): the first main request gets 429 (one owned stream
// error), every later main request is held open 75 s and then answered normally, title requests get 429 at once.
// The binaries come only from the qualification run: OPENCODE_QUIET_REAL_BINS="1.19.5=/path/opencode,1.19.6=/path/opencode".
const bins = (process.env.OPENCODE_QUIET_REAL_BINS ?? "").split(",").filter(Boolean).map(entry => entry.split("=") as [string, string]);
const HOLD_MS = 75000;

async function provider(mode: "long" | "title-only") {
  const log: { t: number; kind: string }[] = [];
  const started = Date.now();
  const held = new Set<ReturnType<typeof setTimeout>>();
  let mains = 0;
  const limited = (res: ServerResponse) => { res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }); res.end(JSON.stringify({ error: { message: "Local fixture rate limit", type: "rate_limit_error", code: "rate_limit_exceeded" } })); };
  const reply = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "mock" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture reply." }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const kind = /title generator/i.test(JSON.stringify(JSON.parse(body).messages ?? [])) ? "title" : "main";
    log.push({ t: Date.now() - started, kind });
    if (kind === "title") return limited(res);
    if (mode === "long" && ++mains === 1) return limited(res);
    const timer = setTimeout(() => { held.delete(timer); if (!res.destroyed) reply(res); }, HOLD_MS); held.add(timer);
    res.on("close", () => { clearTimeout(timer); held.delete(timer); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, log, close: () => { for (const timer of held) clearTimeout(timer); server.closeAllConnections(); server.close(); } };
}

async function turn(bin: string, mode: "long" | "title-only", stopAfterLine: boolean) {
  const root = await mkdtemp(join(tmpdir(), "opencode-quiet-real-"));
  for (const dir of ["home", "work", "home/config", "home/data", "home/cache", "home/state"]) await mkdir(join(root, dir), { recursive: true });
  const fake = await provider(mode);
  const config = { model: "fixture/mock", small_model: "fixture/mock", provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Offline fixture",
    options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "fake-local-only" }, models: { mock: { name: "Mock", limit: { context: 32000, output: 1000 } } } } } };
  const driver = createOpenCodeDriver(async () => ({ default: "fixture/mock", options: [{ id: "fixture/mock", label: "Mock" }] }));
  const home = join(root, "home");
  const instance = await driver.create({ instanceId: "quiet-real", displayName: undefined, enabled: true, environment: {
    HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
  }, config: { cli: bin, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  const threadId = `quiet-real-${mode}-${stopAfterLine ? "stop" : "reply"}`;
  try {
    const sent = Date.now();
    await instance.adapter.sendTurn({ threadId, text: "Offline fixture prompt", model: "fixture/mock", cwd: join(root, "work") });
    let line: { at: number; event: any } | undefined;
    if (mode === "long") {
      const event = await recorder.until(e => e.type === "turn.diagnostic" || e.type === "turn.completed" || e.type === "runtime.error", HOLD_MS + 10000);
      line = { at: Date.now() - sent, event };
      if (stopAfterLine) await instance.adapter.interruptTurn(threadId);
    }
    const completed: any = await recorder.until(e => e.type === "turn.completed", HOLD_MS + 30000);
    return { sent, line, completed, events: recorder.events as any[], requests: fake.log, done: Date.now() - sent };
  } finally { recorder.stop(); await instance.dispose(); fake.close(); await removeTempDir(root); }
}

describe.skipIf(!bins.length).concurrent("W8 real OpenCode, long-retry provider (qualification; needs OPENCODE_QUIET_REAL_BINS)", () => {
  for (const [version, bin] of bins) {
    it(`${version}: the rate-limit line arrives while session/prompt is unanswered, then the normal reply`, async () => {
      expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe(version);
      console.info(`W8 ${version} sha256=${createHash("sha256").update(await readFile(bin)).digest("hex")}`);
      const run = await turn(bin, "long", false);
      console.info(`W8 ${version} reply line=${run.line?.at}ms completed=${run.done}ms requests=${JSON.stringify(run.requests)}`);
      expect(run.line!.event).toMatchObject({ type: "turn.diagnostic", category: "rate_limit" });
      expect(run.line!.at).toBeGreaterThanOrEqual(60000);
      expect(run.line!.at).toBeLessThan(HOLD_MS);
      expect(run.completed).toMatchObject({ ok: true });
      expect(run.done).toBeGreaterThanOrEqual(HOLD_MS);
      expect(run.events.filter(e => e.type === "turn.diagnostic")).toHaveLength(1);
      expect(run.events.filter(e => e.type === "content.delta").map(e => e.delta).join("")).toContain("Fixture reply.");
      expect(run.events.some(e => e.type === "runtime.error")).toBe(false);
    }, 150000);
    it(`${version}: a title-only failure shows no line`, async () => {
      const run = await turn(bin, "title-only", false);
      console.info(`W8 ${version} title-only completed=${run.done}ms requests=${JSON.stringify(run.requests)}`);
      expect(run.requests.some(request => request.kind === "title")).toBe(true);
      expect(run.completed).toMatchObject({ ok: true });
      expect(run.events.filter(e => e.type === "turn.diagnostic")).toEqual([]);
    }, 150000);
    it(`${version}: Stop after the line ends the turn on the confirmed Stop, line kept`, async () => {
      const run = await turn(bin, "long", true);
      console.info(`W8 ${version} stop line=${run.line?.at}ms completed=${run.done}ms`);
      expect(run.line!.event).toMatchObject({ type: "turn.diagnostic", category: "rate_limit" });
      expect(run.done).toBeLessThan(HOLD_MS);
      expect(run.completed).toMatchObject({ stopReason: "cancelled" });
      expect(run.events.filter(e => e.type === "turn.diagnostic")).toHaveLength(1);
      expect(run.events.findIndex(e => e.type === "turn.diagnostic")).toBeLessThan(run.events.findIndex(e => e.type === "turn.completed"));
    }, 150000);
  }
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
