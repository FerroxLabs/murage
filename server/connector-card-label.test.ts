// SPDX-License-Identifier: AGPL-3.0-or-later
// A chat connect card signs in under the label the person confirmed on it
// (#758). The bot's suggestion only fills in the form; once a label is
// confirmed, the card is named and matched by it, and a label another
// account holds is told apart so the form can say so.
import { describe, expect, it } from "vitest";
import { authorizeFailureSentence, CONNECT_CARD_NEEDS_LABEL, connectorLabelTaken, relabelConnector } from "./connector-requests.ts";

describe("a connect card under its confirmed label", () => {
  it("takes the confirmed label in place of the bot's suggestion, title included", () => {
    expect(relabelConnector({ label: "Gmail (Work)", alias: "Work" }, "Home 2")).toEqual({ label: "Gmail (Home 2)", alias: "Home 2" });
  });

  it("names a card the bot asked for with no label", () => {
    expect(relabelConnector({ label: "Gmail" }, "personal")).toEqual({ label: "Gmail (personal)", alias: "personal" });
  });

  it("keeps everything else on the card as it was", () => {
    const card = { slug: "gmail", label: "Gmail (Work)", alias: "Work", status: "required" as const, resumeKey: "k", description: "d" };
    expect(relabelConnector(card, "home")).toEqual({ ...card, alias: "home", label: "Gmail (home)" });
  });

  it("asks for a label in plain words", () => {
    expect(CONNECT_CARD_NEEDS_LABEL).toBe("Enter a label for the account, such as work or personal.");
  });

  it("tells a label another account holds apart from other refusals", () => {
    const clash = Object.assign(new Error('Account alias "home" is already in use for gmail'), { status: 409 });
    expect(connectorLabelTaken(clash)).toBe(true);
    expect(authorizeFailureSentence(clash, "Gmail (home)")).toBe(clash.message);
    expect(connectorLabelTaken(Object.assign(new Error("conflict"), { status: 409 }))).toBe(false);
    expect(connectorLabelTaken(Object.assign(new Error(clash.message), { status: 502 }))).toBe(false);
  });
});
