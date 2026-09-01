/**
 * Flatten Markdown-ish text to one plain line.
 *
 * Package manifests, SKILL.md frontmatter and scouted GitHub profiles are all
 * written by someone else, and their prose is Markdown by habit — a bot package
 * whose description opens "You are **Smart Trader**" rendered the asterisks on
 * screen. These strings land in blurbs and single-line subtitles, so rendering
 * them as real Markdown is the wrong answer too: a heading or a list in a
 * centred one-liner breaks the layout instead of the wording.
 *
 * Deliberately conservative. Only paired, well-formed constructs are unwrapped,
 * because a lone `*` or `_` in ordinary prose ("P&L * 2", `snake_case`) is far
 * more common than a broken emphasis run, and eating those characters would
 * corrupt text that was never Markdown.
 */
export function plainText(input: string): string {
  let out = input;

  // Fenced blocks first: their content is code, not prose worth flattening.
  out = out.replace(/```[\s\S]*?```/g, " ");

  // Images before links — ![alt](src) keeps the alt, and running the link rule
  // first would leave a stray "!" behind.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Emphasis, longest marker first so ** is never read as two single *.
  // Every run requires non-space immediately inside both markers: that is
  // CommonMark's flanking rule, and without it arithmetic ("2 * 3 * 4") reads
  // as an emphasis span and loses its operators.
  const run = (marker: string) => new RegExp(`${marker}(\\S|\\S[^\\n]*?\\S)${marker}`, "g");
  out = out.replace(run("\\*\\*\\*"), "$1");
  out = out.replace(run("___"), "$1");
  out = out.replace(run("\\*\\*"), "$1");
  out = out.replace(run("__"), "$1");
  out = out.replace(run("\\*"), "$1");
  // Single underscores only when the run is bounded by whitespace, so
  // snake_case identifiers survive intact.
  out = out.replace(/(^|\s)_(\S|\S[^\n]*?\S)_(?=\s|$)/g, "$1$2");
  out = out.replace(run("~~"), "$1");
  out = out.replace(/`([^`]+)`/g, "$1");

  // Line-leading furniture: headings, quotes, bullets and ordered markers.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  out = out.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
  // A horizontal rule carries no words at all.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, " ");

  return out.replace(/\s+/g, " ").trim();
}

/** `plainText` plus a hard character budget, for fixed-height blurbs. */
export function plainTextClamped(input: string, max: number): string {
  const text = plainText(input);
  if (text.length <= max) return text;
  // Prefer a word boundary, but never emit a stub if the first word is huge.
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
