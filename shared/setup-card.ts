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
  /** detect: engines were found on this machine and connected. */
  "found",
  /** detect: nothing the person installed was found, and the one in the box
   *  is doing the work. Reached with a keyed engine in the box, which IS
   *  usable, so nothing is broken and nothing needs selling. */
  "bare",
  /** detect: an engine IS here, ready, and nobody is signed in to it. Its own
   *  variant because all three of the others would be a lie about it: "found"
   *  claims it is connected, "bare" claims there was nothing here, and
   *  "bare-needs-key" claims a key is what is missing when a sign-in is. */
  "signed-out",
  /** flux: the key card, offered, on a machine that found something. */
  "key",
  /** flux: they said not now, and local work carries on. */
  "no-key",
  /** chat: what can I take off your plate, and the five jobs. */
  "jobs",
  /** flow: the chosen job, from what it needs through to its result. */
  "do-it",

  // ── PARKED. Real, tested work that is no longer a first-run step. ──
  //
  // Nothing below is deleted, and deleting any of it is not this branch's
  // call to make. The phone and Tailscale walkthrough works; the brief cards
  // work; the backups row exists because of a standing rule that setup must
  // end VERIFIED, and configured is not protected. Whether they move to
  // another surface, return later in the flow, or go, is the owner's decision
  // and it is on the morning list.
  //
  // They stay in the union so their copy entries stay exhaustive and their
  // components stay compiling. Nothing emits them: `variantForStep` in
  // server/setup-conversation.ts never returns one.

  /**
   * PARKED, AND PARKED BECAUSE IT WAS A DEAD END.
   *
   * flux: there is nothing on this computer to think with. It said the true
   * thing and then stopped: the card it routes to is two sentences and no
   * control, while the only way to save a key or pass the step over lives on
   * `FirstRunFluxCard`, which the server showed only when the machine was NOT
   * blank. So the one person who could not leave the Flux step without a key
   * was the one person never shown the box that takes one.
   *
   * The framing it carried is not lost and never needed its own card: the
   * Flux card reads `nothingToThinkWith` itself and opens with the report
   * detection never got to make, above a button. The step plans `key` on
   * every machine now.
   *
   * It stays in the union because it is in transcripts. A 0.1.57 install
   * carries it on the `agents` step and a mid-flight 0.1.58 one carries it on
   * `flux`; both keep reading correctly, and both now get the real Flux card
   * beneath it, because that card has a different key.
   */
  "bare-needs-key",
  /** PARKED. brief: tomorrow morning, rendered, before "shall I do this every
   *  day?". The offer now lives on the `brief` job's own result. */
  "sample-brief",
  /** PARKED. apps: Gmail, calendar and chat, with a reason on each row. The
   *  rows survive as per-job connect; the standalone step does not. */
  "apps",
  /** PARKED. brief: the morning brief, one time field, one button. */
  "brief",
  /** PARKED. brief: it has just run, and here is what it said. */
  "brief-ran",
  /** PARKED. routines: a couple more, proposed from what is connected. */
  "more-routines",
  /** PARKED. the closing card: what would you like to do next. */
  "next",
  /** PARKED. phone pairing, with the QR code in the chat. */
  "phone",
  /** PARKED. phone pairing is not possible yet, and here is the offer to fix
   *  that. */
  "phone-needs-tailscale",
] as const;
export type SetupCardVariant = (typeof SETUP_CARD_VARIANTS)[number];

/** The closing card's step is not one of the five; it belongs to the flow
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
