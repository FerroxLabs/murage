// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auto's destructive guard and the bot's own folders. `rm -f /tmp/dax/a.txt`
// in a routine run raised a card nobody was there to answer: a delete whose
// every target the stop line places inside the bot's own roots (its
// workspace and thread folders, the turn's folder, the temp folders) is not
// "destructive" for this guard. Everything else it guarded still is.
import { describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { deletesPlacedInside, type StopLinePlace } from "./stop-line.ts";

const HOME = "/Users/ada";
const CWD = "/Users/ada/Projects/site";
const place: StopLinePlace = {
  cwd: CWD,
  roots: [CWD, "/Users/ada/.murage/workspaces/dax", "/tmp"],
  home: HOME,
  knownRecipients: new Set(),
};

describe("deletesPlacedInside", () => {
  const inside = [
    "rm -f /tmp/dax/a.txt",
    "rm -rf build",
    "rm -rf ./dist node_modules/.cache",
    "rm -f /Users/ada/.murage/workspaces/dax/notes/old.md",
    "pkill -f x; rm -f /tmp/dax/a.txt",
    "rm -rf /tmp/dax/*",
    "cd /tmp/dax && rm -f a.txt",
  ];
  for (const command of inside) it(`inside: ${command}`, () => expect(deletesPlacedInside(command, place)).toBe(true));

  const not = [
    "rm -rf ~/Documents/x",
    "rm -f /tmp/a.txt ~/Documents/b",
    // a root itself is not inside it
    "rm -rf /tmp",
    "rm -rf .",
    "rm -rf /tmp/*",
    // a delete the reader cannot place, or cannot see as a delete
    "rm -rf $TARGET",
    "rm -rf $(cat list)",
    "ls | xargs rm -rf",
    "echo 'rm -rf /tmp/x'",
    "ssh host rm -rf /tmp/x",
    "bash -c 'rm -rf /tmp/x'",
    "find /tmp/x -delete",
    "git clean -fdx",
    // nothing is deleted at all
    "ls -la",
  ];
  for (const command of not) it(`not inside: ${command}`, () => expect(deletesPlacedInside(command, place)).toBe(false));

  it("never on a Windows home, which reads commands as PowerShell", () => {
    expect(deletesPlacedInside("rm -f C:/Temp/a.txt", { ...place, home: "C:\\Users\\ada", cwd: "C:\\Temp", roots: ["C:\\Temp"] })).toBe(false);
  });
});

describe("Auto's destructive guard with the delete placed inside", () => {
  const auto = { autoApprove: true, alwaysAllow: [] };
  const judge = (command: string) =>
    autoVerdict(auto, "Bash", command, { stopLine: null, deletesInside: deletesPlacedInside(command, place) });

  it("lets a delete inside the bot's own roots through", () => {
    expect(judge("rm -f /tmp/dax/a.txt")).toMatchObject({ source: "auto-mode" });
    expect(judge("rm -rf build")).toMatchObject({ source: "auto-mode" });
  });

  it("still guards a delete in the owner's own folders", () => {
    expect(autoVerdict(auto, "Bash", "rm -rf ~/Documents/x", { stopLine: { kind: "delete", place: "/Users/ada/Documents/x", what: "x" }, deletesInside: deletesPlacedInside("rm -rf ~/Documents/x", place) }).source).toBe("stop-line");
    expect(judge("rm -rf ~/Documents/x").source).toBe("destructive-guard");
  });

  it("still guards a mix of inside and outside", () => {
    expect(judge("rm -f /tmp/dax/a.txt ~/Documents/b").source).toBe("destructive-guard");
  });

  it("keeps stopping a command that also kills processes", () => {
    expect(judge("pkill -f x; rm -f /tmp/dax/a.txt")).toMatchObject({ approve: null, source: "destructive-guard" });
    expect(judge("kill -9 123 && rm -f /tmp/dax/a.txt").source).toBe("destructive-guard");
    expect(judge("killall node; rm -rf build").source).toBe("destructive-guard");
  });

  it("keeps every other destructive rule", () => {
    expect(judge("rm -rf build && git reset --hard").source).toBe("destructive-guard");
    expect(judge("sudo rm -f /tmp/dax/a.txt").source).toBe("destructive-guard");
  });

  it("needs the caller's placement: without it the old guard holds", () => {
    expect(autoVerdict(auto, "Bash", "rm -f /tmp/dax/a.txt", { stopLine: null }).source).toBe("destructive-guard");
  });

  it("the key guard still outranks it", () => {
    expect(judge("rm -f /tmp/dax/.env").source).toBe("sensitive-guard");
  });

  it("a webhook turn keeps its own rules", () => {
    expect(autoVerdict(auto, "Bash", "rm -f /tmp/dax/a.txt", { stopLine: null, unattended: true, deletesInside: true })).toMatchObject({ approve: null, source: "unattended-block" });
  });
});
