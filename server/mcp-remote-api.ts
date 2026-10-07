// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The logic behind the link routes of /api/mcp (spec MCP-LINK 3.11), kept out of
// index.ts so each rule is a named function with its own test: who may call a
// commit route, what a body may carry, what an inspect answer may show. The
// routes in index.ts only wire these to the request.
import { parsePaste, type PasteDraft, type PasteField, type PasteFailureReason, type PasteNote } from "../shared/mcp-paste.ts";
import type { LocalConfirmation } from "../shared/remote-mcp-url.mjs";
import { splitSecretUrl, urlHasSecret } from "../shared/mcp-secret-url.mjs";
import { isRemoteMcpServer, mcpServerNameError, type AnyStoredMcpServer, type StoredRemoteMcpServer } from "./mcp-registry.ts";
import type { McpProbeResult } from "./mcp-probe.ts";
import { probeRemoteMcp, type RemoteProbeInput } from "./remote-mcp-client.ts";
import { resolveDialUrl, resolveRequestAuth, sanitizeSecretDoc, type McpServerSecrets } from "./mcp-secrets.ts";
import { unionScopeText } from "./mcp-signin-card.ts";
import { modelProviderCommitAuthorized } from "./provider-bank-fence.ts";

const LOCAL_CONFIRMATIONS = new Set<string>(["this-computer", "local-network"]);
export const MAX_INSPECT_INPUT_BYTES = 64 * 1024;
export const MAX_INSPECT_PROBES = 5;
export const MAX_SECRETS_BODY_BYTES = 64 * 1024;
/** No inspect or Test holds a probe slot longer than this, whatever the server
 * does (M4): a stuck probe must not be able to use up the concurrency slots. */
export const MCP_ROUTE_DEADLINE_MS = 60_000;

/** `parent` aborts, or `ms` passes, whichever is first. */
export function withDeadline(parent: AbortSignal | undefined, ms: number): AbortSignal {
  return parent ? AbortSignal.any([parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** Stamp a pushed secrets doc with the origin of the entry it is saved for.
 * A push that names a different origin is stale (the entry was edited) and is
 * refused, so a late push cannot bind a secret to the wrong place. */
export function bindSecretsToEntry(doc: McpServerSecrets, entryUrl: string): { ok: true; doc: McpServerSecrets } | { ok: false; error: string } {
  let origin: string;
  try {
    origin = new URL(entryUrl).origin;
  } catch {
    return { ok: false, error: "This server's link is not valid." };
  }
  if (doc.origin !== undefined && doc.origin !== origin) return { ok: false, error: "These secrets were issued for another address." };
  return { ok: true, doc: { ...doc, origin } };
}

/** An edit that changes where a link server is, or how it signs in, leaves its
 * saved secrets unusable. True when they must be dropped. */
export function secretsNoLongerApply(before: AnyStoredMcpServer, after: AnyStoredMcpServer): boolean {
  // A change of kind, either way: a command server's env values are not a
  // link server's secrets, and the other way round.
  if (isRemoteMcpServer(before) !== isRemoteMcpServer(after)) return true;
  if (!isRemoteMcpServer(before) || !isRemoteMcpServer(after)) return false;
  return before.url !== after.url || before.auth !== after.auth;
}

/** Editing what a command server runs (its command or arguments) while it holds
 * saved env values: the owner must say whether those values go to the new
 * command or are cleared. Never decided silently (review L6). */
export function commandEditNeedsEnvChoice(before: AnyStoredMcpServer, after: AnyStoredMcpServer): boolean {
  if (isRemoteMcpServer(before) || isRemoteMcpServer(after)) return false;
  const holdsValues = Object.keys(before.env).length > 0 || (before.heldEnv?.length ?? 0) > 0;
  if (!holdsValues) return false;
  return before.command !== after.command || JSON.stringify(before.args) !== JSON.stringify(after.args);
}

/** A commit route answers only the desktop shell's per-launch token. The caller
 * has already passed the desktop-surface proof; this is the second lock, the
 * same exact-match bearer that guards the model provider commit routes. */
export function mcpCommitRouteAllowed(authorization: unknown, expected: string): boolean {
  return modelProviderCommitAuthorized(authorization, expected);
}

/** Whether a mutation body may carry a secret. Only a run with no desktop shell
 * (dev, headless) keeps secrets in config.json and so accepts them in the body;
 * in the packaged app the renderer sends placeholders and main holds values. */
export function secretsInBodyAllowed(hasDesktopShell: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  // MURAGE_SECRETS_EXTERNAL=1 forces the packaged rule. It can only refuse more.
  return !hasDesktopShell && env.MURAGE_SECRETS_EXTERNAL !== "1";
}

export function parseConfirmLocal(value: unknown): { ok: true; value: LocalConfirmation | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return typeof value === "string" && LOCAL_CONFIRMATIONS.has(value) ? { ok: true, value: value as LocalConfirmation } : { ok: false };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** True when a request body is a link server rather than a command. */
export function isRemoteBody(body: unknown): boolean {
  return isRecord(body) && (typeof body.url === "string" || typeof body.serverUrl === "string" || typeof body.httpUrl === "string");
}

/** The raw entry for parseAnyMcpServerMutation from a request body: only the
 * fields a link entry has, so `name`, `confirmLocal` and anything else never
 * ride into the stored entry. A dev/headless run (`secretsInBody`) that sends a
 * link holding a key has it split the way the packaged app would, except the
 * full link stays in config.json with `urlSecret` set. */
export function prepareRemoteBody(body: Record<string, unknown>, secretsInBody: boolean): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of ["url", "serverUrl", "httpUrl", "type", "transport", "auth", "headers", "urlSecret", "enabled"] as const) {
    if (body[key] !== undefined) raw[key] = body[key];
  }
  const link = [raw.url, raw.serverUrl, raw.httpUrl].find((value): value is string => typeof value === "string");
  if (secretsInBody && link && raw.urlSecret === undefined && urlHasSecret(link)) {
    const split = splitSecretUrl(link, { keepFullInConfig: true });
    if (split?.urlSecret) {
      delete raw.serverUrl;
      delete raw.httpUrl;
      raw.url = split.storedUrl;
      raw.urlSecret = true;
    }
  }
  return raw;
}

/** The body of a secrets push from the desktop shell: a bounded object, reduced
 * to the fields the harness may hold. Returns null for anything else. */
export function validateSecretsPush(body: unknown): McpServerSecrets | null {
  if (!isRecord(body)) return null;
  if (JSON.stringify(body).length > MAX_SECRETS_BODY_BYTES) return null;
  return sanitizeSecretDoc(body);
}

/**
 * The secrets route's whole rule (MCP-LINK 3.4, NEXT-T11 L-d). A link server's
 * push must name the origin main issued it for: none is 400, another than the
 * entry's is 409 (the entry was edited after main read it). It carries no env.
 * A command server's push carries env values only, and no origin.
 */
export function acceptSecretsPush(body: unknown, server: AnyStoredMcpServer):
  { ok: true; doc: McpServerSecrets } | { ok: false; status: 400 | 409; error: string } {
  const doc = validateSecretsPush(body);
  if (!doc) return { ok: false, status: 400, error: "Invalid secrets." };
  if (!isRemoteMcpServer(server)) {
    if (doc.origin !== undefined || doc.headers || doc.url || doc.oauth || !doc.env) return { ok: false, status: 400, error: "Invalid secrets." };
    return { ok: true, doc: { env: doc.env } };
  }
  if (doc.env) return { ok: false, status: 400, error: "Invalid secrets." };
  if (doc.origin === undefined) return { ok: false, status: 400, error: "Name the address these secrets were issued for." };
  const bound = bindSecretsToEntry(doc, server.url);
  return bound.ok ? bound : { ok: false, status: 409, error: bound.error };
}

// ── inspect ─────────────────────────────────────────────────────────────

export type RedactedField = Omit<PasteField, "value"> & { hasValue: boolean; value?: string };

export type RedactedDraft =
  | { kind: "stdio"; name: string; command: string; args: string[]; fields: RedactedField[] }
  | {
    kind: "remote"; name: string; maskedUrl: string; urlHasSecret: boolean; transport?: "http" | "sse";
    convertedFrom?: "mcp-remote" | "mcp-proxy"; fields: RedactedField[]; probe?: McpProbeResult;
  };

/** What an inspect answer may say about a draft. The pasted link (which may hold
 * a key) is dropped in favour of its masked form, and a secret field's pasted
 * value is dropped too: the renderer already has the paste, and a response body
 * is one more place a key could be left. Non-secret values stay (they are not
 * secret and the panel shows them as editable text). */
export function redactDraftForResponse(draft: PasteDraft, probe?: McpProbeResult): RedactedDraft {
  const fields: RedactedField[] = draft.fields.map((field) => {
    const { value, ...rest } = field;
    return field.secret ? { ...rest, hasValue: value !== undefined } : { ...rest, hasValue: value !== undefined, ...(value !== undefined ? { value } : {}) };
  });
  if (draft.kind === "stdio") return { kind: "stdio", name: draft.name, command: draft.command, args: draft.args, fields };
  return {
    kind: "remote", name: draft.name, maskedUrl: draft.maskedUrl, urlHasSecret: draft.urlHasSecret,
    ...(draft.transport ? { transport: draft.transport } : {}),
    ...(draft.convertedFrom ? { convertedFrom: draft.convertedFrom } : {}),
    fields,
    ...(probe ? { probe } : {}),
  };
}

export interface InspectDeps {
  existingNames: ReadonlySet<string>;
  probe?: (input: RemoteProbeInput) => Promise<McpProbeResult>;
  signal?: AbortSignal;
  resolver?: RemoteProbeInput["resolver"];
}

export type InspectResponse =
  | { status: 200; body: { ok: true; source: "link" | "json" | "command"; drafts: RedactedDraft[]; notes: string[]; noteKeys: PasteNote[] } }
  | { status: 200; body: { ok: false; reason: PasteFailureReason; message: string } }
  | { status: 400; body: { error: string } };

/** Parse what was pasted and probe each link WITHOUT credentials. Saves nothing.
 * A link that points at this computer or the local network answers
 * `local-confirm` before any request is sent, until `confirmLocal` is sent. */
export async function inspectMcpInput(body: unknown, deps: InspectDeps): Promise<InspectResponse> {
  if (!isRecord(body) || typeof body.input !== "string") return { status: 400, body: { error: "Paste a link, a command, or a config snippet." } };
  const confirm = parseConfirmLocal(body.confirmLocal);
  if (!confirm.ok) return { status: 400, body: { error: "Unknown local confirmation." } };
  if (new TextEncoder().encode(body.input).length > MAX_INSPECT_INPUT_BYTES) {
    const refused = parsePaste("x".repeat(MAX_INSPECT_INPUT_BYTES + 1));
    return refused.ok ? { status: 400, body: { error: "Too large." } } : { status: 200, body: { ok: false, reason: refused.reason, message: refused.message } };
  }
  const parsed = parsePaste(body.input, { isNameTaken: (name) => deps.existingNames.has(name) || mcpServerNameError(name) !== null });
  if (!parsed.ok) return { status: 200, body: { ok: false, reason: parsed.reason, message: parsed.message } };
  const probe = deps.probe ?? probeRemoteMcp;
  let probed = 0;
  const drafts: RedactedDraft[] = [];
  for (const draft of parsed.drafts) {
    if (draft.kind === "remote" && probed < MAX_INSPECT_PROBES) {
      probed += 1;
      const result = await probe({ url: draft.url, transport: draft.transport, confirmed: confirm.value ?? null, mode: "inspect", signal: deps.signal, resolver: deps.resolver });
      drafts.push(redactDraftForResponse(draft, result));
    } else {
      drafts.push(redactDraftForResponse(draft));
    }
  }
  return { status: 200, body: { ok: true, source: parsed.source, drafts, notes: parsed.notes, noteKeys: parsed.noteKeys } };
}

// ── test and sign-in target ─────────────────────────────────────────────

export interface RemoteTestDeps {
  probe?: (input: RemoteProbeInput) => Promise<McpProbeResult>;
  signal?: AbortSignal;
  resolver?: RemoteProbeInput["resolver"];
  now?: number;
}

/** Probe a saved link server with its stored credentials. A header with no value
 * anywhere is `needs-key` without a request, and a masked link with no stored
 * copy cannot be dialed. */
export async function testRemoteServer(name: string, server: StoredRemoteMcpServer, deps: RemoteTestDeps = {}): Promise<McpProbeResult> {
  const url = resolveDialUrl(name, server);
  const auth = resolveRequestAuth(name, server, deps.now);
  if (url === null || (server.auth === "header" && auth.missing.length > 0)) {
    return { ok: false, reason: "needs-key", error: "This server needs an API key.", apiKey: { headerHint: "authorization" } };
  }
  return (deps.probe ?? probeRemoteMcp)({
    url, transport: server.transport, headers: auth.headers, bearer: auth.bearer,
    confirmed: server.local ?? null, mode: "request", signal: deps.signal, resolver: deps.resolver,
  });
}

export interface OauthTarget {
  url: string;
  resourceMetadataUrl?: string;
  scopeHint?: string;
  local?: LocalConfirmation;
}

/** What main needs to start a sign-in: the link and the server's own hints. No
 * secret. A link that holds a key cannot sign in (null). */
export async function oauthTargetFor(name: string, server: StoredRemoteMcpServer, deps: RemoteTestDeps = {}, hints: { stepUpScope?: string } = {}): Promise<OauthTarget | null> {
  if (server.urlSecret === true) return null;
  const url = resolveDialUrl(name, server);
  if (url === null) return null;
  const result = await (deps.probe ?? probeRemoteMcp)({ url, transport: server.transport, confirmed: server.local ?? null, mode: "request", signal: deps.signal, resolver: deps.resolver });
  const signIn = !result.ok ? result.signIn : undefined;
  // The server's own hint, plus what a tool call was refused for (403
  // insufficient_scope, carried on the waiting sign-in card): main asks for the
  // union of these and what was granted before.
  const scopeHint = unionScopeText(signIn?.scopeHint, hints.stepUpScope);
  return {
    url,
    ...(signIn?.resourceMetadataUrl ? { resourceMetadataUrl: signIn.resourceMetadataUrl } : {}),
    ...(scopeHint ? { scopeHint } : {}),
    ...(server.local ? { local: server.local } : {}),
  };
}
