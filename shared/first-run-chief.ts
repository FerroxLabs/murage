// WHAT THE CHIEF SAYS OUT LOUD WHEN A SETUP STEP LANDS.
//
// It lived as a literal inside server/index.ts, which is how it came to say
// something that was not true. "That is saved, and locked away on this
// computer" was posted the instant the key reached the keychain, and nothing
// had ever asked Flux Router whether the key was any good. A well shaped but
// wrong, revoked or mistyped key earned a confident sentence in the Chief's
// own voice and then died on the person's first question, with nothing on
// screen connecting the two.
//
// So there are two sentences for the key step now, and which one is said is
// decided by an answer the renderer only sends after the key has been tried:
//
//   `SETUP_FLUX_PROVED_ANSWER`    Flux Router answered with this key's own
//                                 model catalogue. The key is real.
//   `SETUP_FLUX_UNPROVED_ANSWER`  Flux Router could not be reached at all.
//                                 That is a statement about the network and
//                                 never about the key, so the sentence says
//                                 exactly that and claims nothing else.
//
// There is deliberately no third answer for a key Flux Router REJECTED. A
// rejected key is not a step that landed; the card keeps the floor and asks
// for another paste, and the Chief says nothing, because there is nothing
// true to say yet.
//
// These strings live here rather than in src/lib/first-run-copy.ts because
// the server is what posts them and the server cannot import the renderer's
// bundle. They are walked by first-run-copy.test.ts all the same, so the
// house rules cover them: no em dash, never sells on price, never names the
// broker, three sentences at the ceiling.
import type { SetupStep } from "./setup.ts";

/** The renderer's answer for a key Flux Router has just proved. */
export const SETUP_FLUX_PROVED_ANSWER = "key proved";
/** The renderer's answer for a key that is saved but could not be tried,
 *  because nothing could reach Flux Router to try it. */
export const SETUP_FLUX_UNPROVED_ANSWER = "key saved, not proved";

/**
 * Every line the Chief can say for a step, keyed by the answer that earns it.
 *
 * Keyed rather than single, because the whole defect was one sentence
 * standing in for several different things that can happen.
 */
export const CHIEF_CONFIRMATIONS: Partial<Record<SetupStep, Readonly<Record<string, string>>>> = {
  flux: {
    [SETUP_FLUX_PROVED_ANSWER]:
      "That key works, and it is locked away on this computer. It never appears in our conversation, not even to me.",
    [SETUP_FLUX_UNPROVED_ANSWER]:
      "That is saved and locked away on this computer. I could not reach Flux Router just now, so I have not tried it yet. "
      + "I will use it the moment you ask me something.",
  },
};

/** The line owed for this answer, or null when the step owes no reply. */
export function chiefConfirmation(step: SetupStep, answer: string): string | null {
  return CHIEF_CONFIRMATIONS[step]?.[answer.trim()] ?? null;
}

/** Every line this step could have said, for the idempotence check: a retry
 *  that comes back with the OTHER verdict must not leave two confirmations
 *  in the thread contradicting each other. */
export function chiefConfirmationsFor(step: SetupStep): readonly string[] {
  return Object.values(CHIEF_CONFIRMATIONS[step] ?? {});
}
