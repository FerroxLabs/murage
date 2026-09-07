import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listStarterProfiles, starterProfileContents, STARTER_PROFILE_IDS } from "./starter-profiles.ts";
import { importBotPackageContents, previewBotPackageContents } from "./bot-package-import.ts";

it("offers exactly three local profiles with no connected-account prerequisite", () => {
  const profiles = listStarterProfiles();
  expect(profiles.map(profile => profile.id)).toEqual([...STARTER_PROFILE_IDS]);
  expect(profiles.map(profile => profile.members)).toEqual([1, 2, 3]);
  expect(profiles.every(profile => profile.connectionsRequired === false)).toBe(true);
  for (const id of STARTER_PROFILE_IDS) {
    const contents = starterProfileContents(id);
    expect(contents.payloads.size).toBe(0);
    expect(contents.manifest.definition.package.routines?.every(routine => routine.enabledAfterInstall === false)).toBe(true);
  }
});

it("refuses arbitrary paths, identity substitution and embedded credentials", () => {
  expect(() => starterProfileContents("../private")).toThrow("available starter profiles");
  const root = mkdtempSync(join(tmpdir(), "murage-starter-profiles-"));
  try {
    mkdirSync(join(root, "packages"));
    const profile = JSON.parse(readFileSync(new URL("../library/packages/starter-personal-home.json", import.meta.url), "utf8"));
    const path = join(root, "packages", "starter-personal-home.json");
    profile.package.id = "wrong-id";
    writeFileSync(path, JSON.stringify(profile));
    expect(() => starterProfileContents("starter-personal-home", root)).toThrow("identity");
    profile.package.id = "starter-personal-home";
    profile.package.summary = "Bearer fake_credential_canary_1234567890";
    writeFileSync(path, JSON.stringify(profile));
    expect(() => starterProfileContents("starter-personal-home", root)).toThrow("content checks");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("prepares each official starter through the common inert import path", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-starter-import-"));
  const existingBots = [{ id: "existing-chief", threadId: "existing-thread", name: "Current Chief" }];
  try {
    for (const id of STARTER_PROFILE_IDS) {
      const contents = starterProfileContents(id);
      const selection = { agents: contents.manifest.definition.package.agents.map(agent => agent.key), skills: [],
        routines: (contents.manifest.definition.package.routines ?? []).map(routine => routine.key), instructions: [] };
      const preview = await previewBotPackageContents(contents, { selection, existingBots });
      let calls = 0;
      const imported = await importBotPackageContents({ contents, dataDir: root, selection, existingBots,
        expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
        modelSelection: { instanceId: "fixture", model: "fixture" }, acknowledgeWarnings: true,
        atomicCommit: ({ prepared }) => {
          calls++;
          for (const bot of prepared.bots) expect(bot).toMatchObject({ chiefOfStaff: false, autoApprove: false, computer: "off", composio: false });
          for (const routine of prepared.routines) expect(routine).toMatchObject({ enabled: false, nextRunAt: null });
        },
      });
      expect(calls).toBe(1);
      expect(imported.bots).toHaveLength(contents.manifest.definition.package.agents.length);
      expect(imported.bots.every(bot => bot.id !== "existing-chief")).toBe(true);
    }
    expect(existingBots).toEqual([{ id: "existing-chief", threadId: "existing-thread", name: "Current Chief" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
