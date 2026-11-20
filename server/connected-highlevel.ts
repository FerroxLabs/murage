// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HighLevel through connected apps only (1.0.20, Sean 11-19: Murage's own HighLevel integration is removed; HighLevel is
// reachable only through Composio connected apps or an owner-added MCP server). This keeps the OPTIONAL HIGHLEVEL rule for
// the connected-apps relay: Composio HighLevel = toolkit `highlevel` or `highlevel_location`, or any slug starting `HIGHLEVEL_`.
import { connectedAppToolId } from "../shared/connected-app-calls.ts";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A Composio HighLevel toolkit or slug, in any case. */
export function isComposioHighLevelId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const id = value.trim().toLowerCase();
  return id === "highlevel" || id === "highlevel_location" || id.startsWith("highlevel_");
}

const MAX_DEPTH = 64;
const SEARCH_TOOLS = /^COMPOSIO_SEARCH_TOOLS$/;

const toolCalls = (input: unknown): Array<{ name: string; tool: string; args: unknown }> => {
  const out: Array<{ name: string; tool: string; args: unknown }> = [];
  // MULTI_EXECUTE can nest another meta-tool. Read the same explicit name
  // and arguments shape at every level, not only the outer JSON-RPC call.
  const visit = (value: unknown, depth = 0): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!object(value)) return;
    const params = value.method === "tools/call" && object(value.params) ? value.params : undefined;
    const name = params ? String(params.name ?? "") : typeof value.tool_slug === "string" ? value.tool_slug : undefined;
    if (name !== undefined) out.push({ name, tool: connectedAppToolId(name), args: params ? params.arguments : value.arguments });
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(input);
  return out;
};

/** Whether a relay reply may need filtering: it answers tools/list or COMPOSIO_SEARCH_TOOLS. */
export function connectorReplyFiltered(input: unknown): boolean {
  return (Array.isArray(input) ? input : [input]).some((message) => object(message) && message.method === "tools/list")
    || toolCalls(input).some((call) => SEARCH_TOOLS.test(call.tool));
}

/** /api/internal/connectors/request: whether any requested toolkit is HighLevel. */
export function connectorRequestNamesHighLevel(slugs: readonly string[]): boolean {
  return slugs.some(isComposioHighLevelId);
}

/** An object that names Composio HighLevel itself: one of its own string values, or one level down (a nested toolkit). */
const namesHighLevel = (item: Record<string, unknown>): boolean => Object.values(item).some((value) =>
  isComposioHighLevelId(value) || (object(value) && Object.values(value).some(isComposioHighLevelId)));

// OPTIONAL HIGHLEVEL (Sean, 1.0.20): HighLevel is never pushed on anyone. In a workspace whose connected apps hold no
// HighLevel account, no bot sees Composio HighLevel on the relay (search results, tool lists) or opens a connect card for
// it, at any level. HighLevel stays listed in Settings → Connected apps for owners who choose it. An owner who connected a
// Composio HighLevel account keeps it: the relay passes Composio HighLevel through unchanged.
// An unknown inventory counts as no HighLevel account (fail closed: nobody is asked to connect it).
/** Said to the engine when a connect request names HighLevel that nobody set up. */
export const HIGHLEVEL_OPTIONAL_REQUEST_REFUSAL = "HighLevel isn't set up in this workspace. Don't offer it or ask the owner to connect it. If the owner asks for HighLevel themselves, tell them it's in Settings → Connected apps.";
/** Replaces a search or tool list only when nothing is left once HighLevel is removed, or it cannot be read. It names no app. */
export const HIGHLEVEL_OPTIONAL_HIDDEN_RESULT = "Nothing usable came back from that search. Continue with the apps that are connected.";

/** Whether Composio HighLevel stays out of sight: no HighLevel account in the workspace's connected apps. */
export function optionalHighLevelHidden(connectedSlugs: ReadonlySet<string> | null | undefined): boolean {
  if (!connectedSlugs) return true;
  return ![...connectedSlugs].some(isComposioHighLevelId);
}

const hiddenResult = { content: [{ type: "text", text: HIGHLEVEL_OPTIONAL_HIDDEN_RESULT }], isError: true };

/** A line of plain text that names the app: its name or slug written as one word (HighLevel, GoHighLevel, highlevel,
 * HIGHLEVEL_LIST_FORMS, highlevel_location) or LeadConnector. Never the English phrase "high level". */
const HIGHLEVEL_WORDS = /(?<![a-z0-9])(?:go)?highlevel|leadconnector/i;

/** The optional path's removal: every item, entry and key that names Composio HighLevel goes, at any depth, and
 * everything else stays. Too deep to read, or left with an emptied list, is dropped (undefined), never passed on. */
function prune(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  // An entry with fields of its own (a tool, a result row) is about HighLevel when it or its nested toolkit names it. A
  // plain holder of other entries is not: it is read through, so one HighLevel entry never takes its neighbours with it.
  const fields = (item: Record<string, unknown>) => Object.values(item).some((field) => field === null || typeof field !== "object");
  const named = (item: unknown) => isComposioHighLevelId(item)
    || (object(item) && (Object.values(item).some(isComposioHighLevelId) || (fields(item) && namesHighLevel(item))));
  if (Array.isArray(value)) return value.filter((item) => !named(item)).map((item) => prune(item, depth + 1)).filter((item) => item !== undefined);
  if (object(value)) {
    const kept = Object.entries(value).filter(([key, item]) => !isComposioHighLevelId(key) && !named(item))
      .map(([key, item]) => [key, prune(item, depth + 1)] as const).filter(([, item]) => item !== undefined);
    // a list this entry held is empty now: the entry was about HighLevel alone, so it goes whole
    if (kept.some(([key, item]) => Array.isArray(item) && item.length === 0 && Array.isArray(value[key]) && value[key].length > 0)) return undefined;
    return Object.fromEntries(kept);
  }
  return value;
}

/** One reply message for a bot that never set HighLevel up: only what names HighLevel is removed (tools, result
 * items, text lines); every other app's results stay. The neutral line replaces the answer only when nothing is left. */
function hideOptionalHighLevel(message: unknown): unknown {
  if (Array.isArray(message)) return message.map(hideOptionalHighLevel);
  if (!object(message) || !object(message.result)) return message;
  const result = message.result;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (isComposioHighLevelId(key)) continue;
    if (key === "tools" && Array.isArray(value)) {
      next.tools = prune(value.filter((tool) => !(object(tool) && isComposioHighLevelId(tool.name))));
    } else if (key === "content" && Array.isArray(value)) {
      const content = value.flatMap((item): unknown[] => {
        if (!object(item)) return isComposioHighLevelId(item) ? [] : [item];
        if (item.type !== "text" || typeof item.text !== "string") { const kept = namesHighLevel(item) ? undefined : prune(item); return kept === undefined ? [] : [kept]; }
        let parsed: unknown;
        try { parsed = JSON.parse(item.text); } catch { parsed = undefined; }
        if (Array.isArray(parsed) || object(parsed)) {
          const kept = prune(parsed);
          return kept === undefined ? [] : [{ ...item, text: JSON.stringify(kept) }];
        }
        const lines = item.text.split("\n").filter((line) => !HIGHLEVEL_WORDS.test(line)).join("\n");
        return lines.trim() ? [{ ...item, text: lines }] : [];
      });
      if (value.length && !content.length) return { ...message, result: hiddenResult };
      next.content = content;
    } else {
      const kept = isComposioHighLevelId(value) ? undefined : prune(value);
      if (kept !== undefined) next[key] = kept;
    }
  }
  return { ...message, result: next };
}

/** The relay's raw answer with Composio HighLevel removed for a bot that never set it up. Other apps' results are kept;
 * bytes that are not a readable answer become the neutral line, never a HighLevel mention. */
export function hideOptionalHighLevelBytes(contentType: string, bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  try {
    if (/^application\/json\b/iu.test(contentType)) return encode(hideOptionalHighLevel(JSON.parse(text)));
    if (/^text\/event-stream\b/iu.test(contentType)) {
      return new TextEncoder().encode(text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        try { return `data: ${JSON.stringify(hideOptionalHighLevel(JSON.parse(line.slice(5))))}`; } catch {
          return `data: ${JSON.stringify({ jsonrpc: "2.0", id: null, result: hiddenResult })}`;
        }
      }).join("\n"));
    }
  } catch { /* not a readable answer */ }
  return encode({ jsonrpc: "2.0", id: null, result: hiddenResult });
}

/** What the connected-apps relay hands back to the engine for one reply: the optional-HighLevel removal when the workspace
 * holds no HighLevel account, the reply unchanged otherwise. */
export function connectorReplyBytes(input: { body: unknown; contentType: string; bytes: Uint8Array; connectedSlugs: () => ReadonlySet<string> | null }): Uint8Array {
  if (!connectorReplyFiltered(input.body)) return input.bytes;
  return optionalHighLevelHidden(input.connectedSlugs()) ? hideOptionalHighLevelBytes(input.contentType, input.bytes) : input.bytes;
}

/** The refusal for a connect request that names Composio HighLevel, or null when the request may go on. */
export function connectorRequestHighLevelRefusal(input: { slugs: readonly string[]; connectedSlugs: () => ReadonlySet<string> | null }): string | null {
  if (!connectorRequestNamesHighLevel(input.slugs)) return null;
  return optionalHighLevelHidden(input.connectedSlugs()) ? HIGHLEVEL_OPTIONAL_REQUEST_REFUSAL : null;
}
