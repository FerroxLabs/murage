// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Package export scrub (BOT-EMAIL-MURAGE-109 section 7, Astra 15): a package never carries a bot's own bound address. Descriptions, routine
// prompts and skill bytes have it replaced with "[bot email address]", and the agent carries only `emailIntent: "was-on"`. No Murage
// imports: the export modules read the bound address through the lookup index.ts registers (null while email is off or unbound).
export const BOT_EMAIL_PLACEHOLDER = "[bot email address]";

let lookup: (botId: string) => string | null = () => null;
/** index.ts: the bot's bound address from the email bindings (never creates a table). */
export function registerBotEmailAddressLookup(fn: (botId: string) => string | null): void { lookup = fn; }
export function boundEmailAddress(botId: string): string | null { try { const address = lookup(botId); return address && address.includes("@") ? address : null; } catch { return null; } }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every case-insensitive occurrence of the address, replaced. */
export function scrubEmailAddress(text: string, address: string | null): string {
  if (!address || !text) return text;
  return text.replace(new RegExp(escape(address), "gi"), BOT_EMAIL_PLACEHOLDER);
}
export function scrubOptional(text: string | undefined, address: string | null): string | undefined { return text === undefined ? text : scrubEmailAddress(text, address); }
/** Skill bytes: a UTF-8 file that names the address is rewritten; any other file is left byte for byte. */
export function scrubEmailBytes(bytes: Buffer, address: string | null): Buffer {
  if (!address) return bytes;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return bytes; }
  const next = scrubEmailAddress(text, address);
  return next === text ? bytes : Buffer.from(next, "utf8");
}
