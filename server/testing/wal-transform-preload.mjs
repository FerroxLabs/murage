// SPDX-License-Identifier: AGPL-3.0-or-later
// node:test adapter of the WAL source transform: `node --import ./server/testing/wal-transform-preload.mjs --test ...` (Node 24).
// module.registerHooks() is synchronous and registers BEFORE either target module loads; the hook keeps the native TypeScript format.
import { registerHooks } from "node:module";
import { transformWalSource, walTarget } from "./wal-transform.mjs";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!walTarget(url) || result.source == null) return result;
    const text = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
    return { ...result, source: transformWalSource(url, text) };
  },
});
