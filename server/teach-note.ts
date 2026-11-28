// TEACH-ENTRY 1.0.23 D9.5: the one conditional note a direct owner turn gets when
// the owner's message is a bare offer to teach the bot (shared/teach-intent.ts).
// The note rides the turn message, never the system prompt, so a phrase turn
// does not change the warm engine's stable prefix (r3 Opus M1). No model call.
import { teachIntent } from "../shared/teach-intent.ts";
import { TURN_PROMPTS } from "./bot-shapes.ts";

/** Send ids whose owner client drew a Teach card (`teachCard: true` on the send body). Bounded; read once per turn. */
const cardSends = new Set<string>();
const CARD_SENDS_MAX = 256;

/** The direct send route records the client's flag here; the turn reads it once by its send id. */
export function noteTeachCardSend(sendId: string | undefined, flag: unknown): void {
  if (flag !== true || typeof sendId !== "string" || !sendId) return;
  cardSends.add(sendId);
  while (cardSends.size > CARD_SENDS_MAX) cardSends.delete(cardSends.values().next().value!);
}

export function takeTeachCardSend(sendIds: readonly (string | undefined)[]): boolean {
  let seen = false;
  for (const id of sendIds) if (id && cardSends.delete(id)) seen = true;
  return seen;
}

/** A channel run's prompt wraps the person's words in an untrusted-message label (telegram-channel.ts); the detector reads only the words. */
const CHANNEL_WRAP = /^\[UNTRUSTED [A-Z ]+ CHANNEL MESSAGE\]\n([\s\S]*)\n\[\/UNTRUSTED [A-Z ]+ CHANNEL MESSAGE\]$/;

export interface TeachNoteInput {
  /** The owner's raw message. */
  text: string;
  /** The owner-typed direct-turn conjunction (index.ts `ownerDirectTurn`). */
  ownerDirectTurn: boolean;
  /** An owner DM from a messaging app (the `channelOwner` fact). */
  ownerChannelDm: boolean;
  /** The owner's client drew a card for this send. Ignored unless the server's own detector matches. */
  teachCard: boolean;
  /** `/learn` skill authoring is on for this turn. */
  skillAuthoring: boolean;
  botName?: string;
}

/** "" or the one note line for this turn. Only a phrase match adds a note; a slash match is the `/learn` alias itself. */
export function teachTurnNote(input: TeachNoteInput): string {
  if (!input.ownerDirectTurn && !input.ownerChannelDm) return "";
  let intent;
  const words = input.ownerChannelDm && !input.ownerDirectTurn ? CHANNEL_WRAP.exec(input.text)?.[1] ?? input.text : input.text;
  try { intent = teachIntent(words, input.botName); } catch { return ""; }
  if (intent?.via !== "phrase") return "";
  if (input.teachCard && input.ownerDirectTurn) return TURN_PROMPTS.teachCard;
  return input.skillAuthoring ? TURN_PROMPTS.teachText : "";
}
