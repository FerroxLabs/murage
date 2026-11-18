// Test-only bridge for the private upstream descriptor. No production module reads
// TypeScript source. Replace this fixture bridge with an upstream export after
// 1.0.19 releases ownership; a missing descriptor fails closed until then.
import { readFileSync } from "node:fs";
import { HOME, protectedPathClass } from "./upstream.ts";
import { compileDenySpec as compile, type CompileInput } from "./compile.ts";
const HOME_PARENT = HOME && HOME !== "/" ? HOME.slice(0, HOME.lastIndexOf("/")) || "/" : "";
export interface ClassifierMetadata { roots: string[]; exceptions: string[] }
/** These private sets cannot be imported before the integration cut. Extract DATA,
 * never evaluate code. An upstream shape change fails closed. A packaged integration
 * must supply the matching source text rather than silently using stale metadata.
 * Exception strings are tagged `regex:`, `prefix:` or `exact:`; emitters must preserve
 * them exactly or return unexpressible. They are not blanket glob exemptions. */
export function classifierMetadata(source = readFileSync(new URL("../always-ask.ts", import.meta.url), "utf8")): ClassifierMetadata {
  function set(name: string): string[] {
    const text = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(source)?.[1];
    if (!text) throw Error(`native-deny upstream metadata unavailable: ${name}`);
    return [...text.matchAll(/"([^"\n]+)"/g)].map(m => m[1]);
  }
  const start = source.indexOf("function systemDescendant(canonical: string): boolean {");
  const end = source.indexOf("export function protectedClass", start);
  const body = source.slice(start, end);
  const ordinary = /const ORDINARY_DEVICE_SINK = (\/.*\/);/.exec(source)?.[1];
  if (start < 0 || end < 0 || !ordinary || !body.includes("return [...SYSTEM_FOLDERS,")) throw Error("native-deny upstream exceptions unavailable");
  const allowPart = body.slice(0, body.indexOf("return [...SYSTEM_FOLDERS,"));
  const exceptions = [
    `regex:${ordinary.slice(1, -1)}`,
    ...[...allowPart.matchAll(/canonical\.startsWith\("([^"\n]+)"\)/g)].map(m => `prefix:${m[1]}`),
    ...[...allowPart.matchAll(/(\/[^\n]+?\/)\.test\(canonical\)/g)].map(m => `regex:${m[1].slice(1, -1)}`),
    ...(HOME && HOME !== "/" ? [`prefix:${HOME.toLowerCase()}/`] : []),
    ...(HOME_PARENT && protectedPathClass(`${HOME_PARENT}/native-descriptor-probe`) === null ? [`prefix:${HOME_PARENT.toLowerCase()}/`] : []),
  ];
  if (!allowPart.includes("ORDINARY_DEVICE_SINK.test(canonical)") || exceptions.length < 8) throw Error("native-deny incomplete upstream exceptions");
  const additional = /return \[\.\.\.SYSTEM_FOLDERS,([\s\S]*?)\.\.\.MORE_SYSTEM\]/.exec(body)?.[1];
  if (!additional) throw Error("native-deny additional roots unavailable");
  const roots = ["/", "~", HOME, HOME_PARENT, ...set("SYSTEM_FOLDERS"), ...set("MORE_SYSTEM"), ...set("MOUNT_PARENTS"), ...[...additional.matchAll(/"([^"\n]+)"/g)].map(m => m[1])].filter(Boolean);
  // The classifier accepts every drive letter. Keep this finite enumeration here,
  // deriving the directory names exclusively from its Windows set.
  for (const drive of "abcdefghijklmnopqrstuvwxyz") {
    roots.push(`${drive}:/`);
    for (const folder of set("WINDOWS_SYSTEM_FOLDERS")) roots.push(`${drive}:/${folder}`);
  }
  for (const root of [...roots]) if (root.startsWith("/") && protectedPathClass(`/private${root}`) === "system") roots.push(`/private${root}`);
  return { roots: [...new Set(roots)], exceptions: [...new Set(exceptions)].sort() };
}

export const compileDenySpec = (input: Omit<CompileInput, "descriptor"> = {}) => compile({ ...input, descriptor: classifierMetadata() });

/** Fake identity facts. Real integration must supply its pinned per-engine table. */
export const testTools = { exec_command: "shell", write_stdin: "stdin", execute_code: "code", apply_patch: "patch", read_file: "read", search: "read", write_file: "write" } as const;
