// Who can start which call (callbar-rereview3.md A9): a bot call needs a
// microphone path (a Mac's own dictation, or hosted transcription anywhere
// else), but a channel call is driven only by the Mac's speech helper.
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { callSupport, helpPanelLeft, showsGroupCallButton } from "./call-support";

describe("callSupport", () => {
  it("a bot call is supported by Mac speech or by hosted transcription", () => {
    expect(callSupport({ macSpeech: true, hostedSpeech: false, macOnly: false }).supported).toBe(true);
    expect(callSupport({ macSpeech: false, hostedSpeech: true, macOnly: false }).supported).toBe(true);
    expect(callSupport({ macSpeech: false, hostedSpeech: false, macOnly: false }).supported).toBe(false);
  });

  it("a channel call on a phone, Windows or Linux (hosted transcription, no Mac helper) is not offered", () => {
    const support = callSupport({ macSpeech: false, hostedSpeech: true, macOnly: true });
    expect(support.supported).toBe(false);
    expect(support.label).toMatch(/Mac/);
    expect(support.reason).toMatch(/Mac/);
  });

  it("a channel call on a Mac is offered", () => {
    expect(callSupport({ macSpeech: true, hostedSpeech: true, macOnly: true }).supported).toBe(true);
  });

  it("the Mac-only copy follows the house rules", () => {
    const { label, reason } = callSupport({ macSpeech: false, hostedSpeech: true, macOnly: true });
    for (const text of [label, reason]) {
      expect(text).not.toMatch(/—|–/);
      expect(text).not.toMatch(/\bsafe/i);
      expect(text).not.toMatch(/[$£€]/);
    }
  });
});

describe("showsGroupCallButton", () => {
  it("is hidden on a phone and wherever there is no desktop bridge (nothing there can ever place a channel call)", () => {
    expect(showsGroupCallButton({ desktopBridge: false, phone: true })).toBe(false);
    expect(showsGroupCallButton({ desktopBridge: false, phone: false })).toBe(false);
    expect(showsGroupCallButton({ desktopBridge: true, phone: true })).toBe(false);
  });
  it("stays on a desktop, where a disabled one explains itself", () => {
    expect(showsGroupCallButton({ desktopBridge: true, phone: false })).toBe(true);
  });
});

describe("helpPanelLeft", () => {
  const inside = (button: { left: number; right: number }, vw: number, width = 280) => {
    const left = button.left + helpPanelLeft(button, vw, width);
    const w = Math.min(width, vw - 24);
    return { left, right: left + w, vw };
  };
  it("hangs the panel from the button's right edge when it fits there", () => {
    const at = inside({ left: 900, right: 940 }, 1200);
    expect(at.right).toBe(940);
  });
  it("moves a panel that would leave the left edge back onto the screen", () => {
    const at = inside({ left: 60, right: 100 }, 390);
    expect(at.left).toBeGreaterThanOrEqual(12);
    expect(at.right).toBeLessThanOrEqual(390 - 12);
  });
  it("a button mid-screen in a narrow window still keeps the panel on both sides", () => {
    for (const left of [0, 20, 150, 250, 340]) {
      const at = inside({ left, right: left + 36 }, 390);
      expect(at.left, `button at ${left}`).toBeGreaterThanOrEqual(12);
      expect(at.right, `button at ${left}`).toBeLessThanOrEqual(390 - 12);
    }
  });
  it("a viewport narrower than the panel gets a panel that fits it", () => {
    const at = inside({ left: 100, right: 136 }, 250);
    expect(at.left).toBeGreaterThanOrEqual(12);
    expect(at.right).toBeLessThanOrEqual(250 - 12);
  });
});

describe("GroupCallButton and its panel", () => {
  const source = readFileSync("src/components/CallControls.tsx", "utf8");
  it("renders nothing where showsGroupCallButton says no", () => {
    expect(source).toContain("if (!showsGroupCallButton({ desktopBridge: Boolean(window.muragebox), phone: isPhoneClient() })) return null;");
  });
  it("keeps the reason panel inside the viewport", () => {
    expect(source).toContain("max-w-[calc(100vw-1.5rem)]");
    expect(source).toContain("style={{ left: panelLeft }}");
  });
});
