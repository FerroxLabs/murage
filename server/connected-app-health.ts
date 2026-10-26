// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// WHICH CONNECTED APP NEEDS RECONNECTING.
//
// The inventory says an account is "active" for as long as the connection
// exists, even after the app behind it has started answering 401 (a revoked
// grant, an expired refresh token). Nothing then showed the person that
// Gmail needed signing in again, and the bot was told the service was briefly
// unreachable. This module remembers, per app, that a tool call came back
// with an authorization failure, and forgets it when a call to that app
// succeeds or the person signs in again.
//
// It is deliberately about ONE app. A broker that is dark (404/503), a token
// the broker rejected (401 on the data route) and a dropped connection are
// whole-broker cases handled in composio.ts; none of them marks an app here.

import { SERVICE_TOOL_PREFIX } from "../shared/connected-app-names.ts";

export interface AppHealthMark {
  at: number;
  /** A short cause for the log: an HTTP status or a fixed word, never a body. */
  cause: string;
  /** The active account ids when it was marked; a different set means the
   * person signed in again, which clears the mark. */
  accountKey: string | null;
  /** The accounts a Reconnect is replacing. They are retired only once a NEW
   * active account for the app is seen; until then they stay as they are. */
  replaces?: string[];
}

const marks = new Map<string, Map<string, AppHealthMark>>();

/** The service's own meta tools (search, schema, multi-execute) name no app. */
const SERVICE_META_SLUG = SERVICE_TOOL_PREFIX.slice(0, -1).toLowerCase();

/** The app a tool belongs to: GMAIL_FETCH_EMAILS -> gmail. */
export function toolkitOfTool(tool: string): string | null {
  const slug = tool.trim().split("_")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || slug === SERVICE_META_SLUG) return null;
  return slug;
}

export function markNeedsReconnect(owner: string, slug: string, cause: string, accountKey: string | null): boolean {
  let forOwner = marks.get(owner);
  if (!forOwner) { forOwner = new Map(); marks.set(owner, forOwner); }
  const fresh = !forOwner.has(slug);
  forOwner.set(slug, { at: Date.now(), cause, accountKey });
  return fresh;
}

/** Change a mark in place (its time stays). False when there is none. */
export function updateMark(owner: string, slug: string, patch: Partial<Omit<AppHealthMark, "at" | "cause">>): boolean {
  const mark = marks.get(owner)?.get(slug);
  if (!mark) return false;
  Object.assign(mark, patch);
  return true;
}

export function clearNeedsReconnect(owner: string, slug: string): boolean {
  const forOwner = marks.get(owner);
  const had = forOwner?.delete(slug) ?? false;
  if (forOwner && forOwner.size === 0) marks.delete(owner);
  return had;
}

export function clearAllHealth(owner?: string): void {
  if (owner === undefined) marks.clear();
  else marks.delete(owner);
}

export function healthMark(owner: string, slug: string): AppHealthMark | undefined {
  return marks.get(owner)?.get(slug);
}

export function needsReconnectSlugs(owner: string | null): string[] {
  return owner ? [...(marks.get(owner)?.keys() ?? [])].sort() : [];
}

export function accountKeyOf(accounts: ReadonlyArray<{ id: string; status: string }> | undefined): string {
  return (accounts ?? []).filter((account) => /^active$/i.test(account.status)).map((account) => account.id).sort().join(",");
}

// ── reading an app's answer ────────────────────────────────────────────

// A 403, "forbidden" or "insufficient scope" is NOT here: the sign-in works and a
// permission is missing, which signing in again would not change (Reconnect
// would loop). Only a 401, a rejected or expired grant or token, or a
// connection the broker says is expired, revoked or inactive says the sign-in
// itself has stopped working. Free words such as "please reconnect" are not a
// signal: an app's own message or a fetched email can say anything.
const AUTH_FAILURE = /(?<![\w.])401(?![\w.])|unauthori[sz]ed|invalid[_ ](credentials|grant|token)|(token|grant|credentials)[^"]{0,30}(expired|revoked|invalid)|(expired|revoked)[^"]{0,20}(token|grant|credentials)|connection[^"]{0,30}(expired|revoked|inactive|invalid)/i;

/** The structured places a failure says what it is. Never `message` or
 * `detail`: those are free text and can echo anything the app returned. */
const SIGNAL_KEYS = ["error", "status", "status_code", "statusCode", "http_status", "code", "reason", "type"];

export interface AppAnswerReading {
  /** App slug -> why it failed to authorize. */
  failed: Map<string, string>;
  /** Apps a call reached and that answered without an error. */
  ok: Set<string>;
}

type Json = unknown;
const obj = (value: Json): Record<string, Json> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : null;

function framesOf(bytes: Uint8Array, requestId: unknown): Array<Record<string, Json>> {
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return [];
  const all: Json[] = [];
  const parse = (value: string) => { try { all.push(JSON.parse(value)); } catch { /* not a frame */ } };
  if (text.startsWith("{") || text.startsWith("[")) parse(text);
  else for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) parse(line.slice(5).trim());
  return all.flatMap((frame) => Array.isArray(frame) ? frame : [frame])
    .map(obj)
    .filter((frame): frame is Record<string, Json> => frame !== null && (requestId === undefined || requestId === null || frame.id === requestId));
}

const slugOfRow = (row: Record<string, Json>): string | null => {
  const tool = row.tool_slug ?? row.toolSlug;
  return typeof tool === "string" ? toolkitOfTool(tool) : null;
};

/** The per-tool rows of one answer, read only where the broker puts them: the
 * answer itself, or its own `results` (`data.results` of a multi-execute).
 * Never deeper: a fetched email or file can carry any JSON. A row counts only
 * for an app the request named. */
function rowsOf(value: Json, apps: ReadonlyArray<string>): Array<Record<string, Json>> {
  const top = obj(value);
  const candidates: Json[] = Array.isArray(value) ? value : [];
  if (top) {
    if (slugOfRow(top) !== null) candidates.push(top);
    const data = obj(top.data);
    if (Array.isArray(data?.results)) candidates.push(...data!.results as Json[]);
    if (Array.isArray(top.results)) candidates.push(...top.results as Json[]);
  }
  return candidates.map(obj).filter((row): row is Record<string, Json> => {
    if (!row) return false;
    const slug = slugOfRow(row);
    return slug !== null && apps.includes(slug);
  });
}

function signalText(sources: ReadonlyArray<Record<string, Json> | null>): string {
  const parts: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const key of SIGNAL_KEYS) {
      const v = source[key];
      if (typeof v === "string" || typeof v === "number") parts.push(String(v));
      else if (obj(v)) for (const subKey of SIGNAL_KEYS) {
        const sub = obj(v)![subKey];
        if (typeof sub === "string" || typeof sub === "number") parts.push(String(sub));
      }
    }
  }
  return parts.join(" ").slice(0, 600);
}

/** The structured words of a failure, capped; null when it did not fail. */
function failureText(row: Record<string, Json>): string | null {
  // The row and its response only: `data` is what the app returned and can
  // hold anything, including words that look like a failure.
  const response = obj(row.response);
  const sources = [row, response].filter((s): s is Record<string, Json> => s !== null);
  const failed = sources.some((s) => s.successful === false || s.success === false || s.isError === true)
    || sources.some((s) => typeof s.error === "string" && s.error.trim() !== "")
    || sources.some((s) => obj(s.error) !== null);
  if (!failed) return null;
  return signalText(sources);
}

function causeOf(text: string): string {
  const status = /(?<![\w.])(401)(?![\w.])/.exec(text)?.[1];
  return status ? `HTTP ${status}` : "sign-in no longer accepted";
}

/** What one connected-app action's answer says about each app it touched.
 * `tools` are the tool slugs the request named. */
export function readAppAnswer(tools: ReadonlyArray<string>, requestId: unknown, bytes: Uint8Array): AppAnswerReading {
  const reading: AppAnswerReading = { failed: new Map(), ok: new Set() };
  const apps = [...new Set(tools.map(toolkitOfTool).filter((slug): slug is string => slug !== null))];
  if (apps.length === 0) return reading;
  for (const frame of framesOf(bytes, requestId)) {
    const errorFrame = obj(frame.error);
    const result = obj(frame.result);
    const texts: string[] = [];
    const plain: string[] = [];
    const parsed: Json[] = [];
    for (const part of Array.isArray(result?.content) ? result!.content as Json[] : []) {
      const text = obj(part)?.text;
      if (typeof text !== "string") continue;
      texts.push(text);
      try { parsed.push(JSON.parse(text)); } catch { plain.push(text); }
    }
    if (result && Object.keys(result).length && !texts.length) parsed.push(result);
    const rows = parsed.flatMap((value) => rowsOf(value, apps));
    if (rows.length) {
      for (const row of rows) {
        const slug = slugOfRow(row);
        if (!slug) continue;
        const text = failureText(row);
        if (text === null) { if (!reading.failed.has(slug)) reading.ok.add(slug); }
        else if (AUTH_FAILURE.test(text)) { reading.failed.set(slug, causeOf(text)); reading.ok.delete(slug); }
      }
      continue;
    }
    // No per-tool rows: the answer speaks for the call. That is only
    // attributable when the call touched exactly one app.
    if (apps.length !== 1) continue;
    const slug = apps[0]!;
    // A JSON-RPC error is read by its structured fields only; a plain-words
    // answer the tool itself flagged as an error is that error's own text.
    const whole = [errorFrame ? signalText([errorFrame, obj(errorFrame.data)]) : "", ...(result?.isError === true ? plain : [])];
    const topLevel = parsed.map(obj).filter((p): p is Record<string, Json> => p !== null).map(failureText).filter((t): t is string => t !== null);
    const failure = [...whole, ...topLevel].find((text) => text && AUTH_FAILURE.test(text.slice(0, 600)));
    if (failure) reading.failed.set(slug, causeOf(failure));
    else if (result && result.isError !== true && !errorFrame && topLevel.length === 0) reading.ok.add(slug);
  }
  return reading;
}
