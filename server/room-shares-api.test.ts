import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
describe("isolated owner HTTP route", () => {
  let fixture: VerificationServer;
  beforeAll(async () => { fixture = await launchVerificationServer(process.env); }, 60000);
  afterAll(async () => { await fixture?.close(); });
  it("GET an unknown receipt returns 404 through the owner HTTP route", async () => {
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const response = await fetch(`${fixture.info.url}/api/room-shares/missing-receipt`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such share request" });
  });

  it("refuses a non-owner before looking up even a missing receipt", async () => {
    const response = await fetch(`${fixture.info.url}/api/room-shares/missing-receipt`, { headers: { "x-test-bare-loopback": "1" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such route" });
  });

});

// The anonymous HTTP case stops at the outer gate. Pin the independent route
// guard too: removing it must fail even while that outer gate still rejects.
it("pins the route-local owner check before receipt lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("// CROSS-CHAT-READ-1019 3.1-3.3 + 8a.1:");
  expect(start).toBeGreaterThan(0);
  const route = source.slice(start, source.indexOf('if (m && method === "POST")', start));
  expect(route).toMatch(/if \(m && method === "GET"\) \{\s*const origin = requestOrigin\(req, url\);\s*if \(origin !== "desktop" && origin !== "companion"\) return json\(res, 403, \{ error: "[^"]+" \}\);\s*const share = roomShare\(database\(\), m\[1\]\);/);
});
