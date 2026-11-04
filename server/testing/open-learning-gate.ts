// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test only: a learning gate that always admits, for transport tests that are not about the fence. Every learning transport refuses a
// call without a gate (memory/learning-send.ts, designs/MEM-LEARNING-FENCE-R8.md), so these tests hand one in. The real gate's
// transaction protocol is covered by learning-send.test.ts and learning-send-fence.test.ts.
import type { LearningGate, LearningPurpose } from "../memory/learning-send.ts";

export interface OpenLearningGate extends LearningGate { readonly sent: number }

export function openLearningGate(purpose: LearningPurpose = "extraction"): OpenLearningGate {
  let released = 0, written = 0, sent = 0;
  return {
    purpose,
    get released() { return released; },
    get sent() { return sent; },
    refused: false,
    check() { /* always current */ },
    send<R>(emit: () => R): R { released++; sent++; return emit(); },
    admit() { released++; },
    wrote() { written = Math.min(released, written + 1); },
    notWritten() { if (released > written) released--; },
  };
}
