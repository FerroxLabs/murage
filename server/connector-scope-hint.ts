// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The idea, the match and the Gmail slug groups follow OpenMausBot server/connector-scope-hint.ts
// (Apache-2.0), see NOTICE. The wording is Murage's own and is true on the managed route.
//
// A connected-app call refused because the account's grant lacks a permission
// the action needs (Google answers ACCESS_TOKEN_SCOPE_INSUFFICIENT). A bot
// that only sees the refusal retries, or asks the person to reconnect. This
// adds one text block to the tool result, at the reply boundary, saying what
// is missing and what to do instead. The provider's own text stays as it was,
// and the journal keeps the raw answer: a replay gets the same bytes plus the
// same note, never a stored annotated copy.

const SCOPE_ERROR = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;

/** What a known tool changes, when its name says which (Gmail settings today). */
function requiredPermission(slug: string): string | null {
  if (!slug.startsWith("GMAIL_")) return null;
  if (/FORWARD|SEND_AS|DELEGATE/.test(slug)) return "manage Gmail forwarding, send-as addresses and delegates";
  if (/FILTER|VACATION|AUTO_REPLY|IMAP|POP|LANGUAGE/.test(slug)) return "manage Gmail filters, vacation replies and mail settings";
  return null;
}

function appName(slug: string): string {
  const toolkit = slug.split("_")[0] ?? "";
  if (toolkit === "GMAIL") return "Gmail";
  if (toolkit.startsWith("GOOGLE")) return "Google";
  if (!toolkit) return "This app";
  return toolkit.charAt(0) + toolkit.slice(1).toLowerCase();
}

/** The tool slugs a call names: `tool_slug` anywhere in its arguments (a batch lists several), else the tool's own name. */
export function toolSlugsOf(name: string | undefined, args: unknown): string[] {
  const slugs: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) walk(item, depth + 1); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "tool_slug" || key === "slug") && typeof item === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(item)) slugs.push(item);
      else walk(item, depth + 1);
    }
  };
  walk(args, 0);
  if (!slugs.length && name && /^[A-Z][A-Z0-9_]{2,80}$/.test(name) && !name.startsWith("COMPOSIO_")) slugs.push(name);
  return [...new Set(slugs)];
}

/** Which connection the refused call went through. On the managed route the app's permissions are fixed by Murage, so reconnecting changes nothing;
 *  on the person's own connected-apps account they can reconnect and grant the access. */
export type ScopeRoute = "managed" | "own";

/** The note a bot reads after its call was refused for a missing permission. */
export function scopeHint(slugs: readonly string[], route: ScopeRoute = "managed"): string {
  const slug = slugs.find((candidate) => requiredPermission(candidate)) ?? slugs[0] ?? "";
  const app = slug ? appName(slug) : "This app";
  const what = slug ? requiredPermission(slug) : null;
  const permission = what ? `the permission to ${what}` : "the permission this action needs";
  return `Note from Murage: ${app} refused this because the connected account has not granted ${permission}. `
    + (route === "own"
      ? "Stop here and do not retry this call until the person has reconnected the app and granted that access, which can help. "
        + `Tell the person plainly that this account's connection does not include that permission, that reconnecting the app with the needed access can fix it, and offer to help another way meanwhile, such as doing this one step by hand in ${app === "This app" ? "the app" : app}.`
      : "Stop here and do not retry this call, and reconnecting the app will not change it. "
        + `Tell the person plainly that this account's connection does not include that permission, so this action is not available through it for now, and offer to help another way, such as doing this one step by hand in ${app === "This app" ? "the app" : app}.`);
}

type Frame = { result?: { content?: unknown } };

/** Adds the note to one JSON-RPC frame whose tool result is a scope refusal. */
function annotateFrame(frame: unknown, slugs: readonly string[], route: ScopeRoute): boolean {
  const result = (frame as Frame | null)?.result;
  if (!result || !Array.isArray(result.content)) return false;
  const refused = result.content.some((item) =>
    item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
    && SCOPE_ERROR.test((item as { text: string }).text));
  if (!refused) return false;
  result.content.push({ type: "text", text: scopeHint(slugs, route) });
  return true;
}

/** The relayed MCP response with the note added when the call came back refused for a missing permission, once per call. Anything else,
 *  including a body it cannot read, comes back byte for byte (the same Uint8Array). */
export function withScopeHint(bytes: Uint8Array, contentType: string, slugs: readonly string[], route: ScopeRoute = "managed"): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!SCOPE_ERROR.test(text)) return bytes;
  try {
    if (/text\/event-stream/i.test(contentType) || /^data:/m.test(text)) {
      const lines = text.split("\n");
      // One note per call: the last frame that carries the refusal.
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!SCOPE_ERROR.test(raw)) continue;
        const frame = JSON.parse(raw);
        if (!annotateFrame(frame, slugs, route)) continue;
        lines[index] = `data: ${JSON.stringify(frame)}${line.endsWith("\r") ? "\r" : ""}`;
        return new TextEncoder().encode(lines.join("\n"));
      }
      return bytes;
    }
    const frame = JSON.parse(text);
    return annotateFrame(frame, slugs, route) ? new TextEncoder().encode(JSON.stringify(frame)) : bytes;
  } catch {
    return bytes;
  }
}
