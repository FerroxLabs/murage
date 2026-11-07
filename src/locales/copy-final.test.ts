// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY LINT r3 (Murage 1.0.18): the blocking copy lint for every shipped string in all 8 languages, in the GATE
// tier (ci/gate-tests.txt). Design: 104-lastresort-evidence/handoffs/designs/L-COPY-LINT-R3-1018.md.
// The engine is scripts/copy-lint.mjs (plain ESM, shared with the review CLI scripts/copy-review.mjs); the two copy
// partitions and normalise/exactHash are scripts/locale-partitions.mjs.
//
//   1. Deterministic rules on normalise(value) for en main, en Help, the 7 main packs and the 7 Help packs:
//      em dash or spaced en dash; Forge; English level names (lookalikes folded, CJK does not protect); links and
//      domains only as exact tokens listed per locale:key in copy-lint/links.json; never a domain next to a purchase
//      cue; four-part versions; the English copied; price words; a fix worded as breakage; engine order.
//   2. Review records (copy-lint/reviews) and the ledger (copy-lint/reviewed.json). Every shipped string needs an entry, except the
//      ids on copy-lint/pending-review.json at their listed hash; that list must be empty at the release cut.
//   3. Completeness: every main key in each main pack, every Help key in each Help pack, nothing extra.
//   4. Pinned lint files: same-as-english.json maps "<code>:<key>" to the exactHash of the English it may equal;
//      english-only.json stays empty; every file in PINNED_FILES is pinned in the ledger.
// Run `COPY_FINAL_REPORT=1 pnpm exec vitest run src/locales/copy-final.test.ts` to print every hit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEDGER_REQUIRED,
  ledgerFailureMessage,
  PINNED_FILES,
  RULE_NAMES,
  completenessProblems,
  duplicateEntries,
  ledgerProblems,
  linksProblems,
  loadCopy,
  readLintFile,
  readReviewInputs,
  ruleFindings,
  ruleIds,
  sameAsEnglishProblems,
  shippedMap,
  type Copy,
  type CopyEntry,
  type Links,
  type RuleContext,
} from "../../scripts/copy-lint.mjs";
import { ledgerFromRecords } from "../../scripts/copy-review.mjs";
import { exactHash } from "../../scripts/locale-partitions.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
export const PACKS = ["de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
const LANGS = ["en", ...PACKS] as const;
type Lang = (typeof LANGS)[number];

const lintJson = <T>(name: string): T => JSON.parse(readLintFile(DIR, name) ?? "null") as T;

// The public-push secret scan lists these two files as reviewed, so nothing else catches a real key put in them.
const HASH_ONLY_FILES = ["copy-lint/same-as-english.json", "help/source-hashes.json"] as const;
/** Every string value at any depth that is not a 64 lowercase hex hash, by path. */
function nonHashStrings(node: unknown, path = "$"): string[] {
  if (typeof node === "string") return /^[0-9a-f]{64}$/.test(node) ? [] : [path];
  if (Array.isArray(node)) return node.flatMap((item, index) => nonHashStrings(item, `${path}[${index}]`));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => nonHashStrings(value, `${path}.${key}`));
  }
  return [];
}
function countStrings(node: unknown): number {
  if (typeof node === "string") return 1;
  if (node && typeof node === "object") return Object.values(node).reduce<number>((sum, value) => sum + countStrings(value), 0);
  return 0;
}

describe("copy final lint (blocking, all 8 languages, main and Help)", () => {
  const copy = loadCopy(DIR);
  const links = lintJson<Links>("links.json");
  const same = lintJson<Record<string, string>>("same-as-english.json");

  it("reads both partitions in every language: en main, en Help, 7 main packs and 7 Help packs", () => {
    expect(copy.problems).toEqual([]);
    expect(Object.keys(copy.help).length).toBeGreaterThan(200);
    for (const code of PACKS) {
      expect(Object.keys(copy.helpPacks[code]).length).toBe(Object.keys(copy.help).length);
      expect(copy.entries.some((entry) => entry.locale === code && entry.partition === "help")).toBe(true);
    }
  });

  it("the step-up catalogues are a source of the shared rules: all 8 languages, read as shipped strings", () => {
    expect(Object.keys(copy.stepUp).length).toBeGreaterThan(100);
    for (const code of LANGS) {
      const ids = copy.entries.filter((entry) => entry.partition === "stepup" && entry.locale === code).map((entry) => entry.id);
      expect(ids.length, code).toBe(Object.keys(copy.stepUp).length);
      expect(ids.every((id) => id.startsWith(`stepup/${code}:`)), code).toBe(true);
    }
    expect(Object.keys(copy.stepUp).some((key) => key.startsWith("@"))).toBe(false);
    // The rules see a bad step-up string with the language it is in.
    expect(ruleIds({ locale: "de", value: "Bot löschen — sofort" }, {})).toContain("em-dash");
    expect(completenessProblems({ ...copy, problems: [], stepUpPacks: { ...copy.stepUpPacks, de: {} } }).some((problem) => problem.startsWith("electron/locales/step-up/de.json:") && problem.endsWith("not translated"))).toBe(true);
  });

  it("the ledger names an entry listed twice, never the fields every entry repeats", () => {
    const entry = '{ "review": "r", "sha256": "s" }';
    expect(duplicateEntries(`{ "strings": { "de:a": ${entry}, "de:b": ${entry} }, "files": {} }`)).toEqual([]);
    expect(duplicateEntries(`{ "strings": { "de:a": ${entry}, "de:a": ${entry} } }`)).toEqual(["de:a"]);
    expect(duplicateEntries(String.raw`{ "strings": { "stepup/de:a": ${entry}, "stepup\/de:a": ${entry}, "de:b": ${entry}, "de:b": ${entry} } }`)).toEqual(["de:b", "stepup/de:a"]);
  });

  it("section 1: every shipped string in every language follows the copy rules", () => {
    const found = ruleFindings(copy, { links, same });
    if (process.env.COPY_FINAL_REPORT) console.log(found.join("\n"));
    expect(found).toEqual([]);
  });

  it("section 1: links.json lists only exact tokens that its string still holds, each with a reason", () => {
    expect(linksProblems(links, copy)).toEqual([]);
  });

  it("section 3: every main key is in each main pack and every Help key in each Help pack, nothing extra", () => {
    const missing = completenessProblems(copy);
    if (process.env.COPY_FINAL_REPORT) console.log(missing.join("\n"));
    expect(missing).toEqual([]);
  });

  it("section 4: same-as-english pins the English text; english-only stays empty", () => {
    expect(sameAsEnglishProblems(same, copy)).toEqual([]);
    expect(lintJson<{ keys: string[] }>("english-only.json").keys).toEqual([]);
  });

  it.each(HASH_ONLY_FILES)("%s holds only 64 lowercase hex hashes as string values", (name) => {
    const parsed: unknown = JSON.parse(readFileSync(`${DIR}${name}`, "utf8"));
    expect(countStrings(parsed)).toBeGreaterThan(200);
    expect(nonHashStrings(parsed)).toEqual([]);
  });

  it("the hash-only check catches a key-shaped value, a short hash, uppercase hex and a nested string", () => {
    const good = "a".repeat(64);
    expect(nonHashStrings({ a: good, b: { c: [good] }, version: 1 })).toEqual([]);
    expect(nonHashStrings({ a: "sk-flux-notarealkey" })).toEqual(["$.a"]);
    expect(nonHashStrings({ a: "a".repeat(63) })).toEqual(["$.a"]);
    expect(nonHashStrings({ a: "A".repeat(64) })).toEqual(["$.a"]);
    expect(nonHashStrings({ locales: { de: { k: [good, "x"] } } })).toEqual(["$.locales.de.k[1]"]);
  });

  it("section 2: every review record and ledger entry is valid (and complete once LEDGER_REQUIRED)", () => {
    const problems = ledgerProblems({ ...readReviewInputs(DIR), shipped: shippedMap(copy), english: copy.english });
    if (process.env.COPY_FINAL_REPORT) console.log(problems.join("\n"));
    expect(problems, ledgerFailureMessage(problems)).toEqual([]);
  });

  it("section 2: the records alone give a valid ledger, so a reviewed.json merge conflict can always be rebuilt", () => {
    const rebuilt = JSON.stringify(ledgerFromRecords({ dir: DIR }));
    const problems = ledgerProblems({ ...readReviewInputs(DIR), ledgerText: rebuilt, shipped: shippedMap(copy), english: copy.english });
    expect(problems, ledgerFailureMessage(problems)).toEqual([]);
  });

  it("section 4: the ledger is required and pins every lint file", () => {
    expect(LEDGER_REQUIRED).toBe(true);
    expect(Object.keys(lintJson<{ files: Record<string, unknown> }>("reviewed.json").files).sort()).toEqual([...PINNED_FILES].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: each rule fails a bad string in every language it covers, naming that rule, and passes good ones.

const per = (id: string, values: Partial<Record<Lang, string>>, ctx: (lang: Lang) => RuleContext = () => ({})) =>
  (Object.entries(values) as [Lang, string][]).map(([locale, value]) => ({ id, locale, value, ctx: ctx(locale) }));
const listed = (token: string) => () => ({ links: [{ token, reason: "fixture" }] });

describe("copy rules: negative fixtures in every language", () => {
  const bad = [
    ...per("em-dash", { en: "Working — now", de: "Läuft — jetzt", es: "Trabajando – ahora", fr: "En cours — maintenant", hi: "चल रहा है — अभी", ja: "作業中—今", "pt-br": "Trabalhando — agora", zh: "正在工作—现在" }),
    ...per("forge", { en: "Open the Forge", de: "Öffne die FORGE", es: "Abre Forge", fr: "Ouvre Forge", hi: "Forge खोलें", ja: "Forgeを開く", "pt-br": "Abra o forge", zh: "打开Forge" }),
    ...per("english-level-name", {
      de: "Wähle Auto für diesen Bot", es: "Elige Ask primero", fr: "Passe en Full access", hi: "No limits चुनें",
      ja: "autoで実行します", "pt-br": "Use o modo Аsk", zh: "ASK模式",
    }),
    ...per("english-level-name", { de: "Au​to bleibt an", ja: "ＡＵＴＯ", zh: "Αuto 模式", fr: "Niveau no  limits", es: "nivel FULL ACCESS", hi: "Ask स्तर", "pt-br": "auto" }),
    ...per("link", {
      en: "See example.com/pricing", de: "Siehe murage.ai/preise", es: "Visita https://example.com", fr: "Écris à help@example.com",
      hi: "http://10.0.0.1:8080 खोलें", ja: "murage.ai で詳しく", "pt-br": "Acesse www.murage.ai", zh: "访问 murage.ai",
    }),
    // Outright: userinfo, a backslash, a protocol-relative host fail even when listed.
    ...per("link", { en: "Open https://user:pw@github.com", de: "Öffne //evil.example" }, (lang) =>
      ({ links: [{ token: lang === "en" ? "https://user:pw@github.com" : "//evil.example", reason: "fixture" }] })),
    ...per("link", { fr: "Ouvre https://murage.ai\\pricing" }, listed("https://murage.ai\\pricing")),
    // Exact token only: a listed host does not cover a longer token.
    ...per("link", { en: "Download from murage.ai/download", es: "Descarga desde murage.ai/es" }, listed("murage.ai")),
    // A domain next to a purchase cue fails even when listed.
    ...per("purchase-link", {
      en: "Top up at murage.ai", de: "Guthaben auf murage.ai aufladen", es: "Recarga en murage.ai", fr: "Recharge sur murage.ai",
      hi: "murage.ai पर रिचार्ज करें", ja: "murage.ai でチャージ", "pt-br": "Recarregue em murage.ai", zh: "在 murage.ai 充值",
    }, listed("murage.ai")),
    ...per("purchase-link", { en: "Buy a plan at murage.ai", de: "Kaufe es auf murage.ai", fr: "Achète sur murage.ai", zh: "在 murage.ai 购买" }, listed("murage.ai")),
    ...per("purchase-link", { de: "Lade auf murage.ai Guthaben auf", es: "Suscríbete en murage.ai" }, listed("murage.ai")),
    // A cue with a colon and a space still overrides the grouped-thousands exception.
    ...per("four-part-version", { de: "Version: 1.234.567.890.123", es: "Versión : 1.234.567.890" }),
    ...per("four-part-version", {
      en: "Update to Murage 1.0.18.1", de: "Version 1.234.567.8", es: "Versión 100.0.0.1", fr: "Murage 10.0.0.1 est prêt",
      hi: "Murage 1.0.18.2 उपलब्ध है", ja: "Fuigo 1.0.40.2 に更新", "pt-br": "Versão 2.0.0.0", zh: "版本 1.0.18.1",
    }),
    ...per("four-part-version", { en: "Build 1.2.3.4.5 is ready", de: "Paket 1.0.18.1 bereit" }),
    ...per("price", {
      en: "Use it free of charge", de: "Ohne Kosten testen", es: "Úsalo sin coste", fr: "Utilise-le sans frais",
      hi: "निशुल्क आज़माएँ", ja: "無料で試す", "pt-br": "Use sem custo", zh: "免费使用",
    }),
    ...per("price", { en: "A cost-free plan", de: "Kostenfrei testen", es: "Es gratis", fr: "C'est gratuit", hi: "मुफ़्त है", ja: "無償で試す", "pt-br": "É grátis", zh: "无偿使用" }),
    ...per("breakage", {
      en: "Fixed a startup freeze", de: "Absturz behoben.", es: "Fallo al iniciar corregido.", fr: "Plantage au démarrage corrigé.",
      hi: "शुरू होते समय क्रैश ठीक कर दिया।", ja: "起動時のクラッシュを修正しました。", "pt-br": "Travamento ao iniciar corrigido.", zh: "已修复启动时崩溃。",
    }),
    ...per("breakage", { en: "Sync is fixed.", de: "Das Problem ist behoben.", fr: "Le problème est résolu.", zh: "问题已解决。", hi: "समस्या ठीक हो गई।", ja: "問題を修正しました。", es: "Problema solucionado.", "pt-br": "Problema resolvido." }),
    ...per("engine-lead", {
      en: "Claude Code and Fuigo keep working.", de: "Codex / Fuigo arbeiten weiter.", es: "Fuigo, Codex y Flux siguen.", fr: "Codex et Fuigo continuent.",
      hi: "Codex और Fuigo चलते रहेंगे।", ja: "Codex、Fuigo は動き続けます。", "pt-br": "Codex e Flux continuam.", zh: "Codex 和 Fuigo 继续工作。",
    }),
    ...per("engine-lead", { en: "Codex • Flux", zh: "Codex；Fuigo", ja: "Codex; Fuigo", de: "Codex\nFuigo" }),
    ...per("safe", { en: "Your files stay safe" }),
    ...per("safe", { en: "A safe-area for your files." }),
  ];
  const copied = PACKS.map((locale) => ({ id: "copied-english", locale, value: "Open  the file ", ctx: { english: "Open the file" } as RuleContext }));

  it.each([...bad, ...copied].map((row) => [`${row.locale} ${row.id}: ${row.value}`, row] as const))("%s", (_name, row) => {
    expect(ruleIds({ locale: row.locale, value: row.value }, row.ctx)).toContain(row.id);
  });

  it("covers every rule, and every language for each rule that applies to it", () => {
    const all = [...bad, ...copied];
    for (const id of Object.keys(RULE_NAMES)) {
      const langs = new Set(all.filter((row) => row.id === id).map((row) => row.locale));
      const expected = id === "safe" ? ["en"] : id === "english-level-name" || id === "copied-english" ? [...PACKS] : [...LANGS];
      expect([...langs].sort(), id).toEqual([...expected].sort());
    }
  });
});

describe("copy rules: positive fixtures", () => {
  const good: { locale: Lang; value: string; ctx?: RuleContext }[] = [
    { locale: "en", value: "Check free disk space, then try again." },
    { locale: "en", value: "Waiting for a free slot. Jargon-free." },
    { locale: "en", value: "Fuigo, Flux and Codex keep working. Claude needs a sign-in." },
    { locale: "en", value: "Claude Code runs Claude models. Pick Fuigo or Codex." },
    { locale: "en", value: "Fuigo 1.0.40 and Murage 1.0.18 are ready." },
    { locale: "en", value: "Murage now opens straight to Today." },
    { locale: "en", value: "Fuigo / Flux / Codex" },
    { locale: "en", value: "Every bot on Fuigo stops answering until this is fixed." },
    { locale: "en", value: "That did not work. Fix the error and try again." },
    { locale: "en", value: "Edit AGENTS.md or en.json, then README.md." },
    { locale: "en", value: "Address starts with https://...", ctx: { links: [{ token: "https://...", reason: "placeholder" }] } },
    { locale: "en", value: "Write to support@fluxrouter.ai.", ctx: { links: [{ token: "support@fluxrouter.ai.", reason: "support" }] } },
    { locale: "en", value: "Open 127.0.0.1:8080 here", ctx: { links: [{ token: "127.0.0.1:8080", reason: "local" }] } },
    { locale: "de", value: "Ganze Tokens von 1 bis 9.007.199.254.740.991." },
    { locale: "pt-br", value: "Até 1.234.567 itens." },
    { locale: "de", value: "Fuigo und Codex arbeiten weiter. Fehler beim Laden." },
    { locale: "de", value: "Wähle automatisch oder frag zuerst. Tasks laufen weiter." },
    { locale: "fr", value: "Autorisation accordée automatiquement." },
    { locale: "zh", value: "要使用你的 ChatGPT 或 Grok 套餐，请选择 Fuigo 或 Codex。" },
    { locale: "zh", value: "知道 Murage 是否正常，出问题时一步修复。" },
    { locale: "ja", value: "エラーを修正してから、もう一度お試しください。" },
    { locale: "es", value: "Comprueba que el enlace empiece por https://.", ctx: { links: [{ token: "https://.", reason: "placeholder" }] } },
    { locale: "de", value: "Fuigo {version}", ctx: { english: "Fuigo {version}" } },
    { locale: "de", value: "Chat", ctx: { english: "Chat", sameOk: true } },
    { locale: "de", value: "Bereich 1–9" },
  ];
  it.each(good.map((row) => [`${row.locale}: ${row.value}`, row] as const))("%s", (_name, row) => {
    expect(ruleIds({ locale: row.locale, value: row.value }, row.ctx ?? {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures for sections 3 and 4 and for links.json.

function fixtureCopy(over: Partial<Record<"main" | "help", Record<string, string>>> & {
  de?: Record<string, string>; helpDe?: Record<string, string>;
} = {}): Copy {
  const main = over.main ?? { "a.one": "One", "a.name": "Fuigo {version}" };
  const help = over.help ?? { "ux.h.tip": "Tip" };
  const de = over.de ?? { "a.one": "Eins", "a.name": "Fuigo {version}" };
  const helpDe = over.helpDe ?? { "ux.h.tip": "Tipp" };
  const packs: Record<string, Record<string, string>> = Object.fromEntries(PACKS.map((code) => [code, code === "de" ? de : { ...main }]));
  const helpPacks: Record<string, Record<string, string>> = Object.fromEntries(PACKS.map((code) => [code, code === "de" ? helpDe : { ...help }]));
  const entries: CopyEntry[] = [];
  const add = (locale: string, partition: "main" | "help", catalogue: Record<string, string>) => {
    for (const [key, value] of Object.entries(catalogue)) entries.push({ id: `${locale}:${key}`, locale, partition, key, value });
  };
  add("en", "main", main);
  add("en", "help", help);
  for (const code of PACKS) { add(code, "main", packs[code]); add(code, "help", helpPacks[code]); }
  return { main, help, stepUp: {}, english: { ...main, ...help }, packs, helpPacks, stepUpPacks: {}, entries, problems: [] };
}

describe("completeness, same-as-english and links.json checks (fixtures)", () => {
  it("section 3: a missing, empty, extra or cross-partition key fails in either partition", () => {
    expect(completenessProblems(fixtureCopy({ de: { "a.one": "Eins", "a.name": "Fuigo {version}" } })).filter((p) => p.startsWith("de"))).toEqual([]);
    expect(completenessProblems(fixtureCopy({ de: { "a.one": "", "a.name": "Fuigo {version}", "ux.h.tip": "Tipp" } })).filter((p) => p.includes("de.json"))).toEqual([
      "de.json: a.one: empty",
      "de.json: ux.h.tip: not a main key (extra or stale)",
    ]);
    expect(completenessProblems(fixtureCopy({ helpDe: {} })).filter((p) => p.includes("help/de.json"))).toEqual([
      "help/de.json: ux.h.tip: not translated",
    ]);
  });

  it("section 4: same-as-english fails on an unknown, unequal, unneeded or English-moved entry", () => {
    const copy = fixtureCopy({ de: { "a.one": "One", "a.name": "Fuigo {version}" } });
    expect(sameAsEnglishProblems({ "de:a.one": exactHash("One") }, copy)).toEqual([]);
    expect(sameAsEnglishProblems({ "de:a.one": exactHash("One (old)") }, copy)).toEqual([
      "same-as-english.json: de:a.one: the English changed (hash differs); review it again",
    ]);
    expect(sameAsEnglishProblems({ "xx:a.one": exactHash("One"), "de:a.gone": exactHash("x") }, copy)).toEqual([
      "same-as-english.json: xx:a.one: unknown locale or key",
      "same-as-english.json: de:a.gone: unknown locale or key",
    ]);
    expect(sameAsEnglishProblems({ "fr:a.one": exactHash("One") }, fixtureCopy())).toEqual([]);
    expect(sameAsEnglishProblems({ "de:a.one": exactHash("One") }, fixtureCopy())).toEqual([
      "same-as-english.json: de:a.one: stale (the pack text is not the English)",
    ]);
    expect(sameAsEnglishProblems({ "de:a.name": exactHash("Fuigo {version}") }, fixtureCopy())).toEqual([
      "same-as-english.json: de:a.name: unneeded (names, numbers and placeholders pass without it)",
    ]);
    // The copied-English rule still fires without the entry.
    expect(ruleFindings(copy, { links: {}, same: {} }).some((f) => f.startsWith("de:a.one: copied-english"))).toBe(true);
    expect(ruleFindings(copy, { links: {}, same: { "de:a.one": exactHash("One") } }).filter((f) => f.startsWith("de:"))).toEqual([]);
  });

  it("links.json fails on an unknown string, a stale token, an uppercase token, a missing reason or a duplicate", () => {
    const copy = fixtureCopy({ main: { "a.one": "Mail support@fluxrouter.ai", "a.name": "Fuigo {version}" } });
    const ok: Links = { "en:a.one": [{ token: "support@fluxrouter.ai", reason: "support" }] };
    expect(linksProblems(ok, copy)).toEqual([]);
    expect(linksProblems({ "en:a.gone": [{ token: "x.ai", reason: "r" }] }, copy)).toEqual(["links.json: en:a.gone: no such shipped string"]);
    expect(linksProblems({ "en:a.one": [{ token: "murage.ai", reason: "r" }] }, copy)).toEqual(["links.json: en:a.one: murage.ai: stale (matches nothing in the string)"]);
    expect(linksProblems({ "en:a.one": [{ token: "SUPPORT@fluxrouter.ai", reason: "r" }] }, copy)).toEqual(expect.arrayContaining(["links.json: en:a.one: SUPPORT@fluxrouter.ai: tokens are lowercase"]));
    expect(linksProblems({ "en:a.one": [{ token: "support@fluxrouter.ai", reason: " " }] }, copy)).toEqual(["links.json: en:a.one: each entry needs a token and a reason"]);
    expect(linksProblems({ "en:a.one": [ok["en:a.one"][0], ok["en:a.one"][0]] }, copy)).toEqual(["links.json: en:a.one: support@fluxrouter.ai: listed twice"]);
  });
});
