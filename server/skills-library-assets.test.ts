// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { handleSkillsApi } from "./skills-api.ts";
import { duplicateIntoCollection, getCollectionSkill, importCollectionSkill, prepareCollectionSkillUpdate, updateCollectionSkill } from "./skill-collection.ts";
import { SKILL_LIBRARY_ROOT, listSkills, readLibraryAssets } from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

const bots = [{ id: "website-assets", name: "Website fixture", canUseSkills: true }];
async function call(method: string, path: string, body: unknown = {}) {
  return (await handleSkillsApi({ method, path: path.split("?")[0]!, url: new URL(path, "http://fixture.test"), readBody: async () => body, bots: () => bots }))!;
}
async function duplicate() {
  const result = await call("POST", "/api/skills/library:website-publisher/duplicate");
  expect(result.status).toBe(201);
  return (result.body as { skill: { ref: string } }).skill.ref;
}
const assets = readLibraryAssets(join(SKILL_LIBRARY_ROOT, "website-publisher", "assets"));
if ("error" in assets) throw new Error(assets.error);

it("copies every website-publisher template into the collection", async () => {
  expect(assets.length).toBeGreaterThanOrEqual(4);
  const copy = await duplicate();
  const detail = await call("GET", `/api/skills/${copy}?view=library`);
  expect((detail.body as { files: unknown[] }).files).toEqual(expect.arrayContaining(assets.map((file) => ({ path: file.path, size: file.content.length }))));
});

it("preserves website-publisher template bytes when saving migrates a bot and when reverting", async () => {
  const bot = bots[0]!;
  expect((await call("PUT", `/api/skills/library:website-publisher/bots/${bot.id}`, { on: true })).status).toBe(200);
  const copy = await duplicate(), name = copy.slice("collection:".length);
  const current = getCollectionSkill(name)!;
  expect(await call("PUT", `/api/skills/collection/${name}`, { description: current.description, body: current.text.split(/\n---\s*\n/).slice(1).join("\n---\n") })).toMatchObject({ status: 200, body: { failed: [] } });
  expect(listSkills(bot.id)).toMatchObject([{ name, source: copy, enabled: true }]);
  for (const file of assets) expect(readFileSync(join(workspaceDir(bot.id), "skills", name, file.path))).toEqual(file.content);
  expect((await call("POST", `/api/skills/${copy}/revert`)).status).toBe(200);
  for (const file of assets) expect(readFileSync(join(workspaceDir(bot.id), "skills", "website-publisher", file.path))).toEqual(file.content);
});

it("keeps opaque library assets byte for byte through further copies, edits and bot installs", async () => {
  const bytes = Buffer.from([0, 255, 128, 42]);
  expect(importCollectionSkill([{ path: "SKILL.md", content: "---\nname: binary-guide\ndescription: A clear method.\n---\nDraft a response.\n" }],
    { kind: "copy", label: "Binary guide", originalRef: "library:binary-guide" }, { assets: [{ path: "assets/image.bin", content: bytes }] })).not.toHaveProperty("error");
  const first = getCollectionSkill("binary-guide")!;
  expect(first.assets).toEqual([{ path: "assets/image.bin", content: bytes }]);
  const next = duplicateIntoCollection(first.contents, { name: first.name, displayName: first.name, description: first.description, originalRef: first.source.originalRef }, undefined, first.assets);
  expect(next).not.toHaveProperty("error");
  if ("error" in next) throw new Error(next.error);
  const snapshot = prepareCollectionSkillUpdate(getCollectionSkill(next.name)!, { description: "Edited method.", body: "Draft a better response." });
  if ("error" in snapshot) throw new Error(snapshot.error);
  expect(updateCollectionSkill(snapshot)).not.toHaveProperty("error");
  expect((await call("PUT", `/api/skills/collection:${next.name}/bots/${bots[0]!.id}`, { on: true })).status).toBe(200);
  expect(readFileSync(join(workspaceDir(bots[0]!.id), "skills", next.name, "assets/image.bin"))).toEqual(bytes);
});

it("rejects invalid supporting paths before copying any files", () => {
  expect(importCollectionSkill([{ path: "SKILL.md", content: "---\nname: bad-assets\ndescription: A clear method.\n---\nDraft a response.\n" }],
    { kind: "copy", label: "Fixture" }, { assets: [{ path: "assets/../SKILL.md", content: Buffer.from("bad") }] })).toMatchObject({ code: "invalid" });
  expect(getCollectionSkill("bad-assets")).toBeNull();
});
