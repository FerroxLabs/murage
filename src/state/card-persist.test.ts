// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { CARD_NOT_SAVED, persistCardPatch } from "./card-persist.ts";

afterEach(() => vi.unstubAllGlobals());

describe("persistCardPatch", () => {
  it("sends the patch with the surface headers and resolves when the harness accepts it", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(persistCardPatch("b1", "m1", { dismissed: true }, { "x-murage-surface-secret": "s" })).resolves.toBeUndefined();
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/bots/b1/cards/m1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ dismissed: true }));
    expect(init.headers).toMatchObject({ "x-murage-surface": "desktop", "x-murage-surface-secret": "s" });
  });

  it("rejects with plain copy on a refusal, so the phone shows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such route" }), { status: 404 })));
    await expect(persistCardPatch("b1", "m1", { dismissed: true }, {})).rejects.toThrow(CARD_NOT_SAVED);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(persistCardPatch("b1", "m1", { dismissed: true }, {})).rejects.toThrow(CARD_NOT_SAVED);
  });

  it("rejects with the same copy when the network drops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(persistCardPatch("b1", "m1", { answered: "Yes", dismissed: true }, {})).rejects.toThrow(CARD_NOT_SAVED);
  });

  it("copy has no em dash and none of the banned words", () => {
    expect(CARD_NOT_SAVED).not.toMatch(/—|safe|safety|unsafe|composio/i);
  });
});
