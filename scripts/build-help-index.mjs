// Build the shipped help index from the user-facing docs.
//
// Why a generated module rather than reading the .mdx at runtime: the packaged
// app ships only what electron-builder lists, and apps/docs is a separate
// workspace that is NOT packaged. Bundling the index as a source module means
// `murage_help` answers the same way in the packaged app as it does in dev,
// with no extra packaging surface and no filesystem lookup that could fail.
//
// Run `node scripts/build-help-index.mjs` after editing apps/docs/content/docs.
// `--check` fails when the committed file is stale; the test suite runs it.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(root, "apps", "docs", "content", "docs");
const OUT = join(root, "shared", "help-index.ts");
/** Public docs site. The only location a help answer may hand to the user:
 * a repo path is not something they can open. */
const SITE = "https://murage.app/docs";
/** Each section is a quotable snippet, not a page. Long enough to answer,
 * short enough that a bot can paste it into chat without a wall of text. */
const MAX_SECTION_CHARS = 700;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

function titleCase(segment) {
  const words = segment.split("-");
  return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
}

/** Strip the MDX that a chat answer must never contain: JSX tags, import
 * lines, fence markers, link syntax. What is left is prose a bot can quote. */
function plain(text) {
  return text
    .replace(/^import .*$/gm, "")
    // Fenced blocks are config and shell, not prose. Indexing them buries a
    // section's real subject under key names a user never asks about, and a
    // bot must not paste a config file into chat as a "quote from the docs".
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[A-Za-z/][^>]*>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clamp(text) {
  if (text.length <= MAX_SECTION_CHARS) return text;
  const cut = text.slice(0, MAX_SECTION_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(stop > MAX_SECTION_CHARS / 2 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

/** A UI path the user can actually follow ("Settings → Engines"). Preferred
 * over a breadcrumb because it names a place in the app, not in the docs. */
function uiPath(text) {
  const match = text.match(/[A-Z][A-Za-z0-9 &'.]*(?: → [A-Za-z0-9 &'.]+)+/);
  return match ? match[0].trim() : undefined;
}

/** Contributor docs, not user help. They describe the repository — including
 * paths inside it — which a help answer must never hand to a person who has
 * only the app. (`shared/help-search.test.ts` fails if one slips in.) */
const EXCLUDED = ["contributing"];

const entries = [];
for (const file of walk(DOCS)) {
  if (EXCLUDED.some((dir) => relative(DOCS, file).split(sep)[0] === dir)) continue;
  const raw = readFileSync(file, "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const head = frontmatter?.[1] ?? "";
  const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const field = (name) => head.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  const title = field("title") ?? "Murage";
  const description = field("description") ?? "";
  const rel = relative(DOCS, file).split(sep).join("/").replace(/\.mdx$/, "");
  const slug = rel.replace(/(^|\/)index$/, "");
  const url = slug ? `${SITE}/${slug}` : SITE;
  // Parent folders are titled from their slug; the leaf uses the page's own
  // frontmatter title, so a breadcrumb reads the way the docs site reads.
  const crumbs = slug.split("/").filter(Boolean);
  const breadcrumb = ["Murage docs", ...crumbs.slice(0, -1).map(titleCase), ...(crumbs.length ? [title] : [])].join(" → ");

  // Split on ## headings. Text before the first heading belongs to the page
  // itself, which is how an index page (all intro, no headings) still indexes.
  const parts = plain(body).split(/^##+ +(.+)$/m);
  const sections = [];
  const intro = parts[0]?.trim();
  if (intro) sections.push({ heading: undefined, text: intro });
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i + 1]?.trim();
    if (text) sections.push({ heading: parts[i].trim(), text });
  }
  for (const section of sections) {
    const text = clamp(section.text);
    entries.push({
      id: `${slug || "index"}#${section.heading ? section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "overview"}`,
      title,
      description,
      heading: section.heading,
      breadcrumb,
      where: uiPath(section.text) ?? breadcrumb,
      url: section.heading ? `${url}#${section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : url,
      text,
    });
  }
}

const generated = `// GENERATED by scripts/build-help-index.mjs — do not edit by hand.
// Source: apps/docs/content/docs/**/*.mdx. Run \`node scripts/build-help-index.mjs\`
// after editing those docs; \`--check\` in the test suite fails when it is stale.
/** One quotable section of the shipped user documentation. */
export interface HelpEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly heading?: string;
  /** Where in the docs this lives, for a user who wants the whole page. */
  readonly breadcrumb: string;
  /** Where in the APP to go — a UI path when the section names one. */
  readonly where: string;
  /** Public documentation URL. Never a repository or filesystem path. */
  readonly url: string;
  readonly text: string;
}

export const HELP_INDEX: readonly HelpEntry[] = ${JSON.stringify(entries, null, 2)};
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== generated) {
    console.error("shared/help-index.ts is stale — run `node scripts/build-help-index.mjs`");
    process.exit(1);
  }
  console.log(`help index up to date (${entries.length} sections)`);
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${relative(root, OUT)} (${entries.length} sections)`);
}
