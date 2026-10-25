import { describe, expect, it } from "vitest";
import { modalKeyAction } from "./use-modal-dialog";

describe("modal dialog keys", () => {
  it("Escape closes from anywhere outside a field", () => {
    for (const position of ["first", "last", "middle", "outside", "empty"] as const) {
      expect(modalKeyAction("Escape", false, position)).toBe("close");
    }
  });
  it("Escape inside an input, textarea or editable field leaves the draft alone", () => {
    expect(modalKeyAction("Escape", false, "middle", { editable: true })).toBe("none");
    expect(modalKeyAction("Escape", false, "first", { editable: true, dirty: true })).toBe("none");
  });
  it("Escape with unsaved edits asks before closing", () => {
    expect(modalKeyAction("Escape", false, "middle", { dirty: true })).toBe("confirm-close");
    expect(modalKeyAction("Escape", false, "middle", { dirty: false })).toBe("close");
  });
  it("Tab wraps from the last control to the first", () => {
    expect(modalKeyAction("Tab", false, "last")).toBe("wrap-to-first");
    expect(modalKeyAction("Tab", false, "middle")).toBe("none");
  });
  it("Shift+Tab wraps from the first control to the last", () => {
    expect(modalKeyAction("Tab", true, "first")).toBe("wrap-to-last");
    expect(modalKeyAction("Tab", true, "middle")).toBe("none");
  });
  it("Tab with focus outside the controls pulls it back in", () => {
    expect(modalKeyAction("Tab", false, "outside")).toBe("wrap-to-first");
    expect(modalKeyAction("Tab", true, "empty")).toBe("wrap-to-first");
  });
  it("other keys are left alone", () => {
    expect(modalKeyAction("a", false, "first")).toBe("none");
  });
});
