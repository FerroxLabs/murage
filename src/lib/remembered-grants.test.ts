// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { describeGrant, rememberedGrants } from "./remembered-grants";

const exactKey = 'exact:["engine-1","/Users/ada/project","npm test && npm run build"]';

describe("rememberedGrants", () => {
  it("lists every grant the bot and its tasks remember, once each", () => {
    const keys = rememberedGrants({ alwaysAllow: ["Bash:git", exactKey], tasks: [{ alwaysAllow: [exactKey, "shell:ls"] }, {}] });
    expect(keys).toEqual(["Bash:git", exactKey, "shell:ls"]);
  });
});

describe("describeGrant", () => {
  const engines = [{ instanceId: "engine-1", displayName: "Claude Code" }];

  it("shows an exact command with its folder and engine", () => {
    expect(describeGrant(exactKey, engines)).toEqual({ kind: "exact", command: "npm test && npm run build", folder: "/Users/ada/project", engine: "Claude Code" });
  });

  it("keeps the engine's id when it is no longer set up", () => {
    expect(describeGrant(exactKey, [])).toMatchObject({ kind: "exact", engine: "engine-1" });
  });

  it("says what the older grants cover in plain words", () => {
    expect(describeGrant("Bash:git", engines)).toEqual({ kind: "other", text: "Any git command" });
    expect(describeGrant("stop:delete:/Users/ada/old", engines)).toEqual({ kind: "other", text: "Deleting in /Users/ada/old" });
    expect(describeGrant("local-computer:Edit", engines)).toEqual({ kind: "other", text: "Edit on this computer" });
    expect(describeGrant("mcp__box__read", engines)).toEqual({ kind: "other", text: "mcp__box__read" });
  });
});

// 0.1.60 Linux pass D2: a delete Murage cannot place is remembered by the
// command itself, and is listed as that command in its folder.
it("describes an unplaced delete grant as its command", () => {
  const key = `stop:delete:unplaced:${JSON.stringify(["/home/tester/.murage/threads/t1", 'tmp="$(cat list.txt)"; rm "$tmp"'])}`;
  expect(describeGrant(key, [])).toEqual({ kind: "exact", command: 'tmp="$(cat list.txt)"; rm "$tmp"', folder: "/home/tester/.murage/threads/t1", engine: "any engine" });
});
