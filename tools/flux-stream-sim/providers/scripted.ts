// tools/flux-stream-sim/providers/scripted.ts
// Offline, deterministic provider for CI and every error-path test. Energy VAD
// on 10 ms windows; a turn ends after a silence that depends on eagerness.
// Text comes from the script (one entry per speech segment) or w1 w2 ...
// Finals carry only the segment that just ended; the turn end is their join.
import type { StreamConfig } from "../../../shared/flux-stream-contract.ts";
import type { Provider, ProviderSession } from "../provider.ts";

const END_SILENCE_MS: Record<StreamConfig["eagerness"], number> = { low: 1500, medium: 700, high: 400 };
const WINDOW_MS = 10;
const PARTIAL_EVERY_MS = 300;

export function resolvedScripted(config: StreamConfig): StreamConfig {
  const min = config.min_silence_ms ?? END_SILENCE_MS[config.eagerness];
  const max = config.max_silence_ms ?? Math.max(min, END_SILENCE_MS[config.eagerness]);
  return { ...config, min_silence_ms: min, max_silence_ms: max };
}

export function scriptedProvider(): Provider {
  return {
    name: "scripted",
    async connect(initial, options, emit) {
      let config = resolvedScripted(initial);
      const script = [...(options.script ?? [])];
      const samplesPerWindow = (config.sample_rate * WINDOW_MS) / 1000;
      let pending = Buffer.alloc(0);
      let audioMs = 0;
      let inTurn = false;
      let segmentOpen = false;
      let silenceMs = 0;
      let turnStart = 0;
      let lastVoice = 0;
      let segmentStart = 0;
      let segmentText = "";
      let finals: string[] = [];
      let generic = 0;
      let sinceTurnPartial = 0;
      let ended = false;

      const endSilence = () => config.max_silence_ms ?? END_SILENCE_MS[config.eagerness];
      const nextSegmentText = () => script.shift() ?? `w${++generic}`;
      const closeSegment = () => {
        if (!segmentOpen) return;
        segmentOpen = false;
        finals.push(segmentText);
        emit({ kind: "final", text: segmentText, startMs: segmentStart, endMs: lastVoice });
      };
      const endTurn = () => {
        closeSegment();
        if (!inTurn) return;
        const text = finals.join(" ").trim();
        if (text) emit({ kind: "turn_end", text, confidence: 1, startMs: turnStart, endMs: lastVoice });
        else emit({ kind: "turn_cancelled" });
        inTurn = false;
        finals = [];
      };

      const session: ProviderSession = {
        sendAudio(pcm) {
          if (ended) return;
          pending = Buffer.concat([pending, pcm]);
          const bytesPerWindow = samplesPerWindow * 2;
          while (pending.length >= bytesPerWindow) {
            const win = pending.subarray(0, bytesPerWindow);
            pending = pending.subarray(bytesPerWindow);
            let sum = 0;
            for (let i = 0; i < win.length; i += 2) sum += (win.readInt16LE(i) / 32768) ** 2;
            const voiced = Math.sqrt(sum / samplesPerWindow) > 0.01;
            audioMs += WINDOW_MS;
            if (voiced) {
              if (!inTurn) {
                inTurn = true;
                turnStart = audioMs - WINDOW_MS;
                sinceTurnPartial = 0;
                emit({ kind: "speech_started", audioMs: turnStart });
              }
              if (!segmentOpen) {
                segmentOpen = true;
                segmentStart = audioMs - WINDOW_MS;
                segmentText = nextSegmentText();
              }
              silenceMs = 0;
              lastVoice = audioMs;
              sinceTurnPartial += WINDOW_MS;
              if (sinceTurnPartial >= PARTIAL_EVERY_MS) {
                sinceTurnPartial = 0;
                const heard = [...finals, segmentText].join(" ").split(" ");
                const share = Math.min(1, (audioMs - segmentStart) / 1000);
                const words = heard.slice(0, Math.max(1, Math.ceil(heard.length * share)));
                emit({ kind: "partial", text: words.join(" ").toLowerCase().replace(/[.,?!]/g, ""), startMs: turnStart, endMs: audioMs });
              }
            } else if (inTurn) {
              silenceMs += WINDOW_MS;
              if (silenceMs >= 300) closeSegment();
              if (config.turn_detection === "semantic" && silenceMs >= endSilence()) endTurn();
              if (config.turn_detection === "manual" && silenceMs >= (config.max_silence_ms ?? 10_000)) endTurn();
            }
          }
        },
        commit() {
          if (inTurn) endTurn();
        },
        update(next) {
          config = resolvedScripted(next);
          return true;
        },
        keepalive() {},
        effectiveConfig() {
          return config;
        },
        async close() {
          if (ended) return;
          if (inTurn) endTurn();
          ended = true;
          emit({ kind: "closed" });
        },
      };
      return session;
    },
  };
}
