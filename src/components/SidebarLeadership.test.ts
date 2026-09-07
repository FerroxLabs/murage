import { expect, it, vi } from "vitest";
vi.mock("@/lib/analytics", () => ({ track: () => {} }));
(globalThis as unknown as { window?: unknown }).window ??= {};
const { leadershipPromotionBlocked } = await import("./Sidebar");
it("blocks member and individual promotions but always permits demotion", () => {
  expect(leadershipPromotionBlocked("member", false)).toBe(true);
  expect(leadershipPromotionBlocked("individual", false)).toBe(true);
  expect(leadershipPromotionBlocked("member", true)).toBe(false);
  expect(leadershipPromotionBlocked("individual", true)).toBe(false);
  expect(leadershipPromotionBlocked("leader", false)).toBe(false);
  expect(leadershipPromotionBlocked("chief", false)).toBe(false);
});
