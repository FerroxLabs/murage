// The one property this control has to hold: it never says it stopped a bot
// that is still driving the screen.
import { describe, expect, it } from "vitest";
import { desktopStopMessage, stopDesktopControl } from "./desktop-stop";

const steps = (over: Partial<Parameters<typeof stopDesktopControl>[0]> = {}) => ({
  takeScreen: async () => true,
  stopTurn: async () => {},
  confirmIdle: async () => true,
  ...over,
});

describe("stopDesktopControl", () => {
  it("reports a real stop only when the bot is confirmed idle", async () => {
    expect(await stopDesktopControl(steps())).toEqual({ kind: "stopped", heldScreen: true });
  });

  it("never claims a stop when the bot is still working", async () => {
    const outcome = await stopDesktopControl(steps({ confirmIdle: async () => false }));
    expect(outcome.kind).toBe("screen-held-only");
  });

  it("names the harness's reason when the stop is refused", async () => {
    const outcome = await stopDesktopControl(steps({
      stopTurn: async () => { throw new Error("the bot switched tasks before it could be interrupted"); },
    }));
    expect(outcome).toEqual({ kind: "screen-held-only", reason: "the bot switched tasks before it could be interrupted" });
  });

  it("does not wait on the idle check once the stop itself failed", async () => {
    let polled = false;
    await stopDesktopControl(steps({
      stopTurn: async () => { throw new Error("refused"); },
      confirmIdle: async () => { polled = true; return true; },
    }));
    expect(polled).toBe(false);
  });

  it("still stops the turn when taking the screen fails, and says the screen is not held", async () => {
    const outcome = await stopDesktopControl(steps({ takeScreen: async () => { throw new Error("no hold"); } }));
    expect(outcome).toEqual({ kind: "stopped", heldScreen: false });
  });

  it("reports nothing stopped, with both reasons, when neither half took", async () => {
    const outcome = await stopDesktopControl(steps({
      takeScreen: async () => false,
      stopTurn: async () => { throw new Error("refused"); },
    }));
    expect(outcome).toEqual({
      kind: "nothing-stopped",
      reason: "refused; the harness did not confirm you have the screen",
    });
  });

  it("treats an unconfirmed hold as no hold rather than as success", async () => {
    const outcome = await stopDesktopControl(steps({ takeScreen: async () => false, confirmIdle: async () => false }));
    expect(outcome).toEqual({ kind: "nothing-stopped", reason: "the turn is still working; the harness did not confirm you have the screen" });
  });
});

describe("desktopStopMessage", () => {
  it("tells the person an action already underway can still finish", () => {
    expect(desktopStopMessage({ kind: "stopped", heldScreen: true }, "Fig")).toContain("already underway can still finish");
  });

  it("never reads as success when nothing stopped", () => {
    const text = desktopStopMessage({ kind: "nothing-stopped", reason: "refused" }, "Fig");
    expect(text).toContain("Nothing was stopped");
    expect(text).toContain("refused");
    expect(text).not.toMatch(/\bstopped,/);
  });

  it("says the screen is held but the turn is not confirmed over", () => {
    const text = desktopStopMessage({ kind: "screen-held-only", reason: "it is still working" }, "Fig");
    expect(text).toContain("cannot start another action");
    expect(text).toContain("did not confirm it stopped");
  });

  it("admits when the screen was not taken back", () => {
    expect(desktopStopMessage({ kind: "stopped", heldScreen: false }, "Fig")).toContain("Taking the screen back failed");
  });
});
