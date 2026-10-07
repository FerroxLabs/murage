// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help must say something about everything the product can do.
//
// `murage_help` is how every bot learns what Murage can do. A bot that is not
// told about a tool, a setting or a place invents one instead (a bot once told
// its owner to switch on a "bot-to-bot communications" setting that does not
// exist). shared/help-capabilities.ts is generated from the code by
// scripts/build-capabilities.mjs, and this file fails when any entry in it is
// missing from the help index. It replaces a hand-kept keyword list that only
// ever knew about the features somebody remembered to write down.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP_CAPABILITIES, type Capability } from "./help-capabilities.ts";
import { HELP_INDEX } from "./help-index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const searchable = HELP_INDEX.map((entry) => `${entry.title} ${entry.heading ?? ""} ${entry.description} ${entry.text}`)
  .join("\n")
  .toLowerCase();

/** What the help has to contain for this entry: a tool by its exact name, anything else by the words a person uses. */
const needle = (capability: Capability): string => (capability.kind === "tool" ? capability.name : capability.term).toLowerCase();

describe("help covers what the code can do", () => {
  it("has a capabilities file that matches the code", () => {
    expect(() => execFileSync(process.execPath, ["scripts/build-capabilities.mjs", "--check"], { cwd: root, stdio: "pipe" })).not.toThrow();
  });

  it("derives a real list, not an empty one", () => {
    const kinds = new Set(HELP_CAPABILITIES.map((capability) => capability.kind));
    expect([...kinds].sort()).toEqual(["bot-settings", "label", "place", "route", "settings-page", "tool"]);
    expect(HELP_CAPABILITIES.filter((capability) => capability.kind === "tool").map((capability) => capability.name)).toEqual(
      expect.arrayContaining(["murage_help", "list_bots", "ask_bot", "delegate_bot", "project_assign"]),
    );
  });

  for (const kind of ["tool", "settings-page", "bot-settings", "place", "label", "route"] as const) {
    it(`mentions every ${kind} in the help index`, () => {
      const missing = HELP_CAPABILITIES.filter((capability) => capability.kind === kind && !searchable.includes(needle(capability)));
      expect(
        missing.map((capability) => `${capability.name} (${capability.source}): the help never says "${needle(capability)}"`),
        "add a docs sentence for each, then run node scripts/build-help-index.mjs",
      ).toEqual([]);
    });
  }
});

describe("help does not invent settings", () => {
  it("never mentions the bot-to-bot setting a bot once made up", () => {
    expect(searchable).not.toContain("bot-to-bot communications");
    expect(searchable).not.toContain("bot to bot communications");
  });

  it("tells bots what to do when something is not possible", () => {
    const entry = HELP_INDEX.find((candidate) => candidate.heading === "If something isn't possible");
    expect(entry, 'a docs section headed "If something isn\'t possible"').toBeDefined();
    expect(entry?.text).toMatch(/say so plainly/i);
    expect(entry?.text).toMatch(/nearest/i);
  });
});
