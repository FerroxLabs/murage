// LIVE CHECK (0.1.52 ASK2): one real Claude Code turn that calls
// AskUserQuestion, answered through Murage's own question path, proving the
// model receives the chosen label and carries on with it.
//
// Everything below the HTTP route is the shipping code: the real
// server/permission-proxy.ts spawned by the real claude binary through
// --permission-prompt-tool, talking to the real createPermissionBroker from
// server/drivers/claude.ts. The answer is delivered exactly the way
// respondToRequest delivers the card's answer: broker.answer(id, "answer",
// undefined, answers).
//
// Isolated: its own scratch cwd and its own broker socket. It never touches
// ~/.murage and starts no Murage server. It needs the `claude` binary on PATH
// and whatever login that binary already has — no API key of its own.
//
//   node scripts/verify-question-claude.ts
//
// Passes only if the model is told "Your questions have been answered" with
// the label that was picked, and then acts on it.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPermissionBroker } from "../server/drivers/claude.ts";
import { SPAWNED_PROXIES } from "../server/proxy-paths.ts";
import { toClaudeAnswers, validateAnswers } from "../server/question-normalize.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const scratch = mkdtempSync(join(tmpdir(), "murage-live-auq-"));
const socketPath = join(scratch, "b.sock");
const mcpConfigPath = join(scratch, "mcp.json");
const PICK = "Detailed";

const fail = (why: string): never => {
  console.error(`LIVE CHECK FAILED: ${why}`);
  process.exit(1);
};

let asked: unknown = null;
let delivered: unknown = null;

const broker = await createPermissionBroker({
  socketPaths: [socketPath],
  isActive: () => true,
  onAsk: (ask) => {
    console.log("\n--- request.opened would carry ---");
    console.log(JSON.stringify({ kind: ask.kind, tool: ask.tool, questions: ask.questions }, null, 2));
    if (ask.kind !== "question") fail(`the ask arrived as ${ask.kind}, not a question`);
    if (!ask.questions?.length) fail("the ask carried no normalized questions");
    asked = ask.questions;
    // exactly what the card does: pick a label, validate it against the
    // questions that were shown, hand it to the broker
    const answers = ask.questions!.map((question) => ({
      id: question.id,
      selected: [question.options.find((option) => option.label === PICK)?.label ?? question.options.at(-1)!.label],
    }));
    const checked = validateAnswers(ask.questions!, answers);
    if (!checked.ok) fail(`the answer did not validate: ${checked.error}`);
    delivered = toClaudeAnswers(ask.questions!, checked.answers);
    console.log("--- answering with ---");
    console.log(JSON.stringify(delivered, null, 2));
    if (!broker.answer(ask.id, "answer", undefined, checked.answers)) fail("the broker refused the answer");
  },
  onResolve: (resolved) => console.log(`--- resolved: ${resolved.behavior} (${resolved.source}) ---`),
});

writeFileSync(
  mcpConfigPath,
  JSON.stringify({
    mcpServers: {
      muragebox: { command: process.execPath, args: [SPAWNED_PROXIES.permission, broker.socketPath], env: { ELECTRON_RUN_AS_NODE: "1" } },
    },
  }),
  { mode: 0o600 },
);

const child = spawn(
  "claude",
  [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--permission-prompt-tool", "mcp__muragebox__approve",
    "--mcp-config", mcpConfigPath,
    "--allowedTools", "mcp__muragebox",
  ],
  { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] },
);

let toolResult = "";
let finalText = "";
let buffered = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let frame: any;
    try { frame = JSON.parse(line); } catch { continue; }
    for (const block of frame.message?.content ?? []) {
      if (block.type === "tool_result") {
        toolResult += typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
      if (block.type === "text" && frame.type === "assistant") finalText += block.text;
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));

child.stdin.write(
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        "Call the AskUserQuestion tool exactly once, with exactly one question: " +
        '"Which format should the report use?" with the two options "Summary" and "Detailed". ' +
        "Give each option a one-line description. Do not use any other tool. " +
        "As soon as you have my answer, reply with exactly one line: CHOSEN=<the label I picked>",
    },
  }) + "\n",
);
child.stdin.end();

const code: number = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? -1)));

console.log("\n=== model-visible tool_result ===");
console.log(toolResult || "(none)");
console.log("=== final assistant text ===");
console.log(finalText.trim() || "(none)");

broker.close();
safeWipeSync(scratch);

if (!asked) fail("Claude never called AskUserQuestion through the permission host");
if (!toolResult.includes("Your questions have been answered")) {
  fail(`the model did not receive the answers. tool_result was: ${toolResult}`);
}
if (toolResult.includes("The user did not answer the questions")) fail("the model was told nobody answered");
if (!toolResult.includes(PICK)) fail(`the chosen label "${PICK}" never reached the model`);
if (!finalText.includes(`CHOSEN=${PICK}`)) fail(`the model did not continue with the chosen label. It said: ${finalText}`);

console.log(`\nLIVE CHECK PASSED (exit ${code})`);
console.log(`  the owner picked: ${PICK}`);
console.log(`  delivered as:     ${JSON.stringify(delivered)}`);
console.log(`  the model replied: ${finalText.trim()}`);
