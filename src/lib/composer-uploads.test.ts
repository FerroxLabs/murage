// W9': an image that is still uploading must not be handed to the NEXT draft.
//
// The defect: `send()` composed the message from the attachment chips that
// existed at that instant and then cleared the draft. An intake still running
// appended its image afterwards — into the now-empty draft — so the picture
// the person thought they had just sent appeared on their following message.
//
// Two things are pinned here, because either one alone leaves the bug open:
//
//  1. the counter stays raised for the WHOLE intake, append included. Holding
//     it only for the network fetch reopens the gap a few lines later, where
//     `intakeFiles` has resolved but the caller has not appended the chips.
//  2. `send()` consults it BEFORE it composes the draft. Checking afterwards
//     would be checking after the text had already been taken.
//
// (2) used to be written out inside a React component this node-environment
// suite cannot render, so the only check available was a regex over that
// component's source: green for any rewrite the regex did not anticipate, and
// never once running the branch. The ordering now lives in
// src/lib/composer-send-gate.ts, and the tests below RUN it with a real
// intake in flight. One source check survives, and says so: that the
// component still asks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { composerFileIntake, composerPasteIntake } from "./composer-intake";
import { composerSendGate } from "./composer-send-gate";
import {
  composerUploadsPending,
  resetComposerUploads,
  subscribeComposerUploads,
  trackComposerUpload,
} from "./composer-uploads";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Comments explain the code to the next reader; they are never behaviour. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const code = (file: string) => stripComments(readFileSync(join(SRC, file), "utf8"));

afterEach(() => resetComposerUploads());

describe("the pending-upload count a composer sends against", () => {
  it("stays raised until the intake has appended its chips, not merely uploaded", async () => {
    // Exactly the real shape: upload resolves, THEN the caller appends.
    const attached: string[] = [];
    let finishUpload = (_: string) => {};
    const upload = new Promise<string>((resolve) => {
      finishUpload = resolve;
    });

    const seenWhenAppending: boolean[] = [];
    const intake = trackComposerUpload("thread-a", async () => {
      const name = await upload;
      // The window the old code lost the image in.
      seenWhenAppending.push(composerUploadsPending("thread-a"));
      attached.push(name);
    });

    expect(composerUploadsPending("thread-a")).toBe(true);
    finishUpload("shot.png");
    // Let the upload's continuation run, but not the tracker's release.
    await Promise.resolve();
    await intake;

    expect(attached).toEqual(["shot.png"]);
    expect(seenWhenAppending).toEqual([true]);
    expect(composerUploadsPending("thread-a")).toBe(false);
  });

  it("keeps one thread's intake out of another thread's send", async () => {
    let release = () => {};
    const intake = trackComposerUpload("thread-a", () => new Promise<void>((r) => { release = r; }));
    expect(composerUploadsPending("thread-a")).toBe(true);
    expect(composerUploadsPending("thread-b")).toBe(false);
    expect(composerUploadsPending(undefined)).toBe(false);
    release();
    await intake;
  });

  it("counts concurrent intakes so the first to finish does not unblock the send", async () => {
    let releaseOne = () => {};
    let releaseTwo = () => {};
    const one = trackComposerUpload("thread-a", () => new Promise<void>((r) => { releaseOne = r; }));
    const two = trackComposerUpload("thread-a", () => new Promise<void>((r) => { releaseTwo = r; }));
    releaseOne();
    await one;
    expect(composerUploadsPending("thread-a")).toBe(true);
    releaseTwo();
    await two;
    expect(composerUploadsPending("thread-a")).toBe(false);
  });

  it("releases a failed upload, so a refused image cannot wedge the composer shut", async () => {
    await expect(
      trackComposerUpload("thread-a", async () => {
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");
    expect(composerUploadsPending("thread-a")).toBe(false);
  });

  it("tells a subscribed composer when the wait starts and when it ends", async () => {
    const seen: boolean[] = [];
    const off = subscribeComposerUploads(() => seen.push(composerUploadsPending("thread-a")));
    let release = () => {};
    const intake = trackComposerUpload("thread-a", () => new Promise<void>((r) => { release = r; }));
    release();
    await intake;
    off();
    expect(seen).toEqual([true, false]);
  });
});

describe("the composer's send path", () => {
  // A real Flux Router key SHAPE (shared/key-extract.ts), in a real sentence,
  // built the way src/components/PasteKeys.test.ts builds its fixture.
  const KEY = `sk-flux-${"F".repeat(40)}`;

  it("holds the message instead of sending it without the image", async () => {
    let release = () => {};
    const intake = trackComposerUpload("thread-a", () => new Promise<void>((r) => { release = r; }));
    expect(composerSendGate({ text: "here you go", threadId: "thread-a" }))
      .toEqual({ kind: "upload-pending" });
    release();
    await intake;
    // and the moment the intake finishes, the same send goes through
    expect(composerSendGate({ text: "here you go", threadId: "thread-a" }))
      .toEqual({ kind: "compose" });
  });

  it("lets another conversation send while this one is uploading", async () => {
    let release = () => {};
    const intake = trackComposerUpload("thread-a", () => new Promise<void>((r) => { release = r; }));
    expect(composerSendGate({ text: "unrelated", threadId: "thread-b" }))
      .toEqual({ kind: "compose" });
    release();
    await intake;
  });

  it("still lets the pasted-key guard go first, because a key in the transcript is unrecoverable", async () => {
    // The two guards fire on the same send. The key wins: an image arriving
    // on the next message is a confusion, a key in the transcript is on disk
    // and in the next prompt a model reads.
    let release = () => {};
    const intake = trackComposerUpload("thread-a", () => new Promise<void>((r) => { release = r; }));
    expect(composerSendGate({ text: `my key is ${KEY} thanks`, threadId: "thread-a" }))
      .toEqual({ kind: "flux-key", key: KEY, rest: "my key is thanks" });
    release();
    await intake;
  });

  it("keeps the sentence around the key and takes only the key", () => {
    expect(composerSendGate({ text: `${KEY}`, threadId: "thread-a" }))
      .toEqual({ kind: "flux-key", key: KEY, rest: "" });
    expect(composerSendGate({ text: "no key in here", threadId: "thread-a" }))
      .toEqual({ kind: "compose" });
  });

  it("guards a composer with no thread of its own too", async () => {
    let release = () => {};
    const intake = trackComposerUpload(undefined, () => new Promise<void>((r) => { release = r; }));
    expect(composerSendGate({ text: "here you go" })).toEqual({ kind: "upload-pending" });
    release();
    await intake;
  });

  // The one thing the gate cannot prove about itself: that the composer asks
  // it, ahead of composing the draft. Read from the source with comments
  // stripped, because this suite cannot render the component.
  describe("and the composer asks it before it composes the draft", () => {
    const composer = () => code("components/Composer.tsx");

    it("gates the send, and gates it first", () => {
      const source = composer();
      const gate = source.indexOf("composerSendGate({ text: effectiveText, threadId })");
      const compose = source.indexOf("composeMessage(effectiveText, attachments)");
      expect(gate).toBeGreaterThan(-1);
      expect(compose).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(compose);
      // and it acts on both answers rather than only one of them
      expect(source).toContain('gate.kind === "flux-key"');
      expect(source).toContain('gate.kind === "upload-pending"');
    });

  });
});

// EVERY INTAKE PATH, RUN, WITH A SEND ATTEMPTED WHILE IT IS IN FLIGHT.
//
// THE GUARD THIS REPLACES counted how many times the string
// `trackComposerUpload(` appeared in Composer.tsx and asked for at least two,
// plus one occurrence in ComposerAttachments.tsx. A reviewer unwrapped the
// paste path and added a decoy call on the attach path: the count stayed at
// two and 18 tests stayed green, with a pasted image able to land on the next
// person's next message. An occurrence is not a wrapped intake, and a count
// of occurrences cannot tell which path each one belongs to.
//
// The wrapping is `src/lib/composer-intake.ts` now, and these run it. Attach
// and drop are the same call (`composerFileIntake`) because they were already
// meant to be the same intake; paste has its own because its upload really is
// different. Each one is executed with the gate consulted mid-flight, which
// is the property: while this is running, that send is held.
describe("every way a file gets into a draft holds the send", () => {
  /** A file as the composer sees one, with the upload under the test's
   *  control so the gate can be asked while it is still in the air. */
  const png = (name: string) => ({ name, size: 4, type: "image/png", text: async () => "" });

  const uploaded = (name: string) => ({ kind: "image" as const, id: name, name, url: `blob:${name}` });

  it("holds it for the attach button, until the chips are appended", async () => {
    let finish = (_: unknown) => {};
    const added: unknown[] = [];
    const seenWhileAppending: boolean[] = [];
    const intake = composerFileIntake({
      threadId: "thread-a",
      files: [png("shot.png")],
      allowImages: true,
      getPath: (file) => file.name,
      uploadImage: async (file) => {
        await new Promise((resolve) => { finish = resolve; });
        return uploaded(file.name) as never;
      },
      onAdd: (attachments) => {
        // The window the old code lost the image in: upload resolved, chips
        // not appended yet.
        seenWhileAppending.push(composerUploadsPending("thread-a"));
        added.push(...attachments);
      },
      onNotice: () => {},
    });

    expect(composerSendGate({ text: "here you go", threadId: "thread-a" }))
      .toEqual({ kind: "upload-pending" });
    finish(undefined);
    await intake;
    expect(added).toHaveLength(1);
    expect(seenWhileAppending).toEqual([true]);
    expect(composerSendGate({ text: "here you go", threadId: "thread-a" })).toEqual({ kind: "compose" });
  });

  it("holds it for a dropped file, by being the same intake the button uses", async () => {
    // Not "looks the same": the same function, with the drop target's own
    // mounted check, which is the only thing that differs.
    let listening = true;
    const notices: string[] = [];
    // An image dropped on a responder that cannot open one: refused out loud,
    // which is the sentence the drop path exists to deliver.
    const dropped = () => ({
      threadId: "thread-a" as const,
      files: [png("shot.png")],
      allowImages: false,
      getPath: (file: { name: string }) => file.name,
      uploadImage: async () => null,
      onAdd: () => {},
      onNotice: (message: string) => notices.push(message),
      stillListening: () => listening,
    });

    const intake = composerFileIntake(dropped());
    expect(composerSendGate({ text: "and this", threadId: "thread-a" }))
      .toEqual({ kind: "upload-pending" });
    await intake;
    expect(composerSendGate({ text: "and this", threadId: "thread-a" })).toEqual({ kind: "compose" });
    expect(notices, "the refusal never reached the composer").toHaveLength(1);

    listening = false;
    notices.length = 0;
    await composerFileIntake(dropped());
    expect(notices, "a notice was written to a composer that had gone").toHaveLength(0);
  });

  it("holds it for a pasted image, which is the path that was unwrapped", async () => {
    let finish = (_: unknown) => {};
    const added: unknown[] = [];
    const intake = composerPasteIntake({
      threadId: "thread-a",
      files: [png("clip.png")],
      uploadImage: async (file) => {
        await new Promise((resolve) => { finish = resolve; });
        return uploaded(file.name) as never;
      },
      onAdd: (attachments) => added.push(...attachments),
      onError: () => {},
    });

    expect(composerSendGate({ text: "look at this", threadId: "thread-a" }))
      .toEqual({ kind: "upload-pending" });
    finish(undefined);
    await intake;
    expect(added).toHaveLength(1);
    expect(composerSendGate({ text: "look at this", threadId: "thread-a" })).toEqual({ kind: "compose" });
  });

  it("releases the gate for every path when the upload fails", async () => {
    // A refused image must never wedge the composer shut, whichever way it
    // arrived.
    const errors: string[] = [];
    await composerPasteIntake({
      threadId: "thread-a",
      files: [png("bad.png")],
      uploadImage: async () => { throw new Error("upload failed"); },
      onAdd: () => {},
      onError: (message) => errors.push(message),
    });
    expect(errors).toEqual(["upload failed"]);
    expect(composerUploadsPending("thread-a")).toBe(false);

    await composerFileIntake({
      threadId: "thread-a",
      files: [png("bad.png")],
      allowImages: true,
      getPath: (file) => file.name,
      uploadImage: async () => { throw new Error("upload failed"); },
      onAdd: () => {},
      onNotice: () => {},
    });
    expect(composerUploadsPending("thread-a")).toBe(false);
  });

  it("keeps one thread's paste out of another thread's send", async () => {
    let finish = (_: unknown) => {};
    const intake = composerPasteIntake({
      threadId: "thread-a",
      files: [png("clip.png")],
      uploadImage: async () => { await new Promise((resolve) => { finish = resolve; }); return null; },
      onAdd: () => {},
      onError: () => {},
    });
    expect(composerSendGate({ text: "unrelated", threadId: "thread-b" })).toEqual({ kind: "compose" });
    finish(undefined);
    await intake;
  });
});
