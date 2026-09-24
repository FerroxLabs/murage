// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new through the real routes: a real server with its own data
// directory and port (launchVerificationServer). The server's own first-run
// answer decides that a brand-new install skips the page. Loopback only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as { version?: string; show?: boolean; error?: string } };
};

describe.skipIf(process.platform === "win32")("what's new routes", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is desktop only", async () => {
    expect((await call("GET", "/api/whats-new?version=0.1.59", undefined, {})).status).toBe(404);
    expect((await call("POST", "/api/whats-new/seen", { version: "0.1.59" }, {})).status).toBe(404);
  });

  it("skips a brand-new install, then shows the next version once", async () => {
    const setup = await (await fetch(`${fixture.info.url}/api/setup`, { headers })).json() as { firstRun?: boolean };
    expect(setup.firstRun).toBe(true);
    expect((await call("GET", "/api/whats-new?version=0.1.59")).body).toEqual({ version: "0.1.59", show: false });
    // the next release is an update of a recorded install
    expect((await call("GET", "/api/whats-new?version=0.1.60")).body).toEqual({ version: "0.1.60", show: true });
    expect((await call("POST", "/api/whats-new/seen", { version: "0.1.60" })).body).toEqual({ version: "0.1.60", show: false });
    expect((await call("GET", "/api/whats-new?version=0.1.60")).body).toEqual({ version: "0.1.60", show: false });
  });
});
