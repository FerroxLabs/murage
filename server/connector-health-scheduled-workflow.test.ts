import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";
import { raiseLevel } from "./testing/raise-level.ts";

it("P2-6 scheduled Buffer work fails visibly while lapsed and safely continues after reconnect", async () => {
  let lapsed = true, account = "buffer-a", probes = 0, failedCalls = 0, completedCalls = 0;
  const broker = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (req.url?.endsWith("/v1/connectors/connected")) return void res.end(JSON.stringify({ services: { buffer: {
      connected: true, status: "ACTIVE", accounts: [{ id: account, alias: "work", status: "ACTIVE" }],
    } } }));
    if (req.url?.endsWith("/authorize")) return void res.end(JSON.stringify({ url: "https://backend.composio.dev/auth/fixture" }));
    if (req.method === "DELETE") return void res.end(JSON.stringify({ removed: 1 }));
    if (req.url?.endsWith("/v1/mcp")) {
      const parts: Buffer[] = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "initialize") return void reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "offline-buffer", version: "1" } });
      if (body.method === "tools/list") return void reply({ tools: [{ name: "BUFFER_LIST_POSTS", description: "Read the fixture queue", inputSchema: { type: "object", properties: {} } }] });
      if (body.method === "tools/call") {
        const probe = body.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL";
        if (probe) {
          probes++;
          expect(body.params.arguments.tools).toEqual([{ tool_slug: "BUFFER_GET_ACCOUNT_CONTEXT", account, arguments: {} }]);
        }
        else if (lapsed) failedCalls++; else completedCalls++;
        if (lapsed) return void res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000,
          message: "Buffer sign-in expired. Sign in again.", data: { dispatched: false, status: 401, error: "invalid_grant" } } }));
        return void reply({ content: [{ type: "text", text: "Buffer queue checked safely. No posts were published." }] });
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
    // A successful engine exit must not conceal the connector failure.
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
    const created = await api("POST", "/api/bots", { name: "Buffer schedule fixture" });
    expect(created.status).toBe(201); const bot = created.body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: true });
    // Exercise the normal owner's confirmation route, with no policy bypass.
    expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    // Approved DESIGN-CONN-r3.md:69-79: no background provider reads before a
    // routine has learned toolkits. A first scheduled run preflights at dispatch.
    expect((await api("GET", "/api/connectors/needs-reconnect")).body.apps).toEqual([]);
    expect(probes).toBe(0);
    const scheduled = await api("POST", "/api/routines", { name: "Check Buffer queue", botId: bot.id, prompt: "Check the Buffer queue without publishing anything.",
      schedule: { type: "once", at: Date.now() - 1000 }, permissionMode: "unlimited" });
    expect(scheduled.status).toBe(201); const routine = scheduled.body.routine;
    const runs = async () => (await api("GET", "/api/routines")).body.runs.filter((r: any) => r.routineId === routine.id);
    await expect.poll(async () => (await runs()).find((r: any) => r.triggerSource === "schedule")?.status, { timeout: 80000 }).toBe("failed");
    const failed = (await runs())[0];
    await expect.poll(async () => (await api("GET", "/api/connectors/needs-reconnect")).body.apps.length, { timeout: 35000 }).toBe(1);
    const incident = (await api("GET", "/api/connectors/needs-reconnect")).body.apps[0];
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBe(1);
    expect(incident.accounts).toEqual([{ id: "buffer-a", alias: "work" }]);
    expect(failed.error).toMatch(/Buffer.*Reconnect/s);
    evidence.push({ preflightIncident: incident, probes });
    expect(failedCalls).toBe(0); expect(completedCalls).toBe(0);
    const messages = await api("GET", `/api/threads/${failed.threadId}/messages?limit=100`);
    expect(JSON.stringify(messages.body)).toMatch(/Buffer sign-in expired|sign in again/i);
    expect(JSON.stringify(messages.body)).toMatch(/failed/);
    evidence.push({ scheduledFailure: failed, messages: messages.body, failedCalls, completedCalls });
    const signIn = await api("POST", `/api/connector-incidents/${incident.incidentId}`, { accountId: "buffer-a", alias: "work" });
    expect(signIn.status).toBe(200);
    lapsed = false; account = "buffer-c";
    await api("GET", "/api/connectors/connected?force=1");
    expect((await api("GET", "/api/connectors/needs-reconnect")).body.apps).toEqual([]);
    const next = await api("PATCH", `/api/routines/${routine.id}`, { enabled: true, schedule: { type: "once", at: Date.now() - 1000 } });
    expect(next.status).toBe(200);
    await expect.poll(async () => (await runs()).filter((r: any) => r.status === "completed").length, { timeout: 80000 }).toBe(1);
    expect(completedCalls).toBe(1); expect(failedCalls).toBe(0);
    const finalRuns = await runs();
    const recovered = finalRuns.find((r: any) => r.status === "completed");
    expect(recovered.triggerSource).toBe("schedule");
    const after = await api("GET", `/api/threads/${recovered.threadId}/messages?limit=100`);
    expect(JSON.stringify(after.body)).toContain("Buffer queue checked safely");
    evidence.push({ signIn: signIn.body, finalRuns, safeContinuation: after.body, failedCalls, completedCalls,
      wait: await runControlMurage(["wait", "--bot", bot.id, "--timeout", "5", "--url", fixture.info.url]) });
  } finally {
    const dir = new URL("../lane-evidence/connector-reconnect-r1/", import.meta.url);
    writeFileSync(fileURLToPath(new URL("scheduled-workflow.json", dir)), JSON.stringify(evidence, null, 2));
    writeFileSync(fileURLToPath(new URL("scheduled-fixture.log", dir)), readFileSync(fixture.info.logPath));
    await fixture.close(); await new Promise<void>(resolve => broker.close(() => resolve()));
  }
}, 240000);
