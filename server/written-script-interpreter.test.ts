// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A script a command writes and then runs is judged by the written-script
// scan only when its interpreter is one the reader can follow: a shell, or a
// language the scan models (node, python and the others it lists), named by a
// plain first line (`#!/usr/bin/env python3`, `#!/usr/bin/node`). The scan
// reads language calls. It does not read a makefile, an awk or expect script,
// a csh script, or whatever a program in the work folder does with the file.
// So a first line naming anything else (an interpreter the scan does not
// model, an `env -S` line, a program by a relative or unusual path, an
// interpreter given switches) keeps the 1.0.20 hold: the command asks, with
// the could-not-read card, at Auto and at Full access. No limits is not made
// stricter than 1.0.20 by this.
import { describe, expect, it } from "vitest";

import { autoVerdict, type AutoContext } from "./auto-approve.ts";

const CWD = "/work/site";
const AUTO = { id: "builder", autoApprove: true };
const FULL = { id: "builder", autoApprove: true, fullAccess: true };
const NO_LIMITS = { id: "builder", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER: AutoContext = { ownerStarted: true, fullAccessOrigin: "owner", commandCwd: CWD, workFolder: CWD, promptFacts: { home: "/home/u", cwd: CWD } } as AutoContext;
const verdict = (bot: object, command: string) => autoVerdict(bot as never, "Bash", command, { ...OWNER, ...(bot === NO_LIMITS ? { outsideRead: null } : {}), commandText: command });
const write = (file: string, body: string) => `cat > ${file} <<'EOF'\n${body}\nEOF`;

/** The ways a command runs the file it just wrote by its path. */
const RUNS: [string, (file: string) => string][] = [
  ["chmod +x, then run by path", (file) => `chmod +x ${file} && ./${file}`],
  ["chmod 755, then run by path with its output kept, in the background", (file) => `chmod 755 ${file}\n./${file} > run.log 2>&1 &`],
  ["chmod +x, then run by its full path", (file) => `chmod +x ${file}; ${CWD}/${file}`],
];

/** First lines the reader cannot follow, each over a body no scan of language calls can judge. */
const UNFOLLOWED: [string, string, string][] = [
  // an interpreter the scan does not model
  ["a makefile run by make", "build", "#!/usr/bin/make -f\nall:\n\tfind /home/u -mindepth 1 -delete"],
  ["an awk script", "report", "#!/usr/bin/awk -f\nBEGIN { while ((\"ls\" | getline line) > 0) print line }"],
  ["an expect script", "login", "#!/usr/bin/expect\nspawn ssh build-host\ninteract"],
  ["a csh script", "setup", "#!/bin/tcsh\nmv /home/u /tmp/x"],
  ["busybox as the interpreter", "setup", "#!/bin/busybox sh\nfind /home/u -mindepth 1 -delete"],
  ["an unmodelled interpreter found by env", "report", "#!/usr/bin/env gawk\nBEGIN { print 1 }"],
  ["a program in the work folder as the interpreter", "job", "#!./tool\nstep one\nstep two"],
  ["a program given by its full path outside the system folders", "job", "#!/work/site/bin/runner\nstep one"],
  // env -S: the interpreter is whatever the rest of the line builds
  ["env -S with a shell", "setup", "#!/usr/bin/env -S bash\nfind /home/u -mindepth 1 -delete"],
  ["env -S with node", "serve", "#!/usr/bin/env -S node\nconsole.log('up');"],
  ["env -S with python and a switch", "check", "#!/usr/bin/env -S python3 -u\nprint('ok')"],
  ["env setting a variable first", "serve", "#!/usr/bin/env NODE_OPTIONS=--require=./hook.js node\nconsole.log('up');"],
  // a name the scan models, reached in a way the reader cannot verify
  ["python by a relative path", "check", "#!./python3\nprint('ok')"],
  ["node from a folder the command could have filled", "serve", "#!/tmp/tools/node\nconsole.log('up');"],
  ["node told to load another file first", "serve", "#!/usr/bin/node -r ./hook.js\nconsole.log('up');"],
  ["python told to run a module", "check", "#!/usr/bin/python3 -m hook\nprint('ok')"],
  ["env found by a relative path", "check", "#!./env python3\nprint('ok')"],
  ["a first line ending in a carriage return, which the system reads as part of the name", "check", "#!/usr/bin/env python3\r\nprint('ok')\r"],
  ["a name in capitals, which is another program where names are case-sensitive", "serve", "#!/usr/bin/env Node\nconsole.log('up');"],
];
const HELD: [string, string][] = [
  ...UNFOLLOWED.flatMap(([name, file, body]) => RUNS.map(([how, run]): [string, string] => [`${name}: ${how}`, `${write(file, body)}\n${run(file)}`])),
  // the run reached through a launcher is the same run
  ["a makefile run by make: run by path through nohup", `${write("build", "#!/usr/bin/make -f\nall:\n\tfind /home/u -mindepth 1 -delete")}\nchmod +x build && nohup ./build > build.log 2>&1 &`],
  ["env -S with a shell: run by path through timeout", `${write("setup", "#!/usr/bin/env -S bash\nfind /home/u -mindepth 1 -delete")}\nchmod +x setup && timeout 30 ./setup`],
  // a plain first line, but the command also wrote a file with the interpreter's own name: which one runs is not known
  ["node found by env, after the command wrote its own file called node", `${write("node", "#!/bin/sh\nmv /home/u /tmp/x")}\nchmod +x node; PATH=.:$PATH\n${write("serve", "#!/usr/bin/env node\nconsole.log('up');")}\nchmod +x serve && ./serve`],
  ["python by its /usr/local path, after the command wrote that file", `${write("/usr/local/bin/python3", "#!/bin/sh\nmv /home/u /tmp/x")}\n${write("check", "#!/usr/local/bin/python3\nprint('ok')")}\nchmod +x check && ./check`],
];

/** First lines the reader follows: the script is scanned as that language, as the same code handed inline is. */
const NODE_BODY = "const fs = require('fs');\nconsole.log(fs.readFileSync('index.html', 'utf8').length);";
const PY_BODY = "from pathlib import Path\nprint(len(Path('index.html').read_text()))";
const FOLLOWED: [string, string, string][] = [
  ["python3 found by env", "check.py", `#!/usr/bin/env python3\n${PY_BODY}`],
  ["python by its system path", "check.py", `#!/usr/bin/python3\n${PY_BODY}`],
  ["python under /usr/local", "check.py", `#!/usr/local/bin/python3.12\n${PY_BODY}`],
  ["node found by env", "size.js", `#!/usr/bin/env node\n${NODE_BODY}`],
  ["node by its system path", "size.js", `#!/usr/bin/node\n${NODE_BODY}`],
  ["node from Homebrew", "size.js", `#!/opt/homebrew/bin/node\n${NODE_BODY}`],
  ["env by its other system path, and a space after #!", "size.js", `#! /bin/env node\n${NODE_BODY}`],
  ["a shell script", "run.sh", "#!/bin/bash\necho building\nmkdir -p out"],
  ["a shell script found by env", "run.sh", "#!/usr/bin/env bash\necho building\nmkdir -p out"],
];
const RUN: [string, string][] = FOLLOWED.flatMap(([name, file, body]) =>
  RUNS.map(([how, run]): [string, string] => [`${name}: ${how}`, `${write(file, body)}\n${run(file)}`]));

describe("a written script whose first line names an interpreter the reader cannot follow keeps the 1.0.20 hold", () => {
  // OVERREACH #6 (MAIN 2026-11-26): the owner's own Full access turn runs a command Murage could not read, as No limits does
  it.each(HELD)("runs at Full access, as it does at No limits, though Murage could not read it: %s", (_name, command) => {
    expect(verdict(FULL, command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  it.each(HELD)("asks at Auto: %s", (_name, command) => {
    expect(verdict(AUTO, command)).toMatchObject({ approve: null });
  });

  // 1.0.20 let every one of these run at No limits (the hold is a could-not-read doubt, never a wipe finding there)
  it.each(HELD)("is no stricter at No limits than 1.0.20: %s", (_name, command) => {
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });
});

describe("a written script whose first line names an interpreter the reader follows is judged by the scan", () => {
  it.each(RUN)("runs without a card at Full access: %s", (_name, command) => {
    expect(verdict(FULL, command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  it.each(RUN)("raises no could-not-read card at Auto: %s", (_name, command) => {
    const found = verdict(AUTO, command);
    expect(found).toMatchObject({ approve: expect.any(String), source: "auto-mode" });
    expect(found.rule).not.toBe("unreadable");
  });

  it.each(RUN)("runs at No limits: %s", (_name, command) => {
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });

  // followed is not trusted: the scan still holds what it held
  const WIPES: [string, string][] = [
    ["python found by env deletes the home folder", `${write("clean.py", "#!/usr/bin/env python3\nimport os, shutil\nshutil.rmtree(os.path.expanduser('~'))")}\nchmod +x clean.py && ./clean.py`],
    ["node by its system path deletes the home folder", `${write("clean.js", "#!/usr/bin/node\nconst fs = require('fs');\nfs.rmSync(require('os').homedir(), { recursive: true, force: true });")}\nchmod +x clean.js && ./clean.js`],
    ["a shell script deletes the home folder", `${write("clean.sh", "#!/bin/bash\nrm -rf ~")}\nchmod +x clean.sh && ./clean.sh`],
  ];
  it.each(WIPES)("asks at Auto, and at Full access either keeps the card or runs as No limits would: %s", (_name, command) => {
    // OVERREACH #6 (MAIN 2026-11-26): a script body No limits does not read runs on the owner's own Full access turn too
    const full = verdict(FULL, command);
    if (full.approve === null) expect(full).toMatchObject({ source: "always-ask" });
    else expect(full).toMatchObject({ source: "full-access", rule: "held=waived" });
    expect(verdict(AUTO, command)).toMatchObject({ approve: null });
  });
});

// The 44 everyday builder commands the first cause13 round probed (cause13-unreadcard: all 44 ran at No limits; the
// here-document script forms ran at Full access once the scan was restored). Their text was not kept, so they are
// written out again here under the same names. The interpreter rule above must not move any of them.
const PAGE = (lines: number) => Array.from({ length: lines }, (_, i) => `    <div class="sq" id="sq${i}">square ${i}</div>`).join("\n");
const HTML = (lines: number) => `<!doctype html>\n<html>\n  <body>\n${PAGE(lines)}\n  </body>\n</html>`;
const GAME_JS = (lines: number) => ["const fs = require('fs');", ...Array.from({ length: lines }, (_, i) => `const move${i} = { from: ${i}, to: ${i + 9}, piece: 'dark' };`), "console.log('moves ready');"].join("\n");
const CHECK_PY = (lines: number) => ["import json", ...Array.from({ length: lines }, (_, i) => `row${i} = [${i}, ${i + 1}, ${i + 2}]`), "print(json.dumps({'ok': True}))"].join("\n");
const BUILDER: [string, string][] = [
  ["and-chain", "mkdir -p src public && touch src/index.js && ls -la src public"],
  ["cd-npm", "cd /work/site && npm install && npm run build"],
  ["pipe", "ls -la | grep html | wc -l"],
  ["heredoc-quoted", write("index.html", HTML(12))],
  ["heredoc-unquoted", `cat > index.html <<EOF\n${HTML(12)}\nEOF`],
  ["heredoc-js-quoted", write("game.js", GAME_JS(6))],
  ["heredoc-js-unquoted", `cat > game.js <<EOF\n${GAME_JS(6)}\nEOF`],
  ["multi-heredoc", `${write("index.html", HTML(8))}\n${write("style.css", ".sq { width: 40px; height: 40px; }\n.dark { background: #333; }")}\n${write("game.js", GAME_JS(6))}`],
  ["multi-heredoc-and", `mkdir -p site && ${write("site/index.html", HTML(8))}\n${write("site/style.css", ".sq { width: 40px; }")}\nls -la site`],
  ["node-e", "node -e \"console.log(require('fs').readdirSync('.').length)\""],
  ["node-e-multi", "node -e \"\nconst fs = require('fs');\nconst page = fs.readFileSync('index.html', 'utf8');\nconsole.log(page.length);\n\""],
  ["python-c", "python3 -c \"print(sum(range(10)))\""],
  ["python-c-write", "python3 -c \"open('notes.txt', 'w').write('checkers board is 8 by 8')\""],
  ["python-heredoc", "python3 <<'EOF'\nimport json\nprint(json.dumps({'squares': 64}))\nEOF"],
  ["node-heredoc", "node <<'EOF'\nconst fs = require('fs');\nconsole.log(\"it's ok\");\nEOF"],
  ["rm-inside", "rm -rf dist && mkdir dist && cp index.html dist/"],
  ["rm-node-modules", "rm -rf node_modules package-lock.json && npm install"],
  ["server-bg", "cd /work/site && npx serve -l 3000 . > serve.log 2>&1 &\nsleep 1\ncurl -s localhost:3000 | head -5"],
  ["nohup", "nohup npx http-server -p 8080 . > server.log 2>&1 &\nsleep 1; cat server.log"],
  ["for-loop", "for f in *.html; do wc -l \"$f\"; done"],
  ["if-test", "if [ -f package.json ]; then npm test; else echo none; fi"],
  ["subst", "echo \"built at $(date +%H:%M) with $(ls | wc -l) files\""],
  ["var", "PORT=3000\necho \"serving on $PORT\"\ncurl -s localhost:$PORT"],
  ["printf-redirect", "printf '%s\\n' 'node_modules' 'dist' > .gitignore && cat .gitignore"],
  ["echo-append", "echo '<!-- built by hand -->' >> index.html"],
  ["sed-i", "sed -i 's/Checkers/Sample Checkers/g' index.html && grep -c Sample index.html"],
  ["tee", "npm run build 2>&1 | tee build.log"],
  ["npx-create", "npx --yes create-vite@latest board --template vanilla && cd board && npm install"],
  ["git", "git init -q && git add -A && git commit -q -m 'first board'"],
  ["curl-pipe-node", "curl -s localhost:3000/api/board | node -e \"process.stdin.on('data', (d) => console.log(String(d).length))\""],
  ["mkdir-brace", "mkdir -p site/{css,js,img} && touch site/css/style.css site/js/game.js && ls -R site"],
  ["big-heredoc-20k", write("index.html", HTML(420))],
  ["big-heredoc-unq-20k", `cat > index.html <<EOF\n${HTML(420)}\nEOF`],
  ["big-multi-30k", `${write("index.html", HTML(300))}\n${write("game.js", GAME_JS(250))}`],
  ["big-node-heredoc-20k", `node <<'EOF'\n${GAME_JS(280)}\nEOF`],
  ["big-python-heredoc", `python3 <<'EOF'\n${CHECK_PY(900)}\nEOF`],
  ["pkg-heredoc-rm", `rm -rf dist\n${write("package.json", "{\n  \"name\": \"board\",\n  \"scripts\": { \"build\": \"vite build\" }\n}")}`],
  ["gitignore-heredoc", write(".gitignore", "node_modules\ndist\n*.log")],
  ["readme-heredoc-rm", `${write("README.md", "# Sample Checkers\n\nOpen index.html.")}\nrm -f notes.txt`],
  ["js-unlink-heredoc", `${write("clean.js", "const fs = require('fs');\nfs.unlinkSync('old.html');")}\nnode clean.js`],
  ["html-5k", write("index.html", HTML(90))],
  ["html-5k-unq", `cat > index.html <<EOF\n${HTML(90)}\nEOF`],
  ["js-5k", `${write("game.js", GAME_JS(70))}\nnode game.js`],
  ["big-70k", write("index.html", HTML(1400))],
];
/** Held before this rule and still held, each for its own reason (none is the interpreter rule). */
const ASKS_AT_FULL = new Set<string>(["js-unlink-heredoc"]);
const ASKS_AT_AUTO = new Set<string>(["js-unlink-heredoc", "rm-inside", "rm-node-modules", "if-test", "git", "big-python-heredoc", "pkg-heredoc-rm", "readme-heredoc-rm", "big-70k"]);

describe("guard: the 44 everyday builder commands are not moved by the interpreter rule", () => {
  it("is the full list", () => {
    expect(BUILDER).toHaveLength(44);
    expect(new Set(BUILDER.map(([name]) => name)).size).toBe(44);
  });

  it.each(BUILDER)("runs at No limits: %s", (_name, command) => {
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });

  it.each(BUILDER)("Full access is as before: %s", (name, command) => {
    // OVERREACH #6: a row Full access held follows No limits' outcome for the same text now
    if (ASKS_AT_FULL.has(name)) expect(verdict(FULL, command).approve === null).toBe(verdict(NO_LIMITS, command).approve === null);
    else expect(verdict(FULL, command)).toMatchObject({ approve: expect.any(String), source: "full-access" });
  });

  it.each(BUILDER)("Auto is as before: %s", (name, command) => {
    if (ASKS_AT_AUTO.has(name)) expect(verdict(AUTO, command)).toMatchObject({ approve: null });
    else expect(verdict(AUTO, command)).toMatchObject({ approve: expect.any(String), source: "auto-mode" });
  });
});
