// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Preloaded into the server under test (--import): one line a second with the event-loop delay of that second.
//   [eld] t=<epoch ms> p50=<ms> p99=<ms> max=<ms>
import { monitorEventLoopDelay } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
setInterval(() => {
  const ms = (v) => Math.round(v / 1e5) / 10;
  console.log(`[eld] t=${Date.now()} p50=${ms(h.percentile(50))} p99=${ms(h.percentile(99))} max=${ms(h.max)}`);
  h.reset();
}, 1000).unref();
