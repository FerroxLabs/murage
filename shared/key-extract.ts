// Pull API keys out of a pasted blob — a .env, a password-manager note, a
// chat message — and say which Murage credential each one COULD be. Pure and
// dependency-free so the renderer and the harness can both read it, the same
// way shared/intake-turn.ts is reached from both sides.
//
// THREE RULES, and every branch below is one of them.
//
// 1. A candidate is a SUGGESTION, never a decision. `providers` is a *set* of
//    destinations, not a winner. One entry means the evidence is unambiguous.
//    More than one means the caller must make the user choose; nothing here
//    picks for them. Zero means the thing is recognisable but Murage has
//    nowhere to put it (see UNSUPPORTED below), so the only offer is "ignore".
//
// 2. Prefer a miss over a wrong write. A key filed under the wrong provider
//    401s on the first request and looks like Murage's fault, so anything that
//    is not positively recognised — by its variable NAME or by its VALUE shape
//    — is dropped on the floor rather than guessed at.
//
// 3. The value is the secret; the name is not. `name` and `hint` are safe to
//    render. `value` is not, ever. Use `maskKey`.
//
// Model keys are saved as named, endpoint-bound provider connections. Other
// tool credentials retain their existing custody path. Detection is local only.
import type { ProviderPreset } from "./provider-connections";

/** A Murage config section that holds a secret a renderer may write. */
export type ProviderId =
  | "xai"
  | "flux"
  | "composio"
  | "box"
  | "opencodeGo"
  | "tts"
  | "imageGen"
  | "openaiCompat"
  | "anthropic" | "openai" | "openrouter" | "deepseek" | "mistral" | "groq";

/** Something we can name but cannot store. Row explains, offers no save. */
export type UnsupportedId = "google" | "stripe" | "openai-admin";

/** Names accepted by `window.muragebox.setCredential` (src/types/muragebox.d.ts),
 * which is the packaged app's door into the OS-encrypted store. `null` means
 * the shell has no row for this secret yet and PUT /api/config is the only
 * door — the situation FluxKeyCard.tsx documents for the Flux key. */
export type ElectronCredential =
  | "composioApiKey"
  | "xaiApiKey"
  | "boxToken"
  | "opencodeGoApiKey"
  | "ttsKey"
  | "openaiImageApiKey";

export interface ProviderRow {
  readonly id: ProviderId;
  /** Shown on the row. */
  readonly label: string;
  /** One line of what a saved key does here. */
  readonly blurb: string;
  /** OS-store name, or null when only the config route works. */
  readonly credential: ElectronCredential | null;
  readonly modelPreset?: ProviderPreset;
  /** The `PUT /api/config` body that saves it. Mirrors AppConfig exactly. */
  readonly body: (value: string) => unknown;
}

/** Every destination, in the order a chooser should offer them. */
export const PROVIDER_ORDER: readonly ProviderId[] = [
  "flux",
  "xai",
  "anthropic", "openai", "openrouter", "deepseek", "mistral", "groq",
  "openaiCompat",
  "imageGen",
  "tts",
  "composio",
  "box",
  "opencodeGo",
];

/** The save table. `body` shapes are taken from `appConfigSchema`
 * (server/config.ts) and `credential` names from CREDENTIAL_PATCH
 * (electron/main.mjs); key-extract.test.ts asserts the three sections
 * ApiKeys.tsx also knows about still agree with it. */
const modelRow = (id: ProviderPreset, label: string): ProviderRow => ({ id, label, blurb: `Save a named ${label} connection for compatible models.`, credential: null, modelPreset: id, body: () => { throw new Error("Model keys must be saved with their selected provider connection."); } });
export const PROVIDERS: Readonly<Record<ProviderId, ProviderRow>> = {
  anthropic: modelRow("anthropic", "Anthropic key"),
  openai: modelRow("openai", "OpenAI key"),
  openrouter: modelRow("openrouter", "OpenRouter key"),
  deepseek: modelRow("deepseek", "DeepSeek key"),
  mistral: modelRow("mistral", "Mistral key"),
  groq: modelRow("groq", "Groq key"),
  xai: {
    id: "xai",
    modelPreset: "xai",
    label: "xAI (Grok) key",
    blurb: "Runs Grok bots on your own xAI account.",
    credential: "xaiApiKey",
    body: (v) => ({ xai: { key: v } }),
  },
  flux: {
    id: "flux",
    modelPreset: "flux",
    label: "Flux Router key",
    blurb: "Adds the Flux model rows to the picker for Claude, Codex and Qwen bots.",
    credential: null,
    body: (v) => ({ flux: { apiKey: v } }),
  },
  composio: {
    id: "composio",
    label: "Composio project key",
    blurb: "Connects Gmail, GitHub, Slack and Notion through your own Composio project.",
    credential: "composioApiKey",
    body: (v) => ({ composio: { apiKey: v } }),
  },
  box: {
    id: "box",
    label: "Box API key",
    blurb: "Gives bots a remote Linux computer with a desktop and terminal.",
    credential: "boxToken",
    body: (v) => ({ box: { token: v } }),
  },
  opencodeGo: {
    id: "opencodeGo",
    label: "OpenCode API key",
    blurb: "Optional key for the OpenCode engine.",
    credential: "opencodeGoApiKey",
    body: (v) => ({ opencodeGo: { apiKey: v } }),
  },
  tts: {
    id: "tts",
    label: "ElevenLabs voice key",
    blurb: "Lets bots speak. Pick a voice in Settings after saving.",
    credential: "ttsKey",
    body: (v) => ({ tts: { key: v } }),
  },
  imageGen: {
    id: "imageGen",
    label: "OpenAI key for avatars",
    blurb: "Draws generated bot avatars. Used only by the avatar generator.",
    credential: "openaiImageApiKey",
    body: (v) => ({ imageGen: { key: v } }),
  },
  openaiCompat: {
    id: "openaiCompat",
    label: "OpenAI-compatible engine key",
    blurb: "Runs the OpenAI-compatible engine (OpenAI, OpenRouter, and friends).",
    credential: null,
    body: (v) => {
      const url = /^sk-or-/.test(v) ? "https://openrouter.ai/api/v1"
        : /^sk-(?:proj|svcacct)-/.test(v) ? "https://api.openai.com/v1" : null;
      if (!url) throw new Error("Choose the exact model provider before saving this key.");
      return { openaiCompat: { key: v, url } };
    },
  },
};

export interface UnsupportedRow {
  readonly id: UnsupportedId;
  readonly label: string;
  /** Why Murage will not take it. Shown instead of a save button. */
  readonly reason: string;
}

export const UNSUPPORTED: Readonly<Record<UnsupportedId, UnsupportedRow>> = {
  "openai-admin": { id: "openai-admin", label: "OpenAI admin key", reason: "Use an inference API key for models; organization admin keys are not supported here." },
  google: {
    id: "google",
    label: "Google AI key",
    reason:
      "Murage has nowhere to keep this. Gemini bots run on the Google CLI's own login, and the harness deletes GEMINI_API_KEY and GOOGLE_API_KEY from every engine it starts.",
  },
  stripe: {
    id: "stripe",
    label: "Stripe secret key",
    reason: "Murage never asks for a payment key and has nowhere to keep one.",
  },
};

/** How a candidate was recognised. Shown as a subtitle, never as the value. */
export type Evidence = "name" | "shape" | "name+shape";

export interface KeyCandidate {
  /** THE SECRET. Never render this. Pass it to a save, and nowhere else. */
  readonly value: string;
  /** Last four characters, or "" when the key is too short to hint safely. */
  readonly hint: string;
  /** Where this could go. 1 = certain. >1 = the user must choose.
   *  0 = recognised but unstorable; see `unsupported`. */
  readonly providers: readonly ProviderId[];
  /** Set when `providers` is empty and we know what the thing is. */
  readonly unsupported?: UnsupportedRow;
  /** The left-hand side it was found under, if any. Names are not secret. */
  readonly name?: string;
  readonly evidence: Evidence;
}

/** What the UI shows in place of a key. Last four only, and not even that
 * for a short one — four of six characters is most of a secret. */
export function maskKey(value: string): string {
  const hint = keyHint(value);
  return hint ? `••••${hint}` : "••••";
}

/** The four characters `maskKey` is allowed to show, or "". */
export function keyHint(value: string): string {
  const v = value.trim();
  return v.length >= 12 ? v.slice(-4) : "";
}

// ---------------------------------------------------------------------------
// The name channel: the left-hand side of `NAME=value`, `name: value`, or a
// JSON path. Every Murage name below has a reader in server/config.ts
// loadConfig(); the third-party spellings are the ones people actually have in
// a .env next to them.
// ---------------------------------------------------------------------------

type Target = readonly ProviderId[] | UnsupportedId;

const NAMES: Readonly<Record<string, Target>> = {
  // xai — env XAI_API_KEY, config xai.key
  XAI_API_KEY: ["xai"],
  XAI_KEY: ["xai"],
  GROK_API_KEY: ["xai"],
  // flux — env FLUX_API_KEY, config flux.apiKey
  FLUX_API_KEY: ["flux"],
  FLUX_APIKEY: ["flux"],
  FLUXROUTER_API_KEY: ["flux"],
  FLUX_ROUTER_API_KEY: ["flux"],
  // composio — env COMPOSIO_API_KEY, config composio.apiKey
  COMPOSIO_API_KEY: ["composio"],
  COMPOSIO_APIKEY: ["composio"],
  // box — env BOX_TOKEN, config box.token
  BOX_TOKEN: ["box"],
  BOX_API_KEY: ["box"],
  // opencode — env OPENCODE_API_KEY, config opencodeGo.apiKey
  OPENCODE_API_KEY: ["opencodeGo"],
  OPENCODEGO_APIKEY: ["opencodeGo"],
  // voice — env MURAGE_TTS_KEY, config tts.key
  MURAGE_TTS_KEY: ["tts"],
  TTS_KEY: ["tts"],
  ELEVENLABS_API_KEY: ["tts"],
  ELEVEN_API_KEY: ["tts"],
  // avatars — env MURAGE_OPENAI_IMAGE_KEY, config imageGen.key
  MURAGE_OPENAI_IMAGE_KEY: ["imageGen"],
  IMAGEGEN_KEY: ["imageGen"],
  // openai-compatible engine — env OPENAI_COMPAT_API_KEY, config openaiCompat.key
  OPENAI_COMPAT_API_KEY: ["openai", "openrouter", "deepseek", "mistral", "flux", "groq", "xai"],
  OPENAICOMPAT_KEY: ["openai", "openrouter", "deepseek", "mistral", "flux", "groq", "xai"],
  OPENROUTER_API_KEY: ["openrouter"],
  // A plain OPENAI_API_KEY names the issuer, not the destination: Murage has
  // TWO places an OpenAI key can live. Ambiguous on purpose.
  OPENAI_API_KEY: ["openai"],
  DEEPSEEK_API_KEY: ["deepseek"],
  MISTRAL_API_KEY: ["mistral"],
  GROQ_API_KEY: ["groq"],
  // Recognisable, unstorable.
  ANTHROPIC_API_KEY: ["anthropic"],
  ANTHROPIC_AUTH_TOKEN: ["anthropic"],
  CLAUDE_API_KEY: ["anthropic"],
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
  GOOGLE_GENERATIVE_AI_API_KEY: "google",
  STRIPE_SECRET_KEY: "stripe",
  STRIPE_API_KEY: "stripe",
};

/** `flux.apiKey`, `"FLUX_API_KEY"`, `export FLUX_API_KEY` all land on the
 * same lookup key. Case and separators are noise; the letters are not. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/^export\s+/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// The shape channel: the value's own prefix. Ordered — the first match wins,
// so every qualified `sk-…` family is tested before the bare one.
// ---------------------------------------------------------------------------

const SHAPES: ReadonlyArray<readonly [RegExp, Target]> = [
  // Anthropic. Checked first so an sk-ant- key can never fall through to the
  // bare sk- bucket and be offered as an OpenAI key.
  [/^sk-ant-[A-Za-z0-9_-]{16,}$/, ["anthropic"]],
  [/^sk-admin-[A-Za-z0-9_-]{16,}$/, "openai-admin"],
  // Flux Router. `sk-flux-…` is the spelling server/opencode-config.ts names
  // in prose and every Flux fixture in the suite uses.
  [/^sk-flux-[A-Za-z0-9_-]{16,}$/, ["flux"]],
  // OpenRouter, which is an openai-compatible upstream.
  [/^sk-or-v1-[A-Za-z0-9_-]{16,}$/, ["openrouter"]],
  [/^gsk_[A-Za-z0-9_-]{16,}$/, ["groq"]],
  // xAI.
  [/^xai-[A-Za-z0-9_-]{16,}$/, ["xai"]],
  // Google AI Studio: AIza + exactly 35.
  [/^AIza[A-Za-z0-9_-]{35}$/, "google"],
  // Composio project key.
  [/^ak_[A-Za-z0-9_-]{16,}$/, ["composio"]],
  // Stripe. BEFORE the ElevenLabs `sk_` rule, so a payment key is never filed
  // as a voice key — the exact wrong-write this parser exists to avoid.
  [/^[sprw]k_(live|test)_[A-Za-z0-9]{16,}$/, "stripe"],
  // ElevenLabs: sk_ + lowercase hex. The underscore is what separates this
  // whole family from the sk- one.
  [/^sk_[a-f0-9]{32,}$/, ["tts"]],
  // OpenAI project key. Certain about the ISSUER, ambiguous about the
  // DESTINATION: Murage has two OpenAI-shaped homes.
  [/^sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}$/, ["openai"]],
  // A bare sk-. Shared by OpenAI, OpenRouter, Flux and a dozen resellers.
  // This is the row that must always ask.
  [/^sk-[A-Za-z0-9_-]{16,}$/, ["openai", "openrouter", "deepseek", "mistral", "flux", "imageGen"]],
];

function matchShape(value: string): Target | undefined {
  for (const [pattern, target] of SHAPES) if (pattern.test(value)) return target;
  return undefined;
}

/** Every shape above, as one scanner for keys sitting loose in prose. The
 * lookarounds stop it biting a substring out of a longer token. */
const LOOSE = new RegExp(
  "(?<![A-Za-z0-9_-])(" +
    [
      "sk-[A-Za-z0-9_-]{16,}",
      // Payment keys first. `sk_live_…` has an underscore the ElevenLabs
      // alternative below cannot cross, so without this branch a Stripe key
      // is invisible here — and invisible means unwarned.
      "[sprw]k_(?:live|test)_[A-Za-z0-9]{16,}",
      "sk_[A-Za-z0-9]{24,}",
      "xai-[A-Za-z0-9_-]{16,}",
      "ak_[A-Za-z0-9_-]{16,}",
      "gsk_[A-Za-z0-9_-]{16,}",
      "AIza[A-Za-z0-9_-]{35}",
    ].join("|") +
    ")(?![A-Za-z0-9_-])",
  "g",
);

// ---------------------------------------------------------------------------
// Cleaning. Whitespace, quotes, trailing commas and CRLF are the usual reason
// a key saves and then does not work, so each one gets stripped deliberately
// and the tests pin the exact survivor.
// ---------------------------------------------------------------------------

const PLACEHOLDER =
  /^(?:<.*>|\.{3,}|x{3,}|your[-_ ]|paste|changeme|change[-_ ]me|todo|replace|example|abc123|secret|\$\{)/i;

/** Value-side cleaning for one `name = value` pair. */
function cleanValue(raw: string): string {
  let v = raw.trim();
  // An unquoted trailing `# comment`, the way .env files carry them.
  if (!/^["'`]/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
  // JSON / YAML list punctuation, then the quotes it was hiding behind, then
  // punctuation again for `"sk-…",` where the comma sat outside the quote.
  v = v.replace(/[,;]+$/, "").trim();
  const quote = v[0];
  if ((quote === '"' || quote === "'" || quote === "`") && v.endsWith(quote) && v.length >= 2) {
    v = v.slice(1, -1);
  }
  return v.replace(/[,;]+$/, "").trim();
}

/** Could this string be somebody's key at all? Deliberately narrow. */
function plausible(value: string): boolean {
  if (value.length < 8 || value.length > 400) return false;
  if (!/^[A-Za-z0-9_\-.=+/:~]+$/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (/(^|[-_])here($|[-_])/i.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------

interface Found {
  value: string;
  name?: string;
  fromName?: Target;
  fromShape?: Target;
}

const PAIR = /^\s*(?:export\s+)?["'`]?([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*(.+)$/;

function scanLines(blob: string, out: Found[]): void {
  for (const line of blob.split(/\r\n|\r|\n/)) {
    const pair = PAIR.exec(line);
    if (!pair) continue;
    const value = cleanValue(pair[2]!);
    if (!plausible(value)) continue;
    push(out, pair[1]!, value);
  }
}

function scanJson(blob: string, out: Found[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.trim());
  } catch {
    return;
  }
  const walk = (node: unknown, parent: string) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === "string") {
        const value = child.trim();
        // `xai.key` and `flux.apiKey` are the names that identify a section;
        // a bare `key` under no parent identifies nothing.
        if (plausible(value)) push(out, parent ? `${parent}.${key}` : key, value);
      } else if (child && typeof child === "object") {
        walk(child, key);
      }
    }
  };
  walk(parsed, "");
}

function scanLoose(blob: string, out: Found[]): void {
  for (const match of blob.matchAll(LOOSE)) {
    const value = match[1]!;
    if (plausible(value)) push(out, undefined, value);
  }
}

function push(out: Found[], name: string | undefined, value: string): void {
  const fromName = name === undefined ? undefined : NAMES[normalizeName(name)];
  const fromShape = matchShape(value);
  // Rule 2. Neither channel recognised it, so it is not a key as far as this
  // parser is concerned. A wrong row is worse than a missing one.
  if (fromName === undefined && fromShape === undefined) return;
  out.push({ value, name: fromName === undefined ? undefined : name, fromName, fromShape });
}

function resolve(found: Found): KeyCandidate {
  const { fromName, fromShape } = found;
  const evidence: Evidence =
    fromName !== undefined && fromShape !== undefined ? "name+shape" : fromName !== undefined ? "name" : "shape";

  // Either channel saying "Murage cannot store this" ends it. Refusing to
  // write is always the safe branch, so a disagreement resolves that way too.
  const unsupportedId =
    typeof fromName === "string" ? fromName : typeof fromShape === "string" ? fromShape : undefined;
  if (unsupportedId) {
    return {
      value: found.value,
      hint: keyHint(found.value),
      providers: [],
      unsupported: UNSUPPORTED[unsupportedId],
      ...(found.name === undefined ? {} : { name: found.name }),
      evidence,
    };
  }

  const byName = Array.isArray(fromName) ? fromName : undefined;
  const byShape = Array.isArray(fromShape) ? fromShape : undefined;
  let providers: ProviderId[];
  if (byName && byShape) {
    const both = byName.filter((id) => byShape.includes(id));
    // Agreement narrows. A contradiction (XAI_API_KEY holding an sk-proj- key)
    // widens instead of picking a side — the user is asked.
    providers = byName.length === 1 && byName[0] === "imageGen" && byShape.includes("openai") ? ["imageGen"] : both.length > 0 ? both : [...new Set([...byName, ...byShape])];
  } else {
    providers = [...(byName ?? byShape ?? [])];
  }

  return {
    value: found.value,
    hint: keyHint(found.value),
    // Declaration order is kept on purpose. Inside an ambiguous set it is the
    // likeliest destination first, which is the order a chooser should offer,
    // and re-sorting by PROVIDER_ORDER would put Flux at the head of a bare
    // `sk-` — a nudge toward exactly the wrong write this file exists to stop.
    providers,
    ...(found.name === undefined ? {} : { name: found.name }),
    evidence,
  };
}

/** Merge two sightings of the SAME key value into one row. The same key
 * under two different names is one key with two possible homes, so this
 * takes the UNION.
 *
 * It must not intersect. Two sightings of one value are not independent
 * evidence — they share a value, so they share a shape — and intersecting
 * would let the weaker sighting delete a destination the stronger one
 * raised. `XAI_API_KEY=sk-proj-…` seen once as a pair and once loose in the
 * same line would silently lose "xai" and start looking decided. */
function merge(a: KeyCandidate, b: KeyCandidate): KeyCandidate {
  if (a.unsupported) return a;
  if (b.unsupported) return b;
  return {
    value: a.value,
    hint: a.hint,
    providers: [...new Set([...a.providers, ...b.providers])],
    ...(a.name ?? b.name ? { name: a.name ?? b.name! } : {}),
    evidence: a.evidence === b.evidence ? a.evidence : "name+shape",
  };
}

/**
 * Read a pasted blob and return every key it recognises, in the order they
 * appear, deduplicated by value.
 *
 * Handles `KEY=value` and `export KEY=value` env lines with or without
 * quotes, `key: value` YAML-ish lines, JSON (including a pasted
 * `~/.murage/config.json`, where the section name is the strongest signal
 * there is), and bare keys sitting in prose. CRLF, trailing commas and
 * wrapping quotes are stripped; the exact surviving string is what gets
 * saved, so the tests pin it character for character.
 *
 * Returns suggestions. It never saves anything and never decides anything a
 * caller could not have decided from the same evidence.
 */
export function extractKeys(blob: string): KeyCandidate[] {
  if (typeof blob !== "string" || blob.trim() === "") return [];
  const found: Found[] = [];
  scanJson(blob, found);
  scanLines(blob, found);
  scanLoose(blob, found);

  // A value seen both under a name and loose in prose is ONE sighting: the
  // nameless one carries strictly less information, so it is dropped rather
  // than merged. Keeping it would make an ambiguous row look decided.
  const named = new Set(found.filter((one) => one.name !== undefined).map((one) => one.value));
  const byValue = new Map<string, KeyCandidate>();
  for (const one of found) {
    if (one.name === undefined && named.has(one.value)) continue;
    const candidate = resolve(one);
    const existing = byValue.get(candidate.value);
    byValue.set(candidate.value, existing ? merge(existing, candidate) : candidate);
  }
  return [...byValue.values()];
}

// ---------------------------------------------------------------------------

/** The subset of ConfigStatus (src/state/store.tsx) this feature reads.
 * Presence flags only — GET /api/config never returns a value, so there is
 * no field a saved key could arrive in. `openaiCompat` is absent from
 * ConfigStatus entirely, so its row can never claim to be already connected. */
export interface ConfiguredFlags {
  xai?: { configured: boolean };
  composio?: { configured: boolean };
  box?: { configured: boolean };
  opencodeGo?: { configured: boolean };
  tts?: { configured: boolean };
  imageGen?: { configured: boolean };
  flux?: { configured: boolean };
}

/** Whether this destination already holds a key. Unknown reads as false —
 * "already connected" is a claim, and an unloaded config cannot make it. */
export function providerConfigured(id: ProviderId, flags: ConfiguredFlags | null | undefined): boolean {
  if (!flags) return false;
  if (id === "openaiCompat" || PROVIDERS[id].modelPreset) return false;
  return flags[id as keyof ConfiguredFlags]?.configured ?? false;
}

/** Local provider hints for a single-key Models form; no inference or HTTP. */
export function modelProviderCandidates(blob: string): ProviderPreset[] {
  return [...new Set(extractKeys(blob).flatMap(candidate => candidate.providers.flatMap(id => PROVIDERS[id].modelPreset ? [PROVIDERS[id].modelPreset!] : [])))];
}
