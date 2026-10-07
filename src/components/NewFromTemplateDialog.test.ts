import { describe, expect, it } from "vitest";

import { alreadyHave, templateImportUrl, templatesOfKind, templateTopics, type TemplateEntry } from "./NewFromTemplateDialog";

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

describe("the import guard go-ahead", () => {
  it("counts only for the template whose warning the owner read", () => {
    const a = { team: { name: "A" } }, b = { team: { name: "B" } };
    expect(templateImportUrl(b, b, true)).toBe("/api/teams/import?mode=add&acknowledgeWarnings=1");
    // A slower preview of another template replaced the one that was reviewed.
    expect(templateImportUrl(a, b, true)).toBe("/api/teams/import?mode=add");
    expect(templateImportUrl(b, undefined, true)).toBe("/api/teams/import?mode=add");
    expect(templateImportUrl(b, b, false)).toBe("/api/teams/import?mode=add");
  });
});

describe("the phone layout of the New Bot / New Team panel", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./NewFromTemplateDialog.tsx", import.meta.url), "utf8");
  it("is portalled to the body so the translated phone drawer is not its containing block", () => {
    expect(source).toMatch(/return createPortal\(\s*<div className="overlay-inset fixed/);
    expect(source).toMatch(/document\.body,\s*\);\s*\}\s*$/);
  });
  it("becomes a full-width, full-height sheet below md, inside the safe area and the visual viewport", () => {
    expect(source).toContain("max-md:h-[var(--vvh,100dvh)]");
    expect(source).toContain("max-md:w-full");
    expect(source).toContain("max-md:rounded-none");
    expect(source).toContain("overlay-inset");
  });
  it("keeps a thumb-sized close control on the phone", () => {
    expect(source).toMatch(/aria-label="Close"[^\n]*max-md:size-11/);
  });
  it("shares the portal fix with the New Team and New Channel panels opened from the same + menu", () => {
    for (const file of ["./NewTeamDialog.tsx", "./Sidebar.tsx"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).toMatch(/return createPortal\(\s*<div\s+className="overlay-inset fixed inset-x-0 top-0 z-40/);
    }
  });
});

describe("the shell follows a panned visual viewport", async () => {
  const { readFileSync } = await import("node:fs");
  it("publishes --vvt and pins #root and overlays to it while the keyboard is open", () => {
    expect(readFileSync(new URL("../lib/visual-viewport.ts", import.meta.url), "utf8")).toContain('setProperty("--vvt"');
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/html\[data-keyboard="open"\] #root \{[^}]*top: var\(--vvt, 0px\)/);
    expect(css).toMatch(/\.overlay-inset \{[^}]*var\(--vvt, 0px\)/);
  });
});
