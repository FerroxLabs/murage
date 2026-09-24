// Bot Settings' approval default: Ask, Auto or Full access for new
// conversations, and Full access's two extras beside it. The server enforces
// every rule (server/full-access-options-api.test.ts); this pins what the
// owner sees and which request each choice makes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotPermissionDefault, FULL_ACCESS_CHANNEL_OPTION, FULL_ACCESS_SETUP_OPTION } from "./BotPermissionDefault";
import { defaultModeStep } from "@/lib/permission-mode";

type Shown = Parameters<typeof BotPermissionDefault>[0]["bot"];
const render = (bot: Shown, onThisComputer = false, desktop?: boolean) =>
  renderToStaticMarkup(createElement(BotPermissionDefault, { bot, onThisComputer, desktop, onChoose: () => {}, onOption: () => {} }));
const radio = (markup: string, label: string) => {
  const end = markup.indexOf(`>${label}<`);
  expect(end, `no "${label}" radio`).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<button", end), end + 1);
};
const pressed = (markup: string) =>
  [...markup.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>([^<]*)</g)].map((match) => match[1]);
const option = (markup: string, label: string) => {
  const at = markup.indexOf(label);
  expect(at, `no "${label}"`).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<button", markup.indexOf('role="switch"', at));
  return markup.slice(start, markup.indexOf(">", start) + 1);
};

describe("Bot Settings approval default", () => {
  it("offers Ask, Auto and Full access, with the current default pressed", () => {
    expect(pressed(render({ autoApprove: false }))).toEqual(["Ask"]);
    expect(pressed(render({ autoApprove: true, fullAccess: false }))).toEqual(["Auto"]);
    expect(pressed(render({ autoApprove: true, fullAccess: true }))).toEqual(["Full access"]);
    // Full access counts only on top of Auto, as the server reads it
    expect(pressed(render({ autoApprove: false, fullAccess: true }))).toEqual(["Ask"]);
    expect(render({ autoApprove: false })).toContain("New conversations start");
  });

  it("shows the two extras under Full access, off unless set, in plain words", () => {
    const markup = render({ autoApprove: true, fullAccess: true });
    expect(FULL_ACCESS_CHANNEL_OPTION).toBe("Also skip approvals for my messages from Telegram, Slack and Discord");
    expect(FULL_ACCESS_SETUP_OPTION).toBe("Also approve setup requests: installing skills, proposing routines and trusting folders");
    expect(option(markup, FULL_ACCESS_CHANNEL_OPTION)).toContain('aria-checked="false"');
    expect(option(markup, FULL_ACCESS_SETUP_OPTION)).toContain('aria-checked="false"');
    expect(option(markup, FULL_ACCESS_CHANNEL_OPTION)).not.toContain(' disabled=""');
    // connecting an app cannot be approved for the owner, and says why
    expect(markup).toContain("Connecting an app still asks");
    expect(markup).toContain("Messages from anyone else, webhooks and routines still ask");
    const on = render({ autoApprove: true, fullAccess: true, fullAccessChannelMessages: true, fullAccessSetupRequests: true });
    expect(option(on, FULL_ACCESS_CHANNEL_OPTION)).toContain('aria-checked="true"');
    expect(option(on, FULL_ACCESS_SETUP_OPTION)).toContain('aria-checked="true"');
  });

  it("disables the extras with a hint when the default is not Full access", () => {
    for (const bot of [{ autoApprove: true, fullAccess: false }, { autoApprove: false }] as Shown[]) {
      const markup = render({ ...bot, fullAccessChannelMessages: true });
      expect(option(markup, FULL_ACCESS_CHANNEL_OPTION)).toContain(' disabled=""');
      expect(option(markup, FULL_ACCESS_SETUP_OPTION)).toContain(' disabled=""');
      expect(markup).toContain("Only used when the default is Full access");
    }
  });

  it("offers Full access only on the desktop app, and says so elsewhere", () => {
    // a phone or the browser door: the server would refuse it, so it is not offered
    const remote = render({ autoApprove: true, fullAccess: false }, false, false);
    expect(radio(remote, "Full access")).toContain(' disabled=""');
    expect(radio(remote, "Auto")).not.toContain(' disabled=""');
    expect(remote).toContain("Full access can only be turned on in the Murage desktop app.");
    // already on Full access: still shown as the default, options not editable here
    const remoteFull = render({ autoApprove: true, fullAccess: true }, false, false);
    expect(pressed(remoteFull)).toEqual(["Full access"]);
    expect(option(remoteFull, FULL_ACCESS_SETUP_OPTION)).toContain(' disabled=""');
    // the desktop, and not-yet-known, keep it available (the server still decides)
    for (const desktop of [true, undefined]) {
      const markup = render({ autoApprove: true, fullAccess: false }, false, desktop);
      expect(radio(markup, "Full access")).not.toContain(' disabled=""');
      expect(markup).not.toContain("can only be turned on in the Murage desktop app");
    }
  });

  it("keeps the local-computer wording", () => {
    expect(render({ autoApprove: true, fullAccess: false }, true)).toContain("on this computer");
  });
});

describe("choosing a default", () => {
  const fresh = { autoApprove: false, fullAccess: false };
  const warned = { autoApprove: true, fullAccess: false, fullAccessAcknowledgedAt: 1 };

  it("Full access shows the one-time warning first, covering this computer when it applies", () => {
    expect(defaultModeStep(fresh, "full", false)).toEqual({ kind: "full-warning", onThisComputer: false });
    expect(defaultModeStep(fresh, "full", true)).toEqual({ kind: "full-warning", onThisComputer: true });
  });

  it("after the warning, Full access asks only about this computer, else saves", () => {
    expect(defaultModeStep(warned, "full", true)).toEqual({ kind: "local-warning", mode: "full" });
    expect(defaultModeStep(warned, "full", false)).toEqual({ kind: "patch", patch: { autoApprove: true, fullAccess: true, noLimits: false } });
  });

  it("No limits has its own warning once, then this computer's, else saves", () => {
    expect(defaultModeStep(warned, "unlimited", false)).toEqual({ kind: "no-limits-warning", onThisComputer: false });
    expect(defaultModeStep({ ...warned, noLimitsAcknowledgedAt: 1 }, "unlimited", true)).toEqual({ kind: "local-warning", mode: "unlimited" });
    expect(defaultModeStep({ ...warned, noLimitsAcknowledgedAt: 1 }, "unlimited", false)).toEqual({ kind: "patch", patch: { autoApprove: true, fullAccess: true, noLimits: true } });
  });

  it("Auto keeps the local-computer warning; Ask never warns", () => {
    expect(defaultModeStep(fresh, "auto", true)).toEqual({ kind: "local-warning", mode: "auto" });
    expect(defaultModeStep(fresh, "auto", false)).toEqual({ kind: "patch", patch: { autoApprove: true, fullAccess: false } });
    expect(defaultModeStep(warned, "ask", true)).toEqual({ kind: "patch", patch: { autoApprove: false, fullAccess: false } });
  });
});
