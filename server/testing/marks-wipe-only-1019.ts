// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect } from "vitest";
import { cell as legacyCell, provenInitiator, type CellSpec } from "./marks-nlh0.ts";

/** These matrices supply stored owner provenance at the policy boundary.
 * MAIN RULING 2026-11-13 wipe-only: non-wipes run on admitted No limits
 * turns; unproven/other-person turns use Ask. Lower levels retain their pins.
 * The caller supplies the independently evaluated Ask twin, never a verdict-
 * selected exemption. Wipe expectations remain literal fixture data. */
// MAIN RULING 2026-11-13 wipe-only: only declared wipe cells retain their card.
export function wipeOnlyCell(
  id: string, bot: { noLimits?: boolean }, patch: Record<string, unknown>,
  verdict: unknown, ask: unknown, spec: CellSpec,
): void {
  if (!bot.noLimits) { legacyCell(id, bot, patch, verdict, spec); return; }
  if (!provenInitiator(patch)) {
    expect(verdict, `${id}: an unproven turn stays Ask`).toEqual(ask);
    expect((verdict as { approve: unknown }).approve).toBeNull();
    return;
  }
  if (spec.n2) {
    expect(spec.owner, `${id}: a wipe states its exact refusal`).toBeDefined();
    expect(verdict, id).toMatchObject(spec.owner!);
    expect("namedCatastrophe" in (verdict as object)).toBe(false);
    return;
  }
  expect(verdict, `${id}: an admitted non-wipe runs`).toMatchObject({ source: "no-limits", approve: expect.any(String) });
  expect((verdict as { approve: string }).approve).not.toBe("");
  for (const field of ["classification", "reason", "namedCatastrophe"])
    expect(field in (verdict as object), `${id}: a run carries no ${field}`).toBe(false);
}
