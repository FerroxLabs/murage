// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// House Rules: the owner's own standing rules for every bot, edited in
// Settings. The text lives in DATA_DIR/house-rules.md and the on/off switch
// in DATA_DIR/house-rules.json, both owner-only (0600) and written through
// writeFileAtomic. With no file on disk the shipped default applies, and
// Reset removes the owner's file so the default applies again.
//
// When on, the text rides FIRST in every bot's system prompt, wrapped in a
// <house-rules> block (houseRulesPrompt). Murage's own safety rules
// (approvals, credentials, untrusted data) stay in code and are never part
// of this editable text: an owner can loosen their bots' manners here, not
// the product's guards.
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { DEFAULT_HOUSE_RULES } from "./house-rules/default.ts";

export { DEFAULT_HOUSE_RULES };

export const HOUSE_RULES_MAX_BYTES = 20 * 1024;
const TEXT_FILE = "house-rules.md";
const FLAG_FILE = "house-rules.json";

export interface HouseRulesState {
  text: string;
  enabled: boolean;
  isDefault: boolean;
  defaultText: string;
  words: number;
}

export class HouseRulesTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    const kb = (n: number) => Math.ceil(n / 1024);
    super(`House rules can be up to ${kb(HOUSE_RULES_MAX_BYTES)} KB. Yours are ${kb(bytes)} KB. Shorten them and save again.`);
    this.name = "HouseRulesTooLargeError";
    this.bytes = bytes;
  }
}

const paths = (dir: string) => ({ text: join(dir, TEXT_FILE), flag: join(dir, FLAG_FILE) });

/** mtime+size of a file, or "-" when it is absent: the cache key. */
function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

function readSaved(dir: string): string | null {
  try {
    return readFileSync(paths(dir).text, "utf8");
  } catch {
    return null;
  }
}

function readEnabled(dir: string): boolean {
  try {
    const flag = JSON.parse(readFileSync(paths(dir).flag, "utf8")) as { enabled?: unknown };
    return flag.enabled !== false;
  } catch {
    return true; // on by default, and a damaged flag never silently turns the rules off
  }
}

const countWords = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

export function readHouseRules(dir: string = DATA_DIR): HouseRulesState {
  const saved = readSaved(dir);
  const text = saved ?? DEFAULT_HOUSE_RULES;
  return {
    text,
    enabled: readEnabled(dir),
    isDefault: saved === null || saved === DEFAULT_HOUSE_RULES,
    defaultText: DEFAULT_HOUSE_RULES,
    words: countWords(text),
  };
}

/** Save the text and/or the switch. Throws HouseRulesTooLargeError over 20 KB. */
export function saveHouseRules(update: { text?: string; enabled?: boolean }, dir: string = DATA_DIR): HouseRulesState {
  if (update.text !== undefined) {
    const bytes = Buffer.byteLength(update.text, "utf8");
    if (bytes > HOUSE_RULES_MAX_BYTES) throw new HouseRulesTooLargeError(bytes);
  }
  const p = paths(dir);
  if (update.text !== undefined) writeFileAtomic(p.text, update.text, { mode: 0o600 });
  if (update.enabled !== undefined) writeFileAtomic(p.flag, `${JSON.stringify({ enabled: update.enabled })}\n`, { mode: 0o600 });
  promptCache.delete(dir);
  return readHouseRules(dir);
}

/** Back to the shipped text. The switch is left as the owner set it. */
export function resetHouseRules(dir: string = DATA_DIR): HouseRulesState {
  try {
    unlinkSync(paths(dir).text);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  promptCache.delete(dir);
  return readHouseRules(dir);
}

// Read on every turn, so cached against both files' mtime and size: a turn
// costs two stats, and an edit (from Settings or by hand) shows up on the
// very next turn.
const promptCache = new Map<string, { key: string; prompt: string }>();

/** The block that opens every bot's system prompt, or "" when off or empty. */
export function houseRulesPrompt(dir: string = DATA_DIR): string {
  const p = paths(dir);
  const key = `${stamp(p.text)}|${stamp(p.flag)}`;
  const hit = promptCache.get(dir);
  if (hit && hit.key === key) return hit.prompt;
  const state = readHouseRules(dir);
  const body = state.text.trim();
  const prompt = state.enabled && body ? `<house-rules>\n${body}\n</house-rules>\n\n` : "";
  promptCache.set(dir, { key, prompt });
  return prompt;
}

type ApiAnswer = { status: number; body: unknown };

/** GET/PUT /api/house-rules and POST /api/house-rules/reset. The caller has
 * already refused every surface but the desktop app. */
export async function handleHouseRulesApi(
  request: { method: string; path: string; readBody: () => Promise<unknown> },
  dir: string = DATA_DIR,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  if (path === "/api/house-rules" && method === "GET") return { status: 200, body: readHouseRules(dir) };
  if (path === "/api/house-rules/reset" && method === "POST") return { status: 200, body: resetHouseRules(dir) };
  if (path === "/api/house-rules" && method === "PUT") {
    let body: unknown;
    try {
      body = await request.readBody();
    } catch {
      return { status: 400, body: { error: "The request could not be read. Try saving again." } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Send the house rules as an object with text and/or enabled." } };
    const { text, enabled, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return { status: 400, body: { error: `Unknown field: ${Object.keys(rest)[0]}` } };
    if (text !== undefined && typeof text !== "string") return { status: 400, body: { error: "House rules text must be a string." } };
    if (enabled !== undefined && typeof enabled !== "boolean") return { status: 400, body: { error: "enabled must be true or false." } };
    if (text === undefined && enabled === undefined) return { status: 400, body: { error: "Nothing to save: send text, enabled, or both." } };
    try {
      return { status: 200, body: saveHouseRules({ text, enabled }, dir) };
    } catch (error) {
      if (error instanceof HouseRulesTooLargeError) return { status: 413, body: { error: error.message } };
      throw error;
    }
  }
  if (path === "/api/house-rules" || path === "/api/house-rules/reset") return { status: 405, body: { error: "method not allowed" } };
  return null;
}
