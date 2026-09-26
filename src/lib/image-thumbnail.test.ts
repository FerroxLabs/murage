import { describe, expect, it } from "vitest";

import {
  PHONE_SCREEN_FRAME_WIDTH,
  rememberServedOriginal,
  screenFramePath,
  requestedWidth,
  servedOriginal,
  thumbnailSrcSet,
  truePixelWidth,
  wasServedOriginal,
} from "./image-thumbnail";

describe("thumbnailSrcSet", () => {
  it("offers the server's three widths for a same-origin attachment", () => {
    expect(thumbnailSrcSet("/api/attachments/abc-123.png")).toBe(
      "/api/attachments/abc-123.png?w=320 320w, /api/attachments/abc-123.png?w=640 640w, /api/attachments/abc-123.png?w=1280 1280w",
    );
  });

  it("leaves a GIF whole: the server would only send the animation back", () => {
    expect(thumbnailSrcSet("/api/attachments/abc.gif")).toBeUndefined();
  });

  it("never touches bytes that are not the harness's attachment route", () => {
    for (const src of ["data:image/png;base64,AAAA", "blob:https://x/1", "https://example.com/a.png", "/api/media/abc", "/api/attachments/abc.png?w=320"]) {
      expect(thumbnailSrcSet(src), src).toBeUndefined();
    }
  });
});

describe("screenFramePath", () => {
  it("asks a phone for a phone-width frame and the desktop for the original", () => {
    expect(screenFramePath("t1", "m1", true)).toBe(`/api/threads/t1/messages/m1/image?w=${PHONE_SCREEN_FRAME_WIDTH}`);
    expect(screenFramePath("t1", "m1", false)).toBe("/api/threads/t1/messages/m1/image");
  });
});

describe("servedOriginal", () => {
  it("is true once the loaded pixels are narrower than the `w` that was asked for", () => {
    expect(servedOriginal("/api/attachments/abc.png?w=1280", 300)).toBe(true);
  });

  it("is false at or above the requested width: that is a real resize, not the original", () => {
    expect(servedOriginal("/api/attachments/abc.png?w=1280", 1280)).toBe(false);
    expect(servedOriginal("/api/attachments/abc.png?w=1280", 2000)).toBe(false);
  });

  it("is false with no `w` to compare against, or before the image has decoded", () => {
    expect(servedOriginal("/api/attachments/abc.png", 300)).toBe(false);
    expect(servedOriginal("/api/attachments/abc.png?w=1280", 0)).toBe(false);
  });
});

describe("measuring the true pixel width", () => {
  // A srcset <img>'s naturalWidth is divided by its candidate's density: a
  // real 1280-pixel thumbnail in a 259 px slot reports 259 (phone
  // verification 08c). The probe is a plain Image, with no srcset.
  const fakeImage = (naturalWidth: number, fail = false) => {
    const image: any = { naturalWidth, onload: null, onerror: null };
    Object.defineProperty(image, "src", {
      set(value: string) {
        image.requested = value;
        queueMicrotask(() => (fail ? image.onerror() : image.onload()));
      },
    });
    return image;
  };

  it("loads the exact URL the thumbnail drew, and answers its real pixels", async () => {
    const image = fakeImage(1280);
    await expect(truePixelWidth("/api/attachments/a.png?w=1280", () => image)).resolves.toBe(1280);
    expect(image.requested).toBe("/api/attachments/a.png?w=1280");
    // a real resize: the srcset stays
    expect(servedOriginal("/api/attachments/a.png?w=1280", 1280)).toBe(false);
  });

  it("answers 0 (\"cannot tell\") when the probe fails, which never drops the srcset", async () => {
    const width = await truePixelWidth("/x.png?w=640", () => fakeImage(0, true));
    expect(width).toBe(0);
    expect(servedOriginal("/x.png?w=640", width)).toBe(false);
  });

  it("reads the requested width only from a ?w= candidate", () => {
    expect(requestedWidth("/api/attachments/a.png?w=640")).toBe(640);
    expect(requestedWidth("/api/attachments/a.png")).toBeUndefined();
  });
});

describe("wasServedOriginal / rememberServedOriginal", () => {
  it("remembers a source across calls, keyed by the src itself", () => {
    const src = "/api/attachments/remembered-once.png";
    expect(wasServedOriginal(src)).toBe(false);
    rememberServedOriginal(src);
    expect(wasServedOriginal(src)).toBe(true);
    expect(wasServedOriginal("/api/attachments/never-marked.png")).toBe(false);
  });
});
