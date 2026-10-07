// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a bot gains or loses when its engine changes (0.1.61 triage row 22,
// adapted from OpenMausBot c659861a #1855 without propose_model). A switch
// used to change only the label the owner saw, while the new engine quietly
// could not mount the team tools, connected apps or the computer. The facts
// are the engines' own capability flags (ProviderAdapter.capabilities, the
// same ones GET /api/instances reports), so the lines never drift from what
// a turn is actually given.

export interface EngineSwitchCapabilities {
  agentsMcp?: boolean;
  composioMcp?: boolean;
  computerMcp?: boolean;
  browserMcp?: boolean;
  customMcp?: boolean;
  images?: boolean;
  queueing?: boolean;
  effortLevels?: readonly string[];
}

/** Which engine, model and route wrote a message row, and the hash of the
 * capability profile the turn ran under (server/engine-profile.ts). Written by
 * the server on every bot row a provider turn produces; absent on rows from
 * before the field existed, which readers treat as unlabelled. */
export interface MessageEngine {
  /** the provider instance that ran the turn */
  instanceId: string;
  /** ProviderAdapter.provider of that instance */
  driverKind: string;
  /** the resolved model the turn ran on */
  model: string;
  /** the provider connection, when the turn was routed through one */
  connectionId?: string;
  /** sha256 over the sorted-key engine profile of this turn */
  capabilityHash: string;
}

/** The capability flags the engine profile and its hash cover as tools. The
 * switch notice below names the same flags (plus images and queueing, which
 * the profile keeps under modalities and queueing); a test asserts the two
 * lists agree so the notice and the hash never drift. */
export const ENGINE_TOOL_KEYS = [
  "agentsMcp",
  "computerMcp",
  "composioMcp",
  "browserMcp",
  "customMcp",
  "phoneMcp",
  "memoryMcp",
  "runsOnOwnTools",
] as const;

const FACTS: ReadonlyArray<{ key: keyof EngineSwitchCapabilities; lost: string; gained: string }> = [
  { key: "agentsMcp", lost: "Loses the team tools (messaging, asking and handing work to other bots) on this engine.", gained: "Gains the team tools (messaging, asking and handing work to other bots) on this engine." },
  { key: "composioMcp", lost: "Loses connected apps on this engine.", gained: "Gains connected apps on this engine." },
  { key: "computerMcp", lost: "Loses its computer on this engine.", gained: "Gains its computer on this engine." },
  { key: "browserMcp", lost: "Loses the browser on this engine.", gained: "Gains the browser on this engine." },
  { key: "customMcp", lost: "Loses your own tool servers on this engine.", gained: "Gains your own tool servers on this engine." },
  { key: "images", lost: "Loses reading pictures on this engine.", gained: "Gains reading pictures on this engine." },
  { key: "queueing", lost: "Messages you send while it works wait until it finishes, on this engine.", gained: "Takes messages while it works, on this engine." },
];

/** Every flag key a switch notice names. */
export const ENGINE_SWITCH_KEYS: readonly string[] = FACTS.map((fact) => fact.key);

/** One plain line per capability the switch loses, then one per capability
 * it gains. Empty when nothing changes (for example a new model on the same
 * engine). Unknown engines on either side say nothing rather than guess. */
export function engineSwitchLines(from: EngineSwitchCapabilities | undefined, to: EngineSwitchCapabilities | undefined): string[] {
  if (!from || !to) return [];
  const lost: string[] = [];
  const gained: string[] = [];
  for (const fact of FACTS) {
    const before = from[fact.key] === true;
    const after = to[fact.key] === true;
    if (before && !after) lost.push(fact.lost);
    if (!before && after) gained.push(fact.gained);
  }
  const hadEffort = (from.effortLevels?.length ?? 0) > 0;
  const hasEffort = (to.effortLevels?.length ?? 0) > 0;
  if (hadEffort && !hasEffort) lost.push("Loses the effort setting on this engine.");
  if (!hadEffort && hasEffort) gained.push("Gains the effort setting on this engine.");
  return [...lost, ...gained];
}
