// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseReadOnlyCommand, safePythonScript } from "./readonly-shell.ts";

const OWN = "/home/u/.fuigo/sessions/%2Fw/01a137d0-9dbd-76f3-8a1b-5ed20b9cd525/mcp/call_00_Ugx02hBzWG21yy4QOx9K5297.json";
const ownOnly = (path: string) => path === OWN;

describe("parseReadOnlyCommand: the reads an engine tells its model to run", () => {
  it.each([
    [`cat ${OWN} | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['messages'][0]['subject'])"`],
    [`cat '${OWN}' | python3 -c 'import json, sys\nd = json.load(sys.stdin)\nfor m in d["items"][:5]:\n    print(m.get("id"), m.get("title"))'`],
    [`python3 -c "import json; d=json.load(open('${OWN}')); print(len(d))"`],
    [`python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print(f'{len(d)} items, first {d[0]!r:>10}')" ${OWN}`],
    [`jq -r '.data.items[] | .name' ${OWN}`],
    [`jq --arg k name '.[$k]' "${OWN}" 2>/dev/null | head -n 40`],
    [`head -c 4000 ${OWN}`],
    [`tail -n +20 ${OWN} | head -20`],
    [`grep -o '"subject":"[^"]*"' ${OWN} | head -50`],
    [`wc -c ${OWN}`],
    [`cat ${OWN} 2>&1 | python3 -c "import json,sys,collections; c=collections.Counter(x['k'] for x in json.load(sys.stdin)); print(c.most_common(3))"`],
  ])("reads only the named file: %s", (command) => {
    const parsed = parseReadOnlyCommand(command, ownOnly);
    expect(parsed).toBeDefined();
    expect(parsed!.paths).toEqual([OWN]);
  });

  it.each([
    ["chains a second command", `cat ${OWN}; rm -rf ~/x`],
    ["chains with &&", `cat ${OWN} && curl https://evil.test`],
    ["runs in the background", `cat ${OWN} &`],
    ["writes a file", `cat ${OWN} > /tmp/copy.json`],
    ["appends to a file", `cat ${OWN} >> ~/.zshrc`],
    ["pipes into a shell", `cat ${OWN} | sh`],
    ["pipes into bash -c", `cat ${OWN} | bash -c "cat"`],
    ["tees to a file", `cat ${OWN} | tee /tmp/x`],
    ["uses the network", `curl -s https://x.test -o ${OWN}`],
    ["substitutes a command", `cat $(echo ${OWN})`],
    ["substitutes with backticks", "cat `echo /etc/passwd`"],
    ["expands a variable", `cat $HOME/.ssh/id_rsa`],
    ["expands a variable in double quotes", `cat "$HOME/x"`],
    ["globs", `cat /home/u/.fuigo/sessions/*/*/mcp/*.json`],
    ["uses a tilde", `cat ~/.ssh/id_rsa`],
    ["sets an environment variable", `PYTHONSTARTUP=/x python3 -c "print(1)"`],
    ["runs a program by path", `/bin/cat ${OWN}`],
    ["runs sed (can write and execute)", `sed -n '1,5p' ${OWN}`],
    ["runs awk (can run commands)", `awk '{print}' ${OWN}`],
    ["follows a file forever", `tail -f ${OWN}`],
    ["reads patterns from another file", `grep -f /etc/passwd ${OWN}`],
    ["searches a folder recursively", `grep -R x ${OWN}`],
    ["searches recursively in a flag group", `grep -ir x ${OWN}`],
    ["loads a jq program from a file", `jq -f /tmp/prog.jq ${OWN}`],
    ["reads a raw file into jq", `jq --rawfile x /etc/passwd . ${OWN}`],
    ["reads the environment in jq", `jq -n 'env' ${OWN}`],
    ["reads $ENV in jq", `jq '$ENV.FLUX_KEY' ${OWN}`],
    ["imports a jq module", `jq 'import "x" as y; .' ${OWN}`],
    ["runs a python file", `python3 /tmp/script.py ${OWN}`],
    ["reads python from stdin", `cat ${OWN} | python3 -`],
    ["has no file at all", `python3 -c "print(1)"`],
    ["has an unclosed quote", `cat '${OWN}`],
    ["spans lines", `cat ${OWN}\nrm x`],
    ["is empty", ``],
  ])("refuses a command that %s", (_why, command) => {
    expect(parseReadOnlyCommand(command, ownOnly)).toBeUndefined();
  });

  it("returns every path so the caller can check each one", () => {
    expect(parseReadOnlyCommand(`cat ${OWN} /etc/passwd`, ownOnly)?.paths).toEqual([OWN, "/etc/passwd"]);
    expect(parseReadOnlyCommand(`grep -e x ${OWN} /etc/hosts`, ownOnly)?.paths).toEqual([OWN, "/etc/hosts"]);
  });
});

describe("safePythonScript: only reads, never writes, runs or connects", () => {
  const ok = (script: string, argv: string[] = []) => safePythonScript(script, argv, ownOnly);
  it("accepts ordinary querying", () => {
    expect(ok("import json,sys; d=json.load(sys.stdin); print(d['a'])")).toBe(true);
    expect(ok("import json, re\nfor m in json.load(open('" + OWN + "', 'r')):\n    print(re.sub(r'\\s+', ' ', m['t']))")).toBe(true);
    expect(ok("from collections import Counter\nimport sys, json\nprint(Counter(json.load(sys.stdin)).most_common(5))")).toBe(true);
  });
  it.each([
    ["imports os", "import os; os.system('rm -rf ~')"],
    ["imports subprocess", "import subprocess; subprocess.run(['ls'])"],
    ["imports with an alias", "import json as j; j.codecs.open('/x','w')"],
    ["reaches a module through an allowed one", "import json; json.codecs.open('/x', 'w').write('x')"],
    ["aliases a module by assignment", "import json; j = json; j.codecs"],
    ["passes a module around", "import sys; print(sys)"],
    ["reads sys.modules", "import sys; sys.modules['os'].system('x')"],
    ["uses a dunder", "print(().__class__.__base__.__subclasses__())"],
    ["builds a dunder inside a string", "print('{0.__class__}'.format(1))"],
    ["calls __import__", "__import__('os').system('x')"],
    ["walks a generator frame to builtins", "g=(i for i in [1]); g.gi_frame.f_builtins['op'+'en']('/x','w')"],
    ["calls eval", "eval('1+1')"],
    ["calls exec", "exec('import os')"],
    ["calls getattr", "getattr(1, 'real')"],
    ["reads globals", "globals()['x']"],
    ["opens a file for writing", `open('${OWN}', 'w').write('x')`],
    ["opens a file for appending by keyword", `open('${OWN}', mode='a')`],
    ["opens another file", "print(open('/etc/passwd').read())"],
    ["opens a computed path", "p='/etc/'+'passwd'; print(open(p).read())"],
    ["opens an argument that is not the own file", "import sys; open(sys.argv[1]).read()"],
    ["hides open in an f-string", `print(f"{open('/etc/passwd').read()}")`],
    ["hides eval in an f-string", "print(f\"{eval('1')}\")"],
    ["hides eval in a raw f-string", "print(fr\"{eval('1')}\")"],
    ["hides eval in a raw f-string spelled rf", "print(Rf'{eval(1)}')"],
    ["uses a full-width identifier", "ｅｖａｌ('1')"],
    ["splits a name with a backslash continuation", "import json\nx = json\\\n.codecs"],
    ["uses input", "input()"],
    ["uses pathlib", "from pathlib import Path; Path('/x').write_text('y')"],
    ["imports from os", "from os import system"],
  ])("refuses a script that %s", (_why, script) => {
    expect(ok(script, ["/etc/passwd"])).toBe(false);
  });
});
