// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

/** 04-B2: a paired phone sees the routines of the bots its sidebar shows, and
 * cannot start a run for a bot the owner archived. */
const COMPANION_TOKEN = "c".repeat(64);
const BARE = { "x-test-bare-loopback": "1" };
let fixture: VerificationServer;
let desktop: Record<string, string>;
const phone = { ...BARE, "x-murage-companion": "1", "x-murage-companion-token": COMPANION_TOKEN };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
}

let openRoutine = "";
let hiddenRoutine = "";

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_COMPANION_TOKEN: COMPANION_TOKEN } });
  const secret = await call("GET", "/api/desktop-secret", {});
  desktop = { ...BARE, "x-murage-surface": "desktop", "x-murage-surface-secret": String(secret.body!.secret) };
  const open = await call("POST", "/api/bots", desktop, { name: "Routine open" });
  const hidden = await call("POST", "/api/bots", desktop, { name: "Routine hidden" });
  const schedule = { type: "once", at: Date.now() + 3_600_000 };
  const a = await call("POST", "/api/routines", desktop, { botId: open.body!.bot.id, name: "Open routine", prompt: "open prompt", schedule });
  const b = await call("POST", "/api/routines", desktop, { botId: hidden.body!.bot.id, name: "Hidden routine", prompt: "hidden prompt", schedule });
  openRoutine = a.body!.routine.id;
  hiddenRoutine = b.body!.routine.id;
  expect((await call("PATCH", `/api/bots/${hidden.body!.bot.id}`, desktop, { hidden: true })).status).toBe(200);
});
afterAll(async () => { await fixture?.close(); });

describe("routines for an archived bot (04-B2)", () => {
  it("keeps an archived bot's routines off the phone list, and the desktop keeps them", async () => {
    const seen = (await call("GET", "/api/routines", phone)).body!.routines.map((r: { id: string }) => r.id);
    expect(seen).toContain(openRoutine);
    expect(seen).not.toContain(hiddenRoutine);
    const own = (await call("GET", "/api/routines", desktop)).body!.routines.map((r: { id: string }) => r.id);
    expect(own).toContain(hiddenRoutine);
  });

  it("refuses a phone run of an archived bot's routine", async () => {
    const refused = await call("POST", `/api/routines/${hiddenRoutine}/run`, phone);
    expect(refused.status).toBe(404);
    const runs = (await call("GET", "/api/routines", desktop)).body!.runs as Array<{ routineId: string }>;
    expect(runs.some((run) => run.routineId === hiddenRoutine)).toBe(false);
  });
});
