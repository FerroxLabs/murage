// A first-run card, as it travels on a message.
//
// The 0.1.58 first run happens IN the Chief of Staff's thread. Each step's
// card is a real bot-authored message (`kind: "options"` carrying `setup`),
// appended by the server exactly like the intake card a new bot is seeded
// with. That choice is the whole design: the person is talking to their Chief
// of Staff from the first second, the conversation is still there tomorrow,
// and nothing about the first run is a modal sitting on top of an app they
// have not seen yet.
//
// The wire shape carries only WHICH card this is. Every word on it lives in
// the renderer, in one file, so the copy can be reviewed and tested in one
// place instead of being spread across server strings. A transcript exported
// without the renderer still reads correctly, because `OptionCardData.title`
// keeps a plain sentence alongside.

import { z } from "zod";

import { SETUP_STEPS, setupStepSchema } from "./setup.ts";

/**
 * Which card, and which version of it.
 *
 * `variant` exists because most steps have two honest openings and the right
 * one depends on what detection found. The agents card either says "you
 * already had these and I have connected them" or "there is one in the box";
 * the phone card either offers a QR code or offers to set Tailscale up
 * first. A card that guessed would be a card that is wrong on half the
 * machines it ships to.
 */
export const SETUP_CARD_VARIANTS = [
  /** hello: name and email, the two fields, with Skip. */
  "welcome",
  /** agents: engines were found on this machine and connected. */
  "found",
  /** agents: nothing was found, and the one in the box is doing the work. */
  "bare",
  /** agents: nothing was found AND the one in the box has nothing to think
   *  with yet. Separate from "bare" because the two say opposite things, and
   *  "it is what is talking to you now" is false on a machine with no key,
   *  no sign-in and no local model. */
  "bare-needs-key",
  /** agents: an engine IS here, ready, and nobody is signed in to it. Its own
   *  variant because all three of the others would be a lie about it: "found"
   *  claims it is connected, "bare" claims there was nothing here, and
   *  "bare-needs-key" claims a key is what is missing when a sign-in is. */
  "signed-out",
  /** flux: the key card, offered. */
  "key",
  /** flux: tomorrow morning, rendered, before anything is asked for. An
   *  offer and an invitation rather than a pitch, and it costs nothing to
   *  produce, which is what lets it exist at all. */
  "sample-brief",
  /** flux: they said not now, and local work carries on. */
  "no-key",
  /** apps: Gmail, calendar and chat, with a reason on each row. */
  "apps",
  /** brief: the morning brief, one time field, one button. */
  "brief",
  /** brief: it has just run, and here is what it said. */
  "brief-ran",
  /** routines: a couple more, proposed from what is connected. */
  "more-routines",
  /** the closing card: what would you like to do next. */
  "next",
  /** phone pairing, with the QR code in the chat. */
  "phone",
  /** phone pairing is not possible yet, and here is the offer to fix that. */
  "phone-needs-tailscale",
] as const;
export type SetupCardVariant = (typeof SETUP_CARD_VARIANTS)[number];

/** The closing card's step is not one of the six; it belongs to the flow
 *  rather than to a checklist row, so it rides on the last step. */
export const setupCardSchema = z.object({
  step: setupStepSchema,
  variant: z.enum(SETUP_CARD_VARIANTS),
  /**
   * One card per key, forever.
   *
   * The server appends the next card whenever it notices the flow has moved
   * on, and it notices on every read of `/api/setup`. Without an identity the
   * person would collect a new copy of the same card every time the app
   * polled. The key is the step and variant, so re-deriving the same state
   * finds the card already there and does nothing.
   */
  key: z.string().min(1).max(120),
  /** Set once the card has been acted on, so the renderer can show it
   *  settled rather than live. The words are the renderer's. */
  settled: z.boolean().optional(),
}).strict();
export type SetupCardData = z.infer<typeof setupCardSchema>;

export function setupCardKey(step: SetupCardData["step"], variant: SetupCardVariant): string {
  return `${step}:${variant}`;
}

/** Defensive read, the same shape of gate `readIntakeCard` applies: a card
 *  from a newer build, or a restored transcript, must never throw its way
 *  into the message list. */
export function readSetupCard(card: unknown): SetupCardData | null {
  if (!card || typeof card !== "object") return null;
  const setup = (card as { setup?: unknown }).setup;
  const parsed = setupCardSchema.safeParse(setup);
  return parsed.success ? parsed.data : null;
}

void SETUP_STEPS;
