// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2428 (Apache-2.0).
import { expect, it, vi } from "vitest";
import { fetchSkillFromSource, parseSkillSource } from "./skill-fetch.ts";

it("refuses a plain-http raw link", () => {
  expect(parseSkillSource("http://raw.githubusercontent.com/o/r/main/SKILL.md")).toHaveProperty("error");
  expect(parseSkillSource("https://raw.githubusercontent.com/o/r/main/SKILL.md")).toEqual({ rawUrl: "https://raw.githubusercontent.com/o/r/main/SKILL.md" });
});

it.each([
  "https://evil.example/SKILL.md",
  "http://raw.githubusercontent.com/o/r/main/SKILL.md",
  "https://raw.githubusercontent.com:8443/o/r/main/SKILL.md",
  `https://user:pass${"@"}raw.githubusercontent.com/o/r/main/SKILL.md`,
])("never downloads a listed file from %s", async (download_url) => {
  const listing = [{ type: "file", name: "SKILL.md", path: "SKILL.md", download_url }];
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    String(input).startsWith("https://api.github.com/") ? Response.json(listing) : new Response("# Skill")) as typeof fetch;
  const result = await fetchSkillFromSource("o/r", fetcher);
  expect(result).toHaveProperty("error");
  expect(vi.mocked(fetcher).mock.calls.map(([input]) => String(input)).filter((url) => !url.startsWith("https://api.github.com/"))).toEqual([]);
});
