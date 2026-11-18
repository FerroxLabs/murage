// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dummy witness pair for the DUMMY predicate set: the format example. Replace with the real per-invariant witnesses.

import type { Witness } from "../witness.ts";

export const DUMMY_WITNESSES: Witness[] = [
  { id: "dummy-reject-flux-close", invariant: "dummy.noFluxInitiatedClosing", kind: "must-reject", seed: "fresh",
    moves: [{ t: "flux.close", inboxId: "i1", reason: "billing" }], note: "Flux closes the inbox for billing: the toy invariant forbids it" },
  { id: "dummy-accept-quiet-clock", invariant: "dummy.noFluxInitiatedClosing", kind: "must-accept", seed: "fresh",
    moves: [{ t: "clock.advance", ms: 60_000 }, { t: "auto.tick" }], note: "time passes and the home ticks, no closing: accepted" },
];
