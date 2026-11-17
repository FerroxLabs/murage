// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLONED-CWD r9 section 6 gate (R53-W): the reported l9ss-hello2 / LEGS10 hello.sh workflow on the real disk and the real
// server seams. A bot whose marked turn runs `cd "<cwd>" && echo hello > hello.sh` does not card a pre-existing sibling
// bot's next turn, and its own next turn is still marked (r9 P7). The cwd is the OS's native path, so on Windows the cd
// word is a double-quoted backslash drive path (r9 P4).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registryKey } from "./download-registry.ts";
import { beginOutsideTurn, downloadRegistry, forgetOutsideState, markTurnOutside, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { cwdOutsideMark, noteToolStartOutside } from "./outside-wire.ts";

afterEach(() => forgetOutsideState());

/** Two pre-existing bot folders side by side, as the bots folder holds them, and a wired store. */
function bots() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "r9-workflow-")));
  const own = join(root, "bot-own");
  const sibling = join(root, "bot-sibling");
  mkdirSync(own); mkdirSync(sibling);
  expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "r9-workflow-store-")), "outside-state.jsonl")))).toBe(true);
  return { own, sibling };
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
    ownMarkedTurn(own, `cd "${own}" && echo hello > hello.sh`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).toBeNull();
    beginOutsideTurn("own-bot", "keys", undefined, false);
    expect(cwdOutsideMark(own)).not.toBeNull();
    // P7: the cwd window is on the registry, and the hello.sh the command wrote Matches it
    const paths = downloadRegistry().list().map((e) => e.path);
    expect(paths).toContain(registryKey(own));
    writeFileSync(join(own, "hello.sh"), "hello\n");
    expect(cwdOutsideMark(join(own, "hello.sh"))).not.toBeNull();
  });
  it("r9 workflow A1: the same cd with an interpreter remainder keeps the sibling's card (fail closed)", () => {
    const { own, sibling } = bots();
    ownMarkedTurn(own, `cd "${own}" && bash hello.sh`);
    beginOutsideTurn("sibling-bot", "keys", undefined, false);
    expect(cwdOutsideMark(sibling)).not.toBeNull();
  });
});
