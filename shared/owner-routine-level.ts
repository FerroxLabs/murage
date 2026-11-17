// SPDX-License-Identifier: AGPL-3.0-or-later
// Public shared calculation contract; S1 implements, S2 consumes for the chip.
// Keep this module browser-safe: no runtime server imports.
import type { OwnerRoutineLevelFn } from '../server/decision/types.ts';
export const ownerRoutineLevel: OwnerRoutineLevelFn = (_botLevel, baseLevel, draftOnly) => draftOnly ? 'ask' : baseLevel;
