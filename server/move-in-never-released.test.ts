import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { moveInHoldSource } from "./testing/move-in-hold.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// Opus/Astra High on e28850df88: the first Downloads listing may never settle (the macOS question left unanswered, an
// unreadable folder). Setup held the Flux card, the only connect/skip UI, for as long as that listing was pending. Here
// the listing is never released: the Flux card must still arrive once the bounded hold has run out.
const HOLD = moveInHoldSource({ release: false, exportFixture: true });


let fixture: VerificationServer;
let desktop: Record<string, string>;

async function call(method: string, path: string, body?: unknown, timeoutMs = 4000) {
  const started = performance.now();
  try {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...desktop },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json() as Record<string, any>, ms: performance.now() - started };
  } catch (error) {
    // A timeout is the freeze this file guards against: reported as a slow answer, not a crash of the test.
    return { status: 0, body: { error: String(error) }, ms: performance.now() - started };
  }
}


const marker = () => join(fixture.info.dataDir, "downloads-listing-entered");

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: HOLD, terms: "accepted", separateHome: true });
  desktop = {};
  const proof = await call("GET", "/api/desktop-secret", undefined, 30_000);
  expect(proof.status).toBe(200);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 180_000);

afterAll(async () => { await fixture?.close(); });

describe("a first Downloads listing that is never released", () => {
  it("still posts the Flux connect/skip card after the bounded hold", async () => {
    const opened = await call("GET", "/api/setup");
    expect(opened.status).toBe(200);
    const chiefId = opened.body.chiefBotId;
    const cards = async (): Promise<string[]> => {
      const bots = await call("GET", "/api/bots");
      return bots.body.bots.find((bot: { id: string }) => bot.id === chiefId).messages
        .flatMap((message: { card?: { setup?: { key: string } } }) => message.card?.setup ? [message.card.setup.key] : []);
    };
    const hello = await call("POST", "/api/setup/skip", { step: "hello" });
    expect(hello.status).toBe(200);
    if (hello.body.next === "detect") await call("POST", "/api/setup/answer", { step: "detect", answer: "Seen it" });
    await vi.waitFor(() => expect(existsSync(marker())).toBe(true), { timeout: 5000 });
    expect(await cards()).not.toContain("flux:key");
    // The release file is never written. The setup view is polled, as the first-run chrome does.
    await vi.waitFor(async () => {
      expect((await call("GET", "/api/setup")).status).toBe(200);
      expect(await cards()).toContain("flux:key");
    }, { timeout: 25_000, interval: 1000 });
  }, 60_000);
});
