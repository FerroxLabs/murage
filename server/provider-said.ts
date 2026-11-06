// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ERRORS-NAME-THE-SERVICE scope B (1.0.18). Sean's Grok CLI turn failed with xAI's HTTP 402 while his xAI team had $80.56 of
// credit, and the card could not say why: the provider's own sentence was thrown away for every payment kind. This keeps that
// sentence, cleaned, so the card can show it under "What <service> said" and the server line can log it.
import { PROVIDER_SAID_MAX, type ProviderErrorInfo } from "../shared/provider-error.ts";
import { providerErrorFields } from "./drivers/provider-error-body.ts";
import { redactSecretsInText } from "./redact.ts";

/** The provider text is cut to this before any pattern runs, so every rule below is bounded however large the engine frame
 * was. The cut lands far past what is kept, and the partial word it leaves is dropped, so a key split by it never survives. */
const INPUT_MAX = 16_384;
// Bounded quantifiers only: linear on any input.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const URL_TEXT = /\bhttps?:\/\/[^\s"'<>()]{1,2048}/gi;
// Controls, zero-width marks, line/paragraph separators, bidi overrides and the BOM. Built from code points so the source holds
// no invisible character (a raw U+2028 inside a regex literal ends the line and breaks the parse).
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];
const CONTROLS = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");
/** xAI names the team the key belongs to ("Your team <uuid> has either used all available credits ..."). Only that shape. */
const TEAM = /\bteam ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** A URL in provider text keeps only its host: a path or query can carry a key, an account id or a signed token. */
function hostOnly(url: string): string {
  try { const host = new URL(url).hostname; return host ? `${host} link` : "link"; } catch { return "link"; }
}

/** What the provider said, as one clean line of at most PROVIDER_SAID_MAX characters, or undefined when it said nothing
 * useful. Reads the envelope's own sentence when the text is a JSON error body. Secrets, bearer strings, emails and link paths
 * are removed before anything is cut. */
export function providerSaidText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let text = raw.length > INPUT_MAX ? raw.slice(0, INPUT_MAX).replace(/\S*$/, "") : raw;
  const envelope = /^\s*[{[]/.test(text) ? providerErrorFields(text).message : undefined;
  if (envelope) text = envelope;
  else if (/^\s*[{[]/.test(text)) return undefined; // a body that is not an envelope is not a sentence
  // Whole links go first, while each is still one unbroken span: a redaction marker put inside a link first would end the link
  // match early and leave the rest of its query (a signature, a second token) behind.
  text = text.replace(CONTROLS, " ").replace(URL_TEXT, hostOnly).replace(EMAIL, "«email»");
  text = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (text.length <= PROVIDER_SAID_MAX) return text;
  const cut = [...text].slice(0, PROVIDER_SAID_MAX - 1).join("");
  const word = cut.replace(/\s+\S*$/, "");
  return `${word.length >= PROVIDER_SAID_MAX / 2 ? word : cut}…`;
}

/** The team id the provider named, when it named one in the one shape known to carry it. */
export function providerTeam(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return TEAM.exec(raw.slice(0, INPUT_MAX))?.[1]?.toLowerCase();
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
 * or a hostile event, cannot put more than one short cleaned line (and a team id of the known shape) in messages.db. */
export function clampProviderSaid(info: ProviderErrorInfo): ProviderErrorInfo {
  const { providerSaid, providerTeam: team, ...rest } = info;
  const said = typeof providerSaid === "string" ? providerSaidText(providerSaid) : undefined;
  const id = typeof team === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(team) ? team : undefined;
  return { ...rest, ...(said ? { providerSaid: said } : {}), ...(id ? { providerTeam: id } : {}) };
}
