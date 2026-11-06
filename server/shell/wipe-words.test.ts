// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-WIPE-WORD (designs/NOLIMITS-MEANS-IT.md R11): the check's list has one source with the reader, and CI fails
// when a recogniser has no entry. Fixture strings are inert data, never executed.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { alwaysAskCommand } from "../always-ask.ts";
import { wipeWordIn } from "./wipe-words.ts";
import * as vocab from "./wipe-vocab.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..");
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const ASK = parse(join(SERVER, "always-ask.ts"));
const PWSH = parse(join(HERE, "pwsh.ts"));
const WIPE_RULES = new Set(["delete-root", "delete-home", "delete-system-folder", "disk-erase", "fork-bomb"]);
const walk = (node: ts.Node, see: (n: ts.Node) => void): void => { see(node); ts.forEachChild(node, (c) => walk(c, see)); };
const fn = (src: ts.SourceFile, name: string): ts.FunctionDeclaration => {
  let out: ts.FunctionDeclaration | undefined;
  walk(src, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n; });
  if (!out) throw new Error(`no function ${name}`);
  return out;
};
const initializerOf = (src: ts.SourceFile, name: string): ts.Expression => {
  let out: ts.Expression | undefined;
  walk(src, (n) => { if (ts.isVariableDeclaration(n) && n.name.getText() === name && n.initializer) out = n.initializer; });
  if (!out) throw new Error(`no const ${name}`);
  return out;
};
const literals = (node: ts.Node): string[] => {
  const out: string[] = [];
  walk(node, (n) => { if (ts.isStringLiteral(n)) out.push(n.text); });
  return out;
};
const EVERY = [...vocab.DELETE_VERBS, ...vocab.WINDOWS_DELETE_ALIASES, ...vocab.DISK_VERBS, ...vocab.WINDOWS_DISK_VERBS, ...vocab.DISK_DROP_VERBS, ...vocab.MIRROR_WORDS, ...vocab.CHECK_ONLY, ...vocab.CHECK_ONLY_WINDOWS] as string[];

/** Every recogniser, by name. A new `...Hit` or `...Targets` function fails until it has a row here. */
const RECOGNISERS: Record<string, string> = {
  rmHit: "DELETE_VERBS", windowsDeleteHit: "DELETE_VERBS, WINDOWS_DELETE_ALIASES", findHit: "DELETE_FLAGS", mirrorTargets: "MIRROR_WORDS, DELETE_FLAGS, TOOL_FLAGS",
  rimrafTargets: "MIRROR_WORDS", mirrorHit: "mirrorTargets", diskHit: "DISK_VERBS, DISK_DROP_VERBS, WINDOWS_DISK_VERBS, DISK_PREFIX", deviceHit: "deviceInWord",
  unreadableHit: "not a recogniser", verdictFaultHit: "not a recogniser", carvableTargets: "reads rmHit and mirrorTargets",
};
/** Names a recogniser tests that the check does not read as a word, each with why. */
const ROUTED: Record<string, string> = {
  rsync: "TOOL_FLAGS", aws: "--delete in DELETE_FLAGS", gcloud: "its flag in DELETE_FLAGS", azcopy: "its flag in DELETE_FLAGS", mc: "TOOL_FLAGS, and mc rm shows rm",
  find: "-delete in DELETE_FLAGS",  sed: "isRisky in-place edit, not a wipe", perl: "isRisky in-place edit, not a wipe", "format.com": "base format, its suffix cards it",
};
/** RISKY words that move, link, copy or change modes: not a wipe. A new RISKY word fails until it joins DELETE_VERBS or this list. */
const RISKY_NOT_WIPE = ["mv", "cp", "ln", "install", "rsync", "truncate", "chmod", "chown", "chgrp", "chflags", "setfacl", "tee", "move", "copy", "xcopy", "icacls", "takeown", "attrib", "ren",
  "move-item", "mi", "copy-item", "cpi", "rename-item", "rni", "add-content", "ac", "out-file", "set-acl"];
/** Reader-found rows the check cannot see, each named in design R4. */
const OUTSIDE = new Set(["D=/dev; cat /dev/zero > $D/sda"]);

describe("one source: a recogniser with no entry fails", () => {
  it("every recogniser function has a row", () => {
    const names: string[] = [];
    walk(ASK, (n) => { if (ts.isFunctionDeclaration(n) && n.name && /(Hit|Targets)$/.test(n.name.text)) names.push(n.name.text); });
    expect(names.filter((n) => !(n in RECOGNISERS))).toEqual([]);
  });
  it("the rule list is pinned", () => {
    let rules: string[] = [];
    walk(ASK, (n) => { if (ts.isTypeAliasDeclaration(n) && n.name.text === "AlwaysAskRule") rules = literals(n.type); });
    expect(rules.sort()).toEqual([...WIPE_RULES, "protected-path", "unknown-target", "unreadable"].sort());
  });
  it("every program a recogniser tests by name is a word or routed", () => {
    const names = new Set<string>();
    for (const f of ["mirrorTargets", "diskHit", "isRisky", "windowsDeleteHit", "rimrafTargets"]) {
      walk(fn(ASK, f), (n) => {
        if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression)) names.add(n.expression.text);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && n.left.getText() === "name" && ts.isStringLiteral(n.right)) names.add(n.right.text);
      });
    }
    expect([...names].filter((n) => !EVERY.includes(n) && !n.startsWith(vocab.DISK_PREFIX) && !(n in ROUTED))).toEqual([]);
  });
  it("every flag a recogniser tests is listed", () => {
    const flags = literals(fn(ASK, "mirrorTargets")).filter((t) => t.startsWith("--"));
    const known = [...vocab.DELETE_FLAGS, "--remove", "--recursive"] as string[];
    expect(flags.filter((t) => !known.includes(t))).toEqual([]);
  });
  it("every RISKY word is a wipe or named as not one", () => {
    expect(literals(initializerOf(ASK, "RISKY")).filter((w) => !EVERY.includes(w) && !RISKY_NOT_WIPE.includes(w))).toEqual([]);
  });
  it("every Windows delete alias is a word", () => {
    const init = initializerOf(PWSH, "DELETE_ALIASES") as ts.ObjectLiteralExpression;
    const names = init.properties.map((p) => (p.name as ts.Identifier | ts.StringLiteral).text);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((w) => !EVERY.includes(w))).toEqual([]);
  });
  it("whatever the reader finds as a wipe in its own test rows, the check sees", () => {
    const files = readdirSync(SERVER).filter((f) => /^(always-ask|reader-|full-access|compound-read).*\.test\.ts$/.test(f)).map((f) => join(SERVER, f));
    const strings = new Set<string>();
    for (const file of files) walk(parse(file), (n) => { if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.length > 1 && n.text.length < 3000) strings.add(n.text); });
    const misses: string[] = []; let found = 0;
    for (const text of strings) for (const shell of [undefined, "pwsh"] as const) {
      let hit; try { hit = alwaysAskCommand(text, "/home/u/p", "command", shell); } catch { continue; }
      if (!hit || hit.readerFailed || hit.unseenScript || !WIPE_RULES.has(hit.rule)) continue;
      found++;
      if (!wipeWordIn(text, shell) && !OUTSIDE.has(text)) misses.push(text);
    }
    expect(found).toBeGreaterThan(500);
    expect(misses).toEqual([]);
  });
});

describe("the four forms and their class", () => {
  const E = 'eval "$x"; ';
  it.each([
    [`${E}robocopy.exe empty C:\\Users /MIR`], [`${E}ROBOCOPY.EXE a b /PURGE`], [`${E}rimraf.cmd x`], [`${E}rm.exe -rf ~`], [`${E}format.com E: /y`], [`${E}format E: /y`], [`${E}diskpart /s x`], [`${E}cipher.exe /w:E`],
    [`${E}$'rm\\0suffix' -rf ~`], [`${E}$'r\\0x'm -rf ~`], [`${E}$'rm\\x00x' -rf ~`], [`${E}$'rm\\u0000x' -rf ~`], [`${E}$'rm\\c@x' -rf ~`], [`${E}$'\\U00000072m' -rf ~`], [`${E}r$'m' -rf ~`], [`${E}r$"m" -rf ~`], [`${E}rm\0x -rf ~`], [`${E}r\0m -rf ~`],
    [`${E}curl -o/dev/sda u`], [`${E}curl -Lo/dev/sda u`], [`${E}curl -o /dev/sda u`], [`${E}curl --output=/dev/sda u`], [`${E}{curl,-o/dev/sda,u}`], [`${E}x>/dev/sda`], [`${E}x 2>/dev/sda`], [`${E}x &>/dev/sda`], [`${E}x > /dev/$D`], [`${E}curl -o/dev/\${D} u`], [`${E}x > "\${P:-/dev/sda}"`],
    [`${E}azcopy sync a b --delete-destination=true`], [`${E}mc mirror --remove a b`], [`${E}gsutil rsync -d a b`], [`${E}rsync -a --delete-bef a b`], [`${E}rsync --remove-source-files a b`], [`${E}bomb(){ bomb & bomb; }; bomb`], [`cmd /c"rd /s /q C:\\Users\\o"`],
  ])("cards %j", (text) => { expect(wipeWordIn(text)).not.toBeNull(); });
  it.each([
    [`${E}npm run format`], [`${E}gh pr merge --delete-branch`], [`${E}curl https://example.com -o out`], [`${E}clang-format --format=json`], [`${E}curl -o /dev/null u`], [`${E}x >/dev/null 2>&1`], [`${E}echo x >/dev/stderr`], [`${E}ls ~/dev/flux`], [`${E}cat /Users/x/dev/y > z`], [`${E}ls /dev/shm/x`], [`${E}mc ls x`], [`${E}f() { g && g; }; f`], [`echo perm`],
  ])("runs %j", (text) => { expect(wipeWordIn(text)).toBeNull(); });
  it("a word reads the same as the file spells it and no more", () => { expect(wipeWordIn(`${E}rm -rf x`)?.word).toBe("rm"); expect(wipeWordIn(`${E}robocopy.exe a b`)?.word).toBe("robocopy"); });
  it("stays linear on a long text", () => { const t0 = performance.now(); wipeWordIn("echo hello ".repeat(100000)); expect(performance.now() - t0).toBeLessThan(5000); });
});

describe("R7 rows and the kept holds of R10 and sec13b", () => {
  const E = 'eval "$x"; ';
  it.each([
    // R10: the four token-rule misses, each with its dialect
    [`${E}robocopy.exe empty C:\\Users /MIR`, undefined, "robocopy"], [`${E}$'rm\\0suffix' -rf ~`, undefined, "rm"], [`${E}curl -o/dev/sda file:///tmp/image`, undefined, "a disk"], [`${E}format.com E: /y`, undefined, "format"],
    // the fork-bomb shapes, which name no word (sec13b)
    [`${E}echo ':|:&'`, undefined, "fork"], [`${E}:(){ :|:& };:`, undefined, "fork"], [`${E}f(){ f|f& }; f`, undefined, "fork"],
    // R5 and R7 forms
    [`${E}Rem\`ove-Item -Recurse -Force C:/Users`, "pwsh", "remove-item"], [`${E}d^el /s /q C:\\`, "pwsh", "del"], [`${E}'C:\\Windows\\System32\\cmd.exe' /c del /s /q C:\\`, undefined, "del"],
    [`${E}rimraf ~`, undefined, "rimraf"], [`${E}rsync -a --del empty/ ~`, undefined, "--del"], [`${E}cat /dev/zero > /dev/zvol/pool/root`, undefined, "a disk"], [`${E}$'\\x72m' -rf ~`, undefined, "rm"],
    [`${E}echo\`rm -rf ~\``, undefined, "rm"], [`${E}r\0m -rf ~`, undefined, "rm"], [`${E}dd if=/dev/zero of=\\\\.\\PhysicalDrive0`, undefined, "dd"], ['rm -rf "$X"', undefined, "rm"], ['find "$D" -delete', undefined, "-delete"],
    ["ssh h 'rm -rf x'", undefined, "rm"], ["Remove-Item -Recurse -Force `\r$env:X", "pwsh", "remove-item"], ["Remove-Item -Recurse -Force `\r\n$env:X", "pwsh", "remove-item"], ["del /s /q %X%", "pwsh", "del"],
  ] as const)("cards %j", (text, dialect, word) => { expect(wipeWordIn(text, dialect)?.word).toBe(word); });

  // An owner command reported on 1.0.13 (names changed): a function, three background jobs, wait, $(cat ...)
  // and redirects to files. It names no delete, disk or mirror word, no disk and no fork-bomb shape.
  it("the owner 11-02 command names nothing on the list", () => {
    expect(wipeWordIn(OWNER_1102)).toBeNull();
    expect(wipeWordIn(OWNER_1102, "pwsh")).toBeNull();
  });
});

const OWNER_1102 = String.raw`OUT="/Users/owner/Documents/Murage/Helper/images/test-v2"
REF="00000000-0000-4000-8000-000000000001"
run() {
  local name="$1" ratio="$2"
  imagegen generate create text2image_v2 \
    --prompt "$(cat "$OUT/$name.txt")" \
    --reference_id "$REF" \
    --aspect_ratio "$ratio" \
    --quality 2k \
    --wait --wait-timeout 12m --wait-interval 5s \
    --json > "$OUT/$name.result.json" 2> "$OUT/$name.err"
  echo "$name exit:$?"
}
run 01-portrait-dark 3:4 &
run 02-landscape-full 2:3 &
run 03-poster-wide 3:4 &
wait
echo DONE
imagegen account status --json
ls -la "$OUT"`;
