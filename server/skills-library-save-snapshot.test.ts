// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { handleSkillsApi, type SkillsApiRequest } from "./skills-api.ts";
import { getCollectionSkill, importCollectionSkill, rewriteSkillHeader } from "./skill-collection.ts";
import { installSkill, listSkills, setSkillEnabled } from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

const bots = [{ id: "snapshot-one", name: "First fixture", canUseSkills: true }, { id: "snapshot-two", name: "Second fixture", canUseSkills: true }];
const edit = { description: "  Edited\n method. ", body: "\n Draft a better response.\n\n" };
function seed(name: string) {
  expect(importCollectionSkill([
    { path: "SKILL.md", content: `\uFEFF---\r\nname: ${name}\r\ndescription: Old method.\r\nlicense: mit\r\nmetadata:\r\n  category: notes\r\n---\r\nDraft a response.\r\n` },
    { path: "notes.txt", content: "Supporting notes.\r\n" },
  ], { kind: "file", label: "Snapshot fixture" }, { assets: [{ path: "assets/image.bin", content: Buffer.from([0, 255, 128]) }] })).not.toHaveProperty("error");
  return getCollectionSkill(name)!;
}
function call(name: string, ownerCode: SkillsApiRequest["ownerCode"], routeAct?: string) {
  const path = `/api/skills/collection/${name}`;
  return handleSkillsApi({ method: "PUT", path, url: new URL(path, "http://fixture.test"), readBody: async () => edit, bots: () => bots, ownerCode, routeAct });
}

it("refuses a browser save with no route act before any write even if the gate would accept", async () => {
  const current = seed("missing-route-act");
  const gate = vi.fn(async () => null);
  expect(await call(current.name, gate)).toMatchObject({ status: 403 });
  expect(gate).not.toHaveBeenCalled();
  expect(getCollectionSkill(current.name)).toEqual(current);
  for (const bot of bots) expect(listSkills(bot.id)).toEqual([]);
});

it("writes approved text and assets and uses the snapshotted bot users after the proof", async () => {
  const current = seed("approved-snapshot"), ref = `collection:${current.name}`;
  const expectedText = rewriteSkillHeader(current.text, { name: current.name, ...edit });
  expect(installSkill(bots[0]!.id, ref, current.contents, { assets: current.assets })).not.toHaveProperty("error");
  expect(setSkillEnabled(bots[0]!.id, current.name, true)).not.toHaveProperty("error");
  const gate = vi.fn(async () => {
    const dir = join(DATA_DIR, "skill-collection", current.name);
    writeFileSync(join(dir, "SKILL.md"), current.text.replace("license: mit", "license: changed"));
    writeFileSync(join(dir, "notes.txt"), "Changed during approval.\n");
    writeFileSync(join(dir, "assets/image.bin"), Buffer.from([42]));
    expect(installSkill(bots[1]!.id, ref, current.contents, { assets: current.assets })).not.toHaveProperty("error");
    expect(setSkillEnabled(bots[1]!.id, current.name, true)).not.toHaveProperty("error");
    return null;
  });
  expect(await call(current.name, gate, "snapshot-route-act")).toMatchObject({ status: 200, body: { failed: [] } });
  expect(gate).toHaveBeenCalledOnce();
  const saved = getCollectionSkill(current.name)!;
  expect(saved.text).toBe(expectedText);
  expect(saved.contents.find((file) => file.path === "notes.txt")).toEqual(current.contents.find((file) => file.path === "notes.txt"));
  expect(saved.assets).toEqual(current.assets);
  for (const file of [{ path: "SKILL.md", content: expectedText }, ...saved.assets]) expect(readFileSync(join(workspaceDir(bots[0]!.id), "skills", current.name, file.path))).toEqual(Buffer.from(file.content));
  expect(readFileSync(join(workspaceDir(bots[1]!.id), "skills", current.name, "SKILL.md"), "utf8")).toBe(current.text);
  expect(listSkills(bots[0]!.id)).toMatchObject([{ source: ref, enabled: true, skippedFiles: ["notes.txt"] }]);
  expect(listSkills(bots[1]!.id)).toMatchObject([{ source: ref, enabled: true }]);
});
