// L-COPY LINT r3 (1.0.18), design section 2: the review ledger checks and the propose/record CLI, on fixtures.
// The live ledger is checked by src/locales/copy-final.test.ts; these prove each failure the lint must report.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEDGER_REQUIRED, PENDING_KEYS, acceptReviewProblems, ledgerFailureMessage, ledgerProblems, loadCopy, readReviewInputs, recordH12, recordId, releasePendingProblems, shippedMap } from "./copy-lint.mjs";
import { main as copyReview, propose, rebuild, record } from "./copy-review.mjs";
import { main as generateLocale } from "./generate-locale.mjs";
import { exactHash } from "./locale-partitions.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

const REVIEWERS = { version: 1, reviewers: [{ kind: "agent", name: "sol-de", account: "gpt-6-sol/acct3" }] };

/** A valid world: two shipped strings, one record by an independent reviewer, a ledger pointing at it. */
function world() {
  const shipped = new Map([["en:a.one", "One"], ["de:a.one", "Eins"]]);
  const english = { "a.one": "One" };
  const files = { "reviewers.json": `${JSON.stringify(REVIEWERS, null, 2)}\n` };
  const doc = {
    version: 1,
    reviewer: REVIEWERS.reviewers[0],
    author: "lcf-translator",
    date: "2026-11-06",
    base: "49f3aac69",
    scope: "fixture",
    strings: {
      "en:a.one": { text: "One", en: "One", verdict: "pass" },
      "de:a.one": { text: "Eins", en: "One", verdict: "pass" },
    },
    files: { "reviewers.json": { text: files["reviewers.json"], verdict: "pass" } },
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const id = recordId("2026-11-06", "fixture", text);
  const ledger = {
    version: 1,
    strings: {
      "en:a.one": { review: id, sha256: exactHash("One") },
      "de:a.one": { review: id, sha256: exactHash("Eins") },
    },
    files: { "reviewers.json": { review: id, sha256: exactHash(files["reviewers.json"]) } },
  };
  return {
    doc, id, shipped, english, files, ledger,
    input: (over = {}) => ({
      shipped, english, files,
      records: { [id]: text },
      ledgerText: JSON.stringify(ledger),
      reviewersText: files["reviewers.json"],
      required: true,
      ...over,
    }),
  };
}

function rewrite(w, mutate) {
  const doc = structuredClone(w.doc);
  mutate(doc);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const id = recordId(doc.date, "fixture", text);
  const ledger = structuredClone(w.ledger);
  for (const entry of [...Object.values(ledger.strings), ...Object.values(ledger.files)]) entry.review = id;
  return { records: { [id]: text }, ledgerText: JSON.stringify(ledger) };
}

describe("review ledger checks (design section 2)", () => {
  it("ships with the ledger-presence check on", () => {
    expect(LEDGER_REQUIRED).toBe(true);
  });

  it("a valid record and ledger pass", () => {
    expect(ledgerProblems(world().input())).toEqual([]);
  });

  it("an entry listed twice in the raw ledger fails, and only that entry", () => {
    const w = world();
    const entry = JSON.stringify(w.ledger.strings["de:a.one"]);
    const ledgerText = JSON.stringify(w.ledger).replace('"de:a.one":', `"de:a.one":${entry},"de:a.one":`);
    expect(ledgerProblems(w.input({ ledgerText }))).toEqual(["reviewed.json: de:a.one: listed twice"]);
  });

  it("a record whose name carries the wrong h12 fails (a record is never edited)", () => {
    const w = world();
    const text = Object.values(w.input().records)[0];
    const edited = text.replace('"scope": "fixture"', '"scope": "fixture, edited"');
    const problems = ledgerProblems(w.input({ records: { [w.id]: edited } }));
    expect(problems.some((p) => p.includes(`h12 ${w.id.slice(-12)} does not match`))).toBe(true);
    expect(recordH12(edited)).not.toBe(w.id.slice(-12));
  });

  it("a reviewer equal to the author fails, and so does one not on reviewers.json", () => {
    const w = world();
    expect(ledgerProblems(w.input(rewrite(w, (doc) => { doc.author = "sol-de"; })))).toEqual(
      expect.arrayContaining([expect.stringMatching(/the reviewer is the author \(sol-de\)/)]),
    );
    expect(ledgerProblems(w.input(rewrite(w, (doc) => { doc.reviewer = { kind: "agent", name: "nobody", account: "x" }; })))).toEqual(
      expect.arrayContaining([expect.stringMatching(/reviewer nobody is not on reviewers\.json/)]),
    );
  });

  it("a record holding different text from the ledger, or a fail verdict, fails", () => {
    const w = world();
    expect(ledgerProblems(w.input(rewrite(w, (doc) => { doc.strings["de:a.one"].text = "Einz"; })))).toEqual([
      expect.stringMatching(/string de:a\.one: record .* holds different text/),
    ]);
    expect(ledgerProblems(w.input(rewrite(w, (doc) => { doc.strings["de:a.one"].verdict = "fail"; })))).toEqual([
      expect.stringMatching(/string de:a\.one: record .* says fail/),
    ]);
  });

  it("live text that changed since review fails (exact hash, no normalisation)", () => {
    const w = world();
    const shipped = new Map(w.shipped);
    shipped.set("de:a.one", "Eins ");
    expect(ledgerProblems(w.input({ shipped }))).toEqual([
      "reviewed.json: string de:a.one: the live text changed since review (sha256 differs)",
    ]);
  });

  it("English that moved since review fails a pack string (re-review)", () => {
    const w = world();
    expect(ledgerProblems(w.input(rewrite(w, (doc) => { doc.strings["de:a.one"].en = "One old"; })))).toEqual([
      "reviewed.json: string de:a.one: the English moved since review (re-review)",
    ]);
  });

  it("an orphan ledger entry, an orphan record and a missing record fail", () => {
    const w = world();
    const ledger = structuredClone(w.ledger);
    ledger.strings["fr:a.gone"] = { review: w.id, sha256: exactHash("Parti") };
    expect(ledgerProblems(w.input({ ledgerText: JSON.stringify(ledger) }))).toEqual([
      "reviewed.json: string fr:a.gone: orphan (names no shipped string)",
    ]);
    const spare = `2026-11-06-spare-${recordH12("{}\n")}`;
    expect(ledgerProblems(w.input({ records: { ...w.input().records, [spare]: "{}\n" } }))).toEqual(expect.arrayContaining([
      `reviews/${spare}.json: orphan record (no ledger entry points to it; delete it)`,
    ]));
    const missing = structuredClone(w.ledger);
    missing.strings["de:a.one"].review = "2026-11-06-gone-aaaaaaaaaaaa";
    expect(ledgerProblems(w.input({ ledgerText: JSON.stringify(missing) }))).toEqual(expect.arrayContaining([
      "reviewed.json: string de:a.one: record 2026-11-06-gone-aaaaaaaaaaaa does not exist",
    ]));
  });

  it("a shipped string or pinned file with no ledger entry fails when the ledger is required, and only then", () => {
    const w = world();
    const shipped = new Map(w.shipped);
    shipped.set("de:a.two", "Zwei");
    const files = { ...w.files, "links.json": "{}\n" };
    expect(ledgerProblems(w.input({ shipped, files }))).toEqual([
      "reviewed.json: string de:a.two: no review entry",
      "reviewed.json: file links.json: no review entry",
    ]);
    expect(ledgerProblems(w.input({ shipped, files, required: false }))).toEqual([]);
  });
});

function locales() {
  const dir = mkdtempSync(join(tmpdir(), "murage-copy-review-"));
  dirs.push(dir);
  const put = (rel, value) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  put("en.json", { "a.one": "One", "a.two": "Bad — dash" });
  put("en-ux/x.json", {});
  put("en-help/h.json", { "ux.h.tip": "Tip" });
  put("de.json", { "a.one": "Eins", "a.two": "Schlecht" });
  put("help/de.json", { "ux.h.tip": "Tipp" });
  put("copy-lint/reviewers.json", REVIEWERS);
  put("copy-lint/links.json", {});
  put("copy-lint/same-as-english.json", {});
  put("copy-lint/english-only.json", { keys: [] });
  put("copy-lint/pending-review.json", { version: 1, strings: {} });
  return dir;
}

describe("copy-review CLI (propose, record)", () => {
  it("propose lists every unreviewed string and pinned file, and refuses a string that fails a rule", () => {
    const dir = locales();
    const { bundle, refused } = propose({ dir, base: "abc123", author: "lcf-translator" });
    expect(refused).toEqual(["en:a.two: an em dash or spaced en dash"]);
    expect(Object.keys(bundle.strings).sort()).toEqual(["de:a.one", "de:a.two", "de:ux.h.tip", "en:a.one", "en:ux.h.tip"]);
    expect(bundle.strings["de:ux.h.tip"]).toEqual({ text: "Tipp", en: "Tip", verdict: "", note: "" });
    expect(Object.keys(bundle.files).sort()).toEqual(["english-only.json", "links.json", "pending-review.json", "reviewers.json", "same-as-english.json"]);
  });

  it("record writes a content-addressed record and points the ledger at pass entries only", () => {
    const dir = locales();
    const { bundle } = propose({ dir, base: "abc123", author: "lcf-translator" });
    for (const item of Object.values(bundle.strings)) item.verdict = "pass";
    bundle.strings["de:a.two"].verdict = "fail";
    bundle.strings["de:a.two"].note = "means bad, not wrong";
    for (const item of Object.values(bundle.files)) item.verdict = "pass";
    const result = record({ dir, bundle, reviewer: "sol-de", slug: "fixture", date: "2026-11-06" });
    const files = readdirSync(join(dir, "copy-lint/reviews"));
    expect(files).toEqual([`${result.id}.json`]);
    const text = readFileSync(join(dir, "copy-lint/reviews", files[0]), "utf8");
    expect(result.id).toBe(recordId("2026-11-06", "fixture", text));
    const ledger = JSON.parse(readFileSync(join(dir, "copy-lint/reviewed.json"), "utf8"));
    expect(Object.keys(ledger.strings).sort()).toEqual(["de:a.one", "de:ux.h.tip", "en:a.one", "en:ux.h.tip"]);
    expect(Object.keys(ledger.files).sort()).toEqual(["english-only.json", "links.json", "pending-review.json", "reviewers.json", "same-as-english.json"]);
    // The lint accepts what record wrote; only the refused and failed strings still lack an entry.
    const copy = loadCopy(dir);
    const problems = ledgerProblems({ ...readReviewInputs(dir), shipped: shippedMap(copy), english: copy.english, required: true });
    expect(problems).toEqual(["reviewed.json: string en:a.two: no review entry", "reviewed.json: string de:a.two: no review entry"]);
    // A second propose offers only what is still unreviewed.
    expect(Object.keys(propose({ dir, base: "abc124", author: "lcf-translator" }).bundle.strings)).toEqual(["de:a.two"]);
  });

  it("record refuses the author as reviewer, an unknown reviewer, an empty verdict and text that changed", () => {
    const dir = locales();
    const fresh = () => {
      const { bundle } = propose({ dir, base: "abc123", author: "lcf-translator" });
      for (const item of [...Object.values(bundle.strings), ...Object.values(bundle.files)]) item.verdict = "pass";
      return bundle;
    };
    expect(() => record({ dir, bundle: { ...fresh(), author: "sol-de" }, reviewer: "sol-de" })).toThrow(/the reviewer is the author/);
    expect(() => record({ dir, bundle: fresh(), reviewer: "nobody" })).toThrow(/not on copy-lint\/reviewers\.json/);
    const empty = fresh();
    empty.strings["de:a.one"].verdict = "";
    expect(() => record({ dir, bundle: empty, reviewer: "sol-de" })).toThrow(/de:a\.one: verdict must be pass or fail/);
    const changed = fresh();
    writeFileSync(join(dir, "de.json"), `${JSON.stringify({ "a.one": "Einz", "a.two": "Schlecht" }, null, 2)}\n`);
    expect(() => record({ dir, bundle: changed, reviewer: "sol-de" })).toThrow(/de:a\.one: the shipped text changed since propose/);
    expect(readdirSync(join(dir, "copy-lint")).includes("reviews")).toBe(false);
  });
});

const PENDING_KEY = "ux.l1.level.unlimitedDetail";

/** Clean strings, one allowed key listed as pending in en and de, and a passing record for everything else. */
function pendingWorld() {
  const dir = locales();
  const put = (rel, value) => writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
  put("en.json", { "a.one": "One", "a.two": "Two", [PENDING_KEY]: "Detail" });
  put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Genaues" });
  const list = { [`en:${PENDING_KEY}`]: exactHash("Detail"), [`de:${PENDING_KEY}`]: exactHash("Genaues") };
  put("copy-lint/pending-review.json", { version: 1, strings: list });
  const review = () => {
    const { bundle } = propose({ dir, base: "abc123", author: "lcf-translator" });
    for (const item of [...Object.values(bundle.strings), ...Object.values(bundle.files)]) item.verdict = "pass";
    return { bundle, result: record({ dir, bundle, reviewer: "sol-de", slug: "fixture", date: "2026-11-06" }) };
  };
  const { bundle } = review();
  const lint = () => {
    const copy = loadCopy(dir);
    return ledgerProblems({ ...readReviewInputs(dir), shipped: shippedMap(copy), english: copy.english, required: true });
  };
  return { dir, put, list, bundle, review, lint };
}

function quietAccept(dir) {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    generateLocale(["de", "--accept"], { dir });
  } finally {
    log.mockRestore();
  }
}

describe("pending review list", () => {
  it("keeps the four historical No limits keys reviewed, with none pending in the shipped packs", () => {
    expect(PENDING_KEYS).toEqual([
      "ux.l1.confirm.unlimitedBody",
      "ux.l1.level.unlimitedDetail",
      "ux.lcopyb.level.unlimited",
      "ux.lcopyb.level.unlimitedHere",
    ]);
    const dir = fileURLToPath(new URL("../src/locales", import.meta.url));
    const inputs = readReviewInputs(dir);
    const ledger = JSON.parse(inputs.ledgerText);
    expect(JSON.parse(readFileSync(join(dir, "copy-lint/pending-review.json"), "utf8")).strings).toEqual({});
    const copy = loadCopy(dir);
    const shipped = shippedMap(copy);
    for (const locale of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      for (const key of PENDING_KEYS) {
        const id = `${locale}:${key}`;
        expect(ledger.strings[id]?.sha256, id).toBe(exactHash(shipped.get(id)));
      }
    }
    expect(ledgerProblems({ ...inputs, shipped, english: copy.english })).toEqual([]);
  });

  it("excepts a listed key at its exact hash, and propose leaves it out", () => {
    const w = pendingWorld();
    expect(w.lint()).toEqual([]);
    expect(Object.keys(w.bundle.strings)).not.toContain(`de:${PENDING_KEY}`);
    expect(Object.keys(w.bundle.strings)).not.toContain(`en:${PENDING_KEY}`);
  });

  it("a fifth key on the list fails", () => {
    const w = pendingWorld();
    w.put("copy-lint/pending-review.json", { version: 1, strings: { ...w.list, "de:a.one": exactHash("Eins") } });
    expect(w.lint()).toEqual(expect.arrayContaining(["pending-review.json: de:a.one: not one of its 4 allowed keys"]));
  });

  it("a language outside the app on the list fails", () => {
    const w = pendingWorld();
    w.put("copy-lint/pending-review.json", { version: 1, strings: { ...w.list, [`xx:${PENDING_KEY}`]: exactHash("x") } });
    expect(w.lint()).toEqual(expect.arrayContaining([`pending-review.json: xx:${PENDING_KEY}: not one of its 4 allowed keys`]));
  });

  it("a changed text on a listed key without a record fails", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Anders" });
    expect(w.lint()).toEqual([`pending-review.json: de:${PENDING_KEY}: the live text changed since it was listed (needs a review record)`]);
  });

  it("changing the text and the listed hash together, with no record, still fails", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Anders" });
    w.put("copy-lint/pending-review.json", { version: 1, strings: { ...w.list, [`de:${PENDING_KEY}`]: exactHash("Anders") } });
    expect(w.lint()).toEqual(["reviewed.json: file pending-review.json: the live text changed since review (sha256 differs)"]);
  });

  it("a changed text on any other string without a record fails", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    expect(w.lint()).toEqual(["reviewed.json: string de:a.two: the live text changed since review (sha256 differs)"]);
  });

  it("a listed key that gains a review entry must leave the list", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Anders" });
    w.review();
    expect(w.lint()).toEqual(expect.arrayContaining([`pending-review.json: de:${PENDING_KEY}: has a review entry, remove it from this list`]));
  });
});

describe("generate-locale --accept needs a review record", () => {
  const hashes = (dir) => readFileSync(join(dir, "source-hashes.json"), "utf8");

  it("accepts a pack whose strings hold records or sit on the list at their hash", () => {
    const w = pendingWorld();
    quietAccept(w.dir);
    expect(Object.keys(JSON.parse(hashes(w.dir)).locales.de).sort()).toEqual(["a.one", "a.two", PENDING_KEY].sort());
  });

  it("refuses a changed translation with no record and writes nothing", () => {
    const w = pendingWorld();
    w.put("source-hashes.json", { version: 1, locales: {} });
    const before = hashes(w.dir);
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*de:a\.two/);
    expect(hashes(w.dir)).toBe(before);
  });

  it("refuses a changed English source with no record", () => {
    const w = pendingWorld();
    w.put("en.json", { "a.one": "One", "a.two": "Second", [PENDING_KEY]: "Detail" });
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*en:a\.two/);
  });

  it("refuses a listed key whose text changed", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Anders" });
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*the live text changed since it was listed/);
  });

  it("refuses a malformed ledger with no records, and writes nothing", () => {
    const w = pendingWorld();
    for (const name of readdirSync(join(w.dir, "copy-lint/reviews"))) rmSync(join(w.dir, "copy-lint/reviews", name));
    w.put("copy-lint/reviewed.json", {});
    w.put("source-hashes.json", { version: 1, locales: {} });
    const before = hashes(w.dir);
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*reviewed\.json: expected/);
    expect(hashes(w.dir)).toBe(before);
  });

  it.each([["null", null], ["false", false], ["0", 0], ["an empty string", ""], ["an array", []], ["null strings", { version: 1, strings: null, files: {} }], ["null files", { version: 1, strings: {}, files: null }], ["array strings", { version: 1, strings: [], files: {} }]])("refuses a ledger holding %s, with or without records, and writes nothing", (_name, value) => {
    for (const dropRecords of [true, false]) {
      const w = pendingWorld();
      if (dropRecords) for (const name of readdirSync(join(w.dir, "copy-lint/reviews"))) rmSync(join(w.dir, "copy-lint/reviews", name));
      w.put("copy-lint/reviewed.json", value);
      w.put("source-hashes.json", { version: 1, locales: {} });
      const before = hashes(w.dir);
      expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*reviewed\.json: expected/);
      expect(hashes(w.dir)).toBe(before);
    }
  });

  it("refuses a listed key whose text and listed hash changed together, and writes nothing", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Zwei", [PENDING_KEY]: "Anders" });
    w.put("copy-lint/pending-review.json", { version: 1, strings: { ...w.list, [`de:${PENDING_KEY}`]: exactHash("Anders") } });
    w.put("source-hashes.json", { version: 1, locales: {} });
    const before = hashes(w.dir);
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*file pending-review\.json/);
    expect(hashes(w.dir)).toBe(before);
  });

  it("refuses a pinned lint file that changed", () => {
    const w = pendingWorld();
    w.put("copy-lint/links.json", { "de:a.one": ["x"] });
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*file links\.json/);
  });

  it("a problem only in another language does not stop this pack", () => {
    const w = pendingWorld();
    w.put("fr.json", { "a.one": "Un" });
    expect(acceptReviewProblems("de", w.dir).filter((p) => p.includes("fr:"))).toEqual([]);
    expect(acceptReviewProblems("fr", w.dir).some((p) => p.includes("string fr:a.one"))).toBe(true);
  });

  it("accepts the same change once its record exists", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    w.review();
    quietAccept(w.dir);
  });
});

describe("release gate: the pending list is empty at the cut", () => {
  const SCRIPTS = dirname(fileURLToPath(import.meta.url));

  it("a listed id, a missing file or an unreadable file each stop the release; an empty list does not", () => {
    const w = pendingWorld();
    expect(releasePendingProblems(w.dir).sort()).toEqual([
      `pending-review.json: de:${PENDING_KEY}: still has no review record`,
      `pending-review.json: en:${PENDING_KEY}: still has no review record`,
    ]);
    w.put("copy-lint/pending-review.json", { version: 1, strings: {} });
    expect(releasePendingProblems(w.dir)).toEqual([]);
    writeFileSync(join(w.dir, "copy-lint/pending-review.json"), "{");
    expect(releasePendingProblems(w.dir)[0]).toMatch(/not valid JSON/);
    expect(releasePendingProblems(locales().replace(/$/, "-absent"))).toEqual(["pending-review.json: missing"]);
  });

  it("the check exits non-zero exactly when the shipped list holds an id", () => {
    const run = spawnSync(process.execPath, [join(SCRIPTS, "copy-pending-check.mjs")], { encoding: "utf8" });
    expect(run.status).toBe(releasePendingProblems().length > 0 ? 1 : 0);
  });

  it("release.yml runs the check in prepare, on every release, and may not continue past it", () => {
    const yml = readFileSync(join(SCRIPTS, "../.github/workflows/release.yml"), "utf8");
    const prepare = yml.slice(yml.indexOf("\n  prepare:\n"), yml.indexOf("\n  ci-gate:\n"));
    const step = prepare.slice(prepare.indexOf("- name: Require a review record for every shipped string"));
    const body = step.slice(0, step.indexOf("\n      - name:", 10));
    expect(body).toContain("if: steps.pin.outputs.should_release == 'true'");
    expect(body).toContain("run: node scripts/copy-pending-check.mjs");
    expect(body).not.toContain("continue-on-error");
    expect(body).not.toContain("||");
  });
});

describe("the copy-final failure message", () => {
  it("names the string, gives propose, Sol and record, and never offers --accept", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    const message = ledgerFailureMessage(w.lint());
    expect(message).toContain("de:a.two");
    expect(message).toMatch(/copy-review\.mjs propose/);
    expect(message).toMatch(/Sol reads the bundle/);
    expect(message).toMatch(/copy-review\.mjs record/);
    expect(message).not.toContain("--accept");
  });

  it("states how a reviewed.json merge conflict resolves", () => {
    expect(ledgerFailureMessage([])).toMatch(/merge conflict in copy-lint\/reviewed\.json[\s\S]*copy-review\.mjs rebuild/);
  });
});

describe("copy-review rebuild", () => {
  const ledgerOf = (dir) => JSON.parse(readFileSync(join(dir, "copy-lint/reviewed.json"), "utf8"));

  // Every record date below is checked against today UTC, so the clock is fixed. Only Date is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T12:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a conflicted reviewed.json comes back whole from the records, byte for byte", () => {
    const w = pendingWorld();
    const good = readFileSync(join(w.dir, "copy-lint/reviewed.json"), "utf8");
    writeFileSync(join(w.dir, "copy-lint/reviewed.json"), `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> other\n`);
    expect(w.lint()[0]).toMatch(/not valid JSON/);
    rebuild({ dir: w.dir });
    expect(readFileSync(join(w.dir, "copy-lint/reviewed.json"), "utf8")).toBe(good);
    expect(w.lint()).toEqual([]);
  });

  it("gives no entry to text that changed since its record, or to a string whose newest record failed it", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Anders", "a.two": "Zwei", [PENDING_KEY]: "Genaues" });
    rebuild({ dir: w.dir });
    expect(Object.keys(ledgerOf(w.dir).strings)).not.toContain("de:a.one");
    expect(Object.keys(ledgerOf(w.dir).strings)).toContain("de:a.two");

    const { bundle } = propose({ dir: w.dir, base: "abc124", author: "lcf-translator", only: "de:a.one" });
    bundle.strings["de:a.one"].verdict = "fail";
    record({ dir: w.dir, bundle, reviewer: "sol-de", slug: "fixture", date: "2026-11-07" });
    rebuild({ dir: w.dir });
    expect(Object.keys(ledgerOf(w.dir).strings)).not.toContain("de:a.one");
  });

  const verdictOn = (w, verdict, slug, date) => record({
    dir: w.dir,
    reviewer: "sol-de",
    slug,
    date,
    bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", strings: { "de:a.one": { text: "Eins", en: "One", verdict } }, files: {} },
  });

  it("a later fail of the very text an older record passed removes the entry", () => {
    const w = pendingWorld();
    verdictOn(w, "fail", "a-new", "2026-11-07");
    rebuild({ dir: w.dir });
    expect(Object.keys(ledgerOf(w.dir).strings)).not.toContain("de:a.one");
  });

  it("a later pass of the very text an older record failed gives the entry", () => {
    const w = pendingWorld();
    verdictOn(w, "fail", "b-mid", "2026-11-07");
    verdictOn(w, "pass", "a-new", "2026-11-08");
    rebuild({ dir: w.dir });
    expect(Object.keys(ledgerOf(w.dir).strings)).toContain("de:a.one");
  });

  it("a record of older English neither gives nor removes an entry", () => {
    const w = pendingWorld();
    record({
      dir: w.dir, reviewer: "sol-de", slug: "old-english", date: "2026-11-07",
      bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", strings: {}, files: { "links.json": { text: readFileSync(join(w.dir, "copy-lint/links.json"), "utf8"), verdict: "pass" } } },
    });
    const text = readFileSync(join(w.dir, "copy-lint/reviews", readdirSync(join(w.dir, "copy-lint/reviews")).find((f) => f.includes("old-english"))), "utf8");
    const doc = JSON.parse(text);
    doc.strings = { "de:a.one": { text: "Eins", en: "One before", verdict: "fail" } };
    const edited = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(join(w.dir, "copy-lint/reviews", `${recordId("2026-11-07", "old-english", edited)}.json`), edited);
    rebuild({ dir: w.dir });
    expect(Object.keys(ledgerOf(w.dir).strings)).toContain("de:a.one");
  });

  it("gives no entry to a translation whose English moved", () => {
    const w = pendingWorld();
    w.put("en.json", { "a.one": "First", "a.two": "Two", [PENDING_KEY]: "Detail" });
    rebuild({ dir: w.dir });
    const strings = Object.keys(ledgerOf(w.dir).strings);
    expect(strings).not.toContain("de:a.one");
    expect(strings).not.toContain("en:a.one");
    expect(strings).toContain("de:a.two");
  });

  const fileText = (w) => readFileSync(join(w.dir, "copy-lint/links.json"), "utf8");
  const fileVerdictOn = (w, verdict, slug, date) => record({
    dir: w.dir,
    reviewer: "sol-de",
    slug,
    date,
    bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", strings: {}, files: { "links.json": { text: fileText(w), verdict } } },
  });
  /** Writes a record straight to disk, as a merge or a hand edit would: record itself refuses these. */
  const placeRecord = (w, date, slug, content, nameDate = date) => {
    const text = `${JSON.stringify({ version: 1, reviewer: { kind: "agent", name: "sol-de", account: "gpt-6-sol/acct3" }, author: "lcf-translator", date, base: "abc125", scope: "fixture", strings: {}, files: {}, ...content }, null, 2)}\n`;
    const id = recordId(nameDate, slug, text);
    writeFileSync(join(w.dir, "copy-lint/reviews", `${id}.json`), text);
    return id;
  };
  const rawLedger = (w) => readFileSync(join(w.dir, "copy-lint/reviewed.json"), "utf8");
  const dropRecord = (w, id) => rmSync(join(w.dir, "copy-lint/reviews", `${id}.json`));

  describe.each([
    ["string", "de:a.one", "strings", verdictOn, (w, verdict) => ({ strings: { "de:a.one": { text: "Eins", en: "One", verdict } } })],
    ["lint file", "links.json", "files", fileVerdictOn, (w, verdict) => ({ files: { "links.json": { text: fileText(w), verdict } } })],
  ])("newest date decides a %s", (_kind, label, section, reviewOn, content) => {
    const entryOf = (w) => ledgerOf(w.dir)[section][label];
    /** A record that arrived by a merge: record itself refuses a same-date conflict. */
    const merged = (w, verdict, slug, date) => ({ id: placeRecord(w, date, slug, content(w, verdict)) });

    it("a same-date conflict then a later pass gives the entry, from the later record", () => {
      const w = pendingWorld();
      merged(w, "fail", "a-conflict", "2026-11-07");
      merged(w, "pass", "z-conflict", "2026-11-07");
      const later = reviewOn(w, "pass", "m-later", "2026-11-08");
      rebuild({ dir: w.dir });
      expect(entryOf(w).review).toBe(later.id);
    });

    it("a same-date conflict then a later fail gives no entry and does not refuse", () => {
      const w = pendingWorld();
      merged(w, "fail", "a-conflict", "2026-11-07");
      merged(w, "pass", "z-conflict", "2026-11-07");
      reviewOn(w, "fail", "m-later", "2026-11-08");
      rebuild({ dir: w.dir });
      expect(entryOf(w)).toBeUndefined();
    });

    it.each([["a-fail", "z-pass"], ["z-fail", "a-pass"]])("a same-date pass and fail gives no entry and rebuild names the id and both records (%s, %s)", (failSlug, passSlug) => {
      const w = pendingWorld();
      const failed = merged(w, "fail", failSlug, "2026-11-07");
      const passed = merged(w, "pass", passSlug, "2026-11-07");
      const { conflicts } = rebuild({ dir: w.dir });
      expect(entryOf(w)).toBeUndefined();
      expect(conflicts).toEqual([`${label}: ${failed.id} fails it and ${passed.id} passes it on 2026-11-07; the fail wins, no entry`]);
    });

    it("the CLI states every route when a fail wins, and rebuild does not get stuck", () => {
      const w = pendingWorld();
      merged(w, "fail", "a-fail", "2026-11-07");
      merged(w, "pass", "z-pass", "2026-11-07");
      const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        copyReview(["rebuild"], { dir: w.dir });
        const text = said.mock.calls.flat().join("\n");
        expect(text).toContain(label);
        expect(text).toMatch(/new text gets a new review/);
        expect(text).toMatch(/a pass of this text arrives on a later UTC date/);
        expect(text).toMatch(/has not merged yet: drop that record from your lane, then run rebuild/);
      } finally {
        said.mockRestore();
        log.mockRestore();
      }
      expect(entryOf(w)).toBeUndefined();
    });

    it("dropping an unmerged wrong fail clears it today, and the pass stands", () => {
      const w = pendingWorld();
      const failed = merged(w, "fail", "a-fail", "2026-11-10");
      const passed = merged(w, "pass", "z-pass", "2026-11-10");
      rebuild({ dir: w.dir });
      expect(entryOf(w)).toBeUndefined();
      dropRecord(w, failed.id);
      rebuild({ dir: w.dir });
      expect(entryOf(w).review).toBe(passed.id);
    });

    it("dropping a wrong pass leaves the fail standing", () => {
      const w = pendingWorld();
      merged(w, "fail", "a-fail", "2026-11-10");
      const passed = merged(w, "pass", "z-pass", "2026-11-10");
      dropRecord(w, passed.id);
      rebuild({ dir: w.dir });
      expect(entryOf(w)).toBeUndefined();
    });

    it.each([["a-one", "z-two"], ["z-two", "a-one"]])("several passes on the newest date give the first by name, whatever order they came in (%s, %s)", (first, second) => {
      const w = pendingWorld();
      reviewOn(w, "pass", first, "2026-11-07");
      reviewOn(w, "pass", second, "2026-11-07");
      rebuild({ dir: w.dir });
      const review = entryOf(w).review;
      expect(review).toMatch(/^2026-11-07-a-one-/);
      const held = JSON.parse(readFileSync(join(w.dir, "copy-lint/reviews", `${review}.json`), "utf8"))[section][label];
      expect(held.verdict).toBe("pass");
      expect(entryOf(w).sha256).toBe(exactHash(held.text));
    });

    it("every pass that can win holds the live text: a same-date record of other text neither wins nor conflicts", () => {
      const w = pendingWorld();
      const other = section === "strings"
        ? { strings: { [label]: { text: "Anders", en: "One", verdict: "pass" } } }
        : { files: { [label]: { text: "{ \"other\": [] }\n", verdict: "pass" } } };
      const otherFail = section === "strings"
        ? { strings: { [label]: { text: "Anders", en: "One", verdict: "fail" } } }
        : { files: { [label]: { text: "{ \"other\": [] }\n", verdict: "fail" } } };
      placeRecord(w, "2026-11-07", "a-other-pass", other);
      placeRecord(w, "2026-11-07", "a-other-fail", otherFail);
      const passed = reviewOn(w, "pass", "z-live", "2026-11-07");
      rebuild({ dir: w.dir });
      expect(entryOf(w).review).toBe(passed.id);
      expect(entryOf(w).sha256).toBe(exactHash(section === "strings" ? "Eins" : fileText(w)));
    });

    it("a newer record of other text does not hide the newest record of the live text", () => {
      const w = pendingWorld();
      const other = section === "strings"
        ? { strings: { [label]: { text: "Anders", en: "One", verdict: "fail" } } }
        : { files: { [label]: { text: "{ \"other\": [] }\n", verdict: "fail" } } };
      const passed = reviewOn(w, "pass", "m-live", "2026-11-07");
      placeRecord(w, "2026-11-08", "z-other", other);
      rebuild({ dir: w.dir });
      expect(entryOf(w).review).toBe(passed.id);
    });

    it("a future pass cannot beat today's fail: rebuild refuses it by name and writes nothing", () => {
      const w = pendingWorld();
      reviewOn(w, "fail", "real", "2026-11-10");
      const future = placeRecord(w, "2099-01-01", "future", content(w, "pass"));
      const before = rawLedger(w);
      expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(`${future}: date must not be after today UTC \\(2026-11-10\\): 2099-01-01`));
      expect(rawLedger(w)).toBe(before);
    });

    it("record agrees with rebuild: a later fail of a text an older record passed removes its entry, byte for byte", () => {
      const w = pendingWorld();
      reviewOn(w, "fail", "later", "2026-11-07");
      const written = rawLedger(w);
      expect(entryOf(w)).toBeUndefined();
      rebuild({ dir: w.dir });
      expect(rawLedger(w)).toBe(written);
    });

    it("record agrees with rebuild: a backdated pass cannot bring back what a newer fail removed", () => {
      const w = pendingWorld();
      reviewOn(w, "fail", "newer", "2026-11-08");
      reviewOn(w, "pass", "backdated", "2026-11-07");
      const written = rawLedger(w);
      expect(entryOf(w)).toBeUndefined();
      rebuild({ dir: w.dir });
      expect(rawLedger(w)).toBe(written);
    });

    it.each([["a-one", "z-two"], ["z-two", "a-one"]])("record agrees with rebuild on several passes on one date, whatever order they came in (%s, %s)", (first, second) => {
      const w = pendingWorld();
      reviewOn(w, "pass", first, "2026-11-07");
      reviewOn(w, "pass", second, "2026-11-07");
      const written = rawLedger(w);
      expect(entryOf(w).review).toMatch(/^2026-11-07-a-one-/);
      rebuild({ dir: w.dir });
      expect(rawLedger(w)).toBe(written);
    });

    it.each([["fail", "pass"], ["pass", "fail"]])("record writes a same-date conflict and the fail wins at once, identical to rebuild (%s, then %s)", (firstVerdict, secondVerdict) => {
      const w = pendingWorld();
      const firstRecord = reviewOn(w, firstVerdict, "first", "2026-11-07");
      const secondRecord = reviewOn(w, secondVerdict, "second", "2026-11-07");
      expect(entryOf(w)).toBeUndefined();
      expect(secondRecord.conflicts.join("\n")).toContain(label);
      expect(secondRecord.conflicts.join("\n")).toContain(firstRecord.id);
      const names = readdirSync(join(w.dir, "copy-lint/reviews"));
      expect(names).toContain(`${firstRecord.id}.json`);
      expect(names).toContain(`${secondRecord.id}.json`);
      const written = rawLedger(w);
      rebuild({ dir: w.dir });
      expect(rawLedger(w)).toBe(written);
    });

    it("a record holding only a fail stays as evidence: the lint does not call it an orphan", () => {
      const w = pendingWorld();
      const failed = reviewOn(w, "fail", "evidence", "2026-11-07");
      expect(w.lint().filter((problem) => problem.includes(failed.id))).toEqual([]);
    });

    it("a record with no fail and no entry is still an orphan", () => {
      const w = pendingWorld();
      reviewOn(w, "fail", "newer", "2026-11-08");
      const backdated = reviewOn(w, "pass", "backdated", "2026-11-07");
      expect(w.lint()).toContain(`reviews/${backdated.id}.json: orphan record (no ledger entry points to it; delete it)`);
    });

    it("record refuses a future date, writes no record and leaves the ledger alone", () => {
      const w = pendingWorld();
      const before = rawLedger(w);
      const names = readdirSync(join(w.dir, "copy-lint/reviews"));
      expect(() => reviewOn(w, "pass", "future", "2099-01-01")).toThrow(/date must not be after today UTC \(2026-11-10\): 2099-01-01/);
      expect(rawLedger(w)).toBe(before);
      expect(readdirSync(join(w.dir, "copy-lint/reviews"))).toEqual(names);
    });
  });

  describe.each([
    ["string", "de:a.one", "strings", (w, verdict) => ({ strings: { "de:a.one": { text: "Eins", en: "One", verdict } } })],
    ["lint file", "links.json", "files", (w, verdict) => ({ files: { "links.json": { text: fileText(w), verdict } } })],
  ])("the lint follows the same rule for a %s", (_kind, label, section, content) => {
    it.each([["a later", "2026-11-07"], ["a same-date", "2026-11-06"]])("%s fail merged with no rebuild: the lint reports it and --accept refuses", (_when, date) => {
      const w = pendingWorld();
      const before = rawLedger(w);
      placeRecord(w, date, "merged-fail", content(w, "fail"));
      expect(rawLedger(w)).toBe(before);
      const expected = `reviewed.json: ${section === "strings" ? "string" : "file"} ${label}: differs from what the records give (no entry); run copy-review.mjs rebuild`;
      expect(w.lint()).toContain(expected);
      expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*differs from what the records give/);
    });

    it("an entry pointing at an older pass than the newest one is reported", () => {
      const w = pendingWorld();
      const later = placeRecord(w, "2026-11-07", "later-pass", content(w, "pass"));
      expect(w.lint().join("\n")).toContain(`${label}: differs from what the records give (record ${later})`);
    });

    it("a later fail from a reviewer not on the list decides nothing, and rebuild says so", () => {
      const w = pendingWorld();
      const before = ledgerOf(w.dir)[section][label].review;
      const stranger = placeRecord(w, "2026-11-07", "stranger", { ...content(w, "fail"), reviewer: { kind: "agent", name: "nobody", account: "x" } });
      const { ignored } = rebuild({ dir: w.dir });
      expect(ledgerOf(w.dir)[section][label].review).toBe(before);
      expect(ignored.join("\n")).toContain(stranger);
      expect(w.lint()).toContain(`reviews/${stranger}.json: reviewer nobody is not on reviewers.json`);
    });

    it("a pass with an unknown verdict or edited bytes gives no entry", () => {
      const w = pendingWorld();
      rmSync(join(w.dir, "copy-lint/reviews", `${ledgerOf(w.dir)[section][label].review}.json`));
      const odd = placeRecord(w, "2026-11-07", "odd", content(w, "maybe"));
      const edited = placeRecord(w, "2026-11-08", "edited", content(w, "pass"));
      const path = join(w.dir, "copy-lint/reviews", `${edited}.json`);
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
      const { ignored } = rebuild({ dir: w.dir });
      expect(ledgerOf(w.dir)[section][label]).toBeUndefined();
      expect(ignored.join("\n")).toContain(odd);
      expect(ignored.join("\n")).toContain(edited);
    });

    it("a fail record with edited bytes gets its error and no deletion advice", () => {
      const w = pendingWorld();
      const failed = placeRecord(w, "2026-11-07", "bad-bytes", content(w, "fail"));
      const path = join(w.dir, "copy-lint/reviews", `${failed}.json`);
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
      const about = w.lint().filter((problem) => problem.includes(failed));
      expect(about.join("\n")).toMatch(/does not match the file bytes/);
      expect(about.join("\n")).not.toMatch(/delete it/);
    });

    it("an invalid fail beside a valid pass makes the lint red and --accept refuses: decides nothing is never quiet", () => {
      const w = pendingWorld();
      const invalid = placeRecord(w, "2026-11-07", "invalid-fail", { ...content(w, "fail"), reviewer: { kind: "agent", name: "nobody", account: "x" } });
      placeRecord(w, "2026-11-07", "valid-pass", content(w, "pass"));
      rebuild({ dir: w.dir });
      const invalidLine = `reviews/${invalid}.json: reviewer nobody is not on reviewers.json`;
      expect(w.lint()).toContain(invalidLine);
      w.put("source-hashes.json", { version: 1, locales: {} });
      const hashes = readFileSync(join(w.dir, "source-hashes.json"), "utf8");
      expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*is not on reviewers\.json/);
      expect(readFileSync(join(w.dir, "source-hashes.json"), "utf8")).toBe(hashes);
    });

    it("an unreferenced pass record with edited bytes keeps its deletion advice", () => {
      const w = pendingWorld();
      const passed = placeRecord(w, "2026-11-07", "bad-pass", content(w, "pass"));
      const path = join(w.dir, "copy-lint/reviews", `${passed}.json`);
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
      expect(w.lint()).toContain(`reviews/${passed}.json: orphan record (no ledger entry points to it; delete it)`);
    });

    it("the lint reports a future record by name", () => {
      const w = pendingWorld();
      const future = placeRecord(w, "2099-01-01", "future", content(w, "pass"));
      expect(w.lint()).toContain(`reviews/${future}.json: date must not be after today UTC (2026-11-10): 2099-01-01`);
    });
  });

  it.each([
    ["a fail with no English", (doc) => { doc.strings = { "de:a.one": { text: "Eins", verdict: "fail" } }; }, /de:a\.one: needs its English/],
    ["a fail with no text", (doc) => { doc.strings = { "de:a.one": { en: "One", verdict: "fail" } }; }, /de:a\.one: needs text/],
    ["a fail whose text is not a string", (doc) => { doc.strings = { "de:a.one": { text: 1, en: "One", verdict: "fail" } }; }, /de:a\.one: needs text/],
    ["an item that is not an object", (doc) => { doc.strings = { "de:a.one": "fail" }; }, /de:a\.one: needs text/],
    ["files as an array beside a good fail", (doc) => { doc.strings = { "de:a.one": { text: "Eins", en: "One", verdict: "fail" } }; doc.files = []; }, /strings and files must both be objects/],
    ["strings as null", (doc) => { doc.strings = null; }, /strings and files must both be objects/],
    ["a translation id that only contains /en: and has no English", (doc) => { doc.strings = { "de:x/en:y": { text: "x", verdict: "pass" }, "de:a.one": { text: "Eins", en: "One", verdict: "fail" } }; }, /de:x\/en:y: needs its English/],
  ])("a malformed record decides nothing, the lint is red and --accept refuses: %s", (_name, mutate, why) => {
    const w = pendingWorld();
    const before = ledgerOf(w.dir).strings["de:a.one"].review;
    const content = {};
    mutate(content);
    const bad = placeRecord(w, "2026-11-07", "malformed", content);
    const { ignored } = rebuild({ dir: w.dir });
    expect(ledgerOf(w.dir).strings["de:a.one"].review).toBe(before);
    expect(ignored.join("\n")).toContain(bad);
    const about = w.lint().filter((problem) => problem.includes(bad));
    expect(about.join("\n")).toMatch(why);
    w.put("source-hashes.json", { version: 1, locales: {} });
    const hashes = readFileSync(join(w.dir, "source-hashes.json"), "utf8");
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de/);
    expect(readFileSync(join(w.dir, "source-hashes.json"), "utf8")).toBe(hashes);
  });

  it("a malformed record holding a fail gets no deletion advice", () => {
    const w = pendingWorld();
    const bad = placeRecord(w, "2026-11-07", "malformed", { strings: { "de:a.one": { text: "Eins", verdict: "fail" } } });
    expect(w.lint().filter((problem) => problem.includes(bad)).join("\n")).not.toMatch(/delete it/);
  });

  it("a future-named record of unreadable bytes is refused by name and rebuild writes nothing", () => {
    const w = pendingWorld();
    const before = rawLedger(w);
    const text = "{ not json\n";
    const id = recordId("2099-01-01", "unreadable", text);
    writeFileSync(join(w.dir, "copy-lint/reviews", `${id}.json`), text);
    expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(`${id}: date must not be after today UTC`));
    expect(rawLedger(w)).toBe(before);
    expect(() => verdictOn(w, "pass", "next", "2026-11-10")).toThrow(new RegExp(id));
    expect(rawLedger(w)).toBe(before);
  });

  it("record survives a referenced record of unreadable bytes and names it, with both files written", () => {
    const w = pendingWorld();
    const referenced = ledgerOf(w.dir).strings["de:a.one"].review;
    writeFileSync(join(w.dir, "copy-lint/reviews", `${referenced}.json`), "{ not json\n");
    const next = verdictOn(w, "pass", "next", "2026-11-10");
    expect(next.ignored.join("\n")).toContain(referenced);
    expect(next.orphaned).toContain(referenced);
    expect(ledgerOf(w.dir).strings["de:a.one"].review).toBe(next.id);
  });

  it("a past-named record of unreadable bytes decides nothing, and the lint is red", () => {
    const w = pendingWorld();
    const text = "{ not json\n";
    const id = recordId("2026-11-07", "unreadable", text);
    writeFileSync(join(w.dir, "copy-lint/reviews", `${id}.json`), text);
    const { ignored } = rebuild({ dir: w.dir });
    expect(ignored.join("\n")).toContain(id);
    expect(w.lint().join("\n")).toContain(`reviews/${id}.json: not valid JSON`);
  });

  it("a fail on a pending string is not excused: the lint is red and --accept refuses, writing nothing", () => {
    const w = pendingWorld();
    expect(w.lint()).toEqual([]);
    const failed = record({
      dir: w.dir, reviewer: "sol-de", slug: "pending-fail", date: "2026-11-07",
      bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", files: {}, strings: { [`de:${PENDING_KEY}`]: { text: "Genaues", en: "Detail", verdict: "fail" } } },
    });
    expect(w.lint()).toContain(`pending-review.json: de:${PENDING_KEY}: record ${failed.id} fails this text`);
    w.put("source-hashes.json", { version: 1, locales: {} });
    const hashes = readFileSync(join(w.dir, "source-hashes.json"), "utf8");
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*fails this text/);
    expect(readFileSync(join(w.dir, "source-hashes.json"), "utf8")).toBe(hashes);
  });

  it("a same-date fail clears when new text gets a new review", () => {
    const w = pendingWorld();
    const fail = { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", files: {}, strings: { "de:a.one": { text: "Eins", en: "One", verdict: "fail" } } };
    record({ dir: w.dir, reviewer: "sol-de", slug: "failed", date: "2026-11-10", bundle: fail });
    expect(Object.keys(ledgerOf(w.dir).strings)).not.toContain("de:a.one");
    w.put("de.json", { "a.one": "Einer", "a.two": "Zwei", [PENDING_KEY]: "Genaues" });
    const pass = { ...fail, strings: { "de:a.one": { text: "Einer", en: "One", verdict: "pass" } } };
    const fixed = record({ dir: w.dir, reviewer: "sol-de", slug: "fixed", date: "2026-11-10", bundle: pass });
    expect(ledgerOf(w.dir).strings["de:a.one"].review).toBe(fixed.id);
  });

  it("the copy-final failure message states the same-date routes", () => {
    const message = ledgerFailureMessage([]);
    expect(message).toMatch(/the fail wins/);
    expect(message).toMatch(/new text gets a new review/);
    expect(message).toMatch(/later UTC date/);
    expect(message).toMatch(/has not merged yet: drop that record/);
    expect(message).not.toContain("--accept");
  });

  it("record drops a failed string it re-reviewed alongside a new pass, and --accept then refuses the failed text", () => {
    const w = pendingWorld();
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    record({
      dir: w.dir, reviewer: "sol-de", slug: "r2", date: "2026-11-07",
      bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", files: {}, strings: {
        "de:a.one": { text: "Eins", en: "One", verdict: "fail" },
        "de:a.two": { text: "Anders", en: "Two", verdict: "pass" },
      } },
    });
    const strings = ledgerOf(w.dir).strings;
    expect(Object.keys(strings)).not.toContain("de:a.one");
    expect(strings["de:a.two"].review).toMatch(/^2026-11-07-r2-/);
    expect(() => quietAccept(w.dir)).toThrow(/refusing to accept de[\s\S]*de:a\.one: no review entry/);
  });

  it("record does not name a superseded record for deletion when it holds a fail", () => {
    const w = pendingWorld();
    const first = record({
      dir: w.dir, reviewer: "sol-de", slug: "mixed", date: "2026-11-07",
      bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", files: {}, strings: {
        "de:a.one": { text: "Eins", en: "One", verdict: "fail" },
        "de:a.two": { text: "Zwei", en: "Two", verdict: "pass" },
      } },
    });
    w.put("de.json", { "a.one": "Eins", "a.two": "Anders", [PENDING_KEY]: "Genaues" });
    const second = record({
      dir: w.dir, reviewer: "sol-de", slug: "next", date: "2026-11-08",
      bundle: { version: 1, base: "abc126", author: "lcf-translator", scope: "fixture", files: {}, strings: { "de:a.two": { text: "Anders", en: "Two", verdict: "pass" } } },
    });
    expect(second.orphaned).not.toContain(first.id);
    expect(w.lint().filter((problem) => problem.includes(first.id))).toEqual([]);
  });

  it("no slack beyond the UTC day: tomorrow is refused at the last second of today and allowed at the first of tomorrow", () => {
    const w = pendingWorld();
    vi.setSystemTime(new Date("2026-11-10T23:59:59Z"));
    expect(() => verdictOn(w, "pass", "edge", "2026-11-11")).toThrow(/after today UTC \(2026-11-10\)/);
    verdictOn(w, "pass", "today", "2026-11-10");
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    expect(verdictOn(w, "pass", "edge", "2026-11-11").id).toMatch(/^2026-11-11-edge-/);
  });

  it("rebuild refuses a future record even when it holds nothing live", () => {
    const w = pendingWorld();
    const future = placeRecord(w, "2099-01-01", "stale-future", { strings: { "de:a.one": { text: "Anders", en: "One", verdict: "pass" } } });
    expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(future));
  });

  it("rebuild refuses a record whose name and date differ, whichever one is in the future", () => {
    const content = { strings: { "de:a.one": { text: "Eins", en: "One", verdict: "pass" } } };
    const w = pendingWorld();
    const pastName = placeRecord(w, "2099-01-01", "date-future", content, "2026-11-07");
    expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(`${pastName}: date must not be after today UTC`));
    dropRecord(w, pastName);
    const futureName = placeRecord(w, "2026-11-07", "name-future", content, "2099-01-01");
    expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(`${futureName}: date 2026-11-07 differs from its name`));
  });

  it.each(["2026-02-31", "2026-13-01", "2026-1-1"])("record and rebuild refuse a date that is not a real day: %s", (date) => {
    const w = pendingWorld();
    expect(() => verdictOn(w, "pass", "odd", date)).toThrow(/date must be/);
    const odd = placeRecord(w, date, "odd", { strings: { "de:a.one": { text: "Eins", en: "One", verdict: "pass" } } });
    expect(() => rebuild({ dir: w.dir })).toThrow(new RegExp(`${odd}: date must be`));
  });
});

describe("rebuild, record, the lint and copy-final use one function", () => {
  const source = (rel) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");
  const body = (text, start) => {
    const from = text.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n}\n", from);
    return text.slice(from, end);
  };

  it("resolveLedger is the only place the rule lives, and each of them reaches it", () => {
    const review = source("copy-review.mjs");
    const lint = source("copy-lint.mjs");
    const final = source("../src/locales/copy-final.test.ts");
    expect(body(review, "function resolveFromDisk(")).toContain("resolveLedger(");
    expect(body(review, "export function record(")).toContain("resolveFromDisk(");
    expect(body(review, "export function rebuild(")).toContain("resolveFromDisk(");
    expect(body(review, "export function ledgerFromRecords(")).toContain("resolveFromDisk(");
    expect(body(lint, "export function ledgerProblems(")).toContain("resolveLedger(");
    expect(lint.match(/passes: \[\]/g)).toHaveLength(1);
    expect(review).not.toMatch(/passes: \[\]|\.verdict === "pass"/);
    expect(final).toContain("ledgerFromRecords({ dir: DIR })");
    expect(final).toContain("ledgerProblems(");
    expect(body(lint, "export function acceptReviewProblems(")).toContain("ledgerProblems(");
  });

  it("what rebuild writes is what the lint accepts, and a different ledger is reported", () => {
    const w = pendingWorld();
    record({
      dir: w.dir, reviewer: "sol-de", slug: "mix", date: new Date().toISOString().slice(0, 10),
      bundle: { version: 1, base: "abc125", author: "lcf-translator", scope: "fixture", files: {}, strings: { "de:a.one": { text: "Eins", en: "One", verdict: "fail" } } },
    });
    const written = readFileSync(join(w.dir, "copy-lint/reviewed.json"), "utf8");
    rebuild({ dir: w.dir });
    expect(readFileSync(join(w.dir, "copy-lint/reviewed.json"), "utf8")).toBe(written);
    expect(w.lint().join("\n")).not.toMatch(/differs from what the records give/);
    const doc = JSON.parse(written);
    doc.strings["de:a.one"] = { review: Object.values(doc.strings)[0].review, sha256: exactHash("Eins") };
    w.put("copy-lint/reviewed.json", doc);
    expect(w.lint().join("\n")).toMatch(/de:a\.one: differs from what the records give \(no entry\)/);
  });
});
