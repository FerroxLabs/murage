// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an engine could do on the turn it ran, kept as a small profile and a
// hash of it. Every bot row a provider turn writes carries the hash and the
// engine, model and route (Message.engine), so a later swap, replay or filter
// can say which engine wrote which line and under what limits. The profile is
// read from the engine's own declared capabilities and model catalog, the
// same facts the model picker's switch notice reads (shared/engine-switch.ts).

import { createHash } from "node:crypto";
import type { ProviderInstance } from "./contracts.ts";
import { ENGINE_TOOL_KEYS, type MessageEngine } from "../shared/engine-switch.ts";

export type EngineToolKey = (typeof ENGINE_TOOL_KEYS)[number];

export interface EngineProfile {
  driverKind: string;
  tools: Record<EngineToolKey, boolean>;
  contextWindow: number | null;
  modalities: { images: boolean; imagesInline: boolean };
  queueing: boolean;
  effortLevels: string[];
}

type ProfileInstance = Pick<ProviderInstance, "driverKind" | "adapter" | "models">;

/** The profile of one instance running one model. */
export function engineProfile(instance: ProfileInstance, model?: string | null): EngineProfile {
  const caps = instance.adapter.capabilities as Record<string, unknown>;
  const tools = {} as Record<EngineToolKey, boolean>;
  for (const key of ENGINE_TOOL_KEYS) tools[key] = caps[key] === true;
  const wanted = model ?? instance.models.default;
  const window = instance.models.options.find((option) => option.id === wanted)?.contextWindow;
  return {
    driverKind: instance.driverKind,
    tools,
    contextWindow: typeof window === "number" && window > 0 ? window : null,
    modalities: { images: caps.images === true, imagesInline: caps.imagesInline === true },
    queueing: caps.queueing === true,
    effortLevels: [...((caps.effortLevels as readonly string[] | undefined) ?? [])],
  };
}

/** JSON with every object's keys sorted, so equal profiles hash equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function capabilityHash(profile: EngineProfile): string {
  return createHash("sha256").update(stableJson(profile)).digest("hex");
}

/** The tool flags that let an engine act on a tool-needing item (a teammate
 * message, a delegation result, an approval card). memoryMcp is left out: it
 * only reads and writes the bot's memory, so it cannot answer any of those.
 * runsOnOwnTools stays in: such an engine acts on its own tools. */
export const ACTING_TOOL_KEYS: readonly EngineToolKey[] = ENGINE_TOOL_KEYS.filter((key) => key !== "memoryMcp");

/** True when the route can act: it mounts a Murage tool that can carry a
 * tool-needing item, or it runs on its own tools. A route with none is text
 * only: it can read and answer, and cannot message, delegate or act. */
export function routeHasTools(profile: EngineProfile): boolean {
  return ACTING_TOOL_KEYS.some((key) => profile.tools[key]);
}

/** The same question for declared capability flags. Unknown capabilities
 * count as "has tools", so nothing is ever held on a guess. */
export function capabilitiesHaveTools(capabilities: object | undefined): boolean {
  if (!capabilities) return true;
  const flags = capabilities as Record<string, unknown>;
  return ACTING_TOOL_KEYS.some((key) => flags[key] === true);
}

/** The same question for a live instance, for callers that hold no profile. */
export function instanceRouteHasTools(instance: ProfileInstance, model?: string | null): boolean {
  return routeHasTools(engineProfile(instance, model));
}

/** The stamp a bot row from this turn carries. */
export function engineStamp(instance: ProfileInstance & { instanceId: string }, model: string | null | undefined, connectionId?: string): MessageEngine {
  const resolved = model || instance.models.default || "";
  return {
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    model: resolved,
    ...(connectionId ? { connectionId } : {}),
    capabilityHash: capabilityHash(engineProfile(instance, resolved)),
  };
}
