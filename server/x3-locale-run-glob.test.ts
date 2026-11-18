// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// arev-salv-x3restore-n4 High: a shell glob read in any locale never bypasses
// credential detection. The reader's locale decides how many characters a
// non-ASCII name holds (LC_ALL=C reads one per byte, UTF-8 one per code point,
// other multibyte charsets other counts), so a run of B non-ASCII bytes is read
// as any count from ceil(B/6) to B when the other side holds a wildcard. A
// U+FFFD in a decoded name stands for 1..3 unknown bytes. The walker rows run
// prepareShellJudgement plus the owner verdict: Full access asks, and the
// No limits twin carries the card (its verdict runs every call).
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";
import { credentialGlobHit, pathGlobsIntersect, segmentsIntersect } from "../shared/sensitive-globs.ts";

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
  const bot = { id: "x3lr", autoApprove: true, fullAccess: true, noLimits };
  const verdict = autoVerdict(bot, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: prepared.rule,
    shellCwdPrepared: true, shellCwdByThread: new Map([["t", prepared.local]]), threadId: "t",
  });
  return { rule: prepared.rule, verdict };
}

const MODES = [["Full access", false], ["No limits", true]] as const;

describe("X3 locale-read glob: credential witness", () => {
  for (const [mode, noLimits] of MODES) {
    it.each([
      ["cat /work/??/*", "é"],
      ["LC_ALL=C cat /work/??/*", "é"],
      ["cat /work/[é][é]/*", "é"],
      ["cat /work/????/*", "😀"],
      ["cat /work/???/*", "€"],
      ["cat /work/a??b/*", "aéb"],
      ["cat /work/???/*", "�"],
      ["cat /work/??????/*", "éü€"],
    ])(`${mode}: %s with /work/%s/credentials.json present CARDS`, async (command, folder) => {
      const judged = await judge(command, keyTree(folder), noLimits);
      expect(judged.rule, JSON.stringify(judged)).toBeTruthy();
      // Full access asks. No limits runs every call (Sean ruling 2026-11-12 02:05Z); its witness is the
      // prepared card itself, as in server/x3-r5-shapes.test.ts.
      if (noLimits) expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
      else expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toBeNull();
    });
    it(`${mode}: cat /work/??/* over a folder without a key stays quiet`, async () => {
      const judged = await judge("cat /work/??/*", plainTree("é"), noLimits);
      expect(judged.rule, JSON.stringify(judged)).toBeNull();
      expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
      expect(judged.verdict.rule, JSON.stringify(judged.verdict)).toBeUndefined();
    });
  }
});

describe("X3 locale-read glob: the matcher", () => {
  it.each([
    ["é", "??"], ["é", "?"], ["é", "[é][é]"], ["😀", "????"], ["😀", "??"], ["€", "???"], ["aéb", "a??b"],
    ["éa", "???"], ["�", "???"], ["éü€", "??????"], ["é", "?*"],
  ])("%s could match %s", (name, segment) => {
    expect(pathGlobsIntersect([name], [segment])).toBe(true);
  });
  it.each([
    // more characters than bytes, or fewer than any charset can pack them into
    ["é", "???"], ["😀", "?????"], ["😀😀", "?"], ["�", "????"],
    // literals still decide: an ASCII literal never meets a non-ASCII byte
    ["éa", "??b"], ["é", "a?"], ["éa", "b?"], ["é", "src"], ["src", "é?"], ["ab", "?"],
  ])("%s never matches %s", (name, segment) => {
    expect(pathGlobsIntersect([name], [segment])).toBe(false);
  });
});

describe("X3 locale-read glob: a non-ASCII credential root", () => {
  it("a temp root spelled with é is found by a byte-counted glob", () => {
    expect(credentialGlobHit(["/tmp/jos??/murage-mcp-*/mcp.json"], { roots: { temp: ["/tmp/josé"] } })).toBeTruthy();
  });
  it("a data root spelled with é is found by a byte-counted glob", () => {
    expect(credentialGlobHit(["/home/jos??/.murage/claude-private/*.json"], { roots: { temp: ["/tmp"], data: ["/home/josé/.murage"] } })).toBeTruthy();
  });
  it("a glob longer than the root's bytes still misses it", () => {
    expect(credentialGlobHit(["/tmp/jos???/murage-mcp-*/mcp.json"], { roots: { temp: ["/tmp/josé"] } })).toBeNull();
  });
  it.each<[string, string, boolean]>([["jos??", "josé", true], ["jos?", "josé", true], ["jos???", "josé", false], ["jo?", "josé", false]])("family segment %s vs %s: %s", (glob, root, could) => {
    expect(segmentsIntersect(glob, [...root])).toBe(could);
  });
});
