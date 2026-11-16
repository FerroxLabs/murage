// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive driver fixtures model the server's admission before recording wire
// events. Refusal tests keep recordEvents and the unmodified product adapter.
import type { ProviderAdapter } from "../contracts.ts";
import { bindFixtureAdapter } from "./mcp-admission-fixture.ts";
import { recordEvents } from "./events.ts";
export type { EventRecorder } from "./events.ts";

export function recordAdmittedEvents(adapter: ProviderAdapter) {
  bindFixtureAdapter(adapter);
  return recordEvents(adapter);
}

/** These native adapters also support explicit legacy non-consuming turns. */
export function recordMountedFixtureEvents(adapter: ProviderAdapter) {
  bindFixtureAdapter(adapter, { mountsOnly: true });
  return recordEvents(adapter);
}
