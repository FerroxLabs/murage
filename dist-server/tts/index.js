import * as elevenlabs from "./elevenlabs.js";
export class NoVoiceConfigured extends Error {
    // a plain field rather than a constructor parameter property: the harness
    // runs under `node --experimental-strip-types`, which is strip-ONLY, so a
    // parameter property is rejected at load time even though it typechecks
    reason;
    constructor(reason) {
        super(reason === "key"
            ? "Add an ElevenLabs key in App Settings to turn on voice."
            : "Pick a voice in App Settings.");
        this.reason = reason;
    }
}
export function voiceConfigured(cfg) {
    return Boolean(cfg.tts?.key && cfg.tts?.voice);
}
/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg, voiceId) {
    return Boolean(cfg.tts?.key && (voiceId || cfg.tts?.voice));
}
/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential. */
export function describeVoice(cfg) {
    return {
        configured: Boolean(cfg.tts?.key),
        ready: voiceConfigured(cfg),
        voice: cfg.tts?.voice ?? "",
    };
}
export function verifyKey(key) {
    return elevenlabs.verifyKey(key);
}
export async function listVoices(cfg) {
    const key = cfg.tts?.key;
    if (!key)
        return [];
    return elevenlabs.listVoices(key);
}
/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg, text, voiceId) {
    const key = cfg.tts?.key;
    if (!key)
        throw new NoVoiceConfigured("key");
    const voice = voiceId || cfg.tts?.voice;
    if (!voice)
        throw new NoVoiceConfigured("voice");
    return elevenlabs.synthesize(text, voice, key);
}
