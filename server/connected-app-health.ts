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

import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { ConnectorHealthStore, type AppHealthMark } from "./connector-health-store.ts";
export type { AppHealthMark } from "./connector-health-store.ts";
let durable: ConnectorHealthStore | undefined;
export function connectorHealthStore(): ConnectorHealthStore {
  return durable ??= new ConnectorHealthStore(join(DATA_DIR, "connector-health.json"));
}

/** The service's own meta tools (search, schema, multi-execute) name no app. */
const SERVICE_META_SLUG = SERVICE_TOOL_PREFIX.slice(0, -1).toLowerCase();

/** The app a tool belongs to: GMAIL_FETCH_EMAILS -> gmail. */
export function toolkitOfTool(tool: string): string | null {
  const slug = tool.trim().split("_")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || slug === SERVICE_META_SLUG) return null;
  return slug;
}

export function markNeedsReconnect(owner: string, slug: string, cause: string, accountKey: string | null): boolean {
  return connectorHealthStore().mark(owner, slug, cause, accountKey);
}

export function updateMark(owner: string, slug: string, patch: Partial<Omit<AppHealthMark, "at" | "cause">>): boolean {
  return connectorHealthStore().update(owner, slug, patch);
}
export function clearNeedsReconnect(owner: string, slug: string): boolean {
  return connectorHealthStore().clear(owner, slug);
}
export function clearAllHealth(owner?: string): void { connectorHealthStore().clearAll(owner); }
export function healthMark(owner: string, slug: string): AppHealthMark | undefined {
  return connectorHealthStore().get(owner, slug);
}
export function needsReconnectSlugs(owner: string | null): string[] {
  return owner ? connectorHealthStore().slugs(owner) : [];
}

export function accountKeyOf(accounts: ReadonlyArray<{ id: string; status: string }> | undefined): string {
  return (accounts ?? []).filter((account) => /^active$/i.test(account.status)).map((account) => account.id).sort().join(",");
}

// ── reading an app's answer ────────────────────────────────────────────

export interface AppAnswerReading {
  /** App slug -> why it failed to authorize. */
  failed: Map<string, string>;
  /** Apps a call reached and that answered without an error. */
  ok: Set<string>;
  /** Any explicit failed tool result, independent of unstable provider wording. */
  errors: Set<string>;
  /** Upstream HTTP status inside an error result, never transport auth. */
  authStatus: Map<string, number>;
  brokerAuth: boolean;
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
function resultRowsOf(value: Json): Json[] | null {
  if (Array.isArray(value)) return value;
  const top = obj(value);
  const candidates: Json[] = [];
  let present = false;
  if (top) {
    if (slugOfRow(top) !== null) { candidates.push(top); present = true; }
    const data = obj(top.data);
    if (Array.isArray(data?.results)) { candidates.push(...data!.results as Json[]); present = true; }
    if (Array.isArray(top.results)) { candidates.push(...top.results as Json[]); present = true; }
  }
  return present ? candidates : null;
}

function rowsOf(value: Json, apps: ReadonlyArray<string>): Array<Record<string, Json>> {
  return (resultRowsOf(value) ?? []).map(obj).filter((row): row is Record<string, Json> => {
    if (!row) return false;
    const slug = slugOfRow(row);
    return slug !== null && apps.includes(slug);
  });
}

/** Only documented HTTP fields at the envelope boundary are authoritative.
 * Application data and JSON-RPC/provider `code` fields are deliberately excluded. */
export function structuredStatus(source: unknown): number | null {
  const row = obj(source);
  for (const envelope of [row, obj(row?.response), obj(row?.error), obj(obj(row?.response)?.error)]) {
    for (const key of ["status", "status_code", "statusCode", "http_status"]) {
      const value = envelope?.[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
      if (typeof value === "string" && /^[1-5][0-9]{2}$/.test(value)) return Number(value);
    }
  }
  return null;
}

function parsedContent(frame: Record<string, Json>): Json[] {
  const result = obj(frame.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const parsed: Json[] = [];
  for (const part of content) {
    const text = obj(part)?.text;
    if (typeof text !== "string") continue;
    try { parsed.push(JSON.parse(text)); } catch { /* Plain text is never an HTTP status. */ }
  }
  if (result && !Array.isArray(result.content)) parsed.push(result);
  return parsed;
}

function rowBrokerAuth(row: Record<string, Json>): boolean {
  return [row, obj(row.response), obj(row.error), obj(obj(row.response)?.error)].some(envelope => envelope?.kind === "auth");
}

/** Flux's project key is an outage, including when it arrives inside a result row. */
export function brokerAuthOf(frame: unknown): boolean {
  const source = obj(frame);
  if (!source) return false;
  const error = obj(source.error);
  if (error?.kind === "auth" || obj(error?.data)?.kind === "auth") return true;
  return parsedContent(source).some(value => {
    const row = obj(value);
    if (row && (row.kind === "auth" || obj(row.error)?.kind === "auth")) return true;
    return (resultRowsOf(value) ?? []).some(value => {
      const result = obj(value);
      return !!result && slugOfRow(result) !== null && rowBrokerAuth(result);
    });
  });
}

function failedEnvelope(row: Record<string, Json>): boolean {
  return [row, obj(row.response)].some(source => source && (
    source.successful === false || source.success === false || source.isError === true
    || (typeof source.error === "string" && source.error.trim() !== "") || obj(source.error) !== null
  ));
}

// This documented diagnostic can only suppress reconnect, never establish it.
function brokerDiagnostic(frame: Record<string, Json>): boolean {
  const error = obj(frame.error), result = obj(frame.result);
  const texts: unknown[] = [error?.message, ...(result?.isError === true && Array.isArray(result.content)
    ? result.content.map(part => obj(part)?.text) : [])];
  for (const value of parsedContent(frame)) {
    const top = obj(value);
    if (!top) continue;
    const rows = [top, ...(Array.isArray(top.results) ? top.results : []), ...(Array.isArray(obj(top.data)?.results) ? obj(top.data)!.results as Json[] : [])];
    for (const value of rows) {
      const row = obj(value);
      if (!row || !failedEnvelope(row)) continue;
      for (const source of [row, obj(row.response), obj(row.error), obj(obj(row.response)?.error)]) texts.push(source?.error, source?.message);
    }
  }
  return texts.some(text => typeof text === "string" && /Connected-apps provider rejected FluxRouter['’]s credentials/i.test(text));
}

export function readAppAnswer(tools: ReadonlyArray<string>, requestId: unknown, bytes: Uint8Array, rowIndex?: number): AppAnswerReading {
  const reading: AppAnswerReading = { failed: new Map(), ok: new Set(), errors: new Set(), authStatus: new Map(), brokerAuth: false };
  const apps = [...new Set(tools.map(toolkitOfTool).filter((slug): slug is string => slug !== null))];
  if (!apps.length) return reading;
  const error = (slug: string, status: number | null) => {
    reading.errors.add(slug); reading.ok.delete(slug);
    if (status === 401 || status === 403) {
      reading.authStatus.set(slug, status); reading.failed.set(slug, `HTTP ${status}`);
    }
  };
  const frames = framesOf(bytes, requestId);
  // Broker-auth precedence applies to the entire call, before any account changes.
  if (frames.some(frame => brokerAuthOf(frame) || brokerDiagnostic(frame))) {
    reading.brokerAuth = true; return reading;
  }
  for (const frame of frames) {
    const errorFrame = obj(frame.error), result = obj(frame.result);
    const parsed = parsedContent(frame);
    const rows = parsed.flatMap(value => rowsOf(value, apps));
    if (rows.length) {
      for (const row of rows.filter(row => rowIndex === undefined || row.index === rowIndex)) {
        const slug = slugOfRow(row)!;
        const status = structuredStatus(row);
        if (failedEnvelope(row) || (status !== null && status >= 400)) error(slug, status);
        else if (!reading.errors.has(slug)) reading.ok.add(slug);
      }
      continue;
    }
    if (rowIndex !== undefined) continue;
    // Keep whole-call failures, but never infer recovery from an empty or
    // unmatched collection's aggregate success flag or a foreign app's row.
    const objects = parsed.map(obj).filter((row): row is Record<string, Json> =>
      row !== null && slugOfRow(row) === null && Object.keys(row).length > 0);
    const sources = [obj(errorFrame?.data), errorFrame, ...objects.flatMap(row => [row, obj(row.error)])];
    const status = sources.map(structuredStatus).find(status => status !== null) ?? null;
    if (errorFrame || result?.isError === true || objects.some(failedEnvelope) || (status !== null && status >= 400)) {
      for (const slug of apps) error(slug, apps.length === 1 ? status : null);
    } else if (objects.length && parsed.every(value => resultRowsOf(value) === null)) {
      for (const slug of apps) if (!reading.errors.has(slug)) reading.ok.add(slug);
    }
  }
  return reading;
}
