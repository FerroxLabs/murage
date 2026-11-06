// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B-PHONE-TURNSTATE (1.0.20, designs/L4B-PHONE-TURNSTATE-1020.md): GET /api/bots/:id/turn-state through the real HTTP routes on
// a verification server. The paired phone's door now forwards its launch proof on this read (companion/src/routes.ts
// OWNER_DECISION_ROUTES), and the harness gate stays mayApprove: the proof reads a state, the door marker alone or no proof reads
// none, and a thread of another bot is never answered. The reply is `{ state, endedAt? }` only.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, owner: Record<string, string> = {};
const COMPANION = "c".repeat(64); // the suite's launch secret (server/testing/setup.ts)
const phone = { "x-murage-companion": "1", "x-murage-companion-token": COMPANION, "x-murage-door-token": COMPANION };
const doorOnly = { "x-murage-companion": "1", "x-murage-door-token": COMPANION };
const bare = { "x-test-bare-loopback": "1" }; // server/testing/setup.ts stamps the door token on every other test fetch

const call = async (method: string, path: string, body?: unknown, headers = owner) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const turnState = (botId: string, threadId: string, headers: Record<string, string>, sendId = "help-question-0001") =>
  call("GET", `/api/bots/${botId}/turn-state?${new URLSearchParams({ threadId, sendId, turnId: "turn-9" })}`, undefined, headers);

beforeAll(async () => {
  // Set before companion-authority.ts reads the environment.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `process.env.MURAGE_COMPANION_TOKEN = ${JSON.stringify(COMPANION)};` });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

it("the paired phone's proof reads the turn state; the door marker alone or no proof reads none", async () => {
  const ava = (await call("POST", "/api/bots", { name: "Ava" })).body.bot;
  expect(typeof ava.threadId).toBe("string");

  // the desktop and the paired phone read the same answer (an unknown send is "unknown", never "ended")
  expect(await turnState(ava.id, ava.threadId, owner)).toEqual({ status: 200, body: { state: "unknown" } });
  expect(await turnState(ava.id, ava.threadId, phone)).toEqual({ status: 200, body: { state: "unknown" } });

  // a forwarded request without the owner proof, and a bare loopback caller: refused, never a state
  const marker = await turnState(ava.id, ava.threadId, doorOnly);
  expect(marker.status).toBe(403);
  expect(marker.body.state).toBeUndefined();
  const loopback = await turnState(ava.id, ava.threadId, bare);
  expect(loopback.status).toBe(404);
  expect(loopback.body.state).toBeUndefined();
  // a proof that is not this launch's secret is no proof
  const forged = await turnState(ava.id, ava.threadId, { ...phone, "x-murage-companion-token": "d".repeat(64) });
  expect([403, 404]).toContain(forged.status);
  expect(forged.body.state).toBeUndefined();
});

it("a thread of another bot is never answered, even with the phone's proof", async () => {
  const ava = (await call("POST", "/api/bots", { name: "Ava two" })).body.bot;
  const ben = (await call("POST", "/api/bots", { name: "Ben" })).body.bot;
  for (const headers of [phone, owner]) {
    const crossed = await turnState(ben.id, ava.threadId, headers);
    expect(crossed.status).toBe(404);
    expect(crossed.body.state).toBeUndefined();
    const own = await turnState(ben.id, ben.threadId, headers);
    expect(own.status).toBe(200);
    expect(Object.keys(own.body).every((key) => key === "state" || key === "endedAt")).toBe(true);
  }
  // a hidden bot reads, for the phone, like one that does not exist; the desktop still reads it
  expect((await call("PATCH", `/api/bots/${ben.id}`, { hidden: true })).status).toBe(200);
  const hidden = await turnState(ben.id, ben.threadId, phone);
  expect(hidden.status).toBe(404);
  expect(hidden.body.state).toBeUndefined();
  expect(await turnState(ben.id, ben.threadId, owner)).toEqual({ status: 200, body: { state: "unknown" } });
  // a bot that does not exist reads like any unknown bot
  const missing = await turnState("bot_missing", ava.threadId, phone);
  expect(missing.status).toBe(404);
  expect(missing.body.state).toBeUndefined();
});
