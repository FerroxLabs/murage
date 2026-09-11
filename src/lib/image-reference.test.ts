import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addImageReference, artifactReferenceSource, attachmentReferenceSource, composerReferenceTarget, referenceChip, registerComposerReferenceTarget,
  subscribeComposerReferenceTargets,
} from "./image-reference";
import { MEDIA_ROUTES, type MediaReferenceResponse } from "../../shared/media-assets";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const register = (threadId: string, draftId: string, botId?: string) => { const off = registerComposerReferenceTarget({ threadId, draftId, ...(botId ? { botId } : {}) }); cleanups.push(off); return off; };
const response = (name = "11111111-1111-4111-8111-111111111111.png"): MediaReferenceResponse => ({
  reference: { id: name, sha256: "a".repeat(64), mime: "image/png", bytes: 68, source: "attachment" },
  attachment: { path: `/data/attachments/${name}`, name, mime: "image/png", bytes: 68 },
});

describe("reference sources", () => {
  it("offers only generated attachment names and saved PNG, JPEG or WebP versions within the limit", () => {
    expect(attachmentReferenceSource("/data/attachments/11111111-1111-4111-8111-111111111111.png")).toEqual({ kind: "attachment", attachmentId: "11111111-1111-4111-8111-111111111111.png" });
    expect(attachmentReferenceSource("C:\\data\\attachments\\abc-1.jpg")).toEqual({ kind: "attachment", attachmentId: "abc-1.jpg" });
    // Only the name is proposed; whether the conversation holds it is the harness's decision.
    for (const path of ["/data/attachments/a.gif", "/data/attachments/secret.png.exe", "/data/attachments/a b.png", "https://example.test/a.png?x=1", ""]) {
      expect(attachmentReferenceSource(path), path).toBeNull();
    }
    const artifact = { id: "0f2a1c3e-1111-4222-8333-944455566677", sha256: "b".repeat(64), mime: "image/webp", bytes: 1024 };
    expect(artifactReferenceSource(artifact)).toEqual({ kind: "artifact", artifactId: artifact.id, sha256: artifact.sha256 });
    expect(artifactReferenceSource({ ...artifact, mime: "image/gif" })).toBeNull();
    expect(artifactReferenceSource({ ...artifact, bytes: 10 * 1024 * 1024 + 1 })).toBeNull();
  });
});

describe("composer targets", () => {
  it("targets the most recent composer, or the one of a named conversation, and forgets unmounted ones", () => {
    const seen = vi.fn(); cleanups.push(subscribeComposerReferenceTargets(seen));
    expect(composerReferenceTarget()).toBeUndefined();
    register("thread-a", "bot:a:thread-a");
    const offB = register("thread-b", "bot:b:thread-b");
    expect(composerReferenceTarget()?.threadId).toBe("thread-b");
    expect(composerReferenceTarget("thread-a")?.draftId).toBe("bot:a:thread-a");
    expect(composerReferenceTarget("thread-c")).toBeUndefined();
    offB();
    expect(composerReferenceTarget()?.threadId).toBe("thread-a");
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("addImageReference", () => {
  it("asks the harness to pin the image into the target conversation and adds an ordinary image chip", async () => {
    register("thread-a", "bot:a:thread-a", "bot-a");
    const request = vi.fn(async () => response()), append = vi.fn();
    const result = await addImageReference({ source: { kind: "attachment", attachmentId: "11111111-1111-4111-8111-111111111111.png" } }, request, append);
    expect(request).toHaveBeenCalledWith(MEDIA_ROUTES.reference, { method: "POST", body: JSON.stringify({ threadId: "thread-a", botId: "bot-a", source: { kind: "attachment", attachmentId: "11111111-1111-4111-8111-111111111111.png" } }) });
    expect(result.status).toBe("added");
    expect(append).toHaveBeenCalledWith("bot:a:thread-a", [expect.objectContaining({ kind: "image", path: "/data/attachments/11111111-1111-4111-8111-111111111111.png", name: "11111111-1111-4111-8111-111111111111.png", size: 68, mime: "image/png" })]);
  });

  it("never sends a saved file to a different conversation's composer", async () => {
    register("thread-a", "bot:a:thread-a");
    const request = vi.fn(async () => response()), append = vi.fn();
    const result = await addImageReference({ source: { kind: "artifact", artifactId: "0f2a1c3e-1111-4222-8333-944455566677", sha256: "c".repeat(64) }, threadId: "thread-b" }, request, append);
    expect(result).toEqual({ status: "no-conversation" });
    expect(request).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  });

  it("surfaces the harness refusal and adds nothing", async () => {
    register("thread-a", "bot:a:thread-a");
    const append = vi.fn();
    await expect(addImageReference({ source: { kind: "attachment", attachmentId: "a.png" } }, async () => { throw new Error("That image is not in this conversation. No reference image was prepared."); }, append))
      .rejects.toThrow("not in this conversation");
    await expect(addImageReference({ source: { kind: "attachment", attachmentId: "a.png" } }, async () => ({}), append)).rejects.toThrow("could not be prepared");
    expect(append).not.toHaveBeenCalled();
  });

  it("builds the chip the composer sends like an upload", () => {
    expect(referenceChip(response(), "chip-1")).toEqual({ kind: "image", id: "chip-1", path: "/data/attachments/11111111-1111-4111-8111-111111111111.png", name: "11111111-1111-4111-8111-111111111111.png", size: 68, mime: "image/png" });
  });
});
