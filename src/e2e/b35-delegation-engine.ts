// B35-DELEGATION fixture engine. Fixture-only: it writes a task-owned copy of
// server/testing/fake-claude-cli.ts into a harness root, with three last-line
// prompt markers inserted immediately before the unique ask-user-question
// anchor line. The shared fake CLI is never modified.
//
//   __fixture_b35_create__:<team>      the parent calls the real mounted
//                                      agents MCP server: create_bot, lead:true
//   __fixture_b35_delegate__:<botId>   the parent calls agents delegate_bot with
//                                      no reason, so the child marker stays on
//                                      the drained prompt's last line
//                                      (server/delegations.ts:643-644)
//   __fixture_b35_child__              the delegated child logs its own agents
//                                      identity, then asks for one Bash
//                                      permission through the real
//                                      --permission-prompt-tool and logs the
//                                      decision it received
//
// The engine log (FAKE_B35_LOG, JSONL) records only whitelisted identity keys
// (MURAGE_BOT_ID, MURAGE_THREAD_ID, MURAGE_TURN_DEPTH). It never records the
// comms token, the MCP config or an environment dump.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../../scripts/channel-live-harness.ts";

/** The unique line the block is inserted before (fake-claude-cli.ts:557). */
export const B35_ANCHOR = 'if (mode === "ask-user-question" || fixtureRequested(';
export const B35_CREATE_MARKER = "__fixture_b35_create__";
export const B35_DELEGATE_MARKER = "__fixture_b35_delegate__";
export const B35_CHILD_MARKER = "__fixture_b35_child__";
export const B35_CHILD_NAME = "B35 Specialist";
export const B35_CHILD_TASK = `B35 child task: request approval for the fictional action.\n${B35_CHILD_MARKER}`;
export const B35_ACTION = "fixture_b35_delegated_action_no_execution";
export const B35_LOG_NAME = "b35-engine.jsonl";
export const B35_CLI_NAME = "b35-delegation-claude.ts";

export type B35Identity = { MURAGE_BOT_ID?: string; MURAGE_THREAD_ID?: string; MURAGE_TURN_DEPTH?: string };
export interface B35LogEntry {
  pid: number;
  role: "parent-create" | "parent-delegate" | "child-asked" | "child-decision" | "fixture-error";
  env?: B35Identity;
  team?: string;
  botId?: string;
  text?: string;
  isError?: boolean;
  taskId?: string | null;
  delegatedBy?: string | null;
  delegatedPrefix?: string | null;
  decision?: { behavior?: string; message?: string; updatedPermissions?: unknown };
  marker?: string;
  error?: string;
}

/** Helpers the inserted block reuses from the fake CLI instead of duplicating. */
const REQUIRED_HELPERS = [
  'import { spawn } from "node:child_process";',
  "const argAfter = ",
  "const out = ",
  "const fixtureRequested = ",
  "const promptText = ",
  "const callPermissionPromptTool = ",
  "const finishIfDone = ",
  "let turnRunning = ",
  "const playTurn = (prompt: JsonValue) => {",
];

// Emitted verbatim into the copy (String.raw keeps its escapes intact). Only
// the ${...} holes below are filled here, and each is a JSON string literal.
const block = () => String.raw`  // ── B35-DELEGATION fixture: inserted by src/e2e/b35-delegation-engine.ts into a task-owned copy ──
  {
    const B35_CREATE = ${JSON.stringify(B35_CREATE_MARKER)};
    const B35_DELEGATE = ${JSON.stringify(B35_DELEGATE_MARKER)};
    const B35_CHILD = ${JSON.stringify(B35_CHILD_MARKER)};
    const b35Text = promptText(prompt);
    const b35LastLine = b35Text.trimEnd().split("\n").pop() ?? "";
    const b35Marker = fixtureRequested(b35Text, B35_CREATE) ? B35_CREATE
      : fixtureRequested(b35Text, B35_DELEGATE) ? B35_DELEGATE
        : fixtureRequested(b35Text, B35_CHILD) ? B35_CHILD : null;
    if (b35Marker) {
      const b35Argument = () => b35LastLine.slice(b35LastLine.indexOf(b35Marker) + b35Marker.length).replace(/^:/, "").trim();
      const b35Log = (entry: Record<string, unknown>) => {
        const file = process.env.FAKE_B35_LOG;
        if (!file) throw new Error("FAKE_B35_LOG is required by the B35 delegation fixture");
        appendFileSync(file, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
      };
      const b35McpServers = (): Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> => {
        const configPath = argAfter("--mcp-config");
        return configPath ? (JSON.parse(readFileSync(configPath, "utf8")).mcpServers ?? {}) : {};
      };
      // Whitelisted identity keys only: never MURAGE_COMMS_TOKEN, the config or an env dump.
      const b35Identity = () => {
        const env = b35McpServers().agents?.env ?? {};
        return { MURAGE_BOT_ID: env.MURAGE_BOT_ID, MURAGE_THREAD_ID: env.MURAGE_THREAD_ID, MURAGE_TURN_DEPTH: env.MURAGE_TURN_DEPTH };
      };
      // A generic MCP tool call, the same stdio JSON-RPC exchange
      // callPermissionPromptTool makes, but for any server in --mcp-config.
      const b35CallMcpTool = (serverName: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
        const server = b35McpServers()[serverName];
        if (!server || typeof server.command !== "string") return Promise.reject(new Error("MCP server " + serverName + " is not mounted"));
        return new Promise((resolve, reject) => {
          const child = spawn(server.command!, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
          let buffered = "";
          let settled = false;
          const send = (message: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n"); };
          const finish = (error: Error | null, value?: { text: string; isError: boolean }) => {
            if (settled) return;
            settled = true;
            if (!child.stdin.destroyed) child.stdin.end();
            if (error) reject(error);
            else resolve(value!);
          };
          child.stdin.on("error", () => {});
          child.on("error", (error) => finish(error));
          child.on("exit", (code) => finish(new Error("MCP server " + serverName + " exited before answering (" + String(code) + ")")));
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            buffered += chunk;
            let nl;
            while ((nl = buffered.indexOf("\n")) !== -1) {
              const line = buffered.slice(0, nl);
              buffered = buffered.slice(nl + 1);
              let message: { id?: number; error?: { message?: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
              try {
                message = JSON.parse(line);
              } catch {
                continue;
              }
              if (message.id === 1) {
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
              } else if (message.id === 2) {
                if (message.error) finish(new Error(String(message.error.message ?? "MCP error")));
                else finish(null, { text: String(message.result?.content?.[0]?.text ?? ""), isError: message.result?.isError === true });
              }
            }
          });
          send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude-b35", version: "1" } } });
        });
      };
      const b35Reply = (text: string, isError = false) => {
        out({ type: "assistant", message: { content: [{ type: "text", text }] } });
        out({ type: "result", is_error: isError, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
        turnRunning = false;
        finishIfDone();
      };
      void (async () => {
        try {
          if (b35Marker === B35_CREATE) {
            const team = b35Argument();
            const result = await b35CallMcpTool("agents", "create_bot", {
              name: ${JSON.stringify(B35_CHILD_NAME)},
              role: "Fixture specialist",
              instructions: "Fictional B35 fixture specialist. It performs no real work.",
              section: team,
              lead: true,
            });
            b35Log({ role: "parent-create", team, text: result.text, isError: result.isError, env: b35Identity() });
            b35Reply("B35 create: " + result.text);
          } else if (b35Marker === B35_DELEGATE) {
            const botId = b35Argument();
            if (!/^[\w-]+$/.test(botId)) throw new Error("the delegate marker needs a bot id");
            // No reason: a reason line would follow the child marker and hide it.
            const result = await b35CallMcpTool("agents", "delegate_bot", { bot_id: botId, message: ${JSON.stringify(B35_CHILD_TASK)} });
            b35Log({ role: "parent-delegate", botId, text: result.text, isError: result.isError, taskId: /Task id: ([\w-]+)/.exec(result.text)?.[1] ?? null, env: b35Identity() });
            b35Reply("B35 delegate: " + result.text);
          } else {
            const delegated = [...b35Text.matchAll(/\[Delegated by @([^,\]\n]+),/g)].at(-1);
            // Logged before asking, so the spec sees the ask while the card is pending.
            b35Log({ role: "child-asked", env: b35Identity(), delegatedBy: delegated?.[1] ?? null, delegatedPrefix: delegated ? "[Delegated by @" + delegated[1] : null });
            const reply = await callPermissionPromptTool({
              tool_name: "Bash",
              input: { command: ${JSON.stringify(B35_ACTION)} },
              tool_use_id: "b35-child-permission",
              permission_suggestions: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash" }] }],
            });
            if (reply === null) throw new Error("Missing permission prompt tool");
            const decision = JSON.parse(reply) as { behavior?: string; message?: unknown; updatedPermissions?: unknown };
            b35Log({ role: "child-decision", decision: {
              behavior: decision.behavior,
              ...(typeof decision.message === "string" ? { message: decision.message } : {}),
              ...(decision.updatedPermissions !== undefined ? { updatedPermissions: decision.updatedPermissions } : {}),
            } });
            b35Reply("B35 child decision: " + String(decision.behavior));
          }
        } catch (error) {
          b35Log({ role: "fixture-error", marker: b35Marker, error: error instanceof Error ? error.message : String(error) });
          b35Reply("B35 fixture error", true);
        }
      })();
      return;
    }
  }`;

/** The fake CLI source with the B35 block inserted before its unique anchor line. */
export function b35DelegationEngineSource(source: string): string {
  const lines = source.split("\n");
  const anchors = lines.flatMap((line, index) => (line.includes(B35_ANCHOR) ? [index] : []));
  if (anchors.length !== 1) throw new Error(`fake CLI insertion anchor must occur exactly once (found ${anchors.length})`);
  const missing = REQUIRED_HELPERS.filter((helper) => !source.includes(helper));
  if (missing.length) throw new Error(`fake CLI no longer provides ${missing.join(", ")}`);
  const fsImport = /^import \{([^}]*)\} from "node:fs";$/m.exec(source)?.[1] ?? "";
  if (!/\bappendFileSync\b/.test(fsImport) || !/\breadFileSync\b/.test(fsImport)) throw new Error("fake CLI no longer imports appendFileSync and readFileSync");
  if (source.includes("__fixture_b35_")) throw new Error("fake CLI already carries B35 delegation markers");
  const at = anchors[0]!;
  return [...lines.slice(0, at), ...block().split("\n"), ...lines.slice(at)].join("\n");
}

/** Write `<root>/b35-delegation-claude.ts` (0700) and return its path. */
export function writeB35DelegationCli(root: string, source = readFileSync(join(ROOT, "server", "testing", "fake-claude-cli.ts"), "utf8")): string {
  const target = join(root, B35_CLI_NAME);
  writeFileSync(target, b35DelegationEngineSource(source), { mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
}

export function readB35Log(file: string): B35LogEntry[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as B35LogEntry) : [];
}
