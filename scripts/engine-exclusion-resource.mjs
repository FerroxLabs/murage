// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The packaged engine-exclusion addon (native/engine-exclusion, built by scripts/build-engine-exclusion.mjs). Without it Murage cannot
// remove a deleted conversation's copies from the coding engines' files (it leaves them alone and says so), so a package that lacks
// it, or carries one for another platform, is refused when it is assembled: electron-builder's copier only warns on a missing source.
import { lstatSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

const MAGIC = {
  darwin: (head) => [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0)),
  linux: (head) => head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46,
  win32: (head) => head[0] === 0x4d && head[1] === 0x5a,
};

/** Throws unless `<resources>/engine-exclusion.node` is a regular, single-link file of a plausible size whose header is an
 * executable image of `platform` (Mach-O, ELF or PE). Returns its path. */
export function validateEngineExclusionResource(resources, platform) {
  const check = MAGIC[platform];
  if (!check) throw new Error("ENGINE_EXCLUSION_PLATFORM_UNSUPPORTED");
  const file = path.join(resources, "engine-exclusion.node");
  let details;
  try { details = lstatSync(file); } catch { throw new Error("ENGINE_EXCLUSION_RESOURCE_MISSING"); }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size < 1024 || details.size > 4 * 1024 * 1024) throw new Error("ENGINE_EXCLUSION_RESOURCE_INVALID");
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8 || !check(head)) throw new Error("ENGINE_EXCLUSION_RESOURCE_MISMATCH");
  } finally { closeSync(fd); }
  return file;
}
