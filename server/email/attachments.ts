// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Email attachments (BOT-EMAIL-MURAGE-109 3.3, F26, F27): each path is a workspace-relative path under the root
// selectFileWorkspace(DATA_DIR, store, bot.id, threadId) returns, read through the whole verified sequence registerArtifact runs
// (server/artifacts.ts): partitionFileRefusal, the authorized root, the verified source (no absolute path, no `..`, no dot-folders, no
// private names, no links, ordinary files only), readVerified (O_NOFOLLOW, fstat compare), then every observed ancestor re-checked with
// lstat after the read, so an ancestor swapped for a link mid-read fails. A 4 MB total budget and Flux's blocked types are refused before
// any Flux call. The bytes are copied out here and frozen into the send record by the caller; nothing is read again at Send time.
// attachment-read.ts is not used.
import { lstatSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  ArtifactError, artifactRelativePathParts, authorizedArtifactRoot, readVerifiedArtifactFile, sameArtifactStat, verifiedArtifactSource,
} from "../artifacts.ts";
import { partitionFileRefusal } from "../partition-files.ts";
import type { BotRecord } from "../store.ts";
import type { DraftAttachment } from "./canonical.ts";

export const ATTACHMENT_BUDGET_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** Flux's allowlist (contract #9: PDF, PNG, JPEG, plain text, CSV, macro-free OOXML), by extension, with the magic bytes Flux checks. */
const ALLOWED: Readonly<Record<string, { type: string; magic?: readonly number[] }>> = {
  ".pdf": { type: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  ".png": { type: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  ".jpg": { type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".txt": { type: "text/plain" },
  ".csv": { type: "text/csv" },
  ".docx": { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b, 0x03, 0x04] },
  ".xlsx": { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", magic: [0x50, 0x4b, 0x03, 0x04] },
  ".pptx": { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", magic: [0x50, 0x4b, 0x03, 0x04] },
};

export const ATTACHMENT_LINES = {
  workspace: "Attachments must be files in this conversation's workspace, named by their path inside it.",
  missing: "That attachment was not found in this conversation's workspace.",
  tooMany: `At most ${MAX_ATTACHMENTS} attachments per email.`,
  budget: "Attachments can be at most 4 MB together.",
  /** design 6, payload_too_large / attachment_type_blocked */
  blocked: "That attachment is of a type email cannot carry.",
} as const;

export type AttachmentResult = { ok: true; files: DraftAttachment[] } | { ok: false; line: string };

/** Reads the attachments of one email call. `root` is the turn's workspace (selectFileWorkspace), `bot` the stored bot (for its
 *  partition). Every refusal is one Murage line; nothing here calls Flux. */
export function readEmailAttachments(input: { root: string | undefined; bot: BotRecord | undefined; threadId: string; paths: unknown }): AttachmentResult {
  if (input.paths === undefined || input.paths === null) return { ok: true, files: [] };
  if (!Array.isArray(input.paths) || input.paths.some(path => typeof path !== "string")) return { ok: false, line: ATTACHMENT_LINES.workspace };
  const paths = input.paths as string[];
  if (!paths.length) return { ok: true, files: [] };
  if (paths.length > MAX_ATTACHMENTS) return { ok: false, line: ATTACHMENT_LINES.tooMany };
  if (!input.root) return { ok: false, line: ATTACHMENT_LINES.workspace };
  // every path is checked, and every type refused, before any byte is read
  const checked: Array<{ path: string; type: string; magic?: readonly number[] }> = [];
  try {
    for (const path of paths) {
      artifactRelativePathParts(path);
      const allowed = ALLOWED[extname(path).toLowerCase()];
      if (!allowed) return { ok: false, line: ATTACHMENT_LINES.blocked };
      checked.push({ path, ...allowed });
    }
    if (input.bot) {
      const denied = partitionFileRefusal(input.bot, input.threadId, paths, input.root);
      if (denied) return { ok: false, line: denied };
    }
    const root = authorizedArtifactRoot(input.root);
    const files: DraftAttachment[] = [];
    let used = 0;
    for (const item of checked) {
      const source = verifiedArtifactSource(root, item.path);
      if (used + source.stat.size > ATTACHMENT_BUDGET_BYTES) return { ok: false, line: ATTACHMENT_LINES.budget };
      const bytes = readVerifiedArtifactFile(source.path, ATTACHMENT_BUDGET_BYTES - used, source.stat);
      if (source.observed.some(([path, stat]) => !sameArtifactStat(stat, lstatSync(path)))) throw new ArtifactError(409, "The file location changed during verification.");
      if (item.magic && !item.magic.every((byte, index) => bytes[index] === byte)) return { ok: false, line: ATTACHMENT_LINES.blocked };
      used += bytes.byteLength;
      files.push({ name: basename(item.path), contentType: item.type, bytes: new Uint8Array(bytes) });
    }
    return { ok: true, files };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, line: ATTACHMENT_LINES.missing };
    if (error instanceof ArtifactError) return { ok: false, line: error.status === 413 ? ATTACHMENT_LINES.budget : error.message };
    return { ok: false, line: ATTACHMENT_LINES.workspace };
  }
}
