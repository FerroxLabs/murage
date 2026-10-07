// Fetch a skill's files from where users actually keep skills: a GitHub
// repo, a folder inside one, a direct SKILL.md, or a skills.sh page that
// points at one. Network in, plain
// {path, content} list out. Validation, scanning, and storage live in
// skills.ts, so this file owns exactly one concern and its tests can hand
// it a fake fetch.
//
// Caps mirror the skills.sh CLI's: nothing here downloads more than
// MAX_FILES files or MAX_FILE_BYTES per file, and only markdown is ever
// requested (v1 imports are markdown-only by policy).
import { z } from "zod";

const MAX_FILES = 30;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTING_BYTES = 1024 * 1024;
const MAX_LISTING_ENTRIES = 1000;
const LISTING_TIMEOUT_MS = 15_000;
const TEXT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const SOURCE_TIMEOUT = "The skill source took too long to answer. Try again in a moment.";
const SOURCE_REDIRECT = "That skill source sent Murage somewhere it does not import from.";
const FILE_TOO_LARGE = "Import stopped because the file is too large (over the 256 KB import cap). Choose a smaller file or a folder of smaller files.";
const LISTING_TOO_LARGE = "That skill folder is too large to read. Choose a smaller folder.";
const REDIRECT_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com"]);
const API = "https://api.github.com";

export interface FetchedSkill {
  source: string;
  files: Array<{ path: string; content: string }>;
}

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  /** A skills.sh skill slug: only the skill it names is imported. */
  skill?: string;
}

/** owner/repo, github.com/owner/repo[/tree/<ref>/<path>], a raw/blob URL
 * straight to a SKILL.md, or a skills.sh/owner/repo[/skill] page. Anything
 * else is refused, loudly. */
export function parseSkillSource(input: string): Target | { rawUrl: string } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "paste a GitHub repository, folder, or SKILL.md URL" };
  if (/^https?:\/\/raw\.githubusercontent\.com\/.+\/SKILL\.md$/i.test(text)) return { rawUrl: text };
  // The file itself must be named SKILL.md, at the repository root or in a
  // folder, the same rule the raw link above applies.
  const blob = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/((?:.*\/)?SKILL\.md)$/i);
  if (blob) {
    return { rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}` };
  }
  const tree = text.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) {
    return { owner: tree[1]!, repo: tree[2]!, ref: tree[3], path: tree[4] ?? "" };
  }
  const registry = text.match(/^https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)(?:\/([\w.-]+))?\/?$/i);
  if (registry) {
    if ([registry[1], registry[2]].some((part) => part === "." || part === "..") ||
      (registry[3] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(registry[3]))) {
      return { error: "that does not look like a skills.sh repository or skill link" };
    }
    // skills.sh is a registry over GitHub: each page installs from
    // github.com/<owner>/<repo> filtered to the named skill, so resolve to
    // the repo and remember the slug to filter discovery on.
    return { owner: registry[1]!, repo: registry[2]!, path: "", skill: registry[3] };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, path: "" };
  return { error: "that does not look like a GitHub or skills.sh repository, folder, or SKILL.md URL" };
}

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  download_url: z.string().nullable().optional(),
});
type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

// The GitHub contents API is the I/O boundary: parse its JSON here, keep
// only entries matching the documented shape, drop the rest silently.
const CONTENT_LISTING = z.array(z.unknown()).catch([]);

function asEntries(listing: z.infer<typeof CONTENT_LISTING>): ContentEntry[] {
  return listing.flatMap((item) => {
    const entry = CONTENT_ENTRY.safeParse(item);
    return entry.success ? [entry.data] : [];
  });
}

/** The deadline also settles fetchers and streams that ignore their signal. */
function beforeDeadline<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(SOURCE_TIMEOUT));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(SOURCE_TIMEOUT));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(work).then(resolve, (error: unknown) => {
      reject(signal.aborted ? new Error(SOURCE_TIMEOUT) : error);
    }).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function fetchWithRedirects(url: string, fetcher: typeof fetch, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
  for (let redirects = 0; ; redirects++) {
    const response = await beforeDeadline(signal, () => fetcher(url, { headers, signal, redirect: "manual" }));
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    void response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location || redirects >= MAX_REDIRECTS) throw new Error(SOURCE_REDIRECT);
    let next: URL;
    try { next = new URL(location, url); } catch { throw new Error(SOURCE_REDIRECT); }
    if (next.protocol !== "https:" || !REDIRECT_HOSTS.has(next.hostname) || next.username || next.password) {
      throw new Error(SOURCE_REDIRECT);
    }
    url = next.href;
  }
}

async function readSourceBody(response: Response, signal: AbortSignal, max: number, tooLarge: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const result = await beforeDeadline(signal, () => reader.read());
      const piece = result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      // Count the decoded text, which can be wider than the bytes received.
      bytes += Buffer.byteLength(piece, "utf8");
      if (bytes > max) throw new Error(tooLarge);
      text += piece;
      if (result.done) return text;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const signal = AbortSignal.timeout(LISTING_TIMEOUT_MS);
  const response = await fetchWithRedirects(url, fetcher, signal, {
    accept: "application/vnd.github+json", "user-agent": "Murage-skills",
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  const text = await readSourceBody(response, signal, MAX_LISTING_BYTES, LISTING_TOO_LARGE);
  const listing = CONTENT_LISTING.parse(JSON.parse(text));
  if (listing.length > MAX_LISTING_ENTRIES) throw new Error(LISTING_TOO_LARGE);
  return asEntries(listing);
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const signal = AbortSignal.timeout(TEXT_TIMEOUT_MS);
  const response = await fetchWithRedirects(url, fetcher, signal, { "user-agent": "Murage-skills" });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`download failed (${response.status})`);
  }
  return readSourceBody(response, signal, MAX_FILE_BYTES, FILE_TOO_LARGE);
}

async function listDir(target: Target, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const ref = target.ref ? `?ref=${encodeURIComponent(target.ref)}` : "";
  const url = `${API}/repos/${target.owner}/${target.repo}/contents/${path}${ref}`;
  return fetchListing(url, fetcher);
}

/** A skill name as a skills.sh slug, the way the registry derives page slugs
 * from each SKILL.md name (which can differ from the folder it lives in). */
const toSkillSlug = (name: string) =>
  name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

/** A folder or file GitHub says is not there, or a file over the cap: skipped
 * during discovery. Any other failure (a refusal, a rate limit, a network
 * error) ends the search, so it is reported as one, not as a missing skill. */
const skippable = (error: unknown) => error instanceof Error && /\b404\b|import cap/.test(error.message);

/** The name field from a skill folder's SKILL.md frontmatter, or undefined
 * when it is not there. */
async function skillNameFrom(entries: ContentEntry[], fetcher: typeof fetch): Promise<string | undefined> {
  const skillMd = entries.find((entry) => entry.type === "file" && entry.name === "SKILL.md" && entry.download_url);
  if (!skillMd) return undefined;
  try {
    const text = await fetchText(skillMd.download_url!, fetcher);
    return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  } catch (error) {
    if (skippable(error)) return undefined;
    throw error;
  }
}

/** Where SKILL.md folders live in real repos, per the registry's own
 * discovery order: the pasted path itself, then skills/, then .claude/skills/
 * and .agents/skills/, then one level of direct children. A skills.sh slug
 * matches a folder whose name slugifies to it, else a skill whose SKILL.md
 * name does, like the registry's own installer; a SKILL.md name, when there
 * is one, outranks the folder's. `search.cut` is set when a named skill was
 * not found and the folder caps left some folders unread. */
export async function discoverSkillDirs(target: Target, fetcher: typeof fetch, search: { cut?: boolean } = {}): Promise<string[]> {
  const root = await listDir(target, target.path, fetcher);
  const wanted = target.skill ? toSkillSlug(target.skill) || undefined : undefined;
  const dirMatches = (dir: string) => !!wanted && toSkillSlug(dir.split("/").at(-1)!) === wanted;
  const isWanted = async (dir: string, entries: ContentEntry[]) => {
    if (!wanted) return true;
    const name = await skillNameFrom(entries, fetcher);
    return name ? toSkillSlug(name) === wanted : dirMatches(dir);
  };
  if (root.some((entry) => entry.type === "file" && entry.name === "SKILL.md") && (await isWanted(target.path, root))) {
    return [target.path];
  }
  const dirs = root.filter((entry) => entry.type === "dir");
  const found: string[] = [];
  const preferred = ["skills", ".claude", ".agents"];
  const rank = (name: string) => (wanted && toSkillSlug(name) === wanted ? 0 : preferred.includes(name) ? 1 : 2);
  const ordered = [...dirs].sort((a, b) => rank(a.name) - rank(b.name));
  const enough = () => found.length >= (wanted ? 1 : 10);
  let cut = ordered.length > 12;
  for (const dir of ordered.slice(0, 12)) {
    if (enough()) break;
    const base = dir.name === ".claude" || dir.name === ".agents" ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try {
      children = await listDir(target, base, fetcher);
    } catch (error) {
      if (skippable(error)) continue;
      throw error;
    }
    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      if (await isWanted(base, children)) found.push(base);
      continue;
    }
    // A folder named like the wanted skill is tried first, even past the cap.
    const childDirs = children.filter((entry) => entry.type === "dir");
    const exact = wanted ? childDirs.find((child) => dirMatches(child.path)) : undefined;
    const candidates = exact ? [exact, ...childDirs.filter((child) => child !== exact).slice(0, 19)] : childDirs.slice(0, 20);
    if (childDirs.length > candidates.length) cut = true;
    for (const child of candidates) {
      if (enough()) break;
      try {
        const inner = await listDir(target, child.path, fetcher);
        if (inner.some((entry) => entry.type === "file" && entry.name === "SKILL.md") && (await isWanted(child.path, inner))) found.push(child.path);
      } catch (error) {
        if (!skippable(error)) throw error;
      }
    }
  }
  if (wanted && !found.length && cut) search.cut = true;
  return found;
}

/** Fetch ONE skill folder's markdown files. `dir` must contain SKILL.md. */
export async function fetchSkillDir(target: Target, dir: string, fetcher: typeof fetch): Promise<FetchedSkill> {
  const entries = await listDir(target, dir, fetcher);
  const markdown = entries
    .filter((entry) => entry.type === "file" && /\.md$/i.test(entry.name) && entry.download_url)
    .slice(0, MAX_FILES);
  if (!markdown.some((entry) => entry.name === "SKILL.md")) {
    throw new Error(`no SKILL.md in ${dir || "the repository root"}`);
  }
  const files = await Promise.all(
    markdown.map(async (entry) => ({
      path: entry.name,
      content: await fetchText(entry.download_url!, fetcher),
    })),
  );
  const ref = target.ref ? `@${target.ref}` : "";
  return { source: `github.com/${target.owner}/${target.repo}${ref}/${dir}`.replace(/\/$/, ""), files };
}

export async function fetchSkillFromSource(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const parsed = parseSkillSource(input);
  if ("error" in parsed) return parsed;
  try {
    if ("rawUrl" in parsed) {
      const content = await fetchText(parsed.rawUrl, fetcher);
      return { skills: [{ source: parsed.rawUrl, files: [{ path: "SKILL.md", content }] }] };
    }
    const search: { cut?: boolean } = {};
    const dirs = await discoverSkillDirs(parsed, fetcher, search);
    if (!dirs.length) {
      return {
        error: search.cut
          ? `too many folders there to find "${parsed.skill}": paste the GitHub link to the skill's own folder`
          : parsed.skill
          ? `no skill named "${parsed.skill}" found there: check the exact name on the skills.sh page`
          : "no SKILL.md found there: paste a skill folder or a repo with a skills/ directory",
      };
    }
    const skills = await Promise.all(dirs.map((dir) => fetchSkillDir(parsed, dir, fetcher)));
    return { skills };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
