// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture consumer owner: c3-memory. Result release producer owner: sfx-fixture.
import type { LineageRef, TurnLineage } from "../lineage-types.ts";
import { addTurnParents } from "../lineage-write.ts";
import { turnToolText } from "../prompt-parts.ts";

/** Models an already delivered tool result in low-level lineage tests. Merely
 * constructing ToolText no longer consumes it: release owns that commit. The
 * fixture must name its captured turn, never infer the newest turn by thread. */
export function deliveredToolText(turn: TurnLineage, text: string, refs: readonly LineageRef[]) {
  const result = turnToolText(turn, text, refs);
  addTurnParents(turn, result.lineageOf);
  return result;
}
