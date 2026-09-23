import { describe, expect, it, vi } from "vitest";

import { deleteCollectionSkill, findingLines, importSkill, listSkills, readSkill, refusalOf, setSkillForBot, verdictLabel } from "./skills-api";

describe("skill verdicts in plain words", () => {
  it("names each verdict", () => {
    expect(verdictLabel("clean")).toBe("No red flags");
    expect(verdictLabel("review")).toBe("Needs a look");
    expect(verdictLabel("blocked")).toBe("Blocked");
  });
  it("lists each finding once, in order", () => {
    expect(findingLines({ findings: [{ message: "B" }, { message: "A" }, { message: "B" }] as never })).toEqual(["B", "A"]);
  });
});

describe("the skills client", () => {
  it("calls the right routes", async () => {
    const request = vi.fn(async () => ({}));
    await listSkills({ q: " invoice " }, request);
    await listSkills({ category: "sales" }, request);
    await listSkills({}, request);
    await readSkill("collection:invoice-chaser", request);
    await importSkill({ link: "https://github.com/a/b" }, request);
    await setSkillForBot("library:ab-test", "bot-1", true, "c".repeat(64), request);
    await setSkillForBot("library:ab-test", "bot-1", false, undefined, request);
    await deleteCollectionSkill("invoice-chaser", true, request);
    expect(request.mock.calls).toEqual([
      ["/api/skills?q=invoice"],
      ["/api/skills?category=sales"],
      ["/api/skills"],
      ["/api/skills/collection%3Ainvoice-chaser"],
      ["/api/skills/import", { method: "POST", body: JSON.stringify({ link: "https://github.com/a/b" }) }],
      ["/api/skills/library%3Aab-test/bots/bot-1", { method: "PUT", body: JSON.stringify({ on: true, acknowledged: "c".repeat(64) }) }],
      ["/api/skills/library%3Aab-test/bots/bot-1", { method: "PUT", body: JSON.stringify({ on: false }) }],
      ["/api/skills/collection/invoice-chaser", { method: "DELETE", body: JSON.stringify({ fromBots: true }) }],
    ]);
  });
  it("reads a refusal's code and scan", () => {
    const error = Object.assign(new Error("needs a look"), { status: 409, body: { code: "needs-review", scan: { verdict: "review", findings: [], contentHash: "x" } } });
    expect(refusalOf(error)).toMatchObject({ code: "needs-review", scan: { contentHash: "x" }, message: "needs a look" });
  });
});
