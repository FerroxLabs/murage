// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Saved prompt blocks and reference packs: versions, scope isolation, pinned
// images; render records; model checks and availability.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import {
  IMAGE_REFERENCE_PACK_DIR, ImageLibraryError, applyImageAvailability, deletePromptBlock, deleteReferencePack, getPromptBlock, imageProbes, listPromptBlocksForBot,
  listPromptBlocksForOwner, listReferencePacksForBot, listReferencePacksForOwner, parseLibraryRef, recordImageProbe, recordRenderPrompt, renderPrompt, resolvePromptBlocks,
  resolveReferencePack, savePromptBlock, saveReferencePack, scheduledProbeDue,
} from "./image-library.ts";
import type { ImageReference } from "./image-generation.ts";

const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const ref = (bytes: Buffer): ImageReference => ({ bytes, mime: "image/png" });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
const bot = (botId: string) => ({ kind: "bot" as const, botId });

describe("prompt blocks", () => {
  it("versions every change and returns the same version for identical text", () => {
    const first = savePromptBlock(db, { scope: "bot", botId: "a", name: "brand-lock", text: "Identity v1", createdBy: "bot:a" });
    expect(first).toMatchObject({ name: "brand-lock", version: 1, chars: 11, created: true });
    expect(savePromptBlock(db, { scope: "bot", botId: "a", name: "brand-lock", text: "  Identity v1  ", createdBy: "bot:a" })).toMatchObject({ version: 1, created: false, id: first.id });
    expect(savePromptBlock(db, { scope: "bot", botId: "a", name: "brand-lock", text: "Identity v2", createdBy: "bot:a" })).toMatchObject({ version: 2, created: true });
    expect(getPromptBlock(db, bot("a"), "brand-lock")).toMatchObject({ version: 2, text: "Identity v2" });
    expect(getPromptBlock(db, bot("a"), "brand-lock@1")).toMatchObject({ version: 1, text: "Identity v1" });
    expect(() => getPromptBlock(db, bot("a"), "brand-lock@9")).toThrow("has no version 9. Its latest is v2.");
  });

  it("keeps each bot's blocks its own, reads the workspace's, and puts its own first", () => {
    savePromptBlock(db, { scope: "bot", botId: "a", name: "lock", text: "A's lock", createdBy: "bot:a" });
    savePromptBlock(db, { scope: "bot", botId: "b", name: "private", text: "B only", createdBy: "bot:b" });
    savePromptBlock(db, { scope: "workspace", name: "lock", text: "Workspace lock", createdBy: "owner" });
    savePromptBlock(db, { scope: "workspace", name: "house-style", text: "House style", createdBy: "owner" });
    expect(getPromptBlock(db, bot("a"), "lock").text).toBe("A's lock");
    expect(getPromptBlock(db, bot("b"), "lock").text).toBe("Workspace lock");
    expect(() => getPromptBlock(db, bot("a"), "private")).toThrow(ImageLibraryError);
    expect(listPromptBlocksForBot(db, "a").map(block => `${block.scope}:${block.name}`)).toEqual(["bot:lock", "workspace:house-style", "workspace:lock"]);
    expect(listPromptBlocksForBot(db, "a").every(block => !("text" in block))).toBe(true);
    expect(listPromptBlocksForOwner(db)).toHaveLength(4);
  });

  it("lists the first 160 characters and refuses bad names, empty text and more than 8 blocks", () => {
    savePromptBlock(db, { scope: "workspace", name: "long", text: "x".repeat(500), createdBy: "owner" });
    expect(listPromptBlocksForBot(db, "a")[0]).toMatchObject({ chars: 500, preview: "x".repeat(160) });
    expect(() => savePromptBlock(db, { scope: "workspace", name: "Bad Name", text: "t", createdBy: "owner" })).toThrow("lowercase");
    expect(() => savePromptBlock(db, { scope: "workspace", name: "empty", text: "   ", createdBy: "owner" })).toThrow("1 to 100,000 characters");
    expect(() => savePromptBlock(db, { scope: "workspace", name: "huge", text: "y".repeat(100_001), createdBy: "owner" })).toThrow("1 to 100,000 characters");
    expect(() => resolvePromptBlocks(db, bot("a"), Array.from({ length: 9 }, () => "long"))).toThrow("at most 8");
    expect(() => parseLibraryRef("lock@0", "block")).toThrow(ImageLibraryError);
  });

  it("soft-deletes every version, keeps numbering, and render records keep their text", () => {
    const one = savePromptBlock(db, { scope: "workspace", name: "lock", text: "One", createdBy: "owner" });
    savePromptBlock(db, { scope: "workspace", name: "lock", text: "Two", createdBy: "owner" });
    recordRenderPrompt(db, { operationId: "op-1", prompt: "One\n\nscene", blocks: [{ name: "lock", version: 1, scope: "workspace", chars: 3 }] });
    expect(deletePromptBlock(db, one.id)).toEqual({ name: "lock", versions: 2 });
    expect(() => getPromptBlock(db, bot("a"), "lock")).toThrow("No saved prompt block");
    expect(listPromptBlocksForOwner(db)).toEqual([]);
    expect(savePromptBlock(db, { scope: "workspace", name: "lock", text: "One", createdBy: "owner" }).version).toBe(3);
    expect(renderPrompt(db, "op-1")).toMatchObject({ prompt: "One\n\nscene", promptChars: 10, blocks: [{ name: "lock", version: 1 }] });
    recordRenderPrompt(db, { operationId: "op-1", prompt: "changed", blocks: [] });
    expect(renderPrompt(db, "op-1")!.prompt).toBe("One\n\nscene");
  });
});

describe("reference packs", () => {
  it("stores each image once under its sha256 and versions the ordered set", () => {
    const first = saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "hero-refs", references: [ref(PNG_A), ref(PNG_B)], createdBy: "bot:a" });
    expect(first).toMatchObject({ name: "hero-refs", version: 1, count: 2, created: true });
    expect(saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "hero-refs", references: [ref(PNG_A), ref(PNG_B)], createdBy: "bot:a" })).toMatchObject({ version: 1, created: false });
    expect(saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "hero-refs", references: [ref(PNG_B), ref(PNG_A)], createdBy: "bot:a" })).toMatchObject({ version: 2 });
    expect(readdirSync(join(DATA_DIR, IMAGE_REFERENCE_PACK_DIR)).sort()).toEqual([`${sha(PNG_A)}.png`, `${sha(PNG_B)}.png`].sort());
    const used = resolveReferencePack(db, DATA_DIR, bot("a"), "hero-refs@1");
    expect(used).toMatchObject({ name: "hero-refs", version: 1, scope: "bot" });
    expect(used.references.map(item => item.bytes)).toEqual([PNG_A, PNG_B]);
    expect(resolveReferencePack(db, DATA_DIR, bot("a"), "hero-refs").references.map(item => item.bytes)).toEqual([PNG_B, PNG_A]);
  });

  it("keeps packs in scope and refuses more than 16 images", () => {
    saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "mine", references: [ref(PNG_A)], createdBy: "bot:a" });
    saveReferencePack(db, DATA_DIR, { scope: "workspace", name: "shared", references: [ref(PNG_B)], createdBy: "owner" });
    expect(() => resolveReferencePack(db, DATA_DIR, bot("b"), "mine")).toThrow("No saved reference pack is named mine");
    expect(resolveReferencePack(db, DATA_DIR, bot("b"), "shared").references).toHaveLength(1);
    expect(listReferencePacksForBot(db, "b").map(pack => pack.name)).toEqual(["shared"]);
    expect(listReferencePacksForOwner(db)).toHaveLength(2);
    expect(() => saveReferencePack(db, DATA_DIR, { scope: "workspace", name: "big", references: Array.from({ length: 17 }, () => ref(PNG_A)), createdBy: "owner" })).toThrow("1 to 16 images");
  });

  it("refuses the whole pack when one image is changed or missing", () => {
    saveReferencePack(db, DATA_DIR, { scope: "workspace", name: "pair", references: [ref(PNG_A), ref(PNG_B)], createdBy: "owner" });
    writeFileSync(join(DATA_DIR, IMAGE_REFERENCE_PACK_DIR, `${sha(PNG_B)}.png`), PNG_A);
    expect(() => resolveReferencePack(db, DATA_DIR, bot("a"), "pair")).toThrow("image 2 of 2 is missing or changed");
    rmSync(join(DATA_DIR, IMAGE_REFERENCE_PACK_DIR, `${sha(PNG_A)}.png`));
    expect(() => resolveReferencePack(db, DATA_DIR, bot("a"), "pair")).toThrow("image 1 of 2 is missing or changed");
  });

  it("soft-deletes a pack", () => {
    const pack = saveReferencePack(db, DATA_DIR, { scope: "workspace", name: "gone", references: [ref(PNG_A)], createdBy: "owner" });
    expect(deleteReferencePack(db, pack.id).versions).toBe(1);
    expect(listReferencePacksForOwner(db)).toEqual([]);
    expect(() => resolveReferencePack(db, DATA_DIR, bot("a"), "gone")).toThrow("No saved reference pack");
  });
});

describe("model checks", () => {
  it("records success and failure times and marks a failed model instead of hiding it", () => {
    recordImageProbe(db, { connectionId: "flux", model: "flux-image", ok: true, at: 1_000, durationMs: 900, costUsd: 0.01 });
    const failed = recordImageProbe(db, { connectionId: "flux", model: "flux-image", ok: false, at: 2_000, errorCode: "provider-error", errorMessage: "HTTP 500" });
    expect(failed).toMatchObject({ ok: false, lastGoodAt: 1_000, lastFailedAt: 2_000, errorCode: "provider-error" });
    const models = [{ id: "flux-image", availability: "unverified" }, { id: "flux-image-fast", availability: "catalog-listed" }];
    const applied = applyImageAvailability(models, imageProbes(db, "flux"));
    expect(applied).toHaveLength(2);
    expect(applied[0]).toMatchObject({ availability: "failed", lastGoodAt: 1_000, lastFailedAt: 2_000, lastError: "provider-error: HTTP 500" });
    expect(applied[1]).toEqual(models[1]);
    recordImageProbe(db, { connectionId: "flux", model: "flux-image", ok: true, at: 3_000 });
    expect(applyImageAvailability(models, imageProbes(db, "flux"))[0]).toMatchObject({ availability: "verified", lastGoodAt: 3_000, lastFailedAt: 2_000 });
  });

  it("allows a scheduled check once per model per day and three a day in all", () => {
    const day = 24 * 60 * 60_000, now = 10 * day;
    expect(scheduledProbeDue(db, "flux", "a", now)).toBe(true);
    recordImageProbe(db, { connectionId: "flux", model: "a", ok: true, at: now - day + 60_000 });
    expect(scheduledProbeDue(db, "flux", "a", now)).toBe(false);
    expect(scheduledProbeDue(db, "flux", "a", now + 60_000)).toBe(true);
    recordImageProbe(db, { connectionId: "flux", model: "b", ok: true, at: now - 1 });
    recordImageProbe(db, { connectionId: "openai", model: "c", ok: false, at: now - 1 });
    expect(scheduledProbeDue(db, "flux", "d", now)).toBe(false);
  });
});

describe("review: how much one scope keeps", () => {
  it("refuses a 51st version of one name and a 101st name, plainly, and never touches another bot", () => {
    for (let version = 1; version <= 50; version++) savePromptBlock(db, { scope: "bot", botId: "a", name: "grows", text: `v${version}`, createdBy: "bot:a" });
    expect(() => savePromptBlock(db, { scope: "bot", botId: "a", name: "grows", text: "v51", createdBy: "bot:a" })).toThrow("already has 50 versions");
    for (let index = 1; index < 100; index++) savePromptBlock(db, { scope: "bot", botId: "a", name: `name-${index}`, text: "x", createdBy: "bot:a" });
    expect(() => savePromptBlock(db, { scope: "bot", botId: "a", name: "one-more", text: "x", createdBy: "bot:a" })).toThrow("already 100 saved prompt blocks");
    expect(savePromptBlock(db, { scope: "bot", botId: "b", name: "one-more", text: "x", createdBy: "bot:b" })).toMatchObject({ created: true });
  });
  it("keeps and uses a pack image up to the generated-image cap", () => {
    const big = Buffer.concat([PNG_A.subarray(0, 33), Buffer.alloc(12 * 1024 * 1024)]);
    saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "big", references: [ref(big)], createdBy: "bot:a" });
    expect(resolveReferencePack(db, DATA_DIR, bot("a"), "big").references[0]!.bytes.length).toBe(big.length);
    expect(() => saveReferencePack(db, DATA_DIR, { scope: "bot", botId: "a", name: "huge", references: [ref(Buffer.concat([PNG_A, Buffer.alloc(26 * 1024 * 1024)]))], createdBy: "bot:a" })).toThrow("at most 25 MB");
  });
});
