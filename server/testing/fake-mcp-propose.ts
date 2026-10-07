// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Fixture: what a Chief's engine does on the hidden New project proposal
// turn, driven through the REAL agents MCP server the driver mounted (the
// fake ACP, Codex and pi CLIs call this with the entry they were handed). It
// lists the tools, tries a teammate tool, tries a Murage route directly with
// the turn's own capability (a model that ignores the listing), sends one
// invalid proposal and then a valid one built from the prompt's eligible id
// map. Each observation is appended to FAKE_PROPOSE_LOG as one JSON line;
// the capability itself is never written anywhere.
//
// Dependency-free: it runs inside the fake CLIs as a bare node subprocess.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface McpServerEntry { command: string; args?: string[]; env?: Record<string, string> }

type Reply = { result?: { tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };

function session(server: McpServerEntry) {
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffered = "", next = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let nl;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      let message: Reply & { id?: number };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id === "number") waiting.get(message.id)?.(message);
    }
  });
  const call = (method: string, params: unknown) => new Promise<Reply>((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 60_000);
    waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, close: () => child.kill() };
}

/** The eligible id map inside the proposal prompt's quoted data block. */
function eligibleIds(prompt: string): string[] {
  const line = /\nBEGIN PROJECT DATA [a-f0-9]+\n(.*)\nEND PROJECT DATA/.exec(prompt)?.[1];
  try { return line ? (JSON.parse(line) as { eligibleMembers: Array<{ id: string }> }).eligibleMembers.map(entry => entry.id) : []; } catch { return []; }
}

/** The fixture Chief's proposal, built from the prompt's eligible ids. */
export function proposalFrom(prompt: string) {
  const ids = eligibleIds(prompt);
  return { members: ids, leadBotId: ids[0], mode: "goal", brief: { summary: "Fixture proposal", doneMeans: "A report", rules: "Be brief" }, budget: { minutes: 90, tokens: 2000000 }, planOutline: ["Read the brief", "Write the report"] };
}

/** `extra` joins the logged observations (the fake ACP adds its permission asks). */
export async function proposeThroughMcp(server: McpServerEntry, prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const mcp = session(server);
  try {
    await mcp.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-chief", version: "1" } });
    const tools = ((await mcp.call("tools/list", {})).result?.tools ?? []).map(tool => tool.name);
    const teammate = await mcp.call("tools/call", { name: "list_bots", arguments: {} });
    const harness = server.env?.MURAGE_HARNESS_URL ?? "";
    const direct = await fetch(`${harness}/api/internal/delegate-bot`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.env?.MURAGE_COMMS_TOKEN ?? ""}` },
      body: JSON.stringify({ botId: "anyone", message: "start work" }),
    }).then(async response => ({ status: response.status, body: await response.json().catch(() => null) }))
      .catch(error => ({ status: 0, body: { error: String(error) } }));
    const proposal = proposalFrom(prompt);
    const invalid = await mcp.call("tools/call", { name: "project_propose", arguments: { ...proposal, mode: "party" } });
    // Written before the valid call: once it lands, Murage ends this turn.
    const observed = {
      ...extra,
      role: server.env?.MURAGE_PROJECT_ROLE ?? null,
      tools,
      teammate: teammate.error?.message ?? teammate.result?.content?.[0]?.text ?? null,
      direct,
      invalid: { isError: invalid.result?.isError === true, text: invalid.result?.content?.[0]?.text ?? invalid.error?.message ?? null },
    };
    if (process.env.FAKE_PROPOSE_LOG) appendFileSync(process.env.FAKE_PROPOSE_LOG, JSON.stringify(observed) + "\n");
    const valid = await mcp.call("tools/call", { name: "project_propose", arguments: proposal });
    return valid.result?.isError ? `proposal refused: ${valid.result?.content?.[0]?.text ?? ""}` : "proposal sent";
  } finally {
    mcp.close();
  }
}

/** The owner's purpose inside the prompt's quoted data block. */
function ownerPurpose(prompt: string): string {
  const line = /\nBEGIN PROJECT DATA [a-f0-9]+\n(.*)\nEND PROJECT DATA/.exec(prompt)?.[1];
  try { return line ? String((JSON.parse(line) as { owner?: { purpose?: unknown } }).owner?.purpose ?? "") : ""; } catch { return ""; }
}

/** Lane N2: the fixture Chief's reply on a turn that answers with the
 * proposal block (every engine). It reads the block's nonce from the prompt's
 * instructions, as a model does. The owner's purpose steers it: "[malformed]"
 * writes a block that does not parse; "[echo]" repeats the owner's words and
 * writes no block of its own (an injection that hopes to be taken as the
 * Chief's); anything else writes a valid block between two notes. */
export function proposalReply(prompt: string): string {
  const open = /<murage-project-proposal nonce="[a-f0-9]{32}">/.exec(prompt.slice(0, prompt.indexOf("\nBEGIN PROJECT DATA")))?.[0] ?? "<no nonce in the instructions>";
  const close = "</murage-project-proposal>";
  const purpose = ownerPurpose(prompt);
  if (purpose.includes("[echo]")) return purpose;
  if (purpose.includes("[malformed]")) return `A report project fits. Ada leads.\n${open}\n{"members":["ada" "bex"]}\n${close}`;
  return `Here is my draft.\n${open}\n${JSON.stringify(proposalFrom(prompt))}\n${close}\nCheck the budget before you create it.`;
}

/** One observation of a block-only proposal turn, appended to FAKE_PROPOSE_LOG. */
export function logProposalTurn(observed: Record<string, unknown>): void {
  if (process.env.FAKE_PROPOSE_LOG) appendFileSync(process.env.FAKE_PROPOSE_LOG, JSON.stringify({ turn: "block", ...observed }) + "\n");
}
