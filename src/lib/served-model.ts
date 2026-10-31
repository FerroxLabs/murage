// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The quiet line under a reply Flux Router answered with a model other than the one picked (server Message.servedModel, read from
// x-flux-routed-model / x-flux-original-model). It says what happened in plain words; it is not an error.
import { bareModelId, resolveModelLabel } from "../../shared/model-label.ts";

export interface ServedModel { routed: string; requested: string }

const same = (a: string, b: string): boolean => bareModelId(a.trim()).toLowerCase() === bareModelId(b.trim()).toLowerCase();

/** Whether the model that answered is not the one that was asked for. */
export function servedModelDiffers(served: ServedModel | null | undefined): boolean {
  return Boolean(served?.routed && served.requested && !same(served.routed, served.requested));
}

/** "Answered by DeepSeek V4 (you picked Flux Auto)", or null when the two models match or are unknown. */
export function servedModelLine(served: ServedModel | null | undefined): string | null {
  if (!served || !servedModelDiffers(served)) return null;
  let routed = resolveModelLabel(served.routed);
  let requested = resolveModelLabel(served.requested);
  // two ids that differ only where the display name hides it (a date, a provider prefix): name them by id
  if (routed === requested) { routed = bareModelId(served.routed); requested = bareModelId(served.requested); }
  return `Answered by ${routed} (you picked ${requested})`;
}
