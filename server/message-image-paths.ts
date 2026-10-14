// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The image paths a stored message names: the attachments it carries, and the
// `<attached-image path>` tags the composer writes into a user's text (older
// rows carry the tag and no attachment). One definition for the writer
// (message-db trackImages), the thread fill (branch-store) and the readers.
import { splitTranscriptAttachments } from "../src/lib/composer-attachments.ts";

export interface ImageNaming { role?: unknown; text?: unknown; attachments?: unknown }

export function attachmentImagePaths(message: ImageNaming): string[] {
  const out: string[] = [];
  if (Array.isArray(message.attachments)) for (const item of message.attachments as Array<{ path?: unknown }>) if (item && typeof item.path === "string" && item.path !== "") out.push(item.path);
  return out;
}
export function tagImagePaths(message: ImageNaming): string[] {
  if (message.role !== "user" || typeof message.text !== "string" || !message.text.includes("<attached-image")) return [];
  try { return splitTranscriptAttachments(message.text).images; } catch { return []; }
}
/** Every path the message names as an image, by attachment or by tag. */
export function imagePathsOf(message: ImageNaming): string[] {
  return [...new Set([...attachmentImagePaths(message), ...tagImagePaths(message)])];
}
