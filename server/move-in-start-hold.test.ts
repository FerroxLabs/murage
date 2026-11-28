import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { moveInHoldSource } from "./testing/move-in-hold.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// 1.0.23 row (dlscan): the owner's terms are already accepted, so the first setup read after a start looks for Grok Bot
// data. On a Mac the open of ~/Downloads is then held until the folder question is answered, and it was held on the main
// thread: /api/health and /api/bots (the check Restart to update makes) timed out until the owner answered.
//
// A real server whose Downloads listing never returns (the hold stands in for the OS inside the worker the server reads
// folders on). The marker proves the hold was reached. Every route must keep answering inside 500 ms, the move-in step
// included once its own wait is bounded by the caller.
const HOLD = moveInHoldSource({ release: false, exportFixture: false });

const QUICK_MS = 500;
let fixture: VerificationServer;
let desktop: Record<string, string>;

async function call(path: string, timeoutMs = 4000) {
  const started = performance.now();
  try {
    const response = await fetch(`${fixture.info.url}${path}`, { headers: desktop, signal: AbortSignal.timeout(timeoutMs) });
    await response.text();
    return { status: response.status, ms: performance.now() - started };
  } catch {
    return { status: 0, ms: performance.now() - started };
  }
}
const marker = () => join(fixture.info.dataDir, "downloads-listing-entered");
const holds = () => existsSync(marker()) ? readFileSync(marker(), "utf8").trim().split("\n") : [];

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: HOLD, separateHome: true });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as Promise<{ secret: string }>);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 180_000);
afterAll(async () => { await fixture?.close(); });

describe("terms accepted, Downloads listing never returns", () => {
  it("health and bots answer inside 500 ms while setup polls, the move-in step and a second poll pile up", async () => {
    const polls = [call("/api/setup?peek=1", 3000), call("/api/setup", 3000), call("/api/move-in/found", 3000)];
    const deadline = Date.now() + 15_000;
    while (holds().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    // The hold was reached somewhere; where is asserted last, after the routes have had to answer.
    expect(holds().length).toBeGreaterThan(0);
    for (let round = 0; round < 5; round++) {
      const health = await call("/api/health");
      expect(health.status).toBe(200);
      expect(health.ms).toBeLessThan(QUICK_MS);
      const bots = await call("/api/bots");
      expect(bots.status).toBe(200);
      expect(bots.ms).toBeLessThan(QUICK_MS);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The setup view answers with the last count, never waiting on the held listing.
    const view = await polls[0];
    expect(view.status).toBe(200);
    // One held listing, however many polls asked, and on the worker: never on the main thread.
    expect(holds()).toEqual(["worker"]);
    await Promise.all(polls);
  }, 60_000);
});
