// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A builder's most common command: write a script with a here-document, then
// run it, in one command. Through 1.0.17 the reader held such a script only
// when it looked up the home folder, deleted or ran something, or named a
// catastrophe. The No limits marks work replaced that scan with a closed
// grammar (one print statement) and held everything else at EVERY level, so
// at Auto and Full access any real script written and run in one command
// raised the "Murage could not read this command" card. The closed grammar is
// the strict (doubt) read only; every other read judges the written code as
// 1.0.17 did and then by the same family scan inline code gets.
import { describe, expect, it } from "vitest";

import { alwaysAskCommand } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";

const CWD = "/work/site";
const AUTO = { id: "builder", autoApprove: true };
const FULL = { id: "builder", autoApprove: true, fullAccess: true };
const NO_LIMITS = { id: "builder", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER: AutoContext = { ownerStarted: true, fullAccessOrigin: "owner", commandCwd: CWD, workFolder: CWD, promptFacts: { home: "/home/u", cwd: CWD } } as AutoContext;
const verdict = (bot: object, command: string) => autoVerdict(bot as never, "Bash", command, { ...OWNER, ...(bot === NO_LIMITS ? { outsideRead: null } : {}), commandText: command });
const heredoc = (file: string, body: string, run: string) => `cat > ${file} <<'EOF'\n${body}\nEOF\n${run}`;

const SERVER_JS = [
  "const http = require('http');",
  "const fs = require('fs');",
  "const board = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ((r + c) % 2 ? 'dark' : 'light')));",
  "http.createServer((req, res) => {",
  "  res.setHeader('content-type', 'text/html');",
  "  res.end(fs.readFileSync('index.html', 'utf8'));",
  "}).listen(3000, () => console.log(\"it's up on 3000\"));",
].join("\n");
const CHECK_PY = [
  "import json",
  "from pathlib import Path",
  "page = Path('index.html').read_text()",
  "print(json.dumps({'squares': page.count('class=\"sq\"')}))",
].join("\n");
const TEST_MJS = "import { strict as assert } from 'node:assert';\nimport { moves } from './game.mjs';\nassert.equal(moves([]).length, 0);\nconsole.log('ok');";

const ORDINARY: [string, string][] = [
  ["node server, written then run", heredoc("server.js", SERVER_JS, "node server.js")],
  ["node module test, written then run", heredoc("game.test.mjs", TEST_MJS, "node game.test.mjs")],
  ["python check, written then run", heredoc("check.py", CHECK_PY, "python3 check.py")],
  ["made in a folder first", `mkdir -p tools && ${heredoc("tools/check.py", CHECK_PY, "python3 tools/check.py")}`],
  ["a python shebang script run directly", `${heredoc("check.py", `#!/usr/bin/env python3\n${CHECK_PY}`, "chmod +x check.py && ./check.py")}`],
];

describe("a script written by a here-document and run in the same command", () => {
  it.each(ORDINARY)("runs without a card at Full access: %s", (_name, command) => {
    expect(verdict(FULL, command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  it.each(ORDINARY)("raises no could-not-read card at Auto: %s", (_name, command) => {
    const found = verdict(AUTO, command);
    expect(found.source).not.toBe("always-ask");
    expect(found.rule).not.toBe("unreadable");
  });

  it.each(ORDINARY)("still runs at No limits: %s", (_name, command) => {
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });

  // fail closed: what 1.0.17 held in a written script is held now, with the same card
  const HELD: [string, string][] = [
    ["deletes", heredoc("clean.js", "const fs = require('fs');\nfs.rmSync(process.argv[2], { recursive: true, force: true });", "node clean.js")],
    ["runs a program", heredoc("run.js", "require('child_process').execSync(process.env.STEP);", "node run.js")],
    ["runs a literal program", heredoc("build.js", "require('child_process').execSync('npm run build', { stdio: 'inherit' });", "node build.js")],
    ["only looks up the home folder", heredoc("where.js", "const os = require('os');\nconsole.log(os.homedir());", "node where.js")],
    ["python runs a program", heredoc("run.py", "import subprocess\nsubprocess.run(['sh', 'step.sh'])", "python3 run.py")],
    ["looks up the home folder", heredoc("home.py", "import os, shutil\nshutil.rmtree(os.path.expanduser('~'))", "python3 home.py")],
    ["names a catastrophe", heredoc("wipe.py", "import shutil\nshutil.rmtree('/')", "python3 wipe.py")],
    ["names a disk", heredoc("disk.py", "open('/dev/sda', 'wb').write(b'0' * 512)", "python3 disk.py")],
    ["written from a value", "cat > step.js <<EOF\n$PAYLOAD\nEOF\nnode step.js"],
  ];
  // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn gives these the outcome No limits gives
  it.each(HELD)("at Full access either keeps the always-ask card or runs it as No limits would, when the written script %s", (_name, command) => {
    const full = verdict(FULL, command);
    if (full.approve === null) expect(full).toMatchObject({ source: "always-ask" });
    else { expect(full).toMatchObject({ source: "full-access" }); expect([undefined, "held=waived"]).toContain(full.rule); } // NOLIMITS-1022 H1 runs an unreadable one untagged
  });

  it("the strict read keeps its closed grammar: unclassified written code is still a doubt there", () => {
    expect(alwaysAskCommand(heredoc("server.js", SERVER_JS, "node server.js"), CWD)).toMatchObject({ rule: "unreadable", doubt: "tokenizer" });
    // and the one statement the grammar finishes stays readable
    expect(alwaysAskCommand(heredoc("hi.py", "print(\"hi\")", "python3 hi.py"), CWD)).toBeNull();
  });
});
