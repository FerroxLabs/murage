// Small display-only adaptation of OpenMausBot PR #948. Code bytes are never normalized here.
const LANGUAGES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript (JSX)", ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript (TSX)",
  py: "Python", python: "Python", rs: "Rust", rust: "Rust", sh: "Shell", bash: "Bash", zsh: "Zsh", ps1: "PowerShell", powershell: "PowerShell",
  json: "JSON", jsonc: "JSON with comments", html: "HTML", css: "CSS", sql: "SQL", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", markdown: "Markdown", cpp: "C++", "c++": "C++", cs: "C#", "c#": "C#", csharp: "C#", c: "C", go: "Go", java: "Java", swift: "Swift", dockerfile: "Dockerfile",
};
export function codeLanguageLabel(language: string): string {
  const name = language.trim(); if (!name) return "Code";
  const key = name.toLowerCase(); return Object.hasOwn(LANGUAGES, key) ? LANGUAGES[key]! : name;
}
/** The renderer already removes its one synthetic fence newline; preserve intentional blank lines. */
export function codeLineCount(code: string): number { return code ? code.split(/\r\n|\r|\n/).length : 0; }
export function codeLineLabel(code: string): string { const count = codeLineCount(code); return `${count} ${count === 1 ? "line" : "lines"}`; }

// Code-block Save, adapted from OpenMausBot PR #979 (merge b5a8a1bb, Apache-2.0).
// The fence language is model text, so it only ever picks an extension from a
// known table or a short plain token; it never becomes a path or a name part.
const EXTENSIONS: Record<string, string> = {
  js: "js", javascript: "js", node: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", mjs: "mjs", cjs: "cjs",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less", json: "json", jsonc: "json", json5: "json5",
  xml: "xml", svg: "svg", md: "md", markdown: "md", mdx: "mdx", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", csv: "csv",
  sh: "sh", bash: "sh", shell: "sh", zsh: "zsh", fish: "fish", ps1: "ps1", powershell: "ps1", bat: "bat", batch: "bat", cmd: "cmd",
  c: "c", h: "h", cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "hpp", cs: "cs", csharp: "cs", "c#": "cs",
  rs: "rs", rust: "rs", go: "go", golang: "go", py: "py", python: "py", rb: "rb", ruby: "rb", php: "php", java: "java",
  kt: "kt", kotlin: "kt", swift: "swift", dart: "dart", r: "r", lua: "lua", sql: "sql", graphql: "graphql", gql: "graphql",
  proto: "proto", protobuf: "proto", diff: "diff", patch: "diff", text: "txt", txt: "txt", plaintext: "txt",
};
// Whole-file names that tools look up by exact name.
const FILENAMES: Record<string, string> = { dockerfile: "Dockerfile", docker: "Dockerfile", makefile: "Makefile", make: "Makefile" };
// A short unknown token passes through as an extension, except types the OS
// launches or installs on open: text saved under them would not be a snippet.
const LAUNCHER_EXTENSIONS = new Set([
  "exe", "com", "scr", "pif", "msi", "msp", "mst", "hta", "lnk", "url", "cpl", "jar", "app", "dmg", "pkg", "deb", "rpm", "apk",
  "reg", "vbs", "vbe", "jse", "wsf", "wsh", "scf", "inf", "gadget", "command", "desktop", "appimage", "workflow", "action",
]);
const PLAIN_TOKEN = /^[a-z0-9][a-z0-9_-]{0,7}$/;

/** Extension (no dot) for a fence language; "txt" when unknown, empty or unsafe. */
export function codeFileExtension(language: string | null | undefined): string {
  const key = (language ?? "").trim().toLowerCase();
  if (!key) return "txt";
  if (Object.hasOwn(EXTENSIONS, key)) return EXTENSIONS[key]!;
  return PLAIN_TOKEN.test(key) && !LAUNCHER_EXTENSIONS.has(key) ? key : "txt";
}
/** Suggested name for a saved snippet: "snippet.py", "Dockerfile", "snippet.txt". */
export function codeFileName(language: string | null | undefined): string {
  const key = (language ?? "").trim().toLowerCase();
  return Object.hasOwn(FILENAMES, key) ? FILENAMES[key]! : `snippet.${codeFileExtension(language)}`;
}

/** How long the Blob URL outlives the click; Chromium may read it after the click task. */
export const SNIPPET_URL_LIFETIME_MS = 1000;
/**
 * Hands the exact code text to the browser as a local file download. The bytes
 * are the UTF-8 encoding of `code` with nothing added or normalized (no BOM, no
 * trailing newline, CRLF kept). Returns false when there is no document to
 * download from. A true result means the download was requested, not that a
 * file was written: the browser owns the save dialog and its cancel. Makes no
 * network request; the anchor and the object URL are always cleaned up.
 */
export function saveCodeSnippet(fileName: string, code: string): boolean {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") return false;
  // Chromium appends ".txt" to an extensionless name typed text/plain, which
  // turned "Dockerfile" into "Dockerfile.txt"; an untyped blob keeps the name.
  const type = /\.[^.]+$/.test(fileName) ? "text/plain;charset=utf-8" : "application/octet-stream";
  const url = URL.createObjectURL(new Blob([code], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = fileName; link.rel = "noopener";
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), SNIPPET_URL_LIFETIME_MS);
  }
  return true;
}
