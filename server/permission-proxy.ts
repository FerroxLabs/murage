import "../shared/win-hide-child-process.mjs";
import {exitWithChildIoReceipt} from "./io-child-receipts.ts";
import { learnProxyOwnerTurn, onProxyReleaseClose, sendProxyFrame, proxyOwnerTurn, proxyTransportLost, reserveProxyUpstream, processProxyRelease } from "./proxy-turn-release.ts";
import { OVERSIZE_PERMISSION_ANSWER_LINE, OVERSIZE_PERMISSION_ASK_LINE, OWNER_ENVELOPE_MAX, OWNER_ITEM_MAX, SNIFF_BYTES, itemCap } from "./owner-turn-caps.ts";
// permission-proxy — the MCP stdio server the claude CLI spawns for
// --permission-prompt-tool (ported from agentcal's runPermissionProxy;
// dedicated entry file, so there is no argv-dispatch fork-bomb hazard).
// Forwards each ask over a unix socket to the broker living in the
// Murage server and waits for the human's answer.
//
//   approve   — the CLI calls this for any tool use its permission mode
//               would deny; the answer is the --permission-prompt-tool
//               JSON contract ({behavior:"allow"|"deny", …}).
//   ask_user  — the agent can pose a question mid-run and wait; the
//               human's words come back verbatim.
//
// stdout is the MCP channel — never console.log here.
import { permissionAllowReply } from "./permission-reply.ts";
import { connect, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { BROKER_UNAVAILABLE_NOTE, brokerPathAccepted, brokerPathFromArgv } from "./permission-pipe.ts";

const socketPath = brokerPathFromArgv(process.argv[2] ?? "");

// Install the supervisor EOF seal even when this generation never needed a permission reply.
processProxyRelease("permission");

const waiting = new Map<string, (msg: any) => void>();
// U22: only Murage's own permission pipe or socket is ever connected to. Anything else is a broker that is gone: every ask is
// answered with the unavailable note, and the driver ends the turn with the reason in chat when it sees that note.
const accepted = brokerPathAccepted(socketPath);
const conn = accepted ? connect(socketPath) : new Socket();
if (!accepted) {
  // The supervisor may stop this process as soon as the terminal IPC notice
  // arrives. Finish this bounded count first; async stderr and IPC have no
  // cross-pipe flush ordering. A closed diagnostic pipe never prevents seal.
  try { writeSync(2, "permission refusals=1\n"); } catch { /* counts only */ }
  proxyTransportLost("permission");
  conn.destroy();
}

interface AllowPermissionResult {
  behavior: "allow";
  updatedInput?: object;
  updatedPermissions?: object[];
}
const dead = () => {
  proxyTransportLost("permission");
  for (const resolve of waiting.values()) {
    resolve({ behavior: "deny", message: BROKER_UNAVAILABLE_NOTE });
  }
  waiting.clear();
};
// A broker that cannot be reached is said once, on stderr (stdout is the MCP channel; the CLI shows a server's
// stderr when it fails, and the app log line comes from the driver, which sees the deny note in the tool result).
// A connect that never completes ends this process with that error instead of leaving the CLI waiting on a server
// that will never answer.
const CONNECT_DEADLINE_MS = 10_000;
const connectTimer = !accepted ? undefined : setTimeout(() => {
  proxyTransportLost("permission");
  process.stderr.write("permission timeouts=1\n");
  process.exit(1);
}, CONNECT_DEADLINE_MS);
connectTimer?.unref();
conn.once("connect", () => clearTimeout(connectTimer));
conn.on("error", () => {
  proxyTransportLost("permission");
  clearTimeout(connectTimer);
  process.stderr.write("permission failures=1\n");
  dead();
});
conn.on("close", dead);
// The release closing (refusal, transport loss) must not leave the broker socket holding the process open.
onProxyReleaseClose(() => conn.destroy());
// The release closing (refusal, transport loss) must not leave the broker socket holding the process open.

// Decode as a stream: a multi-byte character split across two reads must not
// become U+FFFD in an approved write (adapted from OpenMausBot #2387).
const brokerDecoder = new TextDecoder();
let brokerReads = Promise.resolve();
// One broker line as it arrives: its parts (never re-copied per read) and their size.
let lineParts: string[] = [], lineBytes = 0;
// cause22 caps: the rest of one answer of the owner's own turn that went over the 64 MiB ceiling is being discarded up to its
// newline. Only its first 64 KiB are kept, to name the ask it answers (the broker writes the id first).
let cutLine: { head: string } | undefined;
/** cause22 caps (ASTRA c0174cc11d High): one broker answer over the ceiling denies the one ask it answers, with a fixed line that is
 * NOT the broker-unavailable note (the driver ends the turn on that note). The socket, the mount and the turn stay as they were.
 * The ask is named by the id in the line's first 64 KiB; failing that it is the only ask waiting; failing that every waiting ask is
 * denied (none can be told apart, and none may wait for ever). */
const denyCutLine = (head: string) => {
  process.stderr.write("permission oversized=1\n");
  const named = [...head.matchAll(/"id"\s*:\s*"([^"\\]{1,128})"/g)].map(match => match[1]!).find(id => waiting.has(id));
  const ids = named !== undefined ? [named] : [...waiting.keys()];
  for (const id of ids) { waiting.get(id)?.({ behavior: "deny", message: OVERSIZE_PERMISSION_ANSWER_LINE }); waiting.delete(id); }
};
/** One complete broker line. False: the line is not an answer to a waiting ask, so the broker is treated as gone. */
const brokerLine = (line: string): boolean => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return false; }
  if (!(msg?.t === "answer" && typeof msg.id === "string" && waiting.has(msg.id))) return false;
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
  return true;
};
conn.on("data", (raw: Buffer) => {
  conn.pause();
  brokerReads = brokerReads.then(async () => {
  await reserveProxyUpstream("permission", raw.byteLength);
  let chunk = brokerDecoder.decode(raw, { stream: true });
  // cause22 caps: 8 MiB for every turn but the owner's own (the reserve just answered says whose), where the 64 MiB ceiling applies.
  // Over the ceiling the owner's turn is not ended either: that one answer is cut and its ask denied (denyCutLine).
  const owner = proxyOwnerTurn();
  if (!owner && (cutLine !== undefined || lineBytes + Buffer.byteLength(chunk) > 8 * 1024 * 1024)) { dead(); conn.destroy(); return; }
  for (;;) {
    const nl = chunk.indexOf("\n");
    const piece = nl === -1 ? chunk : chunk.slice(0, nl);
    if (cutLine) {
      if (nl === -1) break;
      denyCutLine(cutLine.head); cutLine = undefined;
    } else {
      lineParts.push(piece); lineBytes += Buffer.byteLength(piece);
      if (lineBytes > itemCap(owner, 8 * 1024 * 1024)) {
        const head = lineParts.join("").slice(0, SNIFF_BYTES);
        lineParts = []; lineBytes = 0;
        if (nl === -1) { cutLine = { head }; break; }
        denyCutLine(head);
      } else {
        if (nl === -1) break;
        const line = lineParts.length === 1 ? lineParts[0]! : lineParts.join("");
        lineParts = []; lineBytes = 0;
        if (!brokerLine(line)) { dead(); conn.destroy(); return; }
      }
    }
    chunk = chunk.slice(nl + 1);
  }
  conn.resume();
  }).catch(() => { dead(); conn.destroy(); });
});

const send = (obj: unknown) => sendProxyFrame("permission", obj);

const TOOLS = [
  {
    name: "approve",
    description: "Ask the Murage user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential: do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, with enough context to answer at a glance" },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-5 suggested answers, shown as one-tap buttons",
        },
      },
      required: ["question"],
    },
  },
];

export async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "murage-permissions", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const askId = randomUUID();
    const isQuestion = name === "ask_user";
    // Claude Code routes its own AskUserQuestion tool through this permission
    // host (it never auto-approves it in any mode). The CLI names the tool,
    // so this is a trusted signal, not model text: it is a QUESTION for the
    // owner, never a permission a rule or a reviewer may answer.
    const isClaudeQuestion = name === "approve" && args.tool_name === "AskUserQuestion";
    // the CLI may include its own suggested permission rules; on allow we
    // hand them straight back as updatedPermissions so claude stops asking
    // at its own layer — no invented rule syntax (agentcal)
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    const ask = isQuestion
      ? { t: "ask", id: askId, kind: "question", tool: "ask_user", input: { question: args.question, choices: args.choices } }
      : isClaudeQuestion
        ? { t: "ask", id: askId, kind: "question", tool: "AskUserQuestion", input: args.input }
        : { t: "ask", id: askId, tool: args.tool_name, input: args.input };
    const askLine = JSON.stringify(ask) + "\n";
    // cause22 caps: on the owner's own turn an ask over the 64 MiB ceiling is never sent (the broker would skip it or close the socket
    // on it, and a closed socket ends the turn): this one call is denied here with a fixed note and the turn continues. The door is
    // asked first when it has not said yet whose turn this is. Every other turn: sent as before.
    const tooLarge = Buffer.byteLength(askLine) > OWNER_ITEM_MAX && await learnProxyOwnerTurn("permission");
    if (tooLarge) process.stderr.write("permission oversized=1\n");
    const answer: any = tooLarge ? { behavior: "deny", message: OVERSIZE_PERMISSION_ASK_LINE } : await new Promise((resolve) => {
      waiting.set(askId, resolve);
      if (conn.destroyed) return dead();
      try {
        conn.write(askLine);
      } catch {
        dead();
      }
    });
    let text = answer.message || "The owner did not answer. Do not assume an answer.";
    if (isClaudeQuestion) {
      // Claude reads the owner's picks from updatedInput.answers, keyed by
      // question text (the broker already built that map). Anything else —
      // a skip, a timeout, the turn ending — is an honest deny with a note:
      // an allow without answers would make Claude report "The user did not
      // answer the questions." as if that were the owner's choice.
      const answers = answer.answers && typeof answer.answers === "object" && !Array.isArray(answer.answers) ? answer.answers : null;
      text =
        answer.behavior === "answer" && answers && Object.keys(answers).length
          ? JSON.stringify({ behavior: "allow", updatedInput: { ...args.input, answers } })
          : JSON.stringify({ behavior: "deny", message: answer.message || "The owner did not answer. Do not assume an answer." });
    } else if (!isQuestion) {
      if (answer.behavior === "allow") {
        // Rule 69e: the allow carries the call as judged, or the narrowed call the broker sends.
        // No input is never replaced by `{}` (F5): without one nothing was judged, so it is a deny.
        const judged = answer.updatedInput && typeof answer.updatedInput === "object" && !Array.isArray(answer.updatedInput) ? answer.updatedInput : args.input;
        if (!judged || typeof judged !== "object" || Array.isArray(judged)) {
          return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "Murage: the call carried no input to judge" }) }] } });
        }
        // Managed settings can retain a low MCP cap. Echoing an unchanged Write
        // can turn an allow into a persisted-output notice instead of permission.
        const result: AllowPermissionResult = permissionAllowReply(args.input, judged);
        if (answer.always && suggestions) result.updatedPermissions = suggestions;
        text = JSON.stringify(result);
      } else {
        text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from Murage" });
      }
    }
    // cause22 caps r3: the decision is JSON inside the reply's JSON, so an answer that passed the 64 MiB line ceiling can be over it
    // once escaped (quotes and backslashes double). Downstream such a frame is swapped for a tool error; this is a permission answer,
    // so on the owner's own turn this ONE call is denied here with the fixed note instead. Every other turn: sent as before.
    if (text.length > 8 * 1024 * 1024) {
      const frame = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      if ((Buffer.byteLength(frame) > OWNER_ITEM_MAX || Buffer.byteLength(JSON.stringify(frame)) > OWNER_ENVELOPE_MAX - 2048) && await learnProxyOwnerTurn("permission")) {
        process.stderr.write("permission oversized=1\n");
        text = JSON.stringify({ behavior: "deny", message: OVERSIZE_PERMISSION_ANSWER_LINE });
      }
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

process.stdin.setEncoding("utf8");
let inBuf = "";
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => void exitWithChildIoReceipt(0));
