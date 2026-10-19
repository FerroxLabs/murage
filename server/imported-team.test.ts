// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.1 Episode 1: the "Help me run my business" crew arrived with no team
// lead, and its team name carried part of the import id.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importBotPackageContents, previewBotPackageContents } from "./bot-package-import.ts";
import { importedTeamName, legacyImportedLabel, tidyImportedTeams, type ImportedTeamBot } from "./imported-team.ts";
import { starterProfileContents } from "./starter-profiles.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

async function importStarter(id: string, extra: { existingSections?: string[]; starterLeads?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "murage-imported-team-"));
  try {
    const contents = starterProfileContents(id);
    const pkg = contents.manifest.definition.package;
    const selection = { agents: pkg.agents.map(agent => agent.key), skills: [], instructions: [], routines: (pkg.routines ?? []).map(routine => routine.key) };
    const preview = await previewBotPackageContents(contents, { selection, existingBots: [] });
    const imported = await importBotPackageContents({ contents, dataDir: root, selection, existingBots: [],
      expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
      modelSelection: { instanceId: "fixture", model: "fixture" }, acknowledgeWarnings: true, atomicCommit: () => {}, ...extra });
    return { pkg, bots: imported.bots, leads: imported.leadBotIds };
  } finally { removeTempDirSync(root); }
}

describe("the business starter crew", () => {
  it("names its lead in the package", () => {
    const pkg = starterProfileContents("starter-solo-business").manifest.definition.package;
    expect(pkg.agents.find(agent => agent.key === "business-planner")?.role).toBe("leader");
  });

  it("arrives led, under a plain team name with no id", async () => {
    const { bots, leads } = await importStarter("starter-solo-business", { starterLeads: true });
    const planner = bots.find(bot => bot.name === "Business Planner")!;
    // written with no access; the route appoints the lead after the commit
    expect(bots.every(bot => bot.chiefOfStaff === false)).toBe(true);
    expect(leads).toEqual([planner.id]);
    expect(planner.installedPackage?.sourceRole).toBe("leader");
    for (const bot of bots) expect(bot.section).toBe("Solo Business");
  });

  it("takes the next free name when the team already exists", async () => {
    const { bots } = await importStarter("starter-solo-business", { existingSections: ["Solo Business"] });
    expect(new Set(bots.map(bot => bot.section))).toEqual(new Set(["Solo Business 2"]));
  });

  it("leads nobody when the engine cannot coordinate bots", async () => {
    const { leads } = await importStarter("starter-solo-business", { starterLeads: false });
    expect(leads).toEqual([]);
  });

  it("gives a crew of one no lead", async () => {
    const { leads } = await importStarter("starter-personal-home", { starterLeads: true });
    expect(leads).toEqual([]);
  });
});

describe("team names", () => {
  it("never carry an id and stay unique", () => {
    expect(importedTeamName("Solo Business", undefined, [])).toBe("Solo Business");
    expect(importedTeamName("Solo Business", "General", ["solo business"])).toBe("Solo Business 2");
    expect(importedTeamName("Studio", "Design", [])).toBe("Studio · Design");
    expect(importedTeamName("Projects", undefined, [])).toBe("Projects 2");
    expect(importedTeamName("x".repeat(80), undefined, []).length).toBeLessThanOrEqual(60);
    expect(importedTeamName("", undefined, [])).toBe("Imported team");
  });

  it("recognise only a label an earlier import wrote", () => {
    expect(legacyImportedLabel("Solo Business · General (1a2b3c4d)", new Set(["Solo Business"]))).toEqual({ packageName: "Solo Business", team: "General" });
    expect(legacyImportedLabel("Solo Business · General (1a2b3c4d)", new Set(["Other"]))).toBeNull();
    expect(legacyImportedLabel("My team (12345678)", new Set(["My team"]))).toBeNull();
  });
});

describe("teams imported before 1.0.2 are tidied once", () => {
  const legacy = "Solo Business · General (1a2b3c4d)";
  const pkg = { id: "starter-solo-business", name: "Solo Business" };
  const crew = (over: Partial<ImportedTeamBot>[] = [{}, {}]): ImportedTeamBot[] => [
    { id: "planner", name: "Business Planner", section: legacy, chiefOfStaff: false, installedPackage: { ...pkg, sourceRole: "chief" }, ...over[0] },
    { id: "drafter", name: "Draft Partner", section: legacy, chiefOfStaff: false, installedPackage: { ...pkg, sourceRole: "member" }, ...over[1] },
  ];
  const run = (bots: ImportedTeamBot[], opts: { labels?: string[]; leadershipError?: string | null; renameFails?: boolean; leadFails?: boolean } = {}) => {
    const renames: Array<[string, string]> = [];
    const leads: string[] = [];
    tidyImportedTeams({ bots, labels: opts.labels ?? bots.flatMap(bot => bot.section ? [bot.section] : []), starterPackages: new Set([pkg.id]),
      rename: (from, to) => { if (opts.renameFails) throw new Error("busy"); renames.push([from, to]); },
      makeLead: bot => { if (opts.leadFails) throw new Error("busy"); leads.push(bot.id); }, leadershipError: () => opts.leadershipError ?? null });
    return { renames, leads };
  };

  it("drops the id from the name and gives the crew its lead", () => {
    expect(run(crew())).toEqual({ renames: [[legacy, "Solo Business"]], leads: ["planner"] });
  });

  it("keeps a lead the owner chose", () => {
    expect(run(crew([{}, { chiefOfStaff: true }])).leads).toEqual([]);
  });

  it("leaves a team the owner named alone", () => {
    expect(run(crew([{ section: "My shop" }, { section: "My shop" }]))).toEqual({ renames: [], leads: [] });
  });

  it("leaves a team that also holds the owner's own bots alone", () => {
    const bots = [...crew(), { id: "mine", name: "Mine", section: legacy }];
    expect(run(bots)).toEqual({ renames: [], leads: [] });
  });

  it("picks the next free name", () => {
    expect(run(crew(), { labels: [legacy, "Solo Business"] }).renames).toEqual([[legacy, "Solo Business 2"]]);
  });

  it("assigns no lead when the engine cannot coordinate bots", () => {
    expect(run(crew(), { leadershipError: "no" })).toEqual({ renames: [[legacy, "Solo Business"]], leads: [] });
  });

  // 1.0.1 data: the owner made the package's intended lead their Individual
  // Assistant before upgrading. That choice stays; nobody is promoted.
  it("keeps an Individual Assistant the owner chose, and appoints no lead over it", () => {
    expect(run(crew([{ individual: true }, {}]))).toEqual({ renames: [[legacy, "Solo Business"]], leads: [] });
    expect(run(crew([{}, { individual: true }]))).toEqual({ renames: [[legacy, "Solo Business"]], leads: [] });
  });

  it("finishes at the next start when it stopped part way", () => {
    // the lead was appointed, then the start stopped before the rename
    expect(run(crew([{ chiefOfStaff: true }, {}]))).toEqual({ renames: [[legacy, "Solo Business"]], leads: [] });
    // the lead could not be appointed: the legacy name stays, so the next start tries again
    expect(run(crew(), { leadFails: true })).toEqual({ renames: [], leads: [] });
    // the rename could not finish: the lead stands and the rename is tried again
    expect(run(crew(), { renameFails: true })).toEqual({ renames: [], leads: ["planner"] });
  });
});
