import { describe, expect, it } from "vitest";

import { botListItemPointerIntent, inlineArchiveAvailable, insideRenameField } from "./sidebar-selection";

describe("botListItemPointerIntent", () => {
  it.each(["avatar", "body", "right edge"])("selects the bot from its %s", () => {
    expect(botListItemPointerIntent("click", false)).toBe("select");
  });

  it("leaves clicks inside the rename input with the editor", () => {
    expect(botListItemPointerIntent("click", true)).toBe("ignore");
  });

  it("ignores unrelated pointer events", () => {
    expect(botListItemPointerIntent("contextmenu", false)).toBe("ignore");
    expect(botListItemPointerIntent("mousedown", false)).toBe("ignore");
  });

  it("selects on the primary press outside the field while renaming, because the commit can swallow the click", () => {
    expect(botListItemPointerIntent("mousedown", false, true, 0)).toBe("select");
    expect(botListItemPointerIntent("mousedown", true, true, 0)).toBe("ignore");
    expect(botListItemPointerIntent("mousedown", false, true, 2)).toBe("ignore");
    expect(botListItemPointerIntent("mousedown", false, false, 0)).toBe("ignore");
  });

  it("treats a missing or non-element target as outside the rename field", () => {
    expect(insideRenameField(null)).toBe(false);
    expect(insideRenameField({} as EventTarget)).toBe(false);
  });
});

describe("inlineArchiveAvailable", () => {
  const base = { role: "member" as const, archiveDisabled: false, renaming: false, iconOnly: false };

  it("offers the inline Archive shortcut for an archivable team member or individual assistant", () => {
    expect(inlineArchiveAvailable(base)).toBe(true);
    expect(inlineArchiveAvailable({ ...base, role: "individual" })).toBe(true);
  });

  it("omits it for the Chief of Staff and team leads, who need a successor first", () => {
    expect(inlineArchiveAvailable({ ...base, role: "chief" })).toBe(false);
    expect(inlineArchiveAvailable({ ...base, role: "leader" })).toBe(false);
  });

  it("omits it for the last active bot, while renaming and in the avatar rail", () => {
    expect(inlineArchiveAvailable({ ...base, archiveDisabled: true })).toBe(false);
    expect(inlineArchiveAvailable({ ...base, renaming: true })).toBe(false);
    expect(inlineArchiveAvailable({ ...base, iconOnly: true })).toBe(false);
  });
});
