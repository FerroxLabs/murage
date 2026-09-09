import { expect, it, vi } from "vitest";
import { AUDIO_TRANSCRIPTION_MAX_BYTES, audioTranscriptionMime, isAudioCandidate } from "./audio-intake";
import { intakeFiles } from "./composer-attachments";
import { filenameFor, MAX_CLIP_BYTES } from "../../server/voice/transcribe-route";
it("matches the live route's format and size contract", () => {
  expect(AUDIO_TRANSCRIPTION_MAX_BYTES).toBe(MAX_CLIP_BYTES);
  for (const type of ["audio/ogg; codecs=opus", "audio/webm", "audio/x-m4a", "audio/mp3", "audio/x-wav", "audio/x-flac"]) {
    expect(filenameFor(audioTranscriptionMime({ type, name: "clip", size: 20 }))).not.toBeNull();
  }
  expect(audioTranscriptionMime({ type: "", name: "VOICE.WAV", size: 20 })).toBe("audio/wav");
  expect(audioTranscriptionMime({ type: "application/octet-stream", name: "voice.mp3", size: 20 })).toBe("audio/mpeg");
});
it("rejects unsupported, empty and oversized audio before upload", () => {
  for (const type of ["audio/aac", "audio/opus", "text/html", "constructor"]) expect(() => audioTranscriptionMime({ name: "clip.wav", type, size: 1 })).toThrow(/accepts/);
  expect(() => audioTranscriptionMime({ name: "clip.wav", type: "audio/wav", size: 0 })).toThrow(/empty/);
  expect(() => audioTranscriptionMime({ name: "clip.wav", type: "audio/wav", size: MAX_CLIP_BYTES + 1 })).toThrow(/4 MiB/);
  expect(isAudioCandidate({ name: "clip.aac", type: "" })).toBe(true);
});
it("queues audio for explicit consent without uploading or using its local path", async () => {
  const file = { name: "clip.wav", type: "audio/wav", size: 10, text: async () => "not text" };
  const queueAudio = vi.fn(), getPath = vi.fn(() => "/private/clip.wav"), uploadImage = vi.fn();
  const result = await intakeFiles([file], { allowImages: true, queueAudio, getPath, uploadImage });
  expect(result).toEqual({ attachments: [], notice: null }); expect(queueAudio).toHaveBeenCalledWith(file);
  expect(getPath).not.toHaveBeenCalled(); expect(uploadImage).not.toHaveBeenCalled();
  const refused = await intakeFiles([file], { allowImages: true, getPath, uploadImage });
  expect(refused.attachments).toEqual([]); expect(refused.notice).toContain("review transcription");
});
