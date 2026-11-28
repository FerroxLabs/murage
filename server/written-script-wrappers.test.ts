// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN ruling 2026-11-21 (cause13): a script the same command writes and then
// runs is judged by the same scan whatever wraps the run: an output redirect,
// a background `&`, another command before it (`;` `&&` `||`), a subshell, or
// a `cd` first. Only a script this command did NOT write keeps the 1.0.5
// unseen-script rule (its shape admits the plain run, beside `cd` and the
// commands that only print; any other wrapper asks). A written script that
// deletes the home folder still cards under every wrapper at Auto and Full
// access.
//
// These rows already held on 3bc39b4578 (025fd81c29 restored the written-script
// scan for every wrapper, not only the plain run): they pin the ruling, so a
// change to either rule has to move a row here on purpose.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const CWD = "/work/site";
const AUTO = { id: "builder", autoApprove: true };
const FULL = { id: "builder", autoApprove: true, fullAccess: true };
const NO_LIMITS = { id: "builder", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER: AutoContext = { ownerStarted: true, fullAccessOrigin: "owner", commandCwd: CWD, workFolder: CWD, promptFacts: { home: "/home/u", cwd: CWD } } as AutoContext;
const verdict = (bot: object, command: string) => autoVerdict(bot as never, "Bash", command, { ...OWNER, ...(bot === NO_LIMITS ? { outsideRead: null } : {}), commandText: command });
const write = (file: string, body: string) => `cat > ${file} <<'EOF'\n${body}\nEOF`;

const SERVER_JS = [
  "const http = require('http');",
  "const fs = require('fs');",
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
const WIPE_HOME_JS = "const fs = require('fs');\nconst os = require('os');\nfs.rmSync(os.homedir(), { recursive: true, force: true });";
const WIPE_HOME_PY = "import os, shutil\nshutil.rmtree(os.path.expanduser('~'))";

/** Every wrapper the ruling names, as the run half of the command. `file` is the script as the write half names it. */
const WRAPPERS: [string, (run: string, file: string) => string][] = [
  ["output redirect", (run, file) => `${run} ${file} > run.log 2>&1`],
  ["appending redirect", (run, file) => `${run} ${file} >> run.log`],
  ["background &", (run, file) => `${run} ${file} &`],
  ["redirect and background", (run, file) => `${run} ${file} > run.log 2>&1 &`],
  ["after another command with ;", (run, file) => `echo starting; ${run} ${file}`],
  ["after another command with &&", (run, file) => `mkdir -p out && ${run} ${file}`],
  ["after another command with ||", (run, file) => `test -d out || ${run} ${file}`],
  ["in a subshell", (run, file) => `(${run} ${file})`],
  ["in a subshell with a redirect, in the background", (run, file) => `(${run} ${file} > run.log 2>&1) &`],
  ["after && with a redirect, in the background", (run, file) => `mkdir -p out && ${run} ${file} > out/run.log 2>&1 &`],
];
const rows = (file: string, body: string, run: string): [string, string][] =>
  WRAPPERS.map(([name, wrap]) => [name, `${write(file, body)}\n${wrap(run, file)}`]);

const ORDINARY: [string, string][] = [
  ...rows("server.js", SERVER_JS, "node").map(([name, command]): [string, string] => [`node, ${name}`, command]),
  ...rows("check.py", CHECK_PY, "python3").map(([name, command]): [string, string] => [`python, ${name}`, command]),
  // the heredoc line itself carries the run
  ["node, joined to the heredoc line by &&, redirected", `cat > server.js <<'EOF' && node server.js > run.log 2>&1\n${SERVER_JS}\nEOF`],
  // cd first: the script is written in a folder, the run changes into it
  ["node, cd first", `mkdir -p tools\n${write("tools/server.js", SERVER_JS)}\ncd tools && node server.js`],
  ["node, cd first, redirected, in the background", `mkdir -p tools\n${write("tools/server.js", SERVER_JS)}\ncd tools && node server.js > run.log 2>&1 &`],
  ["python, cd first in a subshell", `mkdir -p tools\n${write("tools/check.py", CHECK_PY)}\n(cd tools && python3 check.py)`],
  ["python, cd before the write and the run", `mkdir -p tools && cd tools\n${write("check.py", CHECK_PY)}\npython3 check.py > check.log`],
  ["node, a new folder made and entered, then the write and the run on their own lines", `mkdir -p app && cd app\n${write("server.js", SERVER_JS)}\nnode server.js > run.log 2>&1 &`],
  ["node, a new folder made and entered, the write and the run all one && chain", `mkdir -p app && cd app && cat > server.js <<'EOF' && node server.js > run.log 2>&1\n${SERVER_JS}\nEOF`],
  ["node, cd to the work folder by its full path", `${write("server.js", SERVER_JS)}\ncd ${CWD} && node server.js > run.log 2>&1 &`],
];

describe("a script written and run in one command is judged by the same scan whatever wraps the run", () => {
  it.each(ORDINARY)("runs without a card at Full access: %s", (_name, command) => {
    expect(verdict(FULL, command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  it.each(ORDINARY)("raises no could-not-read card at Auto: %s", (_name, command) => {
    const found = verdict(AUTO, command);
    expect(found).toMatchObject({ approve: expect.any(String), source: "auto-mode" });
    expect(found.rule).not.toBe("unreadable");
  });

  it.each(ORDINARY)("still runs at No limits: %s", (_name, command) => {
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });
});

// OPEN for MAIN (found by this lane, not changed): `mkdir -p app && cd app && cat > server.js <<EOF` with the run on the
// NEXT line. Past its first command a `&&` chain may or may not have run, so after it the reader no longer knows the
// folder (walk.ts merge: cwdConflict) and cannot match `node server.js` to the file the chain wrote: it is read as a
// script on disk and asks. This is the folder mark, not a wrapper: the same text with `cd app` ending its line, or with
// the run inside the chain, runs (rows above). Pinned so that lifting it is a deliberate change with its own ruling.
describe("held today: the script was written inside a && chain that also changed folder, and runs after the chain", () => {
  const AFTER_CHAIN = `mkdir -p app && cd app && ${write("server.js", SERVER_JS)}\nnode server.js`;
  it("asks at Auto, and runs at Full access as it does at No limits, as a command the reader could not place", () => {
    // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn runs a command Murage could not read
    expect(verdict(FULL, AFTER_CHAIN)).toMatchObject({ approve: expect.any(String), source: "full-access" });
    expect(verdict(AUTO, AFTER_CHAIN)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
  });
});

describe("guard: a written script that deletes the home folder still cards under every wrapper", () => {
  const WIPES: [string, string][] = [
    ...rows("clean.js", WIPE_HOME_JS, "node").map(([name, command]): [string, string] => [`node, ${name}`, command]),
    ...rows("clean.py", WIPE_HOME_PY, "python3").map(([name, command]): [string, string] => [`python, ${name}`, command]),
    ["node, cd first, redirected, in the background", `mkdir -p tools\n${write("tools/clean.js", WIPE_HOME_JS)}\ncd tools && node clean.js > run.log 2>&1 &`],
    ["python, cd first in a subshell", `mkdir -p tools\n${write("tools/clean.py", WIPE_HOME_PY)}\n(cd tools && python3 clean.py)`],
    ["python, a literal wipe of the whole disk, redirected, in the background", `${write("wipe.py", "import shutil\nshutil.rmtree('/')")}\npython3 wipe.py > run.log 2>&1 &`],
    ["a shell script that removes the home folder, redirected, in the background", `${write("clean.sh", "rm -rf ~")}\nbash clean.sh > run.log 2>&1 &`],
  ];
  // OVERREACH #6: the owner's own Full access turn gives these the same outcome as No limits (a wipe the reader names still asks; a script
  // body No limits does not read runs, as it does at No limits)
  it.each(WIPES)("at Full access either keeps the always-ask card or runs as No limits would: %s", (_name, command) => {
    const full = verdict(FULL, command);
    if (full.approve === null) expect(full).toMatchObject({ source: "always-ask" });
    else expect(full).toMatchObject({ source: "full-access", rule: "held=waived" });
  });
  it.each(WIPES)("asks at Auto: %s", (_name, command) => {
    expect(verdict(AUTO, command)).toMatchObject({ approve: null, source: "always-ask" });
  });
});

describe("a script this command did not write keeps the 1.0.5 unseen-script rule", () => {
  // the script is really on disk, so no row asks for a missing file. The 1.0.5 shape is the one script beside `cd` and
  // the commands that only print, with no redirect, `&` or subshell: a row asks either for its wrapper (redirect, `&`,
  // subshell) or because another command in the text is outside that shape (`mkdir`, `test`, a heredoc write)
  const disk = realpathSync(mkdtempSync(join(tmpdir(), "written-script-wrappers-")));
  mkdirSync(join(disk, "tools"));
  writeFileSync(join(disk, "server.js"), "console.log('on disk');\n");
  afterAll(() => removeTempDirSync(disk));
  const onDisk = (command: string) => autoVerdict(FULL as never, "Bash", command, { ...OWNER, commandCwd: disk, workFolder: disk, promptFacts: { home: "/home/u", cwd: disk }, commandText: command } as AutoContext);

  // the 1.0.5 shape, unchanged: the plain run, alone or beside a command that only prints
  const ADMITTED: [string, string][] = [
    ["the plain run", "node server.js"],
    ["after a command that only prints", "echo starting; node server.js"],
    ["after a command that only prints, joined by &&", "echo starting && node server.js"],
  ];
  it.each(ADMITTED)("still goes ahead unseen at Full access: %s", (_name, command) => {
    expect(onDisk(command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  const PRINTS_ONLY = new Set(["after another command with ;"]);
  const WRAPPED = WRAPPERS.filter(([name]) => !PRINTS_ONLY.has(name));
  const UNSEEN: [string, string][] = [
    ...WRAPPED.map(([name, wrap]): [string, string] => [`node, ${name}`, wrap("node", "server.js")]),
    // writing a DIFFERENT file does not make the script that runs a written one
    ...WRAPPERS.map(([name, wrap]): [string, string] => [`node, another file written first, ${name}`, `${write("notes.js", SERVER_JS)}\n${wrap("node", "server.js")}`]),
    ["node, the written script is in another folder than the one that runs", `${write("tools/server.js", SERVER_JS)}\nnode server.js > run.log 2>&1 &`],
    ["node, cd away from the script on disk into the folder of another written file", `${write("tools/notes.js", SERVER_JS)}\ncd tools && node ../server.js > run.log 2>&1 &`],
  ];
  it.each(UNSEEN)("a wrapped run of a script on disk runs at Full access, as at No limits, though the reader could not place it: %s", (_name, command) => {
    // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn runs the unreadable rule
    expect(onDisk(command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });
});
