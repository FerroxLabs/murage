// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance through the real routes: a real server with its own data
// directory and port (launchVerificationServer). Reading is open to any
// authenticated surface; accepting is the owner's (desktop with this launch's
// secret), so a bot's shell on loopback cannot agree to the terms for them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { TERMS_VERSION } from "../shared/terms.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as { accepted?: boolean; error?: string } };
};

describe.skipIf(process.platform === "win32")("terms routes", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { terms: "pending" });
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("a fresh install is not accepted, and only the owner's surface can accept", async () => {
    expect((await call("GET", "/api/terms")).body.accepted).toBe(false);
    const forged = await call("POST", "/api/terms/accept", { version: TERMS_VERSION, ageConfirmed: true }, {});
    // an unproven caller (a bot's shell on loopback) is turned away by the route policy: it learns nothing
    expect(forged.status).toBe(404);
    // Reading the status is a conversation route: a door caller may read it, a caller with no proof at all may not.
    // (The suite stamps the door secret on every fixture request; x-test-bare-loopback: 1 removes it.)
    expect((await call("GET", "/api/terms", undefined, { "x-test-bare-loopback": "1" })).status).toBe(404);
    expect((await call("GET", "/api/terms")).body.accepted).toBe(false);
  });

  it("the status answer is never cached", async () => {
    const response = await fetch(`${fixture.info.url}/api/terms`, { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("the owner accepts once, the record is on disk, and it survives a server restart", async () => {
    const accepted = await call("POST", "/api/terms/accept", { version: TERMS_VERSION, ageConfirmed: true, appVersion: "1.0.2" });
    expect(accepted.status).toBe(200);
    expect((await call("GET", "/api/terms")).body.accepted).toBe(true);
    const file = join(fixture.info.dataDir, "terms-acceptance.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).accepted[0]).toMatchObject({ version: TERMS_VERSION, appVersion: "1.0.2" });
    await fixture.restart();
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    expect((await call("GET", "/api/terms")).body.accepted).toBe(true);
  }, 60000);
});
