// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The merged witness list used by the runner, the tests and the gates: the base spec witnesses (spec.ts) followed by the 8 clause-mutant
// group files (witnesses-cm-g1..g8.ts). A group adds witnesses only to its own file; nothing here needs a hand edit per group.

import { WITNESSES as BASE, type Witness } from "./spec.ts";
import { WITNESSES_G1, PIN as PIN_G1 } from "./witnesses-cm-g1.ts";
import { WITNESSES_G2, PIN as PIN_G2 } from "./witnesses-cm-g2.ts";
import { WITNESSES_G3, PIN as PIN_G3 } from "./witnesses-cm-g3.ts";
import { WITNESSES_G4, PIN as PIN_G4 } from "./witnesses-cm-g4.ts";
import { WITNESSES_G5, PIN as PIN_G5 } from "./witnesses-cm-g5.ts";
import { WITNESSES_G6, PIN as PIN_G6 } from "./witnesses-cm-g6.ts";
import { WITNESSES_G7, PIN as PIN_G7 } from "./witnesses-cm-g7.ts";
import { WITNESSES_G8, PIN as PIN_G8 } from "./witnesses-cm-g8.ts";
import { WITNESSES_S23, PIN as PIN_S23 } from "./witnesses-r34d-s23.ts";

/** Count of the base spec witnesses (before any clause-mutant group witness). Fixed: a group never changes it. */
export const BASE_PIN = 332;
export const CM_GROUP_FILES: Record<string, { witnesses: readonly Witness[]; pin: number }> = {
  g1: { witnesses: WITNESSES_G1, pin: PIN_G1 },
  g2: { witnesses: WITNESSES_G2, pin: PIN_G2 },
  g3: { witnesses: WITNESSES_G3, pin: PIN_G3 },
  g4: { witnesses: WITNESSES_G4, pin: PIN_G4 },
  g5: { witnesses: WITNESSES_G5, pin: PIN_G5 },
  g6: { witnesses: WITNESSES_G6, pin: PIN_G6 },
  g7: { witnesses: WITNESSES_G7, pin: PIN_G7 },
  g8: { witnesses: WITNESSES_G8, pin: PIN_G8 },
  s23: { witnesses: WITNESSES_S23, pin: PIN_S23 },
};
export const BASE_WITNESSES: readonly Witness[] = BASE;
export const WITNESSES: readonly Witness[] = [...BASE, ...WITNESSES_G1, ...WITNESSES_G2, ...WITNESSES_G3, ...WITNESSES_G4, ...WITNESSES_G5, ...WITNESSES_G6, ...WITNESSES_G7, ...WITNESSES_G8, ...WITNESSES_S23];
