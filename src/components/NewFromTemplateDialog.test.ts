import { describe, expect, it } from "vitest";

import { alreadyHave, templatesOfKind, templateTopics, type TemplateEntry } from "./NewFromTemplateDialog";

const entry = (over: Partial<TemplateEntry>): TemplateEntry => ({ slug: "x", name: "X", summary: "", category: "Sell", members: 1, skills: [], ...over });

describe("the New Bot / New Team chooser", () => {
  it("offers one-bot templates for New Bot and multi-bot ones for New Team", () => {
    const all = [entry({ slug: "a", members: 1 }), entry({ slug: "b", members: 3 }), entry({ slug: "c", members: 1 })];
    expect(templatesOfKind(all, "bot").map((e) => e.slug)).toEqual(["a", "c"]);
    expect(templatesOfKind(all, "team").map((e) => e.slug)).toEqual(["b"]);
  });
  it("lists topics with counts, biggest first", () => {
    expect(templateTopics([entry({ category: "Write" }), entry({ category: "Sell" }), entry({ category: "Sell" }), entry({ category: "" })]))
      .toEqual([{ name: "Sell", count: 2 }, { name: "Write", count: 1 }]);
  });
  it("knows a template you already have, by its package or its one bot's name, ignoring archived bots", () => {
    const pkg = entry({ package: "collections-pack", name: "Collections Assistant" });
    expect(alreadyHave(pkg, [{ name: "Something", installedPackage: { id: "collections-pack", name: "", release: "", requiredApps: [] }, hidden: false }])).toBe(true);
    expect(alreadyHave(pkg, [{ name: "collections assistant", hidden: false }])).toBe(true);
    expect(alreadyHave(pkg, [{ name: "Collections Assistant", hidden: true }])).toBe(false);
    expect(alreadyHave(pkg, [{ name: "Other", hidden: false }])).toBe(false);
  });
});

describe("best matches", () => {
  const ranked = [
    { slug: "ignition", name: "IGNITION", summary: "Takes a beginner to one live income asset", category: "Build", members: 1, skills: ["teams/x/skills/client-follow-up/SKILL.md"] },
    { slug: "collections", name: "Collections Assistant", summary: "Chases overdue invoices and unpaid bills politely", category: "Office", members: 1, skills: [] },
  ];
  it("keeps only templates that share at least two meaningful words of a longer request", async () => {
    const { relevantMatches } = await import("./NewFromTemplateDialog");
    expect(relevantMatches(ranked, "chase unpaid invoices and follow up with clients").map((e) => e.slug)).toEqual(["collections"]);
    expect(relevantMatches(ranked, "invoices").map((e) => e.slug)).toEqual(["collections"]);
  });
  it("shows summaries without markdown", async () => {
    const { plainSummary } = await import("./NewFromTemplateDialog");
    expect(plainSummary("You are **Explainer**. You teach.")).toBe("You are Explainer. You teach.");
  });
});
