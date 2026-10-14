// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { pickerModels, type PickerEngine, type PickerModel } from "./provider-model-picker";

type HintEngine = PickerEngine & { capabilities?: { images?: boolean } };

const family = (row: PickerModel) => {
  const id = (row.selection.model.split("/").at(-1) ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return { id, label: row.label.toLowerCase().replace(/[^a-z0-9]/g, "") };
};

/** When the engine shown does not pass pictures, one grey line naming another
 * installed, ready engine whose LIVE catalog has the same model with vision
 * and which does pass pictures. Computed from the catalogs it is given, never
 * from a fixed list. Null when there is no such engine. */
export function picturesElsewhereHint(
  shown: HintEngine | undefined,
  instances: readonly HintEngine[],
  connections: readonly PublicProviderConnection[],
  preferredModel?: string,
): string | null {
  if (!shown || shown.capabilities?.images !== false) return null;
  const seeing = pickerModels(shown, connections).filter((row) => row.capabilities?.vision);
  const ordered = [...seeing.filter((row) => row.selection.model === preferredModel), ...seeing.filter((row) => row.selection.model !== preferredModel)];
  const others = instances.filter((other) =>
    other.instanceId !== shown.instanceId && other.enabled !== false && other.snapshot.state === "available" &&
    other.snapshot.authenticated !== false && other.capabilities?.images === true);
  for (const row of ordered) {
    const want = family(row);
    for (const other of others) {
      const match = pickerModels(other, connections).find((candidate) => {
        // only a known "sees pictures" counts; unknown or false shows nothing
        if (candidate.capabilities?.vision !== true) return false;
        const got = family(candidate);
        return got.id === want.id || (want.label !== "" && got.label === want.label);
      });
      if (match) return `${other.displayName} runs ${row.label} with pictures.`;
    }
  }
  return null;
}
