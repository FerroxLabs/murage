// A project never invents a sidebar section. Its Team choice is picked from
// the teams that already exist, and "none" (the default) leaves it unsectioned
// so it shows under Projects. Free text here once created a stray section.
import type { Bot, Group } from "@/state/store";

/** Every existing team name, bots and rooms together, in first-seen order.
 * Hidden bots can carry a stale assignment, so they are not offered. */
export function existingTeams(
  bots: ReadonlyArray<Pick<Bot, "section" | "hidden">>,
  groups: ReadonlyArray<Pick<Group, "section">>,
): string[] {
  return [
    ...new Set([
      ...bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];
}

/** The section a new project is filed under: the chosen team only when it is
 * one that already exists, otherwise none (undefined, so no `section` is sent). */
export function projectSection(choice: string, teams: readonly string[]): string | undefined {
  return choice && teams.includes(choice) ? choice : undefined;
}
