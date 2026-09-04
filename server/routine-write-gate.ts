import type { Surface } from "./sse-visibility.ts";

/** May this routine-confirmation card be APPLIED from this surface?
 *
 * Pure, and in its own file, so the policy can be tested without booting a
 * server — `index.ts` starts listening on import, so the rule cannot be
 * exercised from inside it. Same shape the desktop viewer's permission policy
 * uses for the same reason.
 *
 * WHY THIS EXISTS. `POST /api/routines` and `PATCH|DELETE /api/routines/:id`
 * are desktop-only, because a routine decides what gets spawned and when.
 * Confirming a routine card reaches the same writes — `resolve()` with
 * behavior "allow" calls routines.create/update/remove, and
 * `inputFromDefinition` sets `enabled: true`, so the schedule is LIVE. That
 * makes the card path a second door into the same room, and a gate with a
 * second door is decoration.
 *
 * `/api/teams/import` writes `enabled: false`, which is why auditing that
 * route proved nothing about this one — the barrier it relies on is absent
 * here.
 *
 * DENY IS ALWAYS ALLOWED. Refusing writes no schedule, and a person holding a
 * phone should always be able to say no to something their bot proposed.
 * Only "allow" is a write.
 *
 * @param isRoutineCard whether this request id actually resolves to a routine
 *   request card. Non-routine cards (skills, approvals, connectors) are not
 *   this gate's business and must fall through untouched.
 */
export function routineCardApplyAllowed(
  isRoutineCard: boolean,
  behavior: string,
  surface: Surface,
): boolean {
  if (!isRoutineCard) return true;
  if (behavior !== "allow") return true;
  return surface === "desktop";
}
