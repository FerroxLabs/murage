// Which platforms can speak without a key — one answer, read by both sides.
//
// The harness has supported two zero-key speech engines for a while: the
// Mac's `say` (server/tts/system-voices.ts) and Windows' System.Speech
// (server/tts/windows-voices.ts). `server/tts/index.ts` treats them as ONE
// provider called "system", because nobody choosing a voice should have to
// know which operating system wrote it.
//
// The settings UI did not know that. It offered the system provider on
// Darwin alone, so a Windows owner could not reach an engine that was
// already installed, already tested and already wired to their config —
// and, since ElevenLabs needs their own key and Flux Router has no synthesis
// endpoint at all, that left them with no voice they could turn on.
//
// The rule lives here rather than in either half so the two cannot drift
// apart again. server/tts/tts.test.ts holds the harness to it.

/** Platforms with a built-in speech engine Murage can drive without a key. */
export const SYSTEM_VOICE_PLATFORMS = ["darwin", "win32"] as const;

export type SystemVoicePlatform = (typeof SYSTEM_VOICE_PLATFORMS)[number];

/** Takes the raw platform string, so a value that is neither `process.platform`
 * nor a desktop capability ("other", "", an unknown future port) is simply a
 * platform without built-in voices rather than a crash. */
export function platformHasSystemVoices(platform: string | undefined): boolean {
  return SYSTEM_VOICE_PLATFORMS.includes(platform as SystemVoicePlatform);
}
