import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { fixtureRuns, toFiles, WANT } from "./fuigo-bump-fixture.mjs";
import { checkRealTurns, commitFiles, hunksOf, callExpressions, machineHeader, mergeCheck, movePin, parseArgs, parseHashNote, parseReviewed, protocolChanges, readRealTurns, REAL_TURN_OSES, REAL_TURN_STEPS, WINDOWS_STEPS } from "./fuigo-bump.mjs";

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

  it("a protocol file passes only when every hunk is reviewed against a named ruling (FUIGO-1038-TRUST-ADDITIVE)", () => {
    const diff = "diff\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n";
    const [first, second] = hunksOf(diff);
    const ruled = parseReviewed(`${first.sha1} p.rs FUIGO-1038-TRUST-ADDITIVE\n${second.sha1} p.rs FUIGO-1038-TRUST-ADDITIVE\n`);
    expect(protocolChanges({ "p.rs": diff, "q.rs": "", "r.rs": "\n" }, ruled)).toEqual([]);
    // A plain reviewed line (no ruling) does not open a protocol file, nor does one hunk short.
    expect(protocolChanges({ "p.rs": diff }, parseReviewed(`${first.sha1} p.rs\n${second.sha1} p.rs\n`))).toEqual(["p.rs"]);
    expect(protocolChanges({ "p.rs": diff }, parseReviewed(`${first.sha1} p.rs FUIGO-1038-TRUST-ADDITIVE\n`))).toEqual(["p.rs"]);
    // A ruling for the same hunk text in another file does not carry over, and rulings for both files can sit together.
    expect(protocolChanges({ "q.rs": diff }, ruled)).toEqual(["q.rs"]);
    const both = parseReviewed([first, second].flatMap((hunk) => ["p.rs", "q.rs"].map((path) => `${hunk.sha1} ${path} FUIGO-1038-TRUST-ADDITIVE`)).join("\n"));
    expect(protocolChanges({ "p.rs": diff, "q.rs": diff }, both)).toEqual([]);
    // Any edit to a ruled hunk is a new hunk; a change with no hunk at all (binary, mode, rename) still stops.
    expect(protocolChanges({ "p.rs": diff.replace("+d", "+D") }, ruled)).toEqual(["p.rs"]);
    expect(protocolChanges({ "p.rs": "diff --git a/p.rs b/p.rs\nBinary files differ\n" }, ruled)).toEqual(["p.rs"]);
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
const clone = (value) => structuredClone(value);
const P = (runs, name, os = "linux") => runs[os].map[name];
const recordsOf = (run, file) => run.rpc.get(file);
const where = (records, test) => records.findIndex((record) => test(record.msg ?? {}));
const isPromptReply = (msg) => msg.id === 6 && msg.method === undefined;
const fails = (runs, message) => expect(() => checkRealTurns(toFiles(runs), WANT)).toThrow(message);
const changedRow = (runs, os, change) => { const files = toFiles(runs); change(files.find((file) => file.row.os === os)); return files; };

describe("real-turn evidence, schema 2", () => {
  it("takes three whole runs built on the masked cap4 and returns what the receipt keeps", () => {
    const receipts = checkRealTurns(toFiles(fixtureRuns()), WANT);
    expect(receipts.map((row) => row.os).sort()).toEqual(Object.keys(REAL_TURN_OSES).sort());
    for (const receipt of receipts) {
      expect(receipt.invocationsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.nonce).toMatch(/^[0-9a-f]{16}$/);
      expect(receipt.transcripts).toBeGreaterThan(13);
      expect(receipt.steps).toBeGreaterThanOrEqual(REAL_TURN_STEPS.length);
    }
    expect(receipts.find((row) => row.os === "windows").steps).toBe(REAL_TURN_STEPS.length + WINDOWS_STEPS.length);
    expect(receipts.find((row) => row.os === "linux").steps).toBe(REAL_TURN_STEPS.length + 1);
  });

  it("refuses bare rows and wrong names", () => {
    const bare = ["linux", "windows", "macos"].map((os) => ({ name: `${os}.json`, row: { fuigoVersion: "1.0.37", pass: true } }));
    expect(() => checkRealTurns(bare, WANT)).toThrow(/schema is not 2/);
    const named = [1, 2, 3].map((n) => ({ name: `row${n}.json`, row: { fuigoVersion: "1.0.37", pass: true } }));
    expect(() => checkRealTurns(named, WANT)).toThrow(/need exactly/);
    expect(() => checkRealTurns(toFiles(fixtureRuns()).slice(1), WANT)).toThrow(/need exactly/);
  });

  it("names every way a copied log gives itself away", () => {
    const files = toFiles(fixtureRuns());
    const linux = files.find((file) => file.row.os === "linux");
    const windows = files.find((file) => file.row.os === "windows");
    const copy = { ...windows, folder: linux.folder, row: { ...windows.row, files: linux.row.files, sha256: linux.row.sha256, steps: linux.row.steps, modelFailures: linux.row.modelFailures } };
    const check = () => checkRealTurns(files.map((file) => (file === windows ? copy : file)), WANT);
    expect(check).toThrow(/nonce is not in the session cwd/);
    expect(check).toThrow(/goos is linux/);
    expect(check).toThrow(/cwd is not a windows path/);
    expect(check).toThrow(/same bytes as linux/);
    expect(check).toThrow(/driver\.json nonce differs/);
  });

  it.each([
    ["another version", (row) => { row.fuigoVersion = "1.0.36"; }, /fuigoVersion is 1\.0\.36/],
    ["another tag commit", (row) => { row.peeledTag = "9".repeat(40); }, /tag commit/],
    ["another Murage sha", (row) => { row.murageSha = "9".repeat(40); }, /Murage sha/],
    ["a binary that is not the pin", (row) => { row.binarySha256 = "9".repeat(64); }, /pinned asset/],
    ["another OS's asset", (row) => { row.target = "win32-x64"; }, /not a linux asset/],
    ["a policy no one gave", (row) => { row.policySha256 = "d".repeat(64); }, /policy sha/],
    ["a step left out", (row) => { delete row.steps["card-skip"]; }, /step card-skip: names no process/],
    ["a step that names no real file", (row) => { row.steps.g3 = { processes: ["rpc-none.jsonl"] }; }, /step g3: rpc-none\.jsonl is not an ACP file/],
    ["a file left out of the list", (row) => { row.files.other.pop(); }, /unlisted file/],
    ["a sha that does not match", (row) => { row.sha256[row.files.driver] = "9".repeat(64); }, /driver\.json does not match/],
  ])("refuses %s", (_label, change, message) => {
    const files = changedRow(fixtureRuns(), "linux", (file) => change(file.row));
    expect(() => checkRealTurns(files, WANT)).toThrow(message);
  });

  it("g7 is needed on one OS only", () => {
    const runs = fixtureRuns();
    delete runs.linux.steps.g7;
    fails(runs, /step g7 has no proof on any OS/);
  });

  it("no Windows PATH row, no Windows pass", () => {
    const runs = fixtureRuns();
    delete runs.windows.steps["windows-path-trailing-semicolon"];
    fails(runs, /windows\.json: step windows-path-trailing-semicolon/);
  });

  // The negatives of the design's Fixture test section, one each.
  it.each([
    ["a dropped response line", (runs) => { const records = recordsOf(runs.linux, P(runs, "P4")); records.splice(where(records, isPromptReply), 1); }, /unanswered request session\/prompt/],
    ["tail:true on a last line", (runs) => { recordsOf(runs.linux, P(runs, "P4")).at(-1).tail = true; }, /truncated/],
    ["stopReason cancelled", (runs) => { const records = recordsOf(runs.linux, P(runs, "P4")); records[where(records, isPromptReply)].msg.result.stopReason = "cancelled"; }, /a prompt ends cancelled/],
    ["a trust reply without scope", (runs) => { const records = recordsOf(runs.linux, P(runs, "P4")); delete records[where(records, (msg) => msg.result?.outcome === "trust")].msg.result.scope; }, /step card-trust: reply deep-equal/],
    ["allow-once replaced on g5-full", (runs) => { const records = recordsOf(runs.linux, runs.linux.steps["g5-full"][0]); records[where(records, (msg) => msg.result?.outcome?.optionId === "allow-once")].msg.result.outcome.optionId = "reject-once"; }, /step g5-full: allow-once reply/],
    ["load-undecided pointed at P2", (runs) => { runs.linux.steps["load-undecided"] = [P(runs, "P2")]; }, /step load-undecided: one folder trust request/],
    ["a raw line in an ACP file", (runs) => { recordsOf(runs.linux, P(runs, "P4")).push({ t: "2026-11-01T01:15:30.000Z", dir: "out", raw: "panic" }); }, /a raw line in an ACP file/],
    ["argv with --trust", (runs) => { runs.linux.invocations.find((item) => `rpc-${item.t}-${item.pid}.jsonl` === P(runs, "P4")).argv.splice(2, 0, "--trust"); }, /launch is not generation 2/],
    ["store readAt after P2's t on h", (runs) => { for (const read of runs.linux.driver.stores) if (read.key.includes("/ask-trust-")) read.readAt = "2026-11-01T01:16:00.000Z"; }, /step h: two store reads/],
    ["uname -s output without MINGW", (runs) => { const records = recordsOf(runs.windows, runs.windows.steps["windows-git-bash"][0]); records[where(records, (msg) => msg.params?.update?.status === "completed")].msg.params.update.content[0].content.text = "Linux\n"; }, /step windows-git-bash: output holds MINGW/],
    ["a runaway with a second unanswered request", (runs) => { const records = recordsOf(runs.linux, P(runs, "P13")); records.splice(40, 0, { t: records[40].t, dir: "out", msg: { jsonrpc: "2.0", id: 9, method: "session/request_permission", params: {} } }); }, /unanswered request session\/request_permission/],
    ["a runaway with an error on another RPC", (runs) => { const records = recordsOf(runs.linux, P(runs, "P12")); const at = where(records, (msg) => msg.id === 4 && msg.method === undefined); records[at].msg = { jsonrpc: "2.0", id: 4, error: { code: -1, message: "x" } }; }, /an error response to _fuigo\/mcp\/list/],
    ["a level step pointed at an Ask file", (runs) => { runs.linux.steps["level-full"] = [P(runs, "P4"), P(runs, "P5")]; }, /step level-full: .* is level ask/],
    ["a processes setting that disagrees", (runs) => { runs.linux.driver.processes[P(runs, "P10")].setting.level = "ask"; }, /setting .* disagrees with level auto/],
    ["a runaway named by a step", (runs) => { runs.linux.steps["level-no-limits"] = [P(runs, "P13"), runs.linux.steps["level-no-limits"][1]]; }, /step level-no-limits: names model failure/],
    ["a modelFailures entry whose file ends end_turn", (runs) => { runs.linux.modelFailures.push({ file: P(runs, "P11"), reason: "max_tokens_truncation" }); }, /max_tokens_truncation needs one failed prompt/],
    ["an open-at-close entry with message text", (runs) => { const records = recordsOf(runs.linux, P(runs, "P13")); const last = clone(records.at(-1)); last.msg.params.update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }; records.push(last); }, /open-at-close has message text/],
    ["an unlisted runaway", (runs) => { runs.linux.modelFailures = runs.linux.modelFailures.filter((entry) => entry.reason !== "open-at-close"); }, /unanswered request session\/prompt/],
    ["an open-at-close run with no app close", (runs) => { runs.linux.driver.endedAt = "2026-11-01T01:00:00.000Z"; }, /open-at-close needs the app closed/],
    ["an open-at-close under the threshold", (runs) => { const records = recordsOf(runs.linux, P(runs, "P13")); records.splice(records.length - 2, 2); }, /more than 1000 thought chunks/],
    ["a fatal in driver.json", (runs) => { runs.linux.driver.fatal = "timeout"; }, /no endedAt or has a fatal/],
    ["a killed app, nothing closed", (runs) => { delete runs.linux.driver.endedAt; }, /no endedAt or has a fatal/],
    ["a fuigo copy on PATH", (runs) => { runs.linux.driver.pathCopies = ["/usr/bin/fuigo"]; }, /a fuigo copy is on PATH/],
    ["a source that is not bundled", (runs) => { runs.linux.driver.fuigo.source = "path"; }, /source is not bundled/],
    ["a binary changed during the run", (runs) => { runs.linux.driver.binary.shaEnd = "9".repeat(64); }, /binary shas are not the pinned asset/],
    ["another package version", (runs) => { runs.linux.driver.version = "1.0.9"; }, /driver version is 1\.0\.9/],
    ["a terminal call in a log", (runs) => { recordsOf(runs.linux, P(runs, "P4")).splice(30, 0, { t: "2026-11-01T01:15:10.000Z", dir: "out", msg: { jsonrpc: "2.0", method: "terminal/create", params: {} } }); }, /log has a terminal call/],
    ["a terminal offered", (runs) => { const records = recordsOf(runs.linux, P(runs, "P4")); records[0].msg.params.clientCapabilities.terminal = true; }, /client offered a terminal/],
    ["a Murage file mapped as a direct client", (runs) => { Object.assign(runs.linux.driver.processes[P(runs, "P4")], { level: "direct", thread: null, setting: null }); }, /a Murage process is mapped as a direct client/],
    ["a level that does not exist", (runs) => { Object.assign(runs.linux.driver.processes[P(runs, "P4")], { level: "free", setting: { status: 200, level: "free" } }); }, /level free is not a permission level/],
    ["a mixed process from another thread", (runs) => { runs.linux.driver.processes[P(runs, "P4")].thread = "thread-other"; }, /processes thread is not the session's thread/],
    ["a rpc file with no invocation", (runs) => { runs.linux.invocations.pop(); }, /has no invocation/],
    ["a load row not on noReplay", (runs) => { const records = recordsOf(runs.linux, P(runs, "P5")); delete records[where(records, (msg) => msg.method === "session/load")].msg.params._meta; }, /step load-consent2: session\/load with noReplay/],
    ["a Murage file on a Phase A step", (runs) => { runs.linux.steps.a = [P(runs, "P4")]; }, /step a: .* is the wrong client/],
    ["a command that ran after Don't trust on g3", (runs) => { const records = recordsOf(runs.linux, P(runs, "P6")); const perm = records[where(records, (msg) => msg.method === "session/request_permission")]; const toolCallId = perm.msg.params.toolCall.toolCallId; records.push({ t: records.at(-1).t, dir: "out", msg: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [] } } } }); }, /step g3: the command did not run/],
    ["a request on f's stored no", (runs) => { const records = recordsOf(runs.linux, runs.linux.steps.f[2]); const at = where(records, (msg) => msg.method === "session/prompt"); const { sessionId } = records[at].msg.params; records.splice(at, 0, { t: records[at].t, dir: "out", msg: { jsonrpc: "2.0", id: 0, method: "_fuigo/folder_trust/request", params: { sessionId, reason: "new" } } }, { t: records[at].t, dir: "in", msg: { jsonrpc: "2.0", id: 0, result: { outcome: "reject" } } }); }, /step f: zero folder trust requests/],
    ["f's stored no read from a store the process did not use", (runs) => { runs.linux.driver.stores.find((read) => read.trusted === false && read.key.endsWith("/declined")).path = `${runs.linux.invocations[0].home}x/.fuigo/trusted_folders.toml`; }, /step f: subfolder has a stored no/],
    ["f's parent trusted only after the spawn", (runs) => { const { parent } = runs.linux.driver.layout.f; runs.linux.driver.stores.find((read) => read.key === parent).readAt = "2026-12-01T00:00:00.000Z"; }, /step f: parent trusted in the store before the spawn/],
    ["a backslash path standing in for a linux store", (runs) => { const read = runs.linux.driver.stores.find((item) => item.trusted === false && item.key.endsWith("/declined")); read.path = read.path.replace("/.fuigo/", "\\.fuigo/"); }, /step f: subfolder has a stored no/],
    ["f with no stored no on the subfolder", (runs) => { const stores = runs.linux.driver.stores; stores.splice(stores.findIndex((read) => read.trusted === false && read.key.endsWith("/declined")), 1); }, /step f: subfolder has a stored no/],
    ["a store that kept the skipped key", (runs) => { const read = runs.linux.driver.stores.find((item) => item.key.includes("/ask-skip-")); read.lines = ["x"]; }, /step card-skip: store has no line/],
    ["a skip that changed Murage's record", (runs) => { runs.linux.driver.rows.find((row) => row.row === "ask-skip").trustGet.record.consent = 2; }, /step card-skip: Murage record unchanged/],
    ["a t3 with no marker on g4", (runs) => { for (const record of recordsOf(runs.linux, P(runs, "P3"))) if (record.msg?.params?.update?.sessionUpdate === "agent_message_chunk") record.msg.params.update.content.text = "x"; }, /step g4: agent text holds the marker/],
  ])("refuses %s", (_label, change, message) => {
    const runs = fixtureRuns();
    change(runs);
    fails(runs, message);
  });

  it("a runaway is no step proof and does not void the run", () => {
    const runs = fixtureRuns();
    expect(runs.linux.modelFailures.map((entry) => entry.reason)).toEqual(["max_tokens_truncation", "open-at-close"]);
    const thoughts = recordsOf(runs.linux, P(runs, "P13")).filter((record) => record.msg?.params?.update?.sessionUpdate === "agent_thought_chunk");
    expect(thoughts.length).toBeGreaterThan(1000);
    expect(() => checkRealTurns(toFiles(runs), WANT)).not.toThrow();
  });

  it("with a policy needs its sha in every row, an ack in the logs and step g1", () => {
    const policy = hex("e");
    const runs = fixtureRuns();
    const withPolicy = { ...WANT, policySha256: policy };
    const stamp = (run) => { for (const records of run.rpc.values()) for (const record of records) if (record.msg?.id === 3 && record.msg.method === undefined) record.msg.result._meta = { "fuigo/permissionPolicy": { sha256: policy } }; };
    const policied = () => toFiles(runs).map((file) => ({ ...file, row: { ...file.row, policySha256: policy } }));
    expect(() => checkRealTurns(policied(), withPolicy)).toThrow(/no ack of this policy/);
    for (const run of Object.values(runs)) stamp(run);
    expect(() => checkRealTurns(policied(), withPolicy)).toThrow(/step g1/);
    for (const run of Object.values(runs)) run.steps.g1 = [run.map.P4];
    expect(checkRealTurns(policied(), withPolicy)).toHaveLength(3);
    expect(() => checkRealTurns(toFiles(runs), WANT)).toThrow(/acks a policy/);
  });

  it("reads each row with its folder, and an extra file or a folder inside it is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-bump-")); dirs.push(dir);
    for (const { name, row, folder } of toFiles(fixtureRuns())) {
      writeFileSync(join(dir, name), JSON.stringify(row));
      const osDir = join(dir, name.replace(/\.json$/, ""));
      mkdirSync(osDir);
      for (const [file, bytes] of folder) writeFileSync(join(osDir, file), bytes);
    }
    expect(checkRealTurns(readRealTurns(dir), WANT)).toHaveLength(3);
    writeFileSync(join(dir, "linux", "extra.txt"), "x");
    expect(() => checkRealTurns(readRealTurns(dir), WANT)).toThrow(/unlisted file extra\.txt/);
  });

  it("a receipt that owes real turns cannot merge", () => {
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: "owed" })).toThrow(/owed/);
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: [{ os: "linux" }, { os: "linux" }, { os: "linux" }] })).toThrow(/owed/);
    expect(() => mergeCheck({ fuigoVersion: "1.0.37", real_turns: checkRealTurns(toFiles(fixtureRuns()), WANT) })).not.toThrow();
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
