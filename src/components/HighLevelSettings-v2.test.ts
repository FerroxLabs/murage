// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as settings from "./HighLevelSettings";
it("ux.simpleOneSwitchNeverFull", () => {
  const module = settings as unknown as Record<string, (...args: any[]) => any>;
  expect(typeof module.highlevelSimpleFamilies).toBe("function");
  const levels = module.highlevelSimpleFamilies!(true, { contacts: { canChange: true }, users: { canChange: true }, payments: { canChange: false } });
  expect(levels.contacts).toBe("change"); expect(levels.users).toBe("change"); expect(levels.payments).toBe("off");
  expect(Object.values(levels)).not.toContain("full");
  const source = readFileSync(new URL("./HighLevelSettings.tsx", import.meta.url), "utf8");
  expect(source.match(/<Switch\b/g)).toHaveLength(1);
  expect(source).toContain('t("highlevel.canChange")');
  expect(source).toContain('t("highlevel.fullHelp")');
});
