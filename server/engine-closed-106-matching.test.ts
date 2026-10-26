// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lane 106 engine-history-home, the rest of it: what counts as Murage's own, and what the log compares.
// - A package named anywhere in a program's arguments still reads as that engine open (the base rule): a file list or a prompt that
//   names `hermes-agent` reads as Hermes open. That errs closed: it only delays a deletion, and never lets Murage touch the files of an
//   engine that is running. (A narrower rule was tried and reverted after eight review rounds.)
// - A parent pid that was reused (Windows keeps a child's parent id after the parent exits) does not make a process Murage's own.
// - The one-line-per-change log compares every holder, not the five the holder list keeps.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";

import { foreignEngineHolders, processState } from "./engine-closed.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-matching-106-")));
const home = join(scratch, ".claude");
mkdirSync(home, { recursive: true });
afterAll(() => removeTempDirSync(scratch));

const state = (engine: string, exe: string, argv: string[]) => processState(engine, [proc(exe, argv, 7100)], 1);
const PY = "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python";

it("a path naming the Hermes package reads as Hermes open, wherever it stands (the base rule, kept on purpose)", () => {
  // the secret scan from Sean's log, its file list reaching a hermes-agent checkout: open, so the deletion waits (never a false closed)
  expect(state("hermes", PY, [PY, "/Users/x/.config/murage-test/secret-scan.py", "skills-library/a/SKILL.md", "vendor/hermes-agent/run_agent.py"])).toBe("open");
  expect(state("hermes", PY, [PY, "-m", "cProfile", "/home/x/src/hermes-agent/run_agent.py"])).toBe("open");
  expect(state("hermes", "/bin/bash", ["bash", "-c", "cd ~/src/hermes-agent && git pull"])).toBe("open");
  // Hermes itself, by its module, its installed script and its program
  expect(state("hermes", PY, [PY, "-m", "hermes_cli.main", "chat"])).toBe("open");
  expect(state("hermes", "/Users/x/.local/bin/hermes", ["hermes", "chat"])).toBe("open");
  expect(state("claude", "/usr/local/bin/node", ["node", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "-p"])).toBe("open");
});

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => fake.restore());

it("a process whose parent pid is Murage's but which started before Murage did is not Murage's own (a reused pid)", () => {
  // this process is on the fake list with start 1; a child of it started at 2, a process holding a reused parent id started at 0.5
  const child = { ...proc("/usr/local/bin/claude", ["claude"], 7201), ppid: process.pid, start: 2 };
  fake.processes.push(child);
  fake.environments.set(child.pid, { HOME: scratch, CLAUDE_CONFIG_DIR: home });
  expect(foreignEngineHolders("claude", home)).toMatchObject({ state: "not-seen", ownOnly: true });
  child.start = 0.5;
  expect(foreignEngineHolders("claude", home).state).toBe("open");
});

it("the holder kinds cover every holder, past the five the list keeps", () => {
  for (let n = 0; n < 6; n++) {
    const item = proc("/usr/local/bin/claude", ["claude"], 7300 + n);
    fake.processes.push(item);
    fake.environments.set(item.pid, { HOME: scratch, CLAUDE_CONFIG_DIR: home });
  }
  const sixth = { ...proc(PY, [PY, "/x/node_modules/@anthropic-ai/claude-code/cli.js"], 7310) };
  fake.processes.push(sixth);
  fake.environments.set(sixth.pid, { HOME: scratch, CLAUDE_CONFIG_DIR: home });
  const seen = foreignEngineHolders("claude", home);
  expect(seen.state).toBe("open");
  expect(seen.holders).toHaveLength(5);
  expect(seen.kinds).toEqual(["claude|program name", "python|package in arguments"]);
});
