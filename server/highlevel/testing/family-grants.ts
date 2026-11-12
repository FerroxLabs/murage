// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { HIGHLEVEL_FAMILIES, type Family, type FamilyLevel } from '../../../shared/highlevel.ts';
/** Explicit V2 fixture authority: every unrequested family is off. */
export function fixtureFamilyLevels(levels: Partial<Record<Family, FamilyLevel>>): Record<Family, FamilyLevel> {
  return Object.fromEntries(HIGHLEVEL_FAMILIES.map(family => [family, levels[family] ?? 'off'])) as Record<Family, FamilyLevel>;
}
