// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { skillActDigest } from "./cloud-home/owner-code.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { SkillsApiRequest } from "./skills-api.ts";

const library = mkdtempSync(join(tmpdir(), "murage-revert-policy-"));
let handle: typeof import("./skills-api.ts").handleSkillsApi;
let skills: typeof import("./skills.ts");
let collection: typeof import("./skill-collection.ts");
const bots = [{ id: "one", name: "One", canUseSkills: true }, { id: "two", name: "Two", canUseSkills: true }];
const original = "library:guide-one";
const routeAct = "revert-act";
async function call(method: string, path: string, body: unknown = {}, ownerCode?: SkillsApiRequest["ownerCode"]) {
  return (await handle({ method, path, url: new URL(path, "http://fixture.test"), readBody: async () => body, bots: () => bots, routeAct, ...(ownerCode ? { ownerCode } : {}) }))!;
}
async function copyAndUse(targets = bots, wanted?: string) {
  const result = await call("POST", `/api/skills/${original}/duplicate`, wanted ? { name: wanted } : {});
  expect(result.status).toBe(201);
  const ref = (result.body as { skill: { ref: string } }).skill.ref;
  for (const bot of targets) expect((await call("PUT", `/api/skills/${ref}/bots/${bot.id}`, { on: true })).status).toBe(200);
  return ref;
}

beforeAll(async () => {
  mkdirSync(join(library, "guide-one"));
  writeFileSync(join(library, "guide-one", "manifest.json"), JSON.stringify({ id: "guide-one", name: "Guide One", version: "1.0.0", description: "Use a clear method.", triggerTerms: ["testing"], defaultEnabled: false, requiredCapabilities: [] }));
  writeFileSync(join(library, "guide-one", "SKILL.md"), "---\nname: guide-one\ndescription: Use a clear method.\n---\nDraft a clear response.\n");
  vi.stubEnv("MURAGE_SKILL_LIBRARY", library);
  vi.resetModules();
  skills = await import("./skills.ts");
  collection = await import("./skill-collection.ts");
  ({ handleSkillsApi: handle } = await import("./skills-api.ts"));
});
beforeEach(() => {
  for (const bot of bots) {
    bot.canUseSkills = true;
    for (const listing of skills.listSkills(bot.id)) skills.removeSkill(bot.id, listing.name);
  }
  for (const skill of collection.listCollection()) collection.deleteCollectionSkill(skill.name);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { vi.unstubAllEnvs(); vi.resetModules(); await removeTempDir(library); });

describe("revert admission and failure handling", () => {
  it("binds the browser owner's proof to the original's content before any installation", async () => {
    const copy = await copyAndUse();
    const originalDetail = await call("GET", `/api/skills/${original}`);
    const hash = (originalDetail.body as { scan: { contentHash: string } }).scan.contentHash;
    const gate = vi.fn(async () => ({ status: 403, body: { code: "email_code" } }));
    expect(await call("POST", `/api/skills/${copy}/revert`, {}, gate)).toMatchObject({ status: 403, body: { code: "email_code" } });
    expect(gate).toHaveBeenCalledExactlyOnceWith(skillActDigest(routeAct, hash));
    for (const bot of bots) expect(skills.listSkills(bot.id).map((skill) => skill.source)).toEqual([copy]);
    expect(collection.listCollection()).toHaveLength(1);
    expect((await call("POST", `/api/skills/${copy}/revert`, {}, async () => null)).status).toBe(200);
  });

  it("keeps all copies on their bots when a later original install fails", async () => {
    const copy = await copyAndUse();
    const install = skills.installSkillFromLibrary;
    vi.spyOn(skills, "installSkillFromLibrary").mockImplementationOnce(install).mockReturnValueOnce({ error: "fixture install failed" });
    expect(await call("POST", `/api/skills/${copy}/revert`)).toMatchObject({ status: 409, body: { error: "fixture install failed" } });
    for (const bot of bots) expect(skills.listSkills(bot.id)).toMatchObject([{ source: copy, enabled: true }]);
    expect(collection.listCollection()).toHaveLength(1);
  });

  it("restores an existing original's disabled switch on rollback", async () => {
    const copy = await copyAndUse();
    expect(skills.installSkillFromLibrary("one", "guide-one", library)).not.toHaveProperty("error");
    vi.spyOn(skills, "installSkillFromLibrary").mockReturnValue({ error: "fixture install failed" });
    expect((await call("POST", `/api/skills/${copy}/revert`)).status).toBe(409);
    expect(skills.listSkills("one").find((skill) => skill.name === "guide-one")).toMatchObject({ enabled: false });
    expect(skills.listSkills("one").find((skill) => skill.source === copy)).toMatchObject({ enabled: true });
  });

  it("rolls back earlier copy removals when a later removal fails", async () => {
    const copy = await copyAndUse();
    const remove = skills.removeSkill;
    vi.spyOn(skills, "removeSkill").mockImplementation((botId, name) =>
      botId === "two" && name === copy.slice("collection:".length) ? { error: "fixture removal failed" } : remove(botId, name));
    expect(await call("POST", `/api/skills/${copy}/revert`)).toMatchObject({ status: 409, body: { error: "fixture removal failed" } });
    for (const bot of bots) expect(skills.listSkills(bot.id)).toMatchObject([{ source: copy, enabled: true }]);
    for (const bot of bots) expect(skills.listSkills(bot.id)).toHaveLength(1);
    expect(collection.listCollection()).toHaveLength(1);
  });

  it("reports incomplete recovery and retains the collection when rollback fails", async () => {
    const copy = await copyAndUse();
    const install = skills.installSkillFromLibrary;
    vi.spyOn(skills, "installSkillFromLibrary").mockImplementationOnce(install).mockReturnValueOnce({ error: "fixture install failed" });
    vi.spyOn(skills, "removeSkill").mockReturnValue({ error: "fixture rollback removal failed" });
    expect(await call("POST", `/api/skills/${copy}/revert`)).toMatchObject({ status: 409, body: {
      code: "recovery-incomplete", error: "Some bots could not be restored. Your copy has been kept.",
      cause: "fixture install failed", recoveryFailed: [{ id: "one", name: "One", error: "fixture rollback removal failed" }],
    } });
    expect(collection.listCollection()).toHaveLength(1);
  });

  it("recovers when a later copy removal throws after changing its manifest", async () => {
    const copy = await copyAndUse();
    const remove = skills.removeSkill;
    vi.spyOn(skills, "removeSkill").mockImplementation((botId, name) => {
      const result = remove(botId, name);
      if (botId === "two" && name === copy.slice("collection:".length)) throw new Error("fixture disk failure");
      return result;
    });
    expect(await call("POST", `/api/skills/${copy}/revert`)).toMatchObject({ status: 409, body: { error: "fixture disk failure" } });
    for (const bot of bots) {
      expect(skills.listSkills(bot.id)).toHaveLength(1);
      expect(skills.listSkills(bot.id)).toMatchObject([{ source: copy, enabled: true }]);
    }
    expect(collection.listCollection()).toHaveLength(1);
  });

  it("supports a copy explicitly given the same slug as its library original", async () => {
    const copy = await copyAndUse(bots, "guide-one");
    expect(copy).toBe("collection:guide-one");
    expect((await call("POST", `/api/skills/${copy}/revert`)).status).toBe(200);
    for (const bot of bots) expect(skills.listSkills(bot.id)).toMatchObject([{ source: "library:guide-one@1.0.0", enabled: true }]);
    expect(collection.listCollection()).toEqual([]);
  });

  it("restores same-slug copies too when a later install fails", async () => {
    const copy = await copyAndUse(bots, "guide-one");
    const install = skills.installSkillFromLibrary;
    vi.spyOn(skills, "installSkillFromLibrary").mockImplementationOnce(install).mockReturnValueOnce({ error: "fixture install failed" });
    expect((await call("POST", `/api/skills/${copy}/revert`)).status).toBe(409);
    for (const bot of bots) expect(skills.listSkills(bot.id)).toMatchObject([{ source: copy, enabled: true }]);
  });

  it("refuses engines that cannot use skills before changing any bot", async () => {
    const copy = await copyAndUse();
    bots[1]!.canUseSkills = false;
    expect(await call("POST", `/api/skills/${copy}/revert`)).toMatchObject({ status: 409, body: { code: "engine" } });
    for (const bot of bots) expect(skills.listSkills(bot.id).map((skill) => skill.source)).toEqual([copy]);
  });

  it("does not require a browser switch-on proof for copies that are off", async () => {
    const copy = await copyAndUse([bots[0]!]);
    await call("PUT", `/api/skills/${copy}/bots/one`, { on: false });
    const gate = vi.fn(async () => ({ status: 403, body: { code: "email_code" } }));
    expect((await call("POST", `/api/skills/${copy}/revert`, {}, gate)).status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
    expect(skills.listSkills("one")).toMatchObject([{ source: "library:guide-one@1.0.0", enabled: false }]);
  });

  it("keeps original provenance through edits and further copies", async () => {
    const first = await copyAndUse([]);
    const second = await call("POST", `/api/skills/${first}/duplicate`);
    const ref = (second.body as { skill: { ref: string } }).skill.ref;
    expect(collection.getCollectionSkill(ref.slice("collection:".length))?.source.originalRef).toBe(original);
    await call("PUT", `/api/skills/collection/${ref.slice("collection:".length)}`, { description: "Edited.", body: "Draft a clear response." });
    expect(collection.getCollectionSkill(ref.slice("collection:".length))?.source.originalRef).toBe(original);
    expect((await call("POST", `/api/skills/${ref}/revert`)).status).toBe(200);
    expect(collection.getCollectionSkill(first.slice("collection:".length))).not.toBeNull();
  });

  it("asks for the same browser proof when saving a copy would move original users", async () => {
    expect((await call("PUT", `/api/skills/${original}/bots/one`, { on: true })).status).toBe(200);
    const copy = await copyAndUse([]);
    const name = copy.slice("collection:".length);
    const before = collection.getCollectionSkill(name)!.text;
    const gate = vi.fn(async () => ({ status: 403, body: { code: "email_code" } }));
    expect((await call("PUT", `/api/skills/collection/${name}`, { description: "Edited.", body: "A better method." }, gate)).status).toBe(403);
    expect(gate).toHaveBeenCalledOnce();
    expect(collection.getCollectionSkill(name)!.text).toBe(before);
    expect(skills.listSkills("one")).toMatchObject([{ source: "library:guide-one@1.0.0", enabled: true }]);
  });

  it("does not overwrite unrelated bot skills when saving a copy", async () => {
    await call("PUT", `/api/skills/${original}/bots/one`, { on: true });
    const copy = await copyAndUse([]);
    const name = copy.slice("collection:".length);
    const text = readFileSync(join(library, "guide-one", "SKILL.md"), "utf8").replace("name: guide-one", `name: ${name}`);
    expect(skills.installSkill("one", "https://example.invalid/unrelated", [{ path: "SKILL.md", content: text }])).not.toHaveProperty("error");
    expect((await call("PUT", `/api/skills/collection/${name}`, { description: "Edited.", body: "A better method." })).status).toBe(409);
    expect(skills.listSkills("one").find((skill) => skill.name === name)?.source).toBe("https://example.invalid/unrelated");
  });
});
