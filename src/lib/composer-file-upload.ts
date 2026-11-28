// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser authorization stays outside the server's shared attachment parser.
import { binaryAttachmentFromFile, type DroppedFile, type FileUploadErrorLine } from "./composer-attachments.ts";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "./live-events.ts";

export async function fileAttachmentFromFile(file: DroppedFile, line: FileUploadErrorLine) {
  try { await ensureDesktopSurfaceSecret(); }
  catch { throw new Error(line("attachFailed", 0)); }
  return binaryAttachmentFromFile(file, line, { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() });
}
