import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("an idle fixture discovers a lapse, retains it through restart and missing inventory, then clears verified recovery", async () => {
  let status = "EXPIRED";
  let absent = false;
  let reads = 0;
  let authorizations = 0;
  const broker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (req.url?.endsWith("/v1/connectors/connected")) {
      reads++;
      return void res.end(JSON.stringify({ services: absent ? {} : { buffer: { connected: status === "ACTIVE", status,
        accounts: [{ id: "fixture-buffer", alias: "work", status }] } } }));
    }
    if (req.url?.endsWith("/authorize") && req.method === "POST") {
      authorizations++;
      return void res.end(JSON.stringify({ url: "https://backend.composio.dev/auth/fixture" }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  const moduleUrl = new URL("./composio.ts", import.meta.url).href;
  const proof = "ab".repeat(32);
  const fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: "c".repeat(64) }, instrumentationSource: `
    process.env.MURAGE_DEV_DESKTOP_SECRET = ${JSON.stringify(proof)};
    process.env.MURAGE_MCP_COMMIT_TOKEN = ${JSON.stringify(proof)};
    const { applyManagedBrokerMessage, primeBrokerReadiness } = await import(${JSON.stringify(moduleUrl)});
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: "c".repeat(64) },
      fluxOwner: "a".repeat(16), legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await primeBrokerReadiness();
  ` });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const get = async (path: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    const created = await runControlMurage(["new-bot", "--url", fixture.info.url, "--name", "Connector fixture"]);
    evidence.push({ created });
    let first: any;
    const deadline = Date.now() + 30_000;
    do {
      first = await get("/api/connectors/needs-reconnect");
      if (first.apps.length) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    expect(first.apps).toEqual([expect.objectContaining({ slug: "buffer", accounts: [{ id: "fixture-buffer", alias: "work" }] })]);
    expect(reads).toBeGreaterThan(0);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0].title).toBe("Buffer needs you to sign in again");
    const tray = await get("/api/desktop/tray");
    expect(tray.items).toContainEqual(expect.objectContaining({ reconnectIncidentId: first.apps[0].incidentId, quick: false }));
    evidence.push({ idleDiscovery: first, inventoryReads: reads, tray });
    const incidentPath = `/api/connector-incidents/${first.apps[0].incidentId}`;
    const unproven = await fetch(`${fixture.info.url}${incidentPath}`);
    expect(unproven.status).toBe(404);
    const phoneHeaders = { "x-murage-companion": "1", "x-murage-companion-token": "c".repeat(64), "content-type": "application/json" };
    const phoneRead = await fetch(`${fixture.info.url}${incidentPath}`, { headers: phoneHeaders });
    expect(phoneRead.status).toBe(200);
    const phoneIncident = await phoneRead.json() as { accounts: unknown };
    expect(phoneIncident.accounts).toEqual(first.apps[0].accounts);
    expect(authorizations).toBe(0);
    const wrongAccount = await fetch(`${fixture.info.url}${incidentPath}`, { method: "POST", headers: phoneHeaders, body: JSON.stringify({ accountId: "another-account", alias: "work" }) });
    expect(wrongAccount.status).toBe(409);
    const begin = await fetch(`${fixture.info.url}${incidentPath}`, { method: "POST", headers: phoneHeaders, body: JSON.stringify({ accountId: "fixture-buffer", alias: "work" }) });
    expect(begin.status).toBe(200);
    expect(authorizations).toBe(1);
    evidence.push({ ownerPhone: phoneIncident, unauthorizedStatus: unproven.status, wrongAccountStatus: wrongAccount.status, signIn: await begin.json(), authorizations });
    absent = true;
    // Renew while the harness is down. Stable verified ownership must survive
    // without relying on a live rejection/renewal callback.
    const instrumentation = join(fixture.info.dataDir, ".verification-instrumentation.body.mjs");
    writeFileSync(instrumentation, readFileSync(instrumentation, "utf8").replace('token: "c".repeat(64)', 'token: "d".repeat(64)'));
    await fixture.restart();
    const restarted = await get("/api/connectors/needs-reconnect");
    expect(restarted.apps[0].incidentId).toBe(first.apps[0].incidentId);
    await get("/api/connectors/connected?force=1");
    const missing = await get("/api/connectors/needs-reconnect");
    expect(missing.apps).toEqual(first.apps);
    evidence.push({ restarted, missing });
    absent = false; status = "ACTIVE";
    await get("/api/connectors/connected?force=1");
    const recovered = await get("/api/connectors/needs-reconnect");
    expect(recovered.apps).toEqual([]);
    const recoveredTray = await get("/api/desktop/tray");
    expect(recoveredTray.items.some((item: any) => item.reconnectIncidentId)).toBe(false);
    evidence.push({ verifiedRecovery: recovered, recoveredTray });
    const desktopHeaders = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof, "content-type": "application/json" };
    const createTool = await fetch(`${fixture.info.url}/api/mcp/servers`, { method: "POST", headers: desktopHeaders,
      body: JSON.stringify({ name: "fixturetool", url: `http://127.0.0.1:${port}/mcp`, confirmLocal: "this-computer", auth: "oauth" }) });
    expect(createTool.status).toBe(201);
    const toolHealth = (body: unknown) => fetch(`${fixture.info.url}/api/mcp/servers/fixturetool/health`, { method: "PUT", headers: { ...desktopHeaders, authorization: `Bearer ${proof}` }, body: JSON.stringify(body) });
    expect((await toolHealth({ origin: "https://another.example", needsReconnect: true, revision: 1 })).status).toBe(409);
    const origin = `http://127.0.0.1:${port}`;
    expect((await toolHealth({ origin, needsReconnect: true, revision: 1 })).status).toBe(200);
    const terminal = await get("/api/connectors/needs-reconnect");
    expect(terminal.apps[0].slug).toBe("mcp-fixturetool");
    await fixture.restart();
    expect((await get("/api/connectors/needs-reconnect")).apps[0].incidentId).toBe(terminal.apps[0].incidentId);
    expect((await toolHealth({ origin, needsReconnect: false, revision: 2, signedInAt: Date.now() + 1 })).status).toBe(200);
    expect((await get("/api/connectors/needs-reconnect")).apps).toEqual([]);
    expect((await toolHealth({ origin, needsReconnect: true, revision: 1 })).status).toBe(200);
    expect((await get("/api/connectors/needs-reconnect")).apps).toEqual([]);
    evidence.push({ customConnectorTerminal: terminal, customConnectorRecovery: "newer sign-in wins over delayed terminal projection" });
  } finally {
    evidence.push({ finalLogPath: fixture.info.logPath });
    writeFileSync(fileURLToPath(new URL("../lane-evidence/connector-reconnect-r1/restart-workflow.json", import.meta.url)), JSON.stringify(evidence, null, 2));
    writeFileSync(fileURLToPath(new URL("../lane-evidence/connector-reconnect-r1/restart-fixture.log", import.meta.url)), readFileSync(fixture.info.logPath));
    await fixture.close();
    await new Promise<void>(resolve => broker.close(() => resolve()));
  }
}, 180_000);
