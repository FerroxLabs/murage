import { waitFixtureToolReply } from "./testing/connector-workflow-fixture.ts";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runControlMurage } from "../scripts/control-murage.ts";
import { launchMemoryVerificationServer as launchVerificationServer } from "./testing/memory-verification-fixture.ts";
import { raiseLevel } from "./testing/raise-level.ts";

async function scheduledWorkflow(noLimits: boolean) {
  let lapsed = true, account = "gmail-a", probes = 0, failedCalls = 0, completedCalls = 0;
  const broker = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (req.url?.endsWith("/v1/connectors/connected")) return void res.end(JSON.stringify({ services: { gmail: {
      connected: true, status: "ACTIVE", accounts: [{ id: account, alias: "work", status: "ACTIVE" }],
    } } }));
    if (req.url?.endsWith("/authorize")) return void res.end(JSON.stringify({ url: "https://backend.composio.dev/auth/fixture" }));
    if (req.method === "DELETE") return void res.end(JSON.stringify({ removed: 1 }));
    if (req.url?.endsWith("/v1/mcp")) {
      const parts: Buffer[] = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "initialize") return void reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "offline-gmail", version: "1" } });
      if (body.method === "tools/list") return void reply({ tools: [{ name: "GMAIL_FETCH_EMAILS", description: "Read the fixture queue", inputSchema: { type: "object", properties: {} } }] });
      if (body.method === "tools/call") {
        const probe = body.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL";
        if (probe) {
          probes++;
          expect(body.params.arguments.tools[0]).toEqual({ tool_slug: "GMAIL_GET_PROFILE", account, arguments: { user_id: "me" } });
        }
        else if (lapsed) failedCalls++; else completedCalls++;
        if (lapsed) return void res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000,
          message: "Gmail sign-in expired. Sign in again.", data: { dispatched: false, status: 401, error: "invalid_grant" } } }));
        return void reply({ content: [{ type: "text", text: "Gmail queue checked safely. No posts were published." }] });
      }
      return void reply({});
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  const proof = "ab".repeat(32);
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_DEV_DESKTOP_SECRET = ${JSON.stringify(proof)};
    process.env.FAKE_CUSTOM_TOOL_SERVER = "murage_connectors";
    // Engine success must not conceal the connector failure.
    const { applyManagedBrokerMessage, primeBrokerReadiness } = await import(${JSON.stringify(new URL("./composio.ts", import.meta.url).href)});
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: "c".repeat(64) },
      legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await primeBrokerReadiness();
  ` });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof,
      "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    // MAIN RULING INT-CONFLICT-DEFAULT: use the real optional-recall setting
    // so this connector dispatch fixture measures its broker failure/recovery.
    // Fixture consumer owner: c4-misc-a2; native turn producer owner: c3-drivers.
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const created = await api("POST", "/api/bots", { name: "Gmail schedule fixture" });
    expect(created.status).toBe(201); const bot = created.body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: true });
    // Keep the original failure/recovery assertions below No limits. The twin
    // proves a signed-out capability reports its plain line without failing the run.
    if (noLimits) expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    else {
      const ask = { autoApprove: false, fullAccess: false, noLimits: false };
      expect((await api("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", ...ask })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, ask)).status).toBe(200);
    }
    const scheduled = await api("POST", "/api/routines", { name: "Check Gmail queue", botId: bot.id, prompt: "Check the Gmail queue without publishing anything.",
      schedule: { type: "once", at: Date.now() - 1000 }, runNow: true, permissionMode: noLimits ? "unlimited" : "ask" });
    expect(scheduled.status).toBe(201); const routine = scheduled.body.routine;
    const runs = async () => (await api("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routine.id);
    await expect.poll(async () => ["completed", "failed"].includes((await runs()).find((r: any) => r.triggerSource === "schedule")?.status), { timeout: 80000 }).toBe(true);
    const failed = (await runs())[0];
    if (noLimits) {
      expect(failed.status).toBe("completed");
      expect(probes).toBe(1); expect(failedCalls).toBe(0); expect(completedCalls).toBe(0);
      const messages = await waitFixtureToolReply(() => api("GET", `/api/threads/${failed.threadId}/messages?limit=100`));
      // MAIN RULING INT-CONFLICT-DEFAULT 0122d6cc014 4bf46fd662f: a known lapsed account names its alias and the reconnect path.
      expect(JSON.stringify(messages.body)).toContain("Reconnect Gmail (work) in App Settings → Connections → Connected apps.");
      expect(messages.body.messages.filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.text)).toContain("custom tool said: Reconnect Gmail (work) in App Settings → Connections → Connected apps.");
      expect(messages.body.messages.filter((m: any) => m.card || m.secret || m.connector)).toHaveLength(0);
      expect(failed.error).toBeUndefined();
      evidence.push({ noLimitsRun: failed, messages: messages.body, probes, failedCalls, completedCalls });
      return;
    }
    expect(failed.status).toBe("failed");
    expect(probes).toBe(1); expect(failedCalls).toBe(0); expect(completedCalls).toBe(0);
    const incident = (await api("GET", "/api/connectors/needs-reconnect")).body.apps[0];
    expect(incident.accounts).toEqual([{ id: "gmail-a", alias: "work" }]);
    expect(failed.error).toMatch(/Gmail.*Reconnect/s);
    const messages = await waitFixtureToolReply(() => api("GET", `/api/threads/${failed.threadId}/messages?limit=100`));
    expect(JSON.stringify(messages.body)).toMatch(/Gmail.*Reconnect/s);
    expect(JSON.stringify(messages.body)).toMatch(/failed/);
    evidence.push({ scheduledFailure: failed, messages: messages.body, failedCalls, completedCalls });
    const signIn = await api("POST", `/api/connector-incidents/${incident.incidentId}`, { accountId: "gmail-a", alias: "work" });
    expect(signIn.status).toBe(200);
    lapsed = false; account = "gmail-c";
    await api("GET", "/api/connectors/connected?force=1");
    expect((await api("GET", "/api/connectors/needs-reconnect")).body.apps).toEqual([]);
    const next = await api("PATCH", `/api/routines/${routine.id}`, { enabled: true, schedule: { type: "once", at: Date.now() - 1000 } });
    expect(next.status).toBe(200);
    await expect.poll(async () => (await runs()).filter((r: any) => r.status === "completed").length, { timeout: 80000 }).toBe(1);
    expect(completedCalls).toBe(1); expect(failedCalls).toBe(0);
    const finalRuns = await runs();
    const recovered = finalRuns.find((r: any) => r.status === "completed");
    expect(recovered.triggerSource).toBe("schedule");
    const after = await waitFixtureToolReply(() => api("GET", `/api/threads/${recovered.threadId}/messages?limit=100`));
    expect(JSON.stringify(after.body)).toContain("Gmail queue checked safely");
    evidence.push({ signIn: signIn.body, finalRuns, safeContinuation: after.body, failedCalls, completedCalls,
      wait: await runControlMurage(["wait", "--bot", bot.id, "--timeout", "5", "--url", fixture.info.url]) });
  } finally {
    // The runner retains this capture outside the checkout.
    try { console.info('Scheduled Gmail workflow', JSON.stringify({ noLimits, evidence, log: readFileSync(fixture.info.logPath, "utf8") })); }
    finally { try { await fixture.close(); } finally { await new Promise<void>(resolve => broker.close(() => resolve())); } }
  }
}

it("R2 scheduled Gmail work preflights an ACTIVE lapse and fails visibly even when the engine reports success", () => scheduledWorkflow(false), 240000);
it("R2 No limits scheduled Gmail reports a signed-out capability without a card, owner wait or failed run", () => scheduledWorkflow(true), 240000);
