// Flux #276 profile: the reaper may stop, so an expired old key still answers 200 at expires_at + 30 min; the legacy profile answers 401.
import { expect, it } from "vitest";
import { addKey, fluxAdvance, fluxUse, emptyFlux } from "./flux.ts";

const mk = (stopped: boolean) => {
  let f = { ...emptyFlux(0), ...(stopped ? { reaperStopped: true } : {}) };
  f = addKey(f, "b1:k1", "b1", "h1", { deadlineAt: 86_400_000 });
  return fluxAdvance(f, 86_400_000 + 30 * 60_000);
};
it("flux276: the old key answers 200 at expires_at + 30 min", () => { expect(fluxUse(mk(true), "b1:k1").resp).toBe(200); });
it("legacy: the old key answers 401 after expires_at", () => { expect(fluxUse(mk(false), "b1:k1").resp).toBe(401); });
