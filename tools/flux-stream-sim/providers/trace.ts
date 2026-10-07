// tools/flux-stream-sim/providers/trace.ts
// Replays a recorded AssemblyAI message sequence through the real mapper, on
// audio time, so the mapper's traps (duplicate ends, opened-but-empty turns)
// run offline in the conformance suite (checks T10, T11).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Provider, ProviderSession } from "../provider.ts";
import { flushPending, mapAssemblyAI, newAaiState, resolvedAai } from "./assemblyai.ts";

const here = dirname(fileURLToPath(import.meta.url));
type TraceStep = { at_ms: number; msg: unknown };

export function traceProvider(dir = join(here, "..", "traces")): Provider {
  return {
    name: "trace",
    async connect(config, options, emit) {
      const steps = JSON.parse(readFileSync(join(dir, `${options.trace ?? "p1-blues"}.json`), "utf8")) as TraceStep[];
      const state = newAaiState(config.format);
      let audioMs = 0;
      let next = 0;
      let ended = false;
      const replayTo = (ms: number) => {
        while (next < steps.length && steps[next].at_ms <= ms) {
          const step = steps[next++];
          for (const e of mapAssemblyAI(step.msg, state, step.at_ms)) emit(e);
        }
        for (const e of flushPending(state, ms)) emit(e);
      };
      const session: ProviderSession = {
        sendAudio(pcm) {
          if (ended) return;
          audioMs += (pcm.length / 2 / config.sample_rate) * 1000;
          replayTo(audioMs);
        },
        commit() {},
        update: () => true,
        keepalive() {},
        effectiveConfig: () => resolvedAai(config),
        async close() {
          if (ended) return;
          replayTo(Number.POSITIVE_INFINITY);
          ended = true;
          emit({ kind: "closed" });
        },
      };
      return session;
    },
  };
}
