// A pasted Flux Router key must never reach the transcript.
//
// The detector itself is tested in src/lib/flux-key-paste.test.ts. What this
// file guards is the thing that test cannot see: that the composer actually
// calls it, and calls it first.
//
// It used to check that by looking for `detectFluxKeyInComposer(` in
// Composer.tsx — which meant the guard's BEHAVIOUR was never run here, only
// its spelling. The decision now lives in src/lib/composer-send-gate.ts, so
// the half that can be executed is executed: given a key in the box, the gate
// answers "flux-key", keeps the sentence around it, and does so even when an
// upload is in flight and would otherwise hold the message.
//
// What is left over is genuinely an ordering inside a React component this
// node-environment suite cannot render, and it is the whole point. `send()`
// has several early exits before it dispatches: an image-support check that
// shows an error and returns, a compose step, a size check that shows a
// notice and returns. Put the gate after any of those and there is a path
// where a key is still sitting in the draft when the function ends, waiting
// for the next Enter. Put it after the dispatch and the key is already in the
// thread, on disk, and in the next prompt a model reads. There is no taking
// that back, so those assertions stay, on the source, with the marker updated
// to the call that now carries the guard.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { composerSendGate } from "@/lib/composer-send-gate";
import { resetComposerUploads, trackComposerUpload } from "@/lib/composer-uploads";

const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");

/** A real Flux Router key SHAPE, built the way PasteKeys.test.ts builds its
 *  fixture so no credential-shaped literal is committed. */
const KEY = `sk-flux-${"F".repeat(40)}`;

/** The offset of a marker, asserted to exist so a rename fails loudly here
 *  rather than silently passing an ordering check between two -1s. */
function at(marker: string): number {
  const index = composer.indexOf(marker);
  expect(index, `Composer.tsx no longer contains ${marker}`).toBeGreaterThan(-1);
  return index;
}

afterEach(() => resetComposerUploads());

describe("the pasted-key guard itself, run", () => {
  it("takes the key out of what would have been sent and keeps the sentence", () => {
    expect(composerSendGate({ text: `here is my key ${KEY} thanks`, threadId: "t" })).toEqual({
      kind: "flux-key",
      key: KEY,
      rest: "here is my key thanks",
    });
  });

  it("answers flux-key even while an upload would otherwise hold the message", async () => {
    let release = () => {};
    const intake = trackComposerUpload("t", () => new Promise<void>((r) => { release = r; }));
    expect(composerSendGate({ text: KEY, threadId: "t" }).kind).toBe("flux-key");
    release();
    await intake;
  });

  it("leaves ordinary text alone, including prose about a key", () => {
    expect(composerSendGate({ text: "I think the key is sk-flux something or other", threadId: "t" }))
      .toEqual({ kind: "compose" });
  });
});

describe("the composer's pasted-key guard", () => {
  it("asks the gate that carries it", () => {
    expect(composer).toContain("composerSendGate({ text: effectiveText, threadId })");
    expect(composer).toContain('from "@/lib/composer-send-gate"');
    // and the component no longer makes the decision itself, which is what
    // put it out of reach of a test in the first place
    expect(composer).not.toContain("detectFluxKeyInComposer(");
  });

  it("runs before anything else in send(), including the size check", () => {
    const send = at("  const send = () => {");
    const guard = composer.indexOf("composerSendGate(", send);
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
    const guard = composer.indexOf('gate.kind === "flux-key"');
    expect(guard, "the flux-key branch has been renamed or removed").toBeGreaterThan(-1);
    const block = composer.slice(guard, guard + 1400);
    expect(block).toContain("setText(gate.rest)");
    expect(block).toContain("saveFluxKey(");
    expect(block).toMatch(/\n\s{6}return;\n/);
    // ...and the key itself is never handed to anything that writes a
    // message. If either of these appears in the guard, something is sending.
    expect(block).not.toContain('dispatch({ type: "send"');
    expect(block).not.toContain('dispatch({ type: "sendGroup"');
  });
});
