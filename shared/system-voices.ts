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

/** What the Voice settings card offers on this machine, as data.
 *
 * The gate and the WORDS were both inline in src/components/VoiceSettings.tsx,
 * and that put the thing W10' actually got wrong — offering a Windows owner
 * "Built-in Mac voices", or telling them the engine is macOS-only — inside a
 * React component this node-environment suite cannot render. The only test
 * that could be written there read the component's source for those strings,
 * which stays green for any spelling the regex happens to miss and cannot run
 * the branch at all.
 *
 * So the decision is here, as a function, and the component renders what it
 * returns. Platform in, copy out, no React.
 */
export interface SystemVoiceOffer {
  /** whether the built-in engine may be chosen at all on this platform */
  available: boolean;
  /** the engine button's label */
  label: string;
  /** where the voices come from, for the sentence above the buttons */
  source: string;
  /** the sentence itself, for the provider currently selected */
  sentence: string;
  /** the disabled button's tooltip, when it is disabled */
  unavailableHint: string;
}

export const SYSTEM_VOICE_UNAVAILABLE_HINT = "Built-in voices are available on macOS and Windows";

export function systemVoiceOffer(
  platform: string | undefined,
  provider: "flux" | "elevenlabs" | "system",
): SystemVoiceOffer {
  const available = platformHasSystemVoices(platform);
  // A Windows owner is never offered "Mac voices", and neither owner is told
  // the voices come from the machine they are not using.
  const windows = platform === "win32";
  const label = windows ? "Built-in Windows voices" : "Built-in Mac voices";
  const source = windows ? "this PC" : "this Mac";
  const sentence =
    provider === "system"
      ? available
        ? ` the voices are the ones already installed on ${source}.`
        : " built-in voices are unavailable here. Switch to Flux or ElevenLabs to keep using voice."
      : provider === "flux"
        ? " the voices come through the workspace's Flux account."
        : " the ElevenLabs key is shared by the workspace.";
  return { available, label, source, sentence, unavailableHint: SYSTEM_VOICE_UNAVAILABLE_HINT };
}
