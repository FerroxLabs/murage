// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ERRORS-NAME-THE-SERVICE (1.0.18): a provider error card names WHO said it and whose account it is. The server stamps the engine
// that ran the turn (`ProviderErrorInfo.engine`, its driver kind) and, when the turn went through a saved AI service, that
// service's preset and whether it is a plan sign-in (`connection`). This module turns those facts into a name, an account kind
// and, where one is known, the provider's billing page. Every value comes from the fixed tables below: a stored message is data,
// so an unknown engine or preset names nothing and the card keeps its generic copy. Billing pages are plain https pages that carry
// nothing personal (no account id, no key, no query).
import { FLUX_BILLING_PAGE } from "./flux-links.ts";
import type { ProviderErrorInfo } from "./provider-error.ts";
import type { ProviderPreset } from "./provider-connections.ts";

/** Whose account the request ran on: the owner's own sign-in, the owner's own pasted key, or their Flux plan. */
export type ServiceAccount = "own-sign-in" | "own-key" | "flux";
export interface ServiceIdentity {
  /** The service as the owner knows it: "Grok (xAI)", "Claude", "OpenAI". */
  name: string;
  account?: ServiceAccount;
  /** The provider's own billing page, plain https, nothing personal in it. */
  billingUrl?: string;
}

type Entry = { name: string; account?: ServiceAccount; billingUrl?: string };

/** Engines, by driver kind, as the owner picked them. An engine CLI signs in with the owner's own account at its maker. Fuigo
 * names no account here: it runs on Flux or on a key set inside Fuigo, and only the Flux reply itself (`provider`) proves which. */
const ENGINE_SERVICE: Readonly<Record<string, Entry>> = {
  fuigoAgent: { name: "Fuigo" },
  claudeAgent: { name: "Claude", account: "own-sign-in", billingUrl: "https://claude.ai/settings/billing" },
  codex: { name: "Codex", account: "own-sign-in" },
  grokAgent: { name: "Grok (xAI)", account: "own-sign-in", billingUrl: "https://console.x.ai/" },
  grok: { name: "Grok (xAI)", account: "own-key", billingUrl: "https://console.x.ai/" },
  geminiAgent: { name: "Gemini", account: "own-sign-in" },
  antigravityAgent: { name: "Antigravity", account: "own-sign-in" },
  qwenAgent: { name: "Qwen", account: "own-sign-in" },
  kimiAgent: { name: "Kimi", account: "own-sign-in" },
  cursorAgent: { name: "Cursor", account: "own-sign-in", billingUrl: "https://cursor.com/dashboard" },
  droidAgent: { name: "Droid", account: "own-sign-in" },
  copilotAgent: { name: "Copilot", account: "own-sign-in", billingUrl: "https://github.com/settings/copilot" },
  openclawAgent: { name: "OpenClaw" },
  opencodeGo: { name: "OpenCode" },
  hermesAgent: { name: "Hermes" },
  clineAgent: { name: "Cline" },
  piAgent: { name: "pi" },
  minimax: { name: "MiniMax", account: "own-key" },
};

/** Saved AI services, by preset. A key preset is the owner's own key; a plan preset is the owner's own sign-in; Flux is Flux. */
const PRESET_SERVICE: Readonly<Record<ProviderPreset, Entry>> = {
  flux: { name: "Flux Router", account: "flux", billingUrl: FLUX_BILLING_PAGE },
  openai: { name: "OpenAI", account: "own-key", billingUrl: "https://platform.openai.com/settings/organization/billing" },
  anthropic: { name: "Anthropic", account: "own-key", billingUrl: "https://console.anthropic.com/settings/billing" },
  xai: { name: "xAI", account: "own-key", billingUrl: "https://console.x.ai/" },
  openrouter: { name: "OpenRouter", account: "own-key", billingUrl: "https://openrouter.ai/settings/credits" },
  deepseek: { name: "DeepSeek", account: "own-key", billingUrl: "https://platform.deepseek.com/top_up" },
  mistral: { name: "Mistral", account: "own-key", billingUrl: "https://console.mistral.ai/billing" },
  groq: { name: "Groq", account: "own-key", billingUrl: "https://console.groq.com/settings/billing" },
  requesty: { name: "Requesty", account: "own-key" },
  google: { name: "Google AI", account: "own-key" },
  chatgpt: { name: "ChatGPT", account: "own-sign-in" },
  supergrok: { name: "SuperGrok", account: "own-sign-in" },
};

const own = <T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** Who said this error and whose account it is, or undefined when nothing stamped on it names a service (a message saved by an
 * earlier build, or an engine Murage has no name for). Flux's own reply wins over the engine: Fuigo on Flux is the Flux plan. */
export function serviceIdentity(info: Pick<ProviderErrorInfo, "provider" | "engine" | "connection"> | undefined): ServiceIdentity | undefined {
  if (!info) return undefined;
  const preset = own(PRESET_SERVICE, info.connection?.preset);
  if (info.provider === "flux-router" || preset?.account === "flux") return { ...PRESET_SERVICE.flux };
  if (preset) return { ...preset, ...(info.connection?.signIn === true ? { account: "own-sign-in" as const } : {}) };
  const engine = own(ENGINE_SERVICE, info.engine);
  return engine ? { ...engine } : undefined;
}

/** Driver kinds and presets are short identifiers; anything else is not stamped. */
const SERVICE_ID = /^[A-Za-z][\w-]{0,39}$/;

/** The server's stamp: the engine that ran the turn and the saved AI service it went through. Only short identifiers are kept,
 * never a key, URL or label. */
export function stampService(info: ProviderErrorInfo, turn: { engine?: unknown; preset?: unknown; signIn?: unknown }): ProviderErrorInfo {
  const engine = typeof turn.engine === "string" && SERVICE_ID.test(turn.engine) ? turn.engine : undefined;
  const preset = typeof turn.preset === "string" && SERVICE_ID.test(turn.preset) ? turn.preset : undefined;
  return {
    ...info,
    ...(engine ? { engine } : {}),
    ...(preset ? { connection: { preset, ...(turn.signIn === true ? { signIn: true } : {}) } } : {}),
  };
}
