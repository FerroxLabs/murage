// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What the MCP servers panel does, apart from how it looks: inspect a paste,
// save an entry, hand secrets to the desktop shell, sign in, test, turn on,
// remove. Every call goes through injected dependencies so a test can prove the
// sequencing contract in lanes/mcplink/API-T11.md and that no secret value is
// ever in a request body when the desktop bridge is there.
import { isSecretName, looksSecretValue, PASTE_MESSAGES, PASTE_NOTE_TEMPLATES, formatPasteNote, parsePaste, type PasteDraft, type PasteField, type PasteFailureReason, type PasteNote, type PasteRemoteDraft, type PasteStdioDraft } from "../../shared/mcp-paste";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { McpBridge, McpSecretsInput } from "./mcp-bridge";

export type ApiFn = (path: string, init?: { method?: string; body?: string }) => Promise<any>;
export interface FlowDeps { api: ApiFn; bridge?: McpBridge }

export type ProbeReason =
  | "spawn" | "timeout" | "closed" | "cancelled" | "initialize" | "protocol" | "still-installing"
  | "needs-sign-in" | "needs-key" | "key-rejected" | "sign-in-ended" | "needs-more-access"
  | "not-found" | "unreachable" | "wrong-address" | "moved" | "https-required" | "local-confirm"
  | "address-changed" | "blocked-address" | "server-error" | "no-answer";

export type LocalKind = "this-computer" | "local-network";

/** What a probe said: fixed sentences and codes only, never a value. */
export type ProbeView =
  | { ok: true; tools: Array<{ name: string; description?: string }>; transport?: "http" | "sse" }
  | {
    ok: false; error: string; reason?: ProbeReason;
    signIn?: { host: string };
    apiKey?: { headerHint: "x-api-key" | "authorization" };
    suggestUrl?: string; suggestHoldsSecret?: boolean; needs?: LocalKind; scopes?: string[];
  };

export type MergedDraft = (PasteRemoteDraft | PasteStdioDraft) & { probe?: ProbeView };

export type InspectOutcome =
  | { ok: true; source: "link" | "json" | "command"; drafts: MergedDraft[]; notes: string[] }
  | { ok: false; message: string };

// ── the parser's sentences, in the owner's language ─────────────────────
// shared/mcp-paste.ts speaks English (it also runs in the harness). It hands
// over a reason or a note key beside each sentence, and the panel shows the
// catalogue's text for that key: mcp.paste.fail.<reason>, mcp.paste.note.<key>.

/** A refusal's sentence. A reason this build does not know shows the text it came with. */
export function pasteFailureText(reason: unknown, fallback = ""): string {
  return typeof reason === "string" && Object.hasOwn(PASTE_MESSAGES, reason) ? t(`mcp.paste.fail.${reason as PasteFailureReason}` as LocaleKey) : fallback;
}

export function pasteNoteText(note: PasteNote): string {
  return formatPasteNote(note, t(`mcp.paste.note.${note.key}` as LocaleKey));
}

function noteKeysFrom(value: unknown): PasteNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: PasteNote[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { key, entry, field } = item as Record<string, unknown>;
    if (typeof key !== "string" || !Object.hasOwn(PASTE_NOTE_TEMPLATES, key) || typeof entry !== "string" || (field !== undefined && typeof field !== "string")) return null;
    notes.push({ key: key as PasteNote["key"], entry, ...(typeof field === "string" ? { field } : {}) });
  }
  return notes;
}

/** Parse locally (the paste carries the link and values the server drops from
 * its answer), ask the harness to probe each link without credentials, and
 * line the two up by position. */
export async function inspectInput(deps: FlowDeps, input: string, confirmLocal?: LocalKind): Promise<InspectOutcome> {
  const local = parsePaste(input);
  if (!local.ok) return { ok: false, message: pasteFailureText(local.reason, local.message) };
  const answer = await deps.api("/api/mcp/inspect", { method: "POST", body: JSON.stringify({ input, ...(confirmLocal ? { confirmLocal } : {}) }) });
  if (!answer?.ok) return { ok: false, message: pasteFailureText(answer?.reason, String(answer?.message ?? "")) };
  const drafts: MergedDraft[] = local.drafts.map((draft: PasteDraft, index: number) => {
    const remote = answer.drafts?.[index];
    return { ...draft, name: typeof remote?.name === "string" ? remote.name : draft.name, ...(remote?.probe ? { probe: remote.probe as ProbeView } : {}) };
  });
  // The harness is the authority on the notes; an answer without keys shows the local parse's.
  const notes = (noteKeysFrom(answer.noteKeys) ?? local.noteKeys).map(pasteNoteText);
  return { ok: true, source: local.source, drafts, notes };
}

// ── choosing how a key is sent ──────────────────────────────────────────

export type HeaderChoice = "authorization" | "x-api-key" | "custom";

export function headerFor(choice: HeaderChoice, custom: string): { name: string; prefix: string } {
  if (choice === "authorization") return { name: "Authorization", prefix: "Bearer " };
  if (choice === "x-api-key") return { name: "X-API-Key", prefix: "" };
  return { name: custom.trim(), prefix: "" };
}

export function defaultHeaderChoice(hint: "x-api-key" | "authorization" | undefined): HeaderChoice {
  return hint === "x-api-key" ? "x-api-key" : "authorization";
}

/** The staged wording for a first run that downloads before it starts. */
export function installStage(elapsedSeconds: number): "start" | "setup" | "still" {
  return elapsedSeconds < 8 ? "start" : elapsedSeconds < 60 ? "setup" : "still";
}

// ── secrets and bodies ──────────────────────────────────────────────────

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").split("/")[0] ?? url; }
}

/** The value each header field of a draft holds, with its fixed prefix. */
export function headerValues(fields: readonly PasteField[], typed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.where.type !== "header") continue;
    const value = (typed[field.id] ?? field.value ?? "").trim();
    if (value) out[field.where.name] = `${field.where.prefix ?? ""}${value}`;
  }
  return out;
}

export function envValues(fields: readonly PasteField[], typed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.where.type !== "env") continue;
    const value = typed[field.id] ?? field.value ?? "";
    if (value !== "") out[field.where.name] = value;
  }
  return out;
}

/** What goes in the request body, and what goes to the desktop shell. With no
 * shell the values stay in the body (the harness refuses them whenever it has
 * one). A value is `true` in the body when the shell holds it. */
export function splitValues(values: Record<string, string>, bridge: McpBridge | undefined): { body: Record<string, string | true>; secrets: Record<string, string> } {
  if (!bridge) return { body: { ...values }, secrets: {} };
  const body: Record<string, true> = {};
  for (const name of Object.keys(values)) body[name] = true;
  return { body, secrets: { ...values } };
}

export interface RemoteSave {
  name: string;
  draft: PasteRemoteDraft;
  auth: "none" | "oauth" | "header";
  /** Header name -> full value (prefix included). */
  headers: Record<string, string>;
  confirmLocal?: LocalKind;
  /** The entry exists already (an earlier step saved it): replace it. */
  existing?: boolean;
}

export type FlowFailure = { ok: false; message: string };

function failure(error: unknown): FlowFailure {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

/** Save a link entry off, then hand its secrets to the shell (only after the
 * entry exists: a save before the 201 is refused, NEXT-T11 L-f). */
export async function saveRemote(deps: FlowDeps, save: RemoteSave): Promise<{ ok: true } | FlowFailure> {
  const { bridge } = deps;
  const { body: headerBody, secrets: headerSecrets } = splitValues(save.headers, bridge);
  const holdsSecretUrl = save.draft.urlHasSecret;
  // With a shell, the stored link is the masked one and the full link goes to
  // the shell. Without one the full link goes in the body and the harness splits it.
  const url = holdsSecretUrl && bridge ? save.draft.maskedUrl : save.draft.url;
  const body = {
    ...(save.existing ? {} : { name: save.name }),
    url,
    ...(holdsSecretUrl && bridge ? { urlSecret: true } : {}),
    ...(save.draft.transport ? { transport: save.draft.transport } : {}),
    auth: save.auth,
    ...(Object.keys(headerBody).length ? { headers: headerBody } : {}),
    ...(save.confirmLocal ? { confirmLocal: save.confirmLocal } : {}),
    ...(save.existing ? {} : { enabled: false }),
  };
  try {
    await deps.api(save.existing ? `/api/mcp/servers/${encodeURIComponent(save.name)}` : "/api/mcp/servers", { method: save.existing ? "PUT" : "POST", body: JSON.stringify(body) });
  } catch (error) {
    return failure(error);
  }
  const input: McpSecretsInput = {
    ...(Object.keys(headerSecrets).length ? { headers: headerSecrets } : {}),
    ...(holdsSecretUrl && bridge ? { url: save.draft.url } : {}),
  };
  if (bridge && (input.headers || input.url)) {
    const saved = await bridge.saveSecrets(save.name, input);
    if (!saved.ok) return { ok: false, message: saved.message };
  }
  return { ok: true };
}

export interface CommandSave {
  name: string;
  draft: PasteStdioDraft;
  env: Record<string, string>;
  existing?: boolean;
}

export async function saveCommand(deps: FlowDeps, save: CommandSave): Promise<{ ok: true } | FlowFailure> {
  const { body: envBody, secrets } = splitValues(save.env, deps.bridge);
  try {
    await deps.api("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({ name: save.name, command: save.draft.command, args: save.draft.args, env: envBody, enabled: false }),
    });
  } catch (error) {
    return failure(error);
  }
  if (deps.bridge && Object.keys(secrets).length) {
    const saved = await deps.bridge.saveSecrets(save.name, { env: secrets });
    if (!saved.ok) return { ok: false, message: saved.message };
  }
  return { ok: true };
}

export async function testServer(deps: FlowDeps, name: string, firstRun = false): Promise<ProbeView> {
  try {
    return await deps.api(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST", ...(firstRun ? { body: JSON.stringify({ patience: "first-run" }) } : {}) }) as ProbeView;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setEnabled(deps: FlowDeps, name: string, enabled: boolean): Promise<void> {
  await deps.api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
}

/** Sign in needs the desktop shell. */
export async function signInTo(deps: FlowDeps, name: string): Promise<{ ok: true } | { ok: false; message: string; cancelled: boolean }> {
  if (!deps.bridge) return { ok: false, message: "", cancelled: false };
  const result = await deps.bridge.signIn(name);
  return result.ok ? { ok: true } : { ok: false, message: result.message, cancelled: result.error === "cancelled" };
}

/** Remove an entry. With the shell it does the revoking, clearing and DELETE
 * itself; without it the panel deletes. Returns the sentence to show, if any. */
export async function removeServer(deps: FlowDeps, name: string): Promise<{ ok: true; message?: string } | FlowFailure> {
  if (deps.bridge) {
    const result = await deps.bridge.remove(name);
    return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message };
  }
  try {
    await deps.api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Edits and adds send typed environment values through the shell when there is
 * one (API-T11: `NAME: true` in the body, the value to saveSecrets). */
export function envForBody(env: Record<string, string | true>, bridge: McpBridge | undefined): { body: Record<string, string | true>; secrets: Record<string, string> } {
  if (!bridge) return { body: env, secrets: {} };
  const body: Record<string, string | true> = {};
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === true) body[name] = true;
    else if (value === "") body[name] = "";
    else { body[name] = true; secrets[name] = value; }
  }
  return { body, secrets };
}

// ── a secret in a command's arguments (review L5) ──────────────────────────
// `--api-key sk-...` is kept in config.json and drawn on the page. The panel
// warns and offers to move the value to an environment value, which the desktop
// shell holds in the secret store.

export interface ArgSecret {
  /** Argument positions to remove: the value, and the flag before it when separate. */
  indexes: number[];
  envName: string;
  value: string;
}

const NOT_A_VALUE = /^(<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|YOUR_[A-Z_]+|\.\.\.|x{3,}|\*{3,})$/i;
const flagEnvName = (flag: string): string => flag.replace(/^-+/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

/** Arguments that carry a credential: the value of a secret-named flag, or any
 * value that reads as a credential. Placeholders and variable references are not. */
export function secretsInArgs(args: readonly string[]): ArgSecret[] {
  const found: ArgSecret[] = [];
  const taken = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    if (taken.has(index)) continue;
    const arg = args[index]!;
    const joined = /^(--?[A-Za-z][\w-]*)=(.+)$/s.exec(arg);
    if (joined) {
      const [, flag, value] = joined;
      if (!NOT_A_VALUE.test(value!) && (isSecretName(flag!) || looksSecretValue(value!))) {
        found.push({ indexes: [index], envName: flagEnvName(flag!) || "SECRET", value: value! });
        taken.add(index);
      }
      continue;
    }
    if (/^--?[A-Za-z][\w-]*$/.test(arg)) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-") && !NOT_A_VALUE.test(next) && (isSecretName(arg) || (arg.startsWith("--") && looksSecretValue(next)))) {
        found.push({ indexes: [index, index + 1], envName: flagEnvName(arg) || "SECRET", value: next });
        taken.add(index + 1);
      }
      continue;
    }
    if (!NOT_A_VALUE.test(arg) && looksSecretValue(arg)) {
      found.push({ indexes: [index], envName: "SECRET", value: arg });
    }
  }
  return found;
}

/** The command as the page shows it, a credential hidden. */
export function displayArgs(args: readonly string[]): string[] {
  const hidden = new Map<number, string>();
  for (const secret of secretsInArgs(args)) {
    const valueIndex = secret.indexes.at(-1)!;
    const arg = args[valueIndex]!;
    const joined = /^(--?[A-Za-z][\w-]*=)/.exec(arg);
    hidden.set(valueIndex, joined ? `${joined[1]}••••` : "••••");
  }
  return args.map((arg, index) => hidden.get(index) ?? arg);
}

/** Move every credential in a stdio draft's arguments to an environment value:
 * the arguments lose it, a secret field takes its place and holds the typed value. */
export function moveArgSecretsToEnv(draft: PasteStdioDraft, typed: Record<string, string>): { draft: PasteStdioDraft; typed: Record<string, string> } {
  const secrets = secretsInArgs(draft.args);
  if (secrets.length === 0) return { draft, typed };
  const remove = new Set(secrets.flatMap((secret) => secret.indexes));
  const fields = [...draft.fields];
  const nextTyped = { ...typed };
  for (const secret of secrets) {
    let envName = secret.envName;
    for (let suffix = 2; fields.some((field) => field.where.type === "env" && field.where.name === envName); suffix += 1) envName = `${secret.envName}_${suffix}`;
    const id = `env:${envName}`;
    fields.push({ id, label: envName, secret: true, placeholder: false, where: { type: "env", name: envName } });
    nextTyped[id] = secret.value;
  }
  return { draft: { ...draft, args: draft.args.filter((_, index) => !remove.has(index)), fields }, typed: nextTyped };
}
