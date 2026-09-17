// The window-wide composer drop has to recognise a region that takes the file
// itself, or a file dropped on a bot's avatar would also attach to the chat.
import { describe, expect, it } from "vitest";
import { FILE_DROP_ZONE_ATTRIBUTE, carriesFiles, droppedAvatarFile, insideFileDropZone } from "./file-drop-zone";

describe("file drop zones", () => {
  it("finds a target inside a marked zone and nothing else", () => {
    const inside = { closest: (selector: string) => (selector === `[${FILE_DROP_ZONE_ATTRIBUTE}]` ? {} : null) };
    const outside = { closest: () => null };
    expect(insideFileDropZone(inside as unknown as EventTarget)).toBe(true);
    expect(insideFileDropZone(outside as unknown as EventTarget)).toBe(false);
    // window and document are event targets without closest().
    expect(insideFileDropZone({} as EventTarget)).toBe(false);
    expect(insideFileDropZone(null)).toBe(false);
  });

  it("only counts drags that carry files", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  it("accepts exactly one supported image", () => {
    const webp = new File(["x"], "a.webp", { type: "image/webp" });
    expect(droppedAvatarFile([webp])).toEqual({ file: webp });
    expect(droppedAvatarFile([])).toBeNull();
    expect(droppedAvatarFile([new File(["x"], "a.svg", { type: "image/svg+xml" })])).toHaveProperty("error");
  });
});
