// Recording stub for the PIP headless text-only tests (Fuigo, Grok, Claude).
// Runs only under vitest: `node pip-stub-cli.mjs --stub=<scenario> --stub-out=<file> <real argv...>`.
// It appends one JSON record per invocation (argv, env, cwd, prompt, pid) and emits scripted lines.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const raw = process.argv.slice(2);
const stub = {};
const argv = [];
for (const a of raw) {
  const m = /^--(stub|stub-out|stub-delay)=(.*)$/.exec(a);
  if (m) stub[m[1]] = m[2]; else argv.push(a);
}
const scenario = stub.stub || "ok";
const after = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const promptFile = after("--prompt-file");
let prompt = null;
try { if (promptFile) prompt = readFileSync(promptFile, "utf8"); } catch { prompt = null; }
const ls = (d) => { try { return d ? readdirSync(d).sort() : null; } catch { return null; } };
const settingsArg = after("--settings");
let settingsContent = null;
try { if (settingsArg && !settingsArg.startsWith("{")) settingsContent = readFileSync(settingsArg, "utf8"); } catch { settingsContent = null; }
const record = (extra = {}) => appendFileSync(stub["stub-out"], JSON.stringify({ homeFiles: ls(process.env.FUIGO_HOME || process.env.GROK_HOME || process.env.CLAUDE_CONFIG_DIR), argv, env: process.env, cwd: process.cwd(), prompt, pid: process.pid, scenario, settingsContent, ...extra }) + "\n");
const engineHome = () => process.env.FUIGO_HOME || process.env.GROK_HOME || process.env.CLAUDE_CONFIG_DIR;
record();
if (after("--debug-file")) writeFileSync(after("--debug-file"), "text-only fixture started");

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const init = (extra = {}) => out({ type: "system", subtype: "init", session_id: "s1", tools: [], mcp_servers: [], ...extra });
const result = (extra = {}) => out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, structured_output: { ok: true }, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hang = (ms = 60000) => new Promise((r) => setTimeout(r, ms));

if (!promptFile) { // Claude shape: the prompt arrives on stdin
  let data = "";
  process.stdin.setEncoding("utf8");
  await new Promise((r) => { process.stdin.on("data", (c) => { data += c; }); process.stdin.on("end", r); process.stdin.on("error", r); });
  prompt = data;
  record({ stdin: data });
}

switch (scenario) {
  case "ok": init(); result(); break;
  case "debug-hook": writeFileSync(after("--debug-file"), "running hook from /external/hook.sh"); init(); result(); break;
  case "require-verbatim": init(); result({ structured_output: { ok: argv.includes("--verbatim") }, ...(argv.includes("--verbatim") ? {} : { is_error: true }) }); break;
  case "usage-before-abort": {
    process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100));
    init(); result(); record({ event: "usage-ready" }); await hang(); break;
  }
  case "slow-exit": init(); result(); await wait(600); break;
  case "no-init": result(); break;
  case "mcp": init({ mcp_servers: [{ name: "evil", status: "connected" }] }); result(); break;
  case "tools": init({ tools: ["Read"] }); result(); break;
  case "tool-call": init(); out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }); result(); break;
  case "agents-md": writeFileSync("AGENTS.md", "injected"); init(); result(); break;
  case "cancelled": init(); result({ subtype: "error_during_execution", is_error: true, errors: ["cancelled"], structured_output: undefined }); break;
  case "bad-schema": init(); result({ structured_output: { wrong: 1 } }); break;
  case "big": init(); process.stdout.write("x".repeat(20000) + "\n"); await hang(30000); break;
  case "late-first-byte": await wait(Number(stub["stub-delay"] || 1500)); init(); result(); break;
  case "ignore-term": {
    // Ignores SIGTERM for 2 s from the first signal, then exits.
    process.on("SIGTERM", () => { appendFileSync(stub["stub-out"], JSON.stringify({ event: "sigterm", at: Date.now() }) + "\n"); setTimeout(() => process.exit(0), 2000); });
    init();
    await hang();
    break;
  }
  case "unkillable-ish": { process.on("SIGTERM", () => {}); init(); await hang(); break; }
  case "sleep": await hang(); break;
  // What Fuigo and Grok really write at every start (fuigo-pager docs.rs, fuigo-active-sessions): inert engine artifacts.
  case "startup-artifacts": {
    const h = engineHome();
    mkdirSync(`${h}/docs/user-guide`, { recursive: true });
    writeFileSync(`${h}/docs/user-guide/01-intro.md`, "guide"); writeFileSync(`${h}/active_sessions.json`, "[]"); writeFileSync(`${h}/active_sessions.lock`, "");
    init(); result(); break;
  }
  case "home-instruction": writeFileSync(`${engineHome()}/CLAUDE.md`, "injected instructions"); init(); result(); break;
  case "root-file": writeFileSync(`${process.env.HOME}/.cache-note`, "x"); init(); result(); break;
  case "server-tool-use": init(); out({ type: "assistant", message: { content: [{ type: "server_tool_use", name: "web_search", input: {} }] } }); result(); break;
  case "malformed": init(); process.stdout.write("this is not json\n"); result(); break;
  case "no-is-error": init(); out({ type: "result", subtype: "success", stop_reason: "end_turn", structured_output: { ok: true } }); break;
  case "string-is-error": init(); result({ is_error: "false" }); break;
  case "result-first": result(); init(); break;
  case "text-result": init(); result({ structured_output: undefined, result: '{"ok":true}' }); break;
  case "helper": { // a same-group helper that outlives the root: the root exits, the helper stays
    const { spawn } = await import("node:child_process");
    const h = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" }); h.unref(); appendFileSync(stub["stub-out"], JSON.stringify({ event: "helper", pid: h.pid }) + "\n");
    init(); result(); break;
  }
  default: init(); result();
}
