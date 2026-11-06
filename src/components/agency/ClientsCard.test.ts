// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L6C fallback (1.0.18, designs/UX-L6C-SWITCH-1018.md section 7): the Your clients card is copy only,
// shows only with a paired home read from the local state, and names, lists or contacts no home.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as slots from "@/components/shell/lane-slots";
import type { CloudHomeBridge } from "@/lib/cloud-workspace";
import { ClientsCard, ClientsCardView, hasPairedHome, useClientsTag } from "./ClientsCard";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const locale = (code: string) => JSON.parse(read(`../../locales/${code}.json`)) as Record<string, string>;
const KEYS = ["ux.l6c.title", "ux.l6c.levers"];
const PACKS = ["de", "es", "fr", "hi", "ja", "pt-br", "zh"];

function fakeBridge(state: () => Promise<unknown>) {
  const network = { listHomes: vi.fn(), listBots: vi.fn(), open: vi.fn(), connectStart: vi.fn() };
  const bridge = { state: vi.fn(state), onLive: vi.fn(() => () => undefined), ...network } as unknown as CloudHomeBridge;
  return { bridge, network };
}

describe("Your clients card (copy only)", () => {
  it("is the card Today renders through the lane slot, with no tag", () => {
    expect(slots.ClientsCard).toBe(ClientsCard);
    expect(slots.useClientsTag).toBe(useClientsTag);
    expect(useClientsTag()).toBeNull();
  });

  it("shows only when the local state has a paired home, and calls nothing but state", async () => {
    const one = fakeBridge(async () => ({ enabled: true, cpSignedIn: false, paired: [{ homeId: "home_acme", origin: "murage-home://home_acme" }] }));
    expect(await hasPairedHome(one.bridge)).toBe(true);
    const none = fakeBridge(async () => ({ enabled: true, cpSignedIn: true, paired: [] }));
    expect(await hasPairedHome(none.bridge)).toBe(false);
    const off = fakeBridge(async () => { throw new Error("isn't available"); });
    expect(await hasPairedHome(off.bridge)).toBe(false);
    const junk = fakeBridge(async () => ({ enabled: "yes", paired: "lots" }));
    expect(await hasPairedHome(junk.bridge)).toBe(false);
    expect(await hasPairedHome(undefined)).toBe(false);
    for (const { bridge, network } of [one, none, off, junk]) {
      expect(bridge.state).toHaveBeenCalledTimes(1);
      for (const spy of Object.values(network)) expect(spy).not.toHaveBeenCalled();
    }
  });

  it("renders nothing before the local state is read (solo owner, first paint)", () => {
    expect(renderToStaticMarkup(createElement(ClientsCard, { onOpenWorkspace: vi.fn(), onOpenUsage: vi.fn() }))).toBe("");
  });

  it("teaches the three levers and names no home", () => {
    const markup = renderToStaticMarkup(createElement(ClientsCardView));
    expect(markup).toContain(">Your clients<");
    expect(markup).toContain("pause its routines in Routines");
    expect(markup).toContain("unlink its messaging apps in Settings");
    expect(markup).toContain("disconnect Flux Router in Settings");
    expect(markup).toContain("resume the routines, link the apps again and reconnect Flux Router");
    expect(markup).not.toMatch(/home_|<button|<a /);
  });

  it("makes no request and reads no home list", () => {
    const source = read("./ClientsCard.tsx");
    expect(source).not.toMatch(/listHomes|listBots|fetch\(|\.open\(|connectStart/);
  });

  it("keeps its copy in every pack, translated with a source hash, in house words", () => {
    const en = locale("en");
    const hashes = (JSON.parse(read("../../locales/source-hashes.json")) as { locales: Record<string, Record<string, string>> }).locales;
    for (const key of KEYS) {
      expect(en[key], key).toBeTruthy();
      for (const code of ["en", ...PACKS]) expect(locale(code)[key], `${code} ${key}`).not.toMatch(/—|\b(safe|free|Forge)\b/i);
      for (const code of PACKS) {
        expect(locale(code)[key], `${code} ${key}`).toBeTruthy();
        expect(locale(code)[key], `${code} ${key} is translated`).not.toBe(en[key]);
        expect(hashes[code]![key], `${code} ${key} hash`).toBe(createHash("sha256").update(en[key]!).digest("hex"));
      }
    }
  });
});
