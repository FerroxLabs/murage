// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

const data = mkdtempSync(join(tmpdir(), "murage-library-errors-"));
let api: typeof import("./skills-api.ts");
let index: typeof import("./skill-search.ts");
beforeAll(async () => {
  const library = join(data, "library");
  mkdirSync(join(library, "guide-one", "assets"), { recursive: true });
  writeFileSync(join(library, "guide-one", "manifest.json"), JSON.stringify({ id: "guide-one", name: "Guide One", version: "1.0.0", description: "A clear method.", triggerTerms: ["testing"], defaultEnabled: false, requiredCapabilities: [] }));
  writeFileSync(join(library, "guide-one", "SKILL.md"), "---\nname: guide-one\ndescription: A clear method.\n---\nDraft a clear response.\n");
  symlinkSync("../SKILL.md", join(library, "guide-one", "assets", "bad-link.md"));
  // A directory in place of the disposable SQLite file makes the real index unavailable.
  mkdirSync(join(data, "skill-index.db"));
  vi.stubEnv("MURAGE_DATA_DIR", data); vi.stubEnv("MURAGE_SKILL_LIBRARY", library); vi.resetModules();
  api = await import("./skills-api.ts"); index = await import("./skill-search.ts");
});
afterAll(async () => { index?.resetSkillIndex(); vi.unstubAllEnvs(); vi.resetModules(); await removeTempDir(data); });
const request = (path: string) => ({ method: "GET", path: path.split("?")[0]!, url: new URL(path, "http://fixture.test"), readBody: async () => ({}), bots: () => [] });

it("returns an explicit failure when library assets cannot be read", async () => {
  expect(await api.handleSkillsApi(request("/api/skills/library:guide-one?view=library"))).toMatchObject({ status: 503, body: { code: "assets-unavailable", error: expect.stringContaining("link") } });
});
it("refuses to silently truncate a search after 200 characters", async () => {
  expect(await api.handleLibrarySkillsApi(request(`/api/library/skills?q=${"a".repeat(201)}`))).toMatchObject({ status: 400, body: { code: "invalid", error: "Search for up to 200 characters." } });
});
it("reports an unavailable index from the uncapped reader", async () => {
  await expect(index.librarySkillRows()).rejects.toThrow("The skills library could not be read. Try again.");
});
it.each(["topics", "skills"])("returns an explicit failure for %s when the index is unavailable", async (route) => {
  expect(await api.handleLibrarySkillsApi(request(`/api/library/${route}`))).toMatchObject({ status: 503, body: { code: "library-unavailable", error: "The skills library could not be read. Try again." } });
});
