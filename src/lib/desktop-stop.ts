/** "Stop using my screen" — the one gesture a person makes when a bot is
 *  driving their desktop and something is going wrong.
 *
 *  Two server facts shape this, and both are why the outcome is reported
 *  rather than assumed:
 *
 *  1. Taking the screen back is the only lever that bites IMMEDIATELY. The
 *     harness refuses a host computer action while a person holds control
 *     (`/api/internal/host-computer` authorises on `computerControl.snapshot`),
 *     and that check covers a bot on Auto as well as one explicitly on "This
 *     computer". It does not wait for an engine to die.
 *  2. Stopping the turn revokes the thread's authority and kills the engine,
 *     so no FURTHER action can be dispatched — but a call already handed to
 *     the desktop driver is awaited, not aborted (`HostComputerBroker`
 *     re-checks authority only after the reply). A keystroke already in
 *     flight lands.
 *
 *  So the honest claim is never "it stopped": it is "nothing more will start,
 *  and what was already underway may finish". Anything that did NOT happen is
 *  named, because a control that says "stopped" while a bot keeps typing is
 *  worse than no control at all.
 */

export type DesktopStopOutcome =
  /** The turn is confirmed over. `heldScreen` says whether the person also
   *  holds the screen, which is what blocks a late action from landing. */
  | { kind: "stopped"; heldScreen: true | false }
  /** The screen is revoked but the turn would not confirm it ended. */
  | { kind: "screen-held-only"; reason: string }
  /** Neither half took. Say so plainly and name why. */
  | { kind: "nothing-stopped"; reason: string };

export interface DesktopStopSteps {
  /** Take the screen back. Resolves true only when the hold is confirmed. */
  takeScreen: () => Promise<boolean>;
  /** Stop the running turn. Rejects with the harness's reason. */
  stopTurn: () => Promise<void>;
  /** Poll until the bot is idle; false when it never went idle. */
  confirmIdle: () => Promise<boolean>;
}

const reasonOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.trim() || "the harness gave no reason";
};

/**
 * Run both halves, never letting one failure hide the other, and report what
 * actually happened. The screen is taken FIRST: if stopping the turn is slow
 * (an engine with a teardown budget) the bot's hands are already refused.
 */
export async function stopDesktopControl({ takeScreen, stopTurn, confirmIdle }: DesktopStopSteps): Promise<DesktopStopOutcome> {
  let heldScreen = false;
  let screenReason = "";
  try {
    heldScreen = await takeScreen();
    if (!heldScreen) screenReason = "the harness did not confirm you have the screen";
  } catch (cause) {
    screenReason = reasonOf(cause);
  }

  let turnReason = "";
  try {
    await stopTurn();
  } catch (cause) {
    turnReason = reasonOf(cause);
  }

  // Ask the harness rather than trusting the 200: a stop that returned OK and
  // left the bot working is exactly the lie this control must not tell.
  const idle = turnReason ? false : await confirmIdle().catch(() => false);
  if (idle) return { kind: "stopped", heldScreen };
  if (heldScreen) return { kind: "screen-held-only", reason: turnReason || "it is still working" };
  return {
    kind: "nothing-stopped",
    reason: [turnReason || "the turn is still working", screenReason].filter(Boolean).join("; "),
  };
}

/** What the panel shows afterwards. `name` is the bot's, as the person knows it. */
export function desktopStopMessage(outcome: DesktopStopOutcome, name: string): string {
  if (outcome.kind === "stopped") {
    return outcome.heldScreen
      ? `${name} stopped, and you have this screen. An action already underway can still finish, so check the screen. Hand control back when you are ready.`
      : `${name} stopped, so it will not start another action. Taking the screen back failed, so an action already underway can still finish, so check the screen.`;
  }
  if (outcome.kind === "screen-held-only") {
    return `You have this screen, so ${name} cannot start another action, but its turn did not confirm it stopped (${outcome.reason}). Use Stop in the header, and check the screen.`;
  }
  return `Nothing was stopped (${outcome.reason}). ${name} may still be using this screen. Use Stop in the header, and check the screen.`;
}
