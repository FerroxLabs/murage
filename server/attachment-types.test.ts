// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { expect, it } from "vitest";
import { saveFile } from "./attachments.ts";
import { removableName } from "./attachment-remove.ts";
import { MANAGED_NAME } from "./storage-attachments.ts";
import { ATTACHMENT_NAME_IN_JSON } from "./transcript-backfill.ts";

async function* chunks(bytes: Buffer) { yield bytes; }

it.each([
  ["bundle.zip", "application/zip", ".zip"],
  ["bundle.tar.gz", "application/gzip", ".tar.gz"],
  ["bundle.7z", "application/x-7z-compressed", ".7z"],
  ["bundle.tar", "application/x-tar", ".tar"],
  ["bundle.rar", "application/vnd.rar", ".rar"],
])("stores %s unchanged without opening or extracting its contents", async (name, mime, suffix) => {
  // Deliberately not a valid archive: accepting these bytes proves upload
  // storage does not try to inspect an archive, even one naming a private path.
  const bytes = Buffer.from("PK fixture ../private.txt\0opaque bytes");
  const saved = await saveFile(chunks(bytes), name, mime);
  expect(saved).toMatchObject({ name, mime, bytes: bytes.length });
  expect(basename(saved.path)).toMatch(new RegExp(`^[a-f0-9-]+${suffix.replaceAll(".", "\\.")}$`));
  expect(readFileSync(saved.path)).toEqual(bytes);
  expect(readdirSync(dirname(saved.path)).filter(file => file === "private.txt")).toEqual([]);
});

it.each(["../bundle.zip", "..\\bundle.zip", "..%2fbundle.zip"])("refuses traversal in an archive upload name: %s", async name => {
  await expect(saveFile(chunks(Buffer.from("opaque")), name, "application/zip")).rejects.toMatchObject({ status: 400 });
});

it("keeps the archive name and bytes on an identical retry and refuses changed bytes", async () => {
  const uploadId = "a1111111-1111-4111-8111-111111111111";
  const saved = await saveFile(chunks(Buffer.from("opaque")), "bundle.tar.gz", "application/gzip", { uploadId });
  expect(await saveFile(chunks(Buffer.from("opaque")), "bundle.tar.gz", "application/gzip", { uploadId })).toEqual(saved);
  await expect(saveFile(chunks(Buffer.from("changed")), "bundle.tar.gz", "application/gzip", { uploadId })).rejects.toMatchObject({ status: 409 });
});


it("masks complete archive names before clipping a credential across the name limit", async () => {
  const secret = ["sk", "proj", "a".repeat(60)].join("-");
  const saved = await saveFile(chunks(Buffer.from("opaque")), `${"x".repeat(167)} ${secret}.zip`, "application/zip");
  expect(saved.name).not.toContain("sk-proj");
  expect(saved.name).toContain("«redacted");
  expect(saved.name).toMatch(/\.zip$/);
  expect(saved.name.length).toBeLessThanOrEqual(184);
});

it.each(["bundle.zip", "bundle.tar.gz", "bundle.tar"])("a stored %s is a managed attachment name that Storage lists and removes", async name => {
  const mime = name.endsWith(".zip") ? "application/zip" : name.endsWith(".tar") ? "application/x-tar" : "application/gzip";
  const onDisk = basename((await saveFile(chunks(Buffer.from("opaque")), name, mime)).path);
  expect(onDisk).toMatch(MANAGED_NAME);
  expect(removableName(onDisk)).toBe(true);
  expect(onDisk.match(new RegExp(ATTACHMENT_NAME_IN_JSON.source, "i"))?.[0]).toBe(onDisk);
});

it("masks a credential written with compatibility characters that normalize into its prefix", async () => {
  const wide = (text: string) => Array.from(text, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
  const saved = await saveFile(chunks(Buffer.from("opaque")), `${wide("sk-proj-" + "a".repeat(60))}.zip`, "application/zip");
  expect(saved.name).not.toContain("sk-proj");
  expect(saved.name).not.toContain("a".repeat(20));
  expect(saved.name).toContain("«redacted");
});
