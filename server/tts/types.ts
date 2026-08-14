// Voice provider SPI — the same shape as the agent driver SPI in
// contracts.ts, for the same reason: adding a voice is one file plus a
// one-line registration, and an unknown provider in a config from a newer
// build degrades to "unavailable" instead of taking the fleet down.
//
// The one addition over the driver SPI is `runsOn`. A cloud voice runs on
// the HARNESS, because its API key must never reach the renderer (the
// config endpoint only ever returns configured-or-not booleans, and that
// invariant is worth more than a saved round trip). A local voice runs in
// the RENDERER, because it has no key to protect, the model is already a
// WebGPU/WASM artifact, and anything imported from the main process or the
// compiled server has to survive electron-builder's `!**/node_modules/**`
// — the renderer's dependencies are bundled by Vite into dist/, which is
// shipped whole.

export interface TtsVoice {
  id: string;
  label: string;
  /** Free-text hint shown under the name in the picker (accent, age, use). */
  description?: string;
}

export interface TtsAudio {
  bytes: Uint8Array;
  mime: string;
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

export interface SynthesizeInput {
  text: string;
  voiceId?: string;
  key: string;
  /** Provider-specific overrides from config (model id, API version, …),
   * so a provider that renames a model does not brick the feature until we
   * ship a new build. */
  options?: Record<string, string>;
}

export interface TtsProvider {
  readonly id: string;
  readonly displayName: string;
  /** Where synthesis happens. "client" providers implement none of the
   * network methods below — the renderer owns them end to end. */
  readonly runsOn: "server" | "client";
  readonly needsKey: boolean;
  /** One line for the settings panel: what this choice costs and sounds like. */
  readonly blurb: string;
  /** Check a key against the provider before we store it (box.verifyToken's
   * rule: a rejected credential must fail at the paste, not hours later in
   * another panel). */
  verifyKey?(key: string): Promise<VerifyResult>;
  listVoices?(key: string): Promise<TtsVoice[]>;
  synthesize?(input: SynthesizeInput): Promise<TtsAudio>;
}

/** Prefer the provider's own words over anything we can invent — it knows
 * the plan, the quota and the model name. Mirrors box.boxErrorMessage. */
export function providerMessage(status: number, what: string, body: unknown): string {
  const record = (body ?? {}) as Record<string, any>;
  const theirs =
    (typeof record.message === "string" && record.message.trim()) ||
    (typeof record.detail === "string" && record.detail.trim()) ||
    (typeof record.error === "string" && record.error.trim()) ||
    (typeof record.error?.message === "string" && record.error.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    return theirs || "that key was rejected — paste a current one in App Settings";
  }
  if (status === 429) return theirs || "the voice provider is rate-limiting this account — wait a moment";
  if (status === 402) return theirs || "the voice provider says this account is out of credit";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Read a fetch body as JSON without throwing on an HTML error page. */
export async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
