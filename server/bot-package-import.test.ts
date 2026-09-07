import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { createBotPackageEntry } from "./bot-package-manifest.ts";
import { importBotPackageArchive, importBotPackageContents, previewBotPackageContents, previewBotPackageImport, type BotPackageAtomicCommitInput } from "./bot-package-import.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  const oversized = await fixture("x".repeat(4001));
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
