// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan sign-in connections: "Sign in with ChatGPT" and "Sign in with Grok".
//
// Ported from Wayland (Ferrox Labs, same owner): the OAuth paths, endpoints
// and headers are the ones Wayland ships in
// src/process/onboarding/chatgptOAuthCore.ts and xaiOAuthCore.ts. What is
// different here is custody: Murage keeps its own copy of the tokens in the
// OS-encrypted credential document and never reads or writes the Codex CLI's
// ~/.codex/auth.json or Grok Build's ~/.grok/auth.json.
//
// Pure: no filesystem, credential reads or network. Imported by the main
// process, the server and (types only) the renderer.

/** The two plan sign-in presets. They never enter the pasted-key bank. */
export const SIGNIN_PRESETS = Object.freeze({
  chatgpt: Object.freeze({
    label: "ChatGPT plan",
    // Wayland pins the Codex backend: a ChatGPT plan token is refused by
    // api.openai.com, so inference and the model list both live here.
    baseUrl: "https://chatgpt.com/backend-api/codex",
    catalogUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    protocol: "responses",
  }),
  supergrok: Object.freeze({
    label: "Grok plan (unofficial)",
    // Wayland sends the Grok sign-in bearer to the general xAI API.
    baseUrl: "https://api.x.ai/v1",
    catalogUrl: "https://api.x.ai/v1/models",
    protocol: "openai",
  }),
});

/** How Murage identifies itself to ChatGPT, the Hermes way: the Codex CLI's
 * originator plus a Codex-style User-Agent. Cloudflare challenges unknown
 * originators from non-residential IPs, which matters for Murage Cloud on
 * servers. Every chatgpt.com and auth.openai.com call uses these two headers
 * so the identity is the same everywhere. Grok keeps its own identity. */
export const CHATGPT_ORIGINATOR = "codex_cli_rs";
export const CHATGPT_USER_AGENT = "codex_cli_rs/0.0.0 (Murage)";
export const CHATGPT_IDENTITY_HEADERS = Object.freeze({ originator: CHATGPT_ORIGINATOR, "user-agent": CHATGPT_USER_AGENT });

/** One connection per provider; the id is stable across sign-ins. */
export const SIGNIN_CONNECTION_IDS = Object.freeze({ chatgpt: "signin-chatgpt", supergrok: "signin-grok" });

export const SIGNIN_PROVIDERS = Object.freeze(["chatgpt", "supergrok"]);

/** The one switch per provider. Default on. Set the variable to 0, off or
 * false to hide the button, refuse new sign-ins and stop routing turns,
 * without touching the saved tokens. Flip the default here to ship it off. */
export const SIGNIN_FLAG_ENV = Object.freeze({ chatgpt: "MURAGE_SIGNIN_CHATGPT", supergrok: "MURAGE_SIGNIN_GROK" });
const DEFAULT_ON = Object.freeze({ chatgpt: true, supergrok: true });

export function signInProviderEnabled(provider, env = process.env) {
  if (!Object.hasOwn(SIGNIN_FLAG_ENV, provider)) return false;
  const raw = String(env?.[SIGNIN_FLAG_ENV[provider]] ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(raw)) return false;
  if (["1", "on", "true", "yes"].includes(raw)) return true;
  return DEFAULT_ON[provider];
}

export function isSignInPreset(value) {
  return typeof value === "string" && Object.hasOwn(SIGNIN_PRESETS, value);
}

export function signInProviderForConnection(id) {
  return SIGNIN_PROVIDERS.find(provider => SIGNIN_CONNECTION_IDS[provider] === id) ?? null;
}
