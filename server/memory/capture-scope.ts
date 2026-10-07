// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which memory scope a thread's captured words belong to (0.1.61 lane M, plan
// 3.8 "Project memory in").
//
// Until 0.1.61 every thread captured into its own conversation scope, so a
// save or a learned fact from a project's chat stayed in that chat's scope
// and "What this project remembers" (the room scope) was always empty. The
// change is at the source, not the save: a room's main chat, its task threads
// and a project desk thread of one of its members capture into the room's
// scope, so saves and learned facts land in the room with their evidence
// intact and no new promotion path. Bot pair rooms (`dm`) are exchanges
// between two bots, not a room the owner keeps, and direct chats keep their
// own conversation scope. Sources already captured are never moved.
//
// Only a thread whose human is the workspace owner captures into a room: a
// thread bound to a channel person keeps its own conversation scope, so a
// contact's words never become material a project recalls elsewhere.
//
// The roster comes from the store (registered at load). Without one (unit
// tests of other modules, tools) capture keeps the conversation scope.
import { teamMemoryKey } from "../team-identities.ts";
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import type { MemoryRoster } from "./policy.ts";

export type ThreadCaptureScope = { kind: "room" | "conversation" | "team"; owner: string };

let captureRoster: (() => MemoryRoster) | null = null;

export function memoryCaptureRoster(): MemoryRoster { return captureRoster?.() ?? {bots:[],groups:[]}; }

export function setMemoryCaptureRoster(provider: (() => MemoryRoster) | null): void {
  captureRoster = provider;
}

/** The room a thread belongs to for memory: its main chat or task thread, or
 * a member's project desk thread. Null for direct chats and pair rooms. */
export function threadMemoryRoom(threadId: string, roster: MemoryRoster | null = captureRoster?.() ?? null): string | null {
  if (!roster) return null;
  const room = roster.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
  if (room) return room.dm ? null : room.id;
  for (const bot of roster.bots) {
    const desk = bot.tasks?.find(task => task.threadId === threadId)?.channelProjectDesk;
    if (!desk) continue;
    const project = roster.groups.find(group => group.id === desk.groupId);
    return project && !project.dm && project.channelProject && project.memberIds.includes(bot.id) ? project.id : null;
  }
  return null;
}

export function threadCaptureScope(threadId: string, roster?: MemoryRoster | null, db?: DatabaseSync): ThreadCaptureScope {
  const current = roster === undefined ? captureRoster?.() ?? null : roster;
  const work = current?.bots.flatMap(bot => bot.tasks ?? []).find(task => task.threadId === threadId)?.sharedWork;
  if (work && !work.quarantined && isWorkspaceOwner(threadHumanPrincipal(threadId, db))) {
    const key = teamMemoryKey(work.teamId);
    if (key) return { kind: "team", owner: key };
  }
  const room = threadMemoryRoom(threadId, current);
  return room && isWorkspaceOwner(threadHumanPrincipal(threadId, db)) ? { kind: "room", owner: room } : { kind: "conversation", owner: threadId };
}
