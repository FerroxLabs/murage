// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Opaque file uploads are separate from the phone share sheet's document
// contract. Nothing in this table grants permission to unpack an archive.
const ARCHIVES: Readonly<Record<string, string>> = {
  ".tar.gz": "application/gzip",
  ".tar.bz2": "application/x-bzip2",
  ".tar.xz": "application/x-xz",
  ".tar.zst": "application/zstd",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".tgz": "application/gzip",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".zst": "application/zstd",
};
export const XMIND_MIME = "application/x-xmind";
export const ARCHIVE_EXTENSIONS = Object.freeze(Object.keys(ARCHIVES));
const ALIASES: Readonly<Record<string, string>> = {
  "application/x-zip-compressed": "application/zip",
  "application/x-gzip": "application/gzip",
  "application/x-rar-compressed": "application/vnd.rar",
  "application/vnd.xmind.workbook": XMIND_MIME,
};

/** Filename hints are used only for an explicit list of inert file types. */
export function binaryFileType(name: string): { mime: string; extension: string } | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xmind")) return { mime: XMIND_MIME, extension: ".xmind" };
  const extension = ARCHIVE_EXTENSIONS.find(ext => lower.endsWith(ext));
  return extension ? { mime: ARCHIVES[extension]!, extension } : null;
}

/** The MIME still chooses an allowed suffix; an arbitrary filename never
 * adds an executable or active document type to the upload allowlist. */
export function binaryUploadType(name: string, mime: string): { mime: string; extension: string } | null {
  const normalized = mime.split(";")[0]!.trim().toLowerCase();
  const canonical = ALIASES[normalized] ?? normalized;
  const hinted = binaryFileType(name);
  if (hinted?.mime === XMIND_MIME && [XMIND_MIME, "application/zip", "application/octet-stream"].includes(canonical)) return hinted;
  if (canonical === XMIND_MIME) return { mime: canonical, extension: ".xmind" };
  if (hinted && hinted.mime === canonical) return hinted;
  const extension = ARCHIVE_EXTENSIONS.find(ext => ARCHIVES[ext] === canonical && !ext.startsWith(".tar."));
  return extension ? { mime: canonical, extension } : null;
}
