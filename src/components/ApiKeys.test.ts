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

describe("the connected apps key row", () => {
  it("never names the broker, and makes the 500+ claim", () => {
    for (const mode of ["self-hosted", "managed", "unavailable"] as const) {
      const state = credentialRowState("composio", config({ composio: { configured: mode !== "unavailable", mode } }));
      expect.soft(state.detail, mode).not.toMatch(/composio/i);
      expect.soft(state.status, mode).not.toMatch(/composio/i);
      expect.soft(state.detail, mode).toMatch(/500\+/);
    }
  });

  it("says Connected only when this row's own key is the one running", () => {
    const own = credentialRowState("composio", config({ composio: { configured: true, mode: "self-hosted" } }));
    expect(own).toMatchObject({ stored: true, working: true, status: "Connected", tone: "own" });
    expect(own.detail).toMatch(/your own key/i);
  });

  it("does not claim a saved key when a broker is carrying it", () => {
    const borrowed = credentialRowState("composio", config({ composio: { configured: true, mode: "managed" } }));
    // It works, and saying nothing would be its own small lie.
    expect(borrowed.working).toBe(true);
    // ...but nothing here may read as "your key is in this box".
    expect(borrowed.stored, "a managed connection reported the row's key as stored").toBe(false);
    expect(borrowed.tone).toBe("borrowed");
    expect(borrowed.status).not.toBe("Connected");
    expect(borrowed.status).toBe("Already connected via Flux Router");
    // ...and the line underneath tells them there is nothing to do, while
    // still leaving their own key on the table. It used to say this key was
    // REQUIRED, which is what sent them hunting for one.
    expect(borrowed.detail).toMatch(/nothing to do/i);
    expect(borrowed.detail).toMatch(/your own key/i);
    expect(borrowed.detail).not.toMatch(/required/i);
  });

  it("says nothing at all when it is neither", () => {
    expect(credentialRowState("composio", config({ composio: { configured: false, mode: "unavailable" } })))
      .toMatchObject({ stored: false, working: false, status: "", tone: "none" });
    expect(credentialRowState("composio", null)).toMatchObject({ stored: false, status: "" });
  });

  it("leaves the rows that really are one question alone", () => {
    // Box and OpenCode have no broker: their own key IS the capability, so
    // both answers are the same answer and the row is unchanged.
    expect(credentialRowState("box", config({ box: { configured: true } })))
      .toMatchObject({ stored: true, working: true, status: "Connected", tone: "own" });
    expect(credentialRowState("box", config({ box: { configured: false } })))
      .toMatchObject({ stored: false, working: false, status: "" });
  });

  // The dots in the field and the red Clear button are both rendered from
  // `stored`, so this is the assertion that keeps them honest: on a managed
  // connection there is nothing to clear, and offering to clear it is what
  // sent the owner round in circles.
  it("has nothing to clear when the key is not this row's", () => {
    const borrowed = credentialRowState("composio", config({ composio: { configured: true, mode: "managed" } }));
    expect(borrowed.stored).toBe(false);
  });
});
