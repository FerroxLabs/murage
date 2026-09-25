import { describe, expect, it } from "vitest";

import {
  PHONE_SCREEN_FRAME_WIDTH,
  rememberServedOriginal,
  screenFramePath,
  servedOriginal,
  thumbnailSrcSet,
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

describe("wasServedOriginal / rememberServedOriginal", () => {
  it("remembers a source across calls, keyed by the src itself", () => {
    const src = "/api/attachments/remembered-once.png";
    expect(wasServedOriginal(src)).toBe(false);
    rememberServedOriginal(src);
    expect(wasServedOriginal(src)).toBe(true);
    expect(wasServedOriginal("/api/attachments/never-marked.png")).toBe(false);
  });
});
