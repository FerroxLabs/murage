// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where an imported skill's files come from besides a dropped file or
// folder: a zip, read in memory with hard bounds, or a GitHub link.
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import * as yauzl from "yauzl";

import { fetchSkillFromSource, parseSkillSource } from "./skill-fetch.ts";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES } from "./skill-collection.ts";

const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;
const MAX_RATIO = 100;

type SkillFile = { path: string; content: string };
type ZipRefusal = { error: string; code: "invalid" | "too-big" };
class Refused extends Error {
  readonly code: ZipRefusal["code"];
  constructor(code: ZipRefusal["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** The text files of a zip, plus the names of files that are not text.
 *  Folders are skipped; encrypted, linked or unusual entries refuse the zip. */
export async function readSkillZip(bytes: Buffer): Promise<{ files: SkillFile[]; skipped: string[] } | ZipRefusal> {
  if (bytes.length > MAX_ZIP_BYTES) return { error: "This zip is too big to import (over 8 MB).", code: "too-big" };
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (error, value) => (error ? reject(error) : resolve(value!))),
    );
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new Refused("too-big", `This zip has too many files to be one skill (over ${MAX_ZIP_ENTRIES}).`);
    const files: SkillFile[] = [];
    const skipped: string[] = [];
    let expanded = 0;
    const source = zip;
    await new Promise<void>((resolve, reject) => {
      source.once("error", reject);
      source.once("end", resolve);
      source.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (name.endsWith("/")) return source.readEntry();
          if (/(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name)) return source.readEntry();
          if (entry.isEncrypted() || (mode !== 0 && mode !== 0o100000) || ![0, 8].includes(entry.compressionMethod)) {
            throw new Refused("invalid", "This zip holds something other than plain files (a link, or an encrypted file).");
          }
          if (entry.uncompressedSize > MAX_SKILL_FILE_BYTES) {
            skipped.push(name);
            return source.readEntry();
          }
          if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_RATIO) throw new Refused("invalid", "This zip is packed in a way that can't be trusted.");
          const raw = await new Promise<Readable>((ok, fail) => source.openReadStream(entry, entry.compressionMethod === 8 ? { decompress: false } : {}, (error, stream) => (error ? fail(error) : ok(stream))));
          let compressed = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              compressed += chunk.length;
              callback(compressed > entry.compressedSize ? new Refused("invalid", "This zip is damaged.") : null, chunk);
            },
          });
          const decoded = entry.compressionMethod === 8 ? createInflateRaw() : new PassThrough();
          const done = pipeline(raw, counter, decoded);
          void done.catch(() => {});
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of decoded) {
            size += (chunk as Buffer).length;
            expanded += (chunk as Buffer).length;
            if (size > entry.uncompressedSize || size > MAX_SKILL_FILE_BYTES) throw new Refused("invalid", "This zip is damaged.");
            if (expanded > MAX_SKILL_TOTAL_BYTES * 2) throw new Refused("too-big", "This skill is too big to import (over 2 MB in all).");
            chunks.push(chunk as Buffer);
          }
          await done;
          try {
            files.push({ path: name, content: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)) });
          } catch {
            skipped.push(name);
          }
          source.readEntry();
        })().catch(reject);
      });
      source.readEntry();
    });
    return { files, skipped };
  } catch (error) {
    if (error instanceof Refused) return { error: error.message, code: error.code };
    return { error: "That file isn't a zip that can be opened.", code: "invalid" };
  } finally {
    zip?.close();
  }
}

/** The first skill at a GitHub link (a repo, a folder in one, or a SKILL.md). */
export async function fetchSkillFromLink(link: string, fetcher: typeof fetch = fetch): Promise<{ files: SkillFile[] } | { error: string; code: "invalid" | "unreachable" }> {
  const parsed = parseSkillSource(link.trim());
  if ("error" in parsed) return { error: "That link doesn't point to a skill. Paste a GitHub link to a skill folder or its SKILL.md.", code: "invalid" };
  const fetched = await fetchSkillFromSource(link.trim(), fetcher);
  if ("error" in fetched) {
    return /no SKILL\.md/i.test(fetched.error)
      ? { error: "That link doesn't point to a skill. A skill is a folder with a SKILL.md file in it.", code: "invalid" }
      : { error: "Couldn't reach that link. Check it and try again.", code: "unreachable" };
  }
  const first = fetched.skills[0];
  return first ? { files: first.files } : { error: "That link doesn't point to a skill.", code: "invalid" };
}
