// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23): the plain-name tool rows the harness relay adds to a connected-apps tools/list answer, per request,
// for a bridge that asked for them (header x-murage-connector-aliases). Never stored in the per-owner remembered list and
// never part of `initialTools`. The enum is a convenience: the relay still checks every call against the bot's grants.
// OWNER: the 1.0.23 F11-V3 builder lane (dispatch side).

import { botAccessPolicy } from "./bot-access-role.ts";
import type { BotRecord } from "./store.ts";
import { CONNECTED_APP_ALIASES, isAliasName } from "../shared/connected-app-aliases.ts";

interface AliasTool { name: string; description: string; inputSchema: Record<string, unknown> }

function aliasTool(alias: string, label: string, accounts: readonly string[]): AliasTool {
  return {
    name: alias,
    description: label,
    inputSchema: {
      type: "object",
      properties: { account: { type: "string", enum: [...accounts] }, arguments: { type: "object" } },
      required: ["account", "arguments"],
      additionalProperties: false,
    },
  };
}

const unique = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** Restricted bot: one row per alias, its enum the accounts granted THAT slug; a writes slug only with `allowWrites`
 * and never for a draft-only bot. */
export function restrictedAliasTools(bot: BotRecord): AliasTool[] {
  const policy = botAccessPolicy(bot);
  if (policy.mode !== "restricted") return [];
  const out: AliasTool[] = [];
  for (const [alias, row] of CONNECTED_APP_ALIASES) {
    if (row.writes && (!policy.allowWrites || bot.draftOnly)) continue;
    const accounts = unique(policy.grants.filter((grant) => grant.toolkit === row.toolkit && grant.tools.includes(row.slug)).map((grant) => grant.accountId));
    if (accounts.length) out.push(aliasTool(alias, row.label, accounts));
  }
  return out;
}

/** Unrestricted / No limits bot: the bot's connected accounts per toolkit, from the remembered inventory.
 * `null` inventory (unknown) lists nothing. */
export function unrestrictedAliasTools(bot: BotRecord, accountsByToolkit: Readonly<Record<string, readonly string[]>> | null, noLimits: boolean): AliasTool[] {
  if (!accountsByToolkit) return [];
  const out: AliasTool[] = [];
  for (const [alias, row] of CONNECTED_APP_ALIASES) {
    if (row.writes && bot.draftOnly && !noLimits) continue;
    const accounts = unique(accountsByToolkit[row.toolkit] ?? []);
    if (accounts.length) out.push(aliasTool(alias, row.label, accounts));
  }
  return out;
}

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function withRows(message: unknown, rows: readonly AliasTool[]): unknown {
  if (!object(message) || !object(message.result) || !Array.isArray(message.result.tools)) return message;
  // a row of the same name the upstream already lists is never doubled
  const have = new Set(message.result.tools.map((tool) => (object(tool) ? tool.name : undefined)));
  return { ...message, result: { ...message.result, tools: [...message.result.tools, ...rows.filter((row) => !have.has(row.name))] } };
}

/** The upstream tools/list answer with the alias rows appended, in the answer's own framing (JSON or event stream).
 * Bytes this cannot read are returned untouched. */
export function withAliasRows(contentType: string, bytes: Uint8Array, rows: readonly AliasTool[]): Uint8Array {
  if (!rows.length) return bytes;
  const text = new TextDecoder().decode(bytes);
  const encode = (value: string) => new TextEncoder().encode(value);
  try {
    if (/^application\/json\b/iu.test(contentType)) return encode(JSON.stringify(withRows(JSON.parse(text), rows)));
    if (/^text\/event-stream\b/iu.test(contentType)) {
      return encode(text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        try { return `data: ${JSON.stringify(withRows(JSON.parse(line.slice(5)), rows))}`; } catch { return line; }
      }).join("\n"));
    }
  } catch { /* not a readable answer */ }
  return bytes;
}

/** A tools/call, or any message of a batch, naming a bare alias: the relay never forwards one upstream (an unflagged
 * bridge, or an ACP agent, would otherwise run a name only the flagged bridge rewrites). */
export function namesBareAlias(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some((message) => object(message) && message.method === "tools/call" && object(message.params) && isAliasName(message.params.name));
}
