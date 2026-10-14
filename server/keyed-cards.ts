// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which rows are filed in keyed_card, and under which (family, key). Shared by the
// writer (message-db), the global pass for older option cards (transcript-backfill)
// and the thread fill (branch-fill), which files the families that live on text
// rows (steer, echo, routineRun, digest).

/** The families of cards that carry no request id, kept by (family, key) in
 * keyed_card so a lookup is a keyed read and never a look through the thread:
 * setup (a first-run flow card, by its key), intake (an intake question still
 * open), browser (a browser-setup offer still open), skill (a learned-skill
 * proposal, by its staged id), publish (a "Connect Netlify" card still waiting
 * to be used), echo (a line the setup flow itself said, by
 * step), steer (a steer the engine has not yet confirmed, by its id), routineRun (a row that carries the prompt of a
 * routine run: the thread is a routine's, not the owner's direct chat) and digest (the project digest status line of
 * one day, by that day) and orphaned (a request card the start retired because its run died: still unanswered and answerable, so it counts as
 * open to the routes that answer it, but it is not in the open-card list that the boot reads). */
export type KeyedFamily = "orphaned" | "setup" | "intake" | "browser" | "skill" | "publish" | "echo" | "steer" | "routineRun" | "digest";

interface KeyedShape {
  card?: { requestId?: unknown; orphaned?: unknown; setup?: { key?: unknown } | null; intake?: unknown; dismissed?: unknown; answered?: unknown; browserSetup?: { resumed?: unknown } | null; skillRequest?: { stagedId?: unknown } | null; publish?: { action?: unknown; connect?: { state?: unknown } | null } | null } | null;
  setupEcho?: unknown;
  steerUnconfirmed?: unknown;
  steerId?: unknown;
  routineRunPrompt?: unknown;
  actorKind?: unknown;
  murage?: { kind?: unknown; digestDay?: unknown } | null;
}

/** Whether a row can be in keyed_card at all: the cheap test a writer makes
 * before it pays for a statement. */
export function mayBeKeyed(message: KeyedShape): boolean {
  return message.card !== undefined && message.card !== null || message.steerId !== undefined || message.setupEcho !== undefined || message.routineRunPrompt !== undefined || message.murage?.digestDay !== undefined;
}

/** The (family, key) pairs one row belongs under, as of its current state. */
export function keyedCardsOf(message: KeyedShape): Array<{ family: KeyedFamily; key: string }> {
  const found: Array<{ family: KeyedFamily; key: string }> = [];
  const card = message.card;
  if (card) {
    if (card.setup && typeof card.setup.key === "string" && card.setup.key) found.push({ family: "setup", key: card.setup.key });
    if (card.intake && !card.dismissed) found.push({ family: "intake", key: "" });
    if (card.browserSetup && !card.answered && !card.browserSetup.resumed) found.push({ family: "browser", key: "" });
    if (card.skillRequest && typeof card.skillRequest.stagedId === "string" && card.skillRequest.stagedId) found.push({ family: "skill", key: card.skillRequest.stagedId });
  }
  if (card && card.orphaned && typeof card.requestId === "string" && card.requestId && !card.answered && !card.dismissed) found.push({ family: "orphaned", key: "" });
  if (card?.publish && card.publish.action === "connect" && card.publish.connect?.state === "needed") found.push({ family: "publish", key: "connect" });
  if (typeof message.setupEcho === "string" && message.setupEcho) found.push({ family: "echo", key: message.setupEcho });
  if (message.steerUnconfirmed === true && typeof message.steerId === "string" && message.steerId) found.push({ family: "steer", key: message.steerId });
  if (message.routineRunPrompt !== undefined && message.routineRunPrompt !== null) found.push({ family: "routineRun", key: "" });
  if (message.actorKind === "murage" && message.murage?.kind === "status" && typeof message.murage.digestDay === "string") found.push({ family: "digest", key: message.murage.digestDay });
  return found;
}

