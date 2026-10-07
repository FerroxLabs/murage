// Every bot gets a voice. A bot with none is given a Grok voice (a female one)
// once, at creation or at first load after an upgrade, and the choice is
// stored on the bot so every surface and every restart agrees. Voices are
// spread: a bot takes one no other bot uses yet; when all are taken, the
// least-used one. The owner can change it any time; an owner's choice is
// never touched (the stored `voiceAssigned` mark is dropped on any edit).

/** The voices a bot can be given by default: the female voices in
 *  tts/xai-speech.ts XAI_VOICES (bot-voice.test.ts keeps the two in step).
 *  Listed here, not imported, because the store loads this file and must not
 *  pull the voice clients (which read their base URLs at import time). */
export const DEFAULT_VOICE_POOL: readonly string[] = ["eve", "ara", "aurora", "carina", "celeste", "iris", "liora", "luna", "ursa"];

let random: () => number = Math.random;
/** Test seam: a seeded source of randomness. Call with no argument to restore. */
export function setVoiceRandom(next?: () => number): void {
  random = next ?? Math.random;
}

interface VoiceBot {
  voice?: string;
  voiceProvider?: string;
  voiceAssigned?: boolean;
}

/** A voice for the next bot: random among the least-used pool voices. */
export function pickDefaultVoice(bots: readonly VoiceBot[], rng: () => number = random): string {
  const uses = new Map(DEFAULT_VOICE_POOL.map((id) => [id, 0]));
  for (const b of bots) if (b.voice && uses.has(b.voice)) uses.set(b.voice, uses.get(b.voice)! + 1);
  const least = Math.min(...uses.values());
  const choices = DEFAULT_VOICE_POOL.filter((id) => uses.get(id) === least);
  return choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))]!;
}

/** Whether a bot has no voice of any kind chosen: no voice id and no voice
 *  service picked (a service picked with the voice cleared is a choice). */
export function lacksVoice(bot: VoiceBot): boolean {
  return !bot.voice?.trim() && !bot.voiceProvider;
}

/** Give every voice-less bot its default, once. Returns whether any changed. */
export function assignMissingVoices(bots: VoiceBot[]): boolean {
  let changed = false;
  for (const bot of bots) {
    if (!lacksVoice(bot)) continue;
    bot.voice = pickDefaultVoice(bots);
    bot.voiceAssigned = true;
    changed = true;
  }
  return changed;
}
