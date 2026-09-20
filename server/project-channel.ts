import {
  CHANNEL_PROJECT_GOAL_MAX,
  CHANNEL_PROJECT_STATUSES,
  channelProjectInputSchema,
  type ChannelProject,
  type ChannelProjectStatus,
} from "../shared/project.ts";

/**
 * The rules for the project block on a channel, in one place so the create
 * route and the patch route cannot drift apart.
 *
 * Every symbol here is `channelProject*`, never bare `project`: see the long
 * note at the top of shared/project.ts for the five other things this
 * codebase already calls a project, three of which mean "a folder on disk".
 * Nothing in this file touches a folder, a lease or a memory scope.
 */

export type ChannelProjectOutcome =
  | { ok: true; project: ChannelProject | undefined }
  | { ok: false; error: string };

const STATUS_LIST = CHANNEL_PROJECT_STATUSES.join(", ");

/** Work out what the block should become, given what is there now and what
 * was asked for. The caller owns persistence; this owns the invariants.
 *
 * `null` clears the block: the channel keeps its chat, its members, its
 * instructions and its folder, and simply stops being a project.
 *
 * Timestamps are never accepted from a client. `startedAt` is stamped once,
 * when the channel first becomes a project, and never moves again, so the
 * record still says when the work began after the goal has been reworded ten
 * times. `updatedAt` moves on any real change. `completedAt` is stamped when
 * the status reaches "done" and cleared again if the work restarts, because
 * a finished-on date that survives a reopening is a lie.
 */
export function nextChannelProject(
  current: ChannelProject | undefined,
  requested: unknown,
  now: number,
): ChannelProjectOutcome {
  if (requested === null) return { ok: true, project: undefined };
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
    return { ok: false, error: "project must be an object, or null to make this a plain channel" };
  }
  const parsed = channelProjectInputSchema.safeParse(requested);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "status") {
      return { ok: false, error: `project status must be one of: ${STATUS_LIST}` };
    }
    if (issue?.path[0] === "goal") {
      return {
        ok: false,
        error: `project goal must be text of at most ${CHANNEL_PROJECT_GOAL_MAX} characters`,
      };
    }
    return { ok: false, error: "project accepts only a goal and a status" };
  }
  const { goal: rawGoal, status: rawStatus } = parsed.data;
  const goal = rawGoal?.trim() ?? current?.goal;
  if (!goal) {
    // A project is a channel with a purpose. Without the purpose there is
    // nothing to store and nothing for the bots to read, so refuse rather
    // than quietly writing an empty goal onto the record.
    return { ok: false, error: "give this project a goal so everyone knows what the work is" };
  }
  if (goal.length > CHANNEL_PROJECT_GOAL_MAX) {
    return {
      ok: false,
      error: `project goal must be text of at most ${CHANNEL_PROJECT_GOAL_MAX} characters`,
    };
  }
  const status: ChannelProjectStatus = rawStatus ?? current?.status ?? "active";
  if (current && current.goal === goal && current.status === status) return { ok: true, project: current };
  const project: ChannelProject = {
    goal,
    status,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
  };
  if (status === "done") project.completedAt = current?.status === "done" ? current.completedAt ?? now : now;
  return { ok: true, project };
}

/** True when this channel has a purpose. */
export const isChannelProject = (group: { channelProject?: ChannelProject }): boolean =>
  Boolean(group.channelProject);

/** In-prompt words for a status. "active" says nothing: the common case
 * should not spend context explaining itself. */
const PROMPT_STATUS: Record<ChannelProjectStatus, string> = {
  active: "",
  paused: ", on hold",
  done: ", finished",
};

/** The one line a member's turn gets when its room is a project, so the bots
 * actually know what the work is.
 *
 * ONE line, deliberately. The context budget is real and the room already
 * spends it on the roster, the instructions and the transcript. Newlines in
 * the goal are collapsed so a pasted paragraph cannot turn this into a
 * second set of instructions competing with the room's own.
 */
export function channelProjectSystemLine(project: ChannelProject | undefined): string | null {
  const goal = project?.goal.replace(/\s+/g, " ").trim();
  if (!project || !goal) return null;
  return `Project goal (what this room is working towards${PROMPT_STATUS[project.status]}): ${goal}`;
}
