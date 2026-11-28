// P2 (settings v10): the production screen, PhoneSetupFlowView, draws no pairing code when no route can carry it.
// Entry point: the rendered component, the same one Settings and onboarding mount; only the surface seam is fixed to "desktop".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { companionPairingRoute } from "../lib/companion-pairing";

vi.mock("../lib/use-surface", () => ({ useDesktopSurface: () => true, useOwnersComputer: () => true, useSurfaceState: () => ({ desktop: true, confirmed: true }) }));
const { PhoneSetupFlowView } = await import("./PhoneSetupFlow");

const noop = () => {};
const CODE = "482916";
const controller = (over: Record<string, unknown> = {}) => ({
  state: { enabled: true, keepAwake: false, port: 8810, devices: [], pairing: { code: CODE } },
  account: null, phase: "qr", email: "", code: "", codeSent: false, busy: false, accountBusy: false, error: null,
  pairingCloseFailed: false, retryPairingClose: noop, accountError: null, pairingLink: null, secondsLeft: 90, address: undefined,
  addressText: null, routeHosted: false, pairingPort: 8810, hostedReady: false, localFallback: false, tailscaleFallback: false,
  tailscaleAvailable: false, browserLink: null, browserDoor: null, remoteAccess: { state: "off" }, setRemoteAccess: noop,
  pairingExpired: false, setupTimedOut: false, setEmail: noop, setCode: noop, changeEmail: noop, start: noop, useLocal: noop,
  lanPrompt: false, confirmLan: noop, dismissLan: noop, useTailscale: noop, requestCode: noop, verifyCode: noop, retryAccount: noop,
  cancel: noop, refreshTailscale: noop, refreshCode: noop, finish: noop, skip: noop, act: async () => {}, accountAct: async () => {},
  ...over,
});
const html = (over: Record<string, unknown>) => renderToStaticMarkup(createElement(PhoneSetupFlowView, { controller: controller(over) as never, variant: "settings" }));

describe("P2: the screen never shows a pairing code when no route can work", () => {
  it("an open window with neither a browser door nor a pairing link shows no code", () => {
    expect(html({ pairingLink: null, browserLink: null })).not.toContain(CODE);
  });
  it("automatic mode with only a LAN endpoint builds no route, so the screen shows no code", () => {
    const source = { endpoints: [{ url: "http://192.0.2.10:8080", kind: "lan", priority: 0 }], port: 8080 } as never;
    const route = companionPairingRoute(source, "automatic");
    expect(route).toBeNull();
    expect(html({ pairingLink: route ? "murage://x" : null, browserLink: null })).not.toContain(CODE);
  });
  it("a usable route, either door, shows the code", () => {
    expect(html({ pairingLink: "murage://pair/x", browserLink: null })).toContain(CODE);
    expect(html({ pairingLink: null, browserLink: "https://door.example/enter#t" })).toContain(CODE);
  });
  it("an expired window never shows it, route or not", () => {
    expect(html({ pairingExpired: true, pairingLink: "murage://pair/x", browserLink: null })).not.toContain(CODE);
  });
});
