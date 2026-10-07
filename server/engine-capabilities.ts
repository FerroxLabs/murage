// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the engine answering a thread can do for the hold queue and the reply
// check. The tool question has one source, server/engine-profile.ts; this file
// adapts it to declared capability flags and keeps the driver event list.

import { capabilitiesHaveTools } from "./engine-profile.ts";

export type RouteCapabilityFlags = object;

/** True when the route can act on tool-needing items (memoryMcp alone does not
 * count; an engine that runs its own tools does). Unknown capabilities count
 * as "has tools". Defined once in engine-profile.ts. */
export function routeHasTools(capabilities: RouteCapabilityFlags | undefined): boolean {
  return capabilitiesHaveTools(capabilities);
}

/** Drivers that have tools but give Murage no tool event stream for a turn.
 * None today: Claude (stream-json tool_use), Codex (exec events), Pi, ACP
 * engines including the own-tools ones (tool_call / tool_call_update),
 * Antigravity and the cloud computer runner all emit `item.started` tool
 * events that become the turn's activity rows. A tool-less driver (the
 * OpenAI-shaped runtime) has no tools to report, so a claim there is flagged,
 * not unverifiable. */
export const DRIVERS_WITHOUT_TOOL_EVENTS: ReadonlySet<string> = new Set<string>();

/** True when a claim cannot be compared with any record on this route: it has
 * tools, but its driver reports no tool events. */
export function recordUnverifiable(driverKind: string | undefined, capabilities: RouteCapabilityFlags | undefined): boolean {
  return driverKind !== undefined && DRIVERS_WITHOUT_TOOL_EVENTS.has(driverKind) && routeHasTools(capabilities);
}
