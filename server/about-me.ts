// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// About me: a short profile the owner writes once in Settings (who they are,
// what they do, how they like to work) so every bot knows it without being
// told again. The text lives in DATA_DIR/about-me.md, owner-only (0600),
// written through writeFileAtomic. An empty or missing file adds nothing.
//
// It is the owner's personal material, so it rides ONLY on turns whose
// human audience is the owner: standingContextParts (standing-context.ts)
// hands it out beside the team brief and MEMORY.md under the same
// ownerAudience rule. A Slack, Discord or Telegram conversation with anyone
// else, and a bot's turn done for them, never carries it. (OpenMausBot's
// version, #1680, put it into every prompt, channel people included.)
//
// Ported as an idea from OpenMausBot #1680; Murage's own code.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

/** Short on purpose: every bot reads it on every owner turn. */
export const ABOUT_ME_MAX_CHARS = 4000;
const TEXT_FILE = "about-me.md";

export interface AboutMeState {
  text: string;
  /** false until the owner first saves, even an empty text. */
  saved: boolean;
  chars: number;
  maxChars: number;
}

/** Characters as a person counts them (an emoji is one), not UTF-16 units. */
export const countChars = (text: string): number => [...text].length;

export class AboutMeTooLongError extends Error {
  constructor(chars: number) {
    const n = (value: number) => value.toLocaleString("en-US");
    super(`About me can be up to ${n(ABOUT_ME_MAX_CHARS)} characters. Yours has ${n(chars)}. Shorten it and save again.`);
    this.name = "AboutMeTooLongError";
  }
}

const pathIn = (dir: string) => join(dir, TEXT_FILE);

function readSaved(dir: string): string | null {
  try {
    return readFileSync(pathIn(dir), "utf8");
  } catch {
    return null;
  }
}

export function readAboutMe(dir: string = DATA_DIR): AboutMeState {
  const saved = readSaved(dir);
  const text = saved ?? "";
  return { text, saved: saved !== null, chars: countChars(text), maxChars: ABOUT_ME_MAX_CHARS };
}

/** Save the text. Throws AboutMeTooLongError over the cap. */
export function saveAboutMe(text: string, dir: string = DATA_DIR): AboutMeState {
  const chars = countChars(text);
  if (chars > ABOUT_ME_MAX_CHARS) throw new AboutMeTooLongError(chars);
  // Only blank space reads as cleared: stored empty, so the editor opens empty.
  writeFileAtomic(pathIn(dir), text.trim() ? text : "", { mode: 0o600 });
  promptCache.delete(dir);
  return readAboutMe(dir);
}

/** A first draft made only of what Murage already knows: the name on the
 *  owner's profile and this computer's time zone. Nothing is guessed. */
export function aboutMeSuggestion(known: { name?: string; timeZone?: string }): string {
  const lines: string[] = [];
  const name = known.name?.trim();
  const zone = known.timeZone?.trim();
  if (name) lines.push(`My name is ${name}.`);
  if (zone) lines.push(`My time zone is ${zone}.`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

// Read on every owner turn, so cached against the file's mtime and size.
const promptCache = new Map<string, { key: string; prompt: string }>();

/** The block for the stable prefix of an owner-audience turn, or "". Never
 *  call this for a turn someone else will read: standingContextParts decides. */
export function aboutMePrompt(dir: string = DATA_DIR): string {
  const key = stamp(pathIn(dir));
  const hit = promptCache.get(dir);
  if (hit && hit.key === key) return hit.prompt;
  const body = (readSaved(dir) ?? "").trim();
  const prompt = body
    ? `<about-the-owner>\nThe owner wrote this about themselves for every bot. Use it to fit your work to them. It is private to the owner: don't repeat it to anyone else.\n\n${body}\n</about-the-owner>\n\n`
    : "";
  promptCache.set(dir, { key, prompt });
  return prompt;
}

type ApiAnswer = { status: number; body: unknown };

/** GET/PUT /api/about-me. The caller has already refused every surface but
 *  the desktop app. GET carries a starting text until the first save. */
export async function handleAboutMeApi(
  request: { method: string; path: string; readBody: () => Promise<unknown>; seed: { name?: string; timeZone?: string } },
  dir: string = DATA_DIR,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  if (path !== "/api/about-me") return null;
  if (method === "GET") {
    const state = readAboutMe(dir);
    return { status: 200, body: { ...state, suggestion: state.saved ? "" : aboutMeSuggestion(request.seed) } };
  }
  if (method === "PUT") {
    let body: unknown;
    try {
      body = await request.readBody();
    } catch {
      return { status: 400, body: { error: "The request could not be read. Try saving again." } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Send About me as an object with text." } };
    const { text, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return { status: 400, body: { error: `Unknown field: ${Object.keys(rest)[0]}` } };
    if (typeof text !== "string") return { status: 400, body: { error: "About me text must be a string." } };
    try {
      return { status: 200, body: { ...saveAboutMe(text, dir), suggestion: "" } };
    } catch (error) {
      if (error instanceof AboutMeTooLongError) return { status: 413, body: { error: error.message } };
      throw error;
    }
  }
  return { status: 405, body: { error: "method not allowed" } };
}
