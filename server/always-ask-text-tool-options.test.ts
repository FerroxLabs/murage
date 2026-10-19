// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Option A+, the delimiter false alarm: a text tool's separator, field list
// or size (`cut -d/`, `sort -t/`, `column -s/`, `paste -d/`, `join -t/`,
// the sets `tr` maps) is not a file. A text tool's option value is read as a
// path only for the options that take one (`sort -o`, `sort -T`); its file
// operands and every redirect keep asking as before. awk is not one of these
// tools: its separator variables can be reused as a target in its program
// (`system("rm -rf " FS)`), so `awk -F/` asks, as before 7b1467c6f.
// Fixture strings are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

const ORDINARY: string[] = [
  // cut
  "cut -d/ -f2 list.txt",
  "cut -d / -f1-3 list.txt",
  "cut -d'/' -f2 list.txt",
  "cut -f2 -d/ list.txt",
  "cut -sd/ -f2 list.txt",
  "cut --delimiter=/ -f2 list.txt",
  "cut --delimiter / -f2 list.txt",
  "cut -d~ -f1 list.txt",
  "cut -d ~ -f1 list.txt",
  "cut -d/ -f2 --output-delimiter=/ list.txt",
  "git ls-files | cut -d/ -f1 | sort -u",
  // sort
  "sort -t/ -k2 list.txt",
  "sort -t / -k 2 list.txt",
  "sort -ut/ -k2 list.txt",
  "sort --field-separator=/ -k2 list.txt",
  "sort --field-separator / -k2 list.txt",
  // column, paste, join
  "column -s/ -t list.txt",
  "column -t -s / list.txt",
  "column -t -s/ -o / list.txt",
  "paste -d/ a.txt b.txt",
  "paste -sd/ a.txt",
  "paste --delimiters=/ a.txt b.txt",
  "join -t/ a.txt b.txt",
  "join -t / -1 2 a.txt b.txt",
  // tr reads no file: both sets are characters
  "tr / _ < list.txt",
  "tr '/' '\\n' < list.txt",
  "tr -d / < list.txt",
  "tr -s / < list.txt",
  "echo a/b | tr / ~",
  // jq's filter is code, not a path, even run from a home folder
  "jq . data.json",
  "curl -s https://example.com/x | jq .",
  "jq -r '.items[]' data.json",
  "jq --arg d x '.a' data.json",
];

const AWK_ASKS: string[] = [
  "awk -F/ '{print $NF}' list.txt",
  "awk -F / '{print $1}' list.txt",
  "awk -F'/' '{print $2}' list.txt",
  "awk -F=/ '{print $2}' list.txt",
  "awk --field-separator=/ '{print $2}' list.txt",
  "awk -v FS=/ '{print $1}' list.txt",
  "awk -vOFS=/ '{print $1, $2}' list.txt",
  "awk --assign OFS=/ '{print $1, $2}' list.txt",
  "awk -v RS=/ '{print}' list.txt",
  "gawk -F/ '{print $NF}' list.txt",
  "mawk -F~ '{print $1}' list.txt",
  "ls | awk -F/ '{print $1}'",
  "awk -F/ '{print $2}' file",
  "awk -F: -v OFS=/ '{print $1,$2}'",
];

const HELD: Array<[cmd: string, rule: string]> = [
  // options that take a path keep being read, glued or separate
  ["sort -o /etc list.txt", "protected-path"],
  ["sort -o/etc list.txt", "protected-path"],
  ["sort -t/ -o /usr list.txt", "protected-path"],
  ["sort -t/ -o/usr list.txt", "protected-path"],
  ["sort --output=/usr list.txt", "protected-path"],
  ["sort --output /usr list.txt", "protected-path"],
  ["sort -T / list.txt", "protected-path"],
  ["awk -f/usr list.txt", "protected-path"],
  ["awk -F/ -f /usr list.txt", "protected-path"],
  ["awk --file=/usr list.txt", "protected-path"],
  // a file operand is still a file
  ["cut -d/ -f1 /usr", "protected-path"],
  ["awk -F/ '{print $1}' /usr", "protected-path"],
  ["paste -d/ /etc b.txt", "protected-path"],
  ["sort -t/ -k2 ~", "protected-path"],
  // an option this table does not know is read as before
  ["cut --bogus=/usr list.txt", "protected-path"],
  // `--` ends the options: what follows is a file
  ["cut -d, -- /usr", "protected-path"],
  // jq: a file operand, or a filter file, is still read
  ["jq . /etc", "protected-path"],
  ["jq -f /usr .", "protected-path"],
  // awk code and assignments other than a separator are read as before
  ["awk -v d=/ 'BEGIN { system(\"rm -rf \" d) }'", "protected-path"],
  ["awk -vd=/usr '{print}' list.txt", "protected-path"],
  // a separator is exempt only beside a literal program that runs, writes and reads nothing
  ["awk -F/home/tester 'BEGIN { system(\"rm -rf \" FS) }'", "protected-path"],
  ["awk -v OFS=/home/tester 'BEGIN { system(\"rm -rf \" OFS) }'", "protected-path"],
  ["awk -v RS=/home/tester 'BEGIN { system(\"rm -rf \" RS) }'", "protected-path"],
  ["awk -F/usr '{ print | \"sh\" }' list.txt", "protected-path"],
  ["awk -v OFS=/usr '{ print > OFS }' list.txt", "protected-path"],
  ["awk -F/usr 'BEGIN { getline < FS }'", "protected-path"],
  ["awk -F/usr -e 'BEGIN { print }'", "protected-path"],
  ["awk -F/usr -f prog.awk list.txt", "protected-path"],
  ["awk -F/usr \"$PROG\" list.txt", "protected-path"],
  // any other option may take a value of its own: `-LF` is gawk's lint option with the value F
  ["gawk -F/home/tester -LF 'BEGIN { system(\"rm -rf \" FS); exit }' harmless", "protected-path"],
  ["gawk -v OFS=/home/tester -LF 'BEGIN { system(\"rm -rf \" OFS); exit }' harmless", "protected-path"],
  ["gawk -v RS=/home/tester -LF 'BEGIN { system(\"rm -rf \" RS); exit }' harmless", "protected-path"],
  ["awk -F/usr -b '{print}' list.txt", "protected-path"],
  ["awk -F/usr --lint=F 'BEGIN { print }'", "protected-path"],
  ["awk --field-sep=/usr 'BEGIN { print }'", "protected-path"],
];

describe("a text tool's separator is not a path", () => {
  it.each(ORDINARY)("%s is ordinary", (cmd) => {
    expect(alwaysAskCommand(cmd, "/work/project")).toBeNull();
    expect(alwaysAskCommand(cmd, "/home/tester")).toBeNull();
  });
  it.each(AWK_ASKS)("%s asks: awk's separator is read as a path", (cmd) => {
    expect(alwaysAskCommand(cmd, "/work/project")?.rule ?? null).toBe("protected-path");
  });
  it.each(HELD)("%s still asks (%s)", (cmd, rule) => {
    expect(alwaysAskCommand(cmd, "/work/project")?.rule ?? null).toBe(rule);
  });
  it("a redirect from tr still asks", () => {
    expect(alwaysAskCommand("tr / _ < list.txt > /dev/sda", "/work/project")?.rule).toBe("disk-erase");
  });
});
