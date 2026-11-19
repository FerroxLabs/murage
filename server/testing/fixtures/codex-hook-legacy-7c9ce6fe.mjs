// Murage pre-execution hook. Generated; do not edit.
import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DEADLINE_MS = 1728010000;
let hookEvent;
// The only exit 2: a SessionStart that cannot post (no proof), or a deny that could not be written at all (stdout gone).
const hardBlock = () => process.exit(2);
// Every printed decision is one synchronous write of the whole line, so nothing is left in a stream buffer at process.exit.
const print = (value) => {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  try { for (let at = 0; at < bytes.length;) { const n = writeSync(1, bytes, at, bytes.length - at); if (n === 0) return false; at += n; } return true; } catch { return false; }
};
const block = (why) => {
  const reason = "Murage blocked this call: " + String(why).slice(0, 300);
  try { writeSync(2, reason + "\n"); } catch {}
  // A Stop fails open: the turn ends as it would without this hook, and it never answers a tool call.
  if (hookEvent === "Stop" || hookEvent === "SubagentStop") process.exit(0);
  if (hookEvent === "SessionStart") hardBlock();
  // Any other call: the documented deny on stdout with a clean exit, which Codex blocks on whatever the shell does to an exit code
  // (Windows: Codex's PowerShell -Command wrapper turns exit 2 into 1, a non-blocking failure). Written synchronously.
  // A deny that could not be written (stdout gone) exits 2: Codex is not reading then, and on POSIX exit 2 is still a block.
  if (!print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })) hardBlock();
  process.exit(0);
};
try {
  const timer = setTimeout(() => block("the check took too long"), DEADLINE_MS);
  const chunks = [];
  if (Object.prototype.hasOwnProperty.call(globalThis, "MURAGE_HOOK_STDIN")) {
    if (!Buffer.isBuffer(globalThis.MURAGE_HOOK_STDIN)) block("invalid input cache");
    chunks.push(globalThis.MURAGE_HOOK_STDIN);
  } else {
    for await (const chunk of process.stdin) chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  hookEvent = input && input.hook_event_name;
  const here = dirname(globalThis.MURAGE_HOOK_FILE ?? fileURLToPath(import.meta.url));
  // The env file of the app-server that runs this hook, named in that process's environment (one file per process, never shared).
  const named = process.env.MURAGE_CODEX_HOOK_ENV;
  // The env file itself is resolved to its real, final path (a link that lands outside never matches), and that file must sit in this
  // scope's own hook-env/ folder, also by its real path, compared exactly. On Windows the same folder can be named by an 8.3 short
  // name (RUNNER~1), a junction or another letter case; the native real path is the name the file system holds, so the process's
  // own file matches, while a case-sensitive sibling (HOOK-ENV) or a link out of the folder does not.
  const real = (path) => { try { return realpathSync.native(path); } catch { return null; } };
  const ownDir = real(join(here, "hook-env"));
  if (!named || !named.endsWith(".env")) block("no socket");
  // The file is opened once (a link as its last name is refused where the OS allows it) and read only through that handle; the
  // handle must be the very file checked by its real path (same device and file id, on Windows the volume and file index), so a
  // swap before the check no longer matches and a swap after it is never read.
  let fd = -1;
  try { fd = openSync(resolve(named), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); } catch { block("no socket"); }
  const envFile = real(resolve(named));
  let sameFile = false;
  try {
    const checked = lstatSync(envFile, { bigint: true }), opened = fstatSync(fd, { bigint: true });
    sameFile = opened.isFile() && checked.isFile() && checked.dev === opened.dev && checked.ino === opened.ino;
  } catch {}
  if (!ownDir || !envFile || dirname(envFile) !== ownDir || !sameFile) block("no socket");
  const env = {};
  const envBytes = readFileSync(fd);
  if (createHash("sha256").update(envBytes).digest("hex") !== process.env.MURAGE_CODEX_HOOK_ENV_SHA256) block("changed socket file");
  for (const line of envBytes.toString("utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  if (!env.SOCKET || !env.TOKEN) block("no socket");
  const event = input.hook_event_name;
  const message = event === "SessionStart"
    ? { kind: "session", token: env.TOKEN, session_id: input.session_id }
    : event === "PreToolUse"
      ? { kind: "pretool", token: env.TOKEN, tool_name: input.tool_name, tool_input: input.tool_input, tool_use_id: input.tool_use_id, turn_id: input.turn_id, cwd: input.cwd }
      : event === "Stop" || event === "SubagentStop"
        ? { kind: "stop", token: env.TOKEN }
        : null;
  if (!message) block("unknown event");
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(env.SOCKET);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (d) => { data += d; const at = data.indexOf("\n"); if (at >= 0) { socket.destroy(); try { resolve(JSON.parse(data.slice(0, at))); } catch (e) { reject(e); } } });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the socket closed")));
  });
  clearTimeout(timer);
  if (event === "SessionStart") { if (!answer || answer.ok !== true) block("Murage could not confirm its tool check"); process.exit(0); }
  if (event === "Stop" || event === "SubagentStop") {
    // A printed block keeps the turn going with the reason as the model's next input; silence ends it.
    if (answer && answer.decision === "block" && typeof answer.reason === "string") print({ decision: "block", reason: answer.reason.slice(0, 2000) });
    process.exit(0);
  }
  if (answer && answer.decision === "allow") {
    // A plain allow prints nothing and exits 0: rig, Codex 0.163.0 lists a printed permissionDecision allow as "unsupported" and marks
    // the run failed, while a silent clean exit is a completed run and the call proceeds. Only a rewrite (Rule 73) prints.
    const out = { hookEventName: "PreToolUse", permissionDecision: "allow" };
    if (answer.updatedInput && typeof answer.updatedInput === "object") out.updatedInput = answer.updatedInput;
    if (typeof answer.additionalContext === "string") out.additionalContext = answer.additionalContext;
    if ((out.updatedInput || out.additionalContext) && !print({ hookSpecificOutput: out })) block("the answer could not be written");
    process.exit(0);
  }
  if (answer && answer.decision === "deny") {
    if (!print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(answer.reason ?? "Murage did not allow this call").slice(0, 2000) } })) hardBlock();
    process.exit(0);
  }
  block("no usable answer");
} catch (error) {
  block(error && error.message ? error.message : "failed");
}
