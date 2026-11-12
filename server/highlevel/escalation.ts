import type { Risk } from "../../shared/highlevel.ts";
import type { OperationSpec } from "./operations/registry.ts";
import { HighLevelEscalation } from "./escalation-state.ts";
export type Escalation = "none" | "send_count" | "targets" | "identical_loop";
const reservations = new HighLevelEscalation();
export function reserveEffectiveRisk(turnKey: string, spec: OperationSpec, args: Record<string, unknown>): { risk: Risk; escalation: Escalation } {
  return reservations.reserve(turnKey, spec, args);
}
