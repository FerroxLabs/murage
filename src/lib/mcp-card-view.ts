// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Which card the MCP servers panel shows for a pasted server, and the plain
// sentence for each reason a test can fail. Pure, so every state can be drawn
// and checked without the network.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { secretsInArgs, type HeaderChoice, type MergedDraft, type ProbeView } from "@/lib/mcp-add-flow";

export type DraftView =
  | "saving" | "signing" | "testing" | "installing"
  | "sign-in" | "key" | "ready" | "local-confirm" | "moved" | "error" | "still-installing"
  | "connected" | "added";

export interface DraftCardState {
  draft: MergedDraft;
  name: string;
  busy: null | "saving" | "signing" | "testing" | "installing";
  /** The latest probe: the unauthenticated one from inspect, then each Test. */
  probe?: ProbeView;
  /** The probe above came from a Test of the saved entry. */
  tested: boolean;
  /** The owner chose an API key over sign-in. */
  useKey: boolean;
  header: HeaderChoice;
  customHeader: string;
  keyValue: string;
  /** Typed values by field id. Held here and nowhere else. */
  typed: Record<string, string>;
  /** The entry exists (an earlier step saved it), under this name. */
  savedName?: string;
  enabled: boolean;
  /** A local confirmation the owner gave. */
  confirmed?: "this-computer" | "local-network";
  /** A failure from saving or signing in, in a plain sentence. */
  message?: string;
  elapsed: number;
}

/** The header a key is most likely sent in, from what a probe learned. */
export function headerFromProbe(probe: ProbeView | undefined): HeaderChoice {
  return probe && !probe.ok && probe.apiKey?.headerHint === "x-api-key" ? "x-api-key" : "authorization";
}

/** A fresh probe for a card: the probe itself, and the header it suggests. One
 * place, so a probe that arrives later (after a local confirmation) picks the
 * header the same way the first one does. */
export function withProbe(probe: ProbeView | undefined): Pick<DraftCardState, "probe" | "header"> {
  return { probe, header: headerFromProbe(probe) };
}

/** The card for a freshly parsed draft. A secret value the owner pasted moves
 * from the draft into the typed values, where its password field shows it, so
 * they do not paste it twice and no other part of the state holds it. */
export function newCardState(draft: MergedDraft): DraftCardState {
  const typed: Record<string, string> = {};
  const fields = draft.fields.map((field) => {
    if (!field.secret || field.placeholder || field.value === undefined) return field;
    typed[field.id] = field.value;
    const { value: _moved, ...rest } = field;
    return rest;
  });
  return {
    draft: { ...draft, fields } as MergedDraft, name: draft.name, busy: null, tested: false, useKey: false,
    ...withProbe(draft.probe),
    customHeader: "", keyValue: "", typed, enabled: false, elapsed: 0,
  };
}

/** True when what was pasted held a secret the page should stop showing. */
export function pasteHoldsSecret(drafts: readonly MergedDraft[]): boolean {
  return drafts.some((draft) => (draft.kind === "remote" && draft.urlHasSecret)
    || (draft.kind === "stdio" && secretsInArgs(draft.args).length > 0)
    || draft.fields.some((field) => field.secret && !field.placeholder && field.value !== undefined));
}

const SIGN_IN_REASONS = new Set(["needs-sign-in", "sign-in-ended", "needs-more-access"]);
const KEY_REASONS = new Set(["needs-key", "key-rejected"]);

export function draftView(state: DraftCardState): DraftView {
  if (state.enabled) return "added";
  if (state.busy === "installing") return "installing";
  if (state.busy) return state.busy;
  const { draft, probe } = state;
  if (draft.kind === "stdio") {
    if (probe && probe.ok && state.tested) return "connected";
    if (probe && !probe.ok && state.tested) return probe.reason === "still-installing" ? "still-installing" : "error";
    return "ready";
  }
  if (!probe) return "ready";
  if (probe.ok) return state.tested ? "connected" : "ready";
  const reason = probe.reason;
  if (reason === "local-confirm") return "local-confirm";
  if (reason === "moved") return "moved";
  if (reason && SIGN_IN_REASONS.has(reason)) {
    if (state.useKey) return "key";
    return draft.fields.length > 0 && !state.tested ? "ready" : "sign-in";
  }
  if (reason && KEY_REASONS.has(reason)) return draft.fields.length > 0 && !state.tested ? "ready" : "key";
  // a snippet that carries its own header fields is filled in and tested, whatever the bare probe said
  if (draft.fields.length > 0 && !state.tested) return "ready";
  return "error";
}

const REASON_KEYS: Partial<Record<string, LocaleKey>> = {
  "needs-sign-in": "mcp.reason.needsSignIn",
  "needs-key": "mcp.reason.needsKey",
  "key-rejected": "mcp.reason.keyRejected",
  "sign-in-ended": "mcp.reason.signInEnded",
  "needs-more-access": "mcp.reason.needsMoreAccess",
  "not-found": "mcp.reason.notFound",
  "unreachable": "mcp.reason.unreachable",
  "wrong-address": "mcp.reason.wrongAddress",
  "https-required": "mcp.reason.httpsRequired",
  "address-changed": "mcp.reason.addressChanged",
  "blocked-address": "mcp.reason.blockedAddress",
  "server-error": "mcp.reason.serverError",
  "no-answer": "mcp.reason.noAnswer",
};

/** The sentence for a failed probe: the catalogue's wording for a link reason,
 * the harness's own fixed sentence for anything else (a command's reasons). */
export function probeSentence(probe: Extract<ProbeView, { ok: false }>, host: string): string {
  const key = probe.reason ? REASON_KEYS[probe.reason] : undefined;
  return key ? t(key, { host }) : probe.error;
}

export function connectedSentence(count: number): string {
  return count === 0 ? t("mcp.card.connected.none") : count === 1 ? t("mcp.card.connected.one") : t("mcp.card.connected.other", { count });
}
