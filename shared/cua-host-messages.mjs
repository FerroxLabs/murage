// Messages between Electron main and the harness for Windows computer use (DESIGN 1022-cua-windows D10, D15, D16, D20).
// Owners: the Windows builder lane (build-1022-cua-windows) owns both sides of this module; main (electron/main.mjs,
// electron/cua-windows-runtime.cjs) and the harness (server) only import it. Main -> harness goes over the private
// utility-process port; harness -> main over utilityParentPort. Nothing else ever builds these shapes by hand.

export const HOST_DESKTOP = "murage:host-desktop";
export const HOST_DESKTOP_READY = "murage:host-desktop-ready";
export const CUA_GENERATION = "murage:cua-generation";
export const CUA_STUCK = "murage:cua-stuck";
export const CUA_INTEGRITY = "murage:cua-integrity";

export const HOST_DESKTOP_STATES = Object.freeze(["locked", "active", "unknown"]);
export const WITHDRAW_CAUSES = Object.freeze(["disable", "restart", "integrity", "quit", "update"]);
const GENERATION = /^[0-9a-f]{12}$/;

/** The lock tracker's state -> the desktop state the harness may act on. Only `unlocked` is active; anything else
 * (locked, unknown, a value this build does not know) is never active. */
export function desktopStateFromLock(lockState) {
  if (lockState === "unlocked") return "active";
  if (lockState === "locked") return "locked";
  return "unknown";
}

export const hostDesktopMessage = (state) => ({ type: HOST_DESKTOP, state: HOST_DESKTOP_STATES.includes(state) ? state : "unknown" });
export const hostDesktopReadyMessage = () => ({ type: HOST_DESKTOP_READY });
export const liveMessage = (generation) => ({ type: CUA_GENERATION, live: generation ?? null });
export const withdrawnMessage = (generation, cause) => ({ type: CUA_GENERATION, withdrawn: generation, cause });
export const retiredMessage = (generation) => ({ type: CUA_GENERATION, retired: generation, exitConfirmed: true });
export const stuckMessage = (generation) => ({ type: CUA_STUCK, generation });
export const integrityMessage = (generation) => ({ type: CUA_INTEGRITY, generation });

/** A validated copy of a host message, or null for anything else (unknown type, extra or malformed fields). */
export function parseHostMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const keys = Object.keys(message).sort().join(",");
  switch (message.type) {
    case HOST_DESKTOP:
      return keys === "state,type" && HOST_DESKTOP_STATES.includes(message.state) ? { type: HOST_DESKTOP, state: message.state } : null;
    case HOST_DESKTOP_READY:
      return keys === "type" ? { type: HOST_DESKTOP_READY } : null;
    case CUA_GENERATION:
      if (keys === "live,type" && (message.live === null || GENERATION.test(message.live))) return { type: CUA_GENERATION, live: message.live };
      if (keys === "cause,type,withdrawn" && GENERATION.test(message.withdrawn) && WITHDRAW_CAUSES.includes(message.cause)) {
        return { type: CUA_GENERATION, withdrawn: message.withdrawn, cause: message.cause };
      }
      if (keys === "exitConfirmed,retired,type" && GENERATION.test(message.retired) && message.exitConfirmed === true) {
        return { type: CUA_GENERATION, retired: message.retired, exitConfirmed: true };
      }
      return null;
    case CUA_STUCK:
    case CUA_INTEGRITY:
      return keys === "generation,type" && GENERATION.test(message.generation) ? { type: message.type, generation: message.generation } : null;
    default:
      return null;
  }
}
