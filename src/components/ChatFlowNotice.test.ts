// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("attributes the independent chat deletion work within PR #3224's own entry", () => {
  const notice = readFileSync("NOTICE", "utf8").replaceAll("\r\n", "\n");
  const entry = notice.match(/^  OpenMausBot PR #3224\n((?: {4}[^\n]*\n)*)/m)?.[1];
  expect(entry).toContain("merge 86d57558277d");
  expect(entry).toContain("Upstream code was not taken.");

  const sections = notice.split(/\n(?=\S)/);
  const independent = sections.findIndex(section => /^  OpenMausBot PR #3224$/m.test(section));
  expect(sections[independent]).toMatch(/^Behaviour taken from upstream, implemented independently in Murage code:\n/);
  const adapted = sections.slice(independent + 1).find(section => /^  OpenMausBot Muse Code driver \(/m.test(section));
  expect(adapted).toMatch(/^Adapted from upstream source:\n/);
});
