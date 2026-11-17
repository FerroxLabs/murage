// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive steering controls own a real retained turn. Explicit contexts,
// including revoked ones, still reach the production fence unchanged.
import { steerWithQuoteLineage as steer } from "../steer-lineage.ts";
import { fixtureEngineFence } from "./mcp-admission-fixture.ts";

export const steerWithQuoteLineage: typeof steer = (adapter, threadId, text, allowed, options) =>
  steer(adapter, threadId, text, allowed, { ...options,
    turn: options.turn === undefined ? fixtureEngineFence(threadId).retained : options.turn });
