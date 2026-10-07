// What registerPush does for the workspace on screen (Decision 1).
export type Plan = "denied" | "reuse" | "replace" | "create";
export function decide(permission: string, binding: string | null, hasDetail: boolean, fresh: boolean): Plan {
  if (permission !== "granted") return "denied";
  if (binding && hasDetail && !fresh) return "reuse";
  return binding ? "replace" : "create";
}
