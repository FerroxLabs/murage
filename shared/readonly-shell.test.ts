// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseReadOnlyCommand, safeJqFilter, safePythonScript } from "./readonly-shell.ts";

const OWN = "/home/u/.fuigo/sessions/%2Fw/01a137d0-9dbd-76f3-8a1b-5ed20b9cd525/mcp/call_00_Ugx02hBzWG21yy4QOx9K5297.json";
const OTHER = "/home/u/.fuigo/sessions/%2Fw/01a13868-5580-7880-afb5-478f03cd8cca/mcp/call_00_other.json";

describe("parseReadOnlyCommand: the reads an engine tells its model to run", () => {
  it.each([
    // Fuigo/Grok: "use the shell to query the saved file (e.g. jq or python3)"; filmed on 1.0.1
    [`cat ${OWN} | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['messages'][0]['subject'])"`],
    [`cat '${OWN}' | python3 -c 'import json, sys\nd = json.load(sys.stdin)\nfor m in d["items"][:5]:\n    print(m.get("id"), m.get("title"))'`],
    [`cat ${OWN} | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['data'], indent=2))" | head -50`],
    [`cat ${OWN} | python3 -I -c "import sys; print(sys.stdin.read()[:2000])"`],
    [`cat ${OWN} 2>&1 | python3 -c "import json,sys,collections; c=collections.Counter(x['k'] for x in json.load(sys.stdin)); print(c.most_common(3))"`],
    [`jq -r '.data.items[] | .name' ${OWN}`],
    [`jq --arg k name '.[$k]' "${OWN}" 2>/dev/null | head -n 40`],
    // a routine on 1.0.1: the cut use_tool result read back, then cut again
    [`jq -r '.content[0].text' ${OWN} | head -300`],
    [`head -c 4000 ${OWN}`],
    [`tail -n +20 ${OWN} | head -20`],
    [`grep -o '"subject":"[^"]*"' ${OWN} | head -50`],
    [`grep -c subject ${OWN}`],
    [`wc -c ${OWN}`],
  ])("reads only the named file: %s", (command) => {
    const parsed = parseReadOnlyCommand(command);
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
    // Astra r3 (High): the script validated open(sys.argv[1]) against the
    // shell word, then reassigned sys.argv. Python now reads stdin only.
    ["reassigns sys.argv before opening it (Astra r3)", `python3 -c "import sys; sys.argv[1]='/other-bot/MEMORY.md'; print(open(sys.argv[1]).read())" ${OWN}`],
    ["reassigns sys.argv to another session's result", `python3 -c "import sys; sys.argv[1]='${OTHER}'; print(open(sys.argv[1]).read())" ${OWN}`],
    ["gives python the own file as an argument", `python3 -c "import json,sys; print(json.load(open(sys.argv[1])))" ${OWN}`],
    ["gives python the own file as an argument it never names", `cat ${OWN} | python3 -c "import json,sys; print(json.load(sys.stdin))" ${OWN}`],
    ["gives python a file after the script", `cat ${OWN} | python3 -c "import sys; print(sys.stdin.read())" /etc/passwd`],
    ["opens the own file by literal", `python3 -c "import json; d=json.load(open('${OWN}')); print(len(d))"`],
    ["opens the own file by literal with an encoding", `python3 -c "import json; d=json.load(open('${OWN}', encoding='utf-8')); print(len(d))"`],
    ["opens another session's result by literal", `cat ${OWN} | python3 -c "print(open('${OTHER}').read())"`],
    ["opens another file behind a stdin read", `cat ${OWN} | python3 -c "import sys; sys.stdin.read(); print(open('/other-bot/MEMORY.md').read())"`],
    ["reads sys.argv[0]", `cat ${OWN} | python3 -c "import sys; print(open(sys.argv[0]).read())"`],
    ["runs code from a string", `cat ${OWN} | python3 -c "exec('print(open(\\"/other-bot/MEMORY.md\\").read())')"`],
    ["reaches a name through getattr", `cat ${OWN} | python3 -c "import sys; print(getattr(sys, 'arg'+'v'))"`],
    ["imports through __import__", `cat ${OWN} | python3 -c "print(__import__('os').environ)"`],
    ["reads the environment", `cat ${OWN} | python3 -c "import os; print(os.environ)"`],
    ["opens through io", `cat ${OWN} | python3 -c "import io; print(io.open('${OTHER}').read())"`],
    ["opens through pathlib", `cat ${OWN} | python3 -c "from pathlib import Path; print(Path('${OTHER}').read_text())"`],
    ["opens through builtins", `cat ${OWN} | python3 -c "import builtins; print(builtins.open('${OTHER}').read())"`],
    ["puts python first in the pipeline", `python3 -c "import sys; print(sys.stdin.read())" | head -5`],
    // Astra r2 (three Highs on 0772fe384): the denylist scanner missed a
    // constructor, a CR line end and jq string interpolation. Allow-list now.
    ["builds a FileIO through type() on stdin's raw buffer (Astra r2 #1)", `cat ${OWN} | python3 -c "import sys; print(type(sys.stdin.buffer.raw)('/other-bot/MEMORY.md').read())"`],
    ["writes a file through the same constructor (Astra r2 #1)", `cat ${OWN} | python3 -c "import sys; type(sys.stdin.buffer.raw)('/other-bot/MEMORY.md', 'w').write(b'x')"`],
    ["hides code after a comment with a carriage return (Astra r2 #2)", `cat ${OWN} | python3 -c "#\rimport os; os.system('id')"`],
    ["has a carriage return anywhere at all", `cat ${OWN}\r`],
    ["has a carriage return inside single quotes", `jq '.a\r' ${OWN}`],
    ["interpolates the environment into a jq string (Astra r2 #3)", `jq -nr '"\\(env)"' ${OWN}`],
    ["interpolates the environment without -n", `jq -r '"\\(env)"' ${OWN}`],
    ["interpolates anything at all in a jq string", `jq -r '"\\(.a)"' ${OWN}`],
    ["hides interpolation behind a unicode escape", `jq -r '"\\u0041\\(env)"' ${OWN}`],
    ["reads nothing with jq -n", `jq -n '1' ${OWN}`],
    ["slurps with jq -s", `jq -s '.' ${OWN}`],
    ["names the environment as a jq arg", `jq --arg ENV x '$ENV.PATH' ${OWN}`],
    ["uses an undeclared jq variable", `jq '$x' ${OWN}`],
    ["reads $__loc__ in jq", `jq '$__loc__' ${OWN}`],
    ["uses jq input", `jq 'input' ${OWN}`],
    ["uses jq inputs", `jq '[inputs]' ${OWN}`],
    ["uses jq debug", `jq 'debug' ${OWN}`],
    ["uses jq stderr", `jq 'stderr' ${OWN}`],
    ["uses jq input_filename", `jq 'input_filename' ${OWN}`],
    ["includes a jq module", `jq 'include "x"; .' ${OWN}`],
    ["uses jq getpath", `jq 'getpath(["a"])' ${OWN}`],
    ["uses the @sh format", `jq -r '.a | @sh' ${OWN}`],
    ["defines a jq function", `jq 'def f: .; f' ${OWN}`],
    ["reduces in jq", `jq 'reduce .[] as $x (0; . + $x)' ${OWN}`],
    ["reads the clock in jq", `jq 'now' ${OWN}`],
    ["halts with an error in jq", `jq 'halt_error' ${OWN}`],
    ["labels in jq", `jq 'label $out | .' ${OWN}`],
    ["passes --argjson to jq", `jq --argjson x 1 '.' ${OWN}`],
    ["passes --indent to jq", `jq --indent 2 '.' ${OWN}`],
    ["has a jq comment", `jq '. # x' ${OWN}`],
  ])("refuses a command that %s", (_why, command) => {
    expect(parseReadOnlyCommand(command)).toBeUndefined();
  });

  it("returns every path so the caller can check each one", () => {
    expect(parseReadOnlyCommand(`cat ${OWN} /etc/passwd`)?.paths).toEqual([OWN, "/etc/passwd"]);
    expect(parseReadOnlyCommand(`grep -e x ${OWN} /etc/hosts`)?.paths).toEqual([OWN, "/etc/hosts"]);
    expect(parseReadOnlyCommand(`cat ${OWN} | python3 -c "import sys; print(sys.stdin.read())" | grep -c x ${OTHER}`)?.paths).toEqual([OWN, OTHER]);
  });
});

describe("safePythonScript: reads stdin, prints, nothing else", () => {
  const ok = (script: string) => safePythonScript(script);
  it("accepts ordinary querying of the pipe", () => {
    expect(ok("import json,sys; d=json.load(sys.stdin); print(d['a'])")).toBe(true);
    expect(ok("import json, re, sys\nfor m in json.load(sys.stdin):\n    print(re.sub(r'\\s+', ' ', m['t']))")).toBe(true);
    expect(ok("from collections import Counter\nimport sys, json\nprint(Counter(json.load(sys.stdin)).most_common(5))")).toBe(true);
    expect(ok("import json, sys; json.dump(json.load(sys.stdin)['data'], sys.stdout, indent=2)")).toBe(true);
    expect(ok("import sys; print(f'{len(sys.stdin.read())} bytes')")).toBe(true);
    expect(ok("import json, sys\nd = json.load(sys.stdin)\nfor m in d[\"items\"][:5]:\n    print(m.get(\"id\"), m.get(\"title\"))")).toBe(true);
    expect(ok("import json,sys,collections; c=collections.Counter(x['k'] for x in json.load(sys.stdin)); print(c.most_common(3))")).toBe(true);
    expect(ok("import json, sys\nd = json.load(sys.stdin)\nrows = sorted(d['items'], key=lambda x: x.get('n', 0), reverse=True)\nfor i, r in enumerate(rows[:10]):\n    print(i, r['n'], r['subject'][:80])")).toBe(true);
    expect(ok("import json, sys\ntry:\n    d = json.load(sys.stdin)\nexcept Exception as e:\n    print('bad json', e)\nelse:\n    print({k: len(v) for k, v in d.items() if isinstance(v, list)})")).toBe(true);
    expect(ok("import json, sys\nd = json.load(sys.stdin)\nprint(f\"{d['count']:>6} items, first {d['items'][0]['id']!r}\")")).toBe(true);
    expect(ok("import json, sys; print('{} of {}'.format(len(json.load(sys.stdin)), 10))")).toBe(true);
    expect(ok("import json, sys\nd = json.load(sys.stdin)\ndef names(x):\n    return [i['name'] for i in x if 'name' in i]\nprint(', '.join(names(d['data'])))")).toBe(true);
    expect(ok("import re, sys\nfor line in sys.stdin.readlines():\n    m = re.search(r'\"subject\":\\s*\"([^\"]*)\"', line)\n    if m:\n        print(m.group(1))")).toBe(true);
    expect(ok("import json, sys\na, b = json.load(sys.stdin)['pair']\nprint(a, b, end='\\n', sep=' | ')")).toBe(true);
    // binding order is not tracked: a name bound anywhere is a local, and an
    // unbound local is a NameError, which reaches nothing
    expect(ok("print(x); x = 1")).toBe(true);
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
    ["opens a file at all, even the own one read-only", `import json; print(json.load(open('${OWN}')))`],
    ["opens a file for writing", `open('${OWN}', 'w').write('x')`],
    ["opens a file for appending by keyword", `open('${OWN}', mode='a')`],
    ["opens another file", "print(open('/etc/passwd').read())"],
    ["opens a computed path", "p='/etc/'+'passwd'; print(open(p).read())"],
    ["reads sys.argv", "import sys; print(sys.argv[1])"],
    ["reassigns sys.argv and opens it (Astra r3)", "import sys; sys.argv[1]='/other-bot/MEMORY.md'; print(open(sys.argv[1]).read())"],
    ["names open without calling it", "import json, sys; f = open; print(json.load(f(sys.stdin.read().strip())))"],
    ["hides open in an f-string", `print(f"{open('/etc/passwd').read()}")`],
    ["hides eval in an f-string", "print(f\"{eval('1')}\")"],
    ["hides eval in a raw f-string", "print(fr\"{eval('1')}\")"],
    ["hides eval in a raw f-string spelled rf", "print(Rf'{eval(1)}')"],
    ["uses a full-width identifier", "ｅｖａｌ('1')"],
    ["splits a name with a backslash continuation", "import json\nx = json\\\n.codecs"],
    ["uses input", "input()"],
    ["uses pathlib", "from pathlib import Path; Path('/x').write_text('y')"],
    ["imports from os", "from os import system"],
    ["imports io", "import io; io.open('/x')"],
    ["imports builtins", "import builtins; builtins.open('/x')"],
    ["imports csv (not on the module list)", "import sys, csv\nfor row in csv.reader(sys.stdin):\n    print(row[0])"],
    // Astra r2 #1: a constructor reached through type() and the raw buffer
    ["builds a FileIO through type() (Astra r2)", "import sys; print(type(sys.stdin.buffer.raw)('/other-bot/MEMORY.md').read())"],
    ["reads stdin's raw buffer at all", "import sys; print(sys.stdin.buffer.raw)"],
    ["reads stdin's buffer", "import sys; print(sys.stdin.buffer.read())"],
    ["calls type on anything", "print(type(1))"],
    ["reads a file descriptor", "import sys; print(sys.stdin.fileno())"],
    ["writes to stdout by method", "import sys; sys.stdout.write('x')"],
    // Astra r2 #2: a CR is a line end for Python
    ["hides code behind a carriage return in a comment (Astra r2)", "#\rimport os; os.system('id')"],
    ["has a carriage return in a string", "print('a\rb')"],
    ["has a tab", "import sys\n\tprint(sys.stdin.read())"],
    ["has a form feed", "import sys\fprint(sys.stdin.read())"],
    // the allow-list: names, attributes, bindings
    ["rebinds the file opener to itself", "open = open; print(open('/etc/passwd').read())"],
    ["aliases the file opener", "x = open; print(x('/etc/passwd').read())"],
    ["binds a builtin name as a lambda default", "f = lambda x=open: x; print(f()('/x').read())"],
    ["binds a builtin name as a def default", "def f(a=open): return a\nprint(f()('/x').read())"],
    ["binds a builtin name as a loop target", "for open in [1]: pass"],
    ["binds a builtin name as a walrus", "print((vars:=1))"],
    ["binds a builtin name through except", "try:\n    pass\nexcept Exception as open:\n    pass"],
    ["uses an unbound name", "print(secret)"],
    ["assigns to a module attribute", "import sys; sys.stdin = 1"],
    ["assigns to a builtin", "print = 1"],
    ["assigns to a keyword", "None = 1"],
    ["binds a module name", "json = 1"],
    ["binds a module name in a for", "import sys\nfor sys in [1]: pass"],
    ["calls dir", "import sys; print(dir(sys))"],
    ["calls vars", "print(vars())"],
    ["calls hasattr", "import sys; print(hasattr(sys, 'argv'))"],
    ["reaches object", "print(object)"],
    ["reaches super", "print(super)"],
    ["uses an attribute off the list", "import sys; print(sys.stdin.encoding)"],
    ["uses an underscore attribute", "import sys; print(sys.stdin._checkClosed)"],
    ["reads sys.exit", "import sys; sys.exit(1)"],
    ["reads sys.maxsize", "import sys; print(sys.maxsize)"],
    ["reads re.error", "import re; print(re.error)"],
    ["reads json.JSONDecodeError", "import json; print(json.JSONDecodeError)"],
    ["imports collections.defaultdict", "from collections import defaultdict"],
    ["imports with parentheses", "from json import (load, loads)"],
    ["imports relatively", "from . import x"],
    ["imports inside an if", "import sys\nif 1: import os"],
    ["imports inside an expression", "print(__import__)"],
    ["defines a class", "class X(dict): pass"],
    ["uses with", "with open('/x') as f: print(f.read())"],
    ["uses del", "x = 1; del x"],
    ["uses while", "while 1: pass"],
    ["uses global", "global x"],
    ["uses yield", "def f():\n    yield 1"],
    ["uses a decorator", "@print\ndef f(): pass"],
    ["uses an annotation", "x: int = 1; print(x)"],
    // strings that could evaluate
    ["formats an attribute", "print('{0.real}'.format(1))"],
    ["formats an index", "print('{0[x]}'.format({'x': 1}))"],
    ["formats a nested field", "print('{:{w}}'.format(1, w=5))"],
    ["formats through a variable holding the template", "t = '{0.real}'; print(t.format(1))"],
    ["uses format_map", "print('{x}'.format_map({'x': 1}))"],
    ["hides type in an f-string", "print(f'{type(1)}')"],
    ["hides a walrus bind of a builtin in an f-string", "print(f'{(open:=1)}')"],
    ["hides a name in an f-string format spec", "import sys; print(f'{1:{open}}')"],
    ["hides a name in a nested f-string", "print(f'{f\"{open}\"}')"],
    ["reuses the quote inside an f-string brace (3.12)", "print(f\"{open(\"/x\").read()}\")"],
    ["has a backslash inside an f-string brace", "print(f'{\"\\\\\"}')"],
    ["has a comment inside an f-string brace", "print(f'{1 # }')"],
    ["has an empty f-string expression", "print(f'{}')"],
    ["uses an unknown string prefix", "print(x'abc')"],
    ["uses a dunder inside a string", "print('__class__')"],
    ["leaves a string unclosed", "print('abc"],
    ["leaves a bracket unclosed", "print((1)"],
    ["leaves a bracket unopened", "print(1))"],
    // number boundaries and odd syntax
    ["glues a keyword to a number", "print(1if open else 2)"],
    ["reads an attribute off a number", "print(1.real)"],
    ["reads an attribute off a float", "print(1.5.real)"],
    ["uses a non-ASCII character in a string", "print('é')"],
    ["uses a dollar sign", "print($x)"],
    ["uses a question mark", "print(1?2)"],
    ["uses a backtick", "print(`x`)"],
    ["uses a lone exclamation mark", "print(!x)"],
    ["is longer than 8000 characters", "x = 1\n".repeat(1500)],
    // frames, generators, exceptions
    ["reaches a lambda's globals", "print((lambda: 0).gi_frame)"],
    ["reaches an exception's traceback", "try:\n    1/0\nexcept Exception as e:\n    print(e.with_traceback)"],
    ["reaches exception args", "try:\n    1/0\nexcept Exception as e:\n    print(e.args)"],
    ["reads a method's self", "print([].append.im_self)"],
    ["reads a pattern's flags", "import re; print(re.compile('x').flags)"],
    ["uses a module as a value", "import json; f = lambda: json; print(f())"],
    ["uses a module as a call argument", "import json, sys; print(len(json))"],
    ["uses a module in a comparison", "import json; print(json == 1)"],
  ])("refuses a script that %s", (_why, script) => {
    expect(ok(script)).toBe(false);
  });
});

describe("safeJqFilter: listed words, declared variables, plain strings", () => {
  const ok = (filter: string, args: string[] = []) => safeJqFilter(filter, new Set(args));
  it("accepts the filters an engine writes", () => {
    expect(ok(".data.items[] | .name")).toBe(true);
    expect(ok(".content[0].text")).toBe(true);
    expect(ok(".[$k]", ["k"])).toBe(true);
    expect(ok('.items | map(select(.unread == true)) | length')).toBe(true);
    expect(ok('.items[:5] | map({id: .id, subject: .subject})')).toBe(true);
    expect(ok('to_entries | map(.key) | join(", ")')).toBe(true);
    expect(ok('.items[] | select(.subject | test("invoice"; "i")) | .id')).toBe(true);
    expect(ok('.a // "none"')).toBe(true);
    expect(ok('if .ok then .data else "failed" end')).toBe(true);
    expect(ok('.items | sort_by(.date) | reverse | first | {id: .id, date: .date}')).toBe(true);
    expect(ok('.items[] | [.id, .name] | @csv')).toBe(true);
    expect(ok('.text | ascii_downcase | split("\\n") | .[0:3]')).toBe(true);
    expect(ok('.a as $x | .b | map(. + $x)')).toBe(true);
    expect(ok('. as [$a, $b] | $a + $b')).toBe(true);
    expect(ok('. as {a: $a} | $a')).toBe(true);
    expect(ok('.. | numbers')).toBe(true);
    expect(ok('.a? // empty')).toBe(true);
    expect(ok('"\\u00e9 \\" \\\\ \\n"')).toBe(true);
  });
  it.each<[string, string, string[]?]>([
    ["reads env", "env"],
    ["reads env through a pipe", ". | env"],
    ["reads $ENV", "$ENV.HOME"],
    ["interpolates env (Astra r2)", '"\\(env)"'],
    ["interpolates anything", '"\\(1)"'],
    ["uses an unknown escape", '"\\x"'],
    ["uses a bad unicode escape", '"\\u12"'],
    ["uses input", "input"],
    ["uses inputs", "[inputs]"],
    ["uses debug", "debug"],
    ["uses stderr", "stderr"],
    ["uses input_filename", "input_filename"],
    ["uses input_line_number", "input_line_number"],
    ["reads $__loc__", "$__loc__"],
    ["reads $__prog__", "$__prog__"],
    ["imports", 'import "x" as y; .'],
    ["includes", 'include "x"; .'],
    ["uses getpath", 'getpath(["a"])'],
    ["uses setpath", 'setpath(["a"]; 1)'],
    ["uses @sh", "@sh"],
    ["uses an unknown format", "@zip"],
    ["uses an undeclared variable", "$x"],
    ["uses a variable declared only by an unlisted construct", "reduce .[] as $x (0; $x)"],
    ["uses ENV as a declared arg", "$ENV", ["ENV"]],
    ["defines a function", "def f: .; f"],
    ["uses foreach", "foreach .[] as $x (0; $x)"],
    ["uses label", "label $out | ."],
    ["uses now", "now"],
    ["uses halt_error", "halt_error"],
    ["uses error", 'error("x")'],
    ["uses until", "until(. > 3; . + 1)"],
    ["uses an unknown word", "frobnicate"],
    ["uses a bare key outside braces", "id: 1"],
    ["has a comment", ". # x"],
    ["has a tab", ".\t| ."],
    ["has a carriage return", ".\r| ."],
    ["has a non-ASCII character", '"é"'],
    ["has a dunder", "$__x"],
    ["uses a backtick", "`x`"],
    ["is empty of a closing quote", '"abc'],
  ])("refuses a filter that %s", (_why, filter, args: string[] = []) => {
    expect(ok(filter, args)).toBe(false);
  });
});
