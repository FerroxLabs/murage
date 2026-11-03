#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fake of `muse serve` (Muse Code's MSP host over stdio) and `muse --version`, for the driver tests of
// server/drivers/muse-code.ts. Speaks newline-delimited JSON-RPC 2.0 the way @muse-code/sdk's Connection expects:
// every command's result echoes its commandId, every error carries data.kind. It never contacts Meta and is never
// the real CLI. Knobs, all from the environment:
//
//   FAKE_MUSE_LOG          path: one JSON line per launch ({launch: argv, env}) and per request ({method, params})
//   FAKE_MUSE_TURN         reply (default) | hang | approval | change | question
//                          approval = one approval/requested with FAKE_MUSE_SUBJECT and FAKE_MUSE_CHOICES, then the
//                          turn completes once approval/decide arrives (the decide is logged)
//                          change   = a completed write_file tool call, then the turn hangs (the Ask stop must end it)
//                          question = one userInput/requested; completes on userInput/answer or userInput/cancel
//   FAKE_MUSE_SUBJECT      JSON approval subject (default a shell `rm -rf build`)
//   FAKE_MUSE_CHOICES      JSON choice list (default once, session, policy amendment, deny)
//   FAKE_MUSE_INTERRUPT    ack (default) | refuse | silent | confirm (ack, then turn/completed cancelled)
//   FAKE_MUSE_GRANT        comma list of capabilities initialize grants (default none)
//   FAKE_MUSE_MODELS       JSON rows for model/list (default one Wonder row and one Contributor row)
//   FAKE_MUSE_REFUSE_FLAG  a launch flag that makes the host exit 2 before initialize (an unknown switch)
//   FAKE_MUSE_EXIT_DELAY_MS / FAKE_MUSE_INIT_DELAY_MS  delays on stdin close and before the initialize answer
//   FAKE_MUSE_FAIL_APPROVAL_MODE  any value: session/setApprovalMode fails (invalidState)
//   FAKE_MUSE_DESCENDANT   any value: each `serve` starts a long-lived child that shares stdout/stderr, so the host's
//                          own exit does not close the pipes (logged as {descendant: pid})
//   FAKE_MUSE_HANG_SESSION_START  any value: session/start is logged and never answered (a session still being set up)
//   FAKE_MUSE_SESSION_START_DELAY_MS  session/start answers only after this delay (a late answer after Stop)
//   FAKE_MUSE_SERVED_MODEL  the modelId session/start reports, whatever was asked (Muse ignoring the requested model)
//   FAKE_MUSE_FAIL_SET_MODEL  any value: session/setModel fails (invalidParams)
// Like the real 1.4.14 host, session/start with no modelId runs on the Contributor default.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const argv = process.argv.slice(2);
const log = (entry: unknown) => { if (env.FAKE_MUSE_LOG) appendFileSync(env.FAKE_MUSE_LOG, `${JSON.stringify(entry)}\n`); };

if (argv[0] === "--version") {
  log({ launch: argv, env: watchedEnv() });
  process.stdout.write("muse 1.4.14-R7309.1\n");
  process.exit(0);
}

function watchedEnv(): Record<string, string | null> {
  const names = ["META_API_KEY", "MUSE_NO_AUTO_UPDATE", "MUSE_CONTRIBUTOR_MODE", "MUSE_DISABLE_APPROVAL_JUDGE", "OPENAI_API_KEY", "CLINE_API_KEY", "FLUX_API_KEY", "OPENAI_BASE_URL"];
  return Object.fromEntries(names.map((name) => [name, env[name] ?? null]));
}

log({ launch: argv, env: watchedEnv() });
if (env.FAKE_MUSE_REFUSE_FLAG && argv.includes(env.FAKE_MUSE_REFUSE_FLAG)) {
  process.stderr.write(`error: unexpected argument '${env.FAKE_MUSE_REFUSE_FLAG}'\n`);
  process.exit(2);
}
if (env.FAKE_MUSE_DESCENDANT && argv[0] === "serve") {
  const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  log({ descendant: held.pid });
}

const send = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const notify = (method: string, params: Record<string, unknown>) => send({ method, params });
const input = createInterface({ input: process.stdin });
if (env.FAKE_MUSE_EXIT_DELAY_MS) input.on("close", () => setTimeout(() => process.exit(0), Number(env.FAKE_MUSE_EXIT_DELAY_MS)));
else input.on("close", () => process.exit(0));

const DEFAULT_CHOICES = [
  { choiceId: "c-once", label: "Allow once", decision: "approved", scope: "once" },
  { choiceId: "c-session", label: "Allow for this session", decision: "approvedForSession", scope: "session" },
  { choiceId: "c-rule", label: "Always allow", decision: "approvedPolicyAmendment", scope: "localPersistent" },
  { choiceId: "c-deny", label: "Deny", decision: "denied", scope: "once" },
];
// The 1.4.14 catalog's shape (probe 3): the Contributor model is the one marked default.
const DEFAULT_MODELS = [
  { modelId: "muse-spark-1.3-contributor", displayLabel: "Muse Spark 1.3 Contributor", isDefault: true },
  { modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder 1.0", isDefault: false, contextLimit: 1_000_000 },
  { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isDefault: false },
];
let sessionCount = 0;
let current: { sessionId: string; turnId: string } | undefined;

const complete = (terminal: string) => {
  if (!current) return;
  const { sessionId, turnId } = current;
  current = undefined;
  notify("turn/completed", { sessionId, turnId, terminal });
};

input.on("line", (line) => {
  let frame: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { frame = JSON.parse(line); } catch { return; }
  const { id, method = "", params = {} } = frame;
  log({ method, params });
  if (id === undefined) return;
  const ok = (result: Record<string, unknown> = {}) => send({ id, result: { ...(params.commandId ? { commandId: params.commandId } : {}), ...result } });
  const fail = (kind: string, message: string) => send({ id, error: { code: -32000, message, data: { kind } } });
  if (method === "initialize") {
    const answer = () => send({ id, result: {
      schema: { fingerprint: "sha256:fake" }, experimentalApi: false, museHome: "/fake", platformFamily: "unix", platformOs: process.platform,
      serverInfo: { name: "muse", version: "1.4.14" },
      grantedCapabilities: (env.FAKE_MUSE_GRANT ?? "").split(",").filter(Boolean),
    } });
    if (env.FAKE_MUSE_INIT_DELAY_MS) setTimeout(answer, Number(env.FAKE_MUSE_INIT_DELAY_MS));
    else answer();
    return;
  }
  if (method === "model/list") return send({ id, result: { models: env.FAKE_MUSE_MODELS ? JSON.parse(env.FAKE_MUSE_MODELS) : DEFAULT_MODELS, providerId: "meta", profileId: null, source: "providerCatalog" } });
  if (method === "session/start" && env.FAKE_MUSE_HANG_SESSION_START) return;
  if (method === "session/start") {
    const answer = () => ok({ session: { sessionId: `s-${++sessionCount}`, modelId: env.FAKE_MUSE_SERVED_MODEL ?? params.modelId ?? "muse-spark-1.3-contributor" }, viewCursor: "v0" });
    if (env.FAKE_MUSE_SESSION_START_DELAY_MS) setTimeout(answer, Number(env.FAKE_MUSE_SESSION_START_DELAY_MS));
    else answer();
    return;
  }
  if (method === "session/setModel" && env.FAKE_MUSE_FAIL_SET_MODEL) return fail("invalidParams", "model refused");
  if (method === "session/resume") return params.sessionId === "s-gone" ? fail("sessionNotFound", "no such session") : ok({ session: { sessionId: params.sessionId } });
  if (method === "session/setApprovalMode" && env.FAKE_MUSE_FAIL_APPROVAL_MODE) return fail("invalidState", "approval mode refused");
  if (method === "turn/interrupt") {
    if (env.FAKE_MUSE_INTERRUPT === "refuse") return fail("invalidState", "interrupt refused");
    if (env.FAKE_MUSE_INTERRUPT === "silent") return;
    ok();
    if (env.FAKE_MUSE_INTERRUPT === "confirm") complete("cancelled");
    return;
  }
  if (method === "approval/decide") { ok(); complete("completed"); return; }
  if (method === "userInput/answer" || method === "userInput/cancel") { ok(); complete("completed"); return; }
  ok();
  if (method !== "turn/start") return;
  const sessionId = String(params.sessionId);
  const turnId = String(params.commandId);
  current = { sessionId, turnId };
  const mode = env.FAKE_MUSE_TURN ?? "reply";
  if (mode === "hang") return;
  if (mode === "approval") {
    notify("approval/requested", {
      sessionId, turnId, approvalId: "ap-1", itemId: "i-1", toolName: "shell", rawArgs: "{}", currentRequirementId: { sourceIndex: 0 },
      subject: env.FAKE_MUSE_SUBJECT ? JSON.parse(env.FAKE_MUSE_SUBJECT) : { kind: "shell", command: "rm -rf build", workspaceRoot: "/work" },
      availableChoices: env.FAKE_MUSE_CHOICES ? JSON.parse(env.FAKE_MUSE_CHOICES) : DEFAULT_CHOICES,
    });
    return;
  }
  if (mode === "change") {
    notify("item/started", { sessionId, item: { itemId: "t-1", kind: "toolCall", status: "inProgress", turnId, tool: "write_file", args: "{\"path\":\"b.txt\"}" } });
    notify("item/completed", { sessionId, item: { itemId: "t-1", kind: "toolCall", status: "completed", turnId, tool: "write_file", args: "{\"path\":\"b.txt\"}" } });
    return;
  }
  if (mode === "question") {
    notify("userInput/requested", { sessionId, turnId, userInputId: "q-1", toolName: "ask_user", questions: [
      { id: "city", header: "City", question: "Which city?", options: [{ label: "Pune" }, { label: "Mumbai" }], selection: { mode: "single" } },
    ] });
    return;
  }
  notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId, text: "hello" } });
  complete("completed");
});
