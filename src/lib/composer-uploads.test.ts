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
// (2) is an ordering inside a React component that this node-environment
// suite cannot render, so it is read out of the SOURCE, with comments
// stripped first — a test that matched prose could be satisfied by this very
// paragraph.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  const composer = () => code("components/Composer.tsx");

  // The guard STATEMENT, not merely a mention of the predicate: the same
  // call also feeds the subscription that takes the notice back down, and
  // that one sits near the top of the component where it would satisfy any
  // ordering check by accident.
  const GUARD = /if \(composerUploadsPending\(threadId\)\) \{\s*setSendNotice\(\{ kind: "upload-pending" \}\);\s*return;\s*\}/;

  it("holds the message instead of sending it without the image", () => {
    expect(composer()).toMatch(GUARD);
  });

  it("asks whether an upload is pending before it composes the draft", () => {
    const source = composer();
    const guard = source.search(GUARD);
    const compose = source.indexOf("composeMessage(effectiveText, attachments)");
    expect(guard).toBeGreaterThan(-1);
    expect(compose).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(compose);
  });

  it("still lets the pasted-key guard go first, because a key in the transcript is unrecoverable", () => {
    const source = composer();
    const keyGuard = source.indexOf("detectFluxKeyInComposer(effectiveText)");
    expect(keyGuard).toBeGreaterThan(-1);
    expect(keyGuard).toBeLessThan(source.search(GUARD));
  });

  it("wraps every composer intake path, so drop and paste are no safer or worse than the attach button", () => {
    expect(composer().match(/trackComposerUpload\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(code("components/ComposerAttachments.tsx")).toContain("trackComposerUpload(");
  });
});
