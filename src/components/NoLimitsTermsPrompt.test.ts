// NOLIMITS-MEANS-IT section 6: when the once-only dialog is owed. The server side of the terms is pinned in
// server/nolimits-owner-started-api.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: vi.fn() }));

const { anyAtNoLimits, noLimitsTermsPending } = await import("./NoLimitsTermsPrompt");
const { NO_LIMITS_NOT_NOW_KEY } = await import("./no-limits-terms-key");
const { NO_LIMITS_TERMS } = await import("../../server/full-access.ts");

describe("the No limits terms prompt", () => {
  it("remembers Not now under the current terms version, so new terms ask again and specs that import the key keep up", () => {
    expect(NO_LIMITS_NOT_NOW_KEY).toBe(`murage.noLimitsTerms.notNow.${NO_LIMITS_TERMS}`);
  });

  it("is owed only when the desktop's config says not accepted; a phone's copy has no field", () => {
    expect(noLimitsTermsPending({ noLimitsTerms: { accepted: false } })).toBe(true);
    expect(noLimitsTermsPending({ noLimitsTerms: { accepted: true } })).toBe(false);
    expect(noLimitsTermsPending({})).toBe(false);
    expect(noLimitsTermsPending(null)).toBe(false);
  });

  it("an owner with no bot or chat at No limits never sees it", () => {
    expect(anyAtNoLimits([])).toBe(false);
    expect(anyAtNoLimits([{ noLimits: false, tasks: [{ noLimits: false } as never] }])).toBe(false);
    expect(anyAtNoLimits([{ noLimits: true }])).toBe(true);
    expect(anyAtNoLimits([{ tasks: [{ noLimits: true } as never] }])).toBe(true);
  });
});
