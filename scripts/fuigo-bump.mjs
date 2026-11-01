#!/usr/bin/env node
// Release-gate step that moves the bundled Fuigo pin (FUIGO-TRUST-V2 N8 as amended by N10).
// Runs on a disposable box only: refuses on darwin without MURAGE_GATE_BOX=1. Never runs a Fuigo binary, runs no
// install scripts, and writes nothing in the repo unless every step passes.
//
//   node scripts/fuigo-bump.mjs --version 1.0.37 --fuigo-checkout <path> --evidence <dir> --base <murage sha>
//     --reviewed-hunks <file> [--murage-git <dir>] [--expected-hashes <FUIGO-1037-HASHES.md>] [--policy <file>]
//     (--real-turns <dir with <os>.json and <os>/ per OS> | --real-turns-owed)
//   node scripts/fuigo-bump.mjs --merge-check <bump-x.y.z.json>
//
// --real-turns-owed moves the pin on a branch and records real_turns: "owed". Build step 10 runs --merge-check on the
// bump receipt before the merge: it refuses a receipt that still owes real turns.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TRUST_BASE_TAG = "v1.0.35";
const C = "crates/codegen";
export const MUST_BE_EMPTY = [
  `${C}/fuigo-workspace/src/folder_trust.rs`, `${C}/fuigo-workspace/src/trust.rs`, `${C}/fuigo-workspace/src/folder_trust_grant_tests.rs`,
  `${C}/fuigo-shell/src/agent/mvp_agent/folder_trust_prompt.rs`,
];
// Every changed hunk here needs a sha1 in --reviewed-hunks (Astra M1: no keyword window). The last three carry the
// 1.0.37 move of check_runner_trust into check_spawn_env_with and the client terminal check.
export const EVERY_HUNK_REVIEWED = [
  `${C}/fuigo-shell/src/agent/folder_trust.rs`, `${C}/fuigo-shell/src/agent/mvp_agent/session_setup.rs`,
  `${C}/fuigo-shell/src/session/acp_session_impl/session_setup.rs`, `${C}/fuigo-workspace/src/permission/manager/mod.rs`,
  `${C}/fuigo-tools/src/sandbox_launch.rs`, `${C}/fuigo-shell-terminal/src/adapter.rs`, `${C}/fuigo-workspace/src/permission/exec_risk.rs`,
];
export const TRUST_PROMPT_CALL = "maybe_spawn_interactive_trust_prompt(";

export const sha = (algo, data, encoding = "hex") => createHash(algo).update(data).digest(encoding);
export const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === "real-turns-owed") out[key] = true;
    else out[key] = argv[++i];
  }
  for (const key of ["version", "fuigo-checkout", "evidence", "base", "reviewed-hunks"]) if (!out[key]) throw new Error(`--${key} is required`);
  if (!/^\d+\.\d+\.\d+$/.test(out.version)) throw new Error("--version must be x.y.z");
  if (!out["real-turns"] === !out["real-turns-owed"]) throw new Error("pass exactly one of --real-turns, --real-turns-owed");
  return out;
};

/** The hunks of a unified diff, each with the sha1 of its text from the @@ line on (the index line never counts). */
export const hunksOf = (diff) => diff.split(/^(?=@@ )/m).slice(1).map((text) => ({ text, sha1: sha("sha1", text) }));

/** Each full `name(...)` call expression in `source`, paren-balanced, in order. */
export const callExpressions = (source, opener) => {
  const calls = [];
  for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
    let depth = 0, end = at + opener.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
};

/** Sha-256 values and sha512 integrity in the hash note, by package name. */
export const parseHashNote = (markdown) => {
  const hashes = {};
  for (const line of markdown.split("\n")) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \|$/.exec(line.trim());
    if (!row) continue;
    (hashes[row[1]] ??= {})[row[2].startsWith("sha512-") ? "integrity" : "sha256"] = row[2];
  }
  return hashes;
};

/** prepare-fuigo.mjs with the pin moved: version, provenance comment, every digest. A digest not replaced stops. */
export const movePin = (source, version, gitHead, assets) => {
  const old = /export const FUIGO_VERSION = "([^"]+)"/.exec(source)?.[1];
  if (!old) throw new Error("FUIGO_VERSION not found");
  const oldHead = /report gitHead ([0-9a-f]{40})/.exec(source)?.[1];
  if (!oldHead) throw new Error("gitHead comment not found");
  let next = source.replaceAll(old, version).replaceAll(oldHead, gitHead);
  for (const [target, pin] of Object.entries(assets)) {
    const block = new RegExp(`("${target}": Object\\.freeze\\(\\{[^}]*?tarballSha256: ")[0-9a-f]{64}(",\\s*binarySha256: ")[0-9a-f]{64}"`);
    if (!block.test(next)) throw new Error(`no pin block for ${target}`);
    next = next.replace(block, `$1${pin.tarballSha256}$2${pin.binarySha256}"`);
  }
  return next;
};

// Real-turn evidence, schema 2 (designs/FUIGO-REALTURN-EVIDENCE-1013.md). One row per OS, <os>.json, beside a folder <os>/
// that holds every file the Go tap wrote in the run plus the driver's driver.json. Facts are read from those files, never
// from a claim. It proves a real, whole run on this build at each permission level: it stops a mistaken, partial or mixed
// run, and a run from another build or OS. It does not prove freshness and it does not stop forgery.
export const REAL_TURN_OSES = Object.freeze({ linux: "linux-", windows: "win32-", macos: "darwin-" });
// Build steps 8: N7 Phase A and B with the N10 reconnect split, f3, g6, plus the 1.0.37 rows. g1 joins with a policy.
export const REAL_TURN_STEPS = Object.freeze(["a", "b", "c", "d", "e", "f", "f2", "f3", "load-undecided", "load-consent2", "load-rejected",
  "g2", "g3", "g4", "g5-auto", "g5-full", "g6", "h", "card-trust", "card-reject", "card-skip",
  "level-ask", "level-auto", "level-full", "level-no-limits"]);
export const WINDOWS_STEPS = Object.freeze(["windows-path-trailing-semicolon", "windows-git-bash"]);
export const ONE_OS_STEP = "g7";
const POLICY_ACK = "fuigo/permissionPolicy";
const FOLDER_TRUST_REQUESTS = new Set(["fuigo/folder_trust/request", "_fuigo/folder_trust/request"]);
const OS_GOOS = Object.freeze({ linux: "linux", windows: "windows", macos: "darwin" });
// Phase A runs on a direct ACP client: no Murage, so no thread and no level setting.
const DIRECT = "direct";
const PHASE_A = new Set(["a", "b", "c", "d", "e", "f", "f2", "f3", "load-rejected"]);
const LEVELS = new Set(["ask", "auto", "full", "nolimits"]);
const STEP_LEVEL = Object.freeze({ g2: "ask", g3: "ask", "g5-auto": "auto", "g5-full": "full", "level-ask": "ask", "level-auto": "auto", "level-full": "full", "level-no-limits": "nolimits" });
const TRUST_REPLY = Object.freeze({ outcome: "trust", scope: "configAndCommands" });
const REJECT_REPLY = Object.freeze({ outcome: "reject" });
const RUNAWAY_THOUGHTS = 1000;
const isHex = (value, length) => typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
const isArray = (value) => Array.isArray(value);

/** A tap stamp or an ISO time as milliseconds. Tap times carry nanoseconds, which Date does not promise to read. */
const clock = (text) => {
  const stamp = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\.\d+)Z$/.exec(String(text));
  const iso = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}${stamp[7]}Z` : String(text);
  return Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
};

/** One rpc file as records. Q2 rule 1: every line a tap record, seq contiguous from 1, no tail. */
const readTranscript = (file, bytes) => {
  const records = [], faults = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { faults.push(`${file}: a line is not JSON`); break; }
    if (typeof record?.seq !== "number" || typeof record.t !== "string" || !["in", "out"].includes(record.dir) || (record.msg === undefined && record.raw === undefined)) { faults.push(`${file}: a line is not a tap record`); break; }
    if (record.seq !== records.length + 1) { faults.push(`${file}: seq is not contiguous at ${record.seq}`); break; }
    if (record.tail) faults.push(`${file}: truncated`);
    records.push(record);
  }
  if (!records.length) faults.push(`${file}: empty`);
  return { file, records, faults };
};

/** What a process did, read from its transcript. Every proof goes through this. */
const viewOf = ({ file, records }, invocation, proc) => {
  const msgs = records.filter((record) => typeof record.msg === "object" && record.msg !== null);
  const method = (name, dir) => msgs.filter((record) => record.msg?.method === name && (!dir || record.dir === dir));
  const updates = (kind) => method("session/update", "out").filter((record) => record.msg.params?.update?.sessionUpdate === kind);
  const replyTo = (request) => msgs.find((record) => record.seq > request.seq && record.dir !== request.dir && record.msg?.method === undefined && record.msg?.id === request.msg.id);
  const prompts = method("session/prompt", "in");
  const commands = new Map(updates("tool_call").map((record) => [record.msg.params.update.toolCallId, record.msg.params.update.rawInput?.command]));
  const completed = updates("tool_call_update").filter((record) => record.msg.params.update.status === "completed").map((record) => {
    const update = record.msg.params.update;
    const text = (isArray(update.content) ? update.content : []).map((item) => item?.content?.text ?? "").join("");
    return { seq: record.seq, id: update.toolCallId, sessionId: record.msg.params.sessionId, text, command: update.rawOutput?.command ?? commands.get(update.toolCallId) };
  });
  return { file, records, msgs, invocation, proc, method, updates, replyTo, prompts, completed,
    trust: msgs.filter((record) => record.dir === "out" && FOLDER_TRUST_REQUESTS.has(record.msg?.method)),
    perms: method("session/request_permission", "out"), news: method("session/new", "in"), loads: method("session/load", "in"), inits: method("initialize", "in"),
    promptText: (record) => (isArray(record.msg.params?.prompt) ? record.msg.params.prompt : []).map((item) => item?.text ?? "").join(""),
    agentText: updates("agent_message_chunk").map((record) => record.msg.params.update.content?.text ?? "").join(""),
    cwd: (method("session/new", "in")[0] ?? method("session/load", "in")[0])?.msg.params?.cwd };
};

/** A runaway's entry, derived and never claimed. Returns the one failed prompt, or a fault. */
const modelFailure = (view, reason, driver) => {
  const prompts = view.prompts;
  const failed = reason === "max_tokens_truncation"
    ? prompts.filter((prompt) => view.replyTo(prompt)?.msg.error?.data?.error_kind === reason)
    : reason === "open-at-close" ? prompts.filter((prompt) => !view.replyTo(prompt)) : null;
  if (!failed) return { fault: `reason ${reason} is not a model failure` };
  if (failed.length !== 1) return { fault: `${reason} needs one failed prompt, found ${failed.length}` };
  const [prompt] = failed;
  const sessionId = prompt.msg.params?.sessionId;
  const tool = view.completed.find((item) => item.seq > prompt.seq && item.sessionId === sessionId);
  if (!tool) return { fault: `${reason} needs a completed tool call in the failed prompt` };
  const thoughts = view.updates("agent_thought_chunk").filter((record) => record.seq > tool.seq && record.msg.params.sessionId === sessionId).length;
  if (thoughts === 0) return { fault: `${reason} needs thought chunks after the tool call` };
  if (reason === "open-at-close") {
    if (prompt !== prompts.at(-1)) return { fault: "open-at-close must be the last prompt" };
    if (thoughts <= RUNAWAY_THOUGHTS) return { fault: `open-at-close needs more than ${RUNAWAY_THOUGHTS} thought chunks` };
    if (view.updates("agent_message_chunk").some((record) => record.seq > prompt.seq)) return { fault: "open-at-close has message text" };
    if (driver.fatal || !(clock(driver.endedAt) > clock(view.records.at(-1).t))) return { fault: "open-at-close needs the app closed after the last record" };
  }
  return { prompt };
};

/** Q2 rules 3 to 5 on one ACP file. `failed` is the one prompt whose ending a model failure excuses. */
const completenessFaults = (view, failed) => {
  const faults = [];
  const open = new Map();
  for (const record of view.msgs) {
    const { id, method: name } = record.msg;
    if (id === undefined) continue;
    if (name !== undefined) {
      const key = `${record.dir}:${id}`;
      if (open.has(key)) faults.push(`request ${name} reuses an open id`);
      open.set(key, record);
      continue;
    }
    const key = `${record.dir === "in" ? "out" : "in"}:${id}`;
    const request = open.get(key);
    if (!request) { faults.push(`a response has no request (id ${id})`); continue; }
    open.delete(key);
    if (record.msg.error !== undefined && request !== failed) faults.push(`an error response to ${request.msg.method}`);
  }
  for (const request of open.values()) if (request !== failed) faults.push(`unanswered request ${request.msg.method}`);
  if (view.inits.length !== 1) faults.push(`${view.inits.length} initialize`);
  if (view.method("authenticate", "in").length !== 1) faults.push("authenticate is not exactly one");
  const pair = view.news.length === 1 && view.loads.length === 1 && view.proc?.level === DIRECT
    && view.news[0].seq < view.loads[0].seq && view.replyTo(view.news[0])?.msg.result?.sessionId === view.loads[0].msg.params?.sessionId;
  if (view.news.length + view.loads.length !== 1 && !pair) faults.push("not exactly one session/new or session/load");
  if (!view.prompts.length) faults.push("no session/prompt");
  const completes = view.method("_fuigo/session/prompt_complete", "out");
  for (const prompt of view.prompts) {
    if (prompt === failed) continue;
    const reply = view.replyTo(prompt);
    const stop = reply?.msg.result?.stopReason;
    if (stop !== "end_turn") { faults.push(`a prompt ends ${stop ?? "with no response"}`); continue; }
    const promptId = reply.msg.result._meta?.promptId;
    if (!promptId || !completes.some((record) => record.msg.params?.promptId === promptId)) faults.push("a prompt has no prompt_complete");
  }
  const last = view.prompts.at(-1);
  const lastReply = last && view.replyTo(last);
  if (lastReply && view.msgs.some((record) => record.seq > lastReply.seq && record.msg.id !== undefined)) faults.push("the last record is not the last prompt's response or a notification after it");
  return faults;
};

class Clause extends Error {}
const must = (ok, clause) => { if (!ok) throw new Clause(clause); };
const count = (views, wanted) => must(views.length === wanted, `needs ${wanted} process${wanted === 1 ? "" : "es"}`);
const oneRequest = (view, reason = "new") => {
  must(view.trust.length === 1, "one folder trust request");
  must(view.trust[0].msg.params?.reason === reason, `request reason ${reason}`);
  return view.trust[0];
};
const answered = (view, request, reply) => must(isDeepStrictEqual(view.replyTo(request)?.msg.result, reply), `reply deep-equal ${JSON.stringify(reply)}`);
const noRequests = (view) => must(view.trust.length === 0, "zero folder trust requests");
const noPermissions = (view) => must(view.perms.length === 0, "zero permission requests");
const prompted = (view, text) => must(view.prompts.some((prompt) => view.promptText(prompt).includes(text)), `prompt ${text}`);
const asked = (view, command, option) => {
  const perm = view.perms.find((record) => record.msg.params?.toolCall?.kind === "execute" && String(record.msg.params.toolCall.rawInput?.command).includes(command));
  must(perm, `permission request for ${command}`);
  if (option) must(view.replyTo(perm)?.msg.result?.outcome?.optionId === option, `${option} reply`);
  return perm;
};
const ranCat = (view, nonce) => view.completed.some((item) => item.text.includes(`note ${nonce}`));
const ranLs = (view) => view.completed.some((item) => item.command === "ls" && item.text.includes("note.txt"));
const ran = (view, ctx) => must(ranCat(view, ctx.nonce) || ranLs(view), "the command ran");
const initialized = (view) => {
  const caps = view.inits[0]?.msg.params?.clientCapabilities;
  must(caps?._meta?.["fuigo/folderTrust"]?.v2 === true, "initialize offers folder trust v2");
  must(!caps?.terminal, "initialize offers no terminal");
};
const turnOf = (ctx, view) => ctx.rows.find((row) => row.row === view.proc.row)?.[view.proc.turn];
const trustCard = (ctx, view) => turnOf(ctx, view)?.cards?.find((card) => card.trust);
const carded = (ctx, view, label) => {
  const card = trustCard(ctx, view);
  must(card, "driver has a trust card");
  must(card.status === 200, "trust card status 200");
  must(typeof card.chosen === "string" && card.chosen.startsWith(label), `card label starts ${label}`);
};
const siblingOf = (ctx, view, turn) => ctx.views.find((other) => other.proc?.row === view.proc.row && other.proc?.turn === turn);
const reads = (ctx, view, key) => ctx.stores.filter((read) => read.key === key && [view.invocation.home, view.invocation.fuigoHome].some((root) => root && String(read.path).startsWith(root)));
const readBefore = (ctx, view, key) => reads(ctx, view, key).filter((read) => clock(read.readAt) < clock(view.invocation.t)).at(-1);
const readAfter = (ctx, view, key) => reads(ctx, view, key).filter((read) => clock(read.readAt) >= clock(view.records.at(-1).t)).at(0);
const noKeyInStore = (ctx, view, key) => {
  const read = readAfter(ctx, view, key);
  must(read, "a store read after the process");
  must(isArray(read.lines) && read.lines.length === 0, "store has no line for the key");
};
const forgotten = (ctx, key) => {
  const entry = ctx.forgets.find((item) => item.key === key);
  must(entry, "driver has a forget for the key");
  must(entry.status === 200, "forget status 200");
  must(entry.recordsAfter === 0, "forget leaves zero records");
  return entry;
};
const layoutOf = (ctx, id) => { const layout = ctx.driver.layout?.[id]; must(layout, `driver layout ${id}`); return layout; };
const loaded = (view) => {
  must(view.loads.length === 1 && view.loads[0].msg.params?._meta?.noReplay === true, "session/load with noReplay");
  must(view.prompts.length > 0 && view.prompts[0].seq > view.loads[0].seq, "prompt after the load");
};
const rejectThenAsks = (view) => { answered(view, oneRequest(view), REJECT_REPLY); prompted(view, "ls"); asked(view, "ls", "reject-once"); };
const levelProof = (ctx, views) => {
  for (const view of views) must(!view.inits[0]?.msg.params?.clientCapabilities?.terminal, "initialize offers no terminal");
  must(views.length >= 2, "needs a pair");
  must(views.some((view) => ranCat(view, ctx.nonce)), "cat note.txt ran");
  must(views.some(ranLs), "ls ran");
};

// Q1, one predicate per step id. The clause that throws names what failed.
const STEP_PROOFS = {
  a: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    initialized(view);
    must(view.news.length === 1, "session/new");
    const request = oneRequest(view);
    must(request.msg.params?.scope === "configAndCommands", "request scope configAndCommands");
    answered(view, request, TRUST_REPLY);
    prompted(view, "cat note.txt"); noPermissions(view); ran(view, ctx);
    const after = readAfter(ctx, view, request.msg.params?.workspace);
    must(after?.lines?.length === 1 && after.trusted === true, "store holds one trusted line for the key");
  },
  b: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    const request = oneRequest(view);
    rejectThenAsks(view);
    const key = request.msg.params?.workspace;
    const before = readBefore(ctx, view, key), after = readAfter(ctx, view, key);
    must(before && after, "store reads before and after");
    must(before.sha256 === after.sha256, "store sha unchanged");
  },
  c: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    const request = oneRequest(view, "upgrade");
    const before = readBefore(ctx, view, request.msg.params?.workspace);
    must(before?.trusted === true && before.consent === undefined && isHex(before.sha256, 64), "legacy trusted = true line before the spawn");
    answered(view, request, TRUST_REPLY);
  },
  d: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    must(readBefore(ctx, view, view.cwd)?.trusted === false, "trusted = false line before the spawn");
    noRequests(view); prompted(view, "ls"); asked(view, "ls");
  },
  e: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    const first = ctx.viewByFile.get(ctx.row.steps?.a?.processes?.[0]);
    must(first && first.cwd === view.cwd && clock(first.invocation.t) < clock(view.invocation.t), "same cwd, after a");
    must(view.news.length === 1, "session/new");
    noRequests(view);
    must(view.agentText.includes(`MARK-${ctx.nonce}`), "agent text holds the marker");
  },
  f: (ctx, views) => {
    count(views, 3);
    const layout = layoutOf(ctx, "f");
    const [submodule, worktree, declined] = views;
    must(submodule.cwd === layout.submodule && oneRequest(submodule).msg.params?.workspace === layout.parent, "submodule asks for the parent");
    must(worktree.cwd === layout.worktree && oneRequest(worktree).msg.params?.workspace === layout.main, "linked worktree asks for the main checkout");
    must(declined.cwd === layout.subfolder, "subfolder cwd");
    must(reads(ctx, declined, layout.parent).some((read) => read.trusted === true), "parent trusted in the store");
    // A stored no on the subfolder beats the parent's yes, and a stored no sends no request (as step d).
    must(readBefore(ctx, declined, layout.subfolder)?.trusted === false, "subfolder has a stored no before the spawn");
    noRequests(declined); prompted(declined, "ls"); asked(declined, "ls");
  },
  f2: (ctx, views) => {
    count(views, 1);
    const layout = layoutOf(ctx, "f2");
    must(views[0].cwd === layout.cwd && oneRequest(views[0]).msg.params?.workspace === layout.main, "request names the main checkout");
  },
  f3: (ctx, views) => {
    count(views, 1);
    const layout = layoutOf(ctx, "f3");
    must(ctx.absolute(views[0].invocation.fuigoHome), "fuigoHome is absolute");
    must(layout.storeExisted === false, "no store existed");
    must(oneRequest(views[0]).msg.params?.workspace === layout.key, "request names the expected key");
  },
  "load-undecided": (ctx, views) => {
    count(views, 1);
    const [view] = views;
    loaded(view);
    rejectThenAsks(view);
    must(!trustCard(ctx, view), "no trust card on t2");
  },
  "load-consent2": (ctx, views) => {
    must(views.length >= 1, "needs a process");
    for (const view of views) {
      loaded(view);
      noRequests(view); noPermissions(view); ran(view, ctx);
      const first = siblingOf(ctx, view, "t1");
      must(first, "its t1");
      answered(first, oneRequest(first), TRUST_REPLY);
    }
  },
  "load-rejected": (ctx, views) => {
    count(views, 1);
    const [view] = views;
    must(view.news.length === 1 && view.loads.length === 1, "new then load in one process");
    const request = oneRequest(view);
    answered(view, request, REJECT_REPLY);
    must(request.seq < view.loads[0].seq, "reject before the load");
    must(view.replyTo(view.loads[0]), "load response");
    must(view.prompts.some((prompt) => prompt.seq > view.loads[0].seq), "prompt after the load");
  },
  g2: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    answered(view, oneRequest(view), TRUST_REPLY);
    carded(ctx, view, "Trust");
    must(ranCat(view, ctx.nonce), "cat ran");
    noPermissions(view);
    must(ctx.rows.find((row) => row.row === view.proc.row)?.trustGet?.records === 1, "trustGet records 1");
  },
  g3: (ctx, views) => {
    count(views, 1);
    const [view] = views;
    answered(view, oneRequest(view), REJECT_REPLY);
    carded(ctx, view, "Don");
    const perm = asked(view, "cat", "reject-once");
    must(turnOf(ctx, view)?.cards?.some((card) => !card.trust && card.behavior === "deny"), "driver command card deny");
    must(!view.completed.some((item) => item.id === perm.msg.params.toolCall.toolCallId), "the command did not run");
  },
  g4: (ctx, views) => {
    count(views, 2);
    const [first, second] = views;
    answered(first, oneRequest(first), TRUST_REPLY);
    must(second.news.length === 1 && second.cwd === first.cwd, "a new session in the same folder");
    noRequests(second);
    must(second.agentText.includes(`MARK-${ctx.nonce}`), "agent text holds the marker");
  },
  "g5-auto": (ctx, views) => {
    count(views, 2);
    const [trusted, rejected] = views;
    must(trustCard(ctx, trusted), "driver has a trust card");
    answered(trusted, oneRequest(trusted), TRUST_REPLY);
    noPermissions(trusted); ran(trusted, ctx);
    answered(rejected, oneRequest(rejected), REJECT_REPLY);
    asked(rejected, "", "allow-once"); ran(rejected, ctx);
    must(turnOf(ctx, rejected)?.cards?.length === 1 && trustCard(ctx, rejected), "cards hold only the trust card");
  },
  "g5-full": (ctx, views) => {
    count(views, 2);
    for (const view of views) {
      answered(view, oneRequest(view), REJECT_REPLY);
      must(turnOf(ctx, view)?.cards?.length === 0, "driver cards empty");
      asked(view, "", "allow-once"); ran(view, ctx);
    }
    loaded(views[1]);
  },
  g6: (ctx, views) => {
    count(views, 3);
    const [first, second, next] = views;
    for (const view of views) must(ctx.absolute(view.invocation.fuigoHome), "fuigoHome is absolute");
    must(next.invocation.fuigoHome !== first.invocation.fuigoHome, "a different fuigoHome after the forget");
    const request = oneRequest(first);
    answered(first, request, TRUST_REPLY);
    noRequests(second);
    const entry = forgotten(ctx, request.msg.params?.workspace);
    must(clock(next.invocation.t) > clock(entry.forgetAt), "the next process is after the forget");
    oneRequest(next);
    must(trustCard(ctx, next), "driver has a trust card");
  },
  g7: (ctx, views) => {
    count(views, 2);
    const [first, second] = views;
    must(ctx.driver.env?.MURAGE_ACP_POOL === "1", "driver env MURAGE_ACP_POOL=1");
    const request = oneRequest(first);
    answered(first, request, REJECT_REPLY);
    carded(ctx, first, "Don");
    const entry = forgotten(ctx, request.msg.params?.workspace);
    must(clock(second.invocation.t) > clock(entry.forgetAt), "the next process is after the forget");
    oneRequest(second);
    must(trustCard(ctx, second), "driver has a trust card");
    must(first.invocation.pid !== second.invocation.pid, "distinct pids");
  },
  h: (ctx, views) => {
    count(views, 2);
    const [first, second] = views;
    must(first.invocation.home === second.invocation.home && first.invocation.fuigoHome === second.invocation.fuigoHome, "same home and fuigoHome");
    must(first.invocation.fuigoHome === "" || ctx.absolute(first.invocation.fuigoHome), "fuigoHome empty or absolute");
    const key = oneRequest(first).msg.params?.workspace;
    const between = reads(ctx, first, key).filter((read) => clock(read.readAt) > clock(first.invocation.t) && clock(read.readAt) < clock(second.invocation.t));
    must(between.length >= 2, "two store reads between the processes");
    must(between[0].lines?.length === 1 && between[0].sha256 === between.at(-1).sha256 && isDeepStrictEqual(between[0].lines, between.at(-1).lines), "same line, same sha");
    noRequests(second);
  },
  "card-trust": (_ctx, views) => { count(views, 1); answered(views[0], oneRequest(views[0]), TRUST_REPLY); },
  "card-reject": (ctx, views) => {
    count(views, 2);
    const [first, second] = views;
    const request = oneRequest(first);
    answered(first, request, REJECT_REPLY);
    carded(ctx, first, "Don");
    noKeyInStore(ctx, first, request.msg.params?.workspace);
    must(!trustCard(ctx, second), "t2 raises no trust card");
  },
  "card-skip": (ctx, views) => {
    count(views, 2);
    const [first, second] = views;
    const request = oneRequest(first);
    answered(first, request, REJECT_REPLY);
    const card = trustCard(ctx, first);
    must(card?.behavior === "skip" && card.chosen === undefined && card.status === 200, "card answered skip, no label, status 200");
    noKeyInStore(ctx, first, request.msg.params?.workspace);
    const record = ctx.rows.find((row) => row.row === first.proc.row)?.trustGet?.record;
    must(record?.source === "picker" && record.consent === undefined, "Murage record unchanged by the skip");
    must(second.invocation.pid !== first.invocation.pid && trustCard(ctx, second), "t2 is a new pid with a trust card");
  },
  "level-ask": levelProof, "level-auto": levelProof, "level-full": levelProof, "level-no-limits": levelProof,
  "windows-path-trailing-semicolon": (ctx, views) => {
    must(views.length >= 1, "needs a process");
    for (const view of views) must(String(view.invocation.path).endsWith(";"), "PATH ends with a semicolon");
    must(views.some((view) => ranCat(view, ctx.nonce)), "cat ran");
  },
  "windows-git-bash": (ctx, views) => {
    count(views, 1);
    const [view] = views;
    prompted(view, "uname -s");
    must(view.completed.some((item) => /MINGW|MSYS/.test(item.text)), "output holds MINGW or MSYS");
    must(ctx.driver.gitDir && String(view.invocation.path).includes(ctx.driver.gitDir), "PATH holds the Git for Windows dir");
  },
  g1: (ctx, views) => {
    must(views.length >= 1, "needs a process");
    for (const view of views) must(view.msgs.some((record) => record.msg.result?._meta?.[POLICY_ACK]?.sha256 === ctx.want.policySha256), "session acks the policy");
  },
};

/** Exact checks 2 to 8 for one OS. Faults go through `stop`; returns the receipt and whether g7 was proved here. */
const checkOsRun = (os, row, folder, want, stop, seen) => {
  if (row.os !== os) stop(`os is ${row.os}`);
  if (row.fuigoVersion !== want.version) stop(`fuigoVersion is ${row.fuigoVersion}`);
  if (row.peeledTag !== want.peeledTag) stop("not this tag commit");
  if (!isHex(row.murageSha, 40) || row.murageSha !== want.murageSha) stop("not this Murage sha");
  if (typeof row.target !== "string" || !row.target.startsWith(REAL_TURN_OSES[os]) || !Object.hasOwn(want.assets, row.target)) stop(`target ${row.target} is not a ${os} asset`);
  else if (row.binarySha256 !== want.assets[row.target].binarySha256) stop("the binary that ran is not the pinned asset");
  if ((row.policySha256 ?? null) !== want.policySha256) stop("policy sha differs");
  if (!isHex(row.nonce, 16)) stop("nonce is not 16 hex");
  else if (seen.nonces.has(row.nonce)) stop("nonce is another row's");
  seen.nonces.add(row.nonce);

  // Check 2: the folder and the list are the same set, and each sha matches.
  const list = row.files ?? {};
  const transcripts = isArray(list.transcripts) ? list.transcripts : [];
  const others = isArray(list.other) ? list.other : [];
  const listed = [list.invocations, list.driver, list.version, ...transcripts, ...others];
  if (new Set(listed).size !== listed.length) stop("a file is listed twice");
  for (const file of listed) {
    if (typeof file !== "string" || !folder.has(file)) { stop(`listed file missing: ${file}`); continue; }
    const bytes = folder.get(file);
    if (bytes === null) { stop(`${file} is not a plain file`); continue; }
    const digest = sha("sha256", bytes);
    if (row.sha256?.[file] !== digest) stop(`${file} does not match its sha256`);
    if (seen.shas.has(digest)) stop(`${file} is the same bytes as ${seen.shas.get(digest)}`);
    seen.shas.set(digest, `${os}/${file}`);
  }
  for (const file of folder.keys()) if (!listed.includes(file)) stop(`unlisted file ${file}`);
  const parseJson = (file) => { try { return JSON.parse(folder.get(file).toString("utf8")); } catch { return undefined; } };
  const driver = (folder.get(list.driver) && parseJson(list.driver)) || null;
  if (!driver) { stop("driver.json unreadable"); return null; }
  if (!folder.get(list.invocations)) { stop("invocations file unreadable"); return null; }
  if (driver.nonce !== row.nonce) stop("driver.json nonce differs from the row");
  if (driver.endedAt === undefined || driver.fatal) stop("driver.json has no endedAt or has a fatal");
  if (driver.fuigo?.source !== "bundled") stop("fuigo source is not bundled");
  if (!isArray(driver.pathCopies) || driver.pathCopies.length) stop("a fuigo copy is on PATH");
  if (driver.version !== want.packageVersion) stop(`driver version is ${driver.version}`);
  const pinned = want.assets[row.target]?.binarySha256;
  if (driver.binary?.shaStart !== pinned || driver.binary?.shaEnd !== pinned) stop("binary shas are not the pinned asset");

  // Q2 rule 6: invocations and rpc files, one to one.
  const invocations = [];
  for (const line of folder.get(list.invocations).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { invocations.push(JSON.parse(line)); } catch { stop("an invocation line is not JSON"); }
  }
  const byFile = new Map(invocations.map((item) => [`rpc-${item.t}-${item.pid}.jsonl`, item]));
  const rpcFiles = [...folder.keys()].filter((file) => /^rpc-.*\.jsonl$/.test(file));
  if (byFile.size !== invocations.length) stop("two invocations share a stamp and pid");
  for (const file of rpcFiles) if (!byFile.has(file)) stop(`${file} has no invocation`);
  for (const file of byFile.keys()) if (!folder.has(file)) stop(`invocation has no file ${file}`);

  const processes = driver.processes ?? {};
  const failures = new Map();
  for (const entry of isArray(row.modelFailures) ? row.modelFailures : []) {
    if (failures.has(entry?.file)) stop(`${entry?.file} is listed twice in modelFailures`);
    failures.set(entry?.file, entry?.reason);
  }
  const absolute = (path) => (os === "windows" ? /^[A-Za-z]:\\/ : /^\//).test(String(path));
  const selfTail = os === "windows" ? /[\\/][Rr]esources[\\/]fuigo[\\/]fuigo\.exe$/ : /\/[Rr]esources\/fuigo\/fuigo$/;
  const views = [];
  const selves = new Set();
  const acks = [];
  for (const [file, invocation] of byFile) {
    const bytes = folder.get(file);
    if (!bytes) continue;
    const argv = isArray(invocation.argv) ? invocation.argv : [];
    const acp = argv.at(-1) === "stdio";
    if (acp !== transcripts.includes(file)) stop(`${file} is ${acp ? "ACP but not in transcripts" : "in transcripts but not ACP"}`);
    const fail = (text) => stop(`${file}: ${text}`);
    if (invocation.goos !== OS_GOOS[os]) fail(`goos is ${invocation.goos}`);
    if (!absolute(invocation.cwd)) fail(`cwd is not a ${os} path`);
    if (!absolute(invocation.self) || !selfTail.test(String(invocation.self))) fail(`self is not a ${os} bundled path`);
    selves.add(invocation.self);
    const transcript = readTranscript(file, bytes);
    for (const fault of transcript.faults) stop(fault);
    if (!acp) continue;
    if (transcript.records.some((record) => record.raw !== undefined)) fail("a raw line in an ACP file");
    if (transcript.records.some((record) => record.msg !== undefined && (typeof record.msg !== "object" || record.msg === null))) fail("a line is not an rpc message");
    if (transcript.faults.length) continue;
    const proc = processes[file];
    if (!proc) fail("no processes entry");
    else if (proc.level === DIRECT) { if (proc.thread != null || proc.setting != null) fail("a direct process has no thread or setting"); }
    else if (!LEVELS.has(proc.level)) fail(`level ${proc.level} is not a permission level`);
    else if (proc.setting?.status !== 200 || proc.setting?.level !== proc.level) fail(`setting ${JSON.stringify(proc.setting)} disagrees with level ${proc.level}`);
    const view = viewOf(transcript, invocation, proc);
    views.push(view);
    let failed = null;
    if (failures.has(file)) {
      const result = modelFailure(view, failures.get(file), driver);
      if (result.fault) fail(result.fault); else failed = result.prompt;
    }
    for (const fault of completenessFaults(view, failed)) fail(fault);
    // Exact check 4: nonce on this file. Exact check 5: the launch.
    if (!String(view.cwd ?? "").includes(row.nonce)) fail("nonce is not in the session cwd");
    if (proc?.row !== "marker" && view.prompts.some((prompt) => !view.promptText(prompt).includes(row.nonce))) fail("nonce is not in a prompt");
    if (!absolute(view.cwd)) fail(`session cwd is not a ${os} path`);
    const threads = view.msgs.flatMap((record) => (record.dir === "in" && isArray(record.msg.params?.mcpServers) ? record.msg.params.mcpServers : []))
      .flatMap((server) => (isArray(server?.env) ? server.env : [])).filter((item) => item?.name === "MURAGE_THREAD_ID").map((item) => item.value);
    if (proc?.level === DIRECT && threads.length) fail("a Murage process is mapped as a direct client");
    if (proc && proc.level !== DIRECT && (!threads.length || threads.some((thread) => thread !== proc.thread))) fail("processes thread is not the session's thread");
    const mode = argv.indexOf("--permission-mode");
    if (mode < 0 || argv[mode + 1] !== "default" || !argv.includes("--no-leader") || !argv.includes("--no-memory") || argv.includes("--trust")) fail("launch is not generation 2 (--permission-mode default, --no-leader, --no-memory, no --trust)");
    // Exact check 6.
    if (view.inits.some((record) => record.msg.params?.clientCapabilities?.terminal)) fail("client offered a terminal");
    if (view.msgs.some((record) => typeof record.msg.method === "string" && record.msg.method.startsWith("terminal/"))) fail("log has a terminal call");
    if (view.msgs.some((record) => record.msg.params?._meta?.clientTerminal === true)) fail("log has clientTerminal");
    acks.push(...view.msgs.map((record) => record.msg.result?._meta?.[POLICY_ACK]?.sha256).filter((ack) => ack !== undefined));
  }
  if (want.policySha256 ? !acks.includes(want.policySha256) || acks.some((ack) => ack !== want.policySha256) : acks.length > 0) stop(want.policySha256 ? "log has no ack of this policy" : "log acks a policy that was not given");
  if (selves.size !== 1) stop("self differs between processes");
  const [self] = selves;
  const realPath = String(self).replace(/(\.exe)?$/, "-real$1");
  if (driver.binary?.path !== realPath) stop("driver binary path is not the tap's fuigo-real");
  for (const file of Object.keys(processes)) if (!transcripts.includes(file)) stop(`processes names ${file}, not a transcript`);
  for (const file of failures.keys()) if (!transcripts.includes(file)) stop(`modelFailures names ${file}, not a transcript`);
  const versionText = folder.get(list.version)?.toString("utf8") ?? "";
  const versionLines = versionText.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line).raw ?? ""; } catch { return ""; } });
  if (byFile.get(list.version)?.argv?.join(" ") !== "--version" || !versionLines.some((line) => line.split(/[^0-9.]+/).includes(want.version))) stop("the Fuigo version line does not name this version");

  // Exact check 7.
  const viewByFile = new Map(views.map((view) => [view.file, view]));
  const ctx = { row, driver, want, views, viewByFile, nonce: row.nonce, absolute, rows: isArray(driver.rows) ? driver.rows : [], stores: isArray(driver.stores) ? driver.stores : [], forgets: isArray(driver.forget) ? driver.forget : [] };
  const prove = (id) => {
    const names = row.steps?.[id]?.processes;
    if (!isArray(names) || !names.length) return `step ${id}: names no process`;
    const named = [];
    for (const file of names) {
      if (failures.has(file)) return `step ${id}: names model failure ${file}`;
      const view = viewByFile.get(file);
      if (!view) return `step ${id}: ${file} is not an ACP file`;
      if (!view.proc) return `step ${id}: ${file} has no processes entry`;
      if (PHASE_A.has(id) !== (view.proc.level === DIRECT)) return `step ${id}: ${file} is the wrong client`;
      if (STEP_LEVEL[id] && view.proc.level !== STEP_LEVEL[id]) return `step ${id}: ${file} is level ${view.proc.level}`;
      named.push(view);
    }
    try { STEP_PROOFS[id](ctx, named); return null; } catch (error) {
      if (error instanceof Clause) return `step ${id}: ${error.message}`;
      throw error;
    }
  };
  const needed = [...REAL_TURN_STEPS, ...(want.policySha256 ? ["g1"] : []), ...(os === "windows" ? WINDOWS_STEPS : [])];
  for (const id of needed) { const fault = prove(id); if (fault) stop(fault); }
  let oneOs = false;
  if (row.steps?.[ONE_OS_STEP]) { const fault = prove(ONE_OS_STEP); if (fault) stop(fault); else oneOs = true; }
  return { oneOs, receipt: { os, target: row.target, binarySha256: row.binarySha256, nonce: row.nonce, invocationsSha256: sha("sha256", folder.get(list.invocations)), transcripts: transcripts.length, steps: needed.length + (oneOs ? 1 : 0) } };
};

/** Refuses anything but one whole run per OS, bound to this version, source, Murage sha, package, asset and policy. All faults, then one throw. */
export const checkRealTurns = (files, want) => {
  const faults = [];
  const names = files.map((file) => file.name).sort();
  const wantNames = Object.keys(REAL_TURN_OSES).map((os) => `${os}.json`).sort();
  if (names.join() !== wantNames.join()) faults.push(`need exactly ${wantNames.join(", ")}, found ${names.join(", ") || "nothing"}`);
  const receipts = [];
  const seen = { nonces: new Set(), shas: new Map() };
  let oneOs = false;
  for (const { name, row, folder } of files) {
    const stop = (text) => faults.push(`${name}: ${text}`);
    const os = name.replace(/\.json$/, "");
    if (!Object.hasOwn(REAL_TURN_OSES, os)) continue;
    if (row?.schema !== 2) { stop("schema is not 2"); continue; }
    if (!(folder instanceof Map)) { stop("evidence folder missing"); continue; }
    const result = checkOsRun(os, row, folder, want, stop, seen);
    if (!result) continue;
    oneOs ||= result.oneOs;
    receipts.push(result.receipt);
  }
  if (!oneOs) faults.push(`step ${ONE_OS_STEP} has no proof on any OS`);
  if (faults.length) throw new Error(`real-turn evidence refused:\n  ${faults.join("\n  ")}`);
  return receipts;
};

/** The files of a --real-turns folder: each <os>.json with every entry of the folder <os>/ beside it. Nothing outside that folder is read. */
export const readRealTurns = (dir) => readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
  const row = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const osDir = join(dir, name.replace(/\.json$/, ""));
  if (!existsSync(osDir)) return { name, row };
  const folder = new Map(readdirSync(osDir, { withFileTypes: true }).map((entry) => [entry.name, entry.isFile() ? readFileSync(join(osDir, entry.name)) : null]));
  return { name, row, folder };
});

/** Step 10: a receipt with the real turns in hand, one row per OS. */
export const mergeCheck = (receipt) => {
  const oses = Array.isArray(receipt.real_turns) ? receipt.real_turns.map((row) => row.os).sort().join() : "";
  if (oses !== Object.keys(REAL_TURN_OSES).sort().join()) throw new Error(`Fuigo ${receipt.fuigoVersion}: real turns are owed, this pin cannot merge`);
};

/** Writes every file or none: all staged beside their targets, then renamed; a failure puts back what was there. */
export const commitFiles = (writes, removals = []) => {
  const temp = (path) => `${path}.bump-tmp`;
  const before = new Map([...writes.map(([path]) => path), ...removals].map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  try {
    for (const [path, text] of writes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(temp(path), text); }
    for (const [path] of writes) renameSync(temp(path), path);
    for (const path of removals) rmSync(path, { force: true });
  } catch (error) {
    for (const [path, old] of before) { if (old === null) rmSync(path, { force: true }); else writeFileSync(path, old); }
    throw error;
  } finally {
    for (const [path] of writes) rmSync(temp(path), { force: true });
  }
};

const fetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const tarEntry = (tar, wanted) => {
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString("utf8", at, at + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(tar.toString("utf8", at + 124, at + 136).replace(/\0.*$/s, "").trim(), 8);
    if (wanted(name)) return { name, data: tar.subarray(at + 512, at + 512 + size) };
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
};
export const machineHeader = (bin) => {
  if (bin.readUInt32LE(0) === 0xfeedfacf) return { format: "Mach-O64", machine: bin.readUInt32LE(4) };
  if (bin.subarray(0, 4).toString("latin1") === "\x7fELF") return { format: "ELF64", machine: bin.readUInt16LE(18) };
  if (bin.subarray(0, 2).toString("latin1") === "MZ") return { format: "PE", machine: bin.readUInt16LE(bin.readUInt32LE(0x3c) + 4) };
  throw new Error("unknown executable header");
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

async function provenance(version, registry, targets, expected, checkoutHead) {
  const packages = [];
  const seen = new Set();
  for (const [target, name] of [["wrapper", "fuigo"], ...targets.map(([t, a]) => [t, a.package])]) {
    const meta = JSON.parse((await fetchBytes(`${registry}/${name.replace("/", "%2f")}/${version}`)).toString());
    const archive = await fetchBytes(meta.dist.tarball);
    if (sha("sha512", archive, "base64") !== meta.dist.integrity.replace(/^sha512-/, "")) throw new Error(`${name}: sha512 integrity mismatch`);
    if (sha("sha1", archive) !== meta.dist.shasum) throw new Error(`${name}: sha1 shasum mismatch`);
    if (meta.gitHead !== checkoutHead) throw new Error(`${name}: gitHead ${meta.gitHead} is not the peeled tag ${checkoutHead}`);
    const tarballSha256 = sha("sha256", archive);
    const note = expected?.[name];
    if (expected && (note?.sha256 !== tarballSha256 || note?.integrity !== meta.dist.integrity)) throw new Error(`${name}: differs from the hash note`);
    seen.add(tarballSha256);
    const row = { target, name, gitHead: meta.gitHead, tarball: meta.dist.tarball, tarballSha256, integrity: meta.dist.integrity, shasum: meta.dist.shasum, archiveBytes: archive.length };
    if (target === "wrapper") row.optionalDependencies = meta.optionalDependencies;
    else {
      const tar = gunzipSync(archive);
      const entry = tarEntry(tar, (entryName) => /^package\/bin\/.*\.br$/.test(entryName) || /^package\/bin\/fuigo(\.exe)?$/.test(entryName));
      if (!entry) throw new Error(`${name}: no executable in the archive`);
      const bin = entry.name.endsWith(".br") ? brotliDecompressSync(entry.data) : Buffer.from(entry.data);
      Object.assign(row, { header: { ...machineHeader(bin), target }, binarySha256: sha("sha256", bin), binaryBytes: bin.length });
    }
    packages.push(row);
  }
  return packages;
}

async function main() {
  if (process.argv[2] === "--merge-check") return mergeCheck(JSON.parse(readFileSync(process.argv[3], "utf8")));
  if (process.platform === "darwin" && process.env.MURAGE_GATE_BOX !== "1") throw new Error("release gate only: set MURAGE_GATE_BOX=1 on a disposable box");
  const args = parseArgs(process.argv.slice(2));
  const { version, evidence: evidenceDir } = args;
  const checkout = args["fuigo-checkout"];
  const prepareFile = join(REPO, "scripts/prepare-fuigo.mjs");
  const { FUIGO_ASSETS, FUIGO_REGISTRY } = await import(pathToFileURL(prepareFile).href);

  // Step 2 first: it needs no network. The reviewed source is the peeled tag commit.
  const head = git(checkout, "rev-parse", `v${version}^{commit}`).trim();
  const baseHead = git(checkout, "rev-parse", `${TRUST_BASE_TAG}^{commit}`).trim();
  const changed = [];
  for (const path of MUST_BE_EMPTY) if (git(checkout, "diff", baseHead, head, "--", path).trim()) changed.push(path);
  if (changed.length) throw new Error(`trust protocol changed: re-review FUIGO-TRUST-V2 (${changed.join(", ")})`);
  for (const path of EVERY_HUNK_REVIEWED.filter((item) => item.endsWith("session_setup.rs"))) {
    const at = (rev) => callExpressions(git(checkout, "show", `${rev}:${path}`), TRUST_PROMPT_CALL).join("\n");
    if (at(baseHead) !== at(head)) throw new Error(`trust protocol changed: re-review FUIGO-TRUST-V2 (${path})`);
  }
  const reviewed = new Set(readFileSync(args["reviewed-hunks"], "utf8").split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
  const unreviewed = EVERY_HUNK_REVIEWED.flatMap((path) => hunksOf(git(checkout, "diff", "-U3", baseHead, head, "--", path)).map((hunk) => ({ path, ...hunk }))).filter((hunk) => !reviewed.has(hunk.sha1));
  if (unreviewed.length) {
    for (const hunk of unreviewed) process.stdout.write(`UNREVIEWED ${hunk.sha1} ${hunk.path}\n${hunk.text}\n`);
    throw new Error(`${unreviewed.length} hunk(s) not reviewed: add each sha1 to --reviewed-hunks after reading it`);
  }

  // Step 3.
  const murageGit = args["murage-git"] ?? REPO;
  const murageSha = git(murageGit, "rev-parse", "--verify", `${args.base}^{commit}`).trim();
  const ancestor = spawnSync("git", ["-C", murageGit, "merge-base", "--is-ancestor", "27d10e398", murageSha]);
  if (ancestor.status !== 1) throw new Error("base re-copies trusted_folders.toml (1.0.10 scoped home)");

  // Step 1: registry receipts, the hash note and the release manifest.
  const expected = args["expected-hashes"] ? parseHashNote(readFileSync(args["expected-hashes"], "utf8")) : null;
  const packages = await provenance(version, FUIGO_REGISTRY, Object.entries(FUIGO_ASSETS), expected, head);
  const releaseBase = `https://github.com/FerroxLabs/fuigo/releases/download/v${version}`;
  const manifestBytes = await fetchBytes(`${releaseBase}/release-manifest.json`);
  const manifest = JSON.parse(manifestBytes.toString());
  const sums = (await fetchBytes(`${releaseBase}/SHA256SUMS`)).toString();
  if (manifest.sourceCommit !== head || manifest.version !== version) throw new Error("release-manifest.json names another source or version");
  for (const row of packages) {
    const listed = manifest.packages.find((item) => item.name === row.name);
    if (listed?.integrity !== row.integrity || listed?.shasum !== row.shasum) throw new Error(`${row.name}: differs from release-manifest.json`);
    for (const digest of [row.tarballSha256, row.binarySha256]) if (digest && !sums.includes(`${digest}  `)) throw new Error(`${row.name}: ${digest} is not in SHA256SUMS`);
  }

  // Step 4: real turns, or an explicit record that they are owed. Every input is read before the first write.
  const assets = Object.fromEntries(packages.filter((row) => row.target !== "wrapper").map((row) => [row.target, { tarballSha256: row.tarballSha256, binarySha256: row.binarySha256 }]));
  const policySha256 = args.policy ? sha("sha256", readFileSync(args.policy)) : null;
  const packageVersion = JSON.parse(git(murageGit, "show", `${murageSha}:package.json`)).version;
  const realTurns = args["real-turns"] ? checkRealTurns(readRealTurns(args["real-turns"]), { version, peeledTag: head, murageSha, packageVersion, assets, policySha256 }) : "owed";

  // Step 5: everything passed; only now write, all or nothing.
  const proof = { version, source: head, registry: FUIGO_REGISTRY, verifiedAt: new Date().toISOString(), installScriptsExecuted: false, nativeExecutablesRun: false, packages };
  const moved = movePin(readFileSync(prepareFile, "utf8"), version, head, assets);
  const oldVersion = /export const FUIGO_VERSION = "([^"]+)"/.exec(readFileSync(prepareFile, "utf8"))[1];
  const proofText = `${JSON.stringify(proof, null, 2)}\n`;
  const receipt = { murageSha, fuigoVersion: version, peeledTag: head, trustBase: baseHead, assets, wrapperTarballSha256: packages[0].tarballSha256, releaseManifestSha256: sha("sha256", manifestBytes), policySha256: policySha256 ?? (realTurns === "owed" ? "owed: real-turn step" : "none: this Murage launches no policy file"), real_turns: realTurns };
  commitFiles([
    [join(evidenceDir, `fuigo-${version}-provenance.json`), proofText],
    [join(evidenceDir, "reviewed-hunks.txt"), readFileSync(args["reviewed-hunks"])],
    [join(evidenceDir, `bump-${version}.json`), `${JSON.stringify(receipt, null, 2)}\n`],
    [prepareFile, moved],
    [join(REPO, `scripts/fuigo-${version}-provenance.json`), proofText],
  ], oldVersion !== version ? [join(REPO, `scripts/fuigo-${oldVersion}-provenance.json`)] : []);
  process.stdout.write(`Pinned ${version} (${head}). Commit scripts/prepare-fuigo.mjs and scripts/fuigo-${version}-provenance.json, update the tests and deploy/cloud-home/LICENSES.md.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`fuigo-bump stopped: ${error.message}\n`); process.exit(1); });
}
