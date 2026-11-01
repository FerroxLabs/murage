// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tool-name shapes the grant readers, the loaders and the card's fold all
// read: a question tool, a command tool, and the remembered keys over them
// that are never kept. Moved here from server/auto-approve.ts unchanged
// (1.0.13 L1a), so shared/durable-grant-allowed.ts and the client's fold use
// the same lists the verdict uses; server/auto-approve.ts re-exports them.

// Tools that ASK THE OWNER something. These are never permissions, however
// an engine happens to file them: the entire point of the call is that a
// person decides, so a machine answering one — auto mode, a remembered
// grant, or the AI reviewer — is not "approval", it is an invented answer.
// Claude Code's AskUserQuestion arrives through the permission host and was
// auto-approved with no answers at all, which the model reads as "The user
// did not answer the questions."
//
// Identity comes from what the ENGINE reports — Claude's `tool_name`, Codex's
// method, Fuigo's extension method, an ACP tool call's name — never from
// model prose. Unknown spellings fail CLOSED here: an unrecognized name is
// treated as an ordinary permission by the rules below, so this list is
// defense in depth behind each driver's own trusted signal, not the only gate.
const QUESTION_TOOLS = new Set([
  "askuserquestion",
  "askuser",
  "ask_user",
  "ask_user_question",
  "request_user_input",
  "requestuserinput",
  "question",
  "clarify",
  "elicitation",
  // full method identities, which have no useful last segment
  "item/tool/requestuserinput",
  "mcpserver/elicitation/request",
  "elicitation/create",
  "_fuigo/ask_user_question",
  "_fuigo/mcp/elicit",
]);

/** Is this the name of a tool that asks the owner a question?
 *
 * Matches the whole identity and its last segment, so an MCP-namespaced
 * (`mcp__box__ask_user`), dotted (`functions.request_user_input`) or
 * slash-separated method (`_fuigo/ask_user_question`) is recognized as the
 * same tool. */
export function isQuestionTool(tool: string): boolean {
  const bare = tool.trim().toLowerCase().replace(/^mcp__.+__/, "");
  if (QUESTION_TOOLS.has(bare)) return true;
  return QUESTION_TOOLS.has(bare.split(/[./]/).pop() ?? "");
}

/** Is this remembered "always allow" key a grant over a question tool?
 *
 * Older builds offered "Always allow" on a question (the key was the bare
 * tool name, optionally scoped), which would have handed every future
 * question to the machine permanently. Such a key is stripped at load and
 * refused at the grant routes; `autoVerdict` ignores it regardless. */
export function isQuestionGrant(key: string): boolean {
  return isQuestionTool(key.replace(/^local-computer:/, ""));
}

/** The tools that run a shell command, under any namespace or dotted name. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "exec_command", "run_command", "computer_exec", "terminal", "powershell", "pwsh"]);

/** A tool's own name with an MCP namespace and a dotted prefix taken off. */
export function bareToolName(tool: string): string {
  return tool.toLowerCase().replace(/^mcp__.+__/, "").split(".").pop()!;
}

/** Is this one of the tools that runs a shell command? */
export function isCommandTool(tool: string): boolean {
  return COMMAND_TOOLS.has(bareToolName(tool));
}

/** Is this remembered key a command tool's bare name (`PowerShell`, `Bash`,
 * `local-computer:PowerShell`)? A command tool's grant is keyed by program
 * (`PowerShell:git`), so a bare one would be a standing shell. 1.0.3 and
 * earlier wrote one for PowerShell, which was not read as a command tool:
 * such a key is dropped at load, refused at the grant routes, and answers
 * nothing in `autoVerdict` regardless. */
export function isBareCommandGrant(key: string): boolean {
  return isCommandTool(key.replace(/^local-computer:/, ""));
}
