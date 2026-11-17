// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// arev-salv-x3restore-par High: a folder whose name is not valid UTF-8 never
// hides a credential from the glob walk. A listing decodes such a name to
// U+FFFD, and the decoded text is no longer the folder's address: reopening it
// finds nothing, or finds a different folder that really is spelled U+FFFD.
// The walk therefore never reopens a lossy folder or link. What the shell reads
// through it is unknown (it may hold a link to a key), so a pattern that
// matches it always cards. A plain file is its own name and is judged by it.
// Owners: the walker = salv-x3restore lane (this -par branch); the frontier
// rules it hands over to = shared/sensitive-globs.ts, same lane.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";

const enoent = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
type Entry = { name: string; dir: boolean; link?: boolean };
/**
 * A filesystem as Node shows it. `list` is what a folder listing returns
 * (decoded names); `reach` is what a decoded path really addresses. A folder
 * stored under raw bytes is listed but is not in `reach` under its decoded name.
 */
function lossyFs(list: Record<string, Entry[]>, reach: Record<string, string>): CredentialGlobFs {
  const norm = (path: string) => posix.normalize(path).replace(/(.)\/$/, "$1");
  return {
    realpath: async (path: string) => {
      const real = reach[norm(path)];
      if (real === undefined) throw enoent(norm(path));
      return real;
    },
    opendir: async (path: string) => {
      const entries = list[norm(path)];
      if (!entries) throw enoent(norm(path));
      let at = 0;
      return {
        read: async () => {
          const entry = entries[at++];
          if (entry === undefined) return null;
          return { name: entry.name, isDirectory: () => entry.dir, isSymbolicLink: () => entry.link === true };
        },
        close: async () => {},
      };
    },
  };
}

const LOSSY = "�";
const self = (...paths: string[]) => Object.fromEntries(paths.map(path => [path, path]));
/** /work/<raw byte FF>/credentials.json: listed as U+FFFD, not reachable by that text. */
const rawOnly = () => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name: LOSSY, dir: true }, { name: "src", dir: true }], "/work/src": [{ name: "a.ts", dir: false }] },
  self("/", "/work", "/work/src", "/work/src/a.ts"),
);
/** The raw folder with the key sits beside a harmless folder that really is named U+FFFD. */
const rawBesideTwin = () => lossyFs(
  {
    "/": [{ name: "work", dir: true }],
    "/work": [{ name: LOSSY, dir: true }, { name: LOSSY, dir: true }],
    [`/work/${LOSSY}`]: [{ name: "README.md", dir: false }],
  },
  self("/", "/work", `/work/${LOSSY}`, `/work/${LOSSY}/README.md`),
);
/** A raw-named link at the last position whose decoded text resolves to the harmless twin file. */
const rawLinkBesideTwin = () => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name: LOSSY, dir: false, link: true }, { name: LOSSY, dir: false }] },
  self("/", "/work", `/work/${LOSSY}`),
);
/** A plain file stored under a raw byte: nothing is opened through it. */
const rawFile = () => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name: LOSSY, dir: false }, { name: "src", dir: true }], "/work/src": [{ name: "a.ts", dir: false }] },
  self("/", "/work", "/work/src", "/work/src/a.ts"),
);
/** Valid names only: the same shape with nothing lossy. */
const validOnly = () => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name: "é", dir: true }], "/work/é": [{ name: "README.md", dir: false }] },
  self("/", "/work", "/work/é", "/work/é/README.md"),
);

async function judge(command: string, fs: CredentialGlobFs | undefined, noLimits: boolean, cwd = "/work") {
  const initial = { targets: new Map([[cwd, cwd]]) };
  const prepared = await prepareShellJudgement(command, initial, { ...(fs ? { fs } : {}), home: "/home/u", namedCwd: cwd, attributed: true });
  const bot = { id: "x3ln", autoApprove: true, fullAccess: true, noLimits };
  const verdict = autoVerdict(bot, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, globExpansionRule: prepared.rule,
    shellCwdPrepared: true, shellCwdByThread: new Map([["t", prepared.local]]), threadId: "t",
  });
  return { rule: prepared.rule, verdict };
}
type Judged = Awaited<ReturnType<typeof judge>>;
const cards = (judged: Judged, noLimits: boolean) => {
  expect(judged.rule, JSON.stringify(judged)).toBeTruthy();
  // Full access asks. No limits runs every call (Sean ruling 2026-11-12 02:05Z); its witness is the prepared card.
  if (noLimits) expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
  else expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toBeNull();
};
const quiet = (judged: Judged) => {
  expect(judged.rule, JSON.stringify(judged)).toBeNull();
  expect(judged.verdict.approve, JSON.stringify(judged.verdict)).toEqual(expect.any(String));
  expect(judged.verdict.rule, JSON.stringify(judged.verdict)).toBeUndefined();
};

const MODES = [["Full access", false], ["No limits", true]] as const;

describe("X3 lossy folder name: the walk never reopens decoded text", () => {
  for (const [mode, noLimits] of MODES) {
    it.each([
      "cat /work/?/*",
      "LC_ALL=C cat /work/?/*",
      "cat /work/*/*",
      "cat /work/*/credentials.json",
      "cat /work/**/*.json",
      "cat /work/?/*.md",
    ])(`${mode}: %s over a raw-byte folder CARDS`, async command => {
      cards(await judge(command, rawOnly(), noLimits), noLimits);
    });
    it(`${mode}: a raw-byte folder beside a harmless folder spelled U+FFFD CARDS`, async () => {
      cards(await judge("cat /work/?/*", rawBesideTwin(), noLimits), noLimits);
    });
    it(`${mode}: a raw-byte link is never resolved through its decoded text`, async () => {
      cards(await judge("cat /work/?", rawLinkBesideTwin(), noLimits), noLimits);
    });
    it(`${mode}: a pattern that cannot match the raw-byte folder stays quiet`, async () => {
      quiet(await judge("cat /work/s*/*", rawOnly(), noLimits));
    });
    it(`${mode}: a plain file stored under a raw byte stays quiet`, async () => {
      quiet(await judge("cat /work/?", rawFile(), noLimits));
    });
    it(`${mode}: the same shape with valid names only stays quiet`, async () => {
      quiet(await judge("cat /work/?/*", validOnly(), noLimits));
    });
  }
});

// The real filesystem. Only Linux stores a name that is not valid UTF-8
// (macOS and Windows refuse to create one), so these rows need it.
describe.runIf(process.platform === "linux")("X3 lossy folder name: real bytes on disk", () => {
  const root = mkdtempSync(posix.join(tmpdir(), "x3ln-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const rawFolder = (work: string, file: string) => {
    mkdirSync(posix.join(root, work));
    const folder = Buffer.concat([Buffer.from(posix.join(root, work) + "/"), Buffer.from([0xff])]);
    mkdirSync(folder);
    writeFileSync(Buffer.concat([folder, Buffer.from("/" + file)]), "{}");
    return posix.join(root, work);
  };
  for (const [mode, noLimits] of MODES) {
    const tag = noLimits ? "n" : "f";
    it(`${mode}: cat <work>/?/* reads credentials.json inside a folder named by byte FF, so it CARDS`, async () => {
      const work = rawFolder(`key-${tag}`, "credentials.json");
      cards(await judge(`cat ${work}/?/*`, undefined, noLimits, work), noLimits);
    });
    it(`${mode}: cat <work>/s*/* beside the same folder never matches it and stays quiet`, async () => {
      const work = rawFolder(`plain-${tag}`, "credentials.json");
      mkdirSync(posix.join(work, "src"));
      writeFileSync(posix.join(work, "src", "a.ts"), "");
      quiet(await judge(`cat ${work}/s*/*`, undefined, noLimits, work));
    });
  }
});

// arev-salv-x3restore-par-n2 High: an ASCII byte can be the second byte of a
// character. Bytes 81 41 are ONE character to a shell in a Shift_JIS locale,
// so `?` matches that folder, while a listing decodes them to U+FFFD then "A"
// (two characters). The matcher reads an ASCII character after a lossy one as
// maybe swallowed by it, so the pattern still reaches the lossy-name check.
// GB18030 spells one character as 81 30 81 30 (U+FFFD "0" U+FFFD "0").
const TRAIL = LOSSY + "A";
const FOUR = LOSSY + "0" + LOSSY + "0";
const oneFolder = (name: string, dir = true, link = false) => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name, dir, link }, { name: "src", dir: true }], "/work/src": [{ name: "a.ts", dir: false }] },
  self("/", "/work", "/work/src", "/work/src/a.ts"),
);
/** Valid names only: "é" then "A" is two characters or more in every locale. */
const validTrail = () => lossyFs(
  { "/": [{ name: "work", dir: true }], "/work": [{ name: "éA", dir: true }], "/work/éA": [{ name: "README.md", dir: false }] },
  self("/", "/work", "/work/éA", "/work/éA/README.md"),
);

describe("X3 lossy folder name: an ASCII byte may be the tail of a multibyte character", () => {
  for (const [mode, noLimits] of MODES) {
    it.each([
      "cat /work/?/*",
      "cat /work/?/credentials.json",
      "cat /work/[!x]/*",
      "cat /work/??/*",
      "cat /work/?A/*",
    ])(`${mode}: %s over a folder stored as bytes 81 41 CARDS`, async command => {
      cards(await judge(command, oneFolder(TRAIL), noLimits), noLimits);
    });
    it(`${mode}: cat /work/?/* over a folder stored as bytes 81 30 81 30 CARDS`, async () => {
      cards(await judge("cat /work/?/*", oneFolder(FOUR), noLimits), noLimits);
    });
    it(`${mode}: a link stored as bytes 81 41 is matched by ? and never resolved through its decoded text`, async () => {
      cards(await judge("cat /work/?", oneFolder(TRAIL, false, true), noLimits), noLimits);
    });
    it.each([
      "cat /work/?B/*",
      "cat /work/A?/*",
      "cat /work/s*/*",
    ])(`${mode}: %s cannot match bytes 81 41 in any locale and stays quiet`, async command => {
      quiet(await judge(command, oneFolder(TRAIL), noLimits));
    });
    it(`${mode}: a plain file stored as bytes 81 41 stays quiet`, async () => {
      quiet(await judge("cat /work/?", oneFolder(TRAIL, false), noLimits));
    });
    it(`${mode}: a valid two-character folder name is not one character and stays quiet`, async () => {
      quiet(await judge("cat /work/?/*", validTrail(), noLimits));
    });
  }
});

describe.runIf(process.platform === "linux")("X3 lossy folder name: real bytes 81 41 on disk", () => {
  const root = mkdtempSync(posix.join(tmpdir(), "x3lt-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const trailFolder = (work: string, file: string) => {
    mkdirSync(posix.join(root, work));
    const folder = Buffer.concat([Buffer.from(posix.join(root, work) + "/"), Buffer.from([0x81, 0x41])]);
    mkdirSync(folder);
    writeFileSync(Buffer.concat([folder, Buffer.from("/" + file)]), "{}");
    return posix.join(root, work);
  };
  for (const [mode, noLimits] of MODES) {
    const tag = noLimits ? "n" : "f";
    it(`${mode}: cat <work>/?/* reads credentials.json inside a folder named by bytes 81 41, so it CARDS`, async () => {
      const work = trailFolder(`key-${tag}`, "credentials.json");
      cards(await judge(`cat ${work}/?/*`, undefined, noLimits, work), noLimits);
    });
    it(`${mode}: cat <work>/?B/* beside the same folder never matches it and stays quiet`, async () => {
      const work = trailFolder(`plain-${tag}`, "credentials.json");
      quiet(await judge(`cat ${work}/?B/*`, undefined, noLimits, work));
    });
    it(`${mode}: cat <work>/?/* over a harmless folder really named with two valid characters stays quiet`, async () => {
      const work = posix.join(root, `valid-${tag}`);
      mkdirSync(posix.join(work, "éA"), { recursive: true });
      writeFileSync(posix.join(work, "éA", "README.md"), "");
      quiet(await judge(`cat ${work}/?/*`, undefined, noLimits, work));
    });
  }
});
