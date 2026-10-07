import { describe, expect, it } from "vitest";
import { commChipAction } from "./comm-chip-visibility";

describe("commChipAction", () => {
  it("opens a group the client has, on the phone", () => {
    expect(commChipAction({ phone: true, groupId: "room-1", groups: [{ id: "room-1" }] })).toBe("open");
  });

  it("blocks a group the phone never received (a bot⇄bot channel filtered by visibleToCompanion)", () => {
    expect(commChipAction({ phone: true, groupId: "dm-dax-kessler", groups: [{ id: "room-1" }] })).toBe("blocked");
  });

  it("blocks on an empty groups list too", () => {
    expect(commChipAction({ phone: true, groupId: "dm-dax-kessler", groups: [] })).toBe("blocked");
  });

  it("always opens on desktop, whether or not the group is in state yet", () => {
    expect(commChipAction({ phone: false, groupId: "dm-dax-kessler", groups: [] })).toBe("open");
    expect(commChipAction({ phone: false, groupId: "room-1", groups: [{ id: "room-1" }] })).toBe("open");
  });
});
