import { describe, expect, it } from "vitest";

import { intakeFiles, noticeOffersStorage, type Attachment } from "./composer-attachments";
import { DISK_FULL_MESSAGE } from "../../shared/attachment-storage.ts";

type Fake = { name: string; size: number; type: string; text: () => Promise<string> };
const file = (name: string, type: string, size = 10): Fake => ({
  name,
  size,
  type,
  text: async () => "contents",
});
const upload = async (f: Fake): Promise<Attachment> => ({
  kind: "image",
  id: `id-${f.name}`,
  name: f.name,
  path: `/api/attachments/${f.name}`,
  size: f.size,
  mime: f.type,
});
const onDisk = (f: Fake) => `/Users/me/${f.name}`;

describe("intakeFiles", () => {
  it("uploads images and keeps ordinary files as paths", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([
      ["image", "shot.png"],
      ["file", "notes.txt"],
    ]);
    expect(out.notice).toBeNull();
  });

  // Was: "treats an image as an ordinary file when the engine cannot read
  // one". Dropping a picture on a responder that cannot see one produced a
  // silent <attached-file path> chip and no notice, while pasting the same
  // picture said so plainly. The drop now refuses out loud too.
  it("refuses a dropped image out loud when the engine cannot read one", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      allowImages: false,
      getPath: onDisk,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments).toEqual([]);
    expect(out.notice).toContain("shot.png");
    expect(out.notice).toMatch(/cannot receive images/);
  });

  it("still takes the non-image files dropped alongside a refused image", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      allowImages: false,
      getPath: onDisk,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([["file", "notes.txt"]]);
    expect(out.notice).toContain("shot.png");
  });

  it("names the files it could not take, rather than dropping them in silence", async () => {
    const out = await intakeFiles([{ ...file("ghost.bin", "application/octet-stream", 999_999_999) }], {
      allowImages: true,
      getPath: () => "",
      uploadImage: upload,
    });
    expect(out.attachments).toHaveLength(0);
    expect(out.notice).toMatch(/ghost\.bin/);
  });

  it("reports an upload that failed without losing the files that worked", async () => {
    const out = await intakeFiles([file("ok.png", "image/png"), file("bad.png", "image/png")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => {
        if (f.name === "bad.png") throw new Error("too large");
        return upload(f);
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.notice).toBe("bad.png was not attached. too large");
  });

  // 1.0.3: four photos refused by a full disk were four repeated sentences.
  it("gives one line for a batch refused for the same reason, and flags the storage action", async () => {
    const out = await intakeFiles(["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((name) => file(name, "image/jpeg")), {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async () => { throw new Error(DISK_FULL_MESSAGE); },
    });
    expect(out.notice).toBe(`4 images were not attached. ${DISK_FULL_MESSAGE}`);
    expect(noticeOffersStorage(out.notice)).toBe(true);
    expect(noticeOffersStorage("bad.png was not attached. too large")).toBe(false);
  });

  it("still gives each distinct reason its own clause", async () => {
    const out = await intakeFiles([file("a.png", "image/png"), file("b.png", "image/png"), file("c.png", "image/png")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => { throw new Error(f.name === "c.png" ? "That image is too large." : DISK_FULL_MESSAGE); },
    });
    expect(out.notice).toBe(`2 images were not attached. ${DISK_FULL_MESSAGE} c.png was not attached. That image is too large.`);
  });
});
