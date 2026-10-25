// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-H H2a, GATE: GET /api/attachments/<name> answers 410 {removed:
// true} for a name with a Remove marker, before any read, when the marker is
// made during the read, and when it is made during a thumbnail resize (the
// recheck sendImage asks right before the first byte). Without a marker the
// answers stay 1.0.3's: 404 for a missing file, 503 for a disk that could not
// answer, and a hidden name is 404 whatever its marker says.
import { describe, expect, it, vi } from "vitest";
import { attachmentGet, NOT_FOUND, REMOVED } from "./attachment-serve.ts";
import type { AttachmentServe } from "./attachments.ts";

const ok: AttachmentServe = { ok: true, bytes: Buffer.from("png"), mime: "image/png", version: "3:abc" };
const NAME = "33333333-3333-4333-8333-333333333333.png";

describe("the attachment GET with a Remove marker", () => {
  it("answers 410 before any read when the marker exists, whether or not the file does", async () => {
    const read = vi.fn(async () => ok);
    expect(await attachmentGet(NAME, { visible: () => true, removed: () => true, read })).toEqual({ refused: REMOVED });
    expect(REMOVED).toEqual({ status: 410, body: { removed: true } });
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing file with no marker, and 503 for a disk that could not answer", async () => {
    expect(await attachmentGet(NAME, { visible: () => true, removed: () => false, read: async () => ({ ok: false, reason: "missing" }) })).toEqual({ refused: NOT_FOUND });
    expect(await attachmentGet(NAME, { visible: () => true, removed: () => false, read: async () => ({ ok: false, reason: "busy" }) })).toMatchObject({ refused: { status: 503 } });
  });

  it("answers 410 when the marker is made during the read, served or unlinked", async () => {
    for (const result of [ok, { ok: false, reason: "changed" } as AttachmentServe]) {
      let marker = false;
      const answer = await attachmentGet(NAME, { visible: () => true, removed: () => marker, read: async () => { marker = true; return result; } });
      expect(answer).toEqual({ refused: REMOVED });
    }
  });

  it("answers 410 when the marker appears during a thumbnail resize: the recheck before the first byte", async () => {
    let marker = false;
    const answer = await attachmentGet(NAME, { visible: () => true, removed: () => marker, read: async () => ok });
    if (!("attachment" in answer)) throw new Error("expected bytes");
    expect(answer.recheck()).toBeNull();
    marker = true; // the Remove lands while the resize runs
    expect(answer.recheck()).toEqual(REMOVED);
  });

  it("a hidden name is 404 whatever its marker says", async () => {
    expect(await attachmentGet(NAME, { visible: () => false, removed: () => true, read: async () => ok })).toEqual({ refused: NOT_FOUND });
  });
});
