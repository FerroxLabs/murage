import { describe, expect, it, vi } from "vitest";

import { deleteCollectionSkill, findingLines, importSkill, listSkills, readSkill, refusalOf, pairLine, setSkillForBot, verdictLabel } from "./skills-api";

describe("skill verdicts in plain words", () => {
  it("names each verdict", () => {
    expect(verdictLabel("clean")).toBe("Checked, nothing risky found");
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

describe("Settings v10 bulk pair lines", () => {
  it("Not saved only from a recorded refusal, with its reason; an unknown pair is Could not check whatever the switch looks like", () => {
    expect(pairLine({ state: "refused", reason: "Dax already has 40 skills on." }, true)).toEqual({ label: "Not saved", detail: "Dax already has 40 skills on." });
    expect(pairLine({ state: "unknown" }, true).label).toBe("Could not check");
    expect(pairLine({ state: "unknown" }, false).label).toBe("Could not check");
    expect(pairLine({ state: "on" }, true)).toEqual({ label: "Saved", detail: "On." });
    expect(pairLine({ state: "already-off" }, false)).toEqual({ label: "Saved", detail: "Already off." });
    expect(pairLine({ state: "kept" }, false).label).toBe("Left as it is");
  });
});
