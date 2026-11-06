// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-L1B-1013 client test 12 and F15: what the confirm card shows and
// sends, each refusal's line, and Undo. The calls run against a fake harness
// answering the wire contract; no DOM, no app data.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import l1 from "@/locales/en-ux/l1.json";
import { LevelConfirmCard } from "./LevelConfirmCard";
import { LevelStatusLine } from "./LevelStatusLine";
import { BotPermissionDefault } from "@/components/BotPermissionDefault";
import { needsLevelConfirm } from "@/lib/permission-mode";
import {
  changeDirect, confirmEffectLine, directLine, levelAcks, levelFlags, openLevelCard, pressUse, raisedLine, undoLevelChange, undoneLine,
  type LevelCard, type LevelDeps, type LevelPreview, type UndoPlan,
} from "@/lib/level-change";
import { UNDO_WINDOW_MS } from "@/lib/undo-window";
import { PermissionModeMenu } from "@/components/PermissionModeMenu";

const NOW = 1_000_000;
const PREVIEW: LevelPreview = {
  previewId: "preview-1", rosterId: "roster-1", targetLevel: "full", botLevel: "auto", botRev: 7,
  eligible: [
    { threadId: "t1", from: "ask", to: "full", rev: 2 },
    { threadId: "t2", from: "auto", to: "full", rev: 4 },
    { threadId: "t3", from: "auto", to: "full", rev: 1 },
  ],
  skipped: [{ threadId: "t4", reason: "busy" }],
  routines: [{ id: "r1", name: "Morning brief", ceiling: "full", from: "auto", to: "full" }],
};
const CARD: LevelCard = { target: "full", preview: PREVIEW };

const stale = (level = "auto", permissionRev = 7) => Object.assign(new Error("changed"), { status: 409, body: { code: "preview_stale", error: "changed", level, permissionRev } });

type Call = { path: string; method: string; body: Record<string, unknown> };
function harness(answers: Array<(call: Call) => unknown>) {
  const calls: Call[] = [];
  const onBot = vi.fn();
  const deps: LevelDeps = {
    flush: vi.fn(async () => undefined),
    onBot,
    api: async (path, init) => {
      const call = { path, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
      calls.push(call);
      const answer = answers.shift();
      if (!answer) throw new Error(`unexpected call ${call.method} ${path}`);
      return answer(call);
    },
  };
  return { deps, calls, onBot };
}
const fails = (error: Error) => () => { throw error; };
const use = (deps: LevelDeps, conversations = true, card = CARD) =>
  pressUse(deps, { botId: "b1", bot: "Nova", card, acks: {}, conversations, drivesComputer: false, now: NOW });

const renderCard = (props: Partial<Parameters<typeof LevelConfirmCard>[0]> = {}) => renderToStaticMarkup(createElement(LevelConfirmCard, {
  bot: "Nova", target: "full", keep: "auto", onThisComputer: false, onKeep: () => {}, onUse: () => {}, onOnlyNew: () => {},
  effect: { kind: "default", conversations: 3, routines: PREVIEW.routines }, ...props,
}));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the confirm card's words (3.3)", () => {
  it("Full access: the design's lines, the count and routine from the preview, both choices", () => {
    const shown = text(renderCard());
    expect(shown).toContain("Use Full access for Nova?");
    expect(shown).toContain("Full access lets Nova run commands, edit files and work with other bots without asking.");
    expect(shown).toContain("It still asks before paying, emailing someone new, posting in public, deleting outside its folder, or reading your keys and passwords.");
    expect(shown).toContain("This also raises 3 open conversations and the routine Morning brief (its level is set to Full access).");
    expect(shown).toContain("Keep Auto");
    expect(shown).toContain("Use Full access");
    expect(shown).toContain("Only new conversations");
    expect(shown).toContain("Routines above follow the default either way.");
    expect(shown).not.toContain("Routines keep their own level");
    expect(shown).not.toContain("On this computer");
  });

  it("No limits: its own text, the level and bot as parameters", () => {
    const shown = text(renderCard({ target: "unlimited", keep: "full", bot: "Ember" }));
    expect(shown).toContain("In conversations you start, No limits lets Ember run commands and tools without asking, including reading and sending your keys. It still asks before a wipe it can read and before a command it cannot read in full. A script file can still run unread. Routines and channel messages keep their own rules.");
    expect(shown).toContain("Keep Full access");
    expect(shown).not.toContain("Nova");
  });

  it("names every routine, and says routines keep their level only when none rises", () => {
    const two = [...PREVIEW.routines, { id: "r2", name: "Weekly", ceiling: "auto", from: "ask", to: "auto" }];
    expect(confirmEffectLine(1, two)).toBe("This also raises 1 open conversation and the routine Morning brief (its level is set to Full access) and the routine Weekly (its level is set to Auto).");
    expect(confirmEffectLine(0, PREVIEW.routines)).toBe("This also raises the routine Morning brief (its level is set to Full access).");
    expect(confirmEffectLine(2, [])).toBe("This also raises 2 open conversations. Routines keep their own level.");
    expect(confirmEffectLine(0, [])).toBe("Routines keep their own level.");
    const none = text(renderCard({ effect: { kind: "default", conversations: 0, routines: [] } }));
    expect(none).toContain("Routines keep their own level.");
    expect(none).not.toContain("Routines above follow");
  });

  it("says what it covers on this computer when the bot drives it", () => {
    expect(text(renderCard({ onThisComputer: true }))).toContain("On this computer that includes your own screen, mouse and keyboard.");
  });

  it("from the chat chip: the same card without counts or the new-conversations choice", () => {
    const conversation = text(renderCard({ effect: { kind: "conversation" }, onOnlyNew: undefined }));
    expect(conversation).toContain("Use Full access for Nova?");
    expect(conversation).toContain("This changes this conversation.");
    expect(conversation).not.toContain("Only new conversations");
    expect(conversation).not.toContain("open conversation");
    expect(text(renderCard({ effect: { kind: "routine", routine: "Morning brief" }, onOnlyNew: undefined }))).toContain("This changes every run of Morning brief.");
  });

  it("stands in place of the example table in Settings", () => {
    const change = { card: CARD, line: null, busy: false, undoing: false, reviewAsk: 0, drivesComputer: true, pick: async () => {}, use: async () => {}, keep: () => {}, undo: async () => {}, review: () => {} };
    const bot = { autoApprove: true, fullAccess: false };
    const props = { botName: "Nova", bot, onThisComputer: false, onChoose: () => {}, onOption: () => {} };
    const open = renderToStaticMarkup(createElement(BotPermissionDefault, { ...props, change }));
    expect(open).toContain("data-level-confirm");
    expect(open).not.toContain("data-level-examples");
    expect(text(open)).toContain("On this computer that includes");
    // the menu stays on the saved level while the card is open
    expect(open).toMatch(/aria-checked="true"[^>]*>Auto</);
    const closed = renderToStaticMarkup(createElement(BotPermissionDefault, { ...props, change: { ...change, card: null } }));
    expect(closed).toContain("data-level-examples");
  });

  it("shows only for a higher pick to Full access or No limits", () => {
    expect(needsLevelConfirm("ask", "full")).toBe(true);
    expect(needsLevelConfirm("auto", "unlimited")).toBe(true);
    expect(needsLevelConfirm("full", "unlimited")).toBe(true);
    expect(needsLevelConfirm("ask", "auto")).toBe(false);
    expect(needsLevelConfirm("unlimited", "full")).toBe(false);
    expect(needsLevelConfirm("full", "full")).toBe(false);
  });

  it("the phone sheet greys Full access and No limits", () => {
    const sheet = renderToStaticMarkup(createElement(PermissionModeMenu, { botName: "Nova", current: "auto", desktop: false, scope: {}, onPick: () => {} }));
    expect(sheet.match(/Set this on your computer\./g)?.length).toBeGreaterThanOrEqual(2);
    expect(text(sheet)).toContain("Full access and No limits are set on your computer, where you can see what they change.");
  });
});

describe("[Use] and Only new conversations", () => {
  const saved = () => ({ bot: { id: "b1" }, permissionRev: 8, routines: PREVIEW.routines });

  it("[Use] sends the PATCH with previewId and ifRev, then the apply with afterRev from the PATCH result", async () => {
    const { deps, calls, onBot } = harness([saved, () => ({ changed: PREVIEW.eligible.map((row) => ({ ...row, rev: row.rev + 1 })) })]);
    const view = await use(deps);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PATCH /api/bots/b1", "POST /api/bots/b1/permissions/refresh"]);
    expect(calls[0].body).toEqual({ ...levelFlags("full"), settingsScope: "defaults", previewId: "preview-1", ifRev: 7 });
    expect(calls[1].body).toEqual({ scope: "open", rosterId: "roster-1", targetLevel: "full", afterRev: 8 });
    expect(calls[1].body.afterRev).not.toBe(PREVIEW.botRev);
    expect(deps.flush).toHaveBeenCalledWith("b1");
    expect(onBot).toHaveBeenCalledWith({ id: "b1" });
    expect(view.card).toBeNull();
    expect(view.line?.text).toBe("Nova is on Full access. 3 conversations follow it.");
    expect(view.line?.undo?.bot).toEqual({ previous: "auto", rev: 8, from: "full", drivesComputer: false });
    expect(view.line?.undo?.conversations.map((row) => row.rev)).toEqual([3, 5, 2]);
  });

  it("carries the first-time acknowledgements on the same PATCH, and this computer's only as Auto comes on", async () => {
    expect(levelAcks({}, "auto", "full", true)).toEqual({ acknowledgeFullAccess: true });
    expect(levelAcks({}, "ask", "full", true)).toEqual({ acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
    expect(levelAcks({ fullAccessAcknowledgedAt: 1 }, "ask", "full", false)).toEqual({});
    expect(levelAcks({ fullAccessAcknowledgedAt: 1 }, "full", "unlimited", false)).toEqual({ acknowledgeNoLimits: true });
    expect(levelAcks({ noLimitsAcknowledgedAt: 1 }, "ask", "unlimited", false)).toEqual({});
    const { deps, calls } = harness([saved, () => ({ changed: [] })]);
    await pressUse(deps, { botId: "b1", bot: "Nova", card: CARD, conversations: true, drivesComputer: true, acks: levelAcks({}, "ask", "full", true), now: NOW });
    expect(calls[0].body).toMatchObject({ acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
  });

  it("Only new conversations sends the PATCH alone", async () => {
    const { deps, calls } = harness([saved]);
    const view = await use(deps, false);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.previewId).toBe("preview-1");
    expect(view.line?.text).toBe("Nova is on Full access.");
    expect(view.line?.undo?.conversations).toEqual([]);
  });

  it("nothing eligible, nothing to apply", async () => {
    const { deps, calls } = harness([saved]);
    await use(deps, true, { ...CARD, preview: { ...PREVIEW, eligible: [] } });
    expect(calls).toHaveLength(1);
  });

  it("a 409 on the PATCH re-previews and shows the stale line on a fresh card, the level unchanged", async () => {
    const fresh = { ...PREVIEW, previewId: "preview-2", routines: [] };
    const { deps, calls, onBot } = harness([fails(stale()), () => fresh]);
    const view = await use(deps);
    expect(calls[1]).toMatchObject({ method: "POST", path: "/api/bots/b1/permissions/refresh", body: { scope: "open", targetLevel: "full" } });
    expect(view.card?.preview.previewId).toBe("preview-2");
    expect(view.card?.notice).toBe("Nova's settings changed while this was open. Look again, then choose.");
    expect(view.line).toBeNull();
    expect(onBot).not.toHaveBeenCalled();
    expect(text(renderCard({ notice: view.card?.notice, keep: "ask" }))).toContain("Keep Ask");
  });

  it("when the level moved past the pick, the stale line stays without a card", async () => {
    const { deps } = harness([fails(stale("full", 9)), () => ({ ...PREVIEW, botLevel: "full" })]);
    const view = await use(deps);
    expect(view.card).toBeNull();
    expect(view.line?.text).toBe("Nova's settings changed while this was open. Look again, then choose.");
  });

  it("a 500 keeps the card open with the server's line and no level written", async () => {
    const failure = Object.assign(new Error("Murage could not save the level. Try again."), { status: 500, body: {} });
    const { deps, onBot } = harness([fails(failure)]);
    const view = await use(deps);
    expect(view.card?.error).toBe("Murage could not save the level. Try again.");
    expect(view.card?.preview).toBe(PREVIEW);
    expect(onBot).not.toHaveBeenCalled();
    expect(text(renderCard({ error: view.card?.error }))).toContain("Murage could not save the level. Try again.");
  });

  it("a bare desktop-only refusal says why", async () => {
    const { deps } = harness([fails(Object.assign(new Error("not found"), { status: 404, body: {} }))]);
    expect((await use(deps)).card?.error).toBe("Full access can only be turned on in the Murage desktop app.");
  });

  it("opening: a refused preview leaves a line, no card", async () => {
    const { deps } = harness([fails(Object.assign(new Error("not found"), { status: 404, body: {} }))]);
    const view = await openLevelCard(deps, { botId: "b1", target: "unlimited", now: NOW });
    expect(view.card).toBeNull();
    expect(view.line?.text).toBe("No limits can only be turned on in the Murage desktop app.");
  });
});

describe("F14: the default saved, the apply refused", () => {
  const saved = () => ({ permissionRev: 8 });

  it("renders from the 409 body, with [Review conversations] and [Undo]", async () => {
    const { deps } = harness([saved, fails(stale("full", 8))]);
    const { card, line } = await use(deps);
    expect(card).toBeNull();
    expect(line?.text).toBe("Nova's default is Full access. The conversation update was not applied.");
    expect(line?.review).toBe(true);
    expect(line?.undo?.bot?.rev).toBe(8);
    const markup = renderToStaticMarkup(createElement(LevelStatusLine, { line: { ...line!, at: Date.now() }, onUndo: () => {}, onReview: () => {} }));
    expect(markup).toContain('data-level-line="apply-refused"');
    expect(text(markup)).toContain("Review conversations");
    expect(text(markup)).toContain("Undo");
  });

  it("names the level in the body, and takes Undo away once the revision moved", async () => {
    const { deps } = harness([saved, fails(stale("no-limits", 9))]);
    const { line } = await use(deps);
    expect(line?.text).toBe("Nova's default is No limits. The conversation update was not applied. Nova has changed since.");
    expect(line?.undo).toBeNull();
    expect(line?.review).toBe(true);
    const markup = renderToStaticMarkup(createElement(LevelStatusLine, { line: line!, onUndo: () => {}, onReview: () => {} }));
    expect(text(markup)).not.toContain("Undo");
  });

  const lost = fails(new TypeError("Failed to fetch"));

  it("an apply with no answer claims nothing, offers the review and no Undo, and asks nothing more", async () => {
    const { deps, calls } = harness([saved, lost]);
    const { card, line } = await use(deps);
    expect(calls).toHaveLength(2);
    expect(card).toBeNull();
    expect(line?.kind).toBe("apply-refused");
    expect(line?.text).toBe("Nova's default is Full access. Murage could not confirm the conversation update.");
    expect(line?.undo).toBeNull();
    expect(line?.review).toBe(true);
    const markup = renderToStaticMarkup(createElement(LevelStatusLine, { line: { ...line!, at: Date.now() }, onUndo: () => {}, onReview: () => {} }));
    expect(text(markup)).toContain("Review conversations");
    expect(text(markup)).not.toContain("Undo");
  });

  it("a server failure of the apply reads the same way", async () => {
    const { deps } = harness([saved, fails(Object.assign(new Error("Murage could not save the level. Try again."), { status: 500, body: {} }))]);
    const { line } = await use(deps);
    expect(line?.text).toBe("Nova's default is Full access. Murage could not confirm the conversation update.");
    expect(line?.undo).toBeNull();
    expect(line?.review).toBe(true);
  });
});

describe("a lowering goes direct", () => {
  it("names the routine count from the PATCH response", async () => {
    const { deps, calls, onBot } = harness([() => ({ bot: { id: "b1" }, permissionRev: 9, routines: [{}, {}] })]);
    const outcome = await changeDirect(deps, { botId: "b1", target: "auto", previous: "full", acks: {}, desktop: true });
    expect(calls[0].body).toEqual({ ...levelFlags("auto"), settingsScope: "defaults" });
    expect(calls[0].body).not.toHaveProperty("previewId");
    expect(onBot).toHaveBeenCalledOnce();
    if (outcome.kind !== "saved") throw new Error("not saved");
    const line = directLine("Nova", outcome, true, false, NOW);
    expect(line.text).toBe("Nova is on Auto. 2 routines now run at Auto.");
    expect(line.undo?.bot).toEqual({ previous: "full", rev: 9, from: "auto", drivesComputer: false });
    expect(directLine("Nova", { ...outcome, routines: 1 }, true, false, NOW).text).toBe("Nova is on Auto. 1 routine now runs at Auto.");
    expect(directLine("Nova", { ...outcome, routines: 0 }, true, false, NOW).text).toBe("Nova is on Auto.");
  });

  it("a phone sends no settingsScope, and offers the computer instead of Undo (L1b-R2-M01)", async () => {
    const { deps, calls } = harness([() => ({ bot: { id: "b1" }, permissionRev: 9, routines: [] })]);
    const outcome = await changeDirect(deps, { botId: "b1", target: "ask", previous: "auto", acks: {}, desktop: false });
    expect(calls[0].body).not.toHaveProperty("settingsScope");
    if (outcome.kind !== "saved") throw new Error("not saved");
    const line = directLine("Nova", outcome, false, false, NOW);
    expect(line.undo).toBeNull();
    const shown = text(renderToStaticMarkup(createElement(LevelStatusLine, { line, onUndo: () => {}, onReview: () => {} })));
    expect(shown).toContain("Restore this level on your computer");
    expect(shown).not.toContain("Undo");
  });

  it("a refused save is a line, not a change", async () => {
    const { deps } = harness([fails(Object.assign(new Error("Stop this bot's threads before changing shared settings"), { status: 409, body: {} }))]);
    expect(await changeDirect(deps, { botId: "b1", target: "ask", previous: "auto", acks: {}, desktop: true })).toEqual({ kind: "failed", message: "Stop this bot's threads before changing shared settings" });
  });
});

describe("Undo (2.5, F15)", () => {
  const conversations = [
    { threadId: "t1", from: "ask", to: "full", rev: 3 },
    { threadId: "t2", from: "auto", to: "full", rev: 5 },
    { threadId: "t3", from: "auto", to: "full", rev: 2 },
  ];
  const raise: UndoPlan = { bot: { previous: "auto", rev: 8, from: "full", drivesComputer: false }, conversations };
  const ok = () => ({ bot: { id: "b1" }, permissionRev: 9 });

  it("a raise: the previous flags with the PATCH's rev, then each changed conversation with its own", async () => {
    const { deps, calls } = harness([ok, ok, ok, ok]);
    const result = await undoLevelChange(deps, "b1", raise);
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/api/bots/b1", body: { ...levelFlags("auto"), settingsScope: "defaults", ifRev: 8 } });
    expect(calls[0].body).not.toHaveProperty("previewId");
    expect(calls.slice(1).map((call) => [call.path, call.body])).toEqual([
      ["/api/bots/b1/tasks/t1", { ...levelFlags("ask"), ifRev: 3 }],
      ["/api/bots/b1/tasks/t2", { ...levelFlags("auto"), ifRev: 5 }],
      ["/api/bots/b1/tasks/t3", { ...levelFlags("auto"), ifRev: 2 }],
    ]);
    expect(undoneLine("Nova", result, NOW).text).toBe("Taken back. Anything already done stays done.");
  });

  it("one conversation changed since: the rest come back and the line reports both", async () => {
    const { deps } = harness([ok, ok, fails(stale()), ok]);
    const result = await undoLevelChange(deps, "b1", raise);
    expect(undoneLine("Nova", result, NOW).text).toBe("Undone for Nova and 2 conversations. 1 conversation has changed since and kept its level.");
  });

  it("two conversations changed since, one came back", async () => {
    const { deps } = harness([ok, ok, fails(stale()), fails(stale())]);
    expect(undoneLine("Nova", await undoLevelChange(deps, "b1", raise), NOW).text).toBe("Undone for Nova and 1 conversation. 2 conversations have changed since and kept their level.");
  });

  it("the bot refused, conversations restored (the handoff's partial line)", async () => {
    const { deps } = harness([fails(stale()), ok, ok, ok]);
    expect(undoneLine("Nova", await undoLevelChange(deps, "b1", { ...raise }), NOW).text).toBe("Undone for 3 conversations. Nova has changed since and kept its level.");
    const two = harness([fails(stale()), ok, ok]);
    expect(undoneLine("Nova", await undoLevelChange(two.deps, "b1", { ...raise, conversations: conversations.slice(0, 2) }), NOW).text).toBe("Undone for 2 conversations. Nova has changed since and kept its level.");
  });

  it("the bot back, every conversation changed since", async () => {
    const { deps } = harness([ok, fails(stale())]);
    expect(undoneLine("Nova", await undoLevelChange(deps, "b1", { ...raise, conversations: conversations.slice(0, 1) }), NOW).text).toBe("Undone for Nova. 1 conversation has changed since and kept its level.");
  });

  it("all refused: nothing was undone", async () => {
    const { deps } = harness([fails(stale()), fails(stale())]);
    expect(undoneLine("Nova", await undoLevelChange(deps, "b1", { ...raise, conversations: conversations.slice(0, 1) }), NOW).text).toBe("Nova has changed since. Nothing was undone.");
  });

  it("a lowering: ifRev and no previewId, a raise back with the routine count from the answer", async () => {
    const { deps, calls } = harness([() => ({ bot: { id: "b1" }, permissionRev: 10, routines: [{}, {}] })]);
    const result = await undoLevelChange(deps, "b1", { bot: { previous: "full", rev: 9, from: "auto", drivesComputer: false }, conversations: [] });
    expect(calls[0].body).toEqual({ ...levelFlags("full"), settingsScope: "defaults", ifRev: 9 });
    expect(undoneLine("Nova", result, NOW).text).toBe("Nova is back on Full access. 2 routines run at Full access again. Taken back. Anything already done stays done.");
  });

  it("a lowering refused by the server: nothing was undone", async () => {
    const { deps } = harness([fails(stale())]);
    const result = await undoLevelChange(deps, "b1", { bot: { previous: "full", rev: 9, from: "auto", drivesComputer: false }, conversations: [] });
    expect(undoneLine("Nova", result, NOW).text).toBe("Nova has changed since. Nothing was undone.");
  });

  it("back up to Auto on this computer repeats the owner's yes, only from Ask", async () => {
    const { deps, calls } = harness([ok, ok]);
    await undoLevelChange(deps, "b1", { bot: { previous: "auto", rev: 9, from: "ask", drivesComputer: true }, conversations: [] });
    await undoLevelChange(deps, "b1", { bot: { previous: "auto", rev: 9, from: "full", drivesComputer: true }, conversations: [] });
    expect(calls[0].body.acknowledgeLocalAuto).toBe(true);
    expect(calls[1].body).not.toHaveProperty("acknowledgeLocalAuto");
  });

  it("a failed call keeps what is left for Try again, and never repeats what came back", async () => {
    const down = Object.assign(new Error("Murage could not save the level. Try again."), { status: 500, body: {} });
    const { deps } = harness([ok, ok, fails(down), ok]);
    const result = await undoLevelChange(deps, "b1", raise);
    const line = undoneLine("Nova", result, NOW);
    expect(line.text).toBe("Undone for Nova and 2 conversations. Murage could not save the level. Try again.");
    expect(line.retry).toBe(true);
    expect(line.undo).toEqual({ bot: null, conversations: [conversations[1]] });
    const shown = text(renderToStaticMarkup(createElement(LevelStatusLine, { line, onUndo: () => {}, onReview: () => {} })));
    expect(shown).toContain("Try again");
  });
});

describe("the status line", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("offers Undo for the window, then keeps the words", () => {
    const line = raisedLine("Nova", { kind: "saved", level: "full", previous: "auto", rev: 8, changed: [] }, false, Date.now());
    const open = renderToStaticMarkup(createElement(LevelStatusLine, { line, onUndo: () => {}, onReview: () => {} }));
    expect(open).toContain('data-level-line="saved"');
    expect(open).toContain('role="status"');
    expect(text(open)).toContain("Undo");
    const late = renderToStaticMarkup(createElement(LevelStatusLine, { line: { ...line, at: Date.now() - UNDO_WINDOW_MS - 1 }, onUndo: () => {}, onReview: () => {} }));
    expect(text(late)).toContain("Nova is on Full access.");
    expect(text(late)).not.toContain("Undo");
  });
});

describe("copy", () => {
  const strings = Object.entries(l1 as Record<string, string>).filter(([key]) => key.startsWith("ux.l1.confirm.") || key.startsWith("ux.l1.levelLine."));

  it("the new strings pass: no em dash, never the banned word, never a level or bot name written in", () => {
    expect(strings.length).toBeGreaterThan(30);
    for (const [key, value] of strings) {
      expect(value, key).not.toMatch(/—/);
      expect(value, key).not.toMatch(/\bsaf(?:e|ely|ety)\b|\bunsafe\b/i);
      expect(value, key).not.toContain("Nova");
      expect(value, key).not.toMatch(/\b(Full access|No limits)\b(?! are)/);
    }
  });

  it("the card and the lines read their words from the catalogue", () => {
    for (const file of ["./LevelConfirmCard.tsx", "./LevelStatusLine.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+/);
    }
  });
});
