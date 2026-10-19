// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the cloud-home:* handlers, behind a fake gate and a fake client.
import { describe, expect, it, vi } from "vitest";

import { CloudHomeError } from "./cloud-home-client.mjs";
import { friendlyCloudHomeError, registerCloudHomeIpc } from "./cloud-home-ipc.mjs";

function setup({ token = "cp-secret-token", paired = [{ homeId: "home-1", origin: "https://h.example" }], showConnect, copied = "murage://door?h=home-1&o=x#t=SECRET.TICKET" } = {}) {
  const handlers = new Map();
  const gate = { handle: (channel, fn) => handlers.set(channel, fn) };
  const client = {
    pairedHomes: vi.fn(async () => paired),
    listHomes: vi.fn(async () => [{ id: "home-1", name: "Cloud home", status: "ready", publicOrigin: "https://h.example" }, { id: "home-2", name: "Spare", status: "creating", publicOrigin: null }, { id: "bad id!", name: "x", status: "x", publicOrigin: null }]),
    startConnect: vi.fn(async () => ({ pending: true, startedAt: 1700000000000 })),
    cancelConnect: vi.fn(async () => ({ pending: false })),
    connectStatus: vi.fn(async () => ({ pending: true, startedAt: 1700000000000, attempted: false, paired: false, lastResult: null, disconnected: false, open: true })),
    pasteDoorLink: vi.fn(async () => ({ homeId: "home-1", deviceId: "dev-secret", publicOrigin: "https://h.example", generation: 1 })),
    disconnect: vi.fn(async () => ({ disconnected: true })),
    deactivate: vi.fn(),
    resume: vi.fn(async () => ({ ok: false, disconnected: true, code: "disconnected", message: "This computer was disconnected from your Cloud home. Connect it again." })),
    activate: vi.fn(async () => {}),
    status: vi.fn(async () => ({ ok: true })),
    fetch: vi.fn(async () => new Response(JSON.stringify({ bots: [{ id: "bot-atlas", name: "Atlas", persona: "secret persona", messages: [{ text: "hi" }] }, { id: "../x", name: "bad" }, { id: "bot-2", name: "" }] }), { status: 200 })),
  };
  const cloudHome = { client, open: vi.fn(), close: vi.fn(), senderHomeId: vi.fn(() => "home-1") };
  const clipboard = { readText: vi.fn(() => copied) };
  registerCloudHomeIpc(gate, { cloudHome, getCpToken: () => token, cpEnvironment: "staging", showConnect, clipboard });
  const call = (channel, ...args) => handlers.get(channel)({ sender: "e" }, ...args);
  return { handlers, client, cloudHome, call, clipboard };
}

describe("registerCloudHomeIpc", () => {
  it("registers exactly the eleven channels; the emailed-code channels are gone", () => {
    const channels = [...setup().handlers.keys()].sort();
    expect(channels).toEqual(["cloud-home:connect-cancel", "cloud-home:connect-paste", "cloud-home:connect-start", "cloud-home:connect-status", "cloud-home:disconnect", "cloud-home:disconnect-this", "cloud-home:list-bots", "cloud-home:list-homes", "cloud-home:open", "cloud-home:reachable", "cloud-home:state"]);
    expect(channels).not.toContain("cloud-home:start-pairing");
    expect(channels).not.toContain("cloud-home:pair");
  });

  it("state: enabled, signed-in or not, what is paired; no token, key or device id", async () => {
    const t = setup();
    const state = await t.call("cloud-home:state");
    expect(state).toEqual({ enabled: true, cpSignedIn: true, paired: [{ homeId: "home-1", origin: "https://h.example" }] });
    expect(JSON.stringify(state)).not.toMatch(/secret|dev-/);
    expect((await setup({ token: null }).call("cloud-home:state")).cpSignedIn).toBe(false);
    await expect(t.call("cloud-home:state", "extra")).rejects.toThrow("Invalid request.");
  });

  it("list-bots: a paired home's bots, id and name only, no transcript asked for; bad ids dropped", async () => {
    const t = setup();
    const bots = await t.call("cloud-home:list-bots", "home-1");
    expect(bots).toEqual([{ id: "bot-atlas", name: "Atlas" }, { id: "bot-2", name: "bot-2" }]);
    expect(t.client.fetch).toHaveBeenCalledWith("home-1", "/api/bots?messages=0");
    await expect(t.call("cloud-home:list-bots", "../x")).rejects.toThrow("Invalid request.");
    t.client.fetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    await expect(t.call("cloud-home:list-bots", "home-1")).rejects.toThrow("Something went wrong. Try again.");
  });

  it("list-homes: the owner's homes with paired / reachable flags; needs the Murage sign-in; bad ids dropped", async () => {
    const t = setup();
    const homes = await t.call("cloud-home:list-homes");
    expect(homes).toEqual([
      { id: "home-1", name: "Cloud home", status: "ready", reachable: true, paired: true },
      { id: "home-2", name: "Spare", status: "creating", reachable: false, paired: false },
    ]);
    expect(t.client.listHomes).toHaveBeenCalledWith({ cpToken: "cp-secret-token", cpEnvironment: "staging" });
    await expect(setup({ token: "" }).call("cloud-home:list-homes")).rejects.toThrow(/Sign in to your Murage account/);
  });

  it("connect-start and connect-cancel take no argument and return nothing secret", async () => {
    const t = setup();
    expect(await t.call("cloud-home:connect-start")).toEqual({ pending: true, startedAt: 1700000000000 });
    expect(t.client.startConnect).toHaveBeenCalledWith({ cpEnvironment: "staging" });
    await expect(t.call("cloud-home:connect-start", "extra")).rejects.toThrow("Invalid request.");
    expect(await t.call("cloud-home:connect-cancel")).toEqual({ pending: false });
    await expect(t.call("cloud-home:connect-cancel", 1)).rejects.toThrow("Invalid request.");
    expect(await t.call("cloud-home:connect-status")).toMatchObject({ pending: true, paired: false, open: true });
    expect(t.client.connectStatus).toHaveBeenCalledWith({ cpEnvironment: "staging" }); // `open` is answered for the environment main selected
    await expect(t.call("cloud-home:connect-status", "x")).rejects.toThrow("Invalid request.");
  });

  it("connect-paste takes no arguments and returns no text", async () => {
    const t = setup();
    for (const bad of [["murage://door?h=home-1&o=x#t=A.B"], [1], ["a", "b"], [undefined]]) {
      await expect(t.call("cloud-home:connect-paste", ...bad)).rejects.toThrow("Invalid request.");
    }
    expect(t.clipboard.readText).not.toHaveBeenCalled();
    expect(t.client.pasteDoorLink).not.toHaveBeenCalled();
    const done = await t.call("cloud-home:connect-paste");
    expect(done).toEqual({ homeId: "home-1" });
    expect(t.clipboard.readText).toHaveBeenCalledTimes(1);
    expect(t.client.pasteDoorLink).toHaveBeenCalledWith("murage://door?h=home-1&o=x#t=SECRET.TICKET"); // main read it, main used it
    expect(JSON.stringify(done)).not.toMatch(/dev-secret|SECRET|TICKET|murage:/);
    t.client.pasteDoorLink.mockResolvedValueOnce({ ignored: true });
    await expect(t.call("cloud-home:connect-paste")).rejects.toThrow("Press Connect first, then use the copied link.");
    t.client.pasteDoorLink.mockRejectedValueOnce(new CloudHomeError("expired", "This link has expired. Press Connect again."));
    const refused = await t.call("cloud-home:connect-paste").then(() => null, (error) => error);
    expect(refused.message).toBe("This link has expired. Press Connect again.");
    expect(refused.message).not.toMatch(/SECRET|TICKET/);
    // Whatever the clipboard holds, the error never echoes it.
    const junk = setup({ copied: "SECRET.TICKET not a link" });
    junk.client.pasteDoorLink.mockRejectedValueOnce(new CloudHomeError("bad-link", "That is not a Murage connect link."));
    await expect(junk.call("cloud-home:connect-paste")).rejects.toThrow(/^That is not a Murage connect link\.$/);
    // No clipboard injected: an empty paste, refused by the client as not a link.
    const handlers = new Map();
    registerCloudHomeIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { cloudHome: { client: t.client, open: vi.fn(), senderHomeId: () => null }, getCpToken: () => "x", active: () => true });
    t.client.pasteDoorLink.mockClear();
    await handlers.get("cloud-home:connect-paste")({ sender: "e" }).catch(() => {});
    expect(t.client.pasteDoorLink).toHaveBeenCalledWith("");
  });

  it("disconnect validates the home id, revokes and forgets through the client, and closes that home's window", async () => {
    const t = setup();
    await expect(t.call("cloud-home:disconnect", "../x")).rejects.toThrow("Invalid request.");
    await expect(t.call("cloud-home:disconnect")).rejects.toThrow("Invalid request.");
    expect(await t.call("cloud-home:disconnect", "home-1")).toEqual({ disconnected: true });
    expect(t.client.disconnect).toHaveBeenCalledWith("home-1");
    expect(t.client.deactivate).toHaveBeenCalledWith("home-1");
    expect(t.cloudHome.close).toHaveBeenCalledWith("home-1");
  });

  it("open: verifies the pin first (activate), then opens the window", async () => {
    const t = setup();
    const order = [];
    t.client.activate.mockImplementation(async () => { order.push("activate"); });
    t.cloudHome.open.mockImplementation(() => { order.push("open"); });
    expect(await t.call("cloud-home:open", "home-1")).toEqual({ opened: true });
    expect(order).toEqual(["activate", "open"]);
    t.client.activate.mockRejectedValueOnce(new CloudHomeError("pin-mismatch", "This isn't the Cloud home you paired with. Pair it again."));
    await expect(t.call("cloud-home:open", "home-1")).rejects.toThrow("This isn't the Cloud home you paired with. Pair it again.");
    expect(t.cloudHome.open).toHaveBeenCalledTimes(1); // a refused pin never opens a window
  });

  it("reachable: a home that no longer knows this computer is resumed once; a revoked computer is forgotten and its window closed", async () => {
    const t = setup();
    t.client.status.mockResolvedValueOnce({ ok: false, code: "needs-repair", message: "Your Cloud home no longer knows this computer. Pair it again." });
    expect(await t.call("cloud-home:reachable")).toEqual({ ok: false, code: "disconnected", message: "This computer was disconnected from your Cloud home. Connect it again." });
    expect(t.client.resume).toHaveBeenCalledWith("home-1");
    expect(t.cloudHome.close).toHaveBeenCalledWith("home-1");
  });

  it("reachable: a revoked computer goes back to the Connect panel through main's showConnect", async () => {
    const showConnect = vi.fn();
    const t = setup({ showConnect });
    t.client.status.mockResolvedValueOnce({ ok: false, code: "needs-repair", message: "x" });
    expect((await t.call("cloud-home:reachable")).code).toBe("disconnected");
    expect(showConnect).toHaveBeenCalledWith("home-1");
    // a passing failure is not a refusal: nothing is closed and no Connect panel shows
    t.client.status.mockResolvedValueOnce({ ok: false, code: "unreachable", message: "Your Cloud home isn't reachable" });
    expect((await t.call("cloud-home:reachable")).code).toBe("unreachable");
    expect(showConnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect-this: the Cloud window's Settings disconnects the SENDER's home only, then shows the Connect panel", async () => {
    vi.useFakeTimers();
    try {
      const showConnect = vi.fn();
      const t = setup({ showConnect });
      await expect(t.call("cloud-home:disconnect-this", "home-2")).rejects.toThrow("Invalid request.");
      expect(t.client.disconnect).not.toHaveBeenCalled();
      expect(await t.call("cloud-home:disconnect-this")).toEqual({ disconnected: true });
      expect(t.client.disconnect).toHaveBeenCalledWith("home-1");
      expect(t.client.deactivate).toHaveBeenCalledWith("home-1");
      expect(showConnect).not.toHaveBeenCalled(); // the answer reaches the window before it closes
      vi.runAllTimers();
      expect(showConnect).toHaveBeenCalledWith("home-1");
      // a sender that is not a Cloud window is refused before anything is revoked
      t.cloudHome.senderHomeId.mockReturnValueOnce(null);
      await expect(t.call("cloud-home:disconnect-this")).rejects.toThrow("Something went wrong. Try again.");
      expect(t.client.disconnect).toHaveBeenCalledTimes(1);
      // a refused revoke keeps the window and says so in plain words
      t.client.disconnect.mockRejectedValueOnce(new CloudHomeError("disconnect-failed", "Could not disconnect this computer. Try again."));
      await expect(t.call("cloud-home:disconnect-this")).rejects.toThrow("Could not disconnect this computer. Try again.");
      vi.runAllTimers();
      expect(showConnect).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("reachable: answers for the SENDER's home only, takes no argument", async () => {
    const t = setup();
    expect(await t.call("cloud-home:reachable")).toEqual({ ok: true });
    expect(t.client.status).toHaveBeenCalledWith("home-1");
    await expect(t.call("cloud-home:reachable", "home-2")).rejects.toThrow("Invalid request.");
    t.client.status.mockResolvedValueOnce({ ok: false, code: "unreachable", message: "Your Cloud home isn't reachable" });
    expect(await t.call("cloud-home:reachable")).toEqual({ ok: false, code: "unreachable", message: "Your Cloud home isn't reachable" });
    t.cloudHome.senderHomeId.mockReturnValueOnce(null);
    await expect(t.call("cloud-home:reachable")).rejects.toThrow("Something went wrong. Try again.");
  });

  it("an unexpected error never leaks its text; a CloudHomeError shows its plain copy", async () => {
    const t = setup();
    t.client.startConnect.mockRejectedValueOnce(new Error("ECONNRESET 10.0.0.5 token=abc"));
    await expect(t.call("cloud-home:connect-start")).rejects.toThrow("Something went wrong. Try again.");
    expect(friendlyCloudHomeError(new CloudHomeError("unreachable", "Your Cloud home isn't reachable"))).toBe("Your Cloud home isn't reachable");
    expect(friendlyCloudHomeError(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
