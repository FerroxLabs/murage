// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// ONE LINE PER APP (1.0.20, owner report on 1.0.19). An app with two accounts
// keeps one incident per account in the health store, and the reconnect line
// read those incidents as apps: "Freshdesk needs you to sign in again.
// Freshdesk needs you to sign in again." with two identical Reconnect
// buttons. The routes now answer one row per app, carrying every account and
// every incident id. Driven through a real server and the fixture broker.
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("two lapsed accounts of one app answer one reconnect row with both accounts, on the desktop and the phone route", async () => {
  const broker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (req.url?.endsWith("/v1/connectors/connected")) return void res.end(JSON.stringify({ services: {
      buffer: { connected: false, status: "EXPIRED", accounts: [
        { id: "fixture-buffer-a", alias: "work", status: "EXPIRED" },
        { id: "fixture-buffer-b", alias: "home", status: "EXPIRED" },
      ] },
      gmail: { connected: false, status: "EXPIRED", accounts: [{ id: "fixture-gmail", status: "EXPIRED" }] },
    } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const port = (broker.address() as { port: number }).port;
  const moduleUrl = new URL("./composio.ts", import.meta.url).href;
  const proof = "ab".repeat(32);
  const fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: "c".repeat(64) }, instrumentationSource: `
    process.env.MURAGE_DEV_DESKTOP_SECRET = ${JSON.stringify(proof)};
    const { applyManagedBrokerMessage, primeBrokerReadiness, noteConnectorUse } = await import(${JSON.stringify(moduleUrl)});
    applyManagedBrokerMessage({ type: "murage:managed-composio", access: null,
      fluxBrokerUrl: "http://127.0.0.1:${port}/composio", fluxAccess: { url: "http://127.0.0.1:${port}/composio", token: "c".repeat(64) },
      fluxOwner: "a".repeat(16), legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
    await primeBrokerReadiness();
    noteConnectorUse();
  ` });
  const get = async (path: string, headers: Record<string, string> = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof }) => {
    const response = await fetch(`${fixture.info.url}${path}`, { headers });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    await runControlMurage(["new-bot", "--url", fixture.info.url, "--name", "Connector fixture"]);
    let answer: any;
    const deadline = Date.now() + 30_000;
    do {
      answer = await get("/api/connectors/needs-reconnect");
      if (answer.apps.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    // CHANGED (hl-optional, 1.0.19 owner report: the notice said its sentence twice with two buttons): each account
    // still has its own incident (incidentIds below), but the owner gets ONE notice per app. (Was: 2.)
    expect(answer.notifications.filter((frame: any) => frame.reconnect?.slug === "buffer")).toHaveLength(1);
    expect(answer.notifications.filter((frame: any) => frame.reconnect?.slug === "gmail")).toHaveLength(1);
    // ...but the line gets one row per app.
    expect(answer.apps.map((app: any) => app.slug)).toEqual(["buffer", "gmail"]);
    const buffer = answer.apps[0];
    expect(buffer.accounts).toEqual([{ id: "fixture-buffer-a", alias: "work" }, { id: "fixture-buffer-b", alias: "home" }]);
    expect(buffer.incidentIds).toHaveLength(2);
    expect(new Set(buffer.incidentIds).size).toBe(2);
    expect(buffer.incidentIds[0]).toBe(buffer.incidentId);
    // The row's incident is one the per-incident route still opens.
    const opened = await get(`/api/connector-incidents/${buffer.incidentId}`);
    expect(opened.slug).toBe("buffer");
    // The phone's list is grouped the same way.
    const phone = await get("/api/connector-incidents", { "x-murage-companion": "1", "x-murage-companion-token": "c".repeat(64) });
    expect(phone.apps.map((app: any) => app.slug)).toEqual(["buffer", "gmail"]);
    expect(phone.apps[0].incidentIds).toEqual(buffer.incidentIds);
  } finally {
    await fixture.close();
    await new Promise<void>(resolve => broker.close(() => resolve()));
  }
}, 180_000);
