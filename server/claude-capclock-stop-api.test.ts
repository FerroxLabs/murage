import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";
import { HELPER_CAP_MS } from "./drivers/mcp-stop-helper.ts";
import { CLI_CALLER_DEADLINE_MS } from "./procs.ts";

// Owner cl-capclockg: pinned enumeration fixture and real HTTP Stop consumer.
it.skipIf(process.platform === "win32")("a pinned startup walk reaches CLAUDE_SESSION_NOT_STOPPED through the real Stop route at HELPER_CAP_MS", async () => {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const { appendFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const report = event => appendFileSync(join(process.env.MURAGE_DATA_DIR, 'capture-clock.jsonl'), JSON.stringify(event) + '\\n');
    const { DesktopStopTarget } = await import(${JSON.stringify(new URL('./drivers/mcp-stop-target.ts', import.meta.url).href)});
    DesktopStopTarget.prototype.track = function() { report({kind:'walk'}); return new Promise(() => {}); };
    const { ChatMcpDescendants } = await import(${JSON.stringify(new URL('./drivers/chat-mcp-client.ts', import.meta.url).href)});
    const ready = ChatMcpDescendants.prototype.ready;
    const seen = new WeakSet();
    ChatMcpDescendants.prototype.ready = function(...args) {
      const first = !seen.has(this); seen.add(this);
      const began = performance.now();
      const result = ready.apply(this, args);
      if (first) result.then(() => report({kind:'ready', elapsed:performance.now()-began}));
      return result;
    };
    const { ClaudeDriver } = await import(${JSON.stringify(new URL('./drivers/claude.ts', import.meta.url).href)});
    const create = ClaudeDriver.create;
    ClaudeDriver.create = async function(...args) {
      const instance = await create.apply(this,args);
      instance.adapter.onEvent(event => {
        if (event.type === 'runtime.error') report({kind:'refusal', message:event.message});
      });
      return instance;
    };
  ` });
  const reportPath = join(fixture.info.dataDir, "capture-clock.jsonl");
  const observations = (): Array<{kind: string; elapsed?: number; message?: string}> =>
    existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const proof = await api("GET", "/api/desktop-secret");
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    const created = await api("POST", "/api/bots", { name: "Capture clock fixture", modelSelection: { instanceId: "verification", model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__ capture clock" })).status).toBe(202);
    await expect.poll(() => observations().some(event => event.kind === "walk"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes("capture clock"), { timeout: 15_000 }).toBe(true);
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stopped.status).toBe(409);
    expect(stopped.body.code).toBe("provider_stop_unconfirmed");
    const events = observations();
    expect(events.some(event => event.kind === "refusal" && event.message?.includes("CLAUDE_SESSION_NOT_STOPPED"))).toBe(true);
    console.log("CAPCLOCK_STOP", JSON.stringify(events));
    const firstReady = events.find(event => event.kind === "ready")!;
    expect(firstReady).toBeDefined();
    expect(firstReady.elapsed).toBeGreaterThanOrEqual(HELPER_CAP_MS - 1);
    expect(firstReady.elapsed).toBeLessThan(HELPER_CAP_MS + CLI_CALLER_DEADLINE_MS);
  } finally { console.log("CAPCLOCK_OBSERVED", JSON.stringify(observations())); await fixture.close(); }
}, 60_000);
