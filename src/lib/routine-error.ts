// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine run stores its failure text. 1.0.19 stored the raw code of Murage's own delete check (wipe-guard-invalid-turn); 1.0.20 stores
// the plain line (server/drivers/murage-exec-wipe.ts GUARD_START_FAILED_LINE, server/index.ts murageInternalCode). A run stored before the
// update reads the same plain line. Only the delete check's own codes are mapped: an engine's or provider's code keeps its own text.
import { murageStartFailureLine } from "../../shared/murage-start-failure";
const DELETE_CHECK_CODE = /^(?:wipe-guard-[a-z0-9]+(?:-[a-z0-9]+)*|wipe-root-inventory-unavailable)$/;

export function routineErrorText(error: string | undefined): string | undefined {
  return error !== undefined && DELETE_CHECK_CODE.test(error.trim()) ? murageStartFailureLine(error.trim()) : error;
}
