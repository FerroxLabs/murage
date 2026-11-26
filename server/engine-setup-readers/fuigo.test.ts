// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { GUIDE, readerFixture } from "./fixture.ts";

const f = readerFixture();
it("K3F0 reports the unqualified Fuigo source with zero filesystem calls", async () => {
  f.put("home/.fuigo/config.toml", '[mcp_servers.tool]\ncommand = "sample"');
  f.put("home/.fuigo/skills/guide/SKILL.md", GUIDE);
  const realpathSync = vi.fn(f.fs.realpathSync);
  expect(await f.read("fuigo", {}, { ...f.fs, realpathSync })).toMatchObject({ status: "unavailable", servers: [], skills: [] });
  expect(realpathSync).not.toHaveBeenCalled();
  expect(f.opened).toEqual([]);
});
