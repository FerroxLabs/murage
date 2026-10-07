// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The "call the first custom tool" mode the fake engines share (MCP-LINK T15
// step 5). With FAKE_CUSTOM_TOOL_SERVER=<name> set, every turn of a fake engine
// does what a model asked to use one of the owner's own MCP servers would do:
// it starts that server exactly as the engine was handed it (command, args and
// the merged environment), initializes, lists the tools and calls the FIRST
// one, then reports the tool's text as its reply.
//
// FAKE_CUSTOM_TOOL_LOG gets one JSON line per call: the engine, the server, the
// tools listed, the call's text and error flag, the turn's prompt text, and the
// launch as the engine performed it (argv and the FULL environment the server
// process got, plus the engine's own argv). The end-to-end test reads that line
// and also greps it, with everything else under the run's temp directory, for
// the link server's tokens: none may ever reach an engine.
//
// Dependency-free apart from node built-ins: it runs inside the bare fakes.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export interface CustomToolLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CustomToolOutcome {
  tools: string[];
  tool?: string;
  text: string;
  isError: boolean;
}

/** The server the fakes call a tool on, or undefined when the mode is off. A
 * prompt naming `__custom_tool__:<name>` (its last such mention) picks another
 * server than the default for that turn. */
export function customToolServer(prompt = ""): string | undefined {
  const fallback = process.env.FAKE_CUSTOM_TOOL_SERVER;
  if (!fallback || !/^[a-z][a-z0-9_-]{0,31}$/.test(fallback)) return undefined;
  const named = [...prompt.matchAll(/__custom_tool__:([a-z][a-z0-9_-]{0,31})/g)].at(-1)?.[1];
  return named ?? fallback;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n") : "";
};

/** Start the server, call its first tool, and return what came back. Never throws. */
export function callFirstCustomTool(engine: string, name: string, launch: CustomToolLaunch, prompt = ""): Promise<CustomToolOutcome> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  Object.assign(env, launch.env);
  // The engine's per-turn tokens sit in the credential file the env names
  // (drivers/turn-credentials.ts), read here at launch as the proxy reads them.
  let turnSecrets: Record<string, string> = {};
  try { if (env.MURAGE_CRED_FILE) turnSecrets = JSON.parse(readFileSync(env.MURAGE_CRED_FILE, "utf8"))[env.MURAGE_CRED_SERVER ?? ""] ?? {}; } catch { /* no file */ }
  const done = (outcome: CustomToolOutcome): CustomToolOutcome => {
    const log = process.env.FAKE_CUSTOM_TOOL_LOG;
    if (log) {
      appendFileSync(log, `${JSON.stringify({
        engine, server: name, ...outcome, prompt,
        launch: { argv: [launch.command, ...launch.args], env, turnSecrets },
        engineArgv: process.argv,
      })}\n`);
    }
    return outcome;
  };
  return new Promise((resolve) => {
    let settled = false;
    let tools: string[] = [];
    let tool: string | undefined;
    const finish = (outcome: Omit<CustomToolOutcome, "tools">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 200).unref?.();
      resolve(done({ tools, ...(tool ? { tool } : {}), ...outcome }));
    };
    const child = spawn(launch.command, launch.args, { env, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => finish({ text: "custom tool: no answer in time", isError: true }), Number(process.env.FAKE_CUSTOM_TOOL_TIMEOUT_MS) || 90_000);
    child.on("error", (error) => finish({ text: `custom tool: could not start (${error.message})`, isError: true }));
    child.on("exit", () => finish({ text: "custom tool: the server closed", isError: true }));
    const send = (message: unknown) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* closed */ } };
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message: { id?: number; result?: { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>; isError?: boolean }; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish({ text: `custom tool: initialize failed (${message.error.message ?? ""})`, isError: true });
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (message.error) return finish({ text: message.error.message ?? "tools/list failed", isError: true });
          const listed = Array.isArray(message.result?.tools) ? message.result!.tools! : [];
          tools = listed.map((entry) => String(entry?.name ?? ""));
          const first = listed[0];
          if (!first?.name) return finish({ text: "custom tool: the server lists no tools", isError: true });
          tool = first.name;
          const args = first.inputSchema?.properties && "text" in first.inputSchema.properties ? { text: `hello from ${engine}` } : {};
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: first.name, arguments: args } });
        } else if (message.id === 3) {
          if (message.error) return finish({ text: message.error.message ?? "tools/call failed", isError: true });
          finish({ text: textOf(message.result), isError: message.result?.isError === true });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fake-${engine}`, version: "1" } } });
  });
}

/** The reply a fake gives after the call. */
export function customToolReply(outcome: CustomToolOutcome): string {
  return outcome.isError ? `custom tool failed: ${outcome.text}` : `custom tool said: ${outcome.text}`;
}
