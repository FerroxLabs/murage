/** Source protection for speech. Never persist this module's inputs or outputs. */
import { findSecretLabels, isExactMarker } from "../../shared/md-secret-label.mjs";
import { redactSecretsForSink } from "../redact.ts";
import { pronounceable, sentenceEnds } from "./speech-text.ts";
import { lex } from "./speech-source-grammar.ts";
import { MAX_SOURCE_BYTES, optionBCut } from "./speech-source-option-b.ts";
export { MAX_SOURCE_BYTES } from "./speech-source-option-b.ts";

export const REST_ON_SCREEN = "The rest is on screen.";
export type ProtectedSpeech = Readonly<{
  text: string;
  cut: number | null;
  sourceLength: number;
  intervals: readonly Readonly<{ start: number; end: number }>[];
}>;
const protectedValues = new WeakSet<object>();

function firstLabel(text: string, inclusive: boolean): number | null {
  let base = 0;
  for (const line of text.split("\n")) {
    const hit = findSecretLabels(line)[0];
    if (hit) {
      let at = hit.sepEnd - 1;
      if (inclusive) {
        // The shared oracle owns vocabulary. Find the shortest suffix ending in this separator.
        const end = at;
        while (at > 0 && /[ \t]/.test(line[at - 1])) at--;
        const earliest = Math.max(0, at - 32);
        let labelStart = earliest;
        for (let j = earliest; j <= at; j++) {
          if (findSecretLabels(line.slice(j, end + 1)).length) labelStart = j;
        }
        at = labelStart;
      }
      return base + at;
    }
    base += line.length + 1;
  }
  return null;
}

/** Protection is idempotent on these private, immutable values, never on arbitrary English. */
export function protectSpeechSource(source: string | ProtectedSpeech, options: { presentation?: boolean } = {}): ProtectedSpeech {
  if (typeof source !== "string") {
    if (!protectedValues.has(source)) throw new Error("invalid protected speech");
    return source;
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error("speech source limit");
  const spans = lex(source);
  let cut = source.length;
  const rawHit = firstLabel(source, Boolean(options.presentation));
  if (rawHit !== null) cut = rawHit;
  const view = spans.map((span) => span.view).join("");
  const hit = firstLabel(view, Boolean(options.presentation));
  let offset = 0;
  for (const span of spans) {
    if (span.unsafe) cut = Math.min(cut, span.start);
    if (hit !== null && hit >= offset && hit < offset + span.view.length) {
      cut = Math.min(cut, span.atomic ? span.start : span.start + hit - offset);
    }
    offset += span.view.length;
  }
  for (const span of spans) if (span.atomic && span.start <= cut && cut < span.end) cut = span.start;
  let text = spans.filter((span) => span.start < cut).map((span) => span.end <= cut ? span.spoken : span.spoken.slice(0, cut - span.start)).join("");
  // Only the protected projection may enter these final transformations.
  text = redactSecretsForSink(text);
  const finalHit = firstLabel(text, Boolean(options.presentation));
  if (finalHit !== null) { text = text.slice(0, finalHit); cut = Math.min(cut, source.length - 1); }
  for (const marker of text.matchAll(/«[^»]*(?:»|$)/g)) {
    const end = marker.index + marker[0].length;
    if (!isExactMarker(marker[0]) || (end < text.length && !/\s/.test(text[end]))) {
      text = text.slice(0, marker.index) + "redacted";
      cut = Math.min(cut, source.length - 1);
      break;
    }
  }
  text = text.replace(/«[^»]*»/g, "redacted")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*(?:#{1,6}|[-+>]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ").trim();
  const wasCut = cut < source.length;
  if (wasCut) text = `${text}${text ? " " : ""}redacted`;
  const result: ProtectedSpeech = Object.freeze({ text, cut: wasCut ? cut : null, sourceLength: source.length,
    intervals: Object.freeze(wasCut ? [Object.freeze({ start: cut, end: source.length })] : []) });
  protectedValues.add(result);
  return result;
}

export function capSpeech(text: string, maxUnits: number, cut = false): string {
  const suffix = ` ${REST_ON_SCREEN}`;
  if (!cut && text.length <= maxUnits) return text;
  if (maxUnits < suffix.length) throw new Error("speech cap too small");
  const room = maxUnits - suffix.length;
  if (text.length > room) {
    const prefix = text.slice(0, room);
    const ends = sentenceEnds(prefix);
    let end = ends.at(-1) ?? prefix.lastIndexOf(" ");
    if (end <= 0) end = room;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    text = text.slice(0, end).trimEnd();
  }
  return text + suffix;
}

/** No transformations are permitted after this immutable adapter payload. */
export type SpeechSourceOptions = { maxUnits?: number; presentation?: boolean; prefix?: string; pronounce?: boolean;
  /** Trusted caller formatting, performed before the D24 B.2 final release gate. */
  releaseTransform?: (text: string) => string;
};
export function compileSpeechSource(source: string, options: SpeechSourceOptions = {}): string {
  try {
    if ((options.prefix !== undefined && optionBCut(options.prefix)) || optionBCut(source)) return REST_ON_SCREEN;
    const parts = [options.prefix, source].filter((part): part is string => part !== undefined).map((part) => protectSpeechSource(part, options));
    const spoken = parts.map((part) => part.text).join(options.prefix === undefined ? "" : " says ");
    if (optionBCut(spoken)) return REST_ON_SCREEN;
    const transformed = options.pronounce === false ? spoken : pronounceable(spoken);
    if (optionBCut(transformed)) return REST_ON_SCREEN;
    const final = protectSpeechSource(transformed, options);
    const capped = capSpeech(final.text, options.maxUnits ?? 1500, final.cut !== null || parts.some((part) => part.cut !== null));
    const released = options.releaseTransform ? options.releaseTransform(capped) : capped;
    // D24 B.2 RULE: check exactly the release after ALL transformations. Only
    // the exact constant suffix appended by capSpeech may be excluded.
    const suffix = ` ${REST_ON_SCREEN}`;
    const appendedSuffix = capped !== final.text && capped.endsWith(suffix);
    const checked = appendedSuffix && released.endsWith(suffix) ? released.slice(0, -suffix.length) : released;
    return optionBCut(checked) ? REST_ON_SCREEN : released;
  } catch {
    // Includes predicate, collapse, shared label scan and lexer budget failures.
    return REST_ON_SCREEN;
  }
}

/** D24 B.2: splitter formatting happens inside compile, before its final gate.
 * Afterwards only character-preserving slices of that exact payload leave. */
export function compileSpeechChunks(source: string, project: (text: string) => string[], options: SpeechSourceOptions = {}): string[] {
  let chunks: string[] = [];
  let separator = "";
  const released = compileSpeechSource(source, { ...options, releaseTransform: text => {
    const formatted = options.releaseTransform ? options.releaseTransform(text) : text;
    if (optionBCut(formatted)) return REST_ON_SCREEN;
    chunks = project(formatted);
    if (chunks.some(chunk => optionBCut(chunk))) return REST_ON_SCREEN;
    // Restore only proven whitespace boundaries. A custom splitter that cuts
    // within a token still checks the concatenation, including straddled secrets.
    separator = chunks.join(" ") === formatted ? " " : "";
    return chunks.join(separator);
  } });
  if (released === REST_ON_SCREEN) return [REST_ON_SCREEN];
  let offset = 0;
  return chunks.map(chunk => { const start = offset; offset += chunk.length; const slice = released.slice(start, offset); offset += separator.length; return slice; });
}
/** Text compiled for a voice. Only voicedText() mints one: a frozen value recorded in a module-private WeakSet.
 *  spokenText() returns its text and refuses anything else at runtime, so a cast, a copy or a plain string fails
 *  closed and is never spoken as compiled (tts speakCallClip). */
export interface VoicedText { readonly text: string; readonly __voicedText: true }
const mintedVoicedText = new WeakSet<object>();
/** The exact text a voice is given for one line it speaks. The call reply route compiles each released utterance
 *  once with this and both synthesizes and captions that same text (call-reply-route.ts, tts speakCallClip). */
export function voicedText(written: string): VoicedText {
  const text = compileSpeechSource(written, { maxUnits: MAX_SOURCE_BYTES * 2 });
  const voiced = Object.freeze({ text, toString: () => text }) as unknown as VoicedText;
  mintedVoicedText.add(voiced);
  return voiced;
}
/** The text of a VoicedText that voicedText() minted. Anything else throws (fail closed). */
export function spokenText(value: unknown): string {
  if (typeof value !== "object" || value === null || !mintedVoicedText.has(value)) throw new TypeError("call speech text was not compiled by voicedText()");
  return (value as VoicedText).text;
}
