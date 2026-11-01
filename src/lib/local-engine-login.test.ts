// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The renderer's side of the desktop sign-in bridge, against a mock of it. A dialog that opens starts nothing.
import { describe, expect, it, vi } from "vitest";

import { LOCAL_ENGINE_LOGIN_CHANNELS, LOCAL_LOGIN_TERMINAL_OFFER_MS, engineSignInSurface, openLocalLogin, type LocalEngineLoginBridge, type LocalEngineLoginClosed, type LocalEngineLoginData, type LocalEngineLoginPreview, type LocalEngineLoginStartResult, type LocalLoginState } from "./local-engine-login";

const preview: LocalEngineLoginPreview = { ok: true, kind: "headless", label: "Grok", accountRoot: "/fixture/.grok" };

function mock({ view = preview, start = { ok: true, id: "s1" } as LocalEngineLoginStartResult, terminal = { ok: true, id: "s2" } as LocalEngineLoginStartResult } = {}) {
  const data = new Set<(payload: LocalEngineLoginData) => void>();
  const closed = new Set<(payload: LocalEngineLoginClosed) => void>();
  const bridge = {
    preview: vi.fn(async () => view),
    start: vi.fn(async () => start),
    stop: vi.fn(async () => ({ ok: true as const })),
    openTerminal: vi.fn(async () => terminal),
    onData(listener: (payload: LocalEngineLoginData) => void) { data.add(listener); return () => { data.delete(listener); }; },
    onClosed(listener: (payload: LocalEngineLoginClosed) => void) { closed.add(listener); return () => { closed.delete(listener); }; },
  } satisfies LocalEngineLoginBridge;
  return { bridge, data, closed, emit: (payload: LocalEngineLoginData) => data.forEach((fn) => fn(payload)), close: (payload: LocalEngineLoginClosed) => closed.forEach((fn) => fn(payload)) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function run(rig: ReturnType<typeof mock>) {
  const states: LocalLoginState[] = [];
  const later: Array<() => void> = [];
  const timers = { setTimeout: ((fn: () => void, ms: number) => { expect(ms).toBe(LOCAL_LOGIN_TERMINAL_OFFER_MS); later.push(fn); return later.length; }) as unknown as typeof setTimeout, clearTimeout: ((handle: number) => { later[handle - 1] = () => {}; }) as unknown as typeof clearTimeout };
  const session = openLocalLogin({ bridge: rig.bridge, instanceId: "grok", onState: (state) => states.push(state), timers });
  return { session, states, later, last: () => states.at(-1)! };
}

describe("the bridge contract", () => {
  it("names exactly the agreed channels", () => {
    expect([...LOCAL_ENGINE_LOGIN_CHANNELS]).toEqual(["preview", "start", "stop", "open-terminal", "data", "closed"].map((name) => `local-engine-login:${name}`));
  });
  it("the window decides the surface: a Cloud home first, then whether the bridge exists", () => {
    const doc = (homeId: string | null) => ({ querySelector: () => (homeId ? { getAttribute: () => homeId } : null) }) as unknown as Pick<Document, "querySelector">;
    const { bridge } = mock();
    expect(engineSignInSurface(bridge, doc(null))).toBe("desktop");
    expect(engineSignInSurface(null, doc(null))).toBe("elsewhere");
    expect(engineSignInSurface(bridge, doc("home-1"))).toBe("cloud-home");
  });
});

describe("a dialog", () => {
  it("reads the preview and starts nothing until the press inside it", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    expect(last()).toMatchObject({ phase: "ready", kind: "headless", label: "Grok", accountRoot: "/fixture/.grok" });
    expect(rig.bridge.start).not.toHaveBeenCalled();
    await session.open();
    expect(rig.bridge.start).toHaveBeenCalledTimes(1);
    expect(rig.bridge.start).toHaveBeenCalledWith({ instanceId: "grok" });
    expect(last().phase).toBe("waiting");
  });
  it("a second press does nothing", async () => {
    const rig = mock();
    const { session } = run(rig);
    await settle();
    await session.open();
    await session.open();
    expect(rig.bridge.start).toHaveBeenCalledTimes(1);
  });
  it("offers Terminal after 45 seconds of waiting", async () => {
    const rig = mock();
    const { session, later, last } = run(rig);
    await settle();
    await session.open();
    expect(last().slow).toBeFalsy();
    later[0]!();
    expect(last().slow).toBe(true);
  });
  it("Finishing, then the final word", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    await session.open();
    rig.emit({ id: "s1", finishing: true });
    expect(last().phase).toBe("finishing");
    rig.close({ id: "s1", result: "signed-in" });
    expect(last()).toMatchObject({ phase: "closed", result: "signed-in" });
  });
  it("hears nothing of another session", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    await session.open();
    rig.close({ id: "other", result: "signed-in" });
    expect(last().phase).toBe("waiting");
  });
  it("a word that lands before start answers is held for its id", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    const pressed = session.open();
    rig.close({ id: "s1", result: "not-finished" });
    await pressed;
    expect(last()).toMatchObject({ phase: "closed", result: "not-finished" });
  });
  it("a refused start says main's line", async () => {
    const rig = mock({ start: { ok: false, code: "busy", message: "Another sign-in is already open." } });
    const { session, last } = run(rig);
    await settle();
    await session.open();
    expect(last()).toMatchObject({ phase: "refused", message: "Another sign-in is already open." });
  });
  it("closing while it runs stops that session, and a start still on its way when it lands", async () => {
    const rig = mock();
    const { session } = run(rig);
    await settle();
    await session.open();
    session.stop();
    session.stop();
    expect(rig.bridge.stop).toHaveBeenCalledTimes(1);
    expect(rig.bridge.stop).toHaveBeenCalledWith({ id: "s1" });
    const second = mock();
    const racing = run(second);
    await settle();
    const pressed = racing.session.open();
    racing.session.stop();
    await pressed;
    expect(second.bridge.stop).toHaveBeenCalledWith({ id: "s1" });
  });
});

describe("Terminal", () => {
  it("takes over from a running sign-in and follows the new session", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    await session.open();
    await session.openTerminal();
    expect(rig.bridge.openTerminal).toHaveBeenCalledWith({ instanceId: "grok" });
    expect(last()).toMatchObject({ phase: "waiting", terminal: "opened" });
    rig.close({ id: "s2", result: "signed-in" });
    expect(last()).toMatchObject({ phase: "closed", result: "signed-in" });
  });
  it("works from a sign-in that ended Not finished", async () => {
    const rig = mock();
    const { session, last } = run(rig);
    await settle();
    await session.open();
    rig.close({ id: "s1", result: "not-finished" });
    await session.openTerminal();
    expect(last()).toMatchObject({ phase: "waiting", terminal: "opened" });
    expect(last().result).toBeUndefined();
  });
  it("a launch that failed after main stopped the sign-in says Not finished, never Waiting", async () => {
    const rig = mock({ terminal: { ok: false, code: "terminal-failed", message: "The terminal didn't open." } });
    const { session, last } = run(rig);
    await settle();
    await session.open();
    await session.openTerminal();
    expect(last()).toMatchObject({ phase: "closed", result: "not-finished", terminal: "failed", message: "The terminal didn't open." });
  });
});
