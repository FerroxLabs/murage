// rebaseStoredPath (designs/S5-DATADIR-PATHS.md r4.1 section 2): a stored absolute path survives a moved data dir
// only under a RECORDED previous DATA_DIR, only to a path Murage's own constructors build, and only inside DATA_DIR.
// Rebase by reconstruction, never by prefix arithmetic. The old path is never stat'ed, read or followed.
import { DATA_DIR } from "./config.ts";
import { dataRoots } from "./data-roots.ts";

export type RebaseResult = { keep: true } | { path: string } | { refused: true };

/** The constructor values of one kind at a data root P, in a fixed order (index i at P pairs with index i at DATA_DIR). */
export type Constructors = (root: string) => Array<string | undefined>;

interface Lexical { root: string; segments: string[] }

/** Section 2 lexical form: absolute, no NUL, no empty, `.` or `..` segment; win32 strips one `\\?\`, splits on both
 * separators and case-folds; darwin compares NFC; POSIX byte-exact. Undefined when the form is not acceptable. */
export function lexicalKey(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const parsed = lexicalForm(path, platform);
  if (!parsed) return undefined;
  return `${parsed.root}|${parsed.segments.join("/")}`;
}
function lexicalForm(path: string, platform: NodeJS.Platform): Lexical | undefined {
  if (!path || path.includes("\0")) return undefined;
  let value = path;
  if (platform === "win32") {
    if (value.startsWith("\\\\?\\UNC\\")) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith("\\\\?\\")) value = value.slice(4);
    value = value.replace(/\//g, "\\").toLowerCase();
    const drive = /^([a-z]):\\/.exec(value);
    const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(value);
    let root: string; let rest: string;
    if (drive) { root = `${drive[1]}:`; rest = value.slice(3); }
    else if (unc) { root = `\\\\${unc[1]}\\${unc[2]}`; rest = value.slice(unc[0].length); }
    else return undefined;
    return segmentsOf(root, rest.replace(/\\+$/, ""), /\\/);
  }
  if (platform === "darwin") value = value.normalize("NFC");
  if (!value.startsWith("/")) return undefined;
  return segmentsOf("/", value.slice(1).replace(/\/+$/, ""), /\//);
}
function segmentsOf(root: string, rest: string, separator: RegExp): Lexical | undefined {
  if (rest === "") return { root, segments: [] };
  const segments = rest.split(separator);
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return undefined;
  return { root, segments };
}
/** inner lies under (or equals) outer, lexically. Matching is exact (section 2), but this refusal test also folds case on
 * darwin, so a case-changed home name under a recorded root ends in data-dir-moved, never a silent keep (D15). */
function lexicallyUnder(inner: string, outer: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string) => platform === "darwin" ? value.toLowerCase() : value;
  const a = lexicalForm(fold(inner), platform), b = lexicalForm(fold(outer), platform);
  if (!a || !b || a.root !== b.root || a.segments.length < b.segments.length) return false;
  return b.segments.every((segment, index) => a.segments[index] === segment);
}

export interface RebaseContext { dataDir?: string; previous?: string[]; platform?: NodeJS.Platform }

export function rebaseStoredPath(stored: string, constructors: Constructors, context: RebaseContext = {}): RebaseResult {
  const platform = context.platform ?? process.platform;
  const dataDir = context.dataDir ?? DATA_DIR;
  const previous = context.previous ?? dataRoots().previousRoots();
  const key = lexicalKey(stored, platform);
  const current = safeValues(constructors, dataDir);
  if (key !== undefined && current.some(value => value && lexicalKey(value, platform) === key)) return { keep: true };
  // A stored value whose lexical form is not acceptable is never rebased; it is refused when it names Murage's own folders.
  if (key === undefined) return [dataDir, ...previous].some(root => stored.startsWith(root)) ? { refused: true } : { keep: true };
  const pairs = new Map<string, string>();
  for (const root of previous) {
    const old = safeValues(constructors, root);
    old.forEach((value, index) => {
      const next = current[index];
      if (!value || !next) return;
      const oldKey = lexicalKey(value, platform);
      if (oldKey === key) pairs.set(`${oldKey}->${lexicalKey(next, platform)}`, next);
    });
  }
  const distinct = new Map<string, string>();
  for (const next of pairs.values()) distinct.set(lexicalKey(next, platform) ?? next, next);
  if (distinct.size === 1) return { path: [...distinct.values()][0]! };
  if (distinct.size > 1) return { refused: true };
  if (previous.some(root => lexicallyUnder(stored, root, platform))) return { refused: true };
  return { keep: true };
}

function safeValues(constructors: Constructors, root: string): Array<string | undefined> {
  try { return constructors(root); } catch { return []; }
}
