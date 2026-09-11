import { describe, expect, it } from "vitest";
import { hostStoppedActivityName } from "../../shared/host-stop";
import { stateForBot } from "./mascot";

// A host stop (shared/host-stop.ts) is one activity with ok:false and a
// "stopped:" name. It is a neutral stop — the transcript shows a StoppedRow,
// not a red card — so the avatar must not switch to the alert glyph for it
// the way it does for a failed tool run (STOP2 verifier follow-up).
describe("stateForBot and a host-stop notice", () => {
  const bot = (last: { kind: string; tool?: { name?: string; ok?: boolean } }) => ({
    name: "Bruce",
    messages: [{ kind: "text" }, last],
  });

  it("alerts on a failed tool run", () => {
    expect(stateForBot(bot({ kind: "activity", tool: { name: "Bash", ok: false } }))).toBe("alerting");
    expect(stateForBot(bot({ kind: "activity", tool: { name: "error: claude exited null before result", ok: false } }))).toBe("alerting");
  });

  it("reads a host-stop notice as a neutral stop, not an alert", () => {
    const stopped = { kind: "activity", tool: { name: hostStoppedActivityName("this computer was switched off for the bot"), ok: false } };
    expect(stateForBot(bot(stopped))).toBe("idle");
    expect(stateForBot({ ...bot(stopped), unread: true })).toBe("notifying");
    expect(stateForBot({ ...bot(stopped), busy: true })).toBe("working");
  });

  it("still honours a pinned expression over everything", () => {
    expect(stateForBot({ ...bot({ kind: "activity", tool: { name: "Bash", ok: false } }), mascotExpression: "happy" })).toBe("happy");
  });
});
