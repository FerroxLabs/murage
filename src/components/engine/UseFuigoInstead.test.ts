// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.14 FIRST-ENGINE-REPICK F0 and section 6: on a sign-in wall "Use Fuigo instead" is the primary button and the engine's own sign-in
// the secondary one, shown only when Fuigo can answer now; the tap sends the engineRev the card was drawn with and the chat it was
// drawn in, and nothing presses it. 1.0.15 M5: with no Fuigo able to answer, the wall leads with the Flux key card.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { EngineSignInButton } from "../EngineSignInButton";
import { UseFuigoInstead, fuigoTapRequest, offersFuigo, runFuigoTap, usableFuigo, wallLead } from "./UseFuigoInstead";

const api = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: (...args: unknown[]) => api(...args) }));
vi.mock("../FluxKeyCard", () => ({ FluxKeyCard: () => createElement("button", { "data-flux-key-card": "" }, "Open Flux Router in Models") }));
afterEach(() => { api.mockClear(); });

const engine = (instanceId: string, driverKind: string, models: string[], extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: driverKind === "fuigoAgent" ? "Fuigo" : "Claude", enabled: true,
  snapshot: { state: "available" }, models: { default: "", options: models.map((id) => ({ id, label: id })) }, ...extra,
} as InstanceInfo);

const FUIGO = engine("fuigo", "fuigoAgent", ["login/m1"]);
const NO_KEY = engine("fuigo", "fuigoAgent", []);
const CLAUDE = engine("claude", "claudeAgent", ["sonnet"]);
const onClaude = { id: "b1", threadId: "t-own", modelSelection: { instanceId: "claude", model: "sonnet" }, engineRev: 3 };

function wall(instances: InstanceInfo[], bot = onClaude) {
  const signIn = createElement(EngineSignInButton, { instanceId: "claude", name: "Claude", quiet: true, bridge: {} as never });
  return renderToStaticMarkup(createElement(UseFuigoInstead, { bot, engineName: "Claude", instances, children: signIn }));
}

describe("F0: Fuigo front and center on the sign-in wall", () => {
  it("Use Fuigo instead is the primary button on the sign-in wall, desktop and Cloud", () => {
    const html = wall([FUIGO, CLAUDE]);
    expect(html).toContain("Claude needs your own Claude account to sign in.");
    expect(html).toContain("Use Fuigo instead");
    const primary = html.indexOf("data-use-fuigo-primary"), signIn = html.indexOf("data-engine-signin-button");
    expect(primary).toBeGreaterThan(-1);
    expect(signIn).toBeGreaterThan(primary);
    // the Fuigo button carries the accent (primary) style, the sign-in the quiet one
    expect(html.slice(primary, signIn)).toContain("bg-accent");
    expect(html.slice(signIn)).not.toContain("bg-accent");
    expect(html).not.toContain("data-flux-key-card");
  });

  it("with no key the wall leads with the Flux key card and the engine's sign-in comes second", () => {
    for (const instances of [[NO_KEY, CLAUDE], [CLAUDE]]) {
      expect(wallLead(onClaude, instances)).toBe("fluxKey");
      const html = wall(instances);
      expect(html).not.toContain("Use Fuigo instead");
      const flux = html.indexOf("data-flux-key-card"), signIn = html.indexOf("data-engine-signin-button");
      expect(flux).toBeGreaterThan(-1);
      expect(signIn).toBeGreaterThan(flux);
      expect(html.slice(signIn)).not.toContain("bg-accent");
    }
    expect(usableFuigo([NO_KEY, CLAUDE])).toBeUndefined();
  });

  it("two usable Fuigo engines lead with neither: the owner picks", () => {
    const two = [FUIGO, engine("fuigo2", "fuigoAgent", ["x"]), CLAUDE];
    expect(usableFuigo(two)).toBeUndefined();
    expect(wallLead(onClaude, two)).toBeNull();
    const html = wall(two);
    expect(html).not.toContain("Use Fuigo instead");
    expect(html).not.toContain("data-flux-key-card");
    expect(html).toContain("data-engine-signin-button");
  });

  it("a bot on Fuigo gets no extra lead (its own wall already holds the Flux key card)", () => {
    expect(wallLead({ modelSelection: { instanceId: "fuigo", model: "" } }, [NO_KEY, CLAUDE])).toBeNull();
    expect(wallLead({ modelSelection: { instanceId: "fuigo", model: "login/m1" } }, [FUIGO, CLAUDE])).toBeNull();
  });

  it("a Chief or Ember already on Claude shows Use Fuigo instead once Fuigo is usable, and only the tap moves it", async () => {
    expect(offersFuigo(onClaude, [CLAUDE])).toBe(false);
    expect(offersFuigo(onClaude, [FUIGO, CLAUDE])).toBe(true);
    expect(offersFuigo({ modelSelection: { instanceId: "fuigo", model: "login/m1" } }, [FUIGO, CLAUDE])).toBe(false);
    // drawing the wall calls nothing: nothing is pressed for the owner
    wall([FUIGO, CLAUDE]);
    wall([NO_KEY, CLAUDE]);
    expect(api).not.toHaveBeenCalled();
    // one press posts the revision the card was drawn with and the chat it was drawn in, once
    expect(await runFuigoTap(onClaude)).toBe("");
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]).toEqual(fuigoTapRequest(onClaude));
    expect(api.mock.calls[0]![0]).toBe("/api/bots/b1/use-fuigo");
    expect(JSON.parse((api.mock.calls[0]![1] as { body: string }).body)).toEqual({ engineRev: 3, threadId: "t-own" });
  });

  it("a stale tap shows the server's words and sends nothing more", async () => {
    const stale = vi.fn(async () => { throw Object.assign(new Error("This bot's engine changed. Check it and try again."), { status: 409 }); });
    expect(await runFuigoTap(onClaude, stale)).toBe("This bot's engine changed. Check it and try again.");
    const notReady = vi.fn(async () => { throw Object.assign(new Error("Fuigo is not ready yet."), { status: 409 }); });
    expect(await runFuigoTap(onClaude, notReady)).toBe("Fuigo is not ready yet.");
    expect(stale).toHaveBeenCalledTimes(1);
    expect(notReady).toHaveBeenCalledTimes(1);
  });
});
