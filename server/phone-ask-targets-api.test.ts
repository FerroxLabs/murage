// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 share and ask S34 through the real server: the ask path answers only to the door's ask envelope, and a jobs envelope is
// refused there (and the reverse), so a jobs token never reaches share and ask and an ask token never reaches a phone job.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
const DOOR = "c".repeat(64);
const DEVICE = "22222222-2222-4222-8222-222222222222";
let fixture: VerificationServer;
let desktop: Record<string, string> = {};

const api = async (method: string, path: string, headers: Record<string, string>) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : "{}" });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const envelope = (scope: string, extra: Record<string, string> = {}) => ({ "x-test-bare-loopback": "1", "x-murage-door-token": DOOR, "x-murage-phone-device": DEVICE, "x-murage-phone-scope": scope, ...extra });
const ask = envelope("ask", { "x-murage-phone-ask-gen": "1" });
const jobs = envelope("jobs");

posixOnly("GET /api/phones/self/targets through the real server (S34)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const patched = await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json", ...desktop }, body: JSON.stringify({ features: { phoneShareAsk: true, phoneTools: true } }) });
    expect(patched.status).toBe(200);
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("an ask envelope gets the targets answer", async () => {
    const res = await api("GET", "/api/phones/self/targets", ask);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bots)).toBe(true);
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it("a jobs envelope, the desktop secret, a bare door token and a wrong scope are 403 on targets", async () => {
    const callers: Array<[string, Record<string, string>]> = [
      ["jobs token", jobs], ["desktop secret", desktop],
      ["bare door token", { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR }],
      ["owner-phone", envelope("owner-phone")], ["ask without a generation", envelope("ask")],
    ];
    for (const [who, headers] of callers) expect((await api("GET", "/api/phones/self/targets", headers)).status, who).toBe(403);
  });

  it("an ask envelope is 403 on every jobs path, and a jobs envelope still passes its own", async () => {
    for (const [method, path] of [["GET", "/api/phones/self/jobs"], ["POST", "/api/phones/self/foreground"], ["DELETE", "/api/phones/self"]] as const) {
      expect((await api(method, path, ask)).status, `${method} ${path}`).toBe(403);
    }
    expect((await api("GET", "/api/phones/self/jobs?wait=0", jobs)).status).not.toBe(403);
  });
  it("POST share: a jobs envelope, a bare door token and the desktop are 403; an ask envelope with a body that is not multipart is 422 (S36)", async () => {
    for (const headers of [jobs, desktop, { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR }]) expect((await api("POST", "/api/phones/self/share", headers)).status).toBe(403);
    const res = await api("POST", "/api/phones/self/share", ask);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("invalid");
  });
  it("POST ask: a jobs envelope, a bare door token and the desktop are 403; an ask envelope with an empty body is 422 (S38)", async () => {
    for (const headers of [jobs, desktop, { "x-test-bare-loopback": "1", "x-murage-door-token": DOOR }]) expect((await api("POST", "/api/phones/self/ask", headers)).status).toBe(403);
    const res = await api("POST", "/api/phones/self/ask", ask);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("invalid");
  });
});
