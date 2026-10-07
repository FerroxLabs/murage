// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MEDIA_MAX_AGE_MS, mediaRoot, ownedMediaFile, sweepMedia } from "./media.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const NOW = 2_000_000_000_000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-media-unit-")); roots.push(dir);
  const root = mediaRoot(dir, "conn");
  mkdirSync(join(root, "chat"), { recursive: true });
  const file = (name: string, ageMs: number) => { const p = join(root, "chat", name); writeFileSync(p, "x"); utimesSync(p, new Date(NOW - ageMs), new Date(NOW - ageMs)); return p; };
  return { dir, root, file };
}

it("accepts only a regular file inside this connection's media directory", () => {
  const f = fixture();
  const inside = f.file("a.jpg", 0);
  expect(ownedMediaFile(f.dir, "conn", inside)).toEqual({ path: inside, bytes: 1 });
  expect(ownedMediaFile(f.dir, "other", inside)).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", join(f.root, "..", "x.jpg"))).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", join(f.root, "chat", "..", "..", "..", "etc", "hosts"))).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", "/etc/hosts")).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", join(f.root, "chat"))).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", join(f.root, "chat", "missing.jpg"))).toBeNull();
  expect(ownedMediaFile(f.dir, "conn", undefined)).toBeNull();
  const link = join(f.root, "chat", "link.jpg"); symlinkSync("/etc/hosts", link);
  expect(ownedMediaFile(f.dir, "conn", link)).toBeNull();
});

it("sweeps files past seven days and day-old partial downloads, spares young and referenced files, removes empty chat folders", () => {
  const f = fixture();
  const old = f.file("old.jpg", MEDIA_MAX_AGE_MS + 1000), young = f.file("young.jpg", MEDIA_MAX_AGE_MS - 60_000), kept = f.file("kept.jpg", MEDIA_MAX_AGE_MS * 3);
  const partOld = f.file("x.jpg.part", 25 * 3_600_000), partNew = f.file("y.jpg.part", 3_600_000);
  mkdirSync(join(f.root, "empty-chat"));
  expect(sweepMedia({ dataDir: f.dir, connectionId: "conn", keep: [kept], nowMs: NOW })).toBe(2);
  expect(existsSync(old)).toBe(false); expect(existsSync(partOld)).toBe(false);
  for (const p of [young, kept, partNew]) expect(existsSync(p)).toBe(true);
  expect(existsSync(join(f.root, "empty-chat"))).toBe(false);
  expect(existsSync(join(f.root, "chat"))).toBe(true);
});

it("never follows a link out of the media directory", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "murage-wa-outside-")); roots.push(outside);
  const victim = join(outside, "victim.txt"); writeFileSync(victim, "keep"); utimesSync(victim, new Date(NOW - 99 * 86_400_000), new Date(NOW - 99 * 86_400_000));
  symlinkSync(outside, join(f.root, "chat", "escape"));
  sweepMedia({ dataDir: f.dir, connectionId: "conn", keep: [], nowMs: NOW });
  expect(existsSync(victim)).toBe(true);
});

it("does nothing when the connection has no media directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-media-none-")); roots.push(dir);
  expect(sweepMedia({ dataDir: dir, connectionId: "conn", keep: [], nowMs: NOW })).toBe(0);
});

it("rejects linked ancestors and rechecks current image size at attachment admission", async () => {
  const { whatsappAttachments } = await import("./media.ts");
  const f = fixture(), outside = join(f.dir, "outside"); mkdirSync(outside);
  const path = join(outside, "photo.jpg"); writeFileSync(path, "outside");
  symlinkSync(outside, join(f.root, "linked"));
  expect(ownedMediaFile(f.dir, "conn", join(f.root, "linked", "photo.jpg"))).toBeNull();
  const image = f.file("image.jpg", 0);
  writeFileSync(image, "changed size");
  expect(whatsappAttachments(f.dir, "conn", "id", [{ path: image, mime: "image/jpeg" }])[0].size).toBe(12);
  rmSync(image); symlinkSync(path, image);
  expect(whatsappAttachments(f.dir, "conn", "id", [{ path: image, mime: "image/jpeg" }])).toEqual([]);
});
