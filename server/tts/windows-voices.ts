// Built-in Windows speech synthesis — the zero-key voice provider, on Windows.
//
// The sibling of system-voices.ts, which does this with `/usr/bin/say` on a
// Mac. Same three exports and the same 22 kHz mono WAV out, so `tts/index.ts`
// can treat "the platform can already speak" as one idea rather than two.
//
// WHY IT HAD TO EXIST. Murage has exactly three ways to turn text into audio
// and, before this, a Windows machine had none of them on day one.
// ElevenLabs needs the person's own key. The Mac path is a Darwin binary.
// And Flux Router has no synthesis endpoint at all, which is not an oversight
// on our side but a fact about that service, written out at the top of
// server/voice/flux-voice.ts. So the first run could not speak a single word
// to a Windows owner, which is most owners.
//
// HOW. Windows' own speech engine (SAPI) through the engine-exclusion addon
// (speechVoices / speechToWave in native/engine-exclusion/exclusion.c), on a
// worker thread. Until 1.0.3 this started PowerShell and .NET's System.Speech,
// which is a thin wrapper over the same SAPI voices; Murage no longer starts
// PowerShell itself (murage-releases #1). The addon lists exactly the voices
// System.Speech listed, under the same ids (each voice's Name, such as
// "Microsoft Zira Desktop"), so a voice saved in a bot's settings before 1.0.3
// still resolves. Chromium's speechSynthesis was not used: it cannot write a
// file, and the server hands the browser a WAV.
//
// THE TEXT IS NEVER PARSED. It is handed to SAPI as plain text (SPF_IS_NOT_XML),
// never as SAPI XML and never in a command line: a spoken reply is model
// output, and model output is downstream of the person's mail.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Audio, Voice } from "./elevenlabs.ts";
import { requireWindowsAddon } from "../engine-exclusion.ts";

export function windowsVoicesAvailable(platform: string = process.platform): boolean {
  return platform === "win32";
}

/** The two speech calls, injectable so the Windows path is testable anywhere. */
export interface WindowsSpeech {
  speechVoices(): Promise<Array<{ name: string; culture: string; description: string }>>;
  /** true when `voice` was found and used; false: the machine's default voice spoke. */
  speechToWave(text: string, voice: string, path: string): Promise<boolean>;
}
const native = (): WindowsSpeech => {
  const addon = requireWindowsAddon();
  return { speechVoices: () => addon.speechVoices!(), speechToWave: (text, voice, path) => addon.speechToWave!(text, voice, path) };
};

/** A voice as the picker shows it: the id is the voice's own name (what System.Speech called VoiceInfo.Name, and what a bot's saved
 *  settings hold), and the culture and description make a list of voices choosable rather than a list of strings. */
export function voiceOf(row: { name: string; culture: string; description: string }): Voice | null {
  const id = row.name.trim();
  if (!id) return null;
  return { id, label: id, description: [row.culture.trim(), row.description.trim()].filter(Boolean).join(": ") };
}

export async function listWindowsVoices(speech: () => WindowsSpeech = native): Promise<Voice[]> {
  try {
    return (await speech().speechVoices()).map(voiceOf).filter((voice): voice is Voice => voice !== null);
  } catch {
    // Same contract as the Mac path: a machine that cannot answer has no
    // voices, rather than an error that has to be handled at every call site.
    return [];
  }
}

/**
 * Synthesize one utterance to 22 kHz mono WAV.
 *
 * The same format the Mac path produces, for the same reason: it is small and
 * every browser plays it without a conversion step.
 *
 * An empty or unknown voice id falls back to the machine's own default, which
 * is what a fresh Windows already sounds like: a voice list can go stale
 * between the pick and the speaking, and an utterance in the wrong voice beats
 * silence. Speaking is bounded at 30 s and stopped when it runs past that.
 */
export async function synthesizeWindows(text: string, voiceId: string | undefined, speech: () => WindowsSpeech = native): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/wav" };
  const dir = await mkdtemp(join(tmpdir(), "murage-say-"));
  const out = join(dir, "utterance.wav");
  try {
    await speech().speechToWave(trimmed, voiceId?.trim() ?? "", out);
    return { bytes: new Uint8Array(await readFile(out)), mime: "audio/wav" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
