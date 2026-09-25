/** Silero's "this is speech" probability (Pipecat's VAD_CONFIDENCE). Its own
 *  module so the call's microphone can compare against it without loading
 *  the model runtime that produces the number (see call-mic.ts). */
export const SPEECH_CONFIDENCE = 0.7;
