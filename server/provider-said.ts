// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ERRORS-NAME-THE-SERVICE scope B (1.0.18). Sean's Grok CLI turn failed with xAI's HTTP 402 while his xAI team had $80.56 of
// credit, and the card could not say why: the provider's own sentence was thrown away for every payment kind. This names what
// the provider said so the card can show it under "What <service> said" and the server line can log it.
//
// Relay 7 (Astra r7): no provider text is ever copied. The provider text is only READ, against a short list of recognised
// account sentences, and what is kept is that entry's own reviewed wording (plus, for xAI's spend-limit line, the team id in
// its one validated shape). Unrecognised text, links, hosts, tokens and any other provider data are never carried, so no event,
// messages.db row or server log line can hold them.
import { PROVIDER_SAID_MAX, type ProviderErrorInfo } from "../shared/provider-error.ts";
import { providerErrorFields } from "./drivers/provider-error-body.ts";

/** The provider text is cut to this before any pattern runs, so every rule below is bounded however large the engine frame was. */
const INPUT_MAX = 16_384;
// Controls, zero-width marks, line/paragraph separators, bidi overrides and the BOM. Built from code points so the source holds
// no invisible character (a raw U+2028 inside a regex literal ends the line and breaks the parse).
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];
const CONTROLS = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** xAI's spend-limit line, the one shape known to name the team the key belongs to. */
const XAI_SPEND = new RegExp(`\\bteam (${UUID}) has either used all available credits or reached its monthly spending limit\\b`, "i");

/** Recognised account sentences. Each pattern is fixed words with bounded gaps (linear on any input); `said` is the reviewed
 * wording that is kept. Order matters: the first match wins. */
const KNOWN: ReadonlyArray<{ re: RegExp; said: (m: RegExpExecArray) => string }> = [
  { re: XAI_SPEND, said: (m) => `Your team ${m[1]!.toLowerCase()} has either used all available credits or reached its monthly spending limit.` },
  { re: /\b(?:monthly )?spending limit (?:has been |was )?(?:reached|exceeded)\b/i, said: () => "The spending limit was reached." },
  { re: /\bcredit balance is (?:too low|exhausted|empty)\b/i, said: () => "Your credit balance is exhausted." },
  { re: /\b(?:insufficient|not enough|no remaining|out of) (?:credits?|balance|funds)\b/i, said: () => "Insufficient credit." },
  { re: /\b(?:quota|usage limit) (?:has been |was )?(?:exceeded|reached|exhausted)\b|\bexceeded (?:your|the) (?:current )?quota\b/i, said: () => "The usage quota was reached." },
  { re: /\bpayment (?:is )?required\b/i, said: () => "Payment is required." },
];

function readable(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let text = raw.length > INPUT_MAX ? raw.slice(0, INPUT_MAX) : raw;
  if (/^\s*[{[]/.test(text)) {
    const envelope = providerErrorFields(text).message;
    if (!envelope) return undefined; // a body that is not an envelope is not a sentence
    text = envelope.slice(0, INPUT_MAX);
  }
  return text.replace(CONTROLS, " ").replace(/\s+/g, " ");
}

/** What the provider said, as the reviewed wording of the first recognised account sentence (at most PROVIDER_SAID_MAX
 * characters), or undefined when the text holds none. Never a copy of provider text. */
export function providerSaidText(raw: unknown): string | undefined {
  const text = readable(raw);
  if (!text) return undefined;
  for (const { re, said } of KNOWN) {
    const m = re.exec(text);
    if (m) return said(m).slice(0, PROVIDER_SAID_MAX);
  }
  return undefined;
}

/** The team id the provider named, only from xAI's spend-limit line. */
export function providerTeam(raw: unknown): string | undefined {
  const text = readable(raw);
  return text ? XAI_SPEND.exec(text)?.[1]?.toLowerCase() : undefined;
}

/** The structured facts plus what the provider said, read from `error.data.message` (the field `classifyProviderError` read
 * the status beside). The ACP route carries the engine's relay of the provider sentence there; the OpenAI-compatible route
 * carries the whole response body, whose envelope sentence is taken. */
export function withProviderSaid(info: ProviderErrorInfo, error: unknown): ProviderErrorInfo {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : undefined;
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as { message?: unknown }).message : undefined;
  const said = providerSaidText(raw);
  const team = providerTeam(raw);
  return { ...info, ...(said ? { providerSaid: said } : {}), ...(team ? { providerTeam: team } : {}) };
}

/** The stored copy, checked again at the one place a runtime error is written: a driver that never called the reader above,
 * or a hostile event, cannot put anything but a reviewed wording (and a team id read from xAI's line) in messages.db. */
export function clampProviderSaid(info: ProviderErrorInfo): ProviderErrorInfo {
  const { providerSaid, providerTeam: team, ...rest } = info;
  const said = typeof providerSaid === "string" ? providerSaidText(providerSaid) : undefined;
  const id = said && typeof team === "string" && new RegExp(`^${UUID}$`).test(team) && said.includes(team) ? team : undefined;
  return { ...rest, ...(said ? { providerSaid: said } : {}), ...(id ? { providerTeam: id } : {}) };
}
