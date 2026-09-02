/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Terminal helpers: colour, the scriptable prompt, a non-echoing secret prompt,
 * and the QR block.
 *
 * The single-shared-readline pattern is lifted from Wayland's installer, whose
 * comment explains it best: a fresh interface per prompt ends stdin on the
 * first EOF, leaving every later prompt hanging on a closed stream. One shared
 * interface reads sequential piped answers correctly and, once stdin closes,
 * makes every prompt resolve to its default — so `murage setup` is fully
 * scriptable and never hangs.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  b: wrap("1"),
  dim: wrap("2"),
  o: wrap("38;5;208"),
  g: wrap("32"),
  r: wrap("31"),
  y: wrap("33"),
};

let _rl = null;
let _stdinEnded = false;

function rlInstance() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout });
    _rl.on("close", () => {
      _stdinEnded = true;
    });
  }
  return _rl;
}

export function closeRl() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}

/** @param {string} question @returns {Promise<string>} */
export function ask(question) {
  if (_stdinEnded) return Promise.resolve("");
  return new Promise((res) => {
    const rl = rlInstance();
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        res(v);
      }
    };
    rl.question(question, (a) => finish(a.trim()));
    rl.once("close", () => finish(""));
  });
}

/** @param {string} question @param {boolean} [dflt] @returns {Promise<boolean>} */
export async function confirm(question, dflt = true) {
  const hint = dflt ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!a) return dflt;
  return a === "y" || a === "yes";
}

/**
 * Read a secret with echo OFF.
 *
 * This is why `murage setup` can promise the auth key never lands in shell
 * history: it is typed at a prompt that does not echo, into a process that puts
 * it in a 0600 file, not into a command line. Falls back to the ordinary
 * prompt when stdin is not a TTY (piped input in a script, where there is no
 * terminal echo to suppress anyway).
 * @param {string} question
 * @returns {Promise<string>}
 */
export function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    const rl = rlInstance();
    const onData = (char) => {
      // Re-write the prompt with no echoed characters after each keystroke.
      const s = String(char);
      if (s === "\n" || s === "\r" || s === "") return;
      process.stdout.write(`\r\x1b[2K${question}`);
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * Render a URL as a terminal QR block if `qrencode` is available.
 *
 * Honest about its limits: Murage's installer ships no QR encoder of its own
 * (the app's `qrcode.react` is a React component and cannot run in a terminal),
 * so this shells out to `qrencode`, which `murage setup` offers to apt-install
 * alongside its other prerequisites. When it is absent we print the URL and say
 * so, rather than pretending.
 * @param {string} url
 * @returns {string | null}
 */
export function qrBlock(url, run = spawnSync) {
  const r = run("qrencode", ["-t", "ANSIUTF8", "-m", "1", url], { encoding: "utf8" });
  if ((r.status ?? 1) !== 0 || !r.stdout) return null;
  return r.stdout;
}

/** @param {string} title */
export function heading(title) {
  console.log(`\n  ${c.o(title)}\n`);
}

/** @param {string} msg */
export function ok(msg) {
  console.log(`  ${c.g("✓")} ${msg}`);
}

/** @param {string} msg */
export function warn(msg) {
  console.log(`  ${c.y("!")} ${msg}`);
}

/** @param {string} msg */
export function fail(msg) {
  console.log(`  ${c.r("✗")} ${msg}`);
}
