// A companion that dies without being asked is replaced, on the same widening
// gaps and the same crash cap as the server (server-supervisor.mjs). On
// 2026-10-05 an outside kill of every helper took the companion down with the
// server, and nothing brought it back.
import { createServerSupervisor } from "./server-supervisor.mjs";

/**
 * @param {{
 *   start: () => Promise<unknown>,
 *   shuttingDown: () => boolean,
 *   supervisor?: ReturnType<typeof createServerSupervisor>,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   log?: (line: string) => void,
 * }} options
 */
export function createCompanionRestarter({ start, shuttingDown, supervisor = createServerSupervisor(), schedule = setTimeout, log = () => {} }) {
  let pending = false;
  const api = {
    /** Call from the lifecycle listener. `wasEnabled` is whether the owner had
     * the companion on at the moment it died. Returns the decision taken. */
    onExit({ expected, wasEnabled }) {
      if (expected || !wasEnabled || shuttingDown()) return { action: "none" };
      const decision = supervisor.decide({ intentional: false });
      if (decision.action !== "restart") {
        log(`companion supervisor: ${decision.action} (${decision.reason ?? "stopped"})`);
        return decision;
      }
      if (pending) return decision;
      pending = true;
      log(`companion supervisor: restarting in ${decision.delayMs}ms (attempt ${decision.attempt})`);
      schedule(() => {
        void (async () => {
          try {
            if (shuttingDown()) return;
            const state = await start();
            // A start that did not come up is one more failed life, counted
            // and delayed like the rest, so the cap still ends the loop.
            if (state && (state.enabled === false || state.error)) {
              pending = false;
              api.onExit({ expected: false, wasEnabled: true });
            }
          } catch (error) {
            log(`companion supervisor: restart threw ${error?.message ?? error}`);
          } finally {
            pending = false;
          }
        })();
      }, decision.delayMs);
      return decision;
    },
  };
  return api;
}
