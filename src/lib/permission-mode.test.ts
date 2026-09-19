// What the owner is told when a surface that is not the desktop app asks for
// Full access. The server refuses with the same bare 404 it gives every
// desktop-only setting (server/full-access.ts), which on screen read "not
// found" / "no such route" beside a control that looked switched on.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FULL_ACCESS_DESKTOP_ONLY, FULL_ACCESS_OPTIONS_DESKTOP_ONLY, fullAccessRefusalMessage, PEER_CONTACT_LABEL, peerContactHint } from "./permission-mode";

const refused = (status: number, message = "not found") => Object.assign(new Error(message), { status });

describe("a refused Full access change, in plain words", () => {
  it("names the desktop app when Full access itself was refused", () => {
    expect(FULL_ACCESS_DESKTOP_ONLY).toBe("Full access can only be turned on in the Murage desktop app.");
    expect(fullAccessRefusalMessage({ fullAccess: true, acknowledgeFullAccess: true }, refused(404))).toBe(FULL_ACCESS_DESKTOP_ONLY);
    expect(fullAccessRefusalMessage({ fullAccess: true }, refused(404, "no such route"))).toBe(FULL_ACCESS_DESKTOP_ONLY);
    expect(fullAccessRefusalMessage({ fullAccess: true }, refused(403))).toBe(FULL_ACCESS_DESKTOP_ONLY);
  });

  it("names the desktop app for Full access's two options too", () => {
    expect(fullAccessRefusalMessage({ fullAccessSetupRequests: true }, refused(404))).toBe(FULL_ACCESS_OPTIONS_DESKTOP_ONLY);
    expect(fullAccessRefusalMessage({ fullAccessChannelMessages: false }, refused(404))).toBe(FULL_ACCESS_OPTIONS_DESKTOP_ONLY);
  });

  it("leaves every other refusal as the server said it", () => {
    // the one-time warning was skipped: a real reason, not the surface
    expect(fullAccessRefusalMessage({ fullAccess: true }, refused(400, "Full access requires confirming the warning first"))).toBeNull();
    // switching Full access OFF is allowed anywhere; its failures are its own
    expect(fullAccessRefusalMessage({ fullAccess: false, autoApprove: true }, refused(404))).toBeNull();
    expect(fullAccessRefusalMessage({ title: "Ops" }, refused(404))).toBeNull();
    expect(fullAccessRefusalMessage({ fullAccess: true }, new Error("offline"))).toBeNull();
  });
});

describe("Ask me before contacting other bots: label and description agree", () => {
  const on = { approvePeerComms: true }, off = { approvePeerComms: false };
  const levels = [{ autoApprove: false }, { autoApprove: true, fullAccess: false }, { autoApprove: true, fullAccess: true }];

  it("names the switch by what turning it on does", () => {
    expect(PEER_CONTACT_LABEL).toBe("Ask me before contacting other bots");
  });

  it("describes the off position as not asking, never as the label's opposite promise", () => {
    for (const level of levels) {
      const hint = peerContactHint({ ...level, ...off });
      expect(hint).toBe("Off: this bot contacts other bots without asking you first.");
      expect(hint).not.toMatch(/stops and asks|will stop/);
    }
  });

  it("describes the on position as asking, under Ask and Auto", () => {
    for (const level of levels.slice(0, 2)) {
      expect(peerContactHint({ ...level, ...on })).toBe("On: this bot stops and asks you before it contacts another bot.");
    }
  });

  it("does not promise to stop when the default is Full access", () => {
    const full = peerContactHint({ autoApprove: true, fullAccess: true, ...on });
    expect(full).toMatch(/^On, but Full access skips this/);
    expect(full).toContain("Switch to Auto to be asked");
    expect(full).not.toContain("stops and asks you before");
  });

  it("is the label and description Bot Settings shows, side by side", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/SettingsPanel.tsx", import.meta.url)), "utf8");
    const label = source.indexOf("{PEER_CONTACT_LABEL}");
    expect(label).toBeGreaterThan(-1);
    const hint = source.indexOf("{peerContactHint(bot)}", label);
    expect(hint - label).toBeGreaterThan(0);
    expect(hint - label).toBeLessThan(300);
    expect(source).toContain("aria-label={PEER_CONTACT_LABEL}");
    expect(source).not.toContain("Let this bot talk to teammates on its own");
  });
});
