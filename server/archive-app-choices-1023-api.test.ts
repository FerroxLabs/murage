// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 ships the 1.0.22 Settings (Settings v10 moves whole to 1.0.24, MAIN-RULING 2026-11-26T17:34Z). The 1.0.22
// sidebar archives a bot with one PATCH { hidden: true } and no review step, so the server must take that PATCH for a
// bot whose app choices were saved: half of v10 (its 409 archive guard without its review dialog) refused it and the
// bot could not be archived at all. Real server, fake engine, throwaway data folder; app choices are saved through the
// shipped PUT /api/bots/:id/access route and the archive body is the sidebar's (src/components/Sidebar.tsx archiveBot).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");

let fixture: VerificationServer;
let desktop: Record<string, string>;

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...desktop },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json as Record<string, any>, text };
}

async function newBot(name: string): Promise<string> {
  const made = await call("POST", "/api/bots", { name });
  expect(made.status, made.text).toBe(201);
  return (made.body.bot as { id: string }).id;
}

async function listed(id: string): Promise<{ hidden?: boolean } | undefined> {
  const bots = await call("GET", "/api/bots");
  expect(bots.status, bots.text).toBe(200);
  return (bots.body.bots as Array<{ id: string; hidden?: boolean }>).find(bot => bot.id === id);
}

posixOnly("archiving a bot with saved app choices (1.0.22 Settings)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("the sidebar's one-click archive takes, the bot reads archived after a reload, and Restore brings it back", async () => {
    await newBot("Keeper");
    const id = await newBot("Shopper");
    const before = await call("GET", `/api/bots/${id}/access`);
    expect(before.status, before.text).toBe(200);
    const saved = await call("PUT", `/api/bots/${id}/access`, { action: "configure", revision: before.body.policy.revision, mode: "restricted", allowWrites: false, grants: [] });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.policy).toMatchObject({ mode: "restricted", revision: before.body.policy.revision + 1 });

    const archived = await call("PATCH", `/api/bots/${id}`, { hidden: true });
    expect(archived.status, archived.text).toBe(200);
    expect(archived.body.bot).toMatchObject({ id, hidden: true });
    expect(await listed(id)).toMatchObject({ hidden: true });

    const restored = await call("PATCH", `/api/bots/${id}`, { hidden: false });
    expect(restored.status, restored.text).toBe(200);
    expect((await listed(id))?.hidden).not.toBe(true);
  }, 60000);
});
