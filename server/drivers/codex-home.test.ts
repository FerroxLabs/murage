// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexHome } from "./codex-catalog.ts";

it("uses an absolute CODEX_HOME", () => {
  const home = join(process.platform === "win32" ? "C:\\" : "/", "srv", "codex-home");
  expect(codexHome({ CODEX_HOME: home, HOME: "/home/a" })).toBe(home);
});

it("ignores a relative CODEX_HOME and uses the home folder", () => {
  expect(codexHome({ CODEX_HOME: "../elsewhere", HOME: "/home/a", USERPROFILE: "/home/a" })).toBe(join("/home/a", ".codex"));
  expect(codexHome({ CODEX_HOME: ".codex", HOME: "/home/a", USERPROFILE: "/home/a" })).toBe(join("/home/a", ".codex"));
});
