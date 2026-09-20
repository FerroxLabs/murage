// A pasted Flux Router key must never reach the transcript.
//
// The detector itself is tested in src/lib/flux-key-paste.test.ts. What this
// file guards is the thing that test cannot see: that the composer actually
// CALLS it, and calls it first.
//
// The order is the whole point, and it is why this is a source test rather
// than a render test. `send()` has several early exits before it dispatches:
// an image-support check that shows an error and returns, a compose step, a
// size check that shows a notice and returns. Put the key guard after any of
// those and there is a path where a key is still sitting in the draft when
// the function ends, waiting for the next Enter. Put it after the dispatch
// and the key is already in the thread, on disk, and in the next prompt a
// model reads. There is no taking that back, so the guard runs before every
// other decision the function makes, and this test fails if it ever moves.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");

/** The offset of a marker, asserted to exist so a rename fails loudly here
 *  rather than silently passing an ordering check between two -1s. */
function at(marker: string): number {
  const index = composer.indexOf(marker);
  expect(index, `Composer.tsx no longer contains ${marker}`).toBeGreaterThan(-1);
  return index;
}

describe("the composer's pasted-key guard", () => {
  it("calls the detector", () => {
    expect(composer).toContain("detectFluxKeyInComposer");
    expect(composer).toContain('from "@/lib/flux-key-paste"');
  });

  it("runs before anything else in send(), including the size check", () => {
    const send = at("  const send = () => {");
    const guard = composer.indexOf("detectFluxKeyInComposer(", send);
    expect(guard, "the guard is not inside send()").toBeGreaterThan(send);

    for (const later of ["messageIsTooLarge(", "composeMessage(", 'type: "sendGroup"', 'type: "send"']) {
      const index = composer.indexOf(later, send);
      expect
        .soft(index, `${later} now runs before the pasted-key guard`)
        .toBeGreaterThan(guard);
    }
  });

  it("stops the send rather than sending the rest of the line", () => {
    // The guard's own block ends in a bare `return;`: the sentence they typed
    // stays in the box, and nothing at all is dispatched on that keystroke.
    const guard = composer.indexOf("detectFluxKeyInComposer(");
    const block = composer.slice(guard, guard + 1400);
    expect(block).toContain("setText(pastedKey.rest)");
    expect(block).toContain("saveFluxKey(");
    expect(block).toMatch(/\n\s{6}return;\n/);
    // ...and the key itself is never handed to anything that writes a
    // message. If either of these appears in the guard, something is sending.
    expect(block).not.toContain('dispatch({ type: "send"');
    expect(block).not.toContain('dispatch({ type: "sendGroup"');
  });
});
