import { describe, expect, it, vi } from "vitest";
import { fetchSkill, fetchSkills, fetchTopics, revertSkill, setSkillOnBot } from "./skillsLibrary";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

describe("the Library client", () => {
  it("uses the contract routes, preserves paging and filters, and escapes input", async () => {
    const request = vi.fn();
    await fetchTopics(request);
    await fetchSkills({}, request);
    await fetchSkills({ term: " home-household ", q: " cat & dog ", filter: "onBots", offset: 200, limit: 200 }, request);
    await fetchSkills({ q: "writing", filter: "mine", offset: 0, limit: 1 }, request);
    await fetchSkill("collection:my-copy", request);
    await setSkillOnBot("library:ab-test", "bot/1", true, undefined, request);
    await setSkillOnBot("library:ab-test", "bot-1", false, undefined, request);
    await setSkillOnBot("collection:my-copy", "bot-1", true, "c".repeat(64), request);
    await revertSkill("collection:my-copy", undefined, request);
    await revertSkill("collection:my-copy", "d".repeat(64), request);
    expect(request.mock.calls).toEqual([
      ["/api/library/topics"],
      ["/api/library/skills"],
      ["/api/library/skills?term=home-household&q=cat+%26+dog&filter=onBots&offset=200&limit=200"],
      ["/api/library/skills?q=writing&filter=mine&offset=0&limit=1"],
      ["/api/skills/collection%3Amy-copy?view=library"],
      ["/api/skills/library%3Aab-test/bots/bot%2F1", { method: "PUT", body: JSON.stringify({ on: true }) }],
      ["/api/skills/library%3Aab-test/bots/bot-1", { method: "PUT", body: JSON.stringify({ on: false }) }],
      ["/api/skills/collection%3Amy-copy/bots/bot-1", { method: "PUT", body: JSON.stringify({ on: true, acknowledged: "c".repeat(64) }) }],
      ["/api/skills/collection%3Amy-copy/revert", { method: "POST", body: "{}" }],
      ["/api/skills/collection%3Amy-copy/revert", { method: "POST", body: JSON.stringify({ acknowledged: "d".repeat(64) }) }],
    ]);
  });

  it("returns server answers and preserves policy and acknowledgement refusals", async () => {
    const response = { items: [], total: 240, offset: 240 };
    const request = vi.fn().mockResolvedValue(response);
    expect(await fetchSkills({ offset: 240 }, request)).toBe(response);
    const refusal = Object.assign(new Error("Needs a look"), { status: 409, body: { code: "needs-review", scan: { contentHash: "c".repeat(64) } } });
    request.mockRejectedValue(refusal);
    await expect(setSkillOnBot("collection:my-copy", "bot-1", true, undefined, request)).rejects.toBe(refusal);
    await expect(revertSkill("collection:my-copy", undefined, request)).rejects.toBe(refusal);
  });
});
