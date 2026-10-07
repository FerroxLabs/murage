// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/bots/:id/learning through the real routes: a real server with its own
// data directory and port, loopback only. Covers the B0 skeleton: desktop
// only, settings with a revision, the expected-revision and idempotency rules
// every mutation obeys, and the not-yet-built routes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let moss: { id: string };
let sequence = 0;
const key = () => `test-key-${++sequence}-${"x".repeat(8)}`;

const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as any };
};
const learning = (suffix = "") => `/api/bots/${moss.id}/learning${suffix}`;

posixOnly("bot learning routes", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const instances = (await call("GET", "/api/instances")).body.instances;
    const model = instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await call("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).body.bot;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is desktop only, and a missing bot or wrong method is refused plainly", async () => {
    expect((await call("GET", learning(), undefined, {})).status).toBe(404);
    expect((await call("GET", `/api/bots/no-such-bot/learning`)).status).toBe(404);
    expect((await call("DELETE", learning())).status).toBe(405);
  });

  it("a new bot learns from its owner by default, with revision 0", async () => {
    const answer = await call("GET", learning());
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ settings: { enabled: true, askFirst: false, prospectLearning: false }, revision: 0, readiness: { ready: false } });
  });

  it("a change needs the revision it was based on and an idempotency key", async () => {
    expect((await call("PATCH", learning(), { askFirst: true })).body.code).toBe("EXPECTED_REVISION_REQUIRED");
    expect((await call("PATCH", learning(), { expectedRevision: 0, askFirst: true })).body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("PATCH", learning(), { expectedRevision: 0, idempotencyKey: "short", askFirst: true })).status).toBe(400);
    expect((await call("GET", learning())).body.revision).toBe(0);
  });

  it("applies a change, bumps the revision, and refuses a stale one with the latest settings", async () => {
    const first = await call("PATCH", learning(), { expectedRevision: 0, idempotencyKey: key(), askFirst: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ settings: { askFirst: true, enabled: true }, revision: 1 });
    const stale = await call("PATCH", learning(), { expectedRevision: 0, idempotencyKey: key(), enabled: false });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "REVISION_CONFLICT", revision: 1, settings: { askFirst: true, enabled: true } });
    expect((await call("GET", learning())).body).toMatchObject({ settings: { askFirst: true }, revision: 1 });
  });

  it("a retried change gets the first answer and does not run twice; the same key for another request is refused", async () => {
    const retry = key();
    const first = await call("PATCH", learning(), { expectedRevision: 1, idempotencyKey: retry, prospectLearning: true });
    expect(first.body).toMatchObject({ settings: { prospectLearning: true }, revision: 2 });
    const again = await call("PATCH", learning(), { expectedRevision: 1, idempotencyKey: retry, prospectLearning: true });
    expect(again).toEqual(first);
    expect((await call("GET", learning())).body.revision).toBe(2);
    const other = await call("PATCH", learning(), { expectedRevision: 2, idempotencyKey: retry, enabled: false });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects values that are not on or off and settings that do not exist", async () => {
    expect((await call("PATCH", learning(), { expectedRevision: 2, idempotencyKey: key(), enabled: "off" })).status).toBe(400);
    expect((await call("PATCH", learning(), { expectedRevision: 2, idempotencyKey: key(), budget: 5 })).status).toBe(400);
    expect((await call("GET", learning())).body.revision).toBe(2);
  });

  it("the general bot PATCH cannot change learning settings", async () => {
    await call("PATCH", `/api/bots/${moss.id}`, { learning: { enabled: false, askFirst: true, prospectLearning: true, revision: 99 } });
    expect((await call("GET", learning())).body).toMatchObject({ settings: { enabled: true, prospectLearning: true }, revision: 2 });
  });

  it("outcomes are served by their own batch: a read, and a mark that needs a real reply to mark", async () => {
    expect((await call("GET", `/api/bots/${moss.id}/outcomes`)).body).toMatchObject({ outcomes: [], counts: { won: 0, lost: 0, proposed: 0 } });
    const noMessage = await call("POST", `/api/bots/${moss.id}/outcomes`, { threadId: "t", messageId: "nope", kind: "won", expectedRevision: 0, idempotencyKey: key() });
    expect(noMessage.status).toBe(404);
    const noRevision = await call("POST", `/api/bots/${moss.id}/outcomes`, { threadId: "t", messageId: "nope", kind: "won" });
    expect(noRevision.body.code).toBe("EXPECTED_REVISION_REQUIRED");
    expect((await call("PATCH", `/api/bots/${moss.id}/outcomes/none`, { answer: "won", expectedRevision: 0, idempotencyKey: key() })).status).toBe(404);
  });

  it("every other route exists: reads are empty, mutations say not available yet", async () => {
    for (const [path, field] of [["/outcomes", "outcomes"], ["/feedback", "feedback"], ["/lessons", "lessons"], ["/learning/examples", "examples"], ["/learning/runs", "runs"], ["/learning/suggestions", "suggestions"], ["/learning/history", "events"]] as const) {
      const answer = await call("GET", `/api/bots/${moss.id}${path}`);
      expect(answer, path).toMatchObject({ status: 200, body: { [field]: [] } });
      expect((await call("GET", `/api/bots/${moss.id}${path}`, undefined, {})).status, path).toBe(404);
    }
    // /lessons is claimed by B3 (bot-lessons-routes.ts), /outcomes by B1 (outcomes-routes.ts); both tested there.
    for (const path of ["/feedback", "/learning/runs", "/learning/runs/preview", "/learning/backfill", "/learning/history/abc/undo"]) {
      const answer = await call("POST", `/api/bots/${moss.id}${path}`, { expectedRevision: 0, idempotencyKey: key() });
      expect(answer, path).toMatchObject({ status: 501, body: { code: "LEARNING_NOT_AVAILABLE" } });
      expect(answer.body.error).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio/i);
    }
  });

  it("the prospect scope round-trips through PATCH and survives toggling the switch", async () => {
    const read = async () => (await call("GET", learning())).body;
    const rev = (await read()).revision;
    const set = await call("PATCH", learning(), { expectedRevision: rev, idempotencyKey: key(), prospectLearning: true, prospectThreadIds: ["th1", "th2"] });
    expect(set.body).toMatchObject({ settings: { prospectLearning: true, prospectThreadIds: ["th1", "th2"] } });
    const off = await call("PATCH", learning(), { expectedRevision: set.body.revision, idempotencyKey: key(), prospectLearning: false });
    expect(off.body.settings).toMatchObject({ prospectLearning: false, prospectThreadIds: ["th1", "th2"] });
    const bad = await call("PATCH", learning(), { expectedRevision: off.body.revision, idempotencyKey: key(), prospectThreadIds: "th1" });
    expect(bad.status).toBe(400);
    // put the shared fixture back as the next test expects it
    await call("PATCH", learning(), { expectedRevision: off.body.revision, idempotencyKey: key(), prospectThreadIds: [] });
  });
});
