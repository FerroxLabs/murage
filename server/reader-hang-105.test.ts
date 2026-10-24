// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: no command text may hold the command reader. The stop line runs on
// the server's own thread (server/index.ts stopLineFor), so a reader that
// never returns freezes every bot. 1.0.4's stop line did, on any delete of
// two targets in different top-level folders (`rd /s /q C:\Windows` read as
// POSIX names `/s` and `/q`; `rm -rf /tmp/a /var/b`; `Remove-Item C:\a, D:\b`):
// the climb to their common folder stopped only at a folder that holds both,
// and `/` was never one (server/stop-line.ts deleteHit).
//
// Every reader entry point is fed ~7k generated strings (cmd, PowerShell,
// POSIX, backslashes, rd, nested quotes, long inputs), in a worker the test
// can stop: a call that does not come back
// within the watchdog fails the test with its input, and no call may take
// longer than 50 ms (the slowest of three tries, so a busy runner's pause is
// not counted against the reader).
// Fixture strings are inert data, never executed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "murage-reader-hang-"));
afterAll(() => removeTempDirSync(home));

/** Per call. A call slower than this on all three tries fails. */
const CALL_MS = 50;
/** No progress for this long is a reader that does not return. */
const WATCHDOG_MS = 5_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROGRAMS = [
  "cmd.exe /c", "cmd /c", "cmd /k", "cmd /r", "powershell -Command", "pwsh -NoProfile -c", "bash -c", "sh -lc", "zsh -ic",
  "rd /s /q", "rmdir /s /q", "del /f /q", "erase", "rm -rf", "rm -r", "Remove-Item -Recurse -Force", "ri -r -fo", "dir", "echo", "type",
  "copy", "xcopy /e", "robocopy /mir", "git clean -fdx", "find . -delete", "python -c", "node -e", "source", ".", "bash", "python",
  "Get-ChildItem | Remove-Item", "cd", "pushd", "set X=", "$x =", "for /f %i in ('dir /b') do", "if exist", "start", "call",
  "curl -X DELETE", "gh api -X DELETE", "mv", "rsync --delete", "sudo rm -rf", "xargs rm", "find / -exec rm {} +",
];
const TARGETS = [
  "C:\\Windows", "C:\\", "C:\\Users\\owner", "D:\\data\\x", "\\\\server\\share\\x", "C:notes.txt", "\\temp\\x", "%USERPROFILE%\\Desktop",
  "%TEMP%\\x", "$env:USERPROFILE\\x", "~", "~/proj", "/", "/tmp/a", "/var/b", "/etc", "/s", "/q", "./build", "../up", "*", "C:\\*",
  "\"C:\\Program Files\\x\"", "'C:\\a b'", "\"$HOME\"", "${HOME}/x", "$(pwd)/x", "`pwd`/y", "\"a\\\"b\"", "'it''s'", "x\\ y",
  "venv/bin/activate", "~/.zshrc", "./env.sh", "build.sh", "manage.py", "/dev/sda", "\\\\.\\PhysicalDrive0", "-rf", "--", "/d",
];
const JOINERS = [" & ", " && ", " || ", " | ", "; ", "\n", " ", " ^& ", "\r\n", " 2>&1 ", " > out.txt ", " < in.txt "];
const NOISE = ["\\", "\\\\", "\"", "'", "`", "^", "%", "!", "$", "(", ")", "{", "}", "[", "]", "#", "<<EOF\n", "@'\n", "\n'@", "*", "?", ":", "/"];

function nestQuotes(random: () => number, text: string): string {
  const depth = Math.floor(random() * 4);
  let out = text;
  for (let i = 0; i < depth; i++) {
    out = random() < 0.5 ? `"${out.replace(/"/g, random() < 0.5 ? '\\"' : '""')}"` : `'${out.replace(/'/g, "'\\''")}'`;
    if (random() < 0.5) out = `${PROGRAMS[Math.floor(random() * 9)]} ${out}`;
  }
  return out;
}

function generated(count: number): string[] {
  const random = rng(105);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const parts: string[] = [];
    const commands = 1 + Math.floor(random() * 5);
    for (let c = 0; c < commands; c++) {
      let command = `${pick(PROGRAMS)} ${pick(TARGETS)}`;
      for (let t = Math.floor(random() * 4); t > 0; t--) command += ` ${pick(TARGETS)}`;
      if (random() < 0.3) command += pick(NOISE);
      if (random() < 0.3) command = nestQuotes(random, command);
      parts.push(command);
      parts.push(pick(JOINERS));
    }
    let text = parts.join("");
    // long inputs: repeated targets, deep backslash runs, long words
    const roll = random();
    if (roll < 0.04) text = `rd /s /q ${Array.from({ length: 400 }, (_, i) => `C:\\d${i}\\x`).join(" ")}`;
    else if (roll < 0.08) text = `rm -rf ${Array.from({ length: 400 }, (_, i) => `/top${i}/x`).join(" ")}`;
    else if (roll < 0.1) text = `${pick(PROGRAMS)} ${"\\".repeat(2000 + Math.floor(random() * 4000))}`;
    else if (roll < 0.12) text = `${pick(PROGRAMS)} ${"\"".repeat(1 + Math.floor(random() * 3000))}`;
    else if (roll < 0.14) text = `${pick(PROGRAMS)} ${"a".repeat(20_000)} & rd /s /q C:\\Windows`;
    else if (roll < 0.16) text = Array.from({ length: 300 }, () => `${pick(PROGRAMS)} ${pick(TARGETS)}`).join(pick(JOINERS));
    out.push(text);
  }
  return out;
}

/** Each entry point the server judges a command through. */
const WORKER = (urls: Record<string, string>) => `
import { parentPort, workerData } from "node:worker_threads";
import { posix, win32 } from "node:path";
const { classifyStopLine } = await import(${JSON.stringify(urls.stopLine)});
const { alwaysAskCommand, alwaysAskRoutineCommand } = await import(${JSON.stringify(urls.alwaysAsk)});
const { autoVerdict, approvalKey } = await import(${JSON.stringify(urls.autoApprove)});
const progress = new Int32Array(workerData.progress);
const CWD = "/work/project", WIN_CWD = "C:\\\\Users\\\\owner\\\\Projects\\\\site";
const nix = { cwd: CWD, roots: [CWD, "/tmp"], home: "/home/tester", knownRecipients: new Set(), realpath: (p) => posix.normalize(p) };
const win = { cwd: WIN_CWD, roots: [WIN_CWD], home: "C:\\\\Users\\\\owner", knownRecipients: new Set(), realpath: (p) => (/^[A-Za-z]:\\\\|^\\\\\\\\/.test(p) ? win32.normalize(p) : posix.normalize(p)) };
const AUTO = { autoApprove: true }, NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const calls = [
  ["stop line, POSIX place", (t) => classifyStopLine("Bash", { command: t }, "", nix)],
  ["stop line, Windows place", (t) => classifyStopLine("PowerShell", { command: t }, "", win)],
  ["stop line, card text only", (t) => classifyStopLine("Bash", {}, t, nix)],
  ["always ask, POSIX", (t) => alwaysAskCommand(t, CWD)],
  ["always ask, PowerShell", (t) => alwaysAskCommand(t, WIN_CWD, "command", "pwsh")],
  ["always ask, routine", (t) => alwaysAskRoutineCommand(t, CWD)],
  ["auto verdict, Auto", (t) => autoVerdict(AUTO, "Bash", t, { commandText: t, commandCwd: CWD })],
  ["auto verdict, No limits", (t) => autoVerdict(NO_LIMITS, "Bash", t, { commandText: t, commandCwd: CWD })],
  ["approval key", (t) => approvalKey("Bash", t)],
];
const slow = [];
for (let i = 0; i < workerData.inputs.length; i++) {
  const text = workerData.inputs[i];
  for (let c = 0; c < calls.length; c++) {
    Atomics.store(progress, 0, i);
    Atomics.store(progress, 1, c);
    Atomics.add(progress, 2, 1);
    let best = Infinity;
    for (let attempt = 0; attempt < 3 && best > workerData.callMs; attempt++) {
      const start = performance.now();
      try { calls[c][1](text); } catch (error) { parentPort.postMessage({ type: "threw", entry: calls[c][0], text: text.slice(0, 300), error: String(error).slice(0, 300) }); }
      best = Math.min(best, performance.now() - start);
    }
    if (best > workerData.callMs) slow.push({ entry: calls[c][0], ms: Math.round(best), text: text.slice(0, 300) });
  }
}
parentPort.postMessage({ type: "done", slow, entries: calls.map((c) => c[0]) });
`;

interface Outcome { hung?: { entry: number; text: string }; slow: Array<{ entry: string; ms: number; text: string }>; threw: unknown[]; entries: string[] }

function runReaders(inputs: string[]): Promise<Outcome> {
  const url = (path: string) => new URL(path, import.meta.url).href;
  const source = WORKER({ stopLine: url("./stop-line.ts"), alwaysAsk: url("./always-ask.ts"), autoApprove: url("./auto-approve.ts") });
  const progress = new SharedArrayBuffer(12);
  const view = new Int32Array(progress);
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { inputs, progress, callMs: CALL_MS },
    execArgv: ["--experimental-strip-types"],
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: join(home, "data") },
  });
  const threw: unknown[] = [];
  return new Promise((resolve, reject) => {
    let seen = -1;
    let still = 0;
    const timer = setInterval(() => {
      const ticks = Atomics.load(view, 2);
      // the worker is still loading the readers
      if (ticks === 0) return;
      if (ticks !== seen) { seen = ticks; still = 0; return; }
      still += 250;
      if (still < WATCHDOG_MS) return;
      clearInterval(timer);
      const at = Atomics.load(view, 0);
      void worker.terminate().then(() => resolve({ hung: { entry: Atomics.load(view, 1), text: inputs[at]!.slice(0, 300) }, slow: [], threw, entries: [] }));
    }, 250);
    worker.on("message", (message: { type: string } & Omit<Outcome, "hung" | "threw">) => {
      if (message.type === "threw") { threw.push(message); return; }
      clearInterval(timer);
      void worker.terminate();
      resolve({ slow: message.slow, threw, entries: message.entries });
    });
    worker.once("error", (error) => { clearInterval(timer); reject(error); });
  });
}

describe("the 1.0.4 stop-line hang", () => {
  it("every delete of targets in separate top folders comes back, as a stop", async () => {
    const inputs = [
      "cmd.exe /c dir & rd /s /q C:\\Windows",
      "rd /s /q C:\\Windows",
      "rm -rf /tmp/a /var/b",
      "rm -r /a /b",
      "Remove-Item C:\\a\\x, D:\\b\\y",
    ];
    const outcome = await runReaders(inputs);
    expect(outcome.hung, JSON.stringify(outcome.hung)).toBeUndefined();
    expect(outcome.threw).toEqual([]);
    expect(outcome.slow).toEqual([]);
  }, 60_000);
});

describe("no command text holds a reader", () => {
  const corpus = [...new Set(generated(8_200))];
  it("the corpus is ~7k generated strings", () => {
    expect(corpus.length, String(corpus.length)).toBeGreaterThan(7_000);
    expect(corpus.some((text) => text.length > 20_000)).toBe(true);
  });
  it(`every entry point returns within ${CALL_MS} ms on every string`, async () => {
    const outcome = await runReaders(corpus);
    expect(outcome.hung, JSON.stringify(outcome.hung)).toBeUndefined();
    expect(outcome.entries.length).toBe(9);
    // a reader may throw only for text it rejects outright; none should
    expect(outcome.threw).toEqual([]);
    expect(outcome.slow).toEqual([]);
  }, 600_000);
});
