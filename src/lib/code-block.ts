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
