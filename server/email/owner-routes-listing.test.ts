// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Batch D review (Fable, Lows at owner-routes.ts:238-240 and :247): the other-setups Remove names a failed Flux listing and carries a code on a non-404 Flux refusal.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute } from "./owner-routes.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import { EMAIL_OWNER_COPY, ownerRouteLine } from "../../shared/email-copy.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let runtime: EmailRuntime;
const call = (path: string, body: unknown) => emailOwnerRoute({ runtime, bot: () => undefined, fluxKeyPresent: () => true, freshProof: async () => null },
  { method: "POST", path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false });
const LISTED = { status: 200, body: { data: [{ id: "ibx_9", bot_id: "gone-bot", address: "old@murage.email", state: "active" }] } };

beforeEach(async () => {
  fake = new FakeFlux();
  runtime = new EmailRuntime({
    accountKey: () => "sk-flux-account-fixture", database: () => new DatabaseSync(":memory:"), transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    now: () => 1_800_000_000_000, workspaceRoot: () => undefined, bot: () => undefined,
  });
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
  await runtime.probe.refresh();
});

describe("other-setups Remove: Flux answers that are not a clean yes", () => {
  it("OS-1: the Flux listing fails: 503 with code other_setup_unavailable and a true line, 0 DELETEs", async () => {
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 503, body: { error: { code: "capability_unavailable" } } });
    const answer = await call("/api/email/other-setups/ibx_9/remove", { confirm: true });
    expect(answer?.status).toBe(503);
    expect(answer?.body.code).toBe("other_setup_unavailable");
    expect(answer?.body.error).toBe(ownerRouteLine("other_setup_unavailable"));
    expect(answer?.body.error).not.toBe(EMAIL_OWNER_COPY.actionFailed);
    expect(String(answer?.body.error)).not.toContain("not from another setup");
    expect(fake.calls("DELETE", /\/v1\/email\/inboxes\//)).toHaveLength(0);
  });
  it("OS-2: a listed address that is not another setup's stays 404 not from another setup", async () => {
    fake.always("GET", /^\/v1\/email\/inboxes$/, LISTED);
    const answer = await call("/api/email/other-setups/ibx_1/remove", { confirm: true });
    expect(answer?.status).toBe(404);
  });
  it("OS-3: a non-404 Flux refusal on the DELETE carries its code and rowId", async () => {
    fake.always("GET", /^\/v1\/email\/inboxes$/, LISTED);
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_9$/, fluxError(403, "inbox_account_mismatch"));
    const answer = await call("/api/email/other-setups/ibx_9/remove", { confirm: true });
    expect(answer?.status).toBe(403);
    expect(answer?.body.code).toBe("inbox_account_mismatch");
    expect(answer?.body.rowId).toBe("other_setup:ibx_9");
  });
  it("OS-4: a Flux refusal that names no code carries the code unavailable", async () => {
    fake.always("GET", /^\/v1\/email\/inboxes$/, LISTED);
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_9$/, { status: 500, body: {} });
    const answer = await call("/api/email/other-setups/ibx_9/remove", { confirm: true });
    expect(answer?.status).toBeGreaterThanOrEqual(500);
    expect(answer?.body.code).toBe("unavailable");
  });
});
