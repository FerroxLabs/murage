import { describe, expect, it } from "vitest";

import { PHONE_SCREEN_FRAME_WIDTH, screenFramePath, thumbnailSrcSet } from "./image-thumbnail";

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
