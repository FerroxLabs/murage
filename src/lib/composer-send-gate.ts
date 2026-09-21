// What the composer must settle BEFORE it composes a draft.
//
// Two things have to happen ahead of `composeMessage`, and both of them are
// orderings rather than values, which is exactly the kind of rule that rots
// quietly:
//
//  1. A FLUX ROUTER KEY NEVER REACHES THE TRANSCRIPT. People paste a key into
//     whatever is on screen, and during the first run the only thing on screen
//     is the chat box. A key that gets past here is written into the
//     conversation, saved to disk with it, and handed to the next model that
//     reads the thread. There is no taking it back, so this goes first — ahead
//     of the upload check, ahead of the size check, ahead of everything.
//  2. AN IMAGE STILL UPLOADING IS PART OF THIS MESSAGE. `attachments` holds
//     only the chips that have already landed, so sending mid-intake sent the
//     text without the picture and handed the picture to the NEXT draft. The
//     live count (composer-uploads.ts) is read here rather than the rendered
//     one: an intake that finished microseconds ago must not be waited on, and
//     one that started microseconds ago must be.
//
// This lived inline in src/components/Composer.tsx, which meant the only test
// that could be written for it read that component as TEXT and matched a
// regex against it — green for any rewrite the regex did not anticipate, and
// never once running the branch. The decision is here so a test can run it.
// The component keeps the effects: setting the text, raising the notice,
// saving the key. Those are React's; this is not.

import { composerUploadsPending } from "./composer-uploads";
import { detectFluxKeyInComposer } from "./flux-key-paste";

export type ComposerSendGate =
  /** a key was lifted out of the box: save it, keep `rest` in the composer */
  | { kind: "flux-key"; key: string; rest: string }
  /** an image intake for this thread has not finished attaching */
  | { kind: "upload-pending" }
  /** nothing is in the way; compose and send */
  | { kind: "compose" };

export function composerSendGate(input: { text: string; threadId?: string }): ComposerSendGate {
  const pastedKey = detectFluxKeyInComposer(input.text);
  if (pastedKey) return { kind: "flux-key", key: pastedKey.key, rest: pastedKey.rest };
  if (composerUploadsPending(input.threadId)) return { kind: "upload-pending" };
  return { kind: "compose" };
}
