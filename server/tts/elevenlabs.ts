// ElevenLabs, the one voice.
//
// Everything about talking to the service lives in this file: verifying a
// key, listing voices, and turning one utterance into mp3 bytes. It runs on
// the HARNESS, never the renderer, because the key must not leave the
// server — GET /api/config reports configured-or-not booleans and nothing
// else, and that invariant is worth more than a saved round trip.
//
// One request per utterance rather than the streaming-input WebSocket: the
// client already splits text into utterances and fetches the next while the
// current one plays, which gets the same perceived latency with far fewer
// moving parts — and no socket to leak when a turn is interrupted.
//
// EVERY REQUEST HERE CARRIES THE KEY, SO NONE FOLLOWS A REDIRECT. fetch keeps
// a custom header like xi-api-key across a redirect, even to another origin,
// and a 307 or 308 also replays the body (the words being spoken). Each call
// below sets `redirect: "error"`, so a redirect fails the request instead.
import { RateLimitedError, retryAfterMs } from "./rate-limit.ts";
const API = process.env.MURAGE_ELEVENLABS_API || "https://api.elevenlabs.io/v1";
const MODEL = "eleven_flash_v2_5";
// 64kbps mono is indistinguishable for speech and a third of the bytes
const FORMAT = "mp3_44100_64";

export interface Voice {
  id: string;
  label: string;
  description?: string;
  /** How the voice sounds, for grouping the picker. xAI publishes this;
   *  OpenAI does not, so theirs is the common reading of how each sounds. */
  gender?: "female" | "male" | "neutral";
  /** Whose voice it is, where one list mixes them (Flux: OpenAI, Grok and
   *  ElevenLabs). */
  provider?: "openai" | "grok" | "elevenlabs";
  /** A Voice Library voice not yet in the owner's own ElevenLabs account:
   *  whose it is. Picking it adds it to the account first (addSharedVoice). */
  publicOwnerId?: string;
}

/** How long the service took, for the voice diagnostics: the harness's own
 *  wait for the response headers, and the gateway's `x-flux-ttfb-ms` when the
 *  service is Flux. Times only. */
export interface ClipTiming {
  headersMs: number;
  fluxTtfbMs?: number;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
  timing?: ClipTiming;
}

/** Audio handed on as the service makes it, so playback can start before
 *  the clip is finished (the first words of a sentence arrive in a third of
 *  the time the whole sentence takes). */
export interface StreamedAudio {
  stream: ReadableStream<Uint8Array>;
  mime: string;
  timing?: ClipTiming;
}

export type Clip = Audio | StreamedAudio;

/** A checked, successful response as one clip, or as it arrives. */
export async function clipFrom(res: Response, mime: string, streamed: boolean): Promise<Clip> {
  if (streamed && res.body) return { stream: res.body, mime };
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Prefer ElevenLabs' own words over anything we can invent — it knows the
 * plan, the quota and the model name. Mirrors box.boxErrorMessage. */
function message(status: number, what: string, body: any): string {
  const theirs =
    (typeof body?.detail === "string" && body.detail.trim()) ||
    (typeof body?.detail?.message === "string" && body.detail.message.trim()) ||
    (typeof body?.message === "string" && body.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    // Restricted keys are the common case, not a corner: a key with the
    // wrong scopes is REAL and still fails, so saying "copy a fresh one"
    // sends people to regenerate a key that was never the problem.
    return "ElevenLabs rejected that key. If it's a restricted key, give it the Voices and Text to Speech permissions, or paste an unrestricted one.";
  }
  if (status === 429) return theirs || "ElevenLabs is rate-limiting this account: wait a moment and try again.";
  if (status === 402) return theirs || "ElevenLabs says this account is out of credit.";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Check a key before we store it: a rejected credential must fail at the
 * paste, not hours later in another panel with nothing to act on.
 *
 * Checked against /voices, NOT /user. ElevenLabs keys carry per-endpoint
 * scopes, and a key restricted to speech has no `user_read` — verifying
 * there rejects perfectly good keys for a permission this feature never
 * uses (found the hard way, with a real key). /voices is what the settings
 * picker needs next, so it tests exactly the capability that matters. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": key },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: message(res.status, "checking that key", await safeJson(res)) };
  } catch {
    return { ok: false, message: "Couldn't reach ElevenLabs to check that key: check your connection." };
  }
}

async function getJson(key: string, url: string, what: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "xi-api-key": key },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(message(res.status, what, body));
  return body;
}

async function accountVoices(key: string): Promise<Voice[]> {
  const body = await getJson(key, `${API}/voices`, "listing voices");
  return (body?.voices ?? [])
    .map((v: any): Voice => ({
      id: String(v.voice_id ?? ""),
      label: String(v.name ?? "Voice"),
      description: [v.labels?.accent, v.labels?.description].filter(Boolean).join(" · ") || undefined,
    }))
    .filter((v: Voice) => v.id);
}

/** The public Voice Library. A voice the owner already added comes back as
 *  their own (no publicOwnerId); one without an owner id cannot be added and
 *  is left out. */
async function libraryVoices(key: string, query: string): Promise<Voice[]> {
  const body = await getJson(key, `${API}/shared-voices?page_size=100&${query}`, "searching the Voice Library");
  return (body?.voices ?? [])
    .map((v: any): Voice => ({
      id: String(v.voice_id ?? ""),
      label: String(v.name ?? "Voice"),
      description: [v.accent, v.description].filter(Boolean).join(" · ") || undefined,
      ...(v.is_added_by_user ? {} : { publicOwnerId: String(v.public_owner_id ?? "") }),
    }))
    .filter((v: Voice) => /^[A-Za-z0-9]{1,128}$/.test(v.id) && (v.publicOwnerId === undefined || /^[A-Za-z0-9]{1,128}$/.test(v.publicOwnerId)));
}

/** What the owner pasted into the search: a Voice Library share link
 *  (`.../share/<owner>/<voice>`), a link with `voiceId=`, or a bare voice id. */
export function pastedVoice(input: string): { id: string; owner?: string } | undefined {
  const text = input.trim();
  const share = /\/share\/([A-Za-z0-9]{1,128})\/([A-Za-z0-9]{1,128})(?=$|[/?#])/.exec(text);
  if (share) return { owner: share[1], id: share[2] };
  const param = /[?&]voiceId=([A-Za-z0-9]{1,128})(?=$|[&#])/.exec(text);
  if (param) return { id: param[1] };
  return /^[A-Za-z0-9]{20}$/.test(text) ? { id: text } : undefined;
}

const firstOfEachId = (voices: Voice[]) => voices.filter((voice, index) => voices.findIndex((v) => v.id === voice.id) === index);

/** The owner's own voices; with a search, their matching voices first, then
 *  the Voice Library's. A pasted link or id finds that one voice. */
export async function listVoices(key: string, { query }: { query?: string } = {}): Promise<Voice[]> {
  const account = await accountVoices(key);
  const trimmed = query?.trim().slice(0, 200) ?? "";
  if (!trimmed) return account;
  const pasted = pastedVoice(trimmed);
  if (pasted) {
    const mine = account.find((voice) => voice.id === pasted.id);
    if (mine) return [mine];
    if (pasted.owner) {
      const owned = await libraryVoices(key, `owner_id=${encodeURIComponent(pasted.owner)}`);
      const match = owned.find((voice) => voice.id === pasted.id);
      if (match) return [match];
    }
  }
  // the account's own voices match every word in their name, description or id, as the picker did
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const mineMatching = account.filter((voice) => words.every((word) => `${voice.label} ${voice.description ?? ""} ${voice.id}`.toLowerCase().includes(word)));
  const library = await libraryVoices(key, `search=${encodeURIComponent(pasted?.id ?? trimmed)}`);
  return firstOfEachId([...mineMatching, ...library]);
}

/** Add a Voice Library voice to the owner's own account (it takes one of
 *  their voice slots) and return the id to speak with. */
export async function addSharedVoice(key: string, publicOwnerId: string, voiceId: string, name: string): Promise<string> {
  const res = await fetch(`${API}/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ new_name: name }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await safeJson(res);
  if (!res.ok) throw new Error(message(res.status, "adding that voice", body));
  return typeof body?.voice_id === "string" && /^[A-Za-z0-9]{1,128}$/.test(body.voice_id) ? body.voice_id : voiceId;
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  return (await synthesizeClip(text, voiceId, key, false)) as Audio;
}

/** ElevenLabs' /stream endpoint sends the audio as it is made. */
export async function synthesizeClip(text: string, voiceId: string, key: string, streamed: boolean): Promise<Clip> {
  const route = streamed ? "/stream" : "";
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}${route}?output_format=${FORMAT}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: MODEL }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) throw new RateLimitedError(message(429, "speaking", await safeJson(res)), retryAfterMs(res.headers.get("retry-after")));
  if (!res.ok) throw new Error(message(res.status, "speaking", await safeJson(res)));
  return clipFrom(res, "audio/mpeg", streamed);
}
