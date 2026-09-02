/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The lane scanner.
 *
 * Tailscale has two ways to put a local server in front of other people. One
 * shares it INSIDE your tailnet — that is the entire point of this deployment.
 * The other publishes it to the OPEN INTERNET — that is the exact thing this
 * deployment exists to prevent, and it is one word away from the safe one on
 * the command line.
 *
 * So the word is banned. Not "discouraged", not "documented as unwise" —
 * mechanically banned, by this test, in two tiers:
 *
 *   Tier 1 (code)  : ZERO occurrences, case-insensitively, anywhere under
 *                    installer/bin, installer/lib, installer/test, or in any
 *                    executable/config file under installer/. No allowlist, no
 *                    escape hatch. A comment mentioning it fails too — because
 *                    a comment is one uncomment away from a command.
 *   Tier 2 (prose) : in the markdown of this lane it may appear ONLY on a line
 *                    that also contains the word NEVER. You cannot write an
 *                    instruction telling somebody to run it, because such a
 *                    line would not contain NEVER.
 *
 * The needle is assembled at runtime so that this file, too, is clean and can
 * be scanned by its own rule.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const NEEDLE = ["fun", "nel"].join("");
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, "..");
const REPO = resolve(INSTALLER, "..");
const PLAN_DIR = join(REPO, "docs", "plans", "cloud-deploy");

const CODE_EXTS = new Set([".mjs", ".cjs", ".js", ".ts", ".json", ".sh", ".service", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "payload", "dist", "dist-server"]);

/** @param {string} dir @param {(p: string) => boolean} pick @returns {string[]} */
function walk(dir, pick) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full, pick));
    else if (pick(full)) out.push(full);
  }
  return out;
}

test("TIER 1: the public-exposure subcommand appears NOWHERE in executable code", () => {
  const files = walk(INSTALLER, (p) => CODE_EXTS.has(extname(p)));
  assert.ok(files.length >= 8, `the scanner found only ${files.length} files — it is not actually scanning`);

  /** @type {string[]} */
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (line.toLowerCase().includes(NEEDLE)) hits.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `banned subcommand found in the executable lane:\n${hits.join("\n")}`);
});

test("TIER 1 self-check: the scanner would actually catch a violation", () => {
  // A scanner nobody has seen fail is not a scanner. Prove the matcher works on
  // a synthetic line before trusting its silence on the real files.
  const violation = `  runTailscale(["${NEEDLE}", "--bg", "8799"]);`;
  assert.ok(violation.toLowerCase().includes(NEEDLE));
  assert.ok(!'runTailscale(["serve", "--bg", "8799"]);'.toLowerCase().includes(NEEDLE));
});

test("TIER 2: in the prose of this lane the word appears only in prohibitions", () => {
  const docs = [
    ...walk(INSTALLER, (p) => extname(p) === ".md"),
    ...walk(PLAN_DIR, (p) => extname(p) === ".md"),
  ];
  assert.ok(docs.length >= 2, `expected the plan and the installer README; found ${docs.length}`);

  /** @type {string[]} */
  const bad = [];
  for (const file of docs) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.toLowerCase().includes(NEEDLE)) return;
        if (line.includes("NEVER")) return;
        bad.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, [], `the banned subcommand is mentioned outside a prohibition:\n${bad.join("\n")}`);
});

test("the only tailnet-facing proxy the installer can build is the tailnet-only one", async () => {
  const { buildServeArgs } = await import("../lib/tailscale.mjs");
  const argv = buildServeArgs({ port: 8799 });
  assert.equal(argv[0], "serve");
  assert.ok(!argv.join(" ").toLowerCase().includes(NEEDLE));
});
