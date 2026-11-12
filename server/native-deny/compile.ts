// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { win32, posix } from "node:path";
import { ALWAYS_ASK_NO_LIMITS, normalizePath, protectedPathClass, type AlwaysAskRule, type ProtectedClass } from "./upstream.ts";

export interface DenySpec {
  version: 2;
  protectedPaths: { path: string; cls: ProtectedClass; scope: "self" | "descendants"; except: string[] }[];
  wipe: { rule: AlwaysAskRule; prefixes: string[][] }[];
  refusals: { kind: "path" | "tool"; value: string; reason: string }[];
  selfPaths: string[];
  hash: string;
}
export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
/** Reject non-JSON values instead of silently dropping a digest-bound field. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  throw Error("native-deny requires complete JSON");
}
export type CanonicalPath = { status: "ok"; path: string } | { status: "unexpressible"; reason: string; path?: never };
export function canonicalPath(raw: string): CanonicalPath {
  if (!raw || /[\x00\r\n]/.test(raw)) return { status: "unexpressible", reason: "invalid-path" };
  const windows = /^[a-z]:|^\\|^\/\//i.test(raw);
  if (windows) {
    const p = raw.replaceAll("\\", "/");
    if (!/^[a-z]:\//i.test(p) || /(?:^|\/)globalroot(?:\/|$)/i.test(p) || /~\d/.test(p) || p.split("/").some(part => part !== "." && part !== ".." && /[. ]$/.test(part)) || p.slice(2).includes(":")) return { status: "unexpressible", reason: "windows-alias" };
    return { status: "ok", path: win32.normalize(p).replaceAll("\\", "/").toLowerCase() };
  }
  return { status: "ok", path: normalizePath(raw) };
}
function exactPath(raw: string): string {
  const found = canonicalPath(raw);
  if (found.status !== "ok") throw Error(`native-deny unexpressible: ${found.reason}`);
  return found.path;
}
/** Preserve a conservative lexical alias, but place the raw POSIX components in
 * filesystem order: a symlink target must be expanded before a following `..`.
 * Missing components remain available for new files. Loops/budget failures throw. */
export function pathAliases(raw: string): string[] {
  const lexical = exactPath(raw);
  if (!posix.isAbsolute(lexical) || lexical.startsWith("//")) return [lexical];
  let current = "/", links = 0, steps = 0;
  const pending = raw.split("/").reverse();
  while (pending.length) {
    if (++steps > 4096) throw Error("unexpressible-path");
    const part = pending.pop()!;
    if (!part || part === ".") continue;
    if (part === "..") { current = posix.dirname(current); continue; }
    const next = current === "/" ? `/${part}` : `${current}/${part}`;
    try {
      if (lstatSync(next).isSymbolicLink()) {
        if (++links > 40) throw Error("unexpressible-path");
        const target = readlinkSync(next);
        if (posix.isAbsolute(target)) current = "/";
        pending.push(...target.split("/").reverse());
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = next;
  }
  return [...new Set([lexical, exactPath(current)])];
}
export interface ProtectedPathDescriptor {
  roots: readonly string[];
  /** Tagged exact/prefix/regex exceptions from the same upstream revision. */
  exceptions: readonly string[];
}
export interface CompileInput {
  /** Required trusted upstream DATA. The private policy is deliberately not
   * replicated here. Until ownership release supplies its descriptor export,
   * integration cannot call this compiler and remains today. */
  descriptor: ProtectedPathDescriptor;
  /** Additional discovered home/volume paths or targets. Defaults include the upstream roots. */
  paths?: readonly string[];
  refusals?: DenySpec["refusals"];
  selfPaths?: readonly string[];
}
export function compileDenySpec(input: CompileInput): DenySpec {
  const metadata = input?.descriptor;
  if (!metadata || !metadata.roots.length || !metadata.exceptions.length) throw Error("native-deny upstream descriptor required");
  const paths = [...metadata.roots, ...(input.paths ?? [])];
  const rows = paths.flatMap(raw => {
    const aliases = pathAliases(raw);
    const fallback = aliases.map(protectedPathClass).find(cls => cls !== null);
    return aliases.flatMap(path => {
      const cls = protectedPathClass(path) ?? fallback;
      return cls ? [{ path, cls, scope: cls === "system" ? "descendants" as const : "self" as const, except: cls === "system" ? [...metadata.exceptions] : [] }] : [];
    });
  });
  function unique<T>(items: T[]): T[] { return [...new Map(items.map(item => [canonicalJson(item), item])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value); }
  const data: Omit<DenySpec, "hash"> = {
    version: 2,
    protectedPaths: unique(rows),
    // No second wipe-prefix dictionary: prefixes are optional defence in depth.
    // All wipe recognition is done by the real upstream reader at L2.
    wipe: Object.entries(ALWAYS_ASK_NO_LIMITS).filter(([, act]) => act === "wipe").map(([rule]) => ({ rule: rule as AlwaysAskRule, prefixes: [] })).sort((a, b) => a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
    refusals: unique((input.refusals ?? []).flatMap(r => r.kind === "path" ? pathAliases(r.value).map(value => ({ ...r, value })) : [{ ...r }])),
    selfPaths: [...new Set((input.selfPaths ?? []).flatMap(pathAliases))].sort(),
  };
  return { ...data, hash: sha256(canonicalJson(data)) };
}
