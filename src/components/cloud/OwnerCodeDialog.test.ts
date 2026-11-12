// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { afterBackspace, applyDigits, emptyDigits, OwnerCodeDialog, OwnerCodeDialogView } from "./OwnerCodeDialog";
import { OwnerExpiredBannerView, ownerExpired } from "./OwnerExpiredBanner";
import type { OwnerCodeSession } from "@/lib/owner-code";
const DASHES = /[\u2013\u2014]/;

const noop = () => {};
const session = (over: Partial<OwnerCodeSession> = {}): OwnerCodeSession => ({ phase: "ready", maskedEmail: "s***@gmail.com", act: "turn on Full access for Dax", resendAt: 0, error: "", ...over });
const view = (over: Partial<Parameters<typeof OwnerCodeDialogView>[0]> = {}) => renderToStaticMarkup(createElement(OwnerCodeDialogView, { session: session(), digits: emptyDigits(), secondsLeft: 0, onChange: noop, onKey: noop, onConfirm: noop, onResend: noop, onCancel: noop, ...over }));

describe("OwnerCodeDialog", () => {
  it("says One more step, the masked email and the act, with 6 labelled one-time-code boxes", () => {
    const html = view();
    expect(html).toContain("One more step.");
    expect(html).toContain("We sent a 6-digit code to s***@gmail.com. Enter it to turn on Full access for Dax.");
    expect(html.match(/<input /g)).toHaveLength(6);
    expect(html.match(/autoComplete="one-time-code"|autocomplete="one-time-code"/gi)).toHaveLength(6);
    expect(html.match(/inputMode="numeric"|inputmode="numeric"/gi)).toHaveLength(6);
    expect(html).toContain('aria-label="Digit 1 of 6"');
    expect(html).toContain('aria-label="Digit 6 of 6"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Confirm");
    expect(html).toContain("Send a new code");
    expect(html).not.toMatch(DASHES);
  });
  it("Send a new code is off while resendIn runs, Confirm is off until all 6 digits are in", () => {
    const waiting = view({ secondsLeft: 12 });
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Send a new code/);
    expect(waiting).toContain("another code in 12 seconds");
    expect(view({ digits: ["1", "2", "3", "4", "5", "6"] })).not.toMatch(/<button[^>]*disabled=""[^>]*>Confirm/);
    expect(view()).toMatch(/<button[^>]*disabled=""[^>]*>Confirm/);
  });
  it("shows the refusal words in an alert", () => {
    expect(view({ session: session({ error: "That code didn't work. Try again." }) })).toContain("That code didn&#x27;t work. Try again.");
  });
  it("renders nothing until a code step is running", () => {
    expect(renderToStaticMarkup(createElement(OwnerCodeDialog))).toBe("");
  });
  it("a paste of 6 digits fills every box from any box; typing moves on; junk is ignored", () => {
    expect(applyDigits(emptyDigits(), 3, "123 456").digits).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(applyDigits(emptyDigits(), 3, "123456").focus).toBe(5);
    expect(applyDigits(emptyDigits(), 0, "7")).toEqual({ digits: ["7", "", "", "", "", ""], focus: 1 });
    expect(applyDigits(emptyDigits(), 2, "ab").digits).toEqual(emptyDigits());
    expect(applyDigits(["1", "", "", "", "", ""], 4, "9").digits).toEqual(["1", "", "", "", "9", ""]);
  });
  it("backspace clears this box, or steps back and clears the one before", () => {
    expect(afterBackspace(["1", "2", "", "", "", ""], 1)).toEqual({ digits: ["1", "", "", "", "", ""], focus: 1 });
    expect(afterBackspace(["1", "2", "", "", "", ""], 2)).toEqual({ digits: ["1", "", "", "", "", ""], focus: 1 });
    expect(afterBackspace(emptyDigits(), 0).focus).toBe(0);
  });
});

describe("OwnerExpiredBanner", () => {
  it("shows the way back only on a Cloud home whose config says owner:false", () => {
    expect(ownerExpired({ owner: false }, true)).toBe(true);
    expect(ownerExpired({ owner: true }, true)).toBe(false);
    expect(ownerExpired({}, true)).toBe(false);
    expect(ownerExpired(undefined, true)).toBe(false);
    expect(ownerExpired({ owner: false }, false)).toBe(false);
    expect(renderToStaticMarkup(createElement(OwnerExpiredBannerView))).toContain("To change settings, open Murage from murage.ai.");
  });
});

describe("the code dialog follows the visual viewport so the keyboard never covers its actions", () => {
  it("the overlay is sized to --vvh (100dvh fallback), not pinned to the layout viewport", () => {
    const html = view();
    expect(html).toContain("overlay-inset");
    expect(html).toContain("h-[var(--vvh,100dvh)]");
    expect(html).toContain("top-0");
    expect(html).not.toMatch(/class="[^"]*\binset-0\b/);
  });
});

