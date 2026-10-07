// "IS THIS WORKING" AND "IS MY KEY IN THIS BOX" ARE DIFFERENT QUESTIONS.
//
// Reported from a real workspace: the connected-apps row showed a green dot,
// the word Connected, eight dots in the field and a red Clear button, on a
// machine where that field had never held a key. All four were reporting that
// connected apps WORKED, which they did, through the broker a Flux Router key
// pays for. The owner read them as "your key is saved", pressed Clear several
// times trying to make the app admit it had lost one, and could not tell
// whether his own key had ever gone in.
//
// A green light that cannot be made to go out by removing your key is not a
// light about your key.

import { describe, expect, it } from "vitest";

import { credentialRowState } from "./ApiKeys";
import type { ConfigStatus } from "@/state/store";

const config = (over: Partial<ConfigStatus> = {}): ConfigStatus => ({
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  opencodeGo: { configured: false },
  ...over,
} as ConfigStatus);

describe("the key rows that remain", () => {
  it("leaves the rows that really are one question alone", () => {
    // Box and OpenCode have no broker: their own key IS the capability, so
    // both answers are the same answer and the row is unchanged.
    expect(credentialRowState("box", config({ box: { configured: true } })))
      .toMatchObject({ stored: true, working: true, status: "Connected", tone: "own" });
    expect(credentialRowState("box", config({ box: { configured: false } })))
      .toMatchObject({ stored: false, working: false, status: "" });
  });
});
