// The chip-order contract, which is the highest-risk line in the intake.
//
// The renderer maps chips by POSITION, not by label, so the order of
// `card.options` is what carries "yes" and "no" across the seam. Nothing
// else in either half fails when that order is wrong: the person presses
// yes, the server records no, and both sides agree they did their job. So
// the order is pinned here, and every failure message below says what
// actually breaks in the product rather than which array differs.
import { describe, expect, it } from "vitest";

import {
  INTAKE_ACCEPT_INDEX,
  INTAKE_DECLINE_INDEX,
  intakeChipIndex,
  intakeChips,
  intakeNarrowPickChips,
  type IntakeCandidate,
  type IntakeChoiceKind,
} from "../shared/intake-turn.ts";

const candidate = (slug: string, name: string): IntakeCandidate => ({ slug, name, skillNames: [] });

const ALL_KINDS: IntakeChoiceKind[] = ["narrow-check", "confirm-profile", "confirm-general"];

describe("intake chip order", () => {
  it("puts the affirmative chip first on the confirm card, or a yes press installs nothing", () => {
    expect(
      intakeChips("confirm-profile")[INTAKE_ACCEPT_INDEX],
      "The renderer reads the confirm card's chips BY INDEX. Index 0 must be the chip that APPLIES the profile. If these two are swapped, pressing 'Set that up' keeps the bot general and pressing 'Keep me general instead' installs a speciality the person just refused, and nothing anywhere throws.",
    ).toBe("Set that up");
    expect(intakeChips("confirm-profile")[INTAKE_DECLINE_INDEX]).toBe("Keep me general instead");
  });

  it("puts the affirmative chip first on the narrow check, or a yes press kills the right guess", () => {
    expect(
      intakeChips("narrow-check")[INTAKE_ACCEPT_INDEX],
      "The renderer reads the narrow-check chips BY INDEX. Index 0 must be the chip that CONFIRMS the named profile. Swapped, agreeing with the bot's guess throws it away and disagreeing accepts it, which is the exact 'chasing invoices lands on a trading profile' bug this whole flow exists to prevent.",
    ).toBe("That's about right");
    expect(intakeChips("narrow-check")[INTAKE_DECLINE_INDEX]).toBe("Not really, it's something else");
  });

  it("puts accept first and the library second on the general card, or accepting opens a panel", () => {
    expect(
      intakeChips("confirm-general")[INTAKE_ACCEPT_INDEX],
      "The renderer reads the general card's chips BY INDEX. Index 0 must be the chip that SETTLES the conversation. Swapped, a person saying 'that's fine' gets the library panel thrown open at them and a person asking for the library gets silence.",
    ).toBe("That's fine");
    expect(intakeChips("confirm-general")[INTAKE_DECLINE_INDEX]).toBe("Show me the library");
  });

  it("never lets a caller choose the order: every fixed pair is exactly two chips", () => {
    for (const kind of ALL_KINDS) {
      const chips = intakeChips(kind);
      expect(chips, `${kind} must render exactly two chips; the renderer's index map has no third slot`).toHaveLength(2);
      expect(chips[INTAKE_ACCEPT_INDEX]).not.toBe(chips[INTAKE_DECLINE_INDEX]);
    }
    expect(INTAKE_ACCEPT_INDEX).toBe(0);
    expect(INTAKE_DECLINE_INDEX).toBe(1);
  });

  it("orders narrow-pick chips as choices[0] then choices[1]", () => {
    const a = candidate("coin", "Numbers");
    const b = candidate("chart", "Smart Trader");
    expect(
      intakeNarrowPickChips(a, b),
      "The narrow-pick chips must be in the same order as IntakeCardData.choices. The renderer answers with the chip's index, so a mismatch hands the person the profile they did not point at.",
    ).toEqual(["Numbers", "Smart Trader"]);
  });

  it("reads a pressed chip back by position, off the card's own options", () => {
    const options = [...intakeChips("confirm-profile")];
    expect(intakeChipIndex(options, "Set that up")).toBe(INTAKE_ACCEPT_INDEX);
    expect(intakeChipIndex(options, "Keep me general instead")).toBe(INTAKE_DECLINE_INDEX);
  });

  // Invariant I7: the composer is always live, so free text is a normal
  // answer to every question and must never be read as a failed chip press.
  it("treats anything that is not a chip as free text, not as a bad answer", () => {
    const options = [...intakeChips("narrow-check")];
    expect(intakeChipIndex(options, "chasing invoices")).toBeNull();
    expect(intakeChipIndex(options, "")).toBeNull();
    // an open question has no chips at all, so nothing is ever a chip press
    expect(intakeChipIndex([], "That's about right")).toBeNull();
  });

  it("ships no em dash or en dash in any chip label", () => {
    const em = String.fromCodePoint(0x2014);
    const en = String.fromCodePoint(0x2013);
    for (const kind of ALL_KINDS) {
      for (const chip of intakeChips(kind)) {
        expect(chip).not.toContain(em);
        expect(chip).not.toContain(en);
      }
    }
  });
});
