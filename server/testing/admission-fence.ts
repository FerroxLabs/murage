// Owners: this harness side is bld1022-o1m2-extract's; the production fence (server/index.ts admittedInstance,
// D1.6 stale_executor) is the O1 m2 S1a lane's (fix/1022-o1m2). Tests that compile a turn site out of index.ts
// (turnRouting, runGroupMemberTurnDispatch) bind the REAL fence here, never a stub of it.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { FuigoAgentDriver } from "../drivers/acp/fuigo.ts";

const INDEX_SOURCE = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** The production admittedInstance, compiled over the case's own registry. custodyUnresolved defaults to the boot value
 *  every production build has (no custody file, F1/F3), so the fence is the plain lookup unless a case closes it. */
export function productionAdmittedInstance<R extends { get(instanceId: string): unknown }>(registry: R, custodyUnresolved = 0): (instanceId: string) => ReturnType<R["get"]> {
  const start = INDEX_SOURCE.indexOf("\nfunction admittedInstance(");
  const end = INDEX_SOURCE.indexOf("\n}\n", start) + 3;
  if (start < 0 || end <= start) throw new Error("Production admission fence moved");
  return runInNewContext(`${stripTypeScriptTypes(INDEX_SOURCE.slice(start, end))}\nadmittedInstance;`,
    { registry, FuigoAgentDriver, fuigoCustodyUnresolved: custodyUnresolved });
}
