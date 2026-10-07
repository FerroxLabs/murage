// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { projectDecisionSentence, ProjectDecisionReminders } from "./project-decisions.ts";
it("uses one project sentence and reminds once after ten minutes", () => {
  expect(projectDecisionSentence("Close Desk",1)).toBe("Close Desk: 1 thing needs your OK");
  expect(projectDecisionSentence("Close Desk",3)).toBe("Close Desk: 3 things need your OK");
  const reminders=new ProjectDecisionReminders();
  expect(reminders.due("g",["a"],0)).toBe(false);
  expect(reminders.due("g",["a"],600000)).toBe(true);
  expect(reminders.due("g",["a"],1200000)).toBe(false);
  expect(reminders.due("g",[],1300000)).toBe(false);
  expect(reminders.due("g",["b"],1400000)).toBe(false);
  expect(reminders.due("g",["b"],2000000)).toBe(true);
});
