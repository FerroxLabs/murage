// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLONED-CWD r9 section 6 gate (R53-W): the reported l9ss-hello2 / LEGS10 workflow on the real disk and the real server
// seams. A bot whose marked turn runs `cd "<cwd>" && <plain command>` does not card a pre-existing sibling bot's next turn,
// and its own next turn is still marked (r9 P7). The exact reported text runs `bash hello.sh`, an interpreter word, so by
// A1-4 it stays carded (the second test). The plain command writes hello.txt as the r9 matrix does: the A1 deny-list also
// reads the `sh` of a file name such as hello.sh (fail closed; QUESTIONS-FOR-MAIN R53-Q3). The cwd is the OS's native path, so on Windows the cd
// word is a double-quoted backslash drive path (r9 P4).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registryKey } from "./download-registry.ts";
import { beginOutsideTurn, downloadRegistry, forgetOutsideState, markTurnOutside, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { cwdOutsideMark, noteToolStartOutside } from "./outside-wire.ts";

afterEach(() => forgetOutsideState());

/** The span a marked turn's write opens starts 2 s before the turn (outside-wire.ts spanTurn) and Matches by ctime anywhere,
 *  so a folder made within it is rightly marked. The reported sibling existed long before the turn: the two bot folders are
 *  made once and are older than that slack when the first turn starts. */
const SPAN_SLACK_MS = 2000;
let aged: { own: string; sibling: string };
beforeAll(async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "r9-workflow-")));
  aged = { own: join(root, "bot-own"), sibling: join(root, "bot-sibling") };
  mkdirSync(aged.own); mkdirSync(aged.sibling);
  await new Promise((resolve) => setTimeout(resolve, SPAN_SLACK_MS + 500));
});
/** Two pre-existing bot folders side by side, as the bots folder holds them, and a wired store. */
function bots() {
  expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "r9-workflow-store-")), "outside-state.jsonl")))).toBe(true);
  return aged;
}
/** The own bot's marked turn runs `command` through the engine's Bash tool, in its own folder. */
function ownMarkedTurn(own: string, command: string) {
  beginOutsideTurn("own-bot", "keys", undefined, false);
  markTurnOutside("own-bot", "web page");
  noteToolStartOutside("own-bot", { origin: "engine", title: "Bash", input: { command } }, own);
}

describe("CLONED-CWD r9 gate: the reported sibling and own-next-turn workflow (real disk)", () => {
  it("r9 workflow: the sibling bot's next turn shows no card, and the own bot's next turn is still marked", () => {
    const { own, sibling } = bots();
    ownMarkedTurn(own, `cd "${own}" && echo hello > hello.txt`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).toBeNull();
    beginOutsideTurn("own-bot", "keys", undefined, false);
    expect(cwdOutsideMark(own)).not.toBeNull();
    // P7: the cwd window is on the registry, and the hello.txt the command wrote Matches it
    const paths = downloadRegistry().list().map((e) => e.path);
    expect(paths).toContain(registryKey(own));
    writeFileSync(join(own, "hello.txt"), "hello\n");
    expect(cwdOutsideMark(join(own, "hello.txt"))).not.toBeNull();
  });
  it("r9 workflow A1-4: the exact reported text, an interpreter remainder, keeps the sibling's card (fail closed)", () => {
    const { own, sibling } = bots();
    ownMarkedTurn(own, `cd "${own}" && printf '#!/bin/bash\\necho "NLW-HELLO"\\n' > hello.sh && bash hello.sh`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).not.toBeNull();
  });
  // R53-Q3 (MAIN RULING 2026-11-17T16:35Z, confirmed as built): a file name ending .sh/.node/.cmd reads as an A1 interpreter
  // word, so a plain write to it keeps the sibling's card (an over-mark, never relief); the same write to hello.txt keeps W1 relief.
  it.each(["hello.sh", "hello.node", "hello.cmd"])("R53-Q3 pin: `echo hello > %s` keeps the sibling's card (A1 over-mark kept)", (name) => {
    const { own, sibling } = bots();
    ownMarkedTurn(own, `cd "${own}" && echo hello > ${name}`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).not.toBeNull();
  });
  it("R53-Q3 pin: `echo hello > hello.txt` keeps the W1 relief (the sibling shows no card)", () => {
    const { own, sibling } = bots();
    ownMarkedTurn(own, `cd "${own}" && echo hello > hello.txt`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).toBeNull();
  });
});
