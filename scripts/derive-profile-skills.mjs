// Derive the `skills` array for a profile from its own primary directive.
//
// WHY THIS EXISTS
// 27 of the 57 single-agent profiles declare ZERO skills. They ship a
// personality and one playbook and nothing the agent can actually reach for.
// The other 30 declare 5-11. Two authoring styles landed in one library; this
// closes the gap without inventing a new field.
//
// WHAT THE "PRIMARY DIRECTIVE" IS
// It already exists: the agent's title + description, the package tagline /
// summary / tags / outcomes, and the playbook (name, summary, triggers,
// instructions). Nothing new is added to the schema. That text is a far richer
// retrieval query than the two words a human types into the library search box,
// so it is what we match against the 2,237 shipped skills.
//
// WHY DERIVE AT BUILD TIME
// The mapping is reviewed once by a human and baked into the JSON, instead of
// being recomputed on every install. Deterministic, zero runtime cost, works
// offline and against a small local model, and a wrong match is visible in a
// diff rather than hidden inside a ranking function.
//
// RETRIEVAL FIDELITY
// The index built here is byte-for-byte the same shape the product's own
// retrieval uses (server/skill-search.ts): fts5(id UNINDEXED, name,
// description, terms) with tokenize='porter unicode61', ranked by
// bm25(0, 8, 1, 3). toMatchExpression below is a deliberate mirror of the
// exported function of the same name. `--verify-parity` checks this script's
// results against the live harness so the mirror cannot silently drift.
// The index is built in memory from skills-library/ so the script needs no
// running harness and no network.
//
// WHY MANY SMALL QUERIES, NOT ONE BIG ONE
// toMatchExpression caps a query at 12 tokens and ORs them. Feeding a
// 10,000-character playbook straight in therefore searches on its first twelve
// words -- usually "You are the ... who ..." -- and finds nothing useful. The
// directive is instead distilled to its salient terms (TF by field weight,
// times IDF over the skill corpus) and issued as several 12-token probes whose
// rankings are fused.
//
// CONFIDENCE IS MEASURED, NOT ASSERTED
// bm25 over an OR query always returns something, so rank alone says nothing.
// The reported score is dominated by `coverage`: how much of the CANDIDATE
// SKILL's own vocabulary (its name and its triggerTerms) appears in the
// profile's directive. A skill whose own words are absent from the directive
// is off-topic no matter where bm25 put it. `--calibrate` scores this against
// the 30 hand-authored profiles, which are the only ground truth available.
//
// Usage:
//   node scripts/derive-profile-skills.mjs                # dry run, all skill-less profiles
//   node scripts/derive-profile-skills.mjs --json         # machine-readable proposal
//   node scripts/derive-profile-skills.mjs --calibrate    # score against hand-authored profiles
//   node scripts/derive-profile-skills.mjs --verify-parity # compare index to the live harness
//   node scripts/derive-profile-skills.mjs --apply        # WRITE the high-confidence mappings
//   node scripts/derive-profile-skills.mjs --apply --min-confidence 0.5 --only book-copy-editor
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = [join(repoRoot, "library", "assistants"), join(repoRoot, "bot-library", "builtins")];
const SKILL_LIBRARY = join(repoRoot, "skills-library");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const options = {
  apply: false,
  json: false,
  calibrate: false,
  verifyParity: false,
  /** Below this a candidate is never proposed at all. */
  floor: 0.28,
  /** Below this --apply refuses to write; the row is reported for a human. */
  minConfidence: 0.45,
  /** Reference shape (smart-trader) carries 11. 5-11 is the house range. */
  maxSkills: 8,
  minSkills: 3,
  only: null,
  candidates: 6,
  harness: "http://127.0.0.1:8799",
};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--apply") options.apply = true;
  else if (arg === "--json") options.json = true;
  else if (arg === "--calibrate") options.calibrate = true;
  else if (arg === "--verify-parity") options.verifyParity = true;
  else if (arg === "--min-confidence") options.minConfidence = Number(process.argv[++i]);
  else if (arg === "--floor") options.floor = Number(process.argv[++i]);
  else if (arg === "--max-skills") options.maxSkills = Number(process.argv[++i]);
  else if (arg === "--candidates") options.candidates = Number(process.argv[++i]);
  else if (arg === "--only") options.only = process.argv[++i];
  else if (arg === "--harness") options.harness = process.argv[++i];
  else throw new Error(`unknown argument: ${arg}`);
}

// ---------------------------------------------------------------------------
// Query sanitising -- mirror of server/skill-search.ts toMatchExpression
// ---------------------------------------------------------------------------

/** MIRROR of the exported toMatchExpression in server/skill-search.ts. Kept as
 *  a copy rather than an import so this build script never drags the server's
 *  DATA_DIR/config graph into a CI run; `--verify-parity` is what stops the
 *  copy from drifting. Any edit here must be made there first. */
export function toMatchExpression(raw) {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .filter((token) => token.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
}

// ---------------------------------------------------------------------------
// Skill corpus
// ---------------------------------------------------------------------------

/** Every skill the on-disk library actually holds. An id that is not in here
 *  installs as nothing: server/index.ts logs and skips it, and
 *  scripts/publish-profiles.mjs drops it from the published catalog. So this
 *  set is also the hard allowlist for anything this script writes. */
function readSkillLibrary() {
  const rows = [];
  for (const entry of readdirSync(SKILL_LIBRARY).sort()) {
    const manifestPath = join(SKILL_LIBRARY, entry, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const terms = Array.isArray(manifest.triggerTerms)
      ? manifest.triggerTerms.filter((t) => typeof t === "string")
      : [];
    rows.push({
      id: typeof manifest.id === "string" && manifest.id ? manifest.id : entry,
      name: typeof manifest.name === "string" && manifest.name ? manifest.name : entry,
      description: typeof manifest.description === "string" ? manifest.description : "",
      terms,
      // A SKILL.md exists for every published skill; without it publish-profiles
      // drops the reference, so absence disqualifies the id here too.
      hasFile: existsSync(join(SKILL_LIBRARY, entry, "SKILL.md")),
    });
  }
  return rows;
}

function buildIndex(skills) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE skills USING fts5(id UNINDEXED, name, description, terms, tokenize='porter unicode61')");
  const insert = db.prepare("INSERT INTO skills(id, name, description, terms) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const skill of skills) insert.run(skill.id, skill.name, skill.description, skill.terms.join(" "));
  db.exec("COMMIT");
  return db;
}

function search(db, query, limit = 20) {
  const expression = toMatchExpression(query);
  if (!expression) return [];
  try {
    return db
      .prepare("SELECT id FROM skills WHERE skills MATCH ? ORDER BY bm25(skills, 0.0, 8.0, 1.0, 3.0) LIMIT ?")
      .all(expression, limit)
      .map((row) => String(row.id));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Words that carry no topic. Two groups: ordinary English function words, and
 *  the words every one of these directives already shares ("you", "user",
 *  "step", "work") -- those rank high by raw frequency and retrieve noise. */
const STOPWORDS = new Set(`a about above after again against all also am an and any are aren as at be because been
before being below between both but by can cannot could did do does doing done down during each else even ever every
few for from further get gets give given goes going got had has have having he her here hers him his how however i if
in into is it its itself just keep let like made make makes many may me might more most much must my need needs never
new no nor not now of off on once one only onto or other others ought our ours out over own per put rather really said
same say says see seen shall she should so some something still such take taken tell than that the their theirs them
then there these they thing things this those though through to together too under until up upon us use used uses using
very was way we well were what when where whether which while who whom why will with within without would yet you your
yours actual actually able across along already always another anyone anything back based become becomes best better
better call called case cases change common complete completely correct current default different does each end enough
example examples exactly first full general good great high include includes including instead itself known large last
least less level line lines list little long look looking lot low main mainly major matter mean means name names next
non note number often old open order part particular people place point points possible present pretty previous problem
process provide provides read ready real reason result results right run running second set sets several short show
shows side simple single small sort specific start stated states sure system table term terms text thing think three
time times top total true try turn two type types unless usually value values version want wants whole whose why wide
word words write writes writing wrote your yourself agent agents assistant bot bots ember embers murage playbook
playbooks skill skills user users human humans profile ask asks asked answer answers question questions job task tasks
step steps rule rules never always must should_not do_not out output outputs input inputs work works working`
  .split(/\s+/)
  .filter(Boolean));

/** Crude, deterministic stem. It exists only so `editing`/`edits`/`editor`
 *  collapse when we measure overlap; FTS5's porter stemmer does the equivalent
 *  on the retrieval side. It does not need to be linguistically right, only
 *  stable. */
function stem(word) {
  let w = word;
  for (const suffix of ["ingly", "edly", "ings", "ies", "ing", "ers", "er", "ed", "es", "s"]) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      if (suffix === "ies") w += "y";
      break;
    }
  }
  return w;
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2 && t.length < 24 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

/** Document frequency of each stem across the 2,237 skills. This is what
 *  separates "manuscript" (rare, discriminating) from "content" (everywhere,
 *  useless as a probe). */
function documentFrequency(skills) {
  const df = new Map();
  for (const skill of skills) {
    const seen = new Set(tokenize(`${skill.name} ${skill.description} ${skill.terms.join(" ")}`).map(stem));
    for (const s of seen) df.set(s, (df.get(s) ?? 0) + 1);
  }
  return df;
}

// ---------------------------------------------------------------------------
// The directive
// ---------------------------------------------------------------------------

/** Pull the primary directive out of a package. NOTHING NEW IS ADDED: this is
 *  a read of fields that already exist. Weights say how much each field is
 *  trusted to describe what the agent is FOR -- tags and playbook triggers are
 *  the most deliberate signal a human wrote, instructions the least focused. */
function directiveOf(pkg) {
  const agent = pkg.agents[0];
  const playbooks = (pkg.playbooks ?? []).filter((p) => (agent.playbooks ?? []).includes(p.key));
  const fields = [
    [5, pkg.name],
    [5, agent.name],
    [6, (pkg.tags ?? []).join(" ")],
    [4, pkg.category],
    [5, pkg.tagline],
    [4, agent.title ?? ""],
    [3, pkg.summary],
    [3, agent.description ?? ""],
    [3, (pkg.outcomes ?? []).join(" ")],
    [4, playbooks.map((p) => p.name).join(" ")],
    [4, playbooks.map((p) => p.triggers.join(" ")).join(" ")],
    [3, playbooks.map((p) => p.summary).join(" ")],
    [1, playbooks.map((p) => p.instructions).join(" ")],
  ];
  return { fields, headline: `${pkg.name} ${pkg.tagline} ${(pkg.tags ?? []).join(" ")}` };
}

/** Salient terms of a directive: field-weighted term frequency times IDF.
 *  A term the skill corpus has never seen (df 0) cannot retrieve anything, so
 *  it is dropped from probes -- but kept in `unknown`, because a directive made
 *  mostly of such terms is exactly the gap case that needs reporting. */
function salientTerms(directive, df, corpusSize) {
  const weight = new Map();
  const surface = new Map();
  for (const [w, text] of directive.fields) {
    for (const token of tokenize(text)) {
      const s = stem(token);
      // Sum of field weights, not raw count: fifty mentions of a word inside a
      // long playbook must not outweigh the tagline it was named in, so the
      // total is passed through sqrt below.
      weight.set(s, (weight.get(s) ?? 0) + w);
      if (!surface.has(s) || token.length < surface.get(s).length) surface.set(s, token);
    }
  }
  const scored = [];
  const unknown = [];
  const raw = new Map();
  for (const [s, w] of weight) {
    const d = df.get(s) ?? 0;
    // A term the corpus has never indexed cannot retrieve anything, so it is
    // kept out of the probes -- but it is still part of what this profile is
    // ABOUT, so it keeps a salience (at maximum rarity) and is reported: a
    // directive made mostly of such terms is exactly the gap case.
    const idf = Math.log(corpusSize / Math.max(1, d));
    const score = Math.sqrt(w) * idf;
    raw.set(s, score);
    if (d === 0) unknown.push(surface.get(s));
    else scored.push({ stem: s, surface: surface.get(s), score, df: d });
  }
  scored.sort((a, b) => b.score - a.score || a.surface.localeCompare(b.surface));
  // Salience in 0..1. This replaces a plain "is the word present anywhere in
  // the directive" test, which a 10,000-character playbook makes almost
  // meaningless -- one passing mention of "vehicle" made a car-maintenance
  // skill look like a match for an estate planner.
  const max = Math.max(0.0001, ...raw.values());
  const salience = new Map([...raw].map(([s, score]) => [s, score / max]));
  return { scored, unknown, salience };
}

const chunk = (values, size) => {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

/** The probes issued for one profile. Each is <= 12 tokens because that is
 *  what the production matcher keeps; several ranked lists fused beat one
 *  truncated list. */
function probesFor(directive, salient) {
  const top = salient.scored.slice(0, 36).map((t) => t.surface);
  const probes = [{ weight: 2.0, query: directive.headline }];
  chunk(top, 12).forEach((group, i) => probes.push({ weight: i === 0 ? 1.6 : 1.0, query: group.join(" ") }));
  return probes.filter((p) => toMatchExpression(p.query));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const RRF_K = 20;

/** How much of the candidate skill's OWN vocabulary the directive contains.
 *  This is the honest half of the score. bm25 asks "does this skill mention a
 *  word the profile used?"; coverage asks "is this skill ABOUT something the
 *  profile is about?", which is the question that decides whether baking the id
 *  in changes the agent for the better or silently makes it do the wrong job.
 *
 *  Name tokens count double: a skill called "Manuscript Style Sheet" is named
 *  after its subject, its description merely discusses it.
 *
 *  Every token is additionally weighted by its IDF, and this is what separates
 *  a real match from a word coincidence. Measured on smart-trader:
 *  `smart-home-setup` matched the directive on "smart" and "setup" -- two words
 *  the corpus is full of -- and scored 0.526 under flat coverage, close enough
 *  to the accept line to be a coin toss. Weighting by IDF drops it while
 *  `chart-analysis` (matching on "chart", "tradingview") rises, because the
 *  rare words are the ones that mean the two documents are about one subject. */
function coverageOf(skill, salience, df, corpusSize) {
  const parts = [];
  for (const t of tokenize(skill.name).map(stem)) parts.push([t, 2]);
  for (const t of tokenize(skill.terms.join(" ")).map(stem)) parts.push([t, 1]);
  let hit = 0;
  let total = 0;
  const counted = new Set();
  for (const [t, w] of parts) {
    if (counted.has(t)) continue;
    counted.add(t);
    // A token the corpus has never indexed still counts against the total: it
    // is maximally rare, so failing to match it is maximally damning.
    const weight = w * Math.log(corpusSize / Math.max(1, df.get(t) ?? 1));
    total += weight;
    hit += weight * (salience.get(t) ?? 0);
  }
  return total === 0 ? 0 : hit / total;
}

// ---------------------------------------------------------------------------
// Skills that belong to somebody else
// ---------------------------------------------------------------------------

/** 107 of the 2,237 skills carry a profile id as a prefix (`beacon-*`, `copy-*`,
 *  `sales-*`, ...) and some of those are written in the second person for that
 *  one assistant. bm25 cannot see the ownership; it put `stage-pitch-deck`
 *  ("**Mode skill.** Default-enabled on the Stage specialist") at the top of the
 *  pitch-deck-creator list.
 *
 *  The prefix ALONE is not ownership, and treating it as such was measured to
 *  be wrong: `copy-editing`, `sales-pitch-deck`, `research-paper-structure` and
 *  `stage-management-guide` are ordinary library skills that merely start with
 *  a profile's name, and a blanket prefix rule silently deleted the single best
 *  candidate the book copy editor had. The `stage` profile itself declares
 *  `sales-pitch-deck`, which settles it.
 *
 *  Ownership is therefore taken from evidence, in two forms:
 *    1. the owning profile DECLARES the prefixed id -- it is demonstrably that
 *       assistant's skill;
 *    2. the prefixed skill's description opens with a bold directive
 *       ("**Mode skill.**", "**When to use.**"), the house style of the Wayland
 *       per-assistant skills. 35 of the 36 such descriptions are owner-prefixed;
 *       none of the ordinary look-alikes above use it. */
export function ownershipIndex(profiles) {
  const owners = new Set();
  const claimed = new Map();
  for (const profile of profiles) {
    for (const id of profile.declared) {
      if (id.startsWith(`${profile.pkg.id}-`)) {
        owners.add(profile.pkg.id);
        claimed.set(id, profile.pkg.id);
      }
    }
  }
  return { owners, claimed };
}

export function belongsToAnother(skill, pkgId, ownership) {
  const claimedBy = ownership.claimed.get(skill.id);
  if (claimedBy && claimedBy !== pkgId) return true;
  if (!skill.description.startsWith("**")) return false;
  for (const owner of ownership.owners) {
    if (owner !== pkgId && skill.id.startsWith(`${owner}-`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recorded review
// ---------------------------------------------------------------------------

/** A human's answer, kept as data so re-running the deriver cannot quietly
 *  undo it. `reject` removes a candidate the ranking liked and a person did
 *  not; `approve` writes one the ranking scored below the accept line.
 *
 *  Only rejections are recorded here so far, and every one is a plain
 *  category error rather than a judgement call -- a video-editing skill on a
 *  book copy editor, a travel-activity planner on a 3D game builder.
 *  Promotions are deliberately NOT pre-filled: a merely plausible match is
 *  exactly the thing that must be approved by a person, because a wrong skill
 *  silently changes what the agent does and is worse than no skill at all. */
export const REVIEW = {
  // A B2B thought-leadership white paper is not a scholarly LaTeX paper.
  "academic-paper": { reject: ["white-paper-writing"] },
  // Wrong medium (video), and the profile's own summary disclaims shaping the
  // book -- "You do not change what the book says or how it is shaped" -- which
  // is exactly what structural and developmental editing are.
  "book-copy-editor": { reject: ["video-editor-guide", "developmental-editor", "structural-editing"] },
  // Wrong medium: audio and video post-production.
  "book-developmental-editor": { reject: ["podcast-editor", "video-editor-guide"] },
  // Travel activities, not 3D scenes.
  "game-3d": { reject: ["adventure-activity-planner"] },
  // "Star Office" is a Murage panel, not a study aid, a home office or a book.
  "star-office-helper": { reject: ["course-companion", "home-office-architect", "reading-companion"] },
  // Matched on "pairings", meaning font pairings.
  "ui-ux-pro-max": { reject: ["wine-pairing"] },
};
function proposeFor(pkg, ctx) {
  const { db, byId, df, corpusSize, ownership } = ctx;
  const directive = directiveOf(pkg);
  const salient = salientTerms(directive, df, corpusSize);
  const probes = probesFor(directive, salient);
  const rejected = new Set(REVIEW[pkg.id]?.reject ?? []);

  const fused = new Map();
  for (const probe of probes) {
    const ids = search(db, probe.query, 25);
    ids.forEach((id, rank) => {
      const row = fused.get(id) ?? { id, rrf: 0, votes: 0 };
      row.rrf += probe.weight / (RRF_K + rank + 1);
      row.votes += 1;
      fused.set(id, row);
    });
  }

  const maxRrf = Math.max(0.0001, ...[...fused.values()].map((r) => r.rrf));
  const scored = [];
  for (const row of fused.values()) {
    const skill = byId.get(row.id);
    if (!skill || !skill.hasFile) continue;
    if (rejected.has(row.id)) continue;
    if (belongsToAnother(skill, pkg.id, ownership)) continue;
    const coverage = coverageOf(skill, salient.salience, df, corpusSize);
    const retrieval = row.rrf / maxRrf;
    const agreement = Math.min(1, row.votes / Math.max(1, probes.length));
    // Coverage dominates on purpose. Retrieval rank only breaks ties between
    // skills the directive genuinely talks about, and agreement rewards a
    // candidate that survived several independent framings of the query.
    const confidence = 0.62 * coverage + 0.23 * retrieval + 0.15 * agreement;
    scored.push({ id: row.id, name: skill.name, coverage, retrieval, agreement, votes: row.votes, confidence });
  }
  scored.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  return { directive, salient, probes, candidates: scored };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function readProfiles() {
  const out = [];
  for (const dir of SOURCES) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
      const path = join(dir, file);
      const raw = readFileSync(path, "utf8");
      const document = JSON.parse(raw);
      const pkg = document.package;
      if (!pkg || !Array.isArray(pkg.agents) || pkg.agents.length !== 1) continue;
      out.push({ path, raw, document, pkg, declared: pkg.agents[0].skills ?? [] });
    }
  }
  return out;
}

/** Write `skills` into the single agent, in the position and formatting the
 *  hand-authored profiles already use (between `appearance` and `playbooks`,
 *  two-space JSON, trailing newline) so the diff is reviewable as content
 *  rather than as a reformat. */
function applySkills(profile, ids) {
  const agent = profile.pkg.agents[0];
  const rebuilt = {};
  for (const [key, value] of Object.entries(agent)) {
    if (key === "playbooks") rebuilt.skills = ids;
    if (key === "skills") continue;
    rebuilt[key] = value;
  }
  if (!("skills" in rebuilt)) rebuilt.skills = ids;
  profile.pkg.agents[0] = rebuilt;
  writeFileSync(profile.path, `${JSON.stringify(profile.document, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** The CLI. Everything above is pure so a test can import this module, compare
 *  its mirrored toMatchExpression against the server's, and exercise the
 *  ownership rules without building an index or writing a file. */
async function main() {
  const skills = readSkillLibrary();
  const byId = new Map(skills.map((s) => [s.id, s]));
  const profiles = readProfiles();
  const ctx = {
    db: buildIndex(skills),
    byId,
    df: documentFrequency(skills),
    corpusSize: skills.length,
    ownership: ownershipIndex(profiles),
  };

  if (options.verifyParity) {
    // The in-memory index must answer the same as the shipped one, or every
    // number this script prints is about a corpus the product does not have.
    const queries = ["trading", "book manuscript style", "powerpoint slides", "3d game", "kubernetes"];
    let mismatches = 0;
    for (const q of queries) {
      const mine = search(ctx.db, q, 8);
      let theirs = null;
      try {
        const res = await fetch(`${options.harness}/api/library/search?q=${encodeURIComponent(q)}&limit=8`, {
          headers: { "x-murage-surface": "desktop" },
        });
        theirs = (await res.json()).skills.map((s) => s.id);
      } catch (error) {
        console.log(`  ${q}: harness unreachable (${error.message}) -- parity unverified`);
        continue;
      }
      const same = JSON.stringify(mine) === JSON.stringify(theirs);
      if (!same) mismatches += 1;
      console.log(`${same ? "OK  " : "DIFF"} ${q}`);
      if (!same) {
        console.log(`     local:   ${mine.join(", ")}`);
        console.log(`     harness: ${theirs.join(", ")}`);
      }
    }
    console.log(mismatches === 0 ? "\nindex parity: identical" : `\nindex parity: ${mismatches} mismatched queries`);
    process.exit(mismatches === 0 ? 0 : 1);
  }

  if (options.calibrate) {
    // Ground truth: the 30 profiles a human already gave skills to. If the
    // deriver cannot rediscover those, its proposals for the other 27 are guesses.
    const authored = profiles.filter((p) => p.declared.length > 0);
    console.log(`Calibrating against ${authored.length} hand-authored profiles.\n`);
    console.log("profile                              declared  top8-hit  recall  mean-conf(hit)  mean-conf(miss)");
    let hits = 0;
    let total = 0;
    const all = [];
    const hitConf = [];
    const missConf = [];
    for (const profile of authored) {
      const { candidates } = proposeFor(profile.pkg, ctx);
      const declared = new Set(profile.declared);
      const top = candidates.slice(0, 8);
      const overlap = top.filter((c) => declared.has(c.id));
      hits += overlap.length;
      total += Math.min(8, declared.size);
      for (const c of candidates.slice(0, 20)) (declared.has(c.id) ? hitConf : missConf).push(c.confidence);
      for (const c of candidates.slice(0, 12)) all.push({ confidence: c.confidence, declared: declared.has(c.id) });
      const recall = declared.size ? overlap.length / Math.min(8, declared.size) : 0;
      console.log(
        `${profile.pkg.id.padEnd(36)} ${String(declared.size).padStart(8)} ${String(overlap.length).padStart(9)} ` +
          `${recall.toFixed(2).padStart(7)}`,
      );
    }
    // Threshold sweep. `precision` here is a LOWER BOUND, not the real number:
    // it counts a candidate as wrong whenever the human did not pick it, and the
    // human picked 8 of the 2,237 -- beacon's own `beacon-email-sequences` scores
    // as a miss. Read it as "how often does a proposal at this score coincide
    // with a human's answer", and use the shape of the curve, not its height.
    console.log("\nthreshold  proposals  agree-with-human  lower-bound precision");
    for (const t of [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]) {
      const kept = all.filter((c) => c.confidence >= t);
      const agree = kept.filter((c) => c.declared).length;
      console.log(
        `${t.toFixed(2).padStart(9)}  ${String(kept.length).padStart(9)}  ${String(agree).padStart(16)}  ` +
          `${(kept.length ? agree / kept.length : 0).toFixed(3).padStart(21)}`,
      );
    }
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`\noverall top-8 recall: ${(hits / total).toFixed(3)} (${hits}/${total})`);
    console.log(`mean confidence, hand-authored candidates: ${mean(hitConf).toFixed(3)} (n=${hitConf.length})`);
    console.log(`mean confidence, everything else:          ${mean(missConf).toFixed(3)} (n=${missConf.length})`);
    process.exit(0);
  }

  // Default target is every skill-less profile. `--only` names one explicitly and
  // is allowed to name a hand-authored one, so a proposal can be eyeballed
  // against a human's answer for the same directive.
  const targets = profiles.filter((p) => (options.only ? p.pkg.id === options.only : p.declared.length === 0));
  const report = [];
  for (const profile of targets) {
    const { candidates, salient } = proposeFor(profile.pkg, ctx);
    const above = candidates.filter((c) => c.confidence >= options.floor).slice(0, options.candidates);
    // A recorded human approval outranks the threshold; the threshold is only
    // there to decide what may be written WITHOUT one.
    const approved = new Set(REVIEW[profile.pkg.id]?.approve ?? []);
    const accepted = candidates
      .filter((c) => c.confidence >= options.minConfidence || approved.has(c.id))
      .slice(0, options.maxSkills);
    const verdict =
      accepted.length >= options.minSkills ? "APPLY" : accepted.length > 0 ? "THIN" : "NO MATCH";
    report.push({
      id: profile.pkg.id,
      path: profile.path.slice(repoRoot.length + 1),
      name: profile.pkg.name,
      category: profile.pkg.category,
      verdict,
      accepted: accepted.map((c) => c.id),
      candidates: above.map((c) => ({
        id: c.id,
        name: c.name,
        confidence: Number(c.confidence.toFixed(3)),
        coverage: Number(c.coverage.toFixed(3)),
        votes: c.votes,
      })),
      salientTerms: salient.scored.slice(0, 10).map((t) => t.surface),
      profile,
    });
  }

  if (options.json) {
    // `profile` carries the parsed document and is dropped: the JSON is a
    // proposal for a person to read, not a copy of the library.
    console.log(JSON.stringify(report.map(({ profile: _profile, ...rest }) => rest), null, 2));
    process.exit(0);
  }

  for (const row of report) {
    console.log(`\n${row.id}  [${row.category}]  ${row.verdict}`);
    console.log(`  directive terms: ${row.salientTerms.join(", ")}`);
    if (row.candidates.length === 0) {
      console.log("  no candidate cleared the floor");
      continue;
    }
    for (const c of row.candidates) {
      const mark = row.accepted.includes(c.id) ? "+" : " ";
      console.log(`  ${mark} ${c.confidence.toFixed(3)}  cov ${c.coverage.toFixed(2)}  x${c.votes}  ${c.id.padEnd(42)} ${c.name}`);
    }
  }

  const counts = { APPLY: 0, THIN: 0, "NO MATCH": 0 };
  for (const row of report) counts[row.verdict] += 1;
  console.log(
    `\n${report.length} skill-less profiles: ${counts.APPLY} applicable, ${counts.THIN} thin, ${counts["NO MATCH"]} with no match ` +
      `(floor ${options.floor}, min-confidence ${options.minConfidence})`,
  );

  if (!options.apply) {
    console.log("\nDRY RUN -- nothing written. Re-run with --apply to write the APPLY rows.");
    process.exit(0);
  }

  let written = 0;
  for (const row of report) {
    if (row.verdict !== "APPLY") continue;
    // Belt and braces: an id that is not in the on-disk library installs as
    // nothing, so it never reaches a file even if scoring says otherwise.
    const ids = row.accepted.filter((id) => byId.has(id) && byId.get(id).hasFile);
    if (ids.length < options.minSkills) continue;
    applySkills(row.profile, ids);
    written += 1;
    console.log(`wrote ${row.path}: ${ids.join(", ")}`);
  }
  console.log(`\n${written} profiles written.`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
