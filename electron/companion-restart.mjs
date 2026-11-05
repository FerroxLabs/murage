// A companion that dies without being asked is replaced, on the same widening
// gaps and the same crash cap as the server (server-supervisor.mjs). On
// 2026-10-05 an outside kill of every helper took the companion down with the
// server, and nothing brought it back.
//
// The one start at launch is retried here too, so a single owner decides every
// automatic start. The first launch after an update is the slow one (new files
// are scanned, the old sidecar may still hold its ports), and a launch start
// that timed out left a paired phone with no way in until a manual restart.
// Port of the behaviour in upstream c91b82001, kept inside this owner.
import { createServerSupervisor } from "./server-supervisor.mjs";

/** Gaps before each retry of the launch start. */
export const COMPANION_LAUNCH_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000]);

function startFailed(state) {
  return !state || state.enabled === false || Boolean(state.error);
}

/** `start` resolves with `superseded: true` when a stop or a newer start
 * moved the launch generation while it was getting ready, and it then started
 * nothing. That is someone else's companion now, not a failed life. */
function superseded(state) {
  return Boolean(state?.superseded);
}

/**
 * @param {{
 *   start: () => Promise<unknown>,
 *   shuttingDown: () => boolean,
 *   wanted?: () => boolean,
 *   generation?: () => number,
 *   supervisor?: ReturnType<typeof createServerSupervisor>,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   log?: (line: string) => void,
 *   launchDelaysMs?: readonly number[],
 * }} options
 *
 * `wanted` reads the saved phone-on flag. `generation` reads the launch
 * generation that every start, stop and unasked exit moves; `start` moves it
 * by exactly one, so any other move means someone else now owns the companion.
 */
export function createCompanionRestarter({
  start,
  shuttingDown,
  wanted = () => true,
  generation = () => 0,
  supervisor = createServerSupervisor(),
  schedule = setTimeout,
  log = () => {},
  launchDelaysMs = COMPANION_LAUNCH_RETRY_DELAYS_MS,
}) {
  let pending = false;
  // Bumped to cancel a launch retry run; onExit takes over by bumping it.
  let launchRun = 0;
  // Every automatic start (launch try or exit restart) runs to settlement
  // before the next one enters, so two never overlap.
  // `stillOwned` is checked inside the chain, right before `start`, so a Stop
  // or a manual start pressed while a start waited its turn wins.
  let chain = Promise.resolve();
  const serialStart = (stillOwned) => {
    const next = chain.then(() => (stillOwned() ? start() : { superseded: true }));
    chain = next.catch(() => {});
    return next;
  };
  // Lets only the newest exit restart clear `pending`.
  let pendingToken = 0;
  // The generation the pending exit restart belongs to.
  let pendingOwner = null;
  const api = {
    /** The start at launch, retried after each gap while the phone is still
     * on, nobody else started or stopped the companion, no exit restart is
     * pending and the app is not quitting. A thrown start (a policy refusal or
     * a cancelled startup) is never retried. Never rejects; resolves with the
     * last state, or null after a throw. */
    async launchStart() {
      const run = ++launchRun;
      const owned = () => run === launchRun && !pending && !shuttingDown() && wanted();
      const attempt = async () => {
        const before = generation();
        const state = await serialStart(() => run === launchRun && !shuttingDown() && wanted() && generation() === before);
        return { state, ours: !superseded(state) && generation() === before + 1 };
      };
      let result;
      try {
        result = await attempt();
        for (const [index, delay] of launchDelaysMs.entries()) {
          if (!startFailed(result.state)) return result.state;
          if (!result.ours || !owned()) {
            log("companion start retry skipped: the companion is no longer wanted here");
            return result.state;
          }
          const reason = result.state?.error ?? "not running";
          log(`companion start failed: ${reason}; trying again in ${Math.round(delay / 1000)}s (${index + 1} of ${launchDelaysMs.length})`);
          const settled = generation();
          await new Promise((resolve) => schedule(resolve, delay));
          if (!owned() || generation() !== settled) {
            log("companion start retry skipped: the companion is no longer wanted here");
            return result.state;
          }
          result = await attempt();
        }
      } catch (error) {
        log(`companion launch start not retried: ${error?.message ?? error}`);
        return null;
      }
      if (startFailed(result.state)) {
        log(`companion start failed: ${result.state?.error ?? "not running"}; giving up until the app restarts`);
      }
      return result.state;
    },

    /** Call from the lifecycle listener. `wasEnabled` is whether the owner had
     * the companion on at the moment it died. Returns the decision taken. */
    onExit({ expected, wasEnabled }) {
      if (expected || !wasEnabled || shuttingDown()) return { action: "none" };
      const decision = supervisor.decide({ intentional: false });
      if (decision.action !== "restart") {
        log(`companion supervisor: ${decision.action} (${decision.reason ?? "stopped"})`);
        return decision;
      }
      // The listener moved the generation before calling here; any later move
      // is a Stop or a manual start, and a restart scheduled before it stands
      // down. A crash of that newer companion replaces the stale restart.
      const owner = generation();
      if (pending && pendingOwner === owner) return decision;
      pending = true;
      pendingOwner = owner;
      const token = ++pendingToken;
      // One owner: a launch retry waiting its turn stops here.
      launchRun += 1;
      log(`companion supervisor: restarting in ${decision.delayMs}ms (attempt ${decision.attempt})`);
      schedule(() => {
        void (async () => {
          try {
            if (shuttingDown()) return;
            const state = await serialStart(() => !shuttingDown() && generation() === owner);
            if (superseded(state)) return;
            // A start that did not come up is one more failed life, counted
            // and delayed like the rest, so the cap still ends the loop.
            if (state && (state.enabled === false || state.error)) {
              pending = false;
              api.onExit({ expected: false, wasEnabled: true });
            }
          } catch (error) {
            log(`companion supervisor: restart threw ${error?.message ?? error}`);
          } finally {
            if (token === pendingToken) pending = false;
          }
        })();
      }, decision.delayMs);
      return decision;
    },
  };
  return api;
}
