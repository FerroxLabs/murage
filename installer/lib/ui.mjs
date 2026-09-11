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
import { Writable } from "node:stream";

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
/** Shared interfaces closed on purpose, to give the terminal to the secret
 * prompt. That close is not stdin ending; the next prompt opens a new one. */
const _handedOver = new WeakSet();

function rlInstance() {
  if (!_rl) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("close", () => {
      if (!_handedOver.has(rl)) _stdinEnded = true;
    });
    _rl = rl;
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
 *
 * "Does not echo" is literal, and it used to be a redraw. The key went through
 * the shared interface, which wrote every character (a pasted key whole)
 * before a listener painted the prompt over it. A terminal recorder, a tmux
 * scrollback or a slow screen had it all, and that interface kept history:
 * Up at the next prompt brought the key back. Now:
 *
 *  - the shared interface is closed first (without that counting as stdin
 *    ending), because two interfaces on one stdin both receive every key;
 *  - the key is read by an interface of its own, in terminal mode, so stdin
 *    is raw and the tty driver echoes nothing, whose output goes nowhere, so
 *    readline echoes nothing, and with `historySize: 0`, so it remembers
 *    nothing; the next prompt opens a fresh shared interface;
 *  - the prompt is written only once raw mode is on, since a key typed before
 *    that would be echoed by the terminal itself;
 *  - EOF (Ctrl-D) skips it and ends stdin, as piped input does; Ctrl-C
 *    restores the terminal and interrupts, as it would at any other prompt.
 * `installer/test/ui-secret.test.mjs` checks all of it on a real pseudo-terminal.
 * @param {string} question
 * @returns {Promise<string>}
 */
export function askSecret(question) {
  if (_stdinEnded) return Promise.resolve("");
  if (!process.stdin.isTTY) return ask(question);
  if (_rl) {
    const shared = _rl;
    _rl = null;
    _handedOver.add(shared);
    shared.close();
  }
  return new Promise((resolve) => {
    const nowhere = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const rl = createInterface({ input: process.stdin, output: nowhere, terminal: true, historySize: 0 });
    let settled = false;
    /** @param {string} value @param {"answered" | "ended" | "interrupted"} how */
    const finish = (value, how) => {
      if (settled) return;
      settled = true;
      if (how === "ended") _stdinEnded = true;
      rl.close();
      process.stdout.write("\n");
      // Left to the process's own SIGINT handling: setup's handlers stop what
      // they started, and with none the default ends the process as ^C does.
      if (how === "interrupted") process.kill(process.pid, "SIGINT");
      else resolve(value);
    };
    rl.on("SIGINT", () => finish("", "interrupted"));
    rl.on("close", () => finish("", "ended"));
    process.stdout.write(question);
    rl.question("", (answer) => finish(answer.trim(), "answered"));
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
