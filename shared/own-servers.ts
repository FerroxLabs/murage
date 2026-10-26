// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own MCP servers (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md
// Rule 51). Two statements that do not contradict: an own-server tool that
// asks is judged like any other ask; an own-server tool that never asks is
// listed here with the boundary that stands in for the ask, named per tool.
// This is the one table every engine reads (Claude pre-allows exactly these,
// ACP's hosted tools, Pi's unasked rows are its exact mount/tool pairs). A
// tool on an own mount that is NOT in OWN_UNASKED asks.

/** The built-in own mounts, by the `mountId` suffix of Rule 54
 * (`own:<builtin>`), with the server name each driver mounts them under. */
export const OWN_BUILTINS = {
  connector: "murage_connectors",
  memory: "murage-memory",
  agents: "agents",
  muragebox: "muragebox",
  computer: "computer",
  browser: "browser",
  phone: "phone",
  dweb: "dweb",
} as const;

export type OwnBuiltin = keyof typeof OWN_BUILTINS;

export interface OwnUnaskedRow {
  mount: `own:${OwnBuiltin}`;
  tools: readonly string[];
  /** the enforcement that stands in for the ask */
  boundary: string;
}

export const OWN_UNASKED: readonly OwnUnaskedRow[] = [
  {
    mount: "own:memory",
    tools: ["memory_search", "memory_get", "memory_save", "memory_propose_correction"],
    boundary: "the handler scopes every call by the bot id of the mount's own session; handle and handles[].handle are turn-local record handles; the effect is confined to that bot's memory",
  },
  {
    mount: "own:memory",
    tools: ["thread_search", "thread_list", "thread_read"],
    boundary: "read-only thread recall (server/thread-recall.ts): the thread set is recallThreads of the mount's own session, recomputed from the live roster on every call; every row passes the reader door; 12 calls per turn",
  },
  {
    mount: "own:agents",
    tools: [
      "list_bots", "get_bot", "check_delegation", "wait_delegation", "get_permission_status", "list_routines", "skills_list",
      "list_reference_packs", "list_prompt_blocks", "get_prompt_block", "list_image_models", "tool_result_read", "murage_help",
      "project_read_messages",
    ],
    boundary: "read handlers over Murage's own records for this bot's permitted roster; bot_id resolves against the roster",
  },
  {
    mount: "own:agents",
    tools: [
      "ask_bot", "delegate_bot", "project_assign", "project_accept", "project_card_manage", "project_review_assign",
      "project_criteria", "project_blocked", "project_brief_update", "project_card_update", "project_review_result",
      "project_suggest", "project_summary_update", "project_bring_in",
    ],
    boundary: "every addressing-looking leaf is a roster id resolved against the owner's own bots; the receiving bot's turn raises its own cards; project_bring_in refuses material from anyone but the owner",
  },
  {
    mount: "own:agents",
    tools: ["allow_for_task"],
    boundary: "granted only for an owner-origin turn at depth 0 with no event id, from an owner-proven surface, for a place the latest owner message names",
  },
  {
    mount: "own:agents",
    tools: [
      "project_propose", "propose_outcome", "propose_routine", "propose_routine_action", "request_bot_access", "request_credential", "ask_user", "show_widget", "update_widget",
      "request_browser_connection", "project_done", "add_mcp_server",
    ],
    boundary: "each files a proposal the owner accepts in the app; nothing is granted, created, connected or signed off until then",
  },
  {
    mount: "own:agents",
    tools: ["create_bot", "update_bot", "archive_bot", "restore_bot", "move_bot", "set_team_lead"],
    boundary: "Chief-only, revision-checked management over the owner's own roster; a created bot starts with apps, peer comms and computer control off",
  },
  // The per-handler rows of Rule 51, read in code at build step 3:
  {
    mount: "own:agents",
    tools: ["send_voice_note"],
    boundary: "posts into the owner's own chat; no recipient leaf",
  },
  {
    mount: "own:agents",
    tools: ["generate_image"],
    boundary: "runs its own image-approval card (server/image-approval.ts) before any request leaves",
  },
  {
    mount: "own:agents",
    tools: ["save_prompt_block", "save_reference_pack"],
    boundary: "writes only this bot's image library on an owner-audience turn (/api/internal/image-prompt-block, image-library-audience.ts); leaves are a name, text, reference ids and a version",
  },
  {
    mount: "own:dweb",
    tools: ["dweb_status", "dweb_repo_status", "dweb_opencode_models"],
    boundary: "reads of Murage's own dweb state",
  },
];

/** Own tools that ASK on every engine, by design (Rule 51). */
export const OWN_ALWAYS_ASK: readonly { mount: `own:${OwnBuiltin}`; tool: string }[] = [
  { mount: "own:agents", tool: "publish_site" },
  { mount: "own:agents", tool: "take_down_site" },
  { mount: "own:agents", tool: "skill_manage" },
  { mount: "own:dweb", tool: "dweb_opencode_run" },
  // per handler, read at build step 3: a workspace path leaf (relative_path,
  // the file a report is saved from) or text that leaves the machine (a
  // search query) is judged by the verdict, so these ask
  { mount: "own:agents", tool: "resolve_image_reference" },
  { mount: "own:agents", tool: "register_artifact" },
  { mount: "own:agents", tool: "web_search" },
];

/** Whether an own tool runs unasked: its mount and its exact name are a row. */
export function isOwnUnasked(mountId: string, tool: string): boolean {
  return OWN_UNASKED.some((row) => row.mount === mountId && row.tools.includes(tool));
}

/** Whether an own tool asks on every engine: its mount and exact name are an OWN_ALWAYS_ASK row. */
export function isOwnAlwaysAsk(mountId: string, tool: string): boolean {
  return OWN_ALWAYS_ASK.some((row) => row.mount === mountId && row.tool === tool);
}

/** The OWN_ALWAYS_ASK pair an engine's MCP-qualified name spells
 * (`mcp__<server>__<tool>`, or `<server>__<tool>` as a dispatcher names it),
 * as `own:<builtin>/<tool>`, or undefined. A bare tool name never matches:
 * it could be an engine's own tool of the same name. */
export function ownAlwaysAskByName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const bare = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  for (const row of OWN_ALWAYS_ASK) {
    const server = OWN_BUILTINS[row.mount.slice("own:".length) as OwnBuiltin];
    if (bare === `${server}__${row.tool}`) return `${row.mount}/${row.tool}`;
  }
  return undefined;
}

/** The two tables never name the same mount and tool: one tool cannot both
 * run unasked and ask on every engine. Checked when this module loads. */
export function assertOwnAskTablesDisjoint(
  unasked: readonly OwnUnaskedRow[] = OWN_UNASKED,
  always: readonly { mount: string; tool: string }[] = OWN_ALWAYS_ASK,
): void {
  const both = always.filter((row) => unasked.some((u) => u.mount === row.mount && u.tools.includes(row.tool)));
  if (both.length) throw new Error(`own-servers: OWN_ALWAYS_ASK and OWN_UNASKED both name ${both.map((row) => `${row.mount}/${row.tool}`).join(", ")}`);
}
assertOwnAskTablesDisjoint();

/** The OWN_UNASKED rows that only read Murage's own records: the roster
 * and its lookups, memory search and get, thread recall, dweb status. These run with no
 * card at every level on every engine (Claude and Codex never ask for
 * them), Ask included. Every other own tool keeps its level's rules. */
export const OWN_READS: readonly { mount: `own:${OwnBuiltin}`; tools: readonly string[] }[] = [
  { mount: "own:memory", tools: ["memory_search", "memory_get", "thread_search", "thread_list", "thread_read"] },
  { mount: "own:agents", tools: OWN_UNASKED.find((row) => row.mount === "own:agents")!.tools },
  { mount: "own:dweb", tools: ["dweb_status", "dweb_repo_status", "dweb_opencode_models"] },
];

/** Whether an own tool only reads: its mount and exact name are an OWN_READS row (and so also an OWN_UNASKED one). */
export function isOwnRead(mountId: string, tool: string): boolean {
  return OWN_READS.some((row) => row.mount === mountId && row.tools.includes(tool)) && isOwnUnasked(mountId, tool);
}

/** Rule 56a step 1: operation-level classifications that outrank the key
 * vocabularies, keyed by (mount, tool, key). `*` matches every tool of the
 * mount. These leaves are handles Murage resolves, never people. */
export const OWN_SCHEMA_OVERRIDES: readonly { mount: `own:${OwnBuiltin}`; tool: string; key: string; as: "object" }[] = [
  { mount: "own:memory", tool: "memory_get", key: "handle", as: "object" },
  { mount: "own:memory", tool: "memory_get", key: "handles[].handle", as: "object" },
  { mount: "own:memory", tool: "memory_propose_correction", key: "handle", as: "object" },
  { mount: "own:memory", tool: "memory_propose_correction", key: "handles[].handle", as: "object" },
  { mount: "own:agents", tool: "*", key: "bot_id", as: "object" },
  { mount: "own:agents", tool: "*", key: "assignee", as: "object" },
  { mount: "own:agents", tool: "*", key: "assignee_bot_id", as: "object" },
  { mount: "own:agents", tool: "*", key: "reviewer_bot_id", as: "object" },
];

/** Murage's own computer mount (`own:computer`, the host computer's tools):
 * the actions that only look at the screen and never change it. They run with
 * no card at every level on every engine, Ask included, as Claude's own reads
 * do; every other computer action (click, type, key, drag, scroll, open,
 * clipboard, browser, app launch and kill) keeps its level's rules and asks
 * once at Ask. The clipboard and browser reads are not here: they can return
 * text the screen does not show. */
export const OWN_COMPUTER_READS: readonly string[] = [
  "list_windows", "list_apps", "get_window_state", "get_desktop_state", "get_accessibility_tree",
  "get_screen_size", "get_cursor_position", "screenshot", "zoom",
];

/** Whether a call on the own computer mount only looks at the screen. */
export function isOwnComputerRead(mountId: string, tool: string): boolean {
  return mountId === "own:computer" && OWN_COMPUTER_READS.includes(tool);
}
