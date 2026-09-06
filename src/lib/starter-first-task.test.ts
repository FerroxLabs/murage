import { expect, it } from "vitest";
import { starterFirstTaskDraft } from "./starter-first-task";

it("offers an editable notes-first prompt for each official profile", () => {
  for (const id of ["starter-personal-home", "starter-solo-business", "starter-business-team"]) {
    const text = starterFirstTaskDraft(id, "", 0);
    expect(text).toContain("My notes:");
    expect(text).toMatch(/not assume access/);
  }
});
it("never overwrites text or attachments, including whitespace drafts", () => {
  expect(starterFirstTaskDraft("starter-personal-home", "My work", 0)).toBeNull();
  expect(starterFirstTaskDraft("starter-personal-home", " ", 0)).toBeNull();
  expect(starterFirstTaskDraft("starter-personal-home", "", 1)).toBeNull();
  expect(starterFirstTaskDraft("unknown", "", 0)).toBeNull();
  expect(starterFirstTaskDraft("toString", "", 0)).toBeNull();
});
