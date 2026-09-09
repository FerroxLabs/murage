import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBotPackageExportBundle } from "./package-export-bundle.ts";
import { createBotPackageExport } from "./package-export.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";
import { importBotPackageArchive, previewBotPackageImport } from "./bot-package-import.ts";
import { commitPackageImportFiles } from "./package-import-transaction.ts";
import type { BotRecord } from "./store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bots: BotRecord[] = ["chief", "leader", "member", "individual"].map(role => ({
  id: role, threadId: `private-${role}`, name: role, title: role, description: `Instructions for ${role}`, color: "green",
  notifications: false, unread: false, createdAt: 1, modelSelection: { instanceId: "private-engine", model: "private-model" }, resumeCursors: {},
  chiefOfStaff: role === "chief" || role === "leader", ...(role === "chief" ? { chiefScope: "workspace" as const } : {}),
  individual: role === "individual", section: role === "chief" ? "Office" : "Research", autoApprove: true,
  playbooks: [{ key: "review", name: "Review", summary: "Review evidence", triggers: ["review"], instructions: "Verify source evidence." }],
}));
const input = { name: "Role crew", bots, groups: [{ id: "private-room", threadId: "private-room-thread", name: "Review room", section: "Research", memberIds: ["leader", "member"], defaultResponder: { kind: "member" as const, botId: "leader" }, bulletin: "Review together.", unread: false, createdAt: 1 }],
  routines: [{ id: "daily", name: "Daily", botId: "member", target: "bot" as const, prompt: "Review notes", runOn: "ember" as const, enabled: true, schedule: { type: "daily" as const, time: "09:00", weekdays: [1] }, durationMinutes: 15, nextRunAt: 1, createdAt: 1, updatedAt: 1 }],
};

it("round-trips exact intended roles, team relationships, chosen assets and inert runtime state through a real ZIP and durable import", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-export-roundtrip-")); roots.push(root);
  const bundle = createBotPackageExportBundle({ exportInput: { ...input, selection: { botIds: bots.map(bot => bot.id), playbookKeys: ["review"], routineIds: ["daily"] } }, skills: [{
    botId: "member", key: "research", name: "Research", license: "MIT", dependencies: [], payloads: new Map([["skills/research/SKILL.md", Buffer.from("---\nname: research\ndescription: Research notes\nlicense: MIT\n---\nRead supplied evidence.\n")]]),
  }] });
  const archivePath = join(root, "crew.zip"); await writeBotPackageArchive(archivePath, bundle);
  const original = readFileSync(archivePath);
  const intake = await readBotPackageArchive(archivePath);
  const selection = { agents: intake.manifest.definition.package.agents.map(agent => agent.key), skills: ["research"], instructions: [], routines: ["daily"] };
  const preview = await previewBotPackageImport(archivePath, { selection });
  expect(preview.summary).toMatchObject({ rooms: 1, importedChiefRole: false, roles: bots.map(bot => ({ key: bot.id, intendedRole: bot.id, team: bot.section })) });
  await importBotPackageArchive({ archivePath, dataDir: root, selection, existingBots: [], modelSelection: { instanceId: "fixture", model: "fixture" }, expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
    atomicCommit: ({ prepared }) => {
      const replacements = new Map([["bots.json", Buffer.from(JSON.stringify(prepared.bots))], ["groups.json", Buffer.from(JSON.stringify(prepared.groups))], ["routines.json", Buffer.from(JSON.stringify(prepared.routines))], ...prepared.files.map(file => [file.path, file.content] as [string, Buffer])]);
      commitPackageImportFiles(root, replacements, new Map([...replacements.keys()].map(path => [path, null])), { allowedNewBotIds: prepared.bots.map(bot => bot.id), assertOwned: () => {} });
    },
  });
  const imported = JSON.parse(readFileSync(join(root, "bots.json"), "utf8")) as BotRecord[];
  expect(imported.map(bot => bot.installedPackage?.sourceRole)).toEqual(["chief", "leader", "member", "individual"]);
  expect(imported.map(bot => bot.installedPackage?.sourceTeam)).toEqual(bots.map(bot => bot.section));
  expect(imported.every(bot => !bot.chiefOfStaff && !bot.chiefScope && !bot.individual && !bot.autoApprove && !bot.browser && bot.composio === false)).toBe(true);
  expect(imported.every(bot => !bots.some(original => original.id === bot.id || original.threadId === bot.threadId))).toBe(true);
  expect(imported.map(bot => bot.description)).toEqual(bots.map(bot => bot.description));
  expect(imported.every(bot => bot.playbooks?.[0].instructions === "Verify source evidence.")).toBe(true);
  expect(imported[1].section).toBe(imported[2].section);
  expect(imported[1].section).not.toBe("Research");
  const rooms = JSON.parse(readFileSync(join(root, "groups.json"), "utf8"));
  expect(rooms).toMatchObject([{ memberIds: [imported[1].id, imported[2].id], defaultResponder: { kind: "member", botId: imported[1].id }, bulletin: "Review together.", section: imported[1].section }]);
  expect(JSON.parse(readFileSync(join(root, "routines.json"), "utf8"))).toMatchObject([{ botId: imported[2].id, enabled: false, nextRunAt: null }]);
  expect(JSON.parse(readFileSync(join(root, "skill-state", imported[2].id, "skills.json"), "utf8")).research.enabled).toBe(false);
  expect(readFileSync(archivePath)).toEqual(original);
});

it("single and partial Markdown exports never infer Chief and omit unselected room responders", () => {
  for (const selected of [["individual"], ["member"], ["leader", "member"]]) {
    const document = createBotPackageExport({ ...input, selection: { botIds: selected, playbookKeys: [], routineIds: [] } });
    const markdown = renderBotPackageMarkdown(document);
    expect(markdown).not.toContain("You are the Chief of Staff");
    expect(markdown).toContain("No Chief of Staff is included");
    expect(parseBotPackage(markdown).package).toEqual(document.package);
    expect(document.package.agents.map(agent => agent.role)).toEqual(selected);
    if (selected.length === 1 && selected[0] === "member") expect(document.package.rooms).toMatchObject([{ members: ["member"], defaultResponder: { kind: "mentions" } }]);
  }
});
