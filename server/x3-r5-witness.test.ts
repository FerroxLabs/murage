// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// X3 r5 sections 1-4: the witness judge. Rows run through the owner No-limits
// verdict with the finding as globExpansionRule. `judge` below stands in for
// Builder A's place loop (one budget per command, one call per word and
// place); rows that need A's real loop are in server/x3-r5-shapes.test.ts.
import { describe, expect, it } from "vitest";
import * as AA from "./auto-approve.ts";
import { autoVerdict, expandCredentialGlob, type CredentialGlobFs } from "./auto-approve.ts";

import { powershellGlobWords } from "../shared/sensitive-globs.ts";

// Base adapters: at 7724de8e there is no word reader, budget or outcome, so the
// rows run against the base's own glob words and result fields (red-before).
type Outcome = { kind: string; cards: boolean; rule: string | null; witness: string | null; code: string | null };
type Words = { token: string; reader: boolean; dotMatch: boolean }[];
const outcomeOf = (result: { outcome?: Outcome; witness: string | null; available: boolean; rule: string | null; reason?: string }): Outcome =>
  result.outcome ?? { kind: result.witness ? "witness" : result.available ? "listed" : "cannot", cards: Boolean(result.rule), rule: result.rule, witness: result.witness, code: result.reason ?? null };
const globWords = (text: string, options: { shell?: "pwsh"; dotglob?: boolean } = {}): Words => typeof AA.shellGlobWords === "function" ? AA.shellGlobWords(text, options)
  : (options.shell === "pwsh" ? powershellGlobWords(text) : AA.dequotedShellText(text)?.globWords ?? []).filter(word => /[*?[]/.test(word)).map(token => ({ token, reader: true, dotMatch: true }));
const newBudget = () => typeof AA.newGlobStepBudget === "function" ? AA.newGlobStepBudget() : { used: 0, limit: 65_536 };

const HOME = "/home/me";
const bot = { id: "x3r5", autoApprove: true, fullAccess: true, noLimits: false };
const errorWith = (code: string) => Object.assign(new Error(code), { code });

/** An in-memory tree: files, implied folders, EACCES folders, big folders and links. */
function tree(files: string[], options: { locked?: string[]; big?: Record<string, number>; links?: Record<string, string> } = {}): CredentialGlobFs & { opened: string[] } {
  const fileSet = new Set(files), dirs = new Set<string>(["/"]);
  const links = options.links ?? {};
  for (const path of [...files, ...Object.keys(links), ...(options.locked ?? []), ...Object.keys(options.big ?? {})]) {
    const parts = path.split("/");
    for (let k = 2; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/"));
  }
  for (const path of [...(options.locked ?? []), ...Object.keys(options.big ?? {})]) dirs.add(path);
  const bigNames = (path: string) => Array.from({ length: options.big?.[path] ?? 0 }, (_, n) => `f${n}.ts`);
  const parentOf = (path: string) => path.replace(/\/[^/]+$/, "") || "/";
  const isBigChild = (path: string) => options.big?.[parentOf(path)] !== undefined && bigNames(parentOf(path)).includes(path.slice(parentOf(path).length + 1));
  const exists = (path: string) => fileSet.has(path) || dirs.has(path) || isBigChild(path);
  const opened: string[] = [];
  const resolve = (path: string): string => {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      if (part === ".") continue;
      if (part === "..") { current = current.replace(/\/[^/]+$/, ""); continue; }
      current += "/" + part;
      let hops = 0;
      while (links[current] !== undefined) { current = resolve(links[current]!); if (++hops > 8) throw errorWith("ELOOP"); }
      if (!exists(current)) throw errorWith("ENOENT");
    }
    return current || "/";
  };
  return {
    opened,
    realpath: async path => resolve(path),
    opendir: async path => {
      opened.push(path);
      if (options.locked?.includes(path)) throw errorWith("EACCES");
      if (fileSet.has(path)) throw errorWith("ENOTDIR");
      if (!dirs.has(path)) throw errorWith("ENOENT");
      const prefix = path === "/" ? "/" : path + "/";
      const names = new Set<string>(bigNames(path));
      for (const one of [...fileSet, ...dirs, ...Object.keys(links)]) if (one.startsWith(prefix) && one.length > prefix.length && !one.slice(prefix.length).includes("/")) names.add(one.slice(prefix.length));
      const list = [...names];
      let index = 0;
      return {
        read: async () => {
          const name = list[index++];
          if (name === undefined) return null;
          const full = prefix + name;
          return { name, isDirectory: () => dirs.has(full) && links[full] === undefined, isSymbolicLink: () => links[full] !== undefined };
        },
        close: async () => {},
      };
    },
  };
}

const WORKSPACE = ["/w/README.md", "/w/src/a.ts", "/w/docs/x.md", "/w/server/drivers/murage-exec.ts", "/w/server/drivers/murage-exec/x.ts", "/w/.claude/skills/s.md", "/w/locked/k.ts"];
const HOME_FILES = ["/home/me/.ssh/id_rsa", "/home/me/.ssh/archive/README-key", "/home/me/.aws/credentials", "/home/me/.aws/config"];
const ARCHIVE_ONLY = ["/home/me/.ssh/archive/README-key", "/home/me/.aws/config"];
const fixture = (extra: string[] = [], home = HOME_FILES) => tree([...WORKSPACE, ...home, ...extra], { locked: ["/w/locked"], big: { "/w/big": 2001 } });

/** Stand-in for A's place loop: one budget per command, every word at every place. */
async function judge(command: string, places: string[], fs: CredentialGlobFs, options: { shell?: "pwsh" } = {}) {
  const budget = newBudget();
  const words = globWords(command, { shell: options.shell });
  const deadline = performance.now() + 5000;
  let rule: string | null = null;
  const outcomes: Outcome[] = [];
  for (const word of words) {
    const anchored = /^(?:\/|[a-z]:[\\/]|~[\\/])/i.test(word.token);
    for (const cwd of anchored ? [undefined] : places) {
      const result = await expandCredentialGlob(word.token, { cwd, home: HOME, fs, deadline, budget, reader: word.reader, dotMatch: word.dotMatch });
      outcomes.push(outcomeOf(result));
      if (outcomeOf(result).cards) rule ??= outcomeOf(result).rule;
    }
  }
  const verdict = autoVerdict(bot, "Bash", command, { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, commandCwd: places[0], shellCwdPrepared: true, globExpansionRule: rule });
  return { rule, verdict, outcomes, words, budget };
}
// The row helpers resolve to the judgement so a row can assert more; `any` lets a row hand the promise straight to `it`.
type Judged = Awaited<ReturnType<typeof judge>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RowResult = Promise<Judged & any>;
const quiet = async (command: string, places: string[], fs: CredentialGlobFs, options: { shell?: "pwsh" } = {}): RowResult => {
  const judged = await judge(command, places, fs, options);
  expect(judged.rule, JSON.stringify(judged.outcomes)).toBeNull();
  expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
  expect(judged.outcomes.some((outcome: Outcome) => outcome.kind === "budget")).toBe(false);
  return judged;
};
const card = async (command: string, places: string[], fs: CredentialGlobFs, options: { shell?: "pwsh" } = {}): RowResult => {
  const judged = await judge(command, places, fs, options);
  // The X3 finding is the discriminator: a row whose call another reader already holds still needs it.
  expect(judged.rule, JSON.stringify({ words: judged.words, outcomes: judged.outcomes })).toBeTruthy();
  expect(judged.verdict.approve).toBeNull();
  return judged;
};
/** Rows the always-ask reader holds before X3 (pre-existing at 7724de8e): assert the X3 layer adds nothing. */
const quietX3 = async (command: string, places: string[], fs: CredentialGlobFs): RowResult => {
  const judged = await judge(command, places, fs);
  expect(judged.rule, JSON.stringify(judged.outcomes)).toBeNull();
  return judged;
};

describe("X3 r5 QUIET", () => {
  it.each(["rtk *.md", "rtk *", "ls *", "grep x *.md", "for f in *.md; do wc -l $f; done"])("plain glob %s", command => quiet(command, ["/w"], fixture()));
  // `find *` and `rtk --include*.md foo` are held by the always-ask reader already at 7724de8e
  // (a glob that could expand to an option); X3 adds nothing to them.
  it.each(["find *", "rtk --include*.md foo"])("always-ask held, X3 adds nothing: %s", command => quietX3(command, ["/w"], fixture()));
  it.each(["grep --include=*.md -r x .", "grep --include=*.json -r x ."])("option word %s (credentials.json in /w)", command => quiet(command, ["/w"], fixture(["/w/credentials.json"])));
  it.each(["ls server/drivers/*", "cat server/drivers/*.ts"])("Murage's own sources %s", command => quiet(command, ["/w"], fixture()));
  it.each(["cat docs/old/*.md", "cat docs/old/*.json"])("ABSENT listing side %s (credentials.json in /w)", async command => {
    const judged = await quiet(command, ["/w"], fixture(["/w/credentials.json"]));
    expect(judged.outcomes.every((outcome: Outcome) => outcome.kind === "absent")).toBe(true);
  });
  it.each([`python3 -c "print(l['bars'])"`, `jq '.results[0]' f.json`])("brackets in programs %s", async command => {
    const judged = await quiet(command, ["/w"], fixture());
    expect(judged.words).toEqual([]);
  });
  it.each(["cat locked/*.ts", "cat big/*.ts"])("CANNOT under threshold %s", async command => {
    const judged = await quiet(command, ["/w"], fixture());
    expect(judged.outcomes.some((outcome: Outcome) => outcome.kind === "cannot")).toBe(true);
  });
  it("dot rule: cat * with .env in /w (bash)", () => quiet("cat *", ["/w"], fixture(["/w/.env"])));
  it("names-only directory: ls .ss?/* in {~}", () => quiet("ls .ss?/*", [HOME], fixture([], ARCHIVE_ONLY)));
  it.each(["ls .ss?/* | wc -l", "ls .ss?/* 2>err.log", "ls .ss?/* >&2", "ls .ss?/* | sort -r | head -n 3"])("[S1] bare listing %s in {~}", command => quiet(command, [HOME], fixture([], ARCHIVE_ONLY)));
  it("[S1] bare listing ls server/drivers/* | head -n 3", () => quiet("ls server/drivers/* | head -n 3", ["/w"], fixture()));
  it("A4 controls stay QUIET: README*, *.ts, /tmp/*", async () => {
    for (const command of ["cat README*", "cat *.ts", "cat /tmp/*"]) await quiet(command, ["/w"], fixture());
  });
});

describe("X3 r5 CARD", () => {
  it.each([
    "find .ss?/* -type f -print0 | xargs -0 cat",
    `ls .ss?/* | while read f; do cat "$f"; done`,
    "cat $(find .ss?/* -type f)",
    "find .ss?/* -type f -print0 | sort --files0-from=-",
    "ls .ss?/* | sort | xargs cat",
    "ls .ss?/* > names.txt",
    "ls .ss?/* 1>names.txt",
    "find .ss?/* -exec cat {} +",
    "bash -c 'ls .ss?/*' | xargs cat",
  ])("[S1] reader fed by an enumerator %s", command => card(command, [HOME], fixture([], ARCHIVE_ONLY)));
  it("[S2] Murage repo directory witness wc -l server/drivers/* (directory reason)", async () => {
    const judged = await card("wc -l server/drivers/*", ["/w"], fixture());
    expect(judged.outcomes.find((outcome: Outcome) => outcome.cards)?.witness).toBe("/w/server/drivers/murage-exec");
  });
  it("witness: cat * in {~/.ssh}", () => card("cat *", [HOME + "/.ssh"], fixture()));
  it("witness: cat ~/.ssh/*", () => card("cat ~/.ssh/*", ["/w"], fixture()));
  it("witness: cat id_* in {~/.ssh}", () => card("cat id_*", [HOME + "/.ssh"], fixture()));
  it.each([["cat as*e*r*", "/w/as.serviceaccount.json"], ["cat *s*e*r*", "/w/as.serviceaccount.json"], ["cat ?serv*", "/w/-serviceaccount.json"]])("witness: %s", async (command, file) => {
    const judged = await card(command, ["/w"], fixture([file]));
    expect(judged.outcomes.find((outcome: Outcome) => outcome.cards)).toMatchObject({ kind: "witness", witness: file });
  });
  it("witness: cat .en?.local with .env.local", () => card("cat .en?.local", ["/w"], fixture(["/w/.env.local"])));
  it("witness: cat .* with .env", () => card("cat .*", ["/w"], fixture(["/w/.env"])));
  it("witness: cat server/drivers/murage-exec/*", () => card("cat server/drivers/murage-exec/*", ["/w"], fixture()));
  it("witness: shopt -s dotglob; cat * with .env", () => card("shopt -s dotglob; cat *", ["/w"], fixture(["/w/.env"])));
  it.each(["cat locked/as*e*r*", "cat big/as*e*r*"])("CANNOT %s", async command => {
    const judged = await card(command, ["/w"], fixture());
    expect(judged.outcomes.find((outcome: Outcome) => outcome.cards)).toMatchObject({ kind: "cannot", witness: null });
    expect(judged.outcomes.find((outcome: Outcome) => outcome.cards)?.code).toMatch(command.includes("locked") ? /^EACCES$/ : /^entries$/);
  });
  it.each(["grep -r . .ss?/*", "tar cf - .ss?/*"])("[R2] directory reader %s in {~}", command => card(command, [HOME], fixture([], ARCHIVE_ONLY)));
  it("PowerShell: Get-Content \"*\" in {~/.ssh}", () => card(`Get-Content "*"`, [HOME + "/.ssh"], fixture(), { shell: "pwsh" }));
  it("PowerShell: Get-Content * with .env in /w (pwsh always dot-matches)", () => card("Get-Content *", ["/w"], fixture(["/w/.env"]), { shell: "pwsh" }));
  it("PowerShell: -LiteralPath never expands", async () => {
    const judged = await judge("Get-Content -LiteralPath '*'", [HOME + "/.ssh"], fixture(), { shell: "pwsh" });
    expect(judged.words).toEqual([]);
  });
  it("[A6] a found witness survives a later cap; ABSENT keeps sibling witnesses", async () => {
    const fs = tree(["/w/a/as.serviceaccount.json", ...WORKSPACE], { big: { "/w/zbig": 2001 } });
    const result = await expandCredentialGlob("*/as*e*r*", { cwd: "/w", fs, deadline: performance.now() + 5000 });
    expect(outcomeOf(result)).toMatchObject({ kind: "witness", cards: true, witness: "/w/a/as.serviceaccount.json" });
  });
  it("physical `..`: cat ../.ssh/* from {~/proj} is listed, not refused", async () => {
    const result = await expandCredentialGlob("../.ssh/*", { cwd: HOME + "/proj", home: HOME, fs: fixture(["/home/me/proj/x"]), deadline: performance.now() + 5000 });
    expect(outcomeOf(result)).toMatchObject({ kind: "witness", cards: true });
  });
  it("physical `..` through a link lands on the link's real parent", async () => {
    const fs = tree([...HOME_FILES, "/w/x"], { links: { "/w/k": "/home/me/.ssh/archive" } });
    const result = await expandCredentialGlob("k/../id_*", { cwd: "/w", home: HOME, fs, deadline: performance.now() + 5000 });
    expect(outcomeOf(result)).toMatchObject({ kind: "witness", witness: "/home/me/.ssh/id_rsa" });
  });
});

describe("X3 r5 section 3 bounds", () => {
  it("M11: one shared 65,536-step budget stops the counter and gives one budget card", async () => {
    const budget = newBudget();
    const fs = fixture();
    const outcomes: Outcome[] = [];
    for (let n = 0; n < 128; n++) {
      const word = `big/*${"abcdefgh"[n % 8]}*b*c*d*e*f*g*h*${n}`;
      outcomes.push(outcomeOf(await expandCredentialGlob(word, { cwd: "/w", fs, deadline: performance.now() + 60_000, budget })));
    }
    expect(budget.used).toBe(65_536);
    expect(outcomes.some(outcome => outcome.kind === "budget" && outcome.cards && outcome.rule === AA.GLOB_BUDGET_WORDS)).toBe(true);
  }, 120_000);
  it("saturation waits for a slot inside the deadline", async () => {
    const release: (() => void)[] = [];
    const slow: CredentialGlobFs = { ...fixture(), realpath: path => new Promise(resolve => release.push(() => resolve(path))) };
    const held = Array.from({ length: 8 }, () => expandCredentialGlob("/w/*.md", { fs: slow, deadline: performance.now() + 5000 }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const waiting = expandCredentialGlob("/w/as*e*r*", { fs: fixture(["/w/as.serviceaccount.json"]), deadline: performance.now() + 5000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const one of release.splice(0)) one();
    for (let k = 0; k < 20 && release.length < 64; k++) { await new Promise(resolve => setTimeout(resolve, 1)); for (const one of release.splice(0)) one(); }
    await Promise.all(held);
    expect(outcomeOf(await waiting)).toMatchObject({ kind: "witness", cards: true });
  });
  it("a slot not won by the deadline is a timeout", async () => {
    const release: (() => void)[] = [];
    const slow: CredentialGlobFs = { ...fixture(), realpath: path => new Promise(resolve => release.push(() => resolve(path))) };
    const held = Array.from({ length: 8 }, () => expandCredentialGlob("/w/*.md", { fs: slow, deadline: performance.now() + 30 }));
    const late = await expandCredentialGlob("/w/as*e*r*", { fs: fixture(), deadline: performance.now() + 15 });
    expect(outcomeOf(late)).toMatchObject({ kind: "cannot", code: "timeout", cards: true });
    for (const one of release) one();
    await Promise.all(held);
  });
});

describe("X3 r5 section 2 words", () => {
  it("G2: a lone [ or [[ is not a glob; a closed bracket is", () => {
    expect(globWords("[ -f x ] && [[ -d y ]]")).toEqual([]);
    expect(globWords("cat id_[r]sa").map(word => word.token)).toEqual(["id_[r]sa"]);
  });
  it("POSIX: quoted and escaped glob characters are literal", () => {
    expect(globWords(`cat '*' "?" \\*`)).toEqual([]);
  });
  it("G3: option words are listed whole", () => {
    expect(globWords("grep --include=*.json -r x .").map(word => word.token)).toEqual(["--include=*.json"]);
  });
  it("G4: local shell payloads only", () => {
    for (const command of ["sh -c 'cat *.md'", "bash -lc 'cat *.md'", "zsh -c 'cat *.md'", "dash -c 'cat *.md'", "ksh -c 'cat *.md'", "fish -c 'cat *.md'", "eval 'cat *.md'"]) {
      expect(globWords(command).map(word => word.token), command).toContain("*.md");
    }
    expect(globWords("pwsh -Command 'Get-Content *.md'").map(word => word.token)).toContain("*.md");
    expect(globWords("cmd /c 'type *.md'").map(word => word.token)).toContain("*.md");
    for (const command of ["python -c 'import glob; glob.glob(\"*\")'", "node -e 'x(\"*\")'", "jq '.[]' f", "awk '/a*/' f", "perl -e 'glob(\"*\")'", "ssh host 'cat *'", "docker exec c sh -c 'cat *'", "kubectl exec p -- cat '*'"]) {
      expect(globWords(command).filter(word => word.token === "*"), command).toEqual([]);
    }
  });
  it("[S1] enumerator classification", () => {
    const reader = (command: string) => globWords(command).find(word => word.token === ".ss?/*")?.reader;
    expect(reader("ls .ss?/*")).toBe(false);
    expect(reader("rtk ls .ss?/*")).toBe(false);
    expect(reader("find .ss?/* -name x")).toBe(false);
    expect(reader("ls .ss?/* | uniq -c")).toBe(false);
    expect(reader("ls .ss?/* | head -5")).toBe(false);
    expect(reader("ls .ss?/* | head -n 3 | wc -l")).toBe(false);
    expect(reader("ls .ss?/* |& cat")).toBe(true);
    expect(reader("ls .ss?/* | head x")).toBe(true);
    expect(reader("ls .ss?/* | sort | xargs cat")).toBe(true);
    expect(reader("ls .ss?/* &> out")).toBe(true);
    expect(reader("ls .ss?/* >> out")).toBe(true);
    expect(reader("ls .ss?/* | wc -l > out")).toBe(true);
    expect(reader("cat <(ls .ss?/*)")).toBe(true);
    expect(reader("echo `ls .ss?/*`")).toBe(true);
    expect(reader("find .ss?/* -delete")).toBe(true);
    expect(reader("find .ss?/* -fprint out")).toBe(true);
    expect(reader("grep -r . .ss?/*")).toBe(true);
  });
  it("dot rule switches", () => {
    expect(globWords("cat *")[0]?.dotMatch).toBe(false);
    for (const command of ["shopt -s dotglob; cat *", "setopt globdots; cat *", "setopt GLOB_DOTS; cat *", "GLOBIGNORE=x; cat *"]) expect(globWords(command).find(word => word.token === "*")?.dotMatch, command).toBe(true);
    expect(globWords("cat *", { dotglob: true })[0]?.dotMatch).toBe(true);
    expect(globWords("Get-Content *", { shell: "pwsh" })[0]?.dotMatch).toBe(true);
  });
});
