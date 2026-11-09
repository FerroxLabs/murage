// secret-scan: fixture (fake paths, policy test rows)
// SEAN-ASK-ATTACH-CAP (1.0.19): the picture cap follows what a turn can
// deliver, and a refusal names the real size and limit.
import { afterEach, describe, expect, it, vi } from "vitest";

import { IMAGE_MAX_BYTES, imageAttachmentFromFile, intakeFiles, type Attachment } from "./composer-attachments";
import { IMAGE_UPLOAD_MAX_BYTES } from "../../shared/media-assets.ts";

const MB = 1024 * 1024;
type Fake = { name: string; size: number; type: string; text: () => Promise<string> };
const fake = (name: string, type: string, size = 10): Fake => ({ name, size, type, text: async () => "contents" });

afterEach(() => vi.unstubAllGlobals());

describe("composer picture cap", () => {
  it("is the shared upload ceiling, not a separate 10 MB", () => {
    expect(IMAGE_MAX_BYTES).toBe(IMAGE_UPLOAD_MAX_BYTES);
    expect(IMAGE_MAX_BYTES).toBe(25 * MB);
  });

  it("sends a 12 MB photo to the server instead of refusing it in the composer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ path: "/d/attachments/a.png", mime: "image/png", bytes: 12 * MB }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = { name: "photo.png", type: "image/png", size: 12 * MB, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;
    await expect(imageAttachmentFromFile(file, "t")).resolves.toMatchObject({ kind: "image", size: 12 * MB });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a picture over the ceiling with its size and the limit, before reading it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const arrayBuffer = vi.fn();
    const file = { name: "huge.png", type: "image/png", size: 30 * MB, arrayBuffer } as unknown as File;
    await expect(imageAttachmentFromFile(file)).rejects.toThrow("huge.png is 30.0 MB. Images can be up to 25.0 MB.");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the server's own limit sentence through when it lowers the cap for an engine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "That image is too large. Images can be up to 3.8 MB.", limitBytes: 3932160 }), { status: 413 })));
    const file = { name: "shot.png", type: "image/png", size: 5 * MB, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File;
    await expect(imageAttachmentFromFile(file, "t")).rejects.toThrow("Images can be up to 3.8 MB.");
  });
});

describe("GIF intake", () => {
  it("attaches a GIF with a path as a file, never as a picture no turn can show", async () => {
    const uploadImage = vi.fn(async (): Promise<Attachment | null> => null);
    const out = await intakeFiles([fake("dance.gif", "image/gif")], { allowImages: true, getPath: f => `/Users/me/${f.name}`, uploadImage });
    expect(uploadImage).not.toHaveBeenCalled();
    expect(out.attachments).toMatchObject([{ kind: "file", name: "dance.gif", path: "/Users/me/dance.gif" }]);
    expect(out.notice).toBeNull();
  });
});
