import { z } from "zod";

/**
 * A channel that has been given a purpose.
 *
 * A project HAS a channel; a channel does not have to be a project. This is
 * the whole difference, expressed as one optional block hanging off the
 * channel record: a goal, a status, and the timestamps that belong to them.
 * A channel without this block is just a channel, which is the normal case,
 * and nothing in the app is allowed to behave differently because the block
 * is absent.
 *
 * ── NAMING: five other things in this codebase are already called "project"
 *
 * The word is badly overloaded here, so every symbol in this file is spelled
 * `channelProject*` and never bare `project`. The five it must not be
 * confused with:
 *
 *  1. The memory scope kind "project" (server/memory/schema.ts). Its
 *     `owner_key` is a canonical FILESYSTEM PATH, and the renderer shows it
 *     as "Project folder". It is a folder's memory, keyed by directory, and
 *     has no channel in it at all. A channel's own memory is the "room"
 *     scope, keyed by group id. This block touches neither.
 *  2. The "project" import mode on POST /api/import (server/index.ts), which
 *     scouts a repository and builds a team plus a room for it. That is a
 *     one-time import route. It may well produce a channel that someone
 *     later makes a project, but the two never share a field or a code path.
 *  3. ProjectFolderLeases (server/project-folder-leases.ts): exclusive claims
 *     on a working DIRECTORY so two turns cannot write to it at once.
 *  4. ProjectTurnLeases (server/project-turn-leases.ts): the same idea, one
 *     turn at a time, again keyed by directory.
 *  5. The Composio project key (server/composio.ts) and the GEPA corpus split
 *     axis "project" (server/memory/gepa-evaluator.ts). A vendor account key
 *     and a train/validation grouping label respectively.
 *
 * Three of those five mean "a folder on disk". A channel already carries its
 * folder in `cwd`, which is untouched by this block: making a channel a
 * project does not give it a folder and changing its folder does not make it
 * a project.
 *
 * Nothing existing is renamed. This file only adds.
 */

/** What the work is doing right now.
 *
 * Deliberately three words and no more. "done" is the end of the WORK, not
 * the end of the channel: the channel lives on and can be filed away
 * separately with its own `hidden` flag, which is what "archiving a project
 * leaves the channel able to live on" means in practice. */
export const CHANNEL_PROJECT_STATUSES = ["active", "paused", "done"] as const;
export type ChannelProjectStatus = (typeof CHANNEL_PROJECT_STATUSES)[number];

export const CHANNEL_PROJECT_GOAL_MAX = 2_000;

/** The stored block. Present = this channel is a project. */
export const channelProjectSchema = z
  .object({
    /** What this project is for, in the person's own words. */
    goal: z.string().min(1).max(CHANNEL_PROJECT_GOAL_MAX),
    status: z.enum(CHANNEL_PROJECT_STATUSES),
    /** When the channel became a project. Never moves again. */
    startedAt: z.number().int().nonnegative(),
    /** Last time the goal or the status changed. */
    updatedAt: z.number().int().nonnegative(),
    /** Last time the status moved to "done". Cleared if the work restarts. */
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChannelProject = z.infer<typeof channelProjectSchema>;

/** What a client may send: a goal, a status, or both. The server owns every
 * timestamp, so none of them are accepted here. Sending `null` on a PATCH
 * clears the block and the channel goes back to being a plain channel. */
export const channelProjectInputSchema = z
  .object({
    goal: z.string().min(1).max(CHANNEL_PROJECT_GOAL_MAX).optional(),
    status: z.enum(CHANNEL_PROJECT_STATUSES).optional(),
  })
  .strict();

export type ChannelProjectInput = z.infer<typeof channelProjectInputSchema>;

/** Shown wherever a status needs a word a person reads. Kept next to the
 * codes so a new status cannot ship without one. */
export const CHANNEL_PROJECT_STATUS_LABELS: Record<ChannelProjectStatus, string> = {
  active: "In progress",
  paused: "On hold",
  done: "Finished",
};
