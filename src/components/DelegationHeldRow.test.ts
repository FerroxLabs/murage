// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The held hand-off row: a choice that does not go through puts both buttons back and says so. (There is no DOM library in this repo, so the row is
// tested as it is built: the view for each state, and the driver that moves it between states.)
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationHeldView, HELD_ACTION_FAILED, heldAction, performHeldAction } from "./DelegationHeldRow";
import type { Action } from "../state/store";

const text = "Murage restarted while handing this to @Helper. It may have started. Check @Helper's conversation, or send it again.";
const view = (state: { busy: boolean; failed: boolean }) => renderToStaticMarkup(createElement(DelegationHeldView, { text, ...state, onSendAgain: () => {}, onDismiss: () => {} }));
const disabled = (markup: string) => (markup.match(/ disabled=""/g) ?? []).length;
/** A recorder for the two flags the row keeps. */
function recorder() {
  const log: string[] = [];
  return { log, ui: { setBusy: (value: boolean) => { log.push(`busy:${value}`); }, setFailed: (value: boolean) => { log.push(`failed:${value}`); } } };
}

describe("the held hand-off row", () => {
  it("offers Send again and Dismiss, both enabled, with no failure line", () => {
    const markup = view({ busy: false, failed: false });
    expect(markup).toContain("Send again");
    expect(markup).toContain("Dismiss");
    expect(disabled(markup)).toBe(0);
    expect(markup).not.toContain(HELD_ACTION_FAILED);
    expect(markup).toContain("Murage restarted while handing this to @Helper.");
  });
  it("turns both buttons off while a choice is out", () => {
    expect(disabled(view({ busy: true, failed: false }))).toBe(2);
  });
  it("a rejected Send again re-enables both buttons and says it did not go through", async () => {
    const { log, ui } = recorder();
    await performHeldAction(() => Promise.reject(new Error("503")), ui);
    expect(log).toEqual(["busy:true", "failed:false", "failed:true", "busy:false"]);
    const after = view({ busy: false, failed: true });
    expect(disabled(after)).toBe(0);                                                 // the owner can try again, with either button
    expect(after).toContain("Try that again in a moment.");
    expect(after).toContain('role="alert"');
  });
  it("a rejected Dismiss does the same, and a choice that goes through clears an earlier failure", async () => {
    const { log, ui } = recorder();
    await performHeldAction(() => Promise.reject(new Error("409")), ui);
    await performHeldAction(() => Promise.resolve(), ui);
    expect(log).toEqual(["busy:true", "failed:false", "failed:true", "busy:false", "busy:true", "failed:false", "busy:false"]);
  });
  it("the wording has no dash and no internal code", () => {
    expect(HELD_ACTION_FAILED).toBe("Try that again in a moment.");
    expect(HELD_ACTION_FAILED).not.toMatch(/[–—]/);
  });
  it("heldAction hands the store a promise that settles with the server's answer", async () => {
    const seen: Action[] = [];
    const accepted = heldAction((action) => { seen.push(action); if (action.type === "resendDelegation") action.settled?.resolve(); }, "resendDelegation", "h-1", "thread-1");
    await expect(accepted).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ type: "resendDelegation", delegationId: "h-1", threadId: "thread-1" });
    const refused = heldAction((action) => { if (action.type === "dismissDelegation") action.settled?.reject(new Error("no")); }, "dismissDelegation", "h-2");
    await expect(refused).rejects.toThrow("no");
  });
});
