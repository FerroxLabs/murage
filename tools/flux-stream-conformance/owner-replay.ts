// tools/flux-stream-conformance/owner-replay.ts
// pnpm flux-stream:owner-replay -- <bake-off run dir> <recording dir>
// Scores the bake-off's saved AssemblyAI events with owner.ts (no network) and
// prints the table to compare with bakeoff-final.md. The recording dir holds
// the four <condition>.pcm files (16 kHz mono s16le) made from the run's audio.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { replayBakeoff } from "./owner.ts";

const [runDir, recDir] = process.argv.slice(2);
if (!runDir || !recDir) {
  process.stderr.write("usage: owner-replay.ts <bake-off run dir> <recording dir>\n");
  process.exit(2);
}
const pcmFor = (condition: string) => {
  const b = readFileSync(join(recDir, `${condition}.pcm`));
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
};
for (const r of replayBakeoff(runDir, pcmFor)) {
  process.stdout.write(`${r.condition}: p50 ${r.p50} ms, p90 ${r.p90} ms, WER ${(r.wer * 100).toFixed(1)} %, splits ${r.splits}/${r.pauseLines}, anomalies ${r.anomalies.join(",") || "none"}, missing ${r.missing.length}\n`);
}
