// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve, sep } from "node:path";

export type StaticResolution = { kind: "file"; file: string; rel: string } | { kind: "refused" };
/** Maps a request path to a file under `root`. Refuses (never falls back to the SPA) any path that decodes to a traversal,
 *  a dotfile or dot-directory, an empty segment (`//`), a backslash or a NUL, or that resolves outside `root`. */
export function resolveStaticFile(root: string, rawPath: string): StaticResolution {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/") || rawPath.length > 2048) return { kind: "refused" };
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return { kind: "refused" }; }
  if (decoded.includes("\0") || decoded.includes("\\")) return { kind: "refused" };
  const rel = decoded === "/" ? "/index.html" : decoded;
  const segments = rel.split("/").slice(1);
  if (segments.some(segment => segment === "" || segment.startsWith("."))) return { kind: "refused" };
  const base = resolve(root), file = resolve(base, "." + rel);
  if (!file.startsWith(base + sep)) return { kind: "refused" };
  return { kind: "file", file, rel };
}
