// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-LOCKED-1019.md 4.2: the credit reading for a Fuigo or Flux row, taken from GET /api/engine-health (the cached
// Flux /key/info answer). Out is the allowance used up, low is spend at Health's own watch line, and no key or a refused
// key are their own readings. With no answer at all there is no reading, which routeState says plainly, never as $0.
import { FLUX_WATCH_PCT } from "@/components/health/health-findings";
import type { EngineHealthAnswer } from "@/components/shell/shell-contract";
import type { RouteCredit } from "./route-state";

/** `asOf` is the answer's own checkedAt (the moment the server read it); the fetch time only when the answer has none. */
export function creditFromHealth(answer: EngineHealthAnswer | null | undefined, now: number = Date.now()): RouteCredit | null {
  if (!answer) return null;
  const asOf = Number.isFinite(answer.checkedAt) ? answer.checkedAt : now;
  switch (answer.flux) {
    // The health answer says the allowance is used up (spent past its budget, or the key is blocked), never whether it was an
    // included or a paid one, so the words stay neutral.
    case "allowance-used-up": return { state: "out", asOf };
    case "none": return { state: "noKey", asOf };
    case "key-problem": return { state: "keyProblem", asOf };
    case "ok": {
      // The server answers ok with no figures when the Flux check was slow, failed or never ran (fluxHealthFrom): that is
      // no reading, never a confirmed Ready.
      if (!answer.fluxInfo) return null;
      const pct = answer.fluxInfo.spendPct;
      return { state: typeof pct === "number" && pct >= FLUX_WATCH_PCT ? "low" : "ok", asOf };
    }
    default: return null;
  }
}
