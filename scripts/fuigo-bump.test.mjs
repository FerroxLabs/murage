import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { checkRealTurns, commitFiles, hunksOf, callExpressions, machineHeader, mergeCheck, movePin, parseArgs, parseHashNote, readRealTurns, REAL_TURN_OSES, REAL_TURN_STEPS, WINDOWS_STEPS } from "./fuigo-bump.mjs";

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const required = ["--version", "1.0.37", "--fuigo-checkout", "/f", "--evidence", "/e", "--base", "abc", "--reviewed-hunks", "/r"];

describe("fuigo-bump", () => {
  it("needs every input and exactly one real-turn source", () => {
    expect(() => parseArgs(required)).toThrow(/exactly one/);
    expect(() => parseArgs([...required, "--real-turns", "/t", "--real-turns-owed"])).toThrow(/exactly one/);
    expect(parseArgs([...required, "--real-turns-owed"]).version).toBe("1.0.37");
    expect(() => parseArgs(["--version", "1.0.37.1", ...required.slice(2), "--real-turns-owed"])).toThrow(/x\.y\.z/);
  });

  it("gives every hunk its own stable id, so changing a reviewed hunk asks for a new review", () => {
    const [first, second] = hunksOf("diff\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n");
    expect(first.sha1).not.toBe(second.sha1);
    expect(hunksOf("diff\n@@ -1 +1 @@\n-a\n+B\n")[0].sha1).not.toBe(first.sha1);
  });

  it("reads whole call expressions, nested parens included", () => {
    expect(callExpressions("x(); go(a, f(b)); go(c)", "go(")).toEqual(["go(a, f(b))", "go(c)"]);
  });

  it("reads both tables of the hash note", () => {
    expect(parseHashNote("| `fuigo` | `aa` |\n| `fuigo` | `sha512-bb==` |\n| Package | SHA-256 |")).toEqual({ fuigo: { sha256: "aa", integrity: "sha512-bb==" } });
  });

  it("moves version, source and both digests, and stops when a target has no pin block", () => {
    const hex = (c) => c.repeat(64);
    const head = "1".repeat(40), next = "2".repeat(40);
    const source = `export const FUIGO_VERSION = "1.0.32";\n// report gitHead ${head}.\n"linux-x64": Object.freeze({\n  package: "@fuigo/linux-x64",\n  tarballSha256: "${hex("a")}",\n  binarySha256: "${hex("b")}",\n}),\n`;
    const moved = movePin(source, "1.0.37", next, { "linux-x64": { tarballSha256: hex("c"), binarySha256: hex("d") } });
    expect(moved).toContain('"1.0.37"');
    expect(moved).toContain(next);
    expect(moved).toContain(hex("c"));
    expect(moved).toContain(hex("d"));
    expect(moved).not.toContain("1.0.32");
    expect(() => movePin(source, "1.0.37", next, { "win32-x64": { tarballSha256: hex("c"), binarySha256: hex("d") } })).toThrow(/no pin block/);
  });

  it("names each machine header", () => {
    const elf = Buffer.alloc(64);
    elf.write("\x7fELF", 0, "latin1");
    elf.writeUInt16LE(0x3e, 18);
    expect(machineHeader(elf)).toEqual({ format: "ELF64", machine: 0x3e });
    expect(() => machineHeader(Buffer.alloc(64))).toThrow(/unknown/);
  });
});

const hex = (c, length = 64) => c.repeat(length);
const asset = { "linux-x64": hex("a"), "win32-x64": hex("b"), "darwin-arm64": hex("c") };
const want = { version: "1.0.37", peeledTag: hex("1", 40), murageSha: hex("2", 40), policySha256: null,
  assets: Object.fromEntries(Object.entries(asset).map(([target, binarySha256]) => [target, { tarballSha256: hex("0"), binarySha256 }])) };
const rpc = (...lines) => Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n"));
const realLog = (extra = []) => rpc(
  { id: 0, method: "initialize", params: { clientCapabilities: { fs: {} } } },
  { id: 1, method: "session/new", params: { cwd: "/w" } },
  { id: 9, method: "fuigo/folder_trust/request", params: {} },
  { id: 2, method: "session/prompt", params: { sessionId: "s1" } },
  { id: 8, method: "session/request_permission", params: {} }, ...extra);
const realFile = (os, target, overrides = {}, log = realLog()) => ({ name: `${os}.json`, rpcLog: log, row: {
  schema: 1, os, target, fuigoVersion: "1.0.37", fuigoVersionLine: "fuigo 1.0.37 (58f976406)", peeledTag: want.peeledTag, murageSha: want.murageSha,
  binarySha256: asset[target], policySha256: null, launchArgv: ["agent", "--no-leader", "stdio"],
  rpcLog: `${os}.rpc.jsonl`, rpcLogSha256: createHash("sha256").update(log).digest("hex"),
  steps: Object.fromEntries([...REAL_TURN_STEPS, ...WINDOWS_STEPS, "g7"].map((id) => [id, { pass: true, sessionId: "s1" }])), ...overrides } });
const realFiles = () => [realFile("linux", "linux-x64"), realFile("windows", "win32-x64"), realFile("macos", "darwin-arm64")];
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

describe("real-turn evidence", () => {
  it("takes one full row per OS and returns what the receipt keeps", () => {
    const receipts = checkRealTurns(realFiles(), want);
    expect(receipts.map((row) => row.os).sort()).toEqual(Object.keys(REAL_TURN_OSES).sort());
    expect(receipts.every((row) => /^[0-9a-f]{64}$/.test(row.rpcLogSha256))).toBe(true);
  });

  it("refuses three bare JSON files", () => {
    const bare = ["linux", "windows", "macos"].map((os) => ({ name: `${os}.json`, row: { fuigoVersion: "1.0.37", pass: true } }));
    expect(() => checkRealTurns(bare, want)).toThrow(/schema is not 1/);
    const named = [1, 2, 3].map((n) => ({ name: `row${n}.json`, row: { fuigoVersion: "1.0.37", pass: true } }));
    expect(() => checkRealTurns(named, want)).toThrow(/need exactly/);
  });

  it("refuses the same OS run three times under three names", () => {
    const [linux] = realFiles();
    const copies = ["linux", "windows", "macos"].map((os) => ({ ...linux, name: `${os}.json` }));
    expect(() => checkRealTurns(copies, want)).toThrow(/windows\.json: os is linux/);
  });

  it.each([
    ["a missing OS", (files) => files.slice(1), /need exactly/],
    ["an extra file", (files) => [...files, { name: "extra.json", row: {} }], /need exactly/],
    ["another version", (files) => [realFile("linux", "linux-x64", { fuigoVersion: "1.0.36" }), ...files.slice(1)], /fuigoVersion is 1\.0\.36/],
    ["a version line of another build", (files) => [realFile("linux", "linux-x64", { fuigoVersionLine: "fuigo 1.0.370" }), ...files.slice(1)], /version line/],
    ["another tag commit", (files) => [realFile("linux", "linux-x64", { peeledTag: hex("9", 40) }), ...files.slice(1)], /tag commit/],
    ["another Murage sha", (files) => [realFile("linux", "linux-x64", { murageSha: hex("9", 40) }), ...files.slice(1)], /Murage sha/],
    ["a binary that is not the pin", (files) => [realFile("linux", "linux-x64", { binarySha256: hex("9") }), ...files.slice(1)], /pinned asset/],
    ["another OS's asset", (files) => [realFile("linux", "win32-x64"), ...files.slice(1)], /not a linux asset/],
    ["a --trust launch", (files) => [realFile("linux", "linux-x64", { launchArgv: ["agent", "--trust", "--no-leader"] }), ...files.slice(1)], /generation 2/],
    ["a policy no one gave", (files) => [realFile("linux", "linux-x64", { policySha256: hex("d") }), ...files.slice(1)], /policy sha/],
    ["no raw log", (files) => [{ ...files[0], rpcLog: undefined }, ...files.slice(1)], /raw ACP log missing/],
    ["an edited log", (files) => [{ ...files[0], rpcLog: realLog([{ id: 3 }]) }, ...files.slice(1)], /does not match/],
    ["a failed step", (files) => [realFile("linux", "linux-x64", { steps: { ...files[0].row.steps, "level-no-limits": { pass: false, sessionId: "s1" } } }), ...files.slice(1)], /step level-no-limits/],
    ["a step with no turn in the log", (files) => [realFile("linux", "linux-x64", { steps: { ...files[0].row.steps, g3: { pass: true, sessionId: "other" } } }), ...files.slice(1)], /step g3/],
    ["a step left out", (files) => [realFile("linux", "linux-x64", { steps: without(files[0].row.steps, "card-skip") }), ...files.slice(1)], /step card-skip/],
    ["no Windows PATH row", (files) => [files[0], realFile("windows", "win32-x64", { steps: without(files[1].row.steps, "windows-path-trailing-semicolon") }), files[2]], /windows-path-trailing-semicolon/],
    ["a terminal call in the log", (files) => [realFile("linux", "linux-x64", {}, realLog([{ id: 5, method: "terminal/create", params: {} }])), ...files.slice(1)], /terminal call/],
    ["a terminal offered", (files) => [realFile("linux", "linux-x64", {}, realLog([{ id: 6, method: "initialize", params: { clientCapabilities: { terminal: true } } }])), ...files.slice(1)], /offered a terminal/],
    ["a leader clientTerminal", (files) => [realFile("linux", "linux-x64", {}, realLog([{ id: 7, method: "session/new", params: { _meta: { clientTerminal: true } } }])), ...files.slice(1)], /clientTerminal/],
    ["an empty log", (files) => [realFile("linux", "linux-x64", {}, Buffer.from("")), ...files.slice(1)], /no initialize/],
    ["a log with no trust request", (files) => [realFile("linux", "linux-x64", {}, rpc({ method: "initialize", params: {} }, { method: "session/prompt", params: { sessionId: "s1" } }, { method: "session/request_permission" })), ...files.slice(1)], /no folder trust request/],
    ["a log that is not JSON", (files) => [realFile("linux", "linux-x64", {}, Buffer.from("pass\n")), ...files.slice(1)], /not JSON/],
    ["g7 on no OS", (files) => files.map((file) => realFile(file.row.os, file.row.target, { steps: without(file.row.steps, "g7") })), /step g7/],
  ])("refuses %s", (_label, change, message) => {
    expect(() => checkRealTurns(change(realFiles()), want)).toThrow(message);
  });

  it("with a policy needs its sha in every row, the engine's ack in the log and step g1", () => {
    const policy = hex("e");
    const acked = realLog([{ id: 1, result: { _meta: { "fuigo/permissionPolicy": { sha256: policy } } } }]);
    const row = (os, target, log) => realFile(os, target, { policySha256: policy }, log);
    const files = [row("linux", "linux-x64", acked), row("windows", "win32-x64", acked), row("macos", "darwin-arm64", acked)];
    expect(() => checkRealTurns(files, { ...want, policySha256: policy })).toThrow(/step g1/);
    const withG1 = files.map((file) => ({ ...file, row: { ...file.row, steps: { ...file.row.steps, g1: { pass: true, sessionId: "s1" } } } }));
    expect(checkRealTurns(withG1, { ...want, policySha256: policy })).toHaveLength(3);
    const unacked = row("linux", "linux-x64", realLog());
    expect(() => checkRealTurns([{ ...unacked, row: { ...unacked.row, steps: withG1[0].row.steps } }, ...withG1.slice(1)], { ...want, policySha256: policy })).toThrow(/no ack of this policy/);
    expect(() => checkRealTurns([realFile("linux", "linux-x64", {}, acked), ...realFiles().slice(1)], want)).toThrow(/acks a policy/);
  });

  it("reads each row beside the log it names, and never leaves the folder for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-bump-")); dirs.push(dir);
    for (const { name, row, rpcLog } of realFiles()) { writeFileSync(join(dir, name), JSON.stringify(row)); writeFileSync(join(dir, row.rpcLog), rpcLog); }
    expect(checkRealTurns(readRealTurns(dir), want)).toHaveLength(3);
    writeFileSync(join(dir, "linux.json"), JSON.stringify({ ...realFiles()[0].row, rpcLog: "../linux.rpc.jsonl" }));
    expect(() => checkRealTurns(readRealTurns(dir), want)).toThrow(/raw ACP log missing/);
  });

  it("a receipt that owes real turns cannot merge", () => {
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: "owed" })).toThrow(/owed/);
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: [{ os: "linux" }, { os: "linux" }, { os: "linux" }] })).toThrow(/owed/);
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: checkRealTurns(realFiles(), want) })).not.toThrow();
  });
});

describe("commitFiles", () => {
  const box = () => { const dir = mkdtempSync(join(tmpdir(), "murage-bump-")); dirs.push(dir); return dir; };

  it("writes every file and removes the old proof", () => {
    const dir = box();
    writeFileSync(join(dir, "old"), "old");
    commitFiles([[join(dir, "deep", "a"), "A"], [join(dir, "b"), "B"]], [join(dir, "old")]);
    expect(readFileSync(join(dir, "deep", "a"), "utf8")).toBe("A");
    expect(readFileSync(join(dir, "b"), "utf8")).toBe("B");
    expect(existsSync(join(dir, "old"))).toBe(false);
  });

  it("a failure part way leaves every file as it was", () => {
    const dir = box();
    writeFileSync(join(dir, "kept"), "before");
    writeFileSync(join(dir, "file"), "a file, so nothing can be written under it");
    expect(() => commitFiles([[join(dir, "kept"), "after"], [join(dir, "new"), "new"], [join(dir, "file", "x"), "X"]])).toThrow();
    expect(readFileSync(join(dir, "kept"), "utf8")).toBe("before");
    expect(existsSync(join(dir, "new"))).toBe(false);
    expect(existsSync(join(dir, "kept.bump-tmp"))).toBe(false);
  });

  it("a rename that fails after others landed puts them back", () => {
    const dir = box();
    writeFileSync(join(dir, "kept"), "before");
    // A folder with content cannot be replaced by a file.
    const taken = mkdtempSync(join(dir, "folder-"));
    writeFileSync(join(taken, "inside"), "x");
    expect(() => commitFiles([[join(dir, "kept"), "after"], [taken, "file over folder"]])).toThrow();
    expect(readFileSync(join(dir, "kept"), "utf8")).toBe("before");
    expect(readFileSync(join(taken, "inside"), "utf8")).toBe("x");
  });
});
