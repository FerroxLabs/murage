// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The open desktop viewer keeps the VM's idle timer fresh (104 item 103).
import { describe, expect, it } from "vitest";
import { STATE_ONLY_SELECTION, desktopApi, phoneApi } from "./testing/index-harness.ts";

describe("POST /api/bots/:id/local-computer/keepalive", () => {
  it("answers the desktop, and only the desktop", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const ok = await desktopApi("POST", `/api/bots/${bot.id}/local-computer/keepalive`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect([403, 404]).toContain((await phoneApi("POST", `/api/bots/${bot.id}/local-computer/keepalive`)).status);
    expect((await desktopApi("POST", "/api/bots/no-such-bot/local-computer/keepalive")).status).toBe(404);
  });
});
