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
  { key: "agentsMcp", lost: "it doesn't message or hand work to other bots", gained: "it can message and hand work to other bots" },
  { key: "composioMcp", lost: "connected apps aren't used", gained: "connected apps are used" },
  { key: "computerMcp", lost: "the computer isn't used", gained: "it can use the computer" },
  { key: "browserMcp", lost: "the browser isn't used", gained: "it can use the browser" },
  { key: "customMcp", lost: "your own tool servers aren't used", gained: "your own tool servers are used" },
  { key: "images", lost: "pictures aren't passed to the model", gained: "pictures are passed to the model" },
  { key: "queueing", lost: "new messages wait for the current reply", gained: "it takes new messages while it works" },
];

/** Every flag key a switch notice names. */
export const ENGINE_SWITCH_KEYS: readonly string[] = FACTS.map((fact) => fact.key);

/** What the engine does differently, as at most two calm statements: one for
 * what it does not do, one for what it adds. Empty when nothing changes (for
 * example a new model on the same engine). Unknown engines on either side say
 * nothing rather than guess. */
export function engineSwitchLines(from: EngineSwitchCapabilities | undefined, to: EngineSwitchCapabilities | undefined, engineLabel?: string): string[] {
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
  if (hadEffort && !hasEffort) lost.push("the effort setting isn't offered");
  if (!hadEffort && hasEffort) gained.push("the effort setting is offered");
  const prefix = `On ${engineLabel?.trim() || "this engine"}: `;
  const join = (parts: string[]) => `${prefix}${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.`;
  return [...(lost.length ? [join(lost)] : []), ...(gained.length ? [join(gained)] : [])];
}

/** The calm capability statement for an engine that does not drive the
 * computer. One sentence, shared by the Computer panel, the engine picker and
 * (in spirit) the system layer a turn gets, so the wording never drifts. */
export function engineWithoutComputerText(engineLabel: string | undefined): string {
  return `${engineLabel?.trim() || "This model"} doesn't use the computer. Switch to a model that does, like Claude, to use it here.`;
}

/** The up-front picker line: the bot's computer is Local, VM or Cloud and the
 * engine being picked cannot mount it. Null for every other case. */
export function computerEngineNote(
  computer: string | undefined,
  target: { computerMcp?: boolean; localComputerMcp?: boolean } | undefined,
  targetLabel: string | undefined,
  driverKind?: string,
): string | null {
  if (!target) return null;
  if (computer === "local") return target.localComputerMcp === true || target.computerMcp === true ? null : engineWithoutComputerText(targetLabel);
  if (computer === "vm") return target.computerMcp === true && driverKind !== "boxAgent" ? null : engineWithoutComputerText(targetLabel);
  if (computer === "cloud") return target.computerMcp === true || driverKind === "boxAgent" ? null : engineWithoutComputerText(targetLabel);
  return null;
}
