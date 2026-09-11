#!/usr/bin/env node
// Live round trip of Fuigo's `_fuigo/ask_user_question` through the real
// Murage server against the PINNED bundled engine (LFU2, ASK3), the way
// scripts/verify-question-claude.ts proves Claude's AskUserQuestion.
//
// Opt-in real-provider proof: it spends FluxRouter credit. It needs
// `--allow-provider`, a FLUX_API_KEY in the environment (no credential file
// is read here — the caller reads the key into env), and the staged engine
// at dist-native/fuigo/<host>/fuigo (`node scripts/prepare-fuigo.mjs`).
//
// What it proves, in order, with an isolated HOME / data dir and nothing of
// the user's touched:
//   1. the engine spawned with Murage's exact argument order (`--permission-mode
//      default --no-memory agent --no-leader … stdio`) identifies as the
//      pinned FUIGO_VERSION;
//   2. a real tool-using turn: the model writes a canary file through its
//      own tool, the permission request becomes a card that this script
//      allows once (never auto-approved), and the file lands on disk;
//   3. a real `_fuigo/ask_user_question`: the model asks, the request becomes
//      a question card carrying the engine's questions, the owner's picks go
//      back through /respond in Fuigo's `{outcome:"accepted", answers,
//      annotations}` shape, and the model's final answer repeats the picks.
//
// Evidence (never the key, never provider headers) is written to --output:
// the wire log the driver keeps (native/<threadId>.ndjson), the transcript,
// and per-check booleans. The wire log is the proof that the pinned version still speaks
// the ask/answer shapes the driver implements.
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { freePortBlock } from "../server/testing/ports.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { FUIGO_VERSION, verifyPinnedBinary } from "./prepare-fuigo.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostTarget = `${process.platform}-${process.arch}`;
const { values } = parseArgs({
  options: {
    cli: { type: "string", default: join(root, "dist-native/fuigo", hostTarget, process.platform === "win32" ? "fuigo.exe" : "fuigo") },
    output: { type: "string", default: join(root, ".planning/fuigo-question-proof") },
    model: { type: "string", default: "claude-haiku-4-5" },
    "allow-provider": { type: "boolean", default: false },
    "keep-fixture": { type: "boolean", default: false },
  },
});
if (!values["allow-provider"]) throw new Error("This real-provider proof requires --allow-provider.");
const key = process.env.FLUX_API_KEY?.trim();
if (!key) throw new Error("FLUX_API_KEY must be in the environment; no credential file is read.");
const cli = resolve(values.cli);
if (!existsSync(cli)) throw new Error(`No staged engine at ${cli}; run node scripts/prepare-fuigo.mjs first.`);
const output = resolve(values.output);
mkdirSync(output, { recursive: true });

const owned = mkdtempSync(join(tmpdir(), "murage-fuigo-question-"));
const home = join(owned, "home");
const dataDir = join(home, ".murage");
const project = join(owned, "project");
const temp = join(owned, "tmp");
for (const path of [home, dataDir, project, temp]) mkdirSync(path, { recursive: true });

const receipt = {
  status: "BLOCKED",
  engine: { cli, target: hostTarget, pinnedVersion: FUIGO_VERSION },
  model: values.model,
  checks: {},
  turns: [],
};
const redact = (text) => String(text).split(key).join("[redacted]");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let base = "";
let desktop = {};
let harness = null;
let bot = null;
let serverLog = "";

async function api(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...desktop },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Fixture API ${method} ${path.split("?")[0]} returned ${response.status}: ${JSON.stringify(result).slice(0, 200)}`);
  return result;
}
const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`)).messages;
const busy = async () => Boolean((await api("GET", "/api/bots")).bots.find((row) => row.id === bot.id)?.busy);
const wireLog = () => {
  const path = join(dataDir, "native", `${bot.threadId}.ndjson`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
};
function failedTurn(rows) {
  return rows.find((m) => m.kind === "activity" && m.tool?.ok === false && /^error:/i.test(m.tool?.name ?? ""));
}
async function poll(check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (harness && (harness.exitCode !== null || harness.signalCode !== null)) throw new Error(`harness exited during ${label}`);
    const result = await check();
    if (result) return result;
    await pause(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const answeredPermissions = new Set();
/** Allow-once for the engine's own tool permission, exactly as the desktop
 * card would. Questions are never touched here: they must surface as
 * question cards and go through the answer path below. */
async function allowPendingPermission(rows, permitted) {
  const cards = rows.filter((m) => m.kind === "options" && typeof m.card?.requestId === "string"
    && typeof m.card?.tool === "string" && !m.card?.questions?.length && !m.card.answered && !answeredPermissions.has(m.card.requestId));
  for (const card of cards) {
    answeredPermissions.add(card.card.requestId);
    permitted.push({ tool: card.card.tool, title: card.card.title ?? null, subtitle: card.card.subtitle ?? null });
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  }
}

try {
  // 1. pinned engine, exact spawn shape
  verifyPinnedBinary(readFileSync(cli), hostTarget);
  const cleanEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, LANG: "en_US.UTF-8",
  };
  const version = execFileSync(cli, ["--version"], { env: cleanEnv, cwd: project, encoding: "utf8", timeout: 15_000 }).trim();
  receipt.engine.reportedVersion = version;
  assert(version.includes(`fuigo ${FUIGO_VERSION}`), `engine reported "${version}", expected fuigo ${FUIGO_VERSION}`);
  receipt.checks.pinnedVersion = true;

  // 2. isolated harness with one live Fuigo instance routed through Flux
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    engineDiscovery: "explicit",
    instances: {
      "fuigo-live": { driver: "fuigoAgent", displayName: "Fuigo live proof", config: { cli, workspace: project, fullAuto: false } },
    },
    features: { browser: false },
  }, null, 2));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  harness = spawn(process.execPath, ["--experimental-strip-types", join(root, "server", "index.ts")], {
    cwd: root,
    env: { ...cleanEnv, MURAGE_DATA_DIR: dataDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", FLUX_API_KEY: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  harness.stdout.on("data", (chunk) => (serverLog += chunk));
  harness.stderr.on("data", (chunk) => (serverLog += chunk));
  await poll(async () => { try { return (await api("GET", "/api/health")).app === "murage"; } catch { return false; } }, 30_000, "server health");
  const proof = await api("GET", "/api/desktop-secret");
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const created = await api("POST", "/api/bots", { name: `Fuigo asker ${randomUUID().slice(0, 8)}` });
  bot = created.bot;
  await api("PATCH", `/api/bots/${bot.id}`, {
    modelSelection: { instanceId: "fuigo-live", model: values.model },
    cwd: project, autoApprove: false, autoReview: "off", approvePeerComms: false, composio: false, browser: false, computer: "off",
  });
  receipt.checks.harnessUp = true;

  // 3. a real tool-using turn: write a canary file through the engine's tool
  const canary = `lfu2-${randomUUID()}`;
  const canaryFile = join(project, "probe.txt");
  const toolTurn = { kind: "tool", permitted: [] };
  await api("POST", `/api/bots/${bot.id}/messages`, {
    threadId: bot.threadId,
    text: `Use your file-writing tool to create a file named probe.txt in the current working directory containing exactly this text and nothing else: ${canary}\nThen read the file back with your file-reading tool and reply with only the text it contains. Do not ask me any questions.`,
  });
  await poll(async () => {
    const rows = await messages();
    const failure = failedTurn(rows);
    if (failure) throw new Error(`engine reported a failure during the tool turn: ${redact(failure.tool.name)}`);
    await allowPendingPermission(rows, toolTurn.permitted);
    return !(await busy()) && rows.some((m) => m.role === "bot" && m.kind === "text");
  }, 180_000, "tool turn");
  const afterTool = await messages();
  toolTurn.botText = afterTool.filter((m) => m.role === "bot" && m.kind === "text").map((m) => m.text ?? "").join("\n");
  toolTurn.fileOnDisk = existsSync(canaryFile) ? readFileSync(canaryFile, "utf8").trim() : null;
  toolTurn.toolCallsOnWire = wireLog().filter((row) => row.msg?.method === "session/update" && row.msg?.params?.update?.sessionUpdate === "tool_call")
    .map((row) => ({ title: row.msg.params.update.title ?? null, kind: row.msg.params.update.kind ?? null }));
  const wireAfterTool = wireLog();
  const permissionIndex = wireAfterTool.findIndex((row) => row.dir === "in" && row.msg?.method === "session/request_permission");
  if (permissionIndex >= 0) {
    const request = wireAfterTool[permissionIndex];
    const reply = wireAfterTool.slice(permissionIndex + 1).find((row) => row.dir === "out" && row.msg?.id === request.msg.id && row.msg?.result);
    toolTurn.permissionOnWire = {
      offered: (request.msg.params?.options ?? []).map((o) => ({ optionId: o.optionId, kind: o.kind })),
      selected: reply?.msg?.result?.outcome ?? null,
    };
    // a card "Yes" is one decision: the engine must get its one-time option,
    // never a standing "allow all edits this session" grant
    assert(toolTurn.permissionOnWire.selected?.optionId && (request.msg.params?.options ?? []).find((o) => o.optionId === toolTurn.permissionOnWire.selected.optionId)?.kind === "allow_once",
      `card allow selected ${JSON.stringify(toolTurn.permissionOnWire.selected)}, not the allow_once option`);
    receipt.checks.allowOnceNotSessionGrant = true;
  }
  receipt.turns.push(toolTurn);
  assert(toolTurn.fileOnDisk === canary, `canary file missing or wrong on disk (${JSON.stringify(toolTurn.fileOnDisk)})`);
  assert(toolTurn.botText.includes(canary), "bot reply did not contain the canary it read back");
  assert(toolTurn.toolCallsOnWire.length > 0, "no tool_call session/update seen on the wire");
  assert(toolTurn.permitted.length > 0, "no permission card was raised for the write; the turn ran unattended");
  receipt.checks.realToolTurn = true;
  receipt.checks.permissionCardNotAutoApproved = true;

  // 4. a real ask_user_question round trip
  const askTurn = { kind: "ask", permitted: [] };
  await api("POST", `/api/bots/${bot.id}/messages`, {
    threadId: bot.threadId,
    text: "Before doing anything else you must call your ask_user_question tool exactly once with two questions: (1) \"Which database?\" single-select with options \"Postgres\" and \"SQLite\"; (2) \"Which features?\" multi-select with options \"Auth\", \"Search\" and \"Billing\". Wait for my answers. Then reply with one line of the form: DB=<my database choice>; FEATURES=<my feature choices comma separated>; NOTES=<any note I added or none>. Do not use any other tool.",
  });
  const card = await poll(async () => {
    const rows = await messages();
    const failure = failedTurn(rows);
    if (failure) throw new Error(`engine reported a failure before asking: ${redact(failure.tool.name)}`);
    await allowPendingPermission(rows, askTurn.permitted);
    return rows.filter((m) => m.card?.questions?.length && !m.card.answered).at(-1);
  }, 180_000, "question card");
  askTurn.card = {
    requestId: card.card.requestId, title: card.card.title ?? null, tool: card.card.tool ?? null,
    questions: card.card.questions.map((q) => ({ id: q.id, question: q.question, multiSelect: q.multiSelect, allowOther: q.allowOther, options: (q.options ?? []).map((o) => o.label) })),
  };
  assert(card.card.questions.length === 2, `expected two questions on the card, got ${card.card.questions.length}`);
  const [dbQuestion, featureQuestion] = card.card.questions;
  assert(dbQuestion.options?.some((o) => o.label === "SQLite"), "first question is missing the SQLite option");
  assert(featureQuestion.multiSelect === true, "second question is not multi-select");
  assert(featureQuestion.options?.some((o) => o.label === "Auth") && featureQuestion.options?.some((o) => o.label === "Billing"), "second question is missing Auth/Billing");
  receipt.checks.askUserQuestionBecameCard = true;
  // Each engine process numbers its requests from 0, and the second turn is
  // a fresh process, so the reply is the first "out" row AFTER the request
  // with that id — matching on id alone would find the first turn's
  // permission reply.
  const wireAtAsk = wireLog();
  const askIndex = wireAtAsk.findIndex((row) => row.dir === "in" && row.msg?.method === "_fuigo/ask_user_question");
  assert(askIndex >= 0, "no _fuigo/ask_user_question request on the wire");
  const askRequest = wireAtAsk[askIndex];
  askTurn.wireRequestParamsKeys = Object.keys(askRequest.msg.params ?? {});
  askTurn.wireRequestQuestions = askRequest.msg.params?.questions ?? null;

  const answered = await api("POST", `/api/bots/${bot.id}/respond`, {
    requestId: card.card.requestId,
    behavior: "answer",
    answers: [
      { id: dbQuestion.id, selected: ["SQLite"] },
      { id: featureQuestion.id, selected: ["Auth", "Billing"], other: "proof note" },
    ],
  });
  askTurn.respond = answered;
  assert(answered.ok === true && answered.outcome === "answered", `respond returned ${JSON.stringify(answered)}`);
  await poll(async () => {
    const rows = await messages();
    const failure = failedTurn(rows);
    if (failure) throw new Error(`engine reported a failure after the answer: ${redact(failure.tool.name)}`);
    await allowPendingPermission(rows, askTurn.permitted);
    return !(await busy());
  }, 180_000, "answered turn to settle");
  const after = await messages();
  const answeredCard = after.find((m) => m.id === card.id);
  askTurn.cardAnswered = answeredCard?.card?.answered ?? null;
  askTurn.botText = after.slice(after.indexOf(answeredCard) + 1).filter((m) => m.role === "bot" && m.kind === "text").map((m) => m.text ?? "").join("\n");
  const askReply = wireLog().slice(askIndex + 1).find((row) => row.dir === "out" && row.msg?.id === askRequest.msg.id && row.msg?.result);
  askTurn.wireReply = askReply?.msg?.result ?? null;
  receipt.turns.push(askTurn);
  assert(askTurn.cardAnswered === "answer", `card did not settle as answered (${askTurn.cardAnswered})`);
  assert(askReply, "no reply to the ask request on the wire");
  assert(askTurn.wireReply.outcome === "accepted", `wire reply outcome ${JSON.stringify(askTurn.wireReply.outcome)}`);
  assert(JSON.stringify(askTurn.wireReply.answers?.[dbQuestion.question]) === JSON.stringify(["SQLite"]), "wire reply did not carry the SQLite pick keyed by question text");
  assert(JSON.stringify(askTurn.wireReply.answers?.[featureQuestion.question]) === JSON.stringify(["Auth", "Billing"]), "wire reply did not carry the multi-select picks");
  receipt.checks.answerDeliveredInFuigoShape = true;
  assert(/sqlite/i.test(askTurn.botText) && /auth/i.test(askTurn.botText) && /billing/i.test(askTurn.botText), `model did not repeat the picks: ${askTurn.botText.slice(0, 300)}`);
  assert(!/postgres|search/i.test(askTurn.botText.replace(/DB=|FEATURES=|NOTES=/g, "")) || /DB=SQLite/i.test(askTurn.botText), "model reported an option that was not picked");
  receipt.checks.modelActedOnAnswer = true;
  receipt.status = "ACCEPTED";
} catch (error) {
  receipt.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 600);
  process.exitCode = 1;
} finally {
  if (bot && harness && harness.exitCode === null) {
    try { await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); } catch { /* already idle */ }
  }
  if (harness) await waitForExit(harness, { signal: "SIGTERM", graceMs: 8000 });
  receipt.checks.harnessExited = !harness || harness.exitCode !== null || harness.signalCode !== null;
  if (bot) {
    const wire = join(dataDir, "native", `${bot.threadId}.ndjson`);
    if (existsSync(wire)) writeFileSync(join(output, "wire.ndjson"), redact(readFileSync(wire, "utf8")), { mode: 0o600 });
    try {
      // the server is down by now; the transcript lives in messages.db, copy it
      const db = join(dataDir, "messages.db");
      if (existsSync(db)) copyFileSync(db, join(output, "messages.db"));
    } catch { /* best effort */ }
  }
  writeFileSync(join(output, "server.log"), redact(serverLog), { mode: 0o600 });
  writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (!values["keep-fixture"]) await removeTempDir(owned);
  else receipt.retainedFixture = owned;
  process.stdout.write(`${JSON.stringify({ status: receipt.status, evidence: output, ...(receipt.error ? { error: receipt.error } : {}) })}\n`);
}
