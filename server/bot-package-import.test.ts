import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { createBotPackageEntry } from "./bot-package-manifest.ts";
import { importBotPackageArchive, importBotPackageContents, previewBotPackageContents, previewBotPackageImport, type BotPackageAtomicCommitInput } from "./bot-package-import.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { RoutineManager } from "./routines.ts";
import { applyRoutinePermissionMode, botPermissionMode, effectiveRoutinePermissionMode } from "./routine-permissions.ts";
import { autoVerdict } from "./auto-approve.ts";
import { writeFileSync } from "node:fs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

// MAIN RULING 2026-11-13 wipe-only: importing no choice cannot invent an explicit lower ceiling.
it("imported routine inherits No limits after enable and reload while an owner-selected Ask survives", async () => {
  const f = await fixture();
  const profile = { autoApprove: false, fullAccess: false, noLimits: false };
  const file = join(f.root, "routines.json");
  const options = { file, botMode: () => botPermissionMode(profile), botState: () => "ready" as const,
    createTask: () => { throw new Error("No scheduled turn in this fixture"); },
    startTurn: async () => { throw new Error("No scheduled turn in this fixture"); } };
  let manager = new RoutineManager(options);
  await importBotPackageArchive({ ...f.options, atomicCommit: ({ prepared }) => {
    const batch = manager.preparePackageAddition(prepared.routines);
    writeFileSync(file, batch.bytes);
    batch.publish();
  } });
  const imported = manager.listRoutines()[0]!;
  expect(imported).toMatchObject({ enabled: false, permissionMode: "ask", nextRunAt: null });
  expect(effectiveRoutinePermissionMode(imported, profile)).toBe("ask");
  manager.update(imported.id, { enabled: true });
  Object.assign(profile, { autoApprove: true, fullAccess: true, noLimits: true });
  manager = new RoutineManager(options);
  const inherited = manager.listRoutines()[0]!;
  expect(inherited.enabled).toBe(true);
  expect(inherited.permissionExplicit).not.toBe(true);
  const mode = effectiveRoutinePermissionMode(inherited, profile);
  expect(mode).toBe("unlimited");
  expect(autoVerdict(applyRoutinePermissionMode(profile, mode), "Bash", "echo routine", { automated: true, routineLevel: true }))
    .toMatchObject({ source: "no-limits", approve: expect.any(String) });
  manager.update(imported.id, { permissionMode: "ask" });
  const explicit = new RoutineManager(options).listRoutines()[0]!;
  expect(explicit.permissionExplicit).toBe(true);
  expect(effectiveRoutinePermissionMode(explicit, profile)).toBe("ask");
  expect(autoVerdict(applyRoutinePermissionMode(profile, "ask"), "Bash", "echo routine", { automated: true, routineLevel: true }))
    .toMatchObject({ approve: null, source: "no-grant" });
});
// Both install-time No limits and a later owner level change use the same
// inherited record. No package-supplied grant or origin is installed.
it.each([false, true])("package routine inherits on first enable and reload (No limits at import: %s)", async atImport => {
  const f = await fixture();
  const profile = { autoApprove: atImport, fullAccess: atImport, noLimits: atImport };
  const file = join(f.root, "routines.json");
  const options = { file, botMode: () => botPermissionMode(profile), botState: () => "ready" as const,
    createTask: () => { throw new Error("No scheduled turn in this fixture"); },
    startTurn: async () => { throw new Error("No scheduled turn in this fixture"); } };
  let manager = new RoutineManager(options);
  await importBotPackageArchive({ ...f.options, atomicCommit: ({ prepared }) => {
    const batch = manager.preparePackageAddition(prepared.routines);
    writeFileSync(file, batch.bytes); batch.publish();
  } });
  const id = manager.listRoutines()[0]!.id;
  expect(manager.listRoutines()[0]).toMatchObject({ enabled: false, nextRunAt: null });
  Object.assign(profile, { autoApprove: true, fullAccess: true, noLimits: true });
  manager.update(id, { enabled: true });
  for (const reload of [false, true]) {
    if (reload) manager = new RoutineManager(options);
    const routine = manager.listRoutines()[0]!;
    expect(routine.permissionExplicit).not.toBe(true);
    const mode = effectiveRoutinePermissionMode(routine, profile);
    expect(mode).toBe("unlimited");
    const actor = applyRoutinePermissionMode(profile, mode);
    expect(autoVerdict(actor, "Bash", "echo routine", { automated: true, routineLevel: true }))
      .toMatchObject({ source: "no-limits", approve: expect.any(String) });
    expect(autoVerdict(actor, "Bash", "rm -rf ~", { automated: true, routineLevel: true, commandText: "rm -rf ~" }).approve).toBeNull();
    // An imported routine cannot turn another person's request into owner work.
    for (const noLimitsOrigin of ["guest", "other-human", "unproven"] as const) {
      expect(autoVerdict(actor, "Bash", "echo routine", { automated: true, routineLevel: true, noLimitsOrigin }).approve).toBeNull();
    }
    expect(autoVerdict(actor, "Bash", "echo routine", { automated: true, routineLevel: true, fullAccessOrigin: "other" }).approve).toBeNull();
  }
  manager.update(id, { permissionMode: "ask" });
  const explicit = new RoutineManager(options).listRoutines()[0]!;
  expect(explicit.permissionExplicit).toBe(true);
  expect(effectiveRoutinePermissionMode(explicit, profile)).toBe("ask");
});

it("package routine imported into an Ask home gains no No limits on enable or reload", async () => {
  const f = await fixture();
  const profile = { autoApprove: false, fullAccess: false, noLimits: false };
  const file = join(f.root, "routines.json");
  const options = { file, botMode: () => botPermissionMode(profile), botState: () => "ready" as const,
    createTask: () => { throw new Error("No scheduled turn in this fixture"); },
    startTurn: async () => { throw new Error("No scheduled turn in this fixture"); } };
  let manager = new RoutineManager(options);
  await importBotPackageArchive({ ...f.options, atomicCommit: ({ prepared }) => {
    const batch = manager.preparePackageAddition(prepared.routines);
    writeFileSync(file, batch.bytes); batch.publish();
  } });
  manager.update(manager.listRoutines()[0]!.id, { enabled: true });
  for (const reload of [false, true]) {
    if (reload) manager = new RoutineManager(options);
    const mode = effectiveRoutinePermissionMode(manager.listRoutines()[0]!, profile);
    expect(mode).toBe("ask");
    expect(autoVerdict(applyRoutinePermissionMode(profile, mode), "Bash", "echo routine", { automated: true, routineLevel: true }))
      .toMatchObject({ source: "no-grant", approve: null });
  }
});

async function fixture(instructions = "Use evidence and report uncertainty.") {
  const root = mkdtempSync(join(tmpdir(), "murage-package-import-")); roots.push(root);
  const payloads = new Map([
    ["bots/scout/SOUL.md", instructions],
    ["skills/research/SKILL.md", "---\nname: research\ndescription: Find cited evidence.\nlicense: MIT\n---\nRead selected sources.\n"],
  ]);
  const manifest = {
    format: "murage.package.bundle", version: 1,
    definition: { format: "murage.package", version: 1, package: {
      id: "sample", release: "1.0.0", name: "Sample", tagline: "Sample team", summary: "Definition only", category: "Community",
      author: { name: "Example" }, license: "MIT", outcomes: ["Research"], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
      chiefOfStaff: "scout",
      agents: [{ key: "scout", name: "Scout", appearance: { color: "green" }, skills: ["research"] }],
      routines: [{ key: "daily", name: "Daily", agent: "scout", prompt: "Research", runOn: "ember", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 15, enabledAfterInstall: false }],
    } },
    skills: [{ key: "research", name: "Research", license: "MIT", dependencies: [], files: ["skills/research/SKILL.md"] }],
    instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }],
    entries: [...payloads].map(([path, content]) => createBotPackageEntry(path, content)),
  };
  const archivePath = join(root, "bundle.zip");
  const zip = new ZipFile();
  const written = pipeline(zip.outputStream as Readable, createWriteStream(archivePath));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false, mode: 0o100600 });
  for (const [path, content] of payloads) zip.addBuffer(Buffer.from(content), path, { compress: false, mode: 0o100600 });
  zip.end(); await written;
  const selection = { agents: ["scout"], skills: ["research"], routines: ["daily"], instructions: ["scout"] };
  const preview = await previewBotPackageImport(archivePath, { selection });
  const options = {
    archivePath, dataDir: root, selection,
    expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
    existingBots: [{ id: "existing-chief", threadId: "existing-thread", name: "Scout" }],
    modelSelection: { instanceId: "fixture", model: "fixture" },
  };
  return { root, manifest, payloads, preview, options };
}

it("routes in-memory contents through the same inert preparation, staging and atomic callback", async () => {
  const f = await fixture();
  const contents = { manifest: f.manifest, payloads: new Map([...f.payloads].map(([path, content]) => [path, Buffer.from(content)])) };
  const preview = await previewBotPackageContents(contents, { selection: f.options.selection, existingBots: f.options.existingBots });
  const reordered = await previewBotPackageContents({ manifest: Object.fromEntries(Object.entries(f.manifest).reverse()), payloads: new Map([...contents.payloads].reverse()) }, { selection: f.options.selection, existingBots: f.options.existingBots });
  expect(preview).toEqual(reordered);
  expect(preview.archiveSha256).not.toBe(f.preview.archiveSha256);
  expect(preview.selectionHash).toBe(f.preview.selectionHash);
  let preparedImport: BotPackageAtomicCommitInput["prepared"] | undefined;
  const atomicCommit = vi.fn(({ prepared, stagingDirectory }: BotPackageAtomicCommitInput) => {
    preparedImport = prepared;
    expect(prepared.bots[0]).toMatchObject({ name: "Scout 2", chiefOfStaff: false, computer: "off", autoApprove: false, browser: false });
    expect(prepared.routines[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(prepared.routines[0], "S9 imported routines inherit the owner level").not.toHaveProperty("permissionMode");
    expect(prepared.routines[0]).not.toHaveProperty("permissionExplicit");
    expect(JSON.parse(readFileSync(join(stagingDirectory, "skill-state", prepared.bots[0].id, "skills.json"), "utf8")).research.enabled).toBe(false);
    expect(prepared.baseline).toBeTruthy();
  });
  const imported = await importBotPackageContents({ ...f.options, contents, expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash, atomicCommit });
  expect(atomicCommit).toHaveBeenCalledTimes(1);
  expect(imported.bots).toEqual(preparedImport!.bots);
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("refuses malformed contents, unknown payloads, changed bytes and stale review hashes before commit", async () => {
  const f = await fixture();
  const contents = { manifest: f.manifest, payloads: new Map([...f.payloads].map(([path, content]) => [path, Buffer.from(content)])) };
  const preview = await previewBotPackageContents(contents, { selection: f.options.selection });
  const atomicCommit = vi.fn();
  const options = { ...f.options, contents, expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash, atomicCommit };
  await expect(importBotPackageContents({ ...options, contents: { ...contents, manifest: { ...f.manifest, version: 99 } } })).rejects.toThrow();
  await expect(importBotPackageContents({ ...options, contents: { ...contents, payloads: new Map([...contents.payloads, ["unknown", Buffer.from("x")]]) } })).rejects.toMatchObject({ code: "PACKAGE_CONTENT_ENTRY_MISMATCH" });
  const changed = new Map(contents.payloads); changed.set("bots/scout/SOUL.md", Buffer.alloc(changed.get("bots/scout/SOUL.md")!.length, 120));
  await expect(importBotPackageContents({ ...options, contents: { ...contents, payloads: changed } })).rejects.toMatchObject({ code: "PACKAGE_CONTENT_HASH_MISMATCH" });
  await expect(importBotPackageContents({ ...options, expectedReviewHash: "0".repeat(64) })).rejects.toMatchObject({ code: "PACKAGE_REVIEW_CHANGED" });
  expect(atomicCommit).not.toHaveBeenCalled();
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("does not grant in-memory starter contents any content-scan exemption", async () => {
  const token = "sk-" + "FixtureNotARealCredential".repeat(2);
  const f = await fixture("Private credential " + token);
  const contents = { manifest: f.manifest, payloads: new Map([...f.payloads].map(([path, content]) => [path, Buffer.from(content)])) };
  const preview = await previewBotPackageContents(contents, { selection: f.options.selection });
  expect(preview.scan.blocked).toBe(true);
  expect(JSON.stringify(preview)).not.toContain(token);
  const atomicCommit = vi.fn();
  await expect(importBotPackageContents({ ...f.options, contents, expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash, acknowledgeWarnings: true, atomicCommit })).rejects.toMatchObject({ code: "PACKAGE_CONTENT_BLOCKED" });
  expect(atomicCommit).not.toHaveBeenCalled();
});

it("stages fresh inert identities, disabled skills and paused routines for the real atomic callback", async () => {
  const f = await fixture();
  const existing = structuredClone(f.options.existingBots);
  let staged: string | undefined;
  const atomicCommit = vi.fn(({ prepared, stagingDirectory }: BotPackageAtomicCommitInput) => {
    staged = stagingDirectory;
    const bot = prepared.bots[0]!;
    expect(bot.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(bot.id).not.toBe("existing-chief");
    expect(bot.threadId).not.toBe("existing-thread");
    expect(bot).toMatchObject({ name: "Scout 2", description: "Use evidence and report uncertainty.", composio: false, browser: false, computer: "off", autoApprove: false, chiefOfStaff: false });
    expect(bot.cwd).toBeUndefined();
    expect(bot.alwaysAllow).toBeUndefined();
    expect(prepared.routines[0]).toMatchObject({ botId: bot.id, enabled: false, nextRunAt: null });
    const skillState = JSON.parse(readFileSync(join(stagingDirectory, "skill-state", bot.id, "skills.json"), "utf8"));
    expect(skillState.research.enabled).toBe(false);
    expect(readFileSync(join(stagingDirectory, "workspaces", bot.id, "SOUL.md"), "utf8")).toBe(bot.description);
    expect(readFileSync(join(stagingDirectory, "workspaces", bot.id, "skills", "research", "SKILL.md"), "utf8")).toBe(f.payloads.get("skills/research/SKILL.md"));
    expect(readdirSync(join(stagingDirectory, "workspaces", bot.id)).sort()).toEqual(["SOUL.md", "skills"]);
  });
  const imported = await importBotPackageArchive({ ...f.options, atomicCommit });
  expect(atomicCommit).toHaveBeenCalledTimes(1);
  expect(imported.bots).toHaveLength(1);
  expect(f.options.existingBots).toEqual(existing);
  expect(existsSync(staged!)).toBe(false);
  // Callback was a fixture: no claim that records were integrated into Store.
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("refuses stale archive/review hashes and changed selection before invoking commit", async () => {
  const f = await fixture();
  const atomicCommit = vi.fn();
  for (const changed of [
    { expectedArchiveSha256: "0".repeat(64) },
    { expectedReviewHash: "0".repeat(64) },
    { selection: { ...f.options.selection, routines: [] } },
  ]) {
    await expect(importBotPackageArchive({ ...f.options, ...changed, atomicCommit })).rejects.toMatchObject({ code: "PACKAGE_REVIEW_CHANGED" });
  }
  expect(atomicCommit).not.toHaveBeenCalled();
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("blocks embedded credentials even after warnings are acknowledged", async () => {
  const token = "sk-" + "FixtureNotARealCredential".repeat(2);
  const f = await fixture("API key example " + token);
  expect(f.preview.scan.blocked).toBe(true);
  expect(JSON.stringify(f.preview)).not.toContain(token);
  const atomicCommit = vi.fn();
  await expect(importBotPackageArchive({ ...f.options, acknowledgeWarnings: true, atomicCommit })).rejects.toMatchObject({ code: "PACKAGE_CONTENT_BLOCKED" });
  expect(atomicCommit).not.toHaveBeenCalled();
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("requires explicit ambiguous-content review and refuses oversized SOUL without truncating", async () => {
  const warning = await fixture("Example path /Users/fixture/source");
  const atomicCommit = vi.fn();
  await expect(importBotPackageArchive({ ...warning.options, atomicCommit })).rejects.toMatchObject({ code: "PACKAGE_REVIEW_REQUIRED" });
  expect(atomicCommit).not.toHaveBeenCalled();
  await importBotPackageArchive({ ...warning.options, acknowledgeWarnings: true, atomicCommit });
  expect(atomicCommit).toHaveBeenCalledTimes(1);
  // Plain words: a long unbroken run of one letter now earns a look from the import guard first.
  const oversized = await fixture("Plain words for the bot. ".repeat(161));
  atomicCommit.mockClear();
  await expect(importBotPackageArchive({ ...oversized.options, atomicCommit })).rejects.toMatchObject({ code: "SOUL_INSTRUCTIONS_EXCEED_PROFILE_LIMIT" });
  expect(atomicCommit).not.toHaveBeenCalled();
});

it("removes all private staging when atomic commit fails, preserving the input archive", async () => {
  const f = await fixture();
  const original = readFileSync(f.options.archivePath);
  let staged: string | undefined;
  await expect(importBotPackageArchive({ ...f.options, atomicCommit: ({ stagingDirectory }) => {
    staged = stagingDirectory;
    expect(readdirSync(stagingDirectory)).toEqual(["skill-state", "workspaces"]);
    throw new Error("injected atomic commit failure");
  } })).rejects.toThrow("injected atomic commit failure");
  expect(existsSync(staged!)).toBe(false);
  expect(readFileSync(f.options.archivePath)).toEqual(original);
  expect(readdirSync(f.root)).toEqual(["bundle.zip"]);
});

it("package imports refuse project desks and every project table", async () => {
  const f = await fixture();
  const { PROJECT_TABLE_NAMES } = await import("./project-tables.ts");
  const payloads = new Map([...f.payloads].map(([path, content]) => [path, Buffer.from(content)]));
  for (const field of ["channelProjectDesk", ...PROJECT_TABLE_NAMES]) {
    const manifest = structuredClone(f.manifest) as any;
    manifest.definition.package.agents[0][field] = [{ group_id: "foreign" }];
    await expect(previewBotPackageContents({ manifest, payloads }, { selection: f.options.selection })).rejects.toThrow("Unsupported package definition field");
  }
});

it("team member imports ignore project desk and table fields", async () => {
  const { importedMemberProfile } = await import("./team-manifest.ts");
  const { PROJECT_TABLE_NAMES } = await import("./project-tables.ts");
  const member = { key: "one", name: "One", appearance: { color: "green" }, channelProjectDesk: { groupId: "foreign" }, ...Object.fromEntries(PROJECT_TABLE_NAMES.map(table => [table, [{ group_id: "foreign" }]])) };
  const profile = importedMemberProfile(member as never, new Set());
  expect(profile).toEqual({ name: "One", title: undefined, description: undefined, color: "green" });
});

it("bot email (section 7): emailIntent was-on is kept as an offer only; email starts off and no address travels", async () => {
  const f = await fixture();
  const manifest = structuredClone(f.manifest) as typeof f.manifest;
  (manifest.definition.package.agents[0] as Record<string, unknown>).emailIntent = "was-on";
  const contents = { manifest, payloads: new Map([...f.payloads].map(([path, content]) => [path, Buffer.from(content)])) };
  const preview = await previewBotPackageContents(contents, { selection: f.options.selection, existingBots: f.options.existingBots });
  let bot: BotPackageAtomicCommitInput["prepared"]["bots"][number] | undefined;
  await importBotPackageContents({ ...f.options, contents, expectedArchiveSha256: preview.archiveSha256, expectedReviewHash: preview.reviewHash,
    atomicCommit: ({ prepared }: BotPackageAtomicCommitInput) => { bot = prepared.bots[0]; } });
  expect(bot?.installedPackage?.emailIntent).toBe("was-on");
  expect(JSON.stringify(bot)).not.toMatch(/@murage\.email|emailKey|inbox/);
  // without the field nothing is recorded
  const plain = await previewBotPackageContents({ manifest: f.manifest, payloads: contents.payloads }, { selection: f.options.selection, existingBots: f.options.existingBots });
  let plainBot: typeof bot;
  await importBotPackageContents({ ...f.options, contents: { manifest: f.manifest, payloads: contents.payloads }, expectedArchiveSha256: plain.archiveSha256, expectedReviewHash: plain.reviewHash,
    atomicCommit: ({ prepared }: BotPackageAtomicCommitInput) => { plainBot = prepared.bots[0]; } });
  expect(plainBot?.installedPackage && "emailIntent" in plainBot.installedPackage).toBe(false);
});

// A live routine-level projection supplies the legacy routine provenance only
// when no stored origin contradicts it. Raw level flags alone prove nothing.
it("legacy routine-level context inherits No limits without a duplicate stored origin", () => {
  const actor = applyRoutinePermissionMode({ autoApprove: true, fullAccess: true, noLimits: true }, "unlimited");
  expect(autoVerdict(actor, "Bash", "echo routine", { automated: true, routineLevel: true }))
    .toMatchObject({ source: "no-limits", approve: expect.any(String) });
  for (const context of [
    {}, { automated: true }, { routineLevel: true, unattended: true },
    { routineLevel: true, channelOwner: true },
    { routineLevel: true, fullAccessOrigin: "other" as const },
    { routineLevel: true, noLimitsOrigin: "guest" as const },
    { routineLevel: true, noLimitsOrigin: "unproven" as const },
  ]) expect(autoVerdict(actor, "Bash", "echo routine", context).approve).toBeNull();
});
