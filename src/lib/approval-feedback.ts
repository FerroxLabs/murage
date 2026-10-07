// Immediate, continuous feedback for the buttons that answer an approval.
//
// An answer can take a while: the phone's device prompt, then the network,
// then the engine. Until it settles the tapped button shows it is working,
// the other buttons on the card are held, and a second tap is ignored here
// (fresh-auth's in-flight join stays as the backstop behind this).
import { useEffect, useMemo, useState } from "react";
import { callNative, nativeHas } from "@/lib/native-shell";

export interface DecisionFeedbackState {
  /** the choice that was tapped and has not settled yet, or null */
  busy: string | null;
  /** the device prompt (Face ID or fingerprint) is up */
  prompting: boolean;
  /** the answer was accepted; the card is waiting to be removed or refetched, so nothing is tappable */
  sent: boolean;
}

export interface DecisionHooks {
  /** the device prompt opened (true) or closed (false) */
  devicePrompt: (up: boolean) => void;
  /** the decision ended without an answer: refusal, cancel or error. Buttons come back. */
  settle: () => void;
  /** the decision was accepted. The buttons stay held until the card goes away. */
  succeed: () => void;
  /** False once a preempting Deny took over or the card went away: a late
   * result of this run must then neither set an error nor touch the card. */
  live: () => boolean;
}

export interface DecisionRunOptions {
  /** A deny-type choice goes out even while another choice is in flight, and takes over the card's state. */
  preempt?: boolean;
  /** Settle back to idle if neither succeed nor settle arrives in this long. */
  watchdogMs?: number;
}

/** An answer that neither succeeds nor fails settles back to idle after this
 * long, twice the browser card's 8 s fallback, so a slow tunnel is not cut off
 * early but buttons are never dead for good. It is stopped while the phone's
 * device prompt is up (the owner may take their time) and restarts when the
 * prompt closes. */
export const DECISION_WATCHDOG_MS = 16_000;

const IDLE: DecisionFeedbackState = { busy: null, prompting: false, sent: false };

/** One buzz on press. The phone shell's `haptic("tap")` when it lists the
 * method (iPhone and Android shells); otherwise `navigator.vibrate(10)`,
 * which Android web views support and iOS does not. Never throws. */
export function tapHaptic(): void {
  try {
    if (nativeHas("haptic")) {
      void Promise.resolve(callNative("haptic", "tap")).catch(() => {});
      return;
    }
  } catch {
    // fall through to the web path
  }
  try {
    globalThis.navigator?.vibrate?.(10);
  } catch {
    // a blocked or missing vibrator is not an error
  }
}

/** The state machine behind the hook, kept free of React so it can be tested. */
export function createDecisionController(emit: (state: DecisionFeedbackState) => void) {
  let state = IDLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current = 0; // id of the run that owns the state; older runs are dead
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const set = (next: DecisionFeedbackState) => {
    state = next;
    emit(next);
  };
  return {
    get state() {
      return state;
    },
    /** Start a decision. False (and `start` never called) when one is in flight
     * (and this is not a preempting deny) or when an answer was already accepted. */
    run(choice: string, start: (hooks: DecisionHooks) => unknown, options: DecisionRunOptions = {}): boolean {
      if (state.sent) return false;
      if (state.busy !== null && !(options.preempt && state.busy !== choice)) return false;
      const id = ++current;
      stop();
      set({ busy: choice, prompting: false, sent: false });
      const watchdogMs = options.watchdogMs ?? DECISION_WATCHDOG_MS;
      const arm = () => {
        stop();
        timer = setTimeout(settle, watchdogMs);
      };
      const mine = () => id === current && !state.sent && state.busy !== null;
      const settle = () => {
        if (!mine()) return;
        stop();
        set(IDLE);
      };
      const hooks: DecisionHooks = {
        devicePrompt: (up) => {
          if (!mine()) return;
          set({ busy: choice, prompting: up, sent: false });
          if (up) stop();
          else arm();
        },
        settle,
        live: mine,
        succeed: () => {
          if (!mine()) return;
          stop();
          set({ busy: choice, prompting: false, sent: true });
        },
      };
      arm();
      try {
        const result = start(hooks);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(undefined, settle);
        }
      } catch {
        settle();
      }
      return true;
    },
    /** Unmount: no timer outlives the card and no late hook of a run in flight sets state.
     * Reusable afterwards (React StrictMode mounts, unmounts and mounts again). */
    dispose() {
      current++;
      stop();
    },
  };
}

/** For a card's buttons: `run(choice, start)` buzzes, marks `choice` busy and
 * holds every other button until `start`'s hooks settle. */
export function useDecisionFeedback() {
  const [state, setState] = useState<DecisionFeedbackState>(IDLE);
  const controller = useMemo(() => createDecisionController(setState), []);
  useEffect(() => () => controller.dispose(), [controller]);
  return useMemo(
    () => ({
      busy: state.busy,
      prompting: state.prompting,
      sent: state.sent,
      run(choice: string, start: (hooks: DecisionHooks) => unknown, options?: DecisionRunOptions): boolean {
        return controller.run(
          choice,
          (hooks) => {
            tapHaptic();
            return start(hooks);
          },
          options,
        );
      },
    }),
    [controller, state],
  );
}
