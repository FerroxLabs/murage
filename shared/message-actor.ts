// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who is speaking in a message (SPEC-P 10, message envelope v2).
//
// New messages in rooms carry a server-written `actorKind`. Older ones do
// not, so readers derive it in this order: the stored `actorKind`; a
// routine's standing instruction (legacy routine prompts are `role:"user"`
// with `routineRunPrompt`); the owner's own words (a user message in a thread
// whose human is the owner, from a proven surface); anyone else's words; a
// bot's reply. Presentation and prompt labelling only: no authorisation
// decision reads it (authority comes from the origin, the thread's human and
// the request lineage).
export type MessageActorKind = "owner" | "person" | "bot" | "murage" | "routine";

export interface ActorKindInput {
  role: "bot" | "user";
  actorKind?: MessageActorKind;
  routineRunPrompt?: unknown;
  origin?: "desktop" | "companion" | "unproven";
  from?: unknown;
}

export function messageActorKind(message: ActorKindInput, threadHumanIsOwner: boolean): MessageActorKind {
  if (message.actorKind) return message.actorKind;
  if (message.routineRunPrompt) return "routine";
  if (message.role === "user") return threadHumanIsOwner && message.origin !== "unproven" ? "owner" : "person";
  return message.from ? "bot" : "murage";
}
