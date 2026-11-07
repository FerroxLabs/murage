// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 cut V6, F1, F4 (designs/NOLIMITS-V1-CUT.md, train 1.0.18): Murage's own tools at the server. index.ts calls
// ownToolGate once, in front of every /api/internal/* route, after the capability checks and before the route runs:
//   (a) the mark: every own tool but the clean readers marks the thread (1.0.19 4.2 r3: the recall tools and the saved-result
//       read mark `memory` at their release, on evidence, not here); writers do not mark their
//       own turn (r4 M1: OWN_WRITERS are their own list), except ask_bot / delegate_bot (`another bot`) and project_bring_in;
//   (b) on a marked lane turn (judged on the state before this call) every writer but the five that keep their own owner
//       card, and every phoneJobs tool, is refused with the fixed text and changes nothing (the floor: v1 raises no card
//       from the middleware);
//   (c) off the lane, a writer on a marked turn records an ownWrite key (data only); a lane turn's start reads them.
// Pure over external-marks.ts: no Murage server imports, so the unit rows drive it directly.
import { PHONE_TOOL_NAMES } from "../shared/phone-jobs-contract.ts";
import { TextBudget, type DownloadRegistry, type FsHooks } from "./download-registry.ts";
import { anyOwnWrite, downloadRegistry, markTurnOutside, ownWrite, ownWritten, turnOutsideRead, type OutsideSource } from "./email/external-marks.ts";
import { nodeFsHooks } from "./outside-dl.ts";

/** r4 3.2 M1 OWN_READ_CLEAN (closed): pure readers of the owner's or this bot's own saved state or fixed Murage text. */
export const OWN_READ_CLEAN_TOOLS: readonly string[] = [
  "list_bots", "get_bot", "get_permission_status", "list_routines", "list_reference_packs", "list_prompt_blocks", "get_prompt_block",
  "list_image_models", "murage_help", "dweb_status",
];
/** r4 6.1.6 OWN_WRITERS (46): every own tool that persists anything a later turn can read. */
export const OWN_WRITERS: ReadonlySet<string> = new Set([
  "memory_save", "memory_propose_correction",
  "create_bot", "update_bot", "archive_bot", "restore_bot", "move_bot", "set_team_lead",
  "ask_bot", "delegate_bot",
  "project_assign", "project_accept", "project_card_manage", "project_review_assign", "project_criteria", "project_blocked",
  "project_brief_update", "project_card_update", "project_review_result", "project_suggest", "project_summary_update", "project_bring_in",
  "project_propose", "propose_outcome", "propose_routine", "propose_routine_action", "request_bot_access", "request_credential",
  "show_widget", "update_widget", "request_browser_connection", "project_done", "add_mcp_server",
  "ask_user", "send_voice_note",
  "generate_image", "save_prompt_block", "save_reference_pack",
  "email_send", "email_reply", "email_trust_offer",
  "allow_for_task",
  // VENUE-POST-1017: a line in a project or channel, which other bots and people read on their later turns
  "venue_post",
  // MurageMain route ruling 11-06: an owner card a marked turn could file, the same shape as request_credential. Named by route;
  // their per-engine asks do not change, so they are not OWN_UNASKED rows.
  "ask_owner_to_share", "connectors_request",
  // A call intent the owner reads. Exempt below: bounded by the call caps, fenced, and it tells him the turn read outside content.
  "needs_owner_now",
]);
/** The writers that keep their own owner card (the question, the image approval, the email Send / Don't send card), and
 *  needs_owner_now, which grants nothing and only tells the owner (bot-calls-card.ts names the outside content). */
export const OWN_HOLD_EXEMPT: ReadonlySet<string> = new Set(["ask_user", "generate_image", "email_send", "email_reply", "email_trust_offer", "needs_owner_now"]);
/** r4 M1 OWN_MARKS: the other own tools of the unasked table (the acting mounts, computer, browser, connectors, are routes). */
export const OWN_MARKS_TOOLS: readonly string[] = [
  "memory_search", "memory_get", "thread_search", "thread_list", "thread_read",
  "check_delegation", "wait_delegation", "skills_list", "tool_result_read", "project_read_messages", "venue_read_messages",
  "email_list", "email_read", "dweb_repo_status", "dweb_opencode_models", ...PHONE_TOOL_NAMES,
];
const READ_CLEAN = new Set(OWN_READ_CLEAN_TOOLS);
/** 1.0.19 4.2 r3: the recall tools and the saved-result read never mark at the gate; each marks at its release, by what it
 *  returned (memory/outside-derived.ts markRecallRecords, external-marks.ts recallRowsOutside). Clean results never mark. */
const RELEASE_JUDGED: ReadonlySet<string> = new Set(["memory_search", "memory_get", "thread_search", "thread_list", "thread_read", "tool_result_read"]);
/** F1: the readers that return a recorded object (and generate_image, given prompt_blocks: coarse, any call). */
const F1_READERS: ReadonlySet<string> = new Set(["get_bot", "list_bots", "get_prompt_block", "list_prompt_blocks", "list_reference_packs", "list_routines", "generate_image"]);
const PHONE: ReadonlySet<string> = new Set<string>([...PHONE_TOOL_NAMES, "phone"]);
const MARK_SOURCE: Readonly<Record<string, OutsideSource>> = {
  ask_bot: "another bot", delegate_bot: "another bot", check_delegation: "another bot", wait_delegation: "another bot",
  venue_read_messages: "another person", project_read_messages: "another person", email_list: "email", email_read: "email",
};
/** Writers that also mark (r4 M1: their reply carries another bot's words, or the material is brought in). */
const MARKING_WRITERS: ReadonlySet<string> = new Set(["ask_bot", "delegate_bot", "project_bring_in"]);

/** The fixed Don't-allow text of the floor (the call changes nothing). */
export const OUTSIDE_WRITE_REFUSAL = "This chat read outside content, so Murage did not make this change: nothing was saved, sent or changed. Tell the owner, who can make it from a fresh chat.";

/** Whether an own tool's engine start (item.started) leaves the turn as it is: a writer that does not mark (see (a)). */
export function ownWriterQuiet(tool: string): boolean { return OWN_WRITERS.has(tool) && !MARKING_WRITERS.has(tool); }

/** (a): the source this own call marks, or null. */
export function ownToolMark(tool: string): OutsideSource | null {
  if (tool === "") return null;
  if (F1_READERS.has(tool) && anyOwnWrite()) return "earlier turn";
  if (READ_CLEAN.has(tool)) return null;
  if (RELEASE_JUDGED.has(tool)) return null;
  if (ownWriterQuiet(tool)) return null;
  return MARK_SOURCE[tool] ?? "outside tool";
}

const MEMORY_ROUTES: Readonly<Record<string, string>> = {
  search: "memory_search", get: "memory_get", save: "memory_save", "propose-correction": "memory_propose_correction",
  "thread-search": "thread_search", "thread-list": "thread_list", "thread-read": "thread_read",
};
const PROJECT_ROUTES: Readonly<Record<string, string>> = {
  propose: "project_propose", assign: "project_assign", accept: "project_accept", "card-manage": "project_card_manage",
  "review-assign": "project_review_assign", criteria: "project_criteria", done: "project_done", blocked: "project_blocked",
  "brief-update": "project_brief_update", "card-update": "project_card_update", "review-result": "project_review_result",
  "read-messages": "project_read_messages", "bring-in": "project_bring_in", suggest: "project_suggest", "summary-update": "project_summary_update",
};
const MANAGEMENT: Readonly<Record<string, string>> = { get: "get_bot", update: "update_bot", archive: "archive_bot", restore: "restore_bot", move: "move_bot", "set-lead": "set_team_lead" };
const POSTS: Readonly<Record<string, string>> = {
  "/api/internal/create-bot": "create_bot", "/api/internal/ask-bot": "ask_bot", "/api/internal/delegate-bot": "delegate_bot",
  "/api/internal/permission-status": "get_permission_status", "/api/internal/access-request": "request_bot_access",
  "/api/internal/routine-requests": "propose_routine", "/api/internal/outcome-proposals": "propose_outcome",
  "/api/internal/request-credential": "request_credential", "/api/internal/show-widget": "show_widget", "/api/internal/update-widget": "update_widget",
  "/api/internal/request-browser-connection": "request_browser_connection", "/api/internal/mcp-servers": "add_mcp_server",
  "/api/internal/ask-user": "ask_user", "/api/internal/voice-note": "send_voice_note", "/api/internal/stop-line-allowance": "allow_for_task",
  "/api/internal/generate-image": "generate_image", "/api/internal/resolve-image-reference": "resolve_image_reference",
  "/api/internal/register-artifact": "register_artifact", "/api/internal/publish-site": "publish_site", "/api/internal/take-down-site": "take_down_site",
  "/api/internal/web-search": "web_search", "/api/internal/skills/stage": "skill_manage", "/api/internal/venue/read-messages": "venue_read_messages",
  "/api/internal/venue/post": "venue_post",
  "/api/internal/needs-owner-now": "needs_owner_now",
  "/api/internal/room-share/ask": "ask_owner_to_share", "/api/internal/connectors/request": "connectors_request",
};
const GETS: Readonly<Record<string, string>> = {
  "/api/internal/agents": "list_bots", "/api/internal/routines": "list_routines", "/api/internal/image-models": "list_image_models",
  "/api/internal/image-prompt-blocks": "list_prompt_blocks", "/api/internal/image-prompt-block": "get_prompt_block",
  "/api/internal/image-reference-packs": "list_reference_packs", "/api/internal/skills": "skills_list", "/api/internal/tool-result": "tool_result_read",
};
const IMAGE_LIBRARY: ReadonlySet<string> = new Set(["/api/internal/image-prompt-blocks", "/api/internal/image-prompt-block", "/api/internal/image-reference-packs", "/api/internal/image-reference-pack"]);

/** The own tool an /api/internal call is (method, path, and the body where the route serves several tools). "" is not a tool
 *  (the proxy's own save of a long result); a route the table does not name is `route:<path>` (it marks, it is not held). */
export function ownToolOfRoute(method: string, path: string, body?: Record<string, unknown>): string {
  const get = method === "GET";
  if (path.startsWith("/api/internal/memory/")) return MEMORY_ROUTES[path.slice("/api/internal/memory/".length)] ?? "memory_save";
  if (path.startsWith("/api/internal/project/")) return PROJECT_ROUTES[path.slice("/api/internal/project/".length)] ?? "project_card_update";
  if (path.startsWith("/api/internal/email/")) return path.slice("/api/internal/email/".length) || "email_send";
  if (path.startsWith("/api/internal/delegations/")) return "check_delegation";
  if (path === "/api/internal/device/call") return typeof body?.tool === "string" && PHONE.has(body.tool) ? body.tool : "phone";
  if (path === "/api/internal/bot-management") return MANAGEMENT[typeof body?.action === "string" ? body.action : ""] ?? "update_bot";
  if (path === "/api/internal/tool-result") return get ? "tool_result_read" : "";
  if (IMAGE_LIBRARY.has(path)) {
    if (get) return GETS[path] ?? "list_prompt_blocks";
    return path.includes("reference-pack") ? "save_reference_pack" : "save_prompt_block";
  }
  return (get ? GETS[path] : POSTS[path]) ?? POSTS[path] ?? GETS[path] ?? `route:${path}`;
}

export interface OwnCall {
  threadId: string;
  /** the caller's bot */
  botId: string;
  tool: string;
  /** NOLIMITS section 1: No limits on a turn the owner started himself (index.ts ownLaneTurn) */
  lane: boolean;
  /** (c): the bot a roster tool names (bot-management targetBotId) */
  targetBotId?: string;
  /** (c): the project of the caller's thread, for project tools */
  projectId?: string;
}

/** (c): the keys an off-lane write on a marked turn records. */
function ownWriteKeys(call: OwnCall): string[] {
  const tool = call.tool;
  // the new bot's id is not known before the route runs: the route records `bot:<newId>` through ownCreatedBot (no wildcard)
  if (tool === "create_bot") return [`bot:${call.botId}`];
  if (["update_bot", "archive_bot", "restore_bot", "move_bot", "set_team_lead"].includes(tool)) return [`bot:${call.targetBotId ?? "*"}`];
  if (tool.startsWith("project_") && tool !== "project_propose" && tool !== "project_done") return [`project:${call.projectId ?? "*"}`];
  if (["save_prompt_block", "save_reference_pack", "propose_routine", "propose_routine_action", "project_propose", "propose_outcome",
    "project_done", "request_bot_access", "request_credential", "show_widget", "update_widget", "request_browser_connection", "add_mcp_server", "ask_owner_to_share", "connectors_request"].includes(tool)) {
    return [`bot:${call.botId}`];
  }
  return [];
}

/** The one middleware step. Returns the refusal the route answers with, or null to let the route run. */
export function ownToolGate(call: OwnCall): { refuse: string } | null {
  if (call.tool === "") return null;
  const before = turnOutsideRead(call.threadId);
  const mark = ownToolMark(call.tool);
  if (mark) markTurnOutside(call.threadId, mark);
  const writer = OWN_WRITERS.has(call.tool) || PHONE.has(call.tool);
  if (call.lane) {
    if (before !== null && writer && !OWN_HOLD_EXEMPT.has(call.tool)) return { refuse: OUTSIDE_WRITE_REFUSAL };
    return null;
  }
  if (OWN_WRITERS.has(call.tool) && turnOutsideRead(call.threadId) !== null) for (const key of ownWriteKeys(call)) ownWrite(key);
  return null;
}

/** V6 (c): the create-bot route, once the new bot exists: a create on a marked turn records the new bot's key (a lane turn
 *  that is marked never gets here, the gate refused it). Not ready: recorded (fail closed). */
export function ownCreatedBot(threadId: string, newBotId: string): void {
  if (turnOutsideRead(threadId) !== null) ownWrite(`bot:${newBotId}`);
}

/** V6 (c) + F1: at a lane turn's start, `earlier turn` when an off-lane marked turn changed the bot, a bot the prompt names
 *  (roster lines, team), the turn's project, or created this bot (`bot:<id>`; `bot:*` only from a roster write with no target). Not ready: marked (ownWritten fails closed). */
export function ownWriteTurnStartMark(input: { botId: string; rosterBotIds: readonly string[]; projectId?: string }): OutsideSource | null {
  const keys = ["bot:*", `bot:${input.botId}`, ...input.rosterBotIds.map((id) => `bot:${id}`),
    ...(input.projectId ? [`project:${input.projectId}`, "project:*"] : [])];
  return keys.some((key) => ownWritten(key)) ? "earlier turn" : null;
}

/** Whether the email policy's auto-clear is skipped (V6 (b)): a marked lane turn (or the store not ready). */
export function laneTurnMarked(threadId: string, lane: boolean): boolean { return lane && turnOutsideRead(threadId) !== null; }

/** F4: the notebook folders the prompt includes (MEMORY.md, GENERAL.md, memory/*), matched against the download registry with
 *  one TextBudget (DL step 2: a folder that is, lies under or holds an entry). A Match, a spent budget or a stat failure marks. */
export function notebookOutsideMark(folders: readonly string[], registry: DownloadRegistry = downloadRegistry(), fsHooks: FsHooks = nodeFsHooks()): OutsideSource | null {
  if (registry.empty() || folders.length === 0) return null;
  const budget = new TextBudget(fsHooks);
  try {
    for (const folder of folders) if (registry.matchPath(folder, { cwd: folder, budget })) return "earlier turn";
  } catch {
    return "earlier turn";
  }
  return budget.spent() ? "earlier turn" : null;
}
