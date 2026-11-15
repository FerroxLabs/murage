// Implements the public helper contract frozen by S0 at 953a1d822 (HighLevel r4 F0).
// Keep the explicit readonly property: Node strip-only cannot run parameter properties.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
export type AnchoredRefusal = "invalid_name" | "link" | "not_directory" | "not_regular" | "hard_link" | "other_volume" | "too_large" | "changed" | "unsupported";
export class AnchoredReadRefused extends Error {
  /** @frozenParameterProperty Node strip-only spelling of the frozen readonly constructor property. */
  readonly code: AnchoredRefusal;
  constructor(code: AnchoredRefusal) { super(code === "unsupported" ? "Murage's file helper is missing. Reinstall Murage." : `File read refused: ${code}`); this.name = "AnchoredReadRefused"; this.code = code; }
}
export type AnchoredStep = { kind: "root" } | { kind: "dir"; index: number } | { kind: "file" } | { kind: "read" };
export interface AnchoredReadHooks { afterStep?(step: AnchoredStep): void }
export interface AnchoredReadResult { readonly bytes: Uint8Array; readonly size: number; readonly volume: string; readonly fileId: string }
interface NativeReader { version(): number; read(root: string, parts: readonly string[], maxBytes: number, hook?: AnchoredReadHooks["afterStep"]): Omit<AnchoredReadResult, "bytes"> & { bytes: ArrayBuffer } }
let native: NativeReader | null | undefined;
function addon(): NativeReader | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== "darwin" && process.platform !== "win32") return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.env.MURAGE_RESOURCES_PATH;
  // A packaged server runs in Resources/server; bundling relocates import.meta.url there.
  const candidates = resources ? [join(resources, "anchored-read.node")] : [join(here, "..", "anchored-read.node"), join(here, "..", "..", "dist-native", "anchored-read", `${process.platform}-${process.arch}`, "anchored-read.node")];
  for (const file of candidates) try {
    const loaded = createRequire(import.meta.url)(file) as NativeReader;
    if (loaded.version() === 1 && typeof loaded.read === "function") { native = loaded; break; }
  } catch { /* Missing or incompatible helpers fail closed. */ }
  return native;
}
function refuse(code: AnchoredRefusal): never { throw new AnchoredReadRefused(code); }
const codes = new Set<AnchoredRefusal>(["invalid_name", "link", "not_directory", "not_regular", "hard_link", "other_volume", "too_large", "changed", "unsupported"]);
function mapError(error: unknown): never {
  if (error instanceof AnchoredReadRefused) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (codes.has(code as AnchoredRefusal)) refuse(code as AnchoredRefusal);
  if (code === "ELOOP") refuse("link");
  if (code === "ENOTDIR") refuse("not_directory");
  refuse("changed");
}
/** Every child open is anchored to the held parent; no child pathname is sampled. */
export function readAnchoredFile(root: string, parts: readonly string[], maxBytes: number, hooks?: AnchoredReadHooks): AnchoredReadResult {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 32 || parts.some(p => typeof p !== "string" || p.length < 1 || p.length > 255 || p === "." || p === ".." || /[/\\:\0\r\n]/.test(p) || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) refuse("invalid_name");
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) refuse("invalid_name");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 0x7ffffffe) refuse("too_large");
  // Snapshot before any hook can mutate the caller's array.
  const names = [...parts];
  const step = (value: AnchoredStep) => hooks?.afterStep?.(value);
  let rootReal: string;
  try { rootReal = realpathSync(root); } catch (error) { return mapError(error); }
  if (process.platform !== "linux") {
    const reader = addon(); if (!reader) refuse("unsupported");
    let hookError: unknown; let hookThrew = false;
    try {
      const result = reader.read(rootReal, names, maxBytes, hooks?.afterStep ? value => { try { step(value); } catch (error) { hookThrew = true; hookError = error; throw error; } } : undefined);
      const bytes = new Uint8Array(result.bytes);
      if (bytes.byteLength !== result.size || result.size > maxBytes) refuse("changed");
      return { ...result, bytes };
    } catch (error) { if (hookThrew) throw hookError; return mapError(error); }
  }
  try { if (statfsSync("/proc/self/fd").type !== 0x9fa0) refuse("unsupported"); } catch { refuse("unsupported"); }
  let fd = -1;
  const io = <T>(fn: () => T): T => { try { return fn(); } catch (error) { return mapError(error); } };
  try {
    fd = io(() => openSync(rootReal, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const volume = io(() => fstatSync(fd, { bigint: true })).dev;
    step({ kind: "root" });
    for (let i = 0; i < names.length; i++) {
      const last = i === names.length - 1;
      const child = io(() => openSync(`/proc/self/fd/${fd}/${names[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | (last ? constants.O_NONBLOCK : constants.O_DIRECTORY)));
      closeSync(fd); fd = child;
      const stat = io(() => fstatSync(fd, { bigint: true }));
      if (stat.dev !== volume) refuse("other_volume");
      if (!last) { if (!stat.isDirectory()) refuse("not_directory"); step({ kind: "dir", index: i }); continue; }
      if (!stat.isFile()) refuse("not_regular");
      if (stat.nlink !== 1n) refuse("hard_link");
      if (stat.size > BigInt(maxBytes)) refuse("too_large");
      step({ kind: "file" });
      const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
      while (size < bytes.length) { const count = io(() => readSync(fd, bytes, size, bytes.length - size, null)); if (!count) break; size += count; }
      step({ kind: "read" });
      const after = io(() => fstatSync(fd, { bigint: true }));
      if (BigInt(size) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.nlink !== 1n) refuse("changed");
      return { bytes: bytes.subarray(0, size), size, volume: volume.toString(), fileId: stat.ino.toString() };
    }
    return refuse("invalid_name");
  } finally { if (fd >= 0) closeSync(fd); }
}

export function anchoredReadAvailable(): boolean { return process.platform === "linux" || addon() !== null; }
