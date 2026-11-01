// Test support for scripts/fuigo-bump.test.mjs. fuigo-bump-cap4.fixture.jsonl is cap4 masked by an allowlist: P1 to P13 kept as
// real shapes, thought chunks of the two runaways cut to 1001, identical neighbours held as a count. Everything cap4 has no
// transcript for (Phase A, auto-reject, full, nolimits, full-plain, g6, g7, Windows) is built here from the same shapes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const clone = (value) => structuredClone(value);
export const ASSETS = { "linux-x64": "a".repeat(64), "win32-x64": "b".repeat(64), "darwin-arm64": "c".repeat(64) };
export const WANT = { version: "1.0.37", peeledTag: "1".repeat(40), murageSha: "2".repeat(40), packageVersion: "1.0.10", policySha256: null,
  assets: Object.fromEntries(Object.entries(ASSETS).map(([target, binarySha256]) => [target, { tarballSha256: "0".repeat(64), binarySha256 }])) };
const ROOT = "/home/gate/run";
const SELF = `${ROOT}/app/resources/fuigo/fuigo`;
const STORE = `${ROOT}/home/.fuigo/trusted_folders.toml`;
const ARGV = ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "-m", "flux-auto", "stdio"];
const CAPS = { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {}, url: {} }, _meta: { "fuigo/folderTrust": { interactive: true, v2: true } } };

const loadCap4 = () => {
  const [head, ...lines] = readFileSync(join(HERE, "fuigo-bump-cap4.fixture.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const rpc = new Map();
  for (const line of lines) {
    const records = rpc.get(line.f) ?? [];
    rpc.set(line.f, records);
    for (let i = 0; i < (line.n ?? 1); i++) records.push(line.m ? { t: line.t, dir: line.d, msg: clone(line.m) } : { t: line.t, dir: line.d, raw: line.r });
  }
  return { nonce: head.nonce, map: head.map, invocations: head.invocations, driver: head.driver, rpc };
};

const iso = (ms) => new Date(ms).toISOString();
const stampOf = (ms) => iso(ms).replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, ".$1000000Z");
const stampMs = (stamp) => Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)\.(\d{3})\d*Z$/, "$1-$2-$3T$4:$5:$6.$7Z"));

/** One synthetic ACP process, in the order cap4 shows, appended to the run. */
const addProcess = (run, spec) => {
  const { row, turn = "t1", level, cwd, thread = `thread-${row}`, sessionId = `session-${row}`, lifecycle = "new", request, prompt = "cat", perm, ran, mark, fuigoHome = "", failed } = spec;
  const start = run.now += 10000, pid = run.pid += 1;
  const file = `rpc-${stampOf(start)}-${pid}.jsonl`;
  run.invocations.push({ t: stampOf(start), pid, argv: spec.argv ?? ARGV, cwd, fuigoHome, goos: "linux", home: `${ROOT}/home`, path: "/usr/bin:/bin", self: SELF });
  const records = [];
  let at = start;
  const push = (dir, msg) => records.push({ t: iso(at += 100), dir, msg: { jsonrpc: "2.0", ...msg } });
  const session = { cwd, mcpServers: level === "direct" ? [] : [{ env: [{ name: "MURAGE_THREAD_ID", value: thread }] }] };
  push("in", { id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: CAPS } });
  push("out", { id: 1, result: {} });
  push("in", { id: 2, method: "authenticate", params: { methodId: "fuigo.api_key" } });
  push("out", { id: 2, result: {} });
  if (lifecycle === "load") push("in", { id: 3, method: "session/load", params: { ...session, sessionId, _meta: { noReplay: true } } });
  else push("in", { id: 3, method: "session/new", params: session });
  push("out", { id: 3, result: lifecycle === "load" ? {} : { sessionId } });
  if (request) {
    push("out", { id: 0, method: "_fuigo/folder_trust/request", params: { sessionId, cwd, workspace: request.workspace ?? cwd, configKinds: ["instructions"], scope: "configAndCommands", reason: request.reason ?? "new" } });
    push("in", { id: 0, result: request.reply });
  }
  if (lifecycle === "new-load") {
    push("in", { id: 4, method: "session/load", params: { ...session, sessionId, _meta: { noReplay: true } } });
    push("out", { id: 4, result: {} });
  }
  const command = { cat: "cat note.txt", ls: "ls", uname: "uname -s", marker: "marker" }[prompt];
  const promptId = `prompt-${pid}`, toolCallId = `tool-${pid}`;
  const tag = { sessionId, _meta: { promptId } };
  const update = (body) => push("out", { method: "session/update", params: { ...tag, update: body } });
  const promptRequest = { id: 6, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: `Nonce ${run.nonce}. Run the shell command \`${command}\` exactly once.` }] } };
  push("in", promptRequest);
  update({ sessionUpdate: "tool_call", toolCallId, rawInput: { command } });
  if (perm) {
    push("out", { id: 1, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId, kind: "execute", rawInput: { command } }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] } });
    push("in", { id: 1, result: { outcome: { outcome: "selected", optionId: perm } } });
  }
  if (ran) {
    const text = ran === true ? (prompt === "ls" ? "AGENTS.md\nnote.txt\n" : `note ${run.nonce}\n`) : ran;
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text } }], rawOutput: { command } });
  } else if (perm) update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
  if (failed) throw new Error("runaways come from cap4");
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: mark ? `MARK-${run.nonce}` : "x" } });
  push("out", { method: "_fuigo/session/prompt_complete", params: { sessionId, promptId, stopReason: "end_turn" } });
  push("out", { id: 6, result: { stopReason: "end_turn", _meta: { promptId } } });
  run.rpc.set(file, records);
  run.driver.processes[file] = { row, turn, thread: level === "direct" ? null : thread, level, setting: level === "direct" ? null : { status: 200, level } };
  run.now = at + 1000;
  return file;
};

const storeRead = (run, key, at, facts) => run.driver.stores.push({ path: facts.path ?? STORE, key, sha256: facts.sha256 ?? sha256(`${key}${facts.trusted}`), lines: facts.lines ?? [], readAt: iso(at), ...(facts.trusted === undefined ? {} : { trusted: facts.trusted }), ...(facts.consent === undefined ? {} : { consent: facts.consent }) });
const lastT = (run, file) => Date.parse(run.rpc.get(file).at(-1).t.replace(/(\.\d{3})\d+/, "$1"));
const header = (key) => [`[folders."${key}"]`];
const driverRow = (run, row, level, cwd, t1, t2) => run.driver.rows.push({ row, level, cwd, t1: { cards: t1 }, ...(t2 ? { t2: { cards: t2 } } : {}) });
const TRUST = { outcome: "trust", scope: "configAndCommands" };
const REJECT = { outcome: "reject" };
const trustCard = (chosen) => ({ trust: true, status: 200, behavior: "answer", chosen });

/** cap4 plus every synthetic row. Linux shapes; `moveTo` makes the other OSes. */
const baseRun = () => {
  const cap4 = loadCap4();
  const { map: P, nonce } = cap4;
  const lastStamp = cap4.invocations.at(-1).t;
  const run = { os: "linux", target: "linux-x64", nonce, ...cap4, modelFailures: [{ file: P.P12, reason: "max_tokens_truncation" }, { file: P.P13, reason: "open-at-close" }], now: stampMs(lastStamp) + 3600000, pid: 3000000, steps: {}, map: P };
  const { driver } = run;
  Object.assign(driver, { stores: [], forget: [], pathCopies: [], binary: { path: `${SELF}-real`, shaStart: ASSETS["linux-x64"], shaEnd: ASSETS["linux-x64"] }, layout: {} });
  const work = (name) => `${ROOT}/work/${name}-${nonce}`;
  const askKey = work("ask-trust");
  storeRead(run, askKey, lastT(run, P.P4) + 100, { lines: header(askKey), trusted: true, consent: 2 });
  storeRead(run, askKey, lastT(run, P.P4) + 200, { lines: header(askKey), trusted: true, consent: 2 });
  for (const [name, file] of [["ask-reject", P.P6], ["ask-skip", P.P8]]) storeRead(run, work(name), lastT(run, file) + 1000, { sha256: "e".repeat(64) });

  // Phase A, direct client.
  const direct = { row: "phase-a", level: "direct" };
  const phase = (name, spec) => addProcess(run, { ...direct, row: `phase-a-${name}`, sessionId: `session-a-${name}`, cwd: work(`a-${name}`), ...spec });
  const a = phase("a", { request: { reply: TRUST }, prompt: "cat", ran: true });
  storeRead(run, work("a-a"), run.now, { lines: header(work("a-a")), trusted: true, consent: 2 });
  run.now += 1000;
  const e = phase("e", { cwd: work("a-a"), prompt: "cat", ran: true, mark: true });
  const bBefore = run.now + 5000;
  storeRead(run, work("a-b"), bBefore, { sha256: "d".repeat(64) });
  const b = phase("b", { request: { reply: REJECT }, prompt: "ls", perm: "reject-once" });
  storeRead(run, work("a-b"), run.now, { sha256: "d".repeat(64) });
  storeRead(run, work("a-c"), run.now + 5000, { lines: header(work("a-c")), trusted: true, sha256: "c".repeat(64) });
  const c = phase("c", { request: { reason: "upgrade", reply: TRUST }, prompt: "cat", ran: true });
  storeRead(run, work("a-d"), run.now + 5000, { lines: header(work("a-d")), trusted: false, sha256: "b".repeat(64) });
  const d = phase("d", { prompt: "ls", perm: "reject-once" });
  const f = { parent: work("a-f-parent"), submodule: `${work("a-f-parent")}/sub`, main: work("a-f-main"), worktree: work("a-f-wt"), subfolder: `${work("a-f-parent")}/declined` };
  const f1 = phase("f1", { cwd: f.submodule, request: { workspace: f.parent, reply: TRUST }, prompt: "cat", ran: true });
  const f2w = phase("f2w", { cwd: f.worktree, request: { workspace: f.main, reply: TRUST }, prompt: "cat", ran: true });
  storeRead(run, f.parent, run.now, { lines: header(f.parent), trusted: true, consent: 2 });
  storeRead(run, f.subfolder, run.now, { lines: header(f.subfolder), trusted: false });
  const f3 = phase("f3r", { cwd: f.subfolder, prompt: "ls", perm: "reject-once" });
  const f2Layout = { cwd: `${work("a-f2-wt")}/sub`, main: work("a-f2-main") };
  const f2 = phase("f2", { cwd: f2Layout.cwd, request: { workspace: f2Layout.main, reply: REJECT }, prompt: "ls", perm: "reject-once" });
  const f3Layout = { cwd: work("a-f3"), key: work("a-f3-hidden"), storeExisted: false };
  const hidden = phase("f3", { cwd: f3Layout.cwd, fuigoHome: `${ROOT}/homes/f3`, request: { workspace: f3Layout.key, reply: REJECT }, prompt: "ls", perm: "reject-once" });
  const rejected = phase("load", { lifecycle: "new-load", request: { reply: REJECT }, prompt: "ls", perm: "reject-once" });
  Object.assign(driver.layout, { f, f2: f2Layout, f3: f3Layout });

  // Murage rows cap4 has no transcript for.
  const pairRow = (name, level) => {
    const cwd = work(name);
    const t1 = addProcess(run, { row: name, level, cwd, request: { reply: TRUST }, prompt: "cat", ran: true });
    const t2 = addProcess(run, { row: name, turn: "t2", level, cwd, lifecycle: "load", prompt: "ls", ran: true });
    driverRow(run, name, level, cwd, [trustCard("Trust this folder")], []);
    return [t1, t2];
  };
  const fullPair = pairRow("full-2", "full");
  const nolimitsPair = pairRow("nolimits-2", "nolimits");
  const plainCwd = work("full-plain");
  const plain = [
    addProcess(run, { row: "full-plain", level: "full", cwd: plainCwd, request: { reply: REJECT }, prompt: "cat", perm: "allow-once", ran: true }),
    addProcess(run, { row: "full-plain", turn: "t2", level: "full", cwd: plainCwd, lifecycle: "load", request: { reply: REJECT }, prompt: "ls", perm: "allow-once", ran: true }),
  ];
  driverRow(run, "full-plain", "full", plainCwd, [], []);
  const autoReject = addProcess(run, { row: "auto-reject", level: "auto", cwd: work("auto-reject"), request: { reply: REJECT }, prompt: "cat", perm: "allow-once", ran: true });
  driverRow(run, "auto-reject", "auto", work("auto-reject"), [trustCard("Don't trust")]);
  const g6Cwd = work("g6"), homeA = `${ROOT}/homes/g6a`, homeB = `${ROOT}/homes/g6b`;
  const g6a = addProcess(run, { row: "g6", level: "ask", cwd: g6Cwd, fuigoHome: homeA, request: { reply: TRUST }, prompt: "cat", ran: true });
  const g6b = addProcess(run, { row: "g6", turn: "t2", level: "ask", cwd: g6Cwd, fuigoHome: homeA, lifecycle: "load", prompt: "ls", ran: true });
  driver.forget.push({ key: g6Cwd, status: 200, recordsBefore: 1, recordsAfter: 0, forgetAt: iso(run.now) });
  const g6n = addProcess(run, { row: "g6", turn: "t3", level: "ask", cwd: g6Cwd, sessionId: "session-g6n", fuigoHome: homeB, request: { reply: TRUST }, prompt: "cat", ran: true });
  driver.rows.push({ row: "g6", level: "ask", cwd: g6Cwd, t1: { cards: [trustCard("Trust this folder")] }, t2: { cards: [] }, t3: { cards: [trustCard("Trust this folder")] } });

  Object.assign(run.steps, { a: [a], b: [b], c: [c], d: [d], e: [e], f: [f1, f2w, f3], f2: [f2], f3: [hidden],
    "load-undecided": [P.P7], "load-consent2": [P.P5, P.P11], "load-rejected": [rejected], g2: [P.P4], g3: [P.P6], g4: [P.P1, P.P3],
    "g5-auto": [P.P10, autoReject], "g5-full": plain, g6: [g6a, g6b, g6n], h: [P.P4, P.P5], "card-trust": [P.P4], "card-reject": [P.P6, P.P7], "card-skip": [P.P8, P.P9],
    "level-ask": [P.P4, P.P5, P.P6, P.P7, P.P8, P.P9], "level-auto": [P.P10, P.P11], "level-full": fullPair, "level-no-limits": nolimitsPair });
  run.driver.nonce = nonce;
  return run;
};

const addG7 = (run) => {
  const cwd = `${ROOT}/work/g7-${run.nonce}`;
  const first = addProcess(run, { row: "g7", level: "ask", cwd, request: { reply: REJECT }, prompt: "ls", perm: "reject-once" });
  run.driver.forget.push({ key: cwd, status: 200, recordsBefore: 1, recordsAfter: 0, forgetAt: iso(run.now) });
  const second = addProcess(run, { row: "g7", turn: "t2", level: "ask", cwd, sessionId: "session-g7b", request: { reply: REJECT }, prompt: "ls", perm: "reject-once" });
  run.driver.rows.push({ row: "g7", level: "ask", cwd, t1: { cards: [trustCard("Don't trust")] }, t2: { cards: [trustCard("Don't trust")] } });
  run.driver.env = { MURAGE_ACP_POOL: "1" };
  run.steps.g7 = [first, second];
};

const deepMap = (value, change) => {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => deepMap(item, change));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [change(key), deepMap(item, change)]));
  return value;
};

/** The same run as another OS: nonce, day, path form, goos and binary all move; nothing is left shared. */
const moveTo = (source, os) => {
  const windows = os === "windows";
  const nonce = windows ? "b2c3d4e5f6071829" : "c3d4e5f607182930";
  const day = windows ? "02" : "03";
  const root = windows ? "C:\\run" : "/Users/runner/run";
  const self = windows ? "C:\\run\\app\\resources\\fuigo\\fuigo.exe" : "/Applications/Murage.app/Contents/Resources/fuigo/fuigo";
  const real = windows ? "C:\\run\\app\\resources\\fuigo\\fuigo-real.exe" : `${self}-real`;
  const target = windows ? "win32-x64" : "darwin-arm64";
  const change = (text) => {
    let next = text.replaceAll(source.nonce, nonce).replaceAll("2026-11-01T", `2026-11-${day}T`).replaceAll("20261101T", `202611${day}T`);
    next = next.replaceAll(`${SELF}-real`, real).replaceAll(SELF, self);
    if (next.startsWith(ROOT)) next = windows ? `${root}${next.slice(ROOT.length).replaceAll("/", "\\")}` : `${root}${next.slice(ROOT.length)}`;
    return next;
  };
  const run = { ...deepMap({ ...source, rpc: null }, change), os, target, nonce, rpc: new Map([...source.rpc].map(([file, records]) => [change(file), deepMap(records, change)])) };
  // The engine streams the marker in pieces, so the moved nonce goes in whole.
  for (const records of run.rpc.values()) {
    const chunks = records.filter((record) => record.msg?.params?.update?.sessionUpdate === "agent_message_chunk");
    const text = chunks.map((record) => record.msg.params.update.content.text).join("");
    if (!text.includes(`MARK-${source.nonce}`)) continue;
    for (const record of chunks) record.msg.params.update.content.text = "";
    chunks[0].msg.params.update.content.text = `MARK-${nonce}`;
  }
  const goos = windows ? "windows" : "darwin";
  run.invocations = run.invocations.map((item) => ({ ...item, goos, ...(windows ? { path: "C:\\run\\git\\bin;C:\\Windows\\System32;" } : {}) }));
  run.driver.os = os;
  run.driver.binary = { path: real, shaStart: ASSETS[target], shaEnd: ASSETS[target] };
  return run;
};

const addGitBash = (run) => {
  const before = run.invocations.length;
  const file = addProcess(run, { row: "gitbash", level: "ask", cwd: `C:\\run\\work\\gitbash-${run.nonce}`, prompt: "uname", ran: "MINGW64_NT-10.0\n" });
  const invocation = run.invocations[before];
  Object.assign(invocation, { goos: "windows", home: "C:\\run\\home", path: "C:\\run\\git\\bin;C:\\Windows\\System32;", self: "C:\\run\\app\\resources\\fuigo\\fuigo.exe" });
  run.driver.rows.push({ row: "gitbash", level: "ask", cwd: invocation.cwd, t1: { cards: [] } });
  run.driver.gitDir = "C:\\run\\git";
  run.steps["windows-git-bash"] = [file];
  run.steps["windows-path-trailing-semicolon"] = [run.map.P4, run.map.P5];
};

/** Three whole runs, ready to be changed by a test and then turned into files with toFiles. */
export const fixtureRuns = () => {
  const base = baseRun();
  const windows = moveTo(base, "windows");
  const macos = moveTo(base, "macos");
  addGitBash(windows);
  addG7(base);
  return { linux: base, windows, macos };
};

const lines = (items) => Buffer.from(items.map((item) => JSON.stringify(item)).join("\n") + "\n");
/** A run as a row and its folder, every sha worked out from the bytes. */
export const rowOf = (run) => {
  const folder = new Map();
  folder.set("invocations.jsonl", lines(run.invocations));
  folder.set("driver.json", Buffer.from(JSON.stringify(run.driver)));
  for (const [file, records] of run.rpc) folder.set(file, lines(records.map((record, index) => ({ seq: index + 1, ...record }))));
  const argvOf = (file) => run.invocations.find((item) => file === `rpc-${item.t}-${item.pid}.jsonl`)?.argv ?? [];
  const rpcFiles = [...run.rpc.keys()];
  const transcripts = rpcFiles.filter((file) => argvOf(file).at(-1) === "stdio");
  const other = rpcFiles.filter((file) => !transcripts.includes(file));
  const version = other.filter((file) => argvOf(file).join(" ") === "--version")[0];
  const row = { schema: 2, os: run.os, target: run.target, nonce: run.nonce, fuigoVersion: WANT.version, peeledTag: WANT.peeledTag, murageSha: WANT.murageSha, binarySha256: ASSETS[run.target], policySha256: null,
    modelFailures: run.modelFailures, files: { invocations: "invocations.jsonl", driver: "driver.json", version, transcripts, other: other.filter((file) => file !== version) },
    sha256: Object.fromEntries([...folder].map(([file, bytes]) => [file, sha256(bytes)])), steps: Object.fromEntries(Object.entries(run.steps).map(([id, processes]) => [id, { processes }])) };
  return { name: `${run.os}.json`, row, folder };
};
export const toFiles = (runs) => Object.values(runs).map(rowOf);
