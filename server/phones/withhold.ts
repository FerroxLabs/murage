// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S18: which tool rows of the event log are phone tools. A started row names the tool; the completed row only
// carries the item id, so the started row is remembered (bounded) until its completion is written.
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import type { RuntimeEvent } from "../contracts.ts";

const NAMES = new Set<string>(PHONE_TOOL_NAMES);
const NAME_IN = /phone_[a-z0-9_]+/g;
const CAP = 2000;

function nameOf(event: Record<string, unknown>): string | null {
  const identity = (event.toolIdentity ?? {}) as { namespace?: unknown; name?: unknown };
  const fields = [identity.name, event.title, event.summary, event.toolKind];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    for (const hit of field.match(NAME_IN) ?? []) if (NAMES.has(hit)) return hit;
  }
  // a tool of the phoneJobs server is a phone tool even under a name this build does not know
  if (identity.namespace === "phoneJobs") return typeof identity.name === "string" && identity.name ? identity.name : "phone tool";
  const title = typeof event.title === "string" ? event.title : "";
  if (/(^|[^a-zA-Z])phoneJobs([^a-zA-Z]|$)/.test(title)) return title.slice(0, 80);
  return null;
}

/** The `phoneTool` half of EventBus.withholdText. One instance per bus. */
export function makePhoneToolMatcher(): (event: RuntimeEvent) => { summary: string } | null {
  const seen = new Map<string, string>();
  return (event) => {
    const e = event as unknown as Record<string, unknown>;
    if (e.itemType !== "tool" || typeof e.itemId !== "string") return null;
    const key = `${event.threadId}:${e.itemId}`;
    if (e.type === "item.started") {
      const name = nameOf(e);
      if (!name) return null;
      seen.set(key, name);
      if (seen.size > CAP) seen.delete(seen.keys().next().value as string);
      return { summary: name };
    }
    if (e.type === "item.completed") {
      const name = seen.get(key);
      if (name === undefined) return nameOf(e) ? { summary: nameOf(e)! } : null;
      seen.delete(key);
      return { summary: name };
    }
    return null;
  };
}

/** A permission or question ask for a phone tool (any thread): its summary and arguments carry phone data. */
export function isPhoneRequest(e: Record<string, unknown>): boolean {
  const call = (e.toolCall ?? {}) as { name?: unknown };
  const fields = [e.tool, e.summary, call.name];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    if (/(^|[^a-zA-Z])phoneJobs([^a-zA-Z]|$)/.test(field)) return true;
    for (const hit of field.match(NAME_IN) ?? []) if (NAMES.has(hit)) return true;
  }
  return false;
}
