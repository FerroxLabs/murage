// An agent's to-do list for the turn it is running, as ACP reports it in a
// `plan` session update (agent-client-protocol-schema 0.11, `Plan` and
// `PlanEntry`). Each update carries the WHOLE list with every entry's current
// status; a client replaces its copy rather than merging.
//
// Wire shape: { sessionUpdate: "plan", entries: [{ content, priority, status,
// _meta? }] }, where status is "pending" | "in_progress" | "completed" and the
// enum is non-exhaustive. Priority is not shown, so it is not carried.

export type AgentPlanStatus = "pending" | "in_progress" | "completed";

export interface AgentPlanEntry {
  content: string;
  status: AgentPlanStatus;
}

/** Bounds for engine-controlled text that is broadcast to every window. */
export const AGENT_PLAN_MAX_ENTRIES = 50;
export const AGENT_PLAN_MAX_CHARS = 500;

const STATUSES: ReadonlySet<string> = new Set<AgentPlanStatus>(["pending", "in_progress", "completed"]);

/** The plan's entries, or null when `entries` is not a list at all (a
 * malformed update is ignored, never read as "the plan is now empty"). An
 * entry without text is dropped; a status this client does not know reads as
 * pending, the same fallback the Fuigo engine uses for the non-exhaustive
 * enum. */
export function normalizeAgentPlan(entries: unknown): AgentPlanEntry[] | null {
  if (!Array.isArray(entries)) return null;
  const plan: AgentPlanEntry[] = [];
  for (const entry of entries) {
    if (plan.length >= AGENT_PLAN_MAX_ENTRIES) break;
    if (!entry || typeof entry !== "object") continue;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string") continue;
    const text = content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    plan.push({
      content: text.length > AGENT_PLAN_MAX_CHARS ? `${text.slice(0, AGENT_PLAN_MAX_CHARS - 1).trimEnd()}…` : text,
      status: typeof status === "string" && STATUSES.has(status) ? (status as AgentPlanStatus) : "pending",
    });
  }
  return plan;
}
