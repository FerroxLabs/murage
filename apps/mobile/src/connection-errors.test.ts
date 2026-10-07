import { describe, expect, it } from "vitest";
import { present, screenForOpenError, screenForClose } from "./screens";
import { TAILSCALE_UNKNOWN, type CloseReason } from "./shell-types";

describe("UX-002: actionable connection diagnoses", () => {
  it.each(["https://desk.example.com", "https://ts.net.example.com", "https://desk.ts.net.example.com"])("never suggests Tailscale for %s", (origin) => {
    for (const kind of ["unreachable", "pairUnreachable"] as const) {
      for (const tailscale of [TAILSCALE_UNKNOWN, { installed: false, connected: false }, { installed: true, connected: true }]) {
        const view = present({ kind, origin }, [], 0, tailscale);
        expect(JSON.stringify(view)).not.toMatch(/tailscale/i);
        expect(view.lines.join(" ")).toMatch(/network/i);
        expect(view.actions.some((a) => a.id === "retry")).toBe(true);
      }
    }
  });
  it("offers Tailscale only for an unreachable tailnet host", () => {
    const view = present({ kind: "unreachable", origin: "https://desk.tail.ts.net" }, [], 0);
    expect(view.actions.some((a) => a.id === "tailscale")).toBe(true);
  });
  it.each(["accessoff", "hosterror"])("preserves the desktop's %s answer for opens and cold closes", (code) => {
    const origin = "https://desk.tail.ts.net";
    const screen = screenForOpenError(code, origin, false)!;
    expect(screen.kind).toBe(code);
    expect(screenForClose({ origin, reason: code as CloseReason }, [])).toEqual(screen);
    const view = present(screen, [], 0);
    expect(JSON.stringify(view)).not.toMatch(/tailscale/i);
    expect(view.lines.join(" ")).toMatch(code === "accessoff" ? /Phone and other devices.*Turn on/ : /open Murage/i);
  });
  it("explains TLS and certificates without recommending a VPN or bypass", () => {
    const view = present(screenForOpenError("insecure", "https://desk.tail.ts.net", false)!, [], 0);
    expect(view.lines.join(" ")).toMatch(/certificate/i);
    expect(JSON.stringify(view)).not.toMatch(/tailscale/i);
  });
});
