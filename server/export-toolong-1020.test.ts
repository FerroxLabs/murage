import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOT_DESCRIPTION_PORTABLE_MAX, BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import { ROUTINE_INSTRUCTIONS_MAX } from "../shared/routine-instructions.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";
import { importBotPackageArchive, previewBotPackageImport } from "./bot-package-import.ts";
import { createBotPackageExportBundle } from "./package-export-bundle.ts";
import { createBotPackageExport, getBotPackageExportSelectionCandidates } from "./package-export.ts";
import { commitPackageImportFiles } from "./package-import-transaction.ts";
import type { BotRecord } from "./store.ts";
import { createTeamManifest, parseTeamManifest } from "./team-manifest.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// 1.0.20 (reported on 1.0.19): exporting ONE selected bot (the Chief of Staff)
// as a ZIP failed with "package.agents.2.description is too long". The options
// step validated every bot in the workspace, and the package capped a
// description at 4000 characters while a Chief creates bots with up to 8000 and
// older bots were never capped.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

const bot = (id: string, name: string, description: string, extra: Partial<BotRecord> = {}): BotRecord => ({
  id, threadId: `thread-${id}`, name, title: "Specialist", description, color: "green", notifications: false, unread: false, createdAt: 1,
  modelSelection: { instanceId: "fixture-engine", model: "fixture-model" }, resumeCursors: {}, section: "Office", ...extra,
});
const words = (length: number, seed: string) => `${seed.repeat(Math.ceil(length / seed.length)).slice(0, length - 1)}.`;

// The reported shape: Sable (Chief of Staff) is selected; three teammates share
// her team and a room, and the third bot in the workspace has a long brief.
const chief = bot("sable", "Sable", "Run the office and route the work.", { chiefOfStaff: true, chiefScope: "workspace" });
const teammates = [bot("ash", "Ash", "Draft replies."), bot("birch", "Birch", words(9_000, "Long brief ")), bot("cedar", "Cedar", "Keep the calendar.")];
const seanInput = {
  name: "Office", bots: [chief, ...teammates], routines: [],
  groups: [{ id: "room-1", threadId: "room-1-thread", name: "Office room", section: "Office", memberIds: ["sable", "ash", "birch", "cedar"],
    defaultResponder: { kind: "member" as const, botId: "sable" }, bulletin: "Work here.", unread: false, createdAt: 1 }],
};

async function zipRoundTrip(exportInput: Parameters<typeof createBotPackageExportBundle>[0]["exportInput"]) {
  const root = mkdtempSync(join(tmpdir(), "murage-export-toolong-")); roots.push(root);
  const bundle = createBotPackageExportBundle({ exportInput, skills: [] });
  const archivePath = join(root, "package.zip");
  await writeBotPackageArchive(archivePath, bundle);
  const intake = await readBotPackageArchive(archivePath);
  const selection = { agents: intake.manifest.definition.package.agents.map(agent => agent.key), skills: [], instructions: [], routines: (intake.manifest.definition.package.routines ?? []).map(routine => routine.key) };
  const preview = await previewBotPackageImport(archivePath, { selection });
  expect(preview.scan.findings.map(finding => `${finding.rule} ${finding.path} ${"field" in finding ? finding.field : ""}`)).toEqual([]);
  await importBotPackageArchive({ archivePath, dataDir: root, selection, existingBots: [], modelSelection: { instanceId: "fixture", model: "fixture" },
    expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
    atomicCommit: ({ prepared }) => {
      const replacements = new Map([["bots.json", Buffer.from(JSON.stringify(prepared.bots))], ["groups.json", Buffer.from(JSON.stringify(prepared.groups))], ["routines.json", Buffer.from(JSON.stringify(prepared.routines))], ...prepared.files.map(file => [file.path, file.content] as [string, Buffer])]);
      commitPackageImportFiles(root, replacements, new Map([...replacements.keys()].map(path => [path, null])), { allowedNewBotIds: prepared.bots.map(item => item.id), assertOwned: () => {} });
    },
  });
  const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));
  return { bots: read("bots.json") as BotRecord[], groups: read("groups.json"), routines: read("routines.json") };
}

describe("1.0.20 export: long fields leave and come back whole", () => {
  it("Sean's shape: one selected Chief exports as a ZIP while an unselected teammate has a 9000-character brief", async () => {
    expect(getBotPackageExportSelectionCandidates(seanInput).bots).toHaveLength(4);
    const imported = await zipRoundTrip({ ...seanInput, selection: { botIds: ["sable"], playbookKeys: [], routineIds: [] } });
    expect(imported.bots.map(item => [item.name, item.description])).toEqual([["Sable", chief.description]]);
  });

  it("a selected bot with a 20,000-character description round-trips through ZIP, Markdown and the team file, unchanged", async () => {
    const description = words(20_000, "Standing instruction ");
    const input = { ...seanInput, bots: [{ ...chief, description }, ...teammates] };
    const imported = await zipRoundTrip({ ...input, selection: { botIds: ["sable", "birch"], playbookKeys: [], routineIds: [] } });
    expect(imported.bots.map(item => item.description)).toEqual([description, teammates[1].description]);
    const document = createBotPackageExport({ ...input, selection: { botIds: ["sable"], playbookKeys: [], routineIds: [] } });
    expect(parseBotPackage(renderBotPackageMarkdown(document)).package.agents[0].description).toBe(description);
    const team = createTeamManifest({ name: "Office", memberIds: ["sable"] }, input.bots);
    expect(parseTeamManifest(JSON.parse(JSON.stringify(team))).team.members[0].description).toBe(description);
  });

  it("every field at the app maximum round-trips through ZIP with nothing lost", async () => {
    const full = bot("full", words(BOT_PROFILE_LIMITS.name, "Northwind office lead "), words(BOT_DESCRIPTION_PORTABLE_MAX, "Answer the morning mail and file each receipt. "), {
      title: words(BOT_PROFILE_LIMITS.title, "Operations and finance coordinator "), section: words(60, "Front office team "),
    });
    const prompt = words(ROUTINE_INSTRUCTIONS_MAX, "Read new mail, sort it by sender and summarise it. ");
    const input = {
      name: "Full", bots: [full],
      groups: [{ id: "room-full", threadId: "room-full-thread", name: words(100, "Weekly planning room "), section: words(60, "Front office team "), memberIds: ["full"],
        defaultResponder: { kind: "member" as const, botId: "full" }, bulletin: words(12_000, "Post the week's priorities here before Monday. "), unread: false, createdAt: 1 }],
      routines: [{ id: "long", name: words(80, "Morning mail sweep "), botId: "full", target: "bot" as const, prompt, runOn: "ember" as const, enabled: true,
        schedule: { type: "daily" as const, time: "09:00", weekdays: [1] }, durationMinutes: 15, nextRunAt: 1, createdAt: 1, updatedAt: 1 }],
    };
    const imported = await zipRoundTrip({ ...input, selection: { botIds: ["full"], playbookKeys: [], routineIds: ["long"] } });
    expect(imported.bots[0]).toMatchObject({ name: full.name, title: full.title, description: full.description });
    expect(imported.groups[0]).toMatchObject({ name: input.groups[0].name, bulletin: input.groups[0].bulletin });
    expect(imported.routines[0].prompt).toBe(prompt);
  });

  it("a field no package can carry is refused in plain words naming the bot and field, never a schema path", () => {
    const tooLong = { ...seanInput, bots: [{ ...chief, description: "x".repeat(BOT_DESCRIPTION_PORTABLE_MAX + 1) }, ...teammates] };
    expect(getBotPackageExportSelectionCandidates(tooLong).bots).toHaveLength(4);
    const run = () => createBotPackageExport({ ...tooLong, selection: { botIds: ["sable"], playbookKeys: [], routineIds: [] } });
    expect(run).toThrow('Bot "Sable" can\'t be exported: its description (its instructions) is too long. Shorten the description (its instructions) and export again, or leave this bot out of the selection. Nothing was exported.');
    expect(run).not.toThrow(/package\.|agents\.\d/);
    // and an unselected bot's field never blocks the selected one
    expect(createBotPackageExport({ ...tooLong, selection: { botIds: ["ash"], playbookKeys: [], routineIds: [] } }).package.agents.map(agent => agent.name)).toEqual(["Ash"]);
  });
});
