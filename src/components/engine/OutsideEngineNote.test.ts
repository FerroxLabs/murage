// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 (1.0.18, MurageMain ruling): the card No limits raises for a turn on an engine Murage does not see in full
// says so in one plain line, names the engines that show their tools, and offers Switch to Fuigo, the same move the
// sign-in wall's "Use Fuigo instead" makes (POST /api/bots/:id/use-fuigo). Only on that card, never on another outside card.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ desktop: true as boolean | undefined }));
const instances = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => surface.desktop, useSurfaceState: () => ({ desktop: surface.desktop, confirmed: true }) }));
vi.mock("@/lib/native-shell", () => ({ inNativeShell: () => false }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const store = { state: { bots: [], routines: [], get instances() { return instances.list; } }, dispatch: () => undefined };
  return { ...actual, useStore: () => store, useStoreIfAny: () => store };
});

import type { Bot, InstanceInfo, Message } from "@/state/store";
import { loadPlainApproval } from "@/lib/plain-approval";
import { PendingApprovalPanel, pendingOf } from "../PendingApproval";
import { fuigoTapRequest } from "./UseFuigoInstead";
import { switchToFuigo } from "./OutsideEngineNote";
import { outsideTurnNote } from "../../../server/auto-approve.ts";

beforeAll(() => loadPlainApproval());
afterEach(() => { surface.desktop = true; instances.list = [FUIGO, KIMI]; });

const engine = (instanceId: string, driverKind: string, displayName: string, models: string[]): InstanceInfo => ({
  instanceId, driverKind, displayName, enabled: true,
  snapshot: { state: "available" }, models: { default: "", options: models.map((id) => ({ id, label: id })) },
} as InstanceInfo);
const FUIGO = engine("fuigo", "fuigoAgent", "Fuigo", ["login/m1"]);
const KIMI = engine("kimi", "kimiAgent", "Kimi", ["k2"]);
instances.list = [FUIGO, KIMI];

const BOT = { id: "b1", name: "Sable", autoApprove: true, threadId: "t1", modelSelection: { instanceId: "kimi", model: "k2" }, engineRev: 3 } as unknown as Bot;
const LINE = "Kimi doesn't show Murage which tools it uses, so No limits still asks here. Fuigo, Claude, Codex, Gemini and Grok don't.";
const OUTSIDE_CLASS = { reason: "outside-turn", unattended: false, automated: false, keys: [] };
const WHY = { key: "ux.l1.why.outsideContent", params: {} };

function message(card: Record<string, unknown>): Message {
  return {
    id: "m1", role: "bot", kind: "options", at: 1, from: { botId: "b1", name: "Sable" },
    card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], tool: "Bash", requestId: "req-1", ...card },
  } as unknown as Message;
}
const unescape = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&");
const panel = (card: Record<string, unknown>) =>
  unescape(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pendingOf(message(card)), who: "Sable", bot: BOT, threadId: "t1" })));

const KIMI_CARD = { cardClass: OUTSIDE_CLASS, why: WHY, held: outsideTurnNote("outside tool"), outsideEngine: { driver: "kimiAgent", name: "Kimi" } };

describe("the uncovered-engine card", () => {
  it("shows the owner line, with the engine's name, and Switch to Fuigo", () => {
    const html = panel(KIMI_CARD);
    expect(html).toContain(LINE);
    expect(html).toContain("data-outside-engine");
    expect(html).toMatch(/<button[^>]*data-switch-fuigo[^>]*>Switch to Fuigo<\/button>/);
  });

  it("names the engine the card carries", () => {
    const html = panel({ ...KIMI_CARD, outsideEngine: { driver: "customAcp", name: "My Agent" } });
    expect(html).toContain("My Agent doesn't show Murage which tools it uses, so No limits still asks here.");
  });

  it("keeps the line but offers no switch when Fuigo cannot answer now, or off the desktop", () => {
    instances.list = [KIMI];
    let html = panel(KIMI_CARD);
    expect(html).toContain(LINE);
    expect(html).not.toContain("data-switch-fuigo");
    instances.list = [FUIGO, KIMI];
    surface.desktop = false;
    html = panel(KIMI_CARD);
    expect(html).toContain(LINE);
    expect(html).not.toContain("data-switch-fuigo");
  });

  it("another outside card shows neither the line nor the button", () => {
    for (const card of [
      { cardClass: OUTSIDE_CLASS, why: WHY, held: outsideTurnNote("web page") },
      { cardClass: OUTSIDE_CLASS, why: WHY, held: outsideTurnNote("outside tool") },
      { held: "This action may be destructive. Review it before allowing it." },
    ]) {
      const html = panel(card);
      expect(html).not.toContain("doesn't show Murage which tools it uses");
      expect(html).not.toContain("data-outside-engine");
      expect(html).not.toContain("Switch to Fuigo");
    }
  });

  it("Switch to Fuigo makes the app's existing move to Fuigo: the sign-in wall's use-fuigo tap, with the bot as drawn", async () => {
    const call = vi.fn(async (..._args: unknown[]) => ({}));
    expect(await switchToFuigo(BOT, call as never)).toBe("");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual(fuigoTapRequest(BOT));
    expect(call.mock.calls[0]![0]).toBe("/api/bots/b1/use-fuigo");
    expect(JSON.parse((call.mock.calls[0]![1] as { body: string }).body)).toEqual({ engineRev: 3, threadId: "t1" });
    // the server's words come back for the card's note (a stale engine, or Fuigo not ready)
    const refused = vi.fn(async () => { throw new Error("This bot's engine changed. Check it and try again."); });
    expect(await switchToFuigo(BOT, refused as never)).toBe("This bot's engine changed. Check it and try again.");
  });
});

describe("the line and the button in every pack", () => {
  const DIR = fileURLToPath(new URL("../../locales/", import.meta.url));
  const codes = readdirSync(DIR).filter((file) => file.endsWith(".json") && file !== "source-hashes.json").map((file) => file.slice(0, -5)).sort();
  const load = (code: string) => JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
  it("English carries the ruled words", () => {
    const en = load("en");
    expect(en["noLimits.v1.engineAsks"]).toBe("{engine} doesn't show Murage which tools it uses, so No limits still asks here. Fuigo, Claude, Codex, Gemini and Grok don't.");
    expect(en["noLimits.v1.switchToFuigo"]).toBe("Switch to Fuigo");
  });
  it("all 8 packs have both, keep {engine} and the product names, and use plain words", () => {
    expect(codes).toEqual(["de", "en", "es", "fr", "hi", "ja", "pt-br", "zh"]);
    for (const code of codes) {
      const pack = load(code);
      const line = pack["noLimits.v1.engineAsks"], button = pack["noLimits.v1.switchToFuigo"];
      expect(line, code).toBeTruthy();
      expect(button, code).toBeTruthy();
      expect(line).toContain("{engine}");
      for (const name of ["Murage", "Fuigo", "Claude", "Codex", "Gemini", "Grok"]) expect(line, `${code}:${name}`).toContain(name);
      expect(button).toContain("Fuigo");
      for (const text of [line, button]) expect(text, code).not.toMatch(/—|\bsafe\b|\bfree\b|\bForge\b/i);
    }
  });
});
