// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { requireQualGate } from "./qual.mjs";

// Slice B6: the five thin entry points. Each calls the gate FIRST and the real work (`caller`) exactly once, only
// on exit 0. Both are injected so W18 can spy on them. The default caller prints CALLER_NOT_BUILT and exits 2
// until the caller-side owner routes the real `canary pre|post`, `flip-latest`, build GO and heartbeat through
// these functions (OPEN NO-OWNER caller side: no real flip path is gated by this slice alone).
export const CALLER_NOT_BUILT = async () => {
  console.log("CALLER_NOT_BUILT");
  return 2;
};

function makeEntry(kind) {
  return async function entry({ gate, caller = CALLER_NOT_BUILT, args = {}, deps = {} } = {}) {
    const check = gate ?? ((gateArgs) => requireQualGate(gateArgs, deps));
    const result = await check({ ...args, for: kind });
    if (result.exit !== 0) return result.exit;
    return caller(args);
  };
}

export const pre = makeEntry("pre");
export const post = makeEntry("post");
export const flip = makeEntry("flip");
export const buildGo = makeEntry("build");
export const heartbeat = makeEntry("heartbeat");
export const ENTRIES = { pre, post, flip, "build-go": buildGo, heartbeat };
