// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A share card whose row is gone (a downgrade and a reinstall drop room_shares; the card message stays) reads as closed. Only a 404 does
// that: any other failure keeps the old behaviour, no card and the bare ask text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";

const api = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));

import { loadRoomShare, RoomShareStatusLine } from "./RoomShareCard";

const html = (card: { status: string; botName: string } | null, gone: boolean) => renderToStaticMarkup(createElement(RoomShareStatusLine, { card, gone }));

describe("a share card whose row is gone", () => {
  beforeEach(() => { api.mockReset(); });

  it("a 404 marks the card gone, and a gone card shows the existing closed line", async () => {
    api.mockImplementation(async () => { throw Object.assign(new Error("no such share request"), { status: 404 }); });
    expect(await loadRoomShare("s1")).toEqual({ share: null, gone: true });
    expect(html(null, true)).toContain(t("roomShare.closed"));
  });

  it("any other failure keeps today's behaviour: no card, no closed line", async () => {
    for (const status of [403, 500, undefined]) {
      api.mockImplementation(async () => { throw Object.assign(new Error("nope"), { status }); });
      expect(await loadRoomShare("s1")).toEqual({ share: null, gone: false });
    }
    expect(html(null, false)).toBe("");
  });

  it("a row that is there still shows its own state line", async () => {
    api.mockResolvedValue({ share: { id: "s1", botName: "Dax", status: "shared", excerpts: [] } });
    const { share, gone } = await loadRoomShare("s1");
    expect(gone).toBe(false);
    expect(html(share, gone)).toContain(t("roomShare.shared", { name: "Dax" }));
    expect(html({ status: "declined", botName: "Dax" }, false)).toContain(t("roomShare.declined"));
    expect(html({ status: "pending", botName: "Dax" }, false)).toBe("");
  });
});
