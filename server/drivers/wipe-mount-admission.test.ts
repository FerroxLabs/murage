// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { customIntegrations, customMountEntries } from "../custom-mcp-mounts.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { AppConfig } from "../config.ts";

// Owners: p1-owner-stall owns wrapper admission; gnl-harness owns its consumer.
it("admits the real owner stdio wrapper and still refuses a replaced generation", () => {
  const f = consumingFixture();
  const caps = new InternalCapabilities();
  caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  try {
    const cfg = { mcpServers: { fixture: { command: "fixture-peer", args: [], env: {}, enabled: true } } } as unknown as AppConfig;
    const entries = customMountEntries(customIntegrations(cfg, { execPath: process.execPath,
      proxyPath: SPAWNED_PROXIES.remoteMcp, wipeProxyPath: SPAWNED_PROXIES.wipeMcp,
      harnessUrl: "http://127.0.0.1:1", token: () => "fixture-capability" }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.args[0]).toBe(SPAWNED_PROXIES.wipeMcp);
    const mounted = admission.mount({ ...entries[0]! });
    expect(mounted.env).toMatchObject({ MURAGE_RELEASE_INSTANCE: expect.any(String) });
    expect(f.refusals).toBe(0);
    f.replace();
    expect(() => admission.mount({ ...entries[0]! })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(f.refusals).toBe(1);
  } finally { admission.dispose(); f.close(); }
});
