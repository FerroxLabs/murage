// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 gap check H3 (LOCKED 2.4). A paired phone and a Cloud window get Models & engines read-only: the engine list as a
// readout, every card that takes a key or a command line as the onComputer stub, and no key field anywhere. A paired
// phone gets Calls with a working "off for today" (the server admits it from a companion). The desktop keeps every
// control live. The heavy desktop editors are stand-ins here: what is under test is which of them the page mounts.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), tts: undefined as import("@/state/store").ConfigStatus["tts"] }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: { bots: [], config: fixture.tts ? { tts: fixture.tts } : null, instances: [{ instanceId: "fixture-claude", displayName: "Claude Code", driverKind: "claude", enabled: true, snapshot: { state: "ready" } }] },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("@/components/today/use-engine-health", () => ({ useEngineHealthAnswer: () => null }));
vi.mock("../ModelsSettings", () => ({ ModelsSettings: () => <input data-stand-in="models-settings" type="password" aria-label="API key" /> }));
vi.mock("../EnginesSettings", () => ({ EnginesSettings: () => <div data-stand-in="engines-settings"><button>Disable</button></div> }));
vi.mock("../PasteKeys", () => ({ PasteKeys: () => <textarea data-stand-in="paste-keys" aria-label="Paste keys" /> }));
vi.mock("./rows/BotRows", () => ({ NewBotEffortRow: () => <div data-stand-in="effort" /> }));

import ModelsPage, { modelsLive } from "./pages/ModelsPage";
import CallsPage from "./pages/CallsPage";
import ConnectionsPage from "./pages/ConnectionsPage";
import { VoiceSettings } from "../VoiceSettings";
import { ImageSettingsView } from "../ImageSettings";
import type { Bot } from "@/state/store";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.api.mockReset();
  fixture.dispatch.mockClear();
  fixture.tts = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (node: React.ReactNode) => { await act(async () => { root.render(node); }); await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const page = (desktop: boolean | undefined, cloud: boolean) => <ModelsPage page="models" mode="advanced" desktop={desktop} cloud={cloud} anchor={null} />;

describe("H3: Models & engines away from the desktop", () => {
  it.each([["a paired phone", false, false], ["a Cloud window", true, true]] as const)("on %s: the engine readout, stubs for key cards, no key field", async (_name, desktop, cloud) => {
    expect(modelsLive({ desktop, cloud })).toBe(false);
    await render(page(desktop, cloud));
    expect(container.querySelector('[data-engine-readout="fixture-claude"]')?.textContent).toContain("Claude Code");
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(container.querySelector("[data-stand-in]")).toBeNull();
    for (const anchor of ["paste-any-keys", "models-heading", "existing-keys-heading", "engine-command-lines-heading"]) {
      expect(container.querySelector(`[data-testid="settings-stub-${anchor}"]`), anchor).not.toBeNull();
    }
  });

  it("on the desktop: the live editors, no readout", async () => {
    expect(modelsLive({ desktop: true, cloud: false })).toBe(true);
    await render(page(true, false));
    expect(container.querySelector('[data-stand-in="engines-settings"]')).not.toBeNull();
    expect(container.querySelector('[data-stand-in="models-settings"]')).not.toBeNull();
    expect(container.querySelector("[data-engines-readout]")).toBeNull();
  });
});

describe("H3: Calls on a paired phone", () => {
  it("turns calls off for today from the phone", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/calls/active") return { offUntil: null };
      if (path.startsWith("/api/calls/history")) return { items: [], next: null };
      if (path === "/api/calls/off-today") return { offUntil: Date.now() + 3_600_000 };
      throw new Error(`unexpected ${path}`);
    });
    await render(<CallsPage page="calls" mode="advanced" desktop={false} cloud={false} anchor={null} />);
    const sw = container.querySelector<HTMLButtonElement>('[data-setting-control="calls-settings-title"]')!;
    expect(sw).not.toBeNull();
    expect(sw.disabled).toBe(false);
    await act(async () => { sw.click(); });
    expect(fixture.api).toHaveBeenCalledWith("/api/calls/off-today", expect.objectContaining({ method: "POST" }));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    // The bots' own calling setup (voice account, numbers) stays on the computer.
    expect(container.querySelector('[data-testid="settings-stub-phone-calls-heading"]')).not.toBeNull();
  });
});

it("mounts the phone calls card only in Calls and links there from Connected apps", async () => {
  fixture.api.mockResolvedValue({ items: [], next: null });
  await render(<>
    <CallsPage page="calls" mode="advanced" desktop={false} cloud={false} anchor={null} />
    <ConnectionsPage page="connections" mode="advanced" desktop={false} cloud={false} anchor={null} />
  </>);
  expect(container.querySelectorAll("#phone-calls-heading")).toHaveLength(1);
  const link = [...container.querySelectorAll("button")].find(button => button.textContent === "Phone calls");
  expect(link).toBeDefined();
  await act(async () => { link!.click(); });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "calls", anchor: "phone-calls-heading" });
});

it("waits for the server's voice provider and honors an explicit bot choice", async () => {
  const bot = { id: "voice-fixture", name: "Voice fixture" } as Bot;
  const voice = (current: Bot = bot) => <VoiceSettings bot={current} onPatch={vi.fn()} />;
  const selected = () => container.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
  fixture.api.mockResolvedValue({ voices: [] });
  fixture.tts = { configured: true, ready: true, voice: "", routes: { speech: "flux", host: null, lookup: null, transcribe: null } };
  await render(voice());
  expect(selected()).toBeUndefined();
  expect(fixture.api).not.toHaveBeenCalled();
  fixture.tts = { ...fixture.tts, provider: "flux" };
  await render(voice());
  expect(selected()).toBe("Flux");
  expect(fixture.api).toHaveBeenCalledWith("/api/tts/voices?provider=flux");
  await render(voice({ ...bot, voiceProvider: "elevenlabs" }));
  expect(selected()).toBe("ElevenLabs");
});

it("shows the image request switch only once the server has reported its state", async () => {
  const onChange = vi.fn();
  const view = (snapshot: React.ComponentProps<typeof ImageSettingsView>["snapshot"]) =>
    <ImageSettingsView snapshot={snapshot} busy={snapshot ? null : "load"} error="" notice="" onChange={onChange} onRefresh={vi.fn()} />;
  const toggle = () => container.querySelector<HTMLButtonElement>('[aria-labelledby="image-settings-allow"]');
  await render(view(null));
  expect(toggle()).toBeNull();
  await render(view({ enabled: true, connections: [], selected: null, catalog: null }));
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => { toggle()!.click(); });
  expect(onChange).toHaveBeenCalledWith({ enabled: false });
});
