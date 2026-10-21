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
      "project_propose", "propose_outcome", "propose_routine", "propose_routine_action", "request_bot_access", "request_credential",
      "request_browser_connection", "project_done",
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

/** The OWN_UNASKED rows that only read Murage's own records: the roster
 * and its lookups, memory search and get, dweb status. These run with no
 * card at every level on every engine (Claude and Codex never ask for
 * them), Ask included. Every other own tool keeps its level's rules. */
export const OWN_READS: readonly { mount: `own:${OwnBuiltin}`; tools: readonly string[] }[] = [
  { mount: "own:memory", tools: ["memory_search", "memory_get"] },
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
