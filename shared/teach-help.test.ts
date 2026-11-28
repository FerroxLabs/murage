// W12 (TEACH-ENTRY 1.0.23 D8.4): the rewritten docs section reaches the generated help index, so a
// bot answering from murage_help names where a taught skill is reviewed and who can use it.
import { describe, expect, it } from "vitest";
import { HELP_INDEX } from "./help-index";

describe("W12 Teach a skill in the help index", () => {
  it("names Taught by you and Who can use it in the Teach a skill section", () => {
    const text = JSON.stringify(HELP_INDEX.filter((entry) => JSON.stringify(entry).includes("Teach a skill")));
    expect(text).toContain("Taught by you");
    expect(text).toContain("Who can use it");
    expect(text).toContain("/teach");
  });
});
