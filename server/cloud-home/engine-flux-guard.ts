// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: on a Cloud home the Claude Code and Codex engines run ONLY on the customer's
// own Claude / ChatGPT sign-in. No Flux key (home sub-key or any other) and no Flux
// address may ever reach them, under any variable name or config argument. Flux
// credits power Murage's own Flux engine and routes only.
import { cloudHomeCopy } from "./copy.ts";

export const SIGN_IN_ONLY_ENGINES: readonly string[] = ["claudeAgent", "codex"];

const isHome = (): boolean => process.env.MURAGE_CLOUD_ROLE === "home";

export function isSignInOnlyEngine(engine: string): boolean { return SIGN_IN_ONLY_ENGINES.includes(engine); }

/** Anything that is a Flux key, or points at a Flux address, in any spelling. */
export function looksLikeFlux(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let text = value;
  try { text = decodeURIComponent(value); } catch { /* use raw text */ }
  return /sk-flux-/i.test(text) || /fluxrouter/i.test(text);
}

/** Variables that exist only to carry a Flux key to a CLI. */
const FLUX_VARIABLE = /^FLUX_|_FLUX_|^FUIGO_/i;

/** Refuse (plain words) a Flux route for Claude Code or Codex on a home. No-op elsewhere. */
export function assertNoFluxForSignInEngine(engine: string): void {
  if (isHome() && isSignInOnlyEngine(engine)) throw new Error(cloudHomeCopy.signInEnginesNoFlux);
}

/** Strip every Flux-bearing variable, whatever it is called, from a sign-in engine's env. Returns the names removed. */
export function scrubFluxFromSignInEnv(engine: string, env: NodeJS.ProcessEnv): string[] {
  if (!isHome() || !isSignInOnlyEngine(engine)) return [];
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (FLUX_VARIABLE.test(name) || looksLikeFlux(value)) { delete env[name]; removed.push(name); }
  }
  return removed;
}

/** Launch arguments or config text for a sign-in engine must not name Flux. */
export function assertNoFluxInSignInArgs(engine: string, args: readonly string[]): void {
  if (isHome() && isSignInOnlyEngine(engine) && args.some(looksLikeFlux)) throw new Error(cloudHomeCopy.signInEnginesNoFlux);
}

/** Credential names that feed those engines. A Flux-looking value in one is dropped / refused. */
export function isSignInEngineCredentialName(name: string): boolean {
  return /anthropic|claude|codex|chatgpt/i.test(name) || name === "openaiApiKey";
}

/**
 * TOML basic-string escapes undone globally: \uXXXX, \UXXXXXXXX, \xHH, \e, the single-character escapes, and a
 * line-ending backslash with the whitespace after it. The repo carries no TOML parser, so this over-decodes (it also
 * treats literal 'strings' as escaped): that can only cause a refusal, never a miss. The Python launcher parses the TOML for real.
 */
export function decodeTomlEscapes(text: string): string {
  const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
  return text.replace(/\\(?:U([0-9a-fA-F]{8})|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([btnfre"\\])|[ \t]*\r?\n[ \t\r\n]*)/g, (match, long, short, hex, one) => {
    const code = long ?? short ?? hex;
    if (code !== undefined) { const point = parseInt(code, 16); return point <= 0x10ffff ? String.fromCodePoint(point) : match; }
    return one !== undefined ? simple[one] : "";
  });
}

/** Text that names Flux once URL-encoding, TOML escapes and JSON string escapes are undone (a quoted `\u0073k-flux-` is still a key). */
export function textNamesFlux(text: string, depth = 0): boolean {
  if (looksLikeFlux(text)) return true;
  const decoded = decodeTomlEscapes(text);
  if (decoded !== text && looksLikeFlux(decoded)) return true;
  if (depth > 4) return false;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) return false;
  try { return jsonNamesFlux(JSON.parse(trimmed), depth + 1); } catch { return false; }
}

function jsonNamesFlux(value: unknown, depth: number): boolean {
  if (typeof value === "string") return textNamesFlux(value, depth);
  if (Array.isArray(value)) return value.some(item => jsonNamesFlux(item, depth));
  if (value && typeof value === "object") return Object.entries(value).some(([name, item]) => textNamesFlux(name, depth) || jsonNamesFlux(item, depth));
  return false;
}

/** The turn's own prompt text is user content, not configuration: it may mention Flux by name. */
const PROMPT_FILE = /\/prompt\.txt$/;

export interface FinalEngineLaunch { env?: Record<string, string | undefined>; args?: readonly string[]; files?: Record<string, string> }

/**
 * THE guard (hole 6): run at the last point before a sign-in engine starts, after every
 * MCP server and integration has been added. Looks at the environment, the arguments and
 * every staged file (Claude's MCP config, Codex project config/auth), and REFUSES in plain
 * words; it never repairs. Egress limits are not proof, so the key must never arrive.
 */
export function assertFinalLaunchFluxFree(engine: string, launch: FinalEngineLaunch): void {
  if (!isHome() || !isSignInOnlyEngine(engine)) return;
  const refuse = (): never => { throw new Error(cloudHomeCopy.signInEnginesNoFlux); };
  for (const [name, value] of Object.entries(launch.env ?? {})) {
    if (value === undefined) continue;
    if (FLUX_VARIABLE.test(name) || textNamesFlux(name) || textNamesFlux(value)) refuse();
  }
  if ((launch.args ?? []).some(arg => textNamesFlux(arg))) refuse();
  for (const [path, contents] of Object.entries(launch.files ?? {})) {
    if (textNamesFlux(path)) refuse();
    if (PROMPT_FILE.test(path)) { if (/sk-flux-/i.test(contents)) refuse(); continue; }
    if (textNamesFlux(contents)) refuse();
  }
}

/** The typed render (what the launcher turns into config files) as the staged files the scan reads: the system prompt is the bot's
 *  own text, so like a prompt file it may mention Flux by name and is refused only for an actual key. */
export function renderAsFiles(render: unknown): Record<string, string> {
  if (!render || typeof render !== "object" || Array.isArray(render)) return {};
  const { systemPrompt, ...rest } = render as Record<string, unknown>;
  return { "/render/render.json": JSON.stringify(rest), ...(typeof systemPrompt === "string" ? { "/render/prompt.txt": systemPrompt } : {}) };
}

/** Driver-side entry: the same final check on a driver's own env. The typed render (MURAGE_CLOUD_TURN_RENDER) is what the
 *  launcher renders every config file from, so it is checked as the staged contents. */
export function assertFinalEngineEnv(engine: string, env: NodeJS.ProcessEnv, args: readonly string[]): void {
  if (!isHome() || !isSignInOnlyEngine(engine)) return;
  const { MURAGE_CLOUD_TURN_RENDER: render, ...rest } = env;
  let parsed: unknown = {};
  try { parsed = JSON.parse(render ?? "{}"); } catch { throw new Error(cloudHomeCopy.signInEnginesNoFlux); }
  assertFinalLaunchFluxFree(engine, { env: rest, args, files: renderAsFiles(parsed) });
}
