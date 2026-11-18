import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("B3 isolated HTTP panel routes honor the first health 503 Retry-After", async () => {
  let probes = 0;
  const broker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) {
      probes++;
      res.writeHead(503, { "retry-after": "600" });
    } else res.statusCode = 503;
    res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  const moduleUrl = new URL("./composio.ts", import.meta.url).href;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const { applyManagedBrokerMessage, primeBrokerReadiness } = await import(${JSON.stringify(moduleUrl)});
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: "c".repeat(64) },
      legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await primeBrokerReadiness();
    // Simulate 21 s since the first health refusal, with real fixture I/O.
    const originalNow = Date.now;
    Date.now = () => originalNow() + 21_000;
  ` });
  try {
    const doctor = await runControlMurage(["doctor", "--url", fixture.info.url]);
    const responses = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${fixture.info.url}/api/connectors/catalog/search?q=fixture`);
      responses.push({ status: response.status, body: await response.json() });
      expect(response.status).toBe(200);
    }
    expect(probes).toBe(1);
    console.log(JSON.stringify({ command: ["doctor", "--url", fixture.info.url], doctor, responses, probes, logPath: fixture.info.logPath }));
  } finally {
    console.log(readFileSync(fixture.info.logPath, "utf8"));
    await fixture.close();
    await new Promise<void>(resolve => broker.close(() => resolve()));
  }
}, 180_000);

it("T6 isolated owner Retry HTTP route returns the terminal non-secret recovery result", async () => {
  const fixture = await launchVerificationServer(process.env);
  try {
    const doctor = await runControlMurage(["doctor", "--url", fixture.info.url]);
    expect((await fetch(`${fixture.info.url}/api/connectors/recovery/retry`, { method: "POST" })).status).toBe(404);
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const response = await fetch(`${fixture.info.url}/api/connectors/recovery/retry`, { method: "POST", headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false, reconnected: false });
    console.log(JSON.stringify({ command: ["doctor", "--url", fixture.info.url], doctor, response: body, logPath: fixture.info.logPath }));
  } finally { await fixture.close(); }
}, 180_000);
