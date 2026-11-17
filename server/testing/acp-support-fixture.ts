// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createAcpDriver, type AcpSupport } from "../drivers/acp/core.ts";
import { admittedFixtureInstance } from "./mcp-admission-fixture.ts";

/** Inert stdio peers implement ACP without making model requests. Declare
 * their destination explicitly so unknown production destinations stay closed.
 * A scenario can still override the reach to exercise the real Flux gate. */
export function createFixtureAcpDriver(support: AcpSupport) {
  const driver = createAcpDriver({ fluxReach: () => "elsewhere", ...support });
  return { ...driver, create: (...args: Parameters<typeof driver.create>) => admittedFixtureInstance(driver.create(...args)) };
}
