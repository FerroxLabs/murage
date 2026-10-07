import { describe, expect, it } from "vitest";
import { NOTICE_TEXT, noticeText } from "./notice";

describe("launcher notices", () => {
  it("knows the removed-computer notice and nothing it was not given", () => {
    expect(noticeText("removedWorkspace")).toBe("That notification was for a computer that is no longer on this phone.");
    expect(noticeText("<script>")).toBeNull();
    expect(noticeText(7)).toBeNull();
  });
  it("follows the copy rules", () => {
    for (const text of Object.values(NOTICE_TEXT)) expect(text).not.toMatch(/—|\bsafe(ty)?\b/i);
  });
});
