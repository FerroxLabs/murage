// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One owner-audience predicate (0.1.61 plan, contract 4.1).
//
// Some of what a bot is shown is the owner's own material: what they wrote
// in About me, the bot's MEMORY.md notebook, the team brief. It rides only on
// a turn whose human audience is the workspace owner. A conversation that
// belongs to a linked channel person (Slack, Discord, Telegram), and a turn a
// bot runs on that person's behalf, gets none of it.
//
// Until 0.1.61 each call site asked `isWorkspaceOwner(threadHumanPrincipal(
// threadId))` for itself. This module is the one place that question is
// answered, and the register of every prompt surface that depends on the
// answer: a new owner-only surface goes through `ownerOnly(id, ...)` with an
// id listed in OWNER_AUDIENCE_SURFACES, and owner-audience.test.ts fails for
// a call with an unlisted id, a listed id nobody calls, or a surface that
// reaches a contact's turn.
//
// The chain rule: a delegated, asked or message_bot turn is owner audience
// only when the thread it runs in AND the thread that started the chain are.
// A peer turn started from a channel person's thread already runs in a task
// bound to that person (humanTask), so both checks agree today; the root
// check keeps it so when a turn lands in a thread that is not bound.
//
// The fingerprint names who is listening: "owner", or the sorted set of the
// human principals involved. A driver session made under one fingerprint is
// not reused under another (L1a/L3a key sessions on it).
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";

export interface TurnAudience {
  /** The thread that started the chain, for a delegated, asked or
   *  message_bot turn. Absent for a turn the human started here. */
  rootThreadId?: string;
  /** What the request that started the turn proved (MessageOrigin). Words
   *  from a caller that proved nothing (a script, a bot's own shell) are not
   *  the owner's, even in the owner's own thread. */
  origin?: "desktop" | "companion" | "unproven";
}

function principalsOf(threadId: string, audience: TurnAudience = {}, db?: DatabaseSync): HumanPrincipal[] {
  const threads = [threadId, ...(audience.rootThreadId && audience.rootThreadId !== threadId ? [audience.rootThreadId] : [])];
  return threads.map(thread => threadHumanPrincipal(thread,db));
}

/** Is everyone this turn answers to the workspace owner? */
export function turnAudienceIsOwner(threadId: string, audience: TurnAudience = {}, db?: DatabaseSync): boolean {
  if (audience.origin === "unproven") return false;
  return principalsOf(threadId, audience, db).every(isWorkspaceOwner);
}

/** "owner", or the sorted, distinct human principals this turn answers to. */
export function audienceFingerprint(threadId: string, audience: TurnAudience = {}): string {
  const principals = principalsOf(threadId, audience);
  const people = [...new Set(principals.map(principal => `${principal.personId}:${principal.bindingId}:${principal.revision}`))].sort();
  // words nobody proved are the owner's are their own audience
  if (audience.origin === "unproven") return ["unproven", ...people].join(",");
  if (principals.every(isWorkspaceOwner)) return "owner";
  return people.join(",");
}

/** Every prompt surface that carries the owner's own material. Each entry
 *  names where it is built; owner-audience.test.ts runs each one in a
 *  contact's thread and in a turn a contact's thread started. */
export const OWNER_AUDIENCE_SURFACES = Object.freeze({
  "about-me": { label: "About me", builtIn: "server/standing-context.ts" },
  "memory-md": { label: "Its notes (MEMORY.md)", builtIn: "server/standing-context.ts" },
  "team-brief": { label: "Team brief", builtIn: "server/standing-context.ts" },
  "project-card": { label: "Project card context", builtIn: "server/project-prompt.ts" },
  "continuation-results": { label: "Results returned to the asker", builtIn: "server/project-prompt.ts" },
  "working-context": { label: "What I've been working on", builtIn: "server/working-context.ts" },
  "project-brief": { label: "Project brief", builtIn: "server/project-layers.ts" },
  "project-board": { label: "Board digest", builtIn: "server/project-layers.ts" },
  "project-summary": { label: "Rolling project summary", builtIn: "server/project-layers.ts" },
  "joining-brief": { label: "Joining brief", builtIn: "server/project-layers.ts" },
  "project-roster-apps": { label: "Connected app names in the roster", builtIn: "server/project-roster.ts" },
  "shared-load": { label: "Shared work", builtIn: "server/shared-bots-roster.ts" },
} as const);
export type OwnerAudienceSurface = keyof typeof OWNER_AUDIENCE_SURFACES;

/** The surface's text on an owner-audience turn, "" on any other. The id is
 *  the registration: a surface not in OWNER_AUDIENCE_SURFACES does not
 *  compile. `build` runs only when the text will be used. */
export function ownerOnly(surface: OwnerAudienceSurface, ownerAudience: boolean, build: () => string): string {
  if (!Object.hasOwn(OWNER_AUDIENCE_SURFACES, surface)) throw new Error(`unregistered owner-audience surface: ${surface}`);
  return ownerAudience ? build() : "";
}
