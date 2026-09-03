// Local full-text retrieval over the two things a person can actually install:
// the shipped skills library (2,237 SKILL.md packages) and the team catalog
// (122 entries).
//
// WHY THIS EXISTS
// The library panel filtered with a lowercase substring match. Measured against
// the real 122-entry catalog, "trading", "crypto", "options", "stocks",
// "newsletter" and "writing" each returned ZERO rows — not poor results, zero.
// Separately, 2,010 of the 2,237 shipped skills (89.9%) were referenced by no
// catalog entry, so they were reachable from nowhere in the product at all.
//
// WHY BOTH CORPORA, ALWAYS
// Indexing the catalog alone does not fix those words. Measured: an FTS5 index
// over the 122 catalog entries still answers "crypto", "options", "stocks" and
// "newsletter" with zero rows, because that text genuinely does not contain
// them. The skills corpus is what carries the recall (crypto-navigator,
// options-basics-trainer, stock-analysis-guide, newsletter-writer). Searching
// both corpora is therefore not a nicety layered on top of catalog search — it
// is the only thing that makes those queries answer at all, and it is the same
// change that makes the 2,010 orphans reachable.
//
// NO NETWORK, EVER. This module touches the filesystem and node:sqlite and
// nothing else. Murage may run headless, air-gapped, or against a local model.
//
// FTS5 availability is not assumed — it is verified. node:sqlite's bundled
// SQLite is compiled with FTS5 under Electron's utilityProcess (the runtime the
// packaged harness actually runs in: electron/main.mjs forks it), confirmed at
// Electron 43.4.0 / Node 24.18.1 / SQLite 3.53.1, bm25() and the porter
// stemmer included. server/message-db.ts already depends on node:sqlite, so
// this adds zero dependencies.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { SKILL_LIBRARY_ROOT, checkLibrarySkill } from "./skills.ts";

/** Bump when the table shape, the tokenizer, or the ADMISSION RULE changes.
 *  Part of the fingerprint, so an app upgrade that changes any of them
 *  rebuilds instead of querying a stale index with the wrong columns — or,
 *  since v3, with rows the installer would now refuse. v3 is the admission
 *  bump: an index built by v2 on an unchanged library still fingerprints as
 *  current, so without this an upgraded app would keep serving the very rows
 *  checkLibrarySkill was added to withhold. */
const SCHEMA_VERSION = 3;

const INDEX_FILE = () => join(DATA_DIR, "skill-index.db");

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 100;

export interface SkillHit {
  id: string;
  name: string;
  description: string;
  /** Facet terms carried by the skill's manifest, for display and drill-down. */
  terms: string[];
}

export interface TeamHit {
  slug: string;
}

export interface Facet {
  term: string;
  count: number;
}

/** Terms that describe a skill's FORMAT or DIFFICULTY rather than its subject.
 *  `guide` alone tags 732 of 2,237 skills, `template` 417, `checklist` 365 —
 *  as browse entry points they sort to the top and say nothing about what the
 *  skill is for. They stay fully searchable; they are only demoted out of the
 *  browse facet strip, where the job is to answer "what is in here?". */
const FORMAT_TERMS = new Set([
  "guide", "template", "checklist", "step-by-step", "beginner-friendly",
  "advanced", "best-practices", "tips", "reference", "how-to", "intermediate",
  "quick-reference", "quickstart", "report",
  // "and" reaches 13 skills purely because a handful of manifests split a
  // phrase into words when they wrote triggerTerms. It is not a topic.
  "and", "the", "for", "with", "your",
]);

/** A facet needs enough behind it to be worth a click. */
const FACET_MIN_COUNT = 12;

// ---------------------------------------------------------------------------
// Query sanitising
// ---------------------------------------------------------------------------

/** Turn arbitrary human input into a safe FTS5 MATCH expression.
 *
 *  FTS5's query language treats `"`, `*`, `(`, `:`, `^`, `-`, AND/OR/NOT as
 *  syntax. Passing raw user text through throws SQLite errors on perfectly
 *  ordinary input ("c++", 'say "hi"', "AND"). Every token is therefore
 *  double-quoted (which makes it a literal string in FTS5, with embedded
 *  quotes doubled) and given a trailing `*` so a partial word typed into a
 *  live search box matches as the person types.
 *
 *  Tokens are OR-ed rather than AND-ed: "stock market" should surface entries
 *  about either, ranked by bm25, rather than only those containing both. With
 *  AND, a two-word query against a thin corpus returns nothing, which is the
 *  exact failure this module exists to remove. */
export function toMatchExpression(raw: string): string {
  const tokens = raw
    .toLowerCase()
    // keep letters, digits and intra-word marks; everything else is a separator
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    // a lone letter matches most of the corpus and costs a full scan
    .filter((token) => token.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return SEARCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(limit)));
}

// ---------------------------------------------------------------------------
// Skills index — on disk, per workspace
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  name: string;
  description: string;
  terms: string;
}

/** One indexable row, or null if this entry must not be advertised.
 *
 *  THE INDEX MUST NOT ADVERTISE WHAT THE INSTALLER WILL REFUSE. Both
 *  /api/library/search and /api/library/suggest hand the ids this module
 *  returns straight to the install routes, so any rule the index does not
 *  enforce is a row a user can tick and watch fail. Before this gate the only
 *  requirement was a parseable manifest.json; the installer additionally
 *  requires a valid id, a real directory, a regular SKILL.md inside the size
 *  cap, a fully valid manifest, valid frontmatter, and a frontmatter name
 *  equal to the manifest id. Measured consequence of that gap: "security
 *  auditor" returned an unresolvable skill as the number one result.
 *
 *  checkLibrarySkill is the installer's own rejection ladder with the write
 *  removed, so the two cannot drift — the same rule set the catalog builder
 *  now calls (scripts/build-local-catalog.mjs). It is deliberately NOT
 *  reimplemented here: a copy is how the disagreement started.
 *
 *  It is checked FIRST so a rejected entry costs no manifest parse, and it is
 *  wrapped because an unexpected throw from one entry must not abort the
 *  build for the other 2,236 — the same resilience readManifest has. */
function indexRow(root: string, entry: string): SkillRow | null {
  try {
    if ("error" in checkLibrarySkill(entry, root)) return null;
  } catch {
    // Defensive: checkLibrarySkill returns its errors rather than throwing,
    // but a skip here is always better than a build that dies on one entry.
    return null;
  }
  return readManifest(root, entry);
}

/** Display fields for a row that has already passed the installer's gate.
 *  The gate validates; this reads what the index shows. They read the same
 *  manifest.json twice — measured at well under the noise floor of the build
 *  it sits in, and the alternative is duplicating the installer's parse. */
function readManifest(root: string, entry: string): SkillRow | null {
  const manifestPath = join(root, entry, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      id?: unknown; name?: unknown; description?: unknown; triggerTerms?: unknown;
    };
    const terms = Array.isArray(manifest.triggerTerms)
      ? manifest.triggerTerms.filter((term): term is string => typeof term === "string")
      : [];
    return {
      id: typeof manifest.id === "string" && manifest.id ? manifest.id : entry,
      name: typeof manifest.name === "string" && manifest.name ? manifest.name : entry,
      description: typeof manifest.description === "string" ? manifest.description : "",
      terms: terms.join(" "),
    };
  } catch {
    // A single unreadable manifest must not cost the other 2,236 skills their
    // index. Skip it; it is simply not findable until it parses.
    return null;
  }
}

/** Staleness key: entry count plus the newest mtime of any manifest.json or
 *  SKILL.md under the library.
 *
 *  A cheaper key — the mtime of the library root directory — was measured and
 *  REJECTED. Appending to a nested SKILL.md leaves the root's mtime byte-for-byte
 *  identical (verified: 1788310132866.762 before and after), so a root-keyed
 *  index would serve stale results forever with no way to notice. The full
 *  sweep is 4,474 stat calls and costs 9–16 ms on this machine — a rounding
 *  error against the 421 ms rebuild it guards, but too much to repeat on every
 *  keystroke, hence the TTL below. SCHEMA_VERSION covers the third case, a
 *  change to this file. */

/** How long a computed fingerprint is trusted before it is swept again.
 *
 *  The sweep is 4,474 stat calls (~10 ms). Cheap once, but search fires on
 *  every keystroke and paying it per character made a hot query 12.8 ms
 *  instead of 0.1 ms — the sweep, not the search, became the latency. The
 *  library is read-only in a packaged app, so re-checking a few times a
 *  second buys nothing; a 5-second window still notices a developer editing a
 *  SKILL.md well inside the time it takes them to alt-tab back. */
const FINGERPRINT_TTL_MS = 5_000;
let fingerprintCache: { root: string; at: number; value: string } | null = null;

function fingerprint(root: string): string {
  const now = Date.now();
  if (fingerprintCache && fingerprintCache.root === root && now - fingerprintCache.at < FINGERPRINT_TTL_MS) {
    return fingerprintCache.value;
  }
  const value = computeFingerprint(root);
  fingerprintCache = { root, at: now, value };
  return value;
}

function computeFingerprint(root: string): string {
  let newest = 0;
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return `v${SCHEMA_VERSION}:missing`;
  }
  for (const entry of entries) {
    for (const file of ["manifest.json", "SKILL.md"]) {
      try {
        const stat = statSync(join(root, entry, file));
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        // absent file — not every entry is a skill directory
      }
    }
    count += 1;
  }
  return `v${SCHEMA_VERSION}:${count}:${Math.trunc(newest)}`;
}

function createSchema(db: DatabaseSync): void {
  // Unindexed id: it is a payload column, never a search target — indexing it
  // would let a hyphenated slug match on its fragments and pollute ranking.
  db.exec(
    "CREATE VIRTUAL TABLE skills USING fts5(" +
      "id UNINDEXED, name, description, terms, tokenize='porter unicode61')",
  );
  // Facets are an EXACT-match axis and the FTS table cannot serve them.
  // Matching "planning" through the stemmed, prefixed FTS column also returns
  // skills tagged `meal-planning` or `capacity-planning`, because the porter
  // tokenizer splits hyphens and stems the parts — so a browse list built from
  // exact term strings and a drill-down built from FTS disagree about what is
  // in a facet, and the count on the button does not match the rows behind it.
  // This side table stores one row per (skill, term) verbatim, joined back to
  // the FTS rows by rowid so descriptions are not stored twice.
  db.exec("CREATE TABLE skill_terms(ref INTEGER NOT NULL, term TEXT NOT NULL)");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

/** Manifests read (and inserted) per event-loop slice.
 *
 *  This is the whole reason the build is async. node:sqlite exposes only
 *  DatabaseSync, and this repo has no worker_threads anywhere, so there is no
 *  thread to move the work to. Left as one synchronous call, the build is
 *  ~421 ms of fully blocking work on the process that also serves every HTTP
 *  route and holds the SSE stream a paired phone keeps open — a visible freeze,
 *  not a background task.
 *
 *  Measured: 100 manifests per slice stalled the loop for 35 ms at worst. 40
 *  brings the worst slice under ~15 ms — inside a frame at 60 Hz — for the
 *  cost of a few more yields in a build that runs once per app version. */
const BUILD_CHUNK = 40;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function buildIndexFile(target: string, root: string): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  // Build into a private temp file and rename over the target. rename(2) is
  // atomic on POSIX and replaces on Win32 via Node, so a reader either opens
  // the whole old index or the whole new one — never a half-written database.
  // If two harness processes build at once both do the full work and the
  // loser's file is simply replaced; the cost is one wasted 400 ms, and no
  // lock file can be left behind to wedge a later start.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  rmSync(temp, { force: true });
  const db = new DatabaseSync(temp);
  let written = 0;
  try {
    // The file is disposable — it is rebuilt from the library whenever the
    // fingerprint misses — so durability guarantees buy nothing here and cost
    // most of the build time.
    db.exec("PRAGMA journal_mode=OFF");
    db.exec("PRAGMA synchronous=OFF");
    createSchema(db);
    const insert = db.prepare("INSERT INTO skills(id, name, description, terms) VALUES (?, ?, ?, ?)");
    const insertTerm = db.prepare("INSERT INTO skill_terms(ref, term) VALUES (?, ?)");
    for (let start = 0; start < entries.length; start += BUILD_CHUNK) {
      const slice = entries.slice(start, start + BUILD_CHUNK);
      // One transaction per slice. A transaction left open across an await
      // would hold a write lock on this file for the whole build; the file is
      // private to this process, but short transactions keep the temp DB
      // consistent if the process dies mid-build and cost nothing measurable.
      db.exec("BEGIN");
      try {
        for (const entry of slice) {
          const row = indexRow(root, entry);
          if (!row) continue;
          const { lastInsertRowid } = insert.run(row.id, row.name, row.description, row.terms);
          for (const term of new Set(row.terms.split(" ").filter(Boolean))) {
            insertTerm.run(lastInsertRowid, term);
          }
          written += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      await yieldToLoop();
    }
    db.exec("INSERT INTO skills(skills) VALUES('optimize')");
    db.exec("CREATE INDEX skill_terms_term ON skill_terms(term)");
    const meta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    // Fingerprint is taken AFTER the read pass, so a library edited while the
    // build was running produces a key that no longer matches on the next
    // open and rebuilds, rather than stamping a fresh key onto stale rows.
    meta.run("fingerprint", fingerprint(root));
    meta.run("count", String(written));
    meta.run("builtAt", new Date().toISOString());
  } finally {
    db.close();
  }
  renameSync(temp, target);
  // SQLite may leave sidecars next to the temp name; rename moved only the
  // main file, so clear them rather than leaking one per build.
  rmSync(`${temp}-wal`, { force: true });
  rmSync(`${temp}-shm`, { force: true });
  return written;
}

let handle: DatabaseSync | null = null;
let handleFingerprint = "";

function closeHandle(): void {
  try {
    handle?.close();
  } catch {
    // already closed
  }
  handle = null;
  handleFingerprint = "";
}

/** Shared in-flight build. Two searches racing the first build must not start
 *  two 400 ms builds inside one process — they await the same promise. */
let building: Promise<DatabaseSync | null> | null = null;

/** Open the index, building or rebuilding it if it is missing or stale.
 *
 *  Resolves to null when the library is unreadable or SQLite refuses —
 *  retrieval then degrades to "no skill results", never to a thrown request.
 *
 *  Cold start: the first call after an install or an upgrade pays the build
 *  (~421 ms of work, spread across ~23 slices so no single slice blocks the
 *  loop for more than ~20 ms). Every later call re-opens a 2.3 MB file in
 *  ~0.6 ms. The build is triggered by the first search rather than at startup
 *  so that launches which never open the library pay nothing, and it is paid
 *  once per app version, not once per launch. */
async function ensureIndex(): Promise<DatabaseSync | null> {
  const root = SKILL_LIBRARY_ROOT;
  const wanted = fingerprint(root);
  if (handle && handleFingerprint === wanted) return handle;
  if (building) return building;
  if (handle) closeHandle();

  building = (async (): Promise<DatabaseSync | null> => {
    const target = INDEX_FILE();
    try {
      if (existsSync(target)) {
        const existing = new DatabaseSync(target, { readOnly: true });
        try {
          const row = existing.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as
            | { value?: string }
            | undefined;
          if (row?.value === wanted) {
            handle = existing;
            handleFingerprint = wanted;
            return handle;
          }
        } catch {
          // unreadable or wrong shape — fall through and rebuild
        }
        existing.close();
      }
      await buildIndexFile(target, root);
      handle = new DatabaseSync(target, { readOnly: true });
      // Key the cached handle to the fingerprint the build actually stamped,
      // not the one sampled before it started.
      const stamped = handle.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as
        | { value?: string }
        | undefined;
      handleFingerprint = stamped?.value ?? wanted;
      return handle;
    } catch {
      closeHandle();
      return null;
    } finally {
      building = null;
    }
  })();
  return building;
}

/** Drop the cached handle. Tests use this after moving DATA_DIR or the library. */
export function resetSkillIndex(): void {
  closeHandle();
  building = null;
  facetCache = null;
  fingerprintCache = null;
}

export interface SkillIndexStats {
  available: boolean;
  count: number;
  builtAt: string | null;
}

export async function skillIndexStats(): Promise<SkillIndexStats> {
  const db = await ensureIndex();
  if (!db) return { available: false, count: 0, builtAt: null };
  try {
    const count = db.prepare("SELECT value FROM meta WHERE key = 'count'").get() as { value?: string } | undefined;
    const built = db.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get() as { value?: string } | undefined;
    return { available: true, count: Number(count?.value ?? 0), builtAt: built?.value ?? null };
  } catch {
    return { available: false, count: 0, builtAt: null };
  }
}

function rowToHit(row: { id?: unknown; name?: unknown; description?: unknown; terms?: unknown }): SkillHit {
  const terms = typeof row.terms === "string" && row.terms ? row.terms.split(" ").filter(Boolean) : [];
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    terms,
  };
}

/** Ranked skills for a human query.
 *
 *  bm25 weights (id, name, description, terms) = (0, 8, 1, 3). The name is the
 *  strongest signal a person is looking at — someone typing "newsletter" wants
 *  `newsletter-writer` above a project-management skill that mentions
 *  newsletters in passing. Terms sit between the two: curated, but coarse.
 *  bm25() returns a NEGATIVE score in SQLite where more negative is better, so
 *  plain ASC ordering is best-first. */
export async function searchSkills(query: string, limit?: number): Promise<SkillHit[]> {
  const expression = toMatchExpression(query);
  if (!expression) return [];
  const db = await ensureIndex();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, name, description, terms FROM skills " +
          "WHERE skills MATCH ? ORDER BY bm25(skills, 0.0, 8.0, 1.0, 3.0) LIMIT ?",
      )
      .all(expression, clampLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(rowToHit);
  } catch {
    return [];
  }
}

/** Every skill carrying exactly this facet term, alphabetical by name.
 *  This is the zero-typing path: it takes no query at all, only a term the
 *  user clicked, and it matches that term verbatim so the rows returned are
 *  exactly the ones the facet's count promised. */
export async function skillsByFacet(term: string, limit?: number): Promise<SkillHit[]> {
  const wanted = term.trim().toLowerCase();
  if (!wanted) return [];
  const db = await ensureIndex();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT s.id, s.name, s.description, s.terms FROM skill_terms t " +
          "JOIN skills s ON s.rowid = t.ref WHERE t.term = ? ORDER BY s.name LIMIT ?",
      )
      .all(wanted, clampLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(rowToHit);
  } catch {
    return [];
  }
}

let facetCache: { fingerprint: string; facets: Facet[] } | null = null;

/** Browse entry points, counted from the manifests themselves.
 *  Every one of the 2,237 skills carries triggerTerms, so this is derived
 *  data, not a hand-written taxonomy that can drift from the library. */
export async function browseFacets(): Promise<Facet[]> {
  const wanted = fingerprint(SKILL_LIBRARY_ROOT);
  if (facetCache && facetCache.fingerprint === wanted) return facetCache.facets;
  const db = await ensureIndex();
  if (!db) return [];
  let facets: Facet[];
  try {
    const rows = db
      .prepare(
        "SELECT term, count(*) AS n FROM skill_terms GROUP BY term HAVING n >= ? ORDER BY n DESC, term ASC",
      )
      .all(FACET_MIN_COUNT) as Array<{ term?: unknown; n?: unknown }>;
    facets = rows
      .map((row) => ({ term: String(row.term ?? ""), count: Number(row.n ?? 0) }))
      .filter((facet) => facet.term && !FORMAT_TERMS.has(facet.term));
  } catch {
    return [];
  }
  facetCache = { fingerprint: wanted, facets };
  return facets;
}

// ---------------------------------------------------------------------------
// Catalog index — in memory, rebuilt when the catalog changes
// ---------------------------------------------------------------------------

/** Structural minimum this module needs from a catalog entry. Deliberately not
 *  an import of TeamCatalogEntry: the catalog's shape and its local-first
 *  loading are owned elsewhere and are changing under a separate lane. This
 *  consumes whatever that returns. */
export interface SearchableTeam {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  skills: string[];
  requires: { apps: string[] };
}

let catalogDb: DatabaseSync | null = null;
let catalogKey = "";

/** The catalog is 122 entries and indexes in ~1 ms, so it lives in memory and
 *  is rebuilt whenever its contents change. Nothing about it is persisted:
 *  it arrives from a loader this lane does not own, and caching someone
 *  else's data to disk is how two sources of truth start. */
function openCatalog(teams: SearchableTeam[]): DatabaseSync | null {
  const key = `${teams.length}:${teams.map((team) => team.slug).join(",")}`;
  if (catalogDb && catalogKey === key) return catalogDb;
  try {
    catalogDb?.close();
  } catch {
    // already closed
  }
  catalogDb = null;
  catalogKey = "";
  try {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE VIRTUAL TABLE teams USING fts5(" +
        "slug UNINDEXED, name, summary, category, skills, tokenize='porter unicode61')",
    );
    const insert = db.prepare("INSERT INTO teams(slug, name, summary, category, skills) VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const team of teams) {
      // A catalog skill entry is a repo path (teams/<slug>/skills/<id>/SKILL.md).
      // The id is the only searchable part, and its hyphens are split so
      // "newsletter" matches a `launch-newsletter` playbook.
      const skills = team.skills
        .map((path) => path.split("/").filter(Boolean).at(-2) ?? "")
        .join(" ")
        .replace(/-/g, " ");
      insert.run(
        team.slug,
        team.name,
        `${team.summary} ${team.outcome ?? ""} ${team.requires.apps.join(" ")}`,
        team.category,
        skills,
      );
    }
    db.exec("COMMIT");
    catalogDb = db;
    catalogKey = key;
    return db;
  } catch {
    return null;
  }
}

/** Ranked catalog entries for a human query.
 *
 *  Returns slugs only. The panel already holds the full catalog it rendered
 *  from, so shipping the entries back would duplicate 68 KB per keystroke to
 *  say something the caller can look up for free. */
export function searchCatalog(teams: SearchableTeam[], query: string, limit?: number): TeamHit[] {
  const expression = toMatchExpression(query);
  if (!expression || teams.length === 0) return [];
  const db = openCatalog(teams);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT slug FROM teams WHERE teams MATCH ? " +
          "ORDER BY bm25(teams, 0.0, 8.0, 1.0, 2.0, 3.0) LIMIT ?",
      )
      .all(expression, clampLimit(limit)) as Array<{ slug?: unknown }>;
    return rows.map((row) => ({ slug: String(row.slug ?? "") }));
  } catch {
    return [];
  }
}

/** Test seam: forget the in-memory catalog index. */
export function resetCatalogIndex(): void {
  try {
    catalogDb?.close();
  } catch {
    // already closed
  }
  catalogDb = null;
  catalogKey = "";
}
