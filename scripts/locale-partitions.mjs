// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY LINT r3 (1.0.18), design section 0: the one shared definition of the two copy partitions and of the
// string helpers the lint (src/locales/copy-final.test.ts), the generator (scripts/generate-locale.mjs) and the
// review CLI (scripts/copy-review.mjs) use. Plain ESM; no renderer code imports it.
//
//   Main partition = keys of src/locales/en.json + every src/locales/en-ux/*.json (boot English is main only).
//     Packs: src/locales/<code>.json, accepted in src/locales/source-hashes.json.
//   Help partition = keys of every src/locales/en-help/*.json. The partition is by FILE, not by key prefix.
//     Packs: src/locales/help/<code>.json, accepted in src/locales/help/source-hashes.json.
// The partitions never share a key, and a key never appears twice inside one catalogue file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
/** The 7 shipped packs. `en` is the source. */
export const PACK_CODES = Object.freeze(["de", "es", "fr", "hi", "ja", "pt-br", "zh"]);
export const MAIN_SOURCE_FILE = "en.json";
export const MAIN_FRAGMENT_DIR = "en-ux";
export const HELP_SOURCE_DIR = "en-help";
export const HELP_PACK_DIR = "help";
export const SOURCE_HASH_FILE = "source-hashes.json";

/** Rule-matching form only: drop format characters (zero-width, bidi marks), NFKC, fold whitespace runs, trim. */
export function normalise(value) {
  return String(value).replace(/\p{Cf}/gu, "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** sha256 hex of the UTF-8 bytes of the raw string as decoded from JSON. Every pin uses this, never normalise. */
export function exactHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** `pt` is served by the pt-br pack; the 7 pack codes and `en` map to themselves. */
export function canonicalCode(code) {
  const lower = String(code ?? "").trim().toLowerCase();
  if (lower === "pt") return "pt-br";
  return lower;
}

/** Keys that occur more than once in the raw text of one flat JSON catalogue (JSON.parse keeps only the last). */
export function duplicateKeys(text) {
  const seen = new Set();
  const dups = new Set();
  // In a flat object of strings a string literal followed by a colon is always a key.
  for (const match of String(text).matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    const key = JSON.parse(`"${match[1]}"`);
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups].sort();
}

function readCatalogueFile(path, label, problems) {
  const text = readFileSync(path, "utf8");
  for (const key of duplicateKeys(text)) problems.push(`${label}: ${key}: key appears twice in the file`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")).sort() : [];
}

/**
 * Both English partitions with the files each key comes from.
 * main: en-ux fragments merged under en.json (en.json wins, as the app merges them).
 * help: every en-help catalogue. problems: duplicate keys in a file, and any key in both partitions.
 */
export function readPartitions(dir = LOCALES_DIR) {
  const problems = [];
  const mainFiles = [];
  const helpFiles = [];
  const fragments = jsonFiles(join(dir, MAIN_FRAGMENT_DIR)).map((file) => {
    const label = `${MAIN_FRAGMENT_DIR}/${file}`;
    mainFiles.push(label);
    return readCatalogueFile(join(dir, MAIN_FRAGMENT_DIR, file), label, problems);
  });
  mainFiles.push(MAIN_SOURCE_FILE);
  const enMain = readCatalogueFile(join(dir, MAIN_SOURCE_FILE), MAIN_SOURCE_FILE, problems);
  const main = Object.assign({}, ...fragments, enMain);
  const help = {};
  const helpFileOf = {};
  for (const file of jsonFiles(join(dir, HELP_SOURCE_DIR))) {
    const label = `${HELP_SOURCE_DIR}/${file}`;
    helpFiles.push(label);
    const catalogue = readCatalogueFile(join(dir, HELP_SOURCE_DIR, file), label, problems);
    for (const [key, value] of Object.entries(catalogue)) {
      if (Object.hasOwn(help, key)) problems.push(`${label}: ${key}: already in ${helpFileOf[key]}`);
      help[key] = value;
      helpFileOf[key] = label;
    }
  }
  for (const key of Object.keys(help)) {
    if (Object.hasOwn(main, key)) problems.push(`${key}: in both the main and the Help partition (${helpFileOf[key]})`);
  }
  return { main, help, mainFiles, helpFiles, problems };
}

/** Path of one pack catalogue (or its source-hash file) inside a partition. */
export function packPath(dir, partition, code) {
  return partition === "help" ? join(dir, HELP_PACK_DIR, `${code}.json`) : join(dir, `${code}.json`);
}
export function hashPath(dir, partition) {
  return partition === "help" ? join(dir, HELP_PACK_DIR, SOURCE_HASH_FILE) : join(dir, SOURCE_HASH_FILE);
}

/** One pack catalogue as a flat object, with duplicate-key problems; `{}` when the file does not exist. */
export function readPack(dir, partition, code, problems = []) {
  const path = packPath(dir, partition, code);
  if (!existsSync(path)) return {};
  return readCatalogueFile(path, partition === "help" ? `${HELP_PACK_DIR}/${code}.json` : `${code}.json`, problems);
}

/** Cyrillic and Greek lookalikes of the letters in the four level names, folded to Latin before matching. */
export const LEVEL_CONFUSABLES = Object.freeze({
  "а": "a", "А": "a", "α": "a", "Α": "a",
  "ѕ": "s", "Ѕ": "s",
  "к": "k", "К": "k", "κ": "k", "Κ": "k",
  "υ": "u", "ս": "u",
  "т": "t", "Т": "t", "τ": "t", "Τ": "t",
  "о": "o", "О": "o", "ο": "o", "Ο": "o",
  "с": "c", "С": "c", "ϲ": "c", "Ϲ": "c",
  "е": "e", "Е": "e", "ε": "e", "Ε": "e",
  "і": "i", "І": "i", "ι": "i", "Ι": "i",
  "м": "m", "М": "m", "Μ": "m",
  "ո": "n", "Ν": "n",
  "ӏ": "l", "Ӏ": "l",
});

/** normalise, fold the lookalikes, ASCII-casefold: the form the level-name rule reads. */
export function levelFold(value) {
  return [...normalise(value)].map((ch) => LEVEL_CONFUSABLES[ch] ?? ch).join("").replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}
