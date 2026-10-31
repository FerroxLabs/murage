// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot e3b9af254: a stored Composio Session is reused only while it belongs to the installation's
// own Composio user, and a freshly created Session naming another user is refused, so connected apps never attach to
// another user's Session.
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationRow } from "./index";
import { createSession, ensureSession } from "./index";

const multiAccount = { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true };
const wire = (id: string, userId?: string) => ({
  session_id: id,
  mcp: { url: `https://mcp.composio.dev/${id}` },
  config: { ...(userId ? { user_id: userId } : {}), multi_account: multiAccount },
});
const row = (overrides: Partial<InstallationRow> = {}): InstallationRow => ({
  id: "install-1", composio_user_id: "murage_mine", session_id: "trs_stored", disabled_at: null,
  claim_issued_at: null, claim_confirmed_at: null, last_claim_jti: null, ...overrides,
});
function env() {
  const writes: unknown[][] = [];
  return {
    writes,
    env: {
      COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1", COMPOSIO_API_KEY: "ak_test",
      SESSION_LIMITER: { limit: async () => ({ success: true }) },
      DB: { prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push(values); } }) }) },
    } as never,
    ctx: { waitUntil(promise: Promise<unknown>) { void promise; } } as never,
  };
}
afterEach(() => vi.unstubAllGlobals());

it.each([["another user's", "murage_other"], ["an unnamed", undefined]])("replaces %s stored Session with one for this installation's user", async (_label, storedUser) => {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json(wire("trs_fresh", "murage_mine"), { status: 201 }); }
    return Response.json(wire("trs_stored", storedUser));
  });
  const { env: e, ctx, writes } = env();
  await expect(ensureSession(row(), e, ctx)).resolves.toMatchObject({ sessionId: "trs_fresh", userId: "murage_mine" });
  expect(posts).toMatchObject([{ user_id: "murage_mine" }]);
  expect(writes.some((values) => values[0] === "trs_fresh" && values[2] === "install-1")).toBe(true);
});

it("keeps reusing a stored Session that belongs to this installation's user", async () => {
  const posts: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(init.body);
    return Response.json(wire("trs_stored", "murage_mine"));
  });
  const { env: e, ctx } = env();
  await expect(ensureSession(row(), e, ctx)).resolves.toMatchObject({ sessionId: "trs_stored" });
  expect(posts).toEqual([]);
});

it("refuses a created Session that names another user, and stamps an unnamed one with the requested user", async () => {
  const { env: e } = env();
  vi.stubGlobal("fetch", async () => Response.json(wire("trs_wrong", "murage_other"), { status: 201 }));
  await expect(createSession(e, "murage_mine")).rejects.toThrow(/another user/);
  vi.stubGlobal("fetch", async () => Response.json(wire("trs_plain"), { status: 201 }));
  await expect(createSession(e, "murage_mine")).resolves.toMatchObject({ sessionId: "trs_plain", userId: "murage_mine" });
});
