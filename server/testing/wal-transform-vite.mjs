// SPDX-License-Identifier: AGPL-3.0-or-later
// Vitest adapter of the WAL source transform: enforce "pre" so the raw TypeScript anchors run before Vite's own TypeScript transform.
import { transformWalSource, walTarget } from "./wal-transform.mjs";

export function walTransformPlugin() {
  return {
    name: "wal-source-transform",
    enforce: "pre",
    transform(code, id) {
      if (!walTarget(id)) return null;
      return { code: transformWalSource(id, code), map: null };
    },
  };
}
