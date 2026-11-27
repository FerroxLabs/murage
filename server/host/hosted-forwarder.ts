// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0/DESIGN-r5.md F1, r5.2 H1 mechanical tie, r5.3 I2): the hosted
// Fuigo forwarder. It is loaded only by a dynamic import() on the HOSTED branch, so a production
// boot never evaluates this module.
//
// Owners: both sides belong to the O1 m2 S1a builder lane (fix/1022-o1m2). The forwarder's turn
// path (r3 D1.1-D1.8: host process, coordinator-owned stdin, custody) lands in a later S1a group;
// until then construction stops fail-closed after the tie, and the boot stays COORDINATOR.
import { markHostedGeneration } from "./hosted-generations.ts";

// r5.3 I2: positive control for the packaged arm. server/index.ts reads this key on every boot and reports
// forwarderInits= on its [fuigo-mode] line: 0 in a production boot, 1 when the HOSTED branch (or a static import) loads it.
const initKey = Symbol.for("murage.hostedForwarder.moduleInits");
const counters = globalThis as unknown as Record<symbol, number | undefined>;
counters[initKey] = (counters[initKey] ?? 0) + 1;

/**
 * The forwarder's turn path (r3 D1.1-D1.4) is not built yet. Until it is, a boot that passes every HOSTED condition still
 * stays COORDINATOR with reason forwarder_incomplete, and the launched host is shut down and its custody reaped.
 */
export const HOSTED_TURN_PATH_READY = false;

export class HostedForwarderUnavailable extends Error {}

/**
 * r5.2 H1: construction throws HOSTED_UNQUALIFIED_BUILD unless the caller passes the override
 * AND this process runs under one of the repo's two test runners. A shipped build sets neither.
 */
export function assertHostedConstructionAllowed(input: { hostedQualifiedOverride?: true }): void {
  const underTestRunner = Boolean(process.env.VITEST) || Boolean(process.env.NODE_TEST_CONTEXT);
  if (input?.hostedQualifiedOverride !== true || !underTestRunner) throw new HostedForwarderUnavailable("HOSTED_UNQUALIFIED_BUILD");
}

export class HostedFuigoForwarder {
  constructor(input: { hostedQualifiedOverride?: true }) {
    assertHostedConstructionAllowed(input);
  }

  /** F2: the generation joins the hosted set at sendTurn entry, before any frame for the handle. */
  beginTurn(dispatchGeneration: string): void {
    markHostedGeneration(dispatchGeneration);
  }
}
