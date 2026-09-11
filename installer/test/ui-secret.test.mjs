/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * I2: the secret prompt must not echo, on a real terminal.
 *
 * The old prompt read the key through the shared readline. That interface
 * echoed every character (and a pasted line whole) before a listener redrew
 * the prompt over it, so a terminal recorder or a scrollback still held the
 * key. It also kept history, so Up at the next prompt brought the key back.
 * Only a real pseudo-terminal shows either, so this drives one with python's
 * `pty` module. Every macOS and Linux image has it, and it adds no npm
 * dependency (U-21). POSIX only: Windows has no pty.
 *
 * The assertions are on the RAW bytes the terminal received, escape
 * sequences included. The fake secret is spelled from letters that appear
 * nowhere else in what the fixture prints, so a single echoed character fails
 * the test, not just the whole secret. No real credential is involved.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const UI = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "ui.mjs")).href;

/** Letters absent from every prompt and line the harness prints. */
const FAKE_SECRET = "qzjvkpbduqzjvkpbdu";
const SECRET_LETTERS = new Set(FAKE_SECRET);
const POSIX_PTY = { skip: process.platform === "win32", timeout: 60_000 };

/**
 * The shape of `murage setup`: an ordinary prompt first (so the shared
 * interface exists and has to hand the terminal over), then the secret, then
 * another ordinary prompt. It reports what it read without printing it.
 */
const HARNESS = [
  `import { ask, askSecret, closeRl } from ${JSON.stringify(UI)};`,
  `const expected = process.env.FIXTURE_EXPECTED ?? "";`,
  `await ask("first: ");`,
  `const secret = await askSecret("secret: ");`,
  `process.stdout.write("secret-matches=" + (secret === expected ? "yes" : "no") + " raw-after=" + (process.stdin.isRaw ? "on" : "off") + "\\n");`,
  `const next = await ask("next: ");`,
  `process.stdout.write("next-nothing=" + (next === "" ? "yes" : "no") + " next-has-secret=" + (expected !== "" && next.includes(expected) ? "yes" : "no") + "\\n");`,
  `closeRl();`,
].join("\n");

/**
 * Runs argv on a new pseudo-terminal. For each step, waits for `expect` to
 * appear in the output after the previous match, then writes each part of
 * `send` with a short gap between them, as typing does. Reports the raw bytes
 * and how the process ended.
 */
const DRIVER = String.raw`
import base64, json, os, pty, select, signal, sys, time

spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(spec["argv"][0], spec["argv"], spec["env"])

raw = bytearray()
pos = 0
eof = False

def pump(timeout):
    global eof
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        chunk = b""
    if chunk:
        raw.extend(chunk)
    else:
        eof = True

missed = None
for expect, send in spec["steps"]:
    needle = expect.encode()
    deadline = time.monotonic() + 15
    while True:
        at = raw.find(needle, pos)
        if at >= 0:
            pos = at + len(needle)
            break
        if eof or time.monotonic() > deadline:
            missed = expect
            break
        pump(0.1)
    if missed is not None:
        break
    for part in send:
        os.write(fd, part.encode("latin-1"))
        time.sleep(0.05)

deadline = time.monotonic() + 15
while not eof and time.monotonic() < deadline:
    pump(0.1)

status = 0
for _ in range(200):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
    time.sleep(0.05)
else:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    missed = missed or "the fixture did not exit"

print(json.dumps({
    "missed": missed,
    "raw": base64.b64encode(bytes(raw)).decode(),
    "code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
    "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
}))
`;

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) safeWipeSync(dir);
});

/**
 * @param {[string, string[]][]} steps
 * @param {{ expected?: string }} [opts] what the harness should read as the secret
 * @returns {{ missed: string | null, raw: string, code: number | null, signal: number | null }}
 */
function onTerminal(steps, { expected = FAKE_SECRET } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-ui-secret-")));
  scratchDirs.push(dir);
  const harness = join(dir, "harness.mjs");
  const driver = join(dir, "pty-driver.py");
  writeFileSync(harness, HARNESS);
  writeFileSync(driver, DRIVER);
  const spec = {
    argv: [process.execPath, harness],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TERM: "xterm-256color", FIXTURE_EXPECTED: expected },
    steps,
  };
  const run = spawnSync("python3", [driver, JSON.stringify(spec)], { encoding: "utf8", timeout: 50_000 });
  if (run.error) throw new Error(`this test drives a pseudo-terminal with python3, which could not run: ${run.error.message}`);
  assert.equal(run.status, 0, `the pty driver failed:\n${run.stderr}`);
  const result = JSON.parse(run.stdout);
  return { ...result, raw: Buffer.from(result.raw, "base64").toString("latin1") };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g;

/** Not the secret, not three letters of it in a row, and not one letter of it anywhere outside an escape sequence. */
function assertNothingEchoed(raw, label) {
  const shown = JSON.stringify(raw);
  assert.ok(!raw.includes(FAKE_SECRET), `${label}: the secret reached the terminal: ${shown}`);
  for (let i = 0; i + 3 <= FAKE_SECRET.length; i += 1) {
    assert.ok(!raw.includes(FAKE_SECRET.slice(i, i + 3)), `${label}: part of the secret reached the terminal: ${shown}`);
  }
  const echoed = [...raw.replace(ANSI, "")].filter((ch) => SECRET_LETTERS.has(ch));
  assert.deepEqual(echoed, [], `${label}: characters of the secret were echoed: ${shown}`);
}

test("a typed secret, corrected with backspace, is read exactly and never echoed, and raw mode ends with it", POSIX_PTY, () => {
  const typed = [...FAKE_SECRET.slice(0, 9), "a", "\x7f", ...FAKE_SECRET.slice(9), "\r"];
  const r = onTerminal([
    ["first: ", ["\r"]],
    ["secret: ", typed],
    ["next: ", ["\r"]],
  ]);
  assert.equal(r.missed, null, `waited for ${JSON.stringify(r.missed)}: ${JSON.stringify(r.raw)}`);
  assert.equal(r.code, 0, JSON.stringify(r.raw));
  assert.match(r.raw, /secret-matches=yes raw-after=off/);
  assert.match(r.raw, /next-nothing=yes next-has-secret=no/);
  assertNothingEchoed(r.raw, "typed");
});

test("a pasted secret with its Enter is not echoed, and Up at the next prompt does not bring it back", POSIX_PTY, () => {
  const r = onTerminal([
    ["first: ", ["\r"]],
    ["secret: ", [`${FAKE_SECRET}\r`]],
    ["next: ", ["\x1b[A", "\r"]],
  ]);
  assert.equal(r.missed, null, `waited for ${JSON.stringify(r.missed)}: ${JSON.stringify(r.raw)}`);
  assert.equal(r.code, 0, JSON.stringify(r.raw));
  assert.match(r.raw, /secret-matches=yes/);
  assert.match(r.raw, /next-nothing=yes next-has-secret=no/, "history handed the secret to the next prompt");
  assertNothingEchoed(r.raw, "pasted");
});

test("EOF at the secret prompt skips it, and the prompts after it take their defaults, as with piped input", POSIX_PTY, () => {
  const r = onTerminal(
    [
      ["first: ", ["\r"]],
      ["secret: ", ["\x04"]],
    ],
    { expected: "" }
  );
  assert.equal(r.missed, null, `waited for ${JSON.stringify(r.missed)}: ${JSON.stringify(r.raw)}`);
  assert.equal(r.code, 0, JSON.stringify(r.raw));
  assert.match(r.raw, /secret-matches=yes raw-after=off/);
  assert.match(r.raw, /next-nothing=yes/);
  assert.ok(!r.raw.includes("next: "), "a prompt after EOF waited for input that cannot come");
});

test("Ctrl-C at the secret prompt interrupts, as at any other prompt, without echoing what was typed", POSIX_PTY, () => {
  const r = onTerminal([
    ["first: ", ["\r"]],
    ["secret: ", [...FAKE_SECRET.slice(0, 6), "\x03"]],
  ]);
  assert.equal(r.missed, null, `waited for ${JSON.stringify(r.missed)}: ${JSON.stringify(r.raw)}`);
  assert.equal(r.signal, 2, `expected the process to end on SIGINT; code ${r.code}: ${JSON.stringify(r.raw)}`);
  assert.ok(!r.raw.includes("secret-matches"), "an interrupted prompt carried on as though answered");
  assertNothingEchoed(r.raw, "interrupted");
});
