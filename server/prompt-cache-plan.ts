// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface PromptLayerClass {
  stability: "constant" | "configuration" | "turn";
  privacy: "product" | "principal";
}
const CONFIGURATION = new Set(["house-rules", "about-me", "persona", "team-brief", "memory"]);
export function classifyPromptLayer(id: string, where: "direct" | "room" = "direct"): PromptLayerClass {
  if (id === "reply-habits") return { stability: "constant", privacy: "product" };
  return { stability: CONFIGURATION.has(id) && !(where === "room" && id === "persona") ? "configuration" : "turn", privacy: "principal" };
}

/** Input is already authorized for this turn. Keep only this invocation's partition; never retain private text or an access verdict. */
export function compilePromptLayers<T extends { id: string; text: string }>(layers: readonly T[], where: "direct" | "room" = "direct"): { prefix: T[]; suffix: T[]; layers: T[] } {
  const prefix: T[] = [], suffix: T[] = [];
  for (const layer of layers) {
    const classification = classifyPromptLayer(layer.id, where);
    (classification.stability === "turn" ? suffix : prefix).push({ ...layer, ...classification });
  }
  return { prefix, suffix, layers: [...prefix, ...suffix] };
}
