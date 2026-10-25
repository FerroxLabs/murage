// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an approval asks for, in plain words.
//
// The card's text (`subtitle`) is what the engine sent: a tool's whole input
// as JSON, a shell line, or a list of paths. That stays on the card, exactly
// as sent, behind "Show details". This file reads it and says the action the
// way a person would ("use Gmail to send email", "change notes.md", "hand a
// task to another bot") with the few facts an owner decides on (who it goes
// to, which file, which site) as short lines underneath.
//
// It reads only what is already on the card, so the approval digest that
// binds an Allow to the card on screen is unchanged. It never makes an action
// sound safer than it is: a shell line is called "read …" only when the strict
// read-only parser (shared/readonly-shell.ts) accepts all of it, and anything
// it does not recognise is "run a command on your computer" or "use a tool".
// Copy rules: plain words, no dashes as punctuation, never the name of the
// connection service behind connected apps.
import { connectedAppActions } from "./connected-app-calls.ts";
import { plainConnectedAppText } from "./connected-app-tools.ts";
import { parseReadOnlyCommand } from "./readonly-shell.ts";

export interface PlainApproval {
  /** Completes "<Bot> wants to …": lower-case, no full stop. */
  action: string;
  /** Short facts under the headline ("To: ana@example.com"). */
  lines: string[];
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The label the server puts before the model's own reason (server/approval-text.ts). */
const REASON_MARK = "\n\nModel's reason: ";
const CUT_MARK = /\n\[truncated, \d+ bytes more\]$/;

const SHELL_TOOLS = new Set(["bash", "shell", "execute", "powershell", "run_terminal_cmd", "run_terminal_command", "exec_command", "run_command", "terminal"]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file", "write_text_file"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "edit_file", "notebookedit", "str_replace", "str_replace_editor", "apply_patch"]);
const READ_TOOLS = new Set(["read", "read_file", "read_text_file", "view", "view_file"]);
const DELETE_TOOLS = new Set(["delete", "delete_file", "remove_file"]);

/** Murage's own tools, said as a person would say them. */
const MURAGE_TOOLS: Record<string, string> = {
  generate_image: "make an image",
  send_voice_note: "send you a voice note",
  register_artifact: "save a file to Files",
  publish_site: "publish a website",
  take_down_site: "take a website down",
  create_bot: "create a new bot",
  update_bot: "change a bot's settings",
  propose_routine: "schedule a routine",
  propose_routine_action: "change a routine",
  skill_manage: "change a skill",
  request_credential: "ask you for a sign-in detail",
  add_mcp_server: "add a connected tool server, switched off",
  request_browser_connection: "connect to your browser",
  request_bot_access: "ask for access to another bot",
  web_search: "search the web",
  // Murage's own reads, named when an engine asks for them (an ACP engine
  // files every MCP call through its dispatcher)
  list_bots: "see your bots",
  get_bot: "look at one of your bots",
  list_routines: "see your routines",
  skills_list: "see its skills",
  murage_help: "look up how Murage works",
  memory_search: "search its memory",
  memory_get: "read from its memory",
  memory_save: "save a note to its memory",
  memory_propose_correction: "suggest a fix to its memory",
  thread_search: "search past conversations",
  thread_list: "list past conversations",
  thread_read: "read a past conversation",
};

/** A dispatcher's call (Fuigo's and Grok Build's `use_tool`: `{variant,
 * tool_name, tool_input}`): the tool it runs and that tool's arguments, so
 * the card names the real tool, never "Variant: UseTool". Anything with
 * another field, or without exactly one name and one object input, is not
 * opened. */
function dispatched(input: Json): { name: string; input: Json } | undefined {
  const names = ["tool_name", "toolName"].filter((key) => input[key] !== undefined);
  const inputs = ["tool_input", "toolInput"].filter((key) => input[key] !== undefined);
  if (names.length !== 1 || inputs.length !== 1) return undefined;
  if (Object.keys(input).some((key) => key !== names[0] && key !== inputs[0] && key !== "variant")) return undefined;
  const name = input[names[0]!];
  const inner = object(input[inputs[0]!]);
  return typeof name === "string" && name.trim() && inner ? { name: name.trim(), input: inner } : undefined;
}

/** Cards Murage raises itself (a peer bot's message, a browser step, an
 * image, a routine, a skill, a hand-off limit): their text is written for the
 * card, or by another bot, and is shown exactly as written. */
const MURAGE_CARD_TOOLS = new Set([
  "ask_bot", "delegate", "send_bot_message", "browser_extension_action", "local_computer_consent",
  "more_handoffs", "more_new_bots", "generate_image", "publish_site", "folder_trust",
  "stage_skill", "update_skill", "schedule_routine", "manage_routine",
]);

/** A tool's bare name: no `mcp__server__`, `server/` or `server__` prefix. */
function bareName(tool: string | undefined): string {
  if (!tool) return "";
  return tool.trim().replace(/^mcp__.+?__/, "").replace(/^[\w.-]+\//, "").replace(/^[a-z0-9-]+__/i, "");
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function shorten(value: string, max = 160): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "notes.md", "notes.md and plan.md", "3 files". */
function fileNames(paths: readonly string[]): string {
  const names = [...new Set(paths.map(baseName))];
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} files`;
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).host.replace(/^www\./, "") || undefined; } catch { return undefined; }
}

const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z]+-[0-9a-f-]{8,}$/i;

/** A shell line, in words. Only a fully understood read is called a read. */
export function plainCommand(command: string): string {
  const line = command.trim();
  const read = parseReadOnlyCommand(line);
  if (read) {
    const looks = read.programs.some((program) => /^(python|jq|grep)/.test(program));
    return `${looks ? "look through" : "read"} ${fileNames(read.paths)}`;
  }
  if (/&&|\|\||;|\n/.test(line)) return "run several commands on your computer";
  // A pipe, a redirect, a substitution or a variable: what it does depends on
  // more than its first word, so it is not named by that word.
  if (/[|<>&`$]/.test(line)) return "run a command on your computer";
  const parts = line.split(/\s+/);
  const program = (parts[0] ?? "").replace(/^.*[\\/]/, "").toLowerCase();
  const args = parts.slice(1);
  if (program === "sudo") return "run a command as an administrator on your computer";
  if (program === "env" || /^[A-Z_][A-Z0-9_]*=/.test(parts[0] ?? "")) return "run a command on your computer";
  const targets = args.filter((arg) => !arg.startsWith("-")).map((arg) => arg.replace(/^["']|["']$/g, ""));
  if (/^(rm|rmdir|unlink|del|remove-item|trash)$/.test(program)) return targets.length ? `delete ${fileNames(targets)}` : "delete files";
  if (program === "mkdir") return "create a folder";
  if (program === "touch") return "create a file";
  if (/^(cp|copy|copy-item|rsync)$/.test(program)) return "copy files";
  if (/^(mv|move|move-item|rename)$/.test(program)) return "move or rename files";
  if (/^(ls|dir|find|tree|get-childitem)$/.test(program)) return "list files";
  if (/^(cat|head|tail|less|more|type|get-content)$/.test(program)) return targets.length ? `read ${fileNames(targets)}` : "read a file";
  if (/^(grep|rg|ag|select-string)$/.test(program)) return "search through files";
  if (program === "git") return "use git";
  if (/^(npm|pnpm|yarn|pip|pip3|brew|apt|apt-get|gem|cargo|uv)$/.test(program)) {
    return args.some((arg) => /^(install|add|i)$/.test(arg)) ? "install software on your computer" : "run a developer tool";
  }
  if (/^(python|python3|node|ruby|perl|php|deno|bun|sh|bash|zsh|pwsh|powershell)$/.test(program)) {
    return args.some((arg) => /^-[ce]$/.test(arg)) ? "run a small script on your computer" : "run a script on your computer";
  }
  if (/^(curl|wget|invoke-webrequest|invoke-restmethod)$/.test(program)) {
    const host = targets.map(hostOf).find(Boolean);
    const sends = args.some((arg) => /^(-d|--data.*|-F|--form|-X|--request|-T|--upload-file)$/.test(arg));
    return host ? `${sends ? "send data to" : "download from"} ${host}` : sends ? "send data over the internet" : "download from the internet";
  }
  if (/^(kill|pkill|killall|taskkill|stop-process)$/.test(program)) return "stop a running program";
  if (/^(chmod|chown|icacls)$/.test(program)) return "change who can open files";
  if (program === "open" || program === "start" || program === "xdg-open") return "open a file or app";
  return "run a command on your computer";
}

/** The facts about a message an owner decides on, from an app call's arguments. */
function messageLines(args: Json | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const key of ["to", "recipient_email", "recipient", "recipients", "to_email", "email", "channel", "channel_id"]) {
    const value = args[key];
    const said = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(", ") : text(value);
    if (said) { out.push(`${/channel/.test(key) ? "Channel" : "To"}: ${shorten(said, 120)}`); break; }
  }
  for (const key of ["cc", "bcc"]) {
    const value = args[key];
    const said = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(", ") : text(value);
    if (said) out.push(`${key === "cc" ? "Copy to" : "Hidden copy to"}: ${shorten(said, 120)}`);
  }
  const subject = text(args.subject) ?? text(args.title) ?? text(args.summary);
  if (subject) out.push(`${text(args.subject) ? "Subject" : "Title"}: ${shorten(subject, 120)}`);
  const body = text(args.body) ?? text(args.message) ?? text(args.text) ?? text(args.content);
  if (body) out.push(`Says: ${shorten(body, 160)}`);
  const when = text(args.start_datetime) ?? text(args.start) ?? text(args.start_time);
  if (when) out.push(`When: ${shorten(when, 60)}`);
  return out;
}

function connectedAppPlain(input: Json, tool: string): PlainApproval | undefined {
  const name = tool.toUpperCase();
  if (/SEARCH_TOOLS|TOOL_SEARCH/.test(name) || (Array.isArray(input.queries) && !input.tools)) {
    const uses = (Array.isArray(input.queries) ? input.queries : []).map((q) => text(object(q)?.use_case) ?? text(q)).filter((q): q is string => Boolean(q));
    return { action: "look up which app tools to use", lines: uses.slice(0, 3).map((use) => `For: ${shorten(use, 120)}`) };
  }
  if (/MANAGE_CONNECTIONS|INITIATE_CONNECTION/.test(name) || (Array.isArray(input.toolkits) && !input.tools)) {
    return { action: "manage a connected app's sign-in", lines: [] };
  }
  const actions = connectedAppActions(input);
  if (!actions.length) return undefined;
  const rows = Array.isArray(input.tools) ? input.tools.map(object) : [object(input.tool_input) ?? input];
  const first = rows[0];
  const firstArgs = object(first?.arguments) ?? object(first?.input) ?? object(first?.params) ?? object(input.arguments);
  if (actions.length === 1) {
    const { app, action } = actions[0]!;
    return { action: `use ${app} to ${action}`, lines: messageLines(firstArgs) };
  }
  const apps = [...new Set(actions.map((a) => a.app))];
  const appText = apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  return {
    action: `use ${appText} (${actions.length} actions)`,
    lines: actions.slice(0, 5).map((a) => `${a.app}: ${a.action}`).concat(actions.length > 5 ? [`and ${actions.length - 5} more`] : []),
  };
}

function fileAction(tool: string, paths: readonly string[]): string | undefined {
  if (!paths.length) return undefined;
  const names = fileNames(paths);
  if (WRITE_TOOLS.has(tool)) return `create or replace ${names}`;
  if (EDIT_TOOLS.has(tool)) return `change ${names}`;
  if (READ_TOOLS.has(tool)) return `read ${names}`;
  if (DELETE_TOOLS.has(tool)) return `delete ${names}`;
  if (tool === "move") return `move ${names}`;
  return undefined;
}

/** Top-level arguments as `Key: value` lines, for a tool nothing above knows. */
function argumentLines(input: Json): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (out.length >= 4) { out.push("More in the details below"); break; }
    const label = key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    if (typeof value === "string" && value.trim()) out.push(`${label}: ${shorten(value, 120)}`);
    else if (typeof value === "number" || typeof value === "boolean") out.push(`${label}: ${String(value)}`);
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out.push(`${label}: ${shorten(value.join(", "), 120)}`);
  }
  return out;
}

function words(name: string): string | undefined {
  const said = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return said && said.length <= 40 && /^[a-z0-9 .]+$/.test(said) ? said : undefined;
}

/** A card's action in plain words, from its tool and its text. */
export function plainApproval(tool: string | undefined, detail: string | undefined): PlainApproval | undefined {
  if (!tool || typeof detail !== "string" || MURAGE_CARD_TOOLS.has(tool)) return undefined;
  const reasonAt = detail.indexOf(REASON_MARK);
  const body = (reasonAt < 0 ? detail : detail.slice(0, reasonAt)).replace(CUT_MARK, "");
  const reason = reasonAt < 0 ? undefined : text(detail.slice(reasonAt + REASON_MARK.length));
  const withReason = (plain: PlainApproval): PlainApproval => ({
    action: plainConnectedAppText(plain.action),
    lines: [...plain.lines, ...(reason ? [`Its reason: ${shorten(reason, 200)}`] : [])].map(plainConnectedAppText),
  });
  let input: Json | undefined;
  if (body.trim().startsWith("{")) {
    try { input = object(JSON.parse(body)); } catch { input = undefined; }
  }
  // A dispatcher's call reads as the tool it runs (bounded by the JSON's own depth).
  const inner = input ? dispatched(input) : undefined;
  if (inner) {
    return plainApproval(inner.name, `${JSON.stringify(inner.input)}${reasonAt < 0 ? "" : detail.slice(reasonAt)}`);
  }
  const bare = bareName(tool);
  const key = bare.toLowerCase();

  // A shell line.
  if (SHELL_TOOLS.has(key)) {
    const command = input ? text(input.command) ?? (Array.isArray(input.command) ? input.command.join(" ") : undefined) : text(body);
    if (!command) return withReason({ action: "run a command on your computer", lines: [] });
    const description = input ? text(input.description) : undefined;
    return withReason({ action: plainCommand(command), lines: description ? [`What it is for: ${shorten(description, 160)}`] : [] });
  }

  if (input) {
    // Connected apps, by the call's own arguments (an ACP engine sends no tool name).
    const app = connectedAppPlain(input, bare);
    if (app) return withReason(app);
    // Another bot.
    const botId = text(input.bot_id);
    const message = text(input.message);
    if (botId && message && Object.keys(input).every((k) => ["bot_id", "message", "reason"].includes(k))) {
      const who = ID_LIKE.test(botId) ? "another bot" : botId;
      return withReason({ action: key === "ask_bot" ? `ask ${who} a question` : `hand a task to ${who}`, lines: [`Message: ${shorten(message, 200)}`] });
    }
    if (MURAGE_TOOLS[key]) return withReason({ action: MURAGE_TOOLS[key]!, lines: argumentLines(input).slice(0, 3) });
    // A file.
    const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.filePath) ?? text(input.path);
    const fileVerb = path ? fileAction(key, [path]) : undefined;
    if (fileVerb) return withReason({ action: fileVerb, lines: [`File: ${path}`] });
    // A web page or a search.
    const url = text(input.url);
    if (url) {
      const method = text(input.method)?.toUpperCase();
      const host = hostOf(url);
      return withReason({
        action: method && method !== "GET" ? `send a request to ${host ?? "a website"}` : `open a page on ${host ?? "the web"}`,
        lines: [`Address: ${shorten(url, 160)}`, ...(method && method !== "GET" ? [`Method: ${method}`] : [])],
      });
    }
    const query = text(input.query);
    if (query && /search/.test(key)) return withReason({ action: "search the web", lines: [`Search: ${shorten(query, 160)}`] });
    // A message sent by some other tool.
    const sendLines = messageLines(input);
    if (/send|mail|reply|message|post/.test(key) && sendLines.some((line) => /^(To|Channel):/.test(line))) {
      return withReason({ action: "send a message", lines: sendLines });
    }
    const named = key && !["other", "tool", "fetch", "read", "edit"].includes(key) ? words(plainConnectedAppText(bare)) : undefined;
    return withReason({ action: named ?? "use a tool", lines: argumentLines(input) });
  }

  // Text: the paths an edit names, a page, or a tool's own title.
  const pathList = body.split(/,\s*/).map((part) => part.trim()).filter(Boolean);
  if (pathList.length && pathList.every((part) => /^([A-Za-z]:)?[\\/]/.test(part))) {
    const verb = fileAction(key === "edit" ? "edit" : key, pathList);
    if (verb) return withReason({ action: verb, lines: pathList.slice(0, 5).map((path) => `File: ${path}`) });
  }
  if (key === "fetch") {
    const host = hostOf(body.trim());
    if (host) return withReason({ action: `open a page on ${host}`, lines: [`Address: ${shorten(body, 160)}`] });
  }
  return undefined;
}
