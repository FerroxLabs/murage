// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 transcript fix: a room reply that bots are no longer shown (it used
// something the owner forgot, deleted or changed) stays in the owner's chat,
// with a small line under it saying so. A source contract, as in
// channels-projects-ui.test.ts: a component reads `window` at import time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const GROUP_VIEW = readFileSync(fileURLToPath(new URL("./GroupView.tsx", import.meta.url)), "utf8");

it("shows the owner that bots no longer see a withheld reply, under the reply itself", () => {
  const flag = GROUP_VIEW.indexOf("{m.withheldFromBots && (");
  expect(flag).toBeGreaterThan(-1);
  const line = "Bots no longer see this reply: it used something you deleted or changed.";
  expect(GROUP_VIEW.indexOf(line, flag)).toBeGreaterThan(flag);
  // inside the bot branch, after the reply's own text: the reply is kept
  expect(GROUP_VIEW.lastIndexOf("<ChatMarkdown text={m.text}", flag)).toBeGreaterThan(-1);
  expect(line).not.toMatch(/—|\bsafe/i);
});

// 0.1.61 final check D4: the reply the owner forgot itself says so, rather
// than that it used something deleted or changed.
it("tells the owner a reply they forgot is withheld because they forgot it", () => {
  const flag = GROUP_VIEW.indexOf("{m.withheldFromBots && (");
  const forgotten = "Bots no longer see this reply: you chose to forget it.";
  expect(GROUP_VIEW.indexOf('m.withheldFromBots === "forgotten"', flag)).toBeGreaterThan(flag);
  expect(GROUP_VIEW.indexOf(forgotten, flag)).toBeGreaterThan(flag);
  expect(forgotten).not.toMatch(/—|\bsafe/i);
});
