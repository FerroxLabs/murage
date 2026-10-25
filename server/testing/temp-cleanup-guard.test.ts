// Every test that removes a temp directory does it through server/testing/cleanup.ts (removeTempDir / removeTempDirSync).
//
// Why this is a test and not a convention: a raw recursive rmSync does not close the message database, does not wait for the
// log checkpointer thread that holds its own connection to the same file, and does not retry. On Windows that is EPERM
// ("operation not permitted") on the directory; on Linux it is ENOTEMPTY while the checkpointer's last close is still copying
// or deleting the -wal. The family took out dozens of suites on the 1.0.2 CI run, every one of them with all assertions green.
// One helper with the settle step and an exponential backoff fixes the cause; this keeps a new suite from going around it.
//
// data-safety.test.ts guards the other half (nothing recursive-deletes a data directory) and reads its vitest scope from the
// same test-file-scope.ts, so the two lists cannot disagree about which files run under the safe-wipe guard.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TEMP_CLEANUP_SCOPE, VITEST_INCLUDE } from "./test-file-scope.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A recursive delete through fs: sync, promise, callback or node's fs.rm, with the options object on one line or several. */
const RAW_RECURSIVE_DELETE = /(?<![\w$])(?:(?:fs|fsp|nodeFs|fsPromises|promises)\.(?:promises\.)?)?(?:rmSync|rmdirSync|rm|rmdir)\s*\((?:[^;()]|\([^;()]*\))*?\brecursive\s*:\s*true|(?<![\w$.])rimraf\s*\(/g;

/**
 * Test files that still call a raw recursive delete on purpose. Add an entry only with a reason a reviewer can check against
 * the file, and only for a delete that is the behaviour under test (a test that removes something mid-test to exercise product
 * code, or that proves the safe-wipe guard refuses it), never for teardown.
 */
const ALLOWLIST: Record<string, string> = {
  "server/data-dir-guard.test.ts": "tests the data-directory guard on the raw fs calls: lines 110 and 114 assert that a raw recursive rmSync of the data dir or its workspaces folder throws DataDirectoryProtected, line 118 that a raw rmSync of one bot's folder inside it is allowed; routing them through removeTempDirSync would test the helper, not the guard. The file's own fixture teardown (rmSync of `parent`) does go through the helper",
  "server/link-removal.test.ts": "tests that removing a linked skill never goes through rmSync: line 78 calls a raw recursive rmSync on the link on purpose, under the emulated Electron Windows rmSync, to prove that call would follow the link and delete the skill's own files (the assertion on the next line), which is the hazard removeLink avoids",
  "server/ticket-recovery-f3.test.ts": "tests that a ticket's started row stays until a PERSISTED receipt replaces it: breakReceipts (line 33) removes the receipts file and stands a directory in its place so the receipt write fails, mendReceipts (line 34) takes that directory away again mid-test and in afterEach; the data dir itself is still removed through removeTempDirSync in beforeEach",
  "server/testing/safe-wipe.test.ts": "tests installSafeWipeGuard itself: it calls the raw fs.rmSync / fs.rm / fs.promises.rm / callback forms on purpose, to prove each is refused for a protected path (and admitted for a scratch one); its own fixture teardown at the end is the raw call under test's guard",
};

const tracked = (): string[] => {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // A copy made for a container run has no .git: the listing saved beside data-safety.test.ts is read instead.
    listing = readFileSync(join(ROOT, "server/testing/.git-ls-files.fixture"), "utf8");
  }
  return listing.split("\0").filter(Boolean);
};

/** Same length as the source, with the inside of string literals, template text and comments blanked: a delete named in a
 * fixture string ("node -e fs.rmSync(...)") is data a test feeds a command, not a delete the test performs. Code inside a
 * template's ${...} is kept. */
const maskStringsAndComments = (src: string): string => {
  const out = src.split("");
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const code = (i: number, stopAtBrace: boolean): number => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        blank(i + 1, j); i = j + 1; continue;
      }
      if (c === "`") {
        let j = i + 1;
        while (j < src.length && src[j] !== "`") {
          if (src[j] === "\\") { blank(j, j + 2); j += 2; continue; }
          if (src[j] === "$" && src[j + 1] === "{") { blank(j, j + 2); j = code(j + 2, true); continue; }
          blank(j, j + 1); j++;
        }
        i = j + 1; continue;
      }
      if (stopAtBrace) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return i + 1; depth--; } }
      i++;
    }
    return i;
  };
  code(0, false);
  return out.join("");
};

const rawDeletes = (file: string): string[] => {
  const text = readFileSync(join(ROOT, file), "utf8");
  const masked = maskStringsAndComments(text);
  const lines = text.split("\n");
  const hits: string[] = [];
  for (const match of masked.matchAll(RAW_RECURSIVE_DELETE)) {
    const line = text.slice(0, match.index).split("\n").length;
    const trimmed = (lines[line - 1] ?? "").trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    hits.push(`${file}:${line}: ${trimmed.slice(0, 140)}`);
  }
  return hits;
};

describe("temp-dir cleanup goes through the shared helper", () => {
  const files = tracked().filter(f => TEMP_CLEANUP_SCOPE.some(rx => rx.test(f)) && f !== "server/testing/temp-cleanup-guard.test.ts");

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("server/tasks.test.ts");
  });

  it("no test file removes a directory recursively with a raw rmSync/rm (use removeTempDir / removeTempDirSync from server/testing/cleanup.ts)", () => {
    const raw: string[] = [];
    for (const file of files) if (!ALLOWLIST[file]) raw.push(...rawDeletes(file));
    expect(raw, "route these through removeTempDir (async) or removeTempDirSync (sync hooks), or allowlist them with a reason").toEqual([]);
  });

  it("sees a raw delete in code and ignores one named inside a string or a comment", () => {
    const code = "afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });";
    const text = [code, 'const cmd = "node -e fs.rmSync(\'/x\',{recursive:true})";', "// rmSync(a, { recursive: true })", "const t = `rm(${x}, { recursive: true })`;"].join("\n");
    expect(maskStringsAndComments(text).match(RAW_RECURSIVE_DELETE)?.length).toBe(1);
    expect(maskStringsAndComments(text).length).toBe(text.length);
  });

  it("keeps the allowlist honest: every entry still contains a raw recursive delete", () => {
    const stale = Object.keys(ALLOWLIST).filter(file => !files.includes(file) || rawDeletes(file).length === 0);
    expect(stale).toEqual([]);
  });

  it("agrees with data-safety.test.ts: every guarded file is a vitest file, so the safe-wipe guard still backs the helper", () => {
    const outside = files.filter(f => !VITEST_INCLUDE.some(rx => rx.test(f)) && !/\.tsx$/.test(f));
    expect(outside).toEqual([]);
    for (const file of Object.keys(ALLOWLIST)) expect(VITEST_INCLUDE.some(rx => rx.test(file)), file).toBe(true);
  });

  it("the helper itself still checks admission on every attempt and settles handles before it removes", () => {
    const helper = readFileSync(join(ROOT, "server/testing/cleanup.ts"), "utf8");
    expect(helper).toMatch(/await settleTestHandles\(dir\)/);
    expect(helper).toMatch(/settleTestHandlesSync\(dir\)/);
    expect(helper.match(/admit\(dir\)/g)?.length).toBe(2);
    expect(helper).toMatch(/assertSafeToWipe\(dir\);/);
  });
});
