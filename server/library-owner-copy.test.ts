// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A team made from a library template showed its channel instructions in the
// channel header: the raw launcher prompt ("# Trend Desk Launcher You are
// **Signal** - the lead for a Trend Desk team in Wayland..."). It named the
// old product, a lead that does not exist, a spawn tool Murage does not have,
// and kept saying "Trend Desk" after the team was renamed (0.1.60 Linux and
// Windows customer passes). Channel instructions are read by the owner in the
// header and by every member on every turn, so they must read as the team's
// purpose in plain words.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = (path: string) => new URL(`../library/${path}/`, import.meta.url);
const json = (path: string, name: string) => JSON.parse(readFileSync(new URL(name, dir(path)), "utf8"));
const packages = readdirSync(dir("packages")).filter(name => name.endsWith(".json"));

describe("library templates speak to the owner", () => {
  it.each(packages)("%s: every channel's instructions are its purpose, not a launcher prompt", name => {
    const pkg = json("packages", name).package;
    for (const room of pkg.rooms ?? []) {
      const bulletin: string = room.bulletin ?? "";
      expect(bulletin, room.name).not.toMatch(/\bWayland\b|Launcher|^\s*#|\bYou are\b|team_spawn_agent/m);
      // it never names the team, so a renamed team's header stays true
      expect(bulletin.includes(room.name) || bulletin.includes(pkg.name), room.name).toBe(false);
      expect(bulletin.length, room.name).toBeLessThanOrEqual(400);
    }
  });

  it("no template or profile names the old product", () => {
    for (const path of ["packages", "assistants"]) {
      for (const name of readdirSync(dir(path)).filter(file => file.endsWith(".json"))) {
        expect(readFileSync(new URL(name, dir(path)), "utf8"), `${path}/${name}`).not.toMatch(/\bWayland\b/);
      }
    }
  });
});
