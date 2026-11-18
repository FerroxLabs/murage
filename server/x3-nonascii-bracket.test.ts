// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// arev-salv-x3restore-n3 High (MAIN 2026-11-17T08:33Z): a bracket class with a
// non-ASCII member never bypasses credential detection. The class is read as
// matching ANY character (fail closed). A `?` matches one whole character, so
// an astral-plane folder name is not skipped either. Every row runs
// prepareShellJudgement plus the owner verdict: Full access asks, and the
// No limits twin carries the card (its verdict runs every call).
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";
import { pathGlobsIntersect, segmentsIntersect } from "../shared/sensitive-globs.ts";

type Tree = Record<string, string[]>; // folder -> entries; a name ending in "/" is a folder
const enoent = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
function treeFs(tree: Tree): CredentialGlobFs {
  const isFile = (path: string) => (tree[posix.dirname(path)] ?? []).includes(posix.basename(path));
  const norm = (path: string) => posix.normalize(path).replace(/(.)\/$/, "$1");
  return {
    realpath: async (path: string) => {
      const n = norm(path);
      if (n in tree || isFile(n)) return n;
      throw enoent(n);
    },
    opendir: async (path: string) => {
      const entries = tree[norm(path)];
      if (!entries) throw enoent(norm(path));
      let at = 0;
      return {
        read: async () => {
          const entry = entries[at++];
          if (entry === undefined) return null;
          const dir = entry.endsWith("/");
          return { name: dir ? entry.slice(0, -1) : entry, isDirectory: () => dir, isSymbolicLink: () => false };
        },
        close: async () => {},
      };
    },
  };
}

const keyTree = (folder: string): Tree => ({ "/": ["work/"], "/work": [`${folder}/`, "src/"], [`/work/${folder}`]: ["credentials.json"], "/work/src": ["a.ts"] });
const plainTree = (folder: string): Tree => ({ "/": ["work/"], "/work": [`${folder}/`, "src/"], [`/work/${folder}`]: ["README.md"], "/work/src": ["a.ts"] });

async function judge(command: string, tree: Tree, noLimits: boolean) {
  const initial = { targets: new Map([["/work", "/work"]]) };
  const prepared = await prepareShellJudgement(command, initial, { fs: treeFs(tree), home: "/home/u", namedCwd: "/work", attributed: true });
  const bot = { id: "x3na", autoApprove: true, fullAccess: true, noLimits };
  const verdict = autoVerdict(bot, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: prepared.rule,
    shellCwdPrepared: true, shellCwdByThread: new Map([["t", prepared.local]]), threadId: "t",
  });
  return { rule: prepared.rule, verdict };
}

const MODES = [["Full access", false], ["No limits", true]] as const;

describe("X3 non-ASCII bracket class: credential witness", () => {
  for (const [mode, noLimits] of MODES) {
    it.each([
      ["cat /work/[é]/*", "é"],
      ["cat /work/[é]/credentials.json", "é"],
      ["cat /work/[éa]/*", "é"],
      ["cat /work/[ä-ö]/*", "é"],
      ["cat /work/[😀]/*", "😀"],
      ["cat /work/?/*", "😀"],
      ["cat /work/?/*", "é"],
    ])(`${mode}: %s with /work/%s/credentials.json present CARDS`, async (command, folder) => {
      const judged = await judge(command, keyTree(folder), noLimits);
      expect(judged.rule, JSON.stringify(judged)).toBeTruthy();
      // Full access asks. No limits runs every call (Sean ruling 2026-11-12 02:05Z); its witness is the
      // prepared card itself, as in server/x3-r5-shapes.test.ts.
      if (noLimits) expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
      else expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toBeNull();
    });
    it(`${mode}: cat /work/[é]/* over a folder without a key stays quiet`, async () => {
      const judged = await judge("cat /work/[é]/*", plainTree("é"), noLimits);
      expect(judged.rule, JSON.stringify(judged)).toBeNull();
      expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
      expect(judged.verdict.rule, JSON.stringify(judged.verdict)).toBeUndefined();
    });
  }
});

describe("X3 non-ASCII bracket class: the matcher", () => {
  it.each([
    ["é", "[é]"], ["é", "[!a]"], ["É", "[é]"], ["x", "[é]"], ["😀", "[😀]"], ["😀", "?"], ["a😀b", "a?b"], ["😀", "\0😀"], ["é", "[a-zé]"],
  ])("%s could match %s", (name, segment) => {
    expect(pathGlobsIntersect([name], [segment])).toBe(true);
  });
  it.each([
    ["ab", "?"], ["😀😀", "?"], ["b", "[a]"], ["é", "a"],
  ])("%s never matches %s", (name, segment) => {
    expect(pathGlobsIntersect([name], [segment])).toBe(false);
  });
  // the credential-family reader: its alphabets are ASCII, so a non-ASCII class there is any character too
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  it.each<[string, string[]]>([["[é]", [ALNUM]], ["[éa]x", [ALNUM, "x"]], ["[😀]x", [ALNUM, "x"]]])("family segment: %s could match an ASCII family name", (glob, family) => {
    expect(segmentsIntersect(glob, family)).toBe(true);
  });
});
