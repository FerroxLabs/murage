import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// D5 and D12f on a real server: the two new first-run routes, their gates, and the idempotent settle.
const NEVER_ANSWERS = `process.env.FAKE_CLAUDE_MODE = "exit-early";\n`;

let box: VerificationServer;
let desktop: Record<string, string>;
const remote = { "x-murage-companion": "1" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) {
  const response = await fetch(`${box.info.url}${path}`, {
    method,
    headers: { ...(raw === undefined ? { "content-type": "application/json" } : { "content-type": "text/plain" }), ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

beforeAll(async () => {
  box = await launchVerificationServer(process.env, undefined, { instrumentationSource: NEVER_ANSWERS });
  const proof = await call("GET", "/api/desktop-secret");
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 120_000);
afterAll(async () => { await box?.close(); });

async function cardKeys(): Promise<string[]> {
  const bots = await call("GET", "/api/bots", undefined, desktop);
  const setup = await call("GET", "/api/setup", undefined, desktop);
  const chief = bots.body.bots.find((bot: { id: string }) => bot.id === setup.body.chiefBotId);
  return chief.messages.filter((m: any) => m.card?.setup).map((m: any) => m.card.setup.key as string);
}

describe("D5 POST /api/setup/card", () => {
  it("404 off desktop, 415 without JSON, 400 for a key off the allowlist", async () => {
    expect((await call("POST", "/api/setup/card", { key: "flux:notify", action: "settle" }, remote)).status).toBe(404);
    expect((await call("POST", "/api/setup/card", undefined, desktop, "key=flux:notify")).status).toBe(415);
    expect((await call("POST", "/api/setup/card", { key: "chat:jobs", action: "settle" }, desktop)).status).toBe(400);
    expect((await call("POST", "/api/setup/card", { key: "flux:notify", action: "open" }, desktop)).status).toBe(400);
  });
  it("answers 409 for a card that is not in the conversation yet, and never settles by a step", async () => {
    await call("GET", "/api/setup", undefined, desktop);
    expect((await call("POST", "/api/setup/card", { key: "flux:notify", action: "settle" }, desktop)).status).toBe(409);
    expect(await cardKeys()).not.toContain("flux:notify");
  });
});

describe("D12f POST /api/setup/hire", () => {
  it("404 off desktop, 415 without JSON, 400 for keys outside the starter packages", async () => {
    const body = { agents: [{ profileId: "starter-solo-business", key: "draft-partner" }] };
    expect((await call("POST", "/api/setup/hire", body, remote)).status).toBe(404);
    expect((await call("POST", "/api/setup/hire", undefined, desktop, "x")).status).toBe(415);
    expect((await call("POST", "/api/setup/hire", { agents: [{ profileId: "starter-personal-home", key: "x" }] }, desktop)).status).toBe(400);
    expect((await call("POST", "/api/setup/hire", { agents: [{ profileId: "starter-solo-business", key: "nope" }] }, desktop)).status).toBe(400);
  });
  it("hires once and a repeat returns the same bots without a second copy (D12c)", async () => {
    const body = { agents: [{ profileId: "starter-solo-business", key: "draft-partner" }] };
    const first = await call("POST", "/api/setup/hire", body, desktop);
    expect(first.status).toBe(200);
    expect(first.body.hired).toHaveLength(1);
    const again = await call("POST", "/api/setup/hire", body, desktop);
    expect(again.body.hired).toEqual(first.body.hired);
    const bots = await call("GET", "/api/bots", undefined, desktop);
    expect(bots.body.bots.filter((bot: { name: string }) => bot.name === "Draft Partner")).toHaveLength(1);
  });
});

describe("F4 GET /api/move-in/found", () => {
  it("403 for a paired or service caller, a label and count for the desktop", async () => {
    expect([403, 404]).toContain((await call("GET", "/api/move-in/found", undefined, remote)).status);
    expect([403, 404]).toContain((await call("GET", "/api/move-in/found", undefined, {})).status);
    const found = await call("GET", "/api/move-in/found", undefined, desktop);
    expect(found.status).toBe(200);
    expect(Object.keys(found.body.grok).sort()).toEqual(["count", "label"]);
  });
});

describe("D17b /api/owner/first-run-jobs", () => {
  it("is owner surfaces only, and validates ids", async () => {
    expect((await call("GET", "/api/owner/first-run-jobs", undefined, remote)).status).toBe(403);
    expect((await call("POST", "/api/owner/first-run-jobs", { pending: ["bogus"] }, desktop)).status).toBe(400);
    expect((await call("POST", "/api/owner/first-run-jobs", { pending: ["day", "notes"] }, desktop)).body.pending).toEqual(["day", "notes"]);
    expect((await call("GET", "/api/owner/first-run-jobs", undefined, desktop)).body.pending).toEqual(["day", "notes"]);
  });
});
