// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { OverviewLine, overviewLineText } from "./LearningOverviewLine";
import { settingsPanelSource } from "./bot-pages/panel-source";


it("says one short sentence, and nothing when there is nothing to say", () => {
  expect(overviewLineText(null)).toBeNull();
  expect(overviewLineText({ lessons: 0, memories: 0 })).toBeNull();
  expect(overviewLineText({ lessons: 1, memories: 0 })).toBe("Learned 1 thing this month");
  expect(overviewLineText({ lessons: 5, memories: 9 })).toBe("Learned 14 things this month");
  expect(renderToStaticMarkup(createElement(OverviewLine, { text: null }))).toBe("");
  expect(renderToStaticMarkup(createElement(OverviewLine, { text: "Learned 14 things this month" }))).toContain("Learned 14 things this month");
});
it("sits after the setup action on the Overview, desktop only", () => {
  const panel = settingsPanelSource();
  expect(panel).toMatch(/<BotSetupAction bot=\{bot\} \/>\s*\{desktop === true && <LearningOverviewLine /);
  expect(panel).toMatch(/<SettingsSection id="learning" active=\{section\}>\s*(?:<div id="bot-setting-learning"[^>]*>)?\{desktop === true && <LearningSettings key=\{`learning-\$\{bot\.id\}`\} bot=\{bot\} \/>\}/);
});
