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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Is this a file the scanner must read?
 *
 * The extension allowlist alone was a hole. This lane's own docblock claims it
 * covers "any executable/config file under installer/", but `extname()` is ""
 * for exactly the files a shell wrapper would be — `installer/bin/murage`, a
 * `Makefile`, a hook — so a one-line wrapper invoking the banned subcommand
 * would have shipped without the scanner ever opening it. Anything with no
 * extension is now read too, and judged by its first bytes.
 */
function scannable(p) {
  if (CODE_EXTS.has(extname(p))) return true;
  if (extname(p) !== "") return false;
  try {
    if (statSync(p).mode & 0o111) return true; // executable bit
    return readFileSync(p, "utf8").startsWith("#!");
  } catch {
    return false;
  }
}

test("TIER 1: the public-exposure subcommand appears NOWHERE in executable code", () => {
  const files = walk(INSTALLER, scannable);
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

test("TIER 1 self-check: an extension-less wrapper is scanned, not skipped", () => {
  // The gap this closes, demonstrated: a shebang script named `murage` has no
  // extension, so the old extension allowlist never read it.
  const dir = mkdtempSync(join(tmpdir(), "murage-lane-scan-"));
  const wrapper = join(dir, "murage");
  writeFileSync(wrapper, `#!/bin/sh\nexec tailscale ${NEEDLE} 443\n`, { mode: 0o755 });
  assert.equal(extname(wrapper), "", "the point of the case is that it has no extension");
  assert.ok(CODE_EXTS.has(extname(wrapper)) === false, "the old rule would have skipped it");
  assert.ok(scannable(wrapper), "the widened rule must read it");
  const hits = walk(dir, scannable).filter((f) => readFileSync(f, "utf8").toLowerCase().includes(NEEDLE));
  assert.deepEqual(hits, [wrapper], "the scanner must find the violation in a file with no extension");
  rmSync(dir, { recursive: true, force: true });
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

/**
 * Every subcommand this installer is allowed to hand the Tailscale CLI.
 *
 * A denylist of one word only stops the spelling somebody thought of. This is
 * the other direction: nothing may reach `runTailscale` except these three,
 * so a future exposure subcommand under a NEW name — or an alias for the
 * banned one — fails here without anybody having to have predicted it.
 */
const ALLOWED_SUBCOMMANDS = new Set(["up", "status", "serve"]);

test("ALLOWLIST: every argv the installer builds starts with an approved subcommand", async () => {
  const { buildServeArgs, buildUpArgs } = await import("../lib/tailscale.mjs");
  const argvs = [
    buildUpArgs({ keyFile: "/k" }),
    buildUpArgs({ keyFile: "/k", tags: ["tag:murage"], hostname: "h" }),
    buildServeArgs({ port: 8813 }),
    buildServeArgs({ port: 8813, https: false, listenPort: 80 }),
  ];
  for (const argv of argvs) {
    assert.ok(ALLOWED_SUBCOMMANDS.has(argv[0]), `argv starts with an unapproved subcommand: ${argv.join(" ")}`);
  }
});

test("ALLOWLIST: no call site hands runTailscale anything but an approved subcommand", () => {
  const sources = walk(join(INSTALLER, "bin"), scannable).concat(walk(join(INSTALLER, "lib"), scannable));
  assert.ok(sources.length >= 5, `expected the bin and lib lane; found ${sources.length}`);

  /** @type {string[]} */
  const bad = [];
  let sites = 0;
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    // `runTailscale(` followed by either an inline array whose first element is
    // a string literal, or one of the two argv builders.
    for (const m of text.matchAll(/(function\s+)?runTailscale\(\s*(?:\n\s*)?([\s\S]{0,40})/g)) {
      if (m[1]) continue; // the definition itself, not a call
      sites += 1;
      const head = m[2];
      // An inline array: its first element must be an approved subcommand.
      const literal = /^\[\s*"([A-Za-z][\w-]*)"/.exec(head);
      if (literal) {
        if (ALLOWED_SUBCOMMANDS.has(literal[1])) continue;
        bad.push(`${relative(REPO, file)}: runTailscale([${JSON.stringify(literal[1])}, …`);
        continue;
      }
      // A builder, called inline or through a variable this same file assigns
      // from one. Anything else — a computed argv, an imported array, a
      // parameter — is refused, because nothing here can prove what is in it.
      const inline = /^(?:ts\.)?(buildUpArgs|buildServeArgs)\s*\(/.exec(head);
      if (inline) continue;
      const ident = /^([A-Za-z_$][\w$]*)\s*,/.exec(head);
      if (ident && new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*=\\s*(?:ts\\.)?(?:buildUpArgs|buildServeArgs)\\s*\\(`).test(text)) {
        continue;
      }
      bad.push(`${relative(REPO, file)}: runTailscale(${head.split("\n")[0].trim()}`);
    }
  }
  assert.ok(sites >= 3, `the matcher found only ${sites} call sites — it is not actually matching`);
  assert.deepEqual(bad, [], `a call site names a subcommand outside the allowlist:\n${bad.join("\n")}`);
});
