// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderAdapter, ProviderInstance } from "../contracts.ts";

/** Advertise only mount surfaces that can accept this installation's
 * consuming turns. Native chat/tools keep their existing driver fences.
 * Explicit input is never stripped: unsupported mounts still fail in the
 * adapter rather than running with a different tool set. */
export function decorateConsumingMcpInstance(live: ProviderInstance): ProviderInstance {
  const original = live.adapter;
  if (original.capabilities.consumingMcp !== false) return live;
  const capabilities = Object.freeze({ ...original.capabilities,
    agentsMcp: false, memoryMcp: false, computerMcp: false, composioMcp: false,
    phoneMcp: false, browserMcp: false, customMcp: false, localComputerMcp: false,
  });
  const adapter = new Proxy(original, {
    get(target, property) {
      if (property === "capabilities") return capabilities;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
  return new Proxy(live, {
    get(target, property) {
      if (property === "adapter") return adapter;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
