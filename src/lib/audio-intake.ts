/** Matches the existing Flux transcription route, not a raw-audio model claim. */
export const AUDIO_TRANSCRIPTION_MAX_BYTES = 4 * 1024 * 1024;
export const AUDIO_FORMATS = "Ogg, WebM, M4A/MP4, MP3, WAV or FLAC";
const MIMES: Record<string, string> = {
  "audio/ogg": "audio/ogg", "audio/webm": "audio/webm", "audio/mp4": "audio/mp4",
  "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg",
  "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/flac": "audio/flac", "audio/x-flac": "audio/flac",
};
const EXTENSIONS: Record<string, string> = { ogg: "audio/ogg", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac" };
type AudioFile = { name: string; type: string; size: number };
export function isAudioCandidate(file: Pick<AudioFile, "name" | "type">): boolean {
  return file.type.toLowerCase().startsWith("audio/") || /\.(ogg|opus|webm|m4a|mp4|mp3|wav|flac|aac)$/i.test(file.name);
}
export function audioTranscriptionMime(file: AudioFile): string {
  const declared = file.type.split(";", 1)[0]!.trim().toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = Object.hasOwn(MIMES, declared) ? MIMES[declared] : ((!declared || declared === "application/octet-stream") && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined);
  if (!mime) throw new Error(`Audio transcription accepts ${AUDIO_FORMATS}.`);
  if (file.size === 0) throw new Error("That audio file is empty.");
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > AUDIO_TRANSCRIPTION_MAX_BYTES) throw new Error("Audio transcription accepts files up to 4 MiB. Choose a shorter recording.");
  return mime;
}
