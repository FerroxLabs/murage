import { describe, expect, it } from "vitest";

import { formerChiefOutcome } from "./chief-handover.ts";

const chief = { id: "a", section: "Ops", chiefOfStaff: true, chiefScope: "workspace" as const };

describe("formerChiefOutcome", () => {
  it("keeps the former Chief leading its team when it can", () => {
    expect(formerChiefOutcome(chief, [chief], true)).toBe("leader");
  });

  it("makes it a member when its engine cannot lead", () => {
    expect(formerChiefOutcome(chief, [chief], false)).toBe("member");
  });

  it("makes it a member when its team already has a leader", () => {
    const lead = { id: "b", section: " Ops ", chiefOfStaff: true };
    expect(formerChiefOutcome(chief, [chief, lead], true)).toBe("member");
  });

  it("ignores leaders of other teams and the new Chief", () => {
    const other = { id: "b", section: "Sales", chiefOfStaff: true };
    const next = { id: "c", section: "Ops", chiefOfStaff: true, chiefScope: "workspace" as const };
    expect(formerChiefOutcome(chief, [chief, other, next], true)).toBe("leader");
  });
});
