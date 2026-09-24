// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BUILT_IN_COPY_NOTE, SkillEditor } from "./SkillEditor";
import type { SkillDetail } from "@/lib/skills-api";

const skill: SkillDetail = {
  ref: "collection:invoice-chaser-copy", name: "invoice-chaser-copy", description: "Chases overdue invoices.", kind: "collection", verdict: "clean",
  source: "Copied from Invoice Chaser", usedBy: [], text: "---\nname: invoice-chaser-copy\ndescription: Chases overdue invoices.\nlicense: MIT\n---\n# Invoices\nDraft polite reminders.\n",
  files: ["SKILL.md"], skipped: [], scan: { verdict: "clean", findings: [], contentHash: "c".repeat(64) }, bots: [],
};

describe("the skill editor", () => {
  it("edits the name, what it's for and the instructions, never the raw header block", () => {
    const html = renderToStaticMarkup(createElement(SkillEditor, { skill, onCancel: () => {}, onSaved: () => {} }));
    expect(html).toContain(">Name<");
    expect(html).toContain("What it&#x27;s for");
    expect(html).toContain("What it tells the bot");
    expect(html).toContain("Chases overdue invoices.");
    expect(html).not.toContain("license: MIT");
    expect(html).not.toContain("name: invoice-chaser-copy");
    expect(html).not.toMatch(/SKILL\.md|frontmatter|manifest/i);
    expect(html).toContain(">Save<");
  });

  it("says when a built-in is being edited as the owner's own copy", () => {
    const html = renderToStaticMarkup(createElement(SkillEditor, { skill, note: BUILT_IN_COPY_NOTE, onCancel: () => {}, onSaved: () => {} }));
    expect(html).toContain("Built-in skills can&#x27;t be changed, so this edits your own copy.");
  });
});
