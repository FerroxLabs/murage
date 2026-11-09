// The one-time Full access warning says, in plain words, what the bot will
// stop asking about — and what still asks.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FullAccessWarning } from "./FullAccessWarning";
import { permissionModeOf } from "@/lib/permission-mode";

const render = (onThisComputer: boolean) =>
  renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", onThisComputer, onCancel: () => {}, onConfirm: () => {} }));

describe("FullAccessWarning", () => {
  it("names what Full access stops asking about, and what it still stops before", () => {
    const markup = render(false);
    expect(markup).toContain("will not ask before running commands, editing files or contacting other bots");
    expect(markup).toContain("still asks before deleting anything outside its folder, paying for anything, messaging someone new or posting in public, and reading your keys and passwords");
    expect(markup).toContain("Work started by another app&#x27;s trigger link still asks");
    // routines follow a level of their own now (server/routine-permissions.ts)
    expect(markup).not.toContain("routines still ask");
    // images follow the level now: made without a card, with a record, and the setting says where to change it
    expect(markup).not.toContain("image generation still asks");
    expect(markup).toContain("makes images without asking in your own conversations and routines");
    expect(markup).toContain("Change that under Images in Bot settings");
    expect(markup).toContain("messages from Telegram, Slack or Discord, and setup requests");
    expect(markup).toContain("unless you allow them in Bot Settings");
    expect(markup).not.toContain("your own screen");
  });

  it("covers this computer when the bot drives it", () => {
    expect(render(true)).toContain("your own screen, mouse and keyboard");
  });

  it("the new terms: one line above the warning, Accept and Not now, for every bot and no one name", () => {
    const markup = renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "", level: "unlimited", terms: true, onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(markup).toContain("No limits changed. Read this once and it applies to every bot.");
    expect(markup).toContain(">Accept<");
    expect(markup).toContain(">Not now<");
    expect(markup).not.toContain("Give @");
    expect(markup).not.toContain("Turn on no limits");
    expect(markup).not.toContain("You are asked this once");
  });

  it("has its own wording for No limits", () => {
    const markup = renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", level: "unlimited", onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(markup).toContain("Give @Vega no limits?");
    // NOLIMITS v1 copy W and O-win (designs/NOLIMITS-MEANS-IT.md section 11)
    expect(markup).toContain("No limits runs what you ask without stopping to ask you, even a command Murage cannot read in full.");
    expect(markup).toContain("Murage asks before each command that can run code for the rest of that chat.");
    expect(markup).toContain("Commands that only read and print keep running.");
    expect(markup).toContain("on Windows, Murage keeps asking before PowerShell and cmd commands as it does today.");
    expect(markup).not.toContain("This bot runs on OpenClaw");
    expect(markup).toContain("Turn on no limits");
    expect(markup).not.toContain("still asks before deleting anything outside its folder");
    expect(markup).not.toMatch(/\u2014|\bsafe\b/);
  });

  it("names the OpenClaw exception (copy O) when the bot runs on OpenClaw", () => {
    const markup = renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", level: "unlimited", openClaw: true, onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(markup).toContain("This bot runs on OpenClaw, which runs commands without asking Murage first.");
  });

  it("says whether it covers this conversation, the bot or one routine", () => {
    const at = (scope: "conversation" | "bot" | { routine: string }) =>
      renderToStaticMarkup(createElement(FullAccessWarning, { open: true, botName: "Vega", level: "unlimited", scope, onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(at("conversation")).toContain("This is for this conversation only. Routines use the level in Bot settings, Permissions, unless a routine has its own.");
    expect(at("bot")).toContain("Routines keep their own level and never run above this one.");
    expect(at({ routine: "Log tick" })).toContain("This is for the routine Log tick only.");
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(FullAccessWarning, { open: false, botName: "Vega", onThisComputer: false, onCancel: () => {}, onConfirm: () => {} }))).toBe("");
  });
});

describe("permissionModeOf", () => {
  it("reads Full access only on top of Auto", () => {
    expect(permissionModeOf({ autoApprove: true, fullAccess: true })).toBe("full");
    expect(permissionModeOf({ autoApprove: true, fullAccess: false })).toBe("auto");
    expect(permissionModeOf({ autoApprove: false, fullAccess: true })).toBe("ask");
  });

  it("reads No limits only on top of Full access, so older Full access bots stay guarded", () => {
    expect(permissionModeOf({ autoApprove: true, fullAccess: true, noLimits: true })).toBe("unlimited");
    expect(permissionModeOf({ autoApprove: true, fullAccess: false, noLimits: true })).toBe("auto");
    expect(permissionModeOf({ autoApprove: true, fullAccess: true })).toBe("full");
  });
});
