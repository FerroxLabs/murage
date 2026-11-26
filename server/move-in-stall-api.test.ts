import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MOVE_IN_WAIT_MS } from "./move-in-found.ts";
import { moveInHoldSource } from "./testing/move-in-hold.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// 1.0.21 row (custjourney-1020/1021-ROW.md): on a Mac, opening ~/Downloads is held by the OS until the owner answers the
// folder question. The move-in finder listed it with readdirSync on the main thread, so a first start froze behind the
// terms screen: health, terms and the Accept press all waited for the answer.
//
// A real server, with the OS hold stood in for inside the server child: a listing of a folder named Downloads blocks the
// calling thread for 20 s when synchronous (what macOS does to the open), and waits for the test to release it when asynchronous. Every other
// folder reads normally. The marker file proves the hold was actually reached, so a green run is not a skipped listing.
const HOLD = moveInHoldSource({ release: true, exportFixture: true });

const QUICK_MS = 500;

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
const holds = () => existsSync(marker()) ? readFileSync(marker(), "utf8").trim().split("\n") : [];

async function expectResponsive() {
  const health = await call("GET", "/api/health");
  expect(health.status).toBe(200);
  expect(health.ms).toBeLessThan(QUICK_MS);
  const terms = await call("GET", "/api/terms");
  expect(terms.status).toBe(200);
  expect(terms.ms).toBeLessThan(QUICK_MS);
  return terms.body;
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: HOLD, terms: "pending", separateHome: true });
  desktop = {};
  const proof = await call("GET", "/api/desktop-secret", undefined, 30_000);
  expect(proof.status).toBe(200);
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 180_000);

afterAll(async () => { await fixture?.close(); });

describe("a first start whose Downloads question is still unanswered", () => {
  it("before the terms are accepted, the polled setup view does not list Downloads and health and terms answer", async () => {
    // The tray and the setup card poll the view while the terms screen is up.
    let answered: Awaited<ReturnType<typeof call>> | undefined;
    const view = call("GET", "/api/setup?peek=1", undefined, 30_000).then((result) => (answered = result));
    // Checked while a listing would be held: once the view has answered, or once the hold is reached.
    for (let i = 0; i < 300 && !answered && holds().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const terms = await expectResponsive();
    expect(terms.accepted).toBe(false);
    await view;
    if (!answered) throw new Error("the setup view did not answer");
    expect(answered.status).toBe(200);
    expect(answered.body.moveIn).toEqual({ grok: 0 });
    // Pressing Move my bots before the terms are accepted lists nothing either.
    const early = await call("POST", "/api/move-in/grok", {}, 5000);
    expect(early.status).toBe(409);
    // Not asked at all before the terms: the OS question cannot appear over the terms screen.
    expect(holds()).toEqual([]);
  }, 60_000);

  it("keeps health, terms and a repeated Accept responsive while Downloads is held", async () => {
    const { version } = await expectResponsive();
    const accept = await call("POST", "/api/terms/accept", { version, ageConfirmed: true });
    expect(accept.status).toBe(200);
    expect(accept.ms).toBeLessThan(QUICK_MS);
    expect(accept.body.accepted).toBe(true);

    const view = call("GET", "/api/setup?peek=1", undefined, 30_000);
    await vi.waitFor(() => expect(holds()).toHaveLength(1), { timeout: 5000 });

    // A repeated press is a real Accept request, issued after the listing has entered the hold.
    const repeated = await call("POST", "/api/terms/accept", { version, ageConfirmed: true }, QUICK_MS);
    expect(repeated).toMatchObject({ status: 200, body: { accepted: true } });
    expect(repeated.ms).toBeLessThan(QUICK_MS);
    await expectResponsive();

    const first = await view;
    expect(first.status).toBe(200);
    expect(first.body.moveIn).toEqual({ grok: 0 });
    // The reading is still in flight: the renderer must go on polling for as long as the OS holds it.
    expect(first.body.moveInReading).toBe(true);
    expect(holds()).toEqual(["worker"]);

    await expectResponsive();
    // Polled again while the listing is still held: answers with the last count, and starts no second listing.
    const again = await call("GET", "/api/setup?peek=1", undefined, 30_000);
    expect(again.status).toBe(200);
    expect(again.body.moveIn).toEqual({ grok: 0 });
    // The owner's own requests end too, on their own bound, with the server free meanwhile (never a hang for the length of the hold).
    const step = await call("GET", "/api/move-in/found", undefined, 10_000);
    expect(step.status).toBe(200);
    expect(step.body).toMatchObject({ grok: { count: 0 }, pending: true });
    expect(step.ms).toBeLessThan(MOVE_IN_WAIT_MS + 3000);
    await expectResponsive();
    const press = await call("POST", "/api/move-in/grok", {}, 10_000);
    expect(press.status).toBe(503);
    expect(press.ms).toBeLessThan(MOVE_IN_WAIT_MS + 3000);
    await expectResponsive();
    expect(holds()).toEqual(["worker"]);
  }, 90_000);

  it("still offers the Grok bots when discovery finishes after Hello", async () => {
    const opened = await call("GET", "/api/setup");
    expect(opened.status).toBe(200);
    const chiefId = opened.body.chiefBotId;
    expect(chiefId).toBeTruthy();
    const cards = async (): Promise<string[]> => {
      const bots = await call("GET", "/api/bots");
      expect(bots.status).toBe(200);
      return bots.body.bots.find((bot: { id: string }) => bot.id === chiefId).messages
        .flatMap((message: { card?: { setup?: { key: string } } }) => message.card?.setup ? [message.card.setup.key] : []);
    };
    const hello = await call("POST", "/api/setup/skip", { step: "hello" });
    expect(hello.status).toBe(200);
    expect(hello.body.steps).toContainEqual(expect.objectContaining({ id: "hello", skipped: true }));
    if (hello.body.next === "detect") {
      const detect = await call("POST", "/api/setup/answer", { step: "detect", answer: "Seen it" });
      expect(detect).toMatchObject({ status: 200, body: { next: "flux" } });
    } else {
      expect(hello.body.next).toBe("flux");
    }
    expect(holds()).toEqual(["worker"]);
    const whileHeld = await cards();
    const move = "detect:move-grok";
    const flux = "flux:key";
    expect(whileHeld).not.toContain(move);

    writeFileSync(join(fixture.info.dataDir, "downloads-listing-released"), "");
    await vi.waitFor(async () => {
      const updated = await call("GET", "/api/setup");
      expect(updated).toMatchObject({ status: 200, body: { moveIn: { grok: 1 } } });
    }, { timeout: 5000 });
    // Once the reading has settled the flag is gone, so an idle poll can sleep again.
    expect((await call("GET", "/api/setup")).body.moveInReading).toBeUndefined();
    const after = await cards();
    expect(after.filter((key) => key === move || key === flux)).toEqual([move, flux]);
    expect(whileHeld).not.toContain(flux);
    expect(holds()).toEqual(["worker"]);
  }, 30_000);
});
