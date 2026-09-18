// One folder, one spelling.
//
// A guard that compares the path string it was handed protects one spelling of
// a folder and waves every other one through. Windows names the same folder
// several ways and its filesystem treats them all as equal: `c:\users\me` and
// `C:\Users\Me` differ only in case, `C:\Users\me\DOCUME~1` is the 8.3 alias of
// `Documents`, a trailing separator changes nothing, forward slashes are
// accepted everywhere backslashes are, and `\\?\C:\Users\me` /
// `\\?\UNC\server\share` are the extended-length spellings of the same place.
// macOS volumes are case-insensitive by default, so `~/documents` opens the
// folder written `Documents` there too.
//
// Callers must canonicalize with `realpathSync.native` BEFORE using anything
// here. The native call resolves symlinks *and* answers in the filesystem's own
// casing and long names; the JavaScript `realpathSync` follows links but hands
// back the spelling it was given, so it settles neither. This module settles
// what is left of the spelling; it never touches the filesystem, so it can say
// nothing about links.
//
// Case is folded only on Windows. On a case-insensitive macOS volume the native
// realpath has already returned the filesystem's own casing, so folding there
// would only make genuinely distinct folders collide on a case-sensitive one.
// `server/turn-resources.ts` draws the same line for workspace claims.
//
// Lives in shared/ as .mjs (with a .d.mts beside it, the pattern
// shared/backup-restic-pin.mjs already uses) because both server/*.ts and
// electron/*.mjs need it and only .mjs can be imported by both at runtime.

/** The one spelling of `path` its filesystem would recognize. Compare these,
 * never the raw strings. */
export function oneSpelling(path) {
  if (typeof path !== "string" || path === "") return path;
  const windows = process.platform === "win32";
  let out = path;
  if (windows) {
    // The extended-length prefixes name the same place. Strip before anything
    // else: those forms are backslash-only, so slash folding must come after.
    if (out.startsWith("\\\\?\\UNC\\")) out = `\\\\${out.slice("\\\\?\\UNC\\".length)}`;
    else if (/^\\\\\?\\[A-Za-z]:/.test(out)) out = out.slice("\\\\?\\".length);
    // Windows accepts either slash for every separator.
    out = out.replaceAll("/", "\\");
  }
  const sep = windows ? "\\" : "/";
  // A trailing separator names the same folder — but a root is all separator,
  // so never shorten one away to nothing ("C:\" and "/" must survive).
  const root = rootLength(out, windows, sep);
  while (out.length > root && out.endsWith(sep)) out = out.slice(0, -1);
  return windows ? out.toLowerCase() : out;
}

/** How much of `path` is its root and can never be trimmed: "C:\", "\\" for a
 * UNC path, "/" — or 0 for a relative path, which has no root to protect. */
function rootLength(path, windows, sep) {
  if (!windows) return path.startsWith("/") ? 1 : 0;
  if (/^[A-Za-z]:\\/.test(path)) return 3;
  if (path.startsWith("\\\\")) return 2;
  return path.startsWith(sep) ? 1 : 0;
}

/** Whether `a` and `b` name the same path. Canonicalize both with
 * `realpathSync.native` first: this settles spelling, not links. */
export function samePath(a, b) {
  return oneSpelling(a) === oneSpelling(b);
}

/** Whether `child` IS `parent` or sits beneath it. A separator is always
 * required between the two, so a sibling whose name merely starts with the
 * parent's ("…/Documents-archive" under "…/Documents") is not contained.
 * Canonicalize both with `realpathSync.native` first. */
export function pathWithin(parent, child) {
  const top = oneSpelling(parent), inner = oneSpelling(child);
  if (!top || !inner) return false;
  if (top === inner) return true;
  const sep = process.platform === "win32" ? "\\" : "/";
  // A root already ends in its own separator; anything else needs one added.
  return inner.startsWith(top.endsWith(sep) ? top : top + sep);
}

/** Whether either path contains the other — the shape a guard needs when both
 * nestings are wrong, such as a backup repository and the scratch directory
 * that must not share a tree. */
export function pathOverlaps(a, b) {
  return pathWithin(a, b) || pathWithin(b, a);
}
