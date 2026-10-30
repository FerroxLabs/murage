// Full access's two per-bot extras, as rules: the owner's own messages from
// Telegram, Slack and Discord, and setup requests (installing skills,
// proposing routines, trusting folders). Both are off unless the owner turns
// them on from the desktop, and both do nothing unless Full access is on.
// The HTTP wiring is pinned in full-access-options-api.test.ts.
import { describe, expect, it } from "vitest";

import { autoVerdict, fullAccessCovers } from "./auto-approve.ts";
import { fullAccessApprovesSetup, fullAccessOptionsChange } from "./full-access.ts";

const full = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const auto = { autoApprove: true, fullAccess: false, alwaysAllow: [] };
const channels = { ...full, fullAccessChannelMessages: true };
const setup = { ...full, fullAccessSetupRequests: true };

/** A turn started by the owner's own Telegram, Slack or Discord message:
 * it runs unattended inside a channel routine run. */
const ownerChannel = { unattended: true, automated: true, channelOwner: true } as const;

describe("owner channel messages under Full access", () => {
  it("still ask by default, exactly as Auto judges an unattended turn", () => {
    const verdict = autoVerdict(full, "Bash", "cat ~/.zshrc", ownerChannel);
    expect(verdict.approve).toBeNull();
    expect(verdict).toEqual(autoVerdict(auto, "Bash", "cat ~/.zshrc", ownerChannel));
    expect(autoVerdict(full, "Bash", "ls", ownerChannel).source).toBe("unattended-block");
  });

  it("run under Full access once the owner allows it", () => {
    const verdict = autoVerdict(channels, "Bash", "rm -rf build", ownerChannel);
    expect(verdict.source).toBe("full-access");
    expect(verdict.approve).toContain("full access");
    // the key guard and the stop line still hold there, as at the desktop
    expect(autoVerdict(channels, "Bash", "cat ~/.zshrc", ownerChannel).source).toBe("sensitive-guard");
    expect(autoVerdict(channels, "Bash", "x", { ...ownerChannel, stopLine: { kind: "pay", what: "Make a payment" } }).source).toBe("stop-line");
  });

  it("the option does nothing without Full access", () => {
    const autoWithOption = { ...auto, fullAccessChannelMessages: true };
    expect(autoVerdict(autoWithOption, "Bash", "ls", ownerChannel).approve).toBeNull();
  });

  it("never covers a webhook or routine turn, whatever the option says", () => {
    expect(autoVerdict(channels, "Bash", "ls", { unattended: true }).approve).toBeNull();
    expect(autoVerdict(channels, "Bash", "cat ~/.zshrc", { automated: true }).source).toBe("sensitive-guard");
  });

  it("only a real boolean counts: a missing or odd stored value is off", () => {
    expect(fullAccessCovers({ ...full, fullAccessChannelMessages: "yes" as unknown as boolean }, "owner-channel")).toBe(false);
    expect(fullAccessCovers(full, "owner-channel")).toBe(false);
    expect(fullAccessCovers(channels, "owner-channel")).toBe(true);
    expect(fullAccessCovers(channels, "other")).toBe(false);
    expect(fullAccessCovers(full, "owner")).toBe(true);
  });

  it("a question still reaches the owner", () => {
    expect(autoVerdict(channels, "AskUserQuestion", "Which branch?", ownerChannel).source).toBe("question-tool");
  });
});

describe("setup requests under Full access", () => {
  it("still ask by default", () => {
    expect(fullAccessApprovesSetup(full, "owner")).toBe(false);
    expect(fullAccessApprovesSetup({ ...full, fullAccessSetupRequests: "true" as unknown as boolean }, "owner")).toBe(false);
  });

  it("are approved in the owner's own turn once the owner allows it", () => {
    expect(fullAccessApprovesSetup(setup, "owner")).toBe(true);
  });

  it("need Full access itself", () => {
    expect(fullAccessApprovesSetup({ ...auto, fullAccessSetupRequests: true }, "owner")).toBe(false);
    expect(fullAccessApprovesSetup({ autoApprove: false, fullAccess: true, fullAccessSetupRequests: true }, "owner")).toBe(false);
  });

  it("never for a webhook or routine turn, or anyone but the owner", () => {
    expect(fullAccessApprovesSetup({ ...setup, fullAccessChannelMessages: true }, "other")).toBe(false);
  });

  it("from the owner's channel messages only when both options are on", () => {
    expect(fullAccessApprovesSetup(setup, "owner-channel")).toBe(false);
    expect(fullAccessApprovesSetup({ ...setup, fullAccessChannelMessages: true }, "owner-channel")).toBe(true);
  });
});

describe("changing the options", () => {
  it("setting either is the desktop app's decision alone", () => {
    expect(fullAccessOptionsChange({ fullAccessChannelMessages: true }, false)).toMatchObject({ ok: false, status: 404 });
    expect(fullAccessOptionsChange({ fullAccessSetupRequests: true }, false)).toMatchObject({ ok: false, status: 404 });
    expect(fullAccessOptionsChange({ fullAccessSetupRequests: false }, false)).toMatchObject({ ok: false, status: 404 });
    expect(fullAccessOptionsChange({ fullAccessChannelMessages: true, fullAccessSetupRequests: false }, true)).toEqual({
      ok: true, patch: { fullAccessChannelMessages: true, fullAccessSetupRequests: false },
    });
  });

  it("rejects non-booleans and leaves other requests alone", () => {
    expect(fullAccessOptionsChange({ fullAccessSetupRequests: "yes" }, true)).toMatchObject({ ok: false, status: 400 });
    expect(fullAccessOptionsChange({ fullAccessChannelMessages: 1 }, true)).toMatchObject({ ok: false, status: 400 });
    expect(fullAccessOptionsChange({ title: "x" }, true)).toEqual({ ok: true, patch: {} });
  });
});
