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
import { classifyStopLine, deletesPlacedInside, stopLineKey, stopLineKeyCovers, type StopLinePlace } from "./stop-line.ts";

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

// 0.1.60 Mac pass: the Ask card for a routine run's own command said "Delete
// something Murage cannot place, so it may be outside its folder" when the
// only delete was of a file the command had just made in the bot's own
// thread folder. The card reads the same inside-roots rule as Auto's guard.
describe("the card's wording for a delete inside the bot's own folder", () => {
  const thread = "/Users/ada/.murage/workspaces/dax/threads/t1";
  const own: StopLinePlace = { cwd: thread, roots: [thread, "/Users/ada/.murage/workspaces/dax", "/tmp"], home: HOME, knownRecipients: new Set() };
  const command = [
    `cd "${thread}" && \\`,
    "mkdir -p notes && \\",
    `NOW="$(date '+%Y-%m-%d %H:%M:%S %Z')" && \\`,
    "cat >> notes/log.md <<EOF",
    "$NOW",
    "EOF",
    "python3 - <<'PYEOF'",
    'with open("notes/pipeline.md", "a") as f:',
    '    f.write("cleanup step: use rm to send old files to trash\\n")',
    "PYEOF",
    "touch notes/tmp-delete-me.txt && \\",
    "rm notes/tmp-delete-me.txt && \\",
    'echo "=== log.md ===" && cat notes/log.md',
  ].join("\n");

  // The reader did not take a backslash at the end of a line as the line
  // going on, so `rm` after `&& \` was never read as a command, and a line
  // with a here-doc and an unread `rm` was "a delete it cannot place".
  it("reads a line that goes on after a backslash, so the delete is placed inside", () => {
    expect(classifyStopLine("Bash", { command }, command, own)).toBeNull();
    const continued = "touch notes/a.txt && \\\nrm notes/a.txt && \\\necho done";
    expect(classifyStopLine("Bash", { command: continued }, continued, own)).toBeNull();
    expect(deletesPlacedInside(continued, own)).toBe(true);
  });

  it("still stops a continued delete outside the folder", () => {
    const outside = "cat >> notes/log.md <<EOF\nx\nEOF\ntouch notes/a.txt && \\\nrm ~/Documents/b.txt";
    expect(classifyStopLine("Bash", { command: outside }, outside, own)?.what).toBe("Delete 1 item outside its folder: ~/Documents/b.txt");
    expect(deletesPlacedInside(outside, own)).toBe(false);
  });
});

// 0.1.60 Linux pass D2: a routine that deletes its own temp file through a
// variable (`tmp="tempfile_$(date +%s).txt" ... rm "$tmp"`) was flagged
// "Delete 1 item outside its folder: $tmp", and that card offered only Allow
// once, so it could never be always allowed.
describe("a delete through a variable set earlier in the same command", () => {
  const thread = "/home/tester/.murage/workspaces/dax/threads/t1";
  const own: StopLinePlace = { cwd: thread, roots: [thread, "/tmp"], home: "/home/tester", knownRecipients: new Set() };
  const hit = (command: string) => classifyStopLine("Bash", { command }, command, own);

  it("is placed when the variable is a dated name in the bot's folder, or a mktemp file", () => {
    for (const command of [
      'tmp="tempfile_$(date +%s).txt" && date > "$tmp" && cat "$tmp" >> notes/log.md && rm "$tmp"',
      'tmp=$(mktemp) && echo x > "$tmp" && rm -f "$tmp"',
      'tmp="$(mktemp notes/run.XXXXXX)"; echo x > "$tmp"; rm "$tmp"',
      'tmp="$(mktemp -p /tmp run.XXXXXX)"; rm "$tmp"',
      'tmp="notes/scratch.txt"; rm "$tmp"',
    ]) {
      expect(hit(command), command).toBeNull();
      expect(deletesPlacedInside(command, own), command).toBe(true);
    }
  });

  it("still stops one that lands outside the folder", () => {
    expect(hit('tmp="$(mktemp -p /home/tester/Documents run.XXXXXX)"; rm "$tmp"')?.what).toBe("Delete 1 item outside its folder: ~/Documents/run.XXXXXX");
    expect(hit('tmp="/home/tester/Documents/old.txt"; rm "$tmp"')?.what).toBe("Delete 1 item outside its folder: ~/Documents/old.txt");
  });

  it("asks when it cannot be placed, and that card can be allowed for the task or the routine", () => {
    const command = 'tmp="$(cat list.txt)"; rm "$tmp"';
    const stop = hit(command)!;
    expect(stop.what).toMatch(/^Delete something Murage cannot place, so it may be outside its folder: /);
    const key = stopLineKey(stop)!;
    expect(key).toMatch(/^stop:delete:unplaced:/);
    expect(stopLineKeyCovers(key, stop)).toBe(true);
    // the same command on a later run, with only a date changed, is the same shape
    const dated = (day: string) => `tmp="$(grep ${day} list.txt)"; rm "$tmp"`;
    expect(stopLineKeyCovers(stopLineKey(hit(dated("2026-09-25"))!)!, hit(dated("2026-09-26"))!)).toBe(true);
    // another command is not
    expect(stopLineKeyCovers(key, hit('tmp="$(cat other.txt)"; rm "$tmp"')!)).toBe(false);
    // and the routine's own grant covers it in the routine's runs
    expect(autoVerdict({ autoApprove: false }, "Bash", command, { automated: true, routineLevel: true, stopLine: stop, routineAllow: [key] }))
      .toMatchObject({ source: "routine-allow", rule: key });
  });
});
