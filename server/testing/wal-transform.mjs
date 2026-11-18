// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only source transform for the WAL checkpointer (design DESIGN-WALFLAKE6 rev8, D0). The worker is created from the inline string
// WORKER_SOURCE inside server/wal-maintenance.ts, so the target is the PARENT module: it is transformed before evaluation, together with its
// embedded worker string. Production files on disk are never written; no production code reads or imports this file.
// Each edit is an exact string anchor that must occur exactly once; a missing or repeated anchor fails with a named error.
import { readFileSync } from "node:fs";
// D5: production holds no test seam. SEAM_RESTORE is the exact inverse of the D5 removal (generated once from the removal diff, see
// wal-seam-edits.json): each entry maps a unique production anchor to the seamed text, so the transformed copy has every test seam the
// witnesses and mutants need while the files on disk have none. The restore batch applies first, as one simultaneous, non-overlapping pass.
const SEAM_RESTORE = JSON.parse(readFileSync(new URL("./wal-seam-edits.json", import.meta.url), "utf8"));
import { EDITS, TRANSFORM_MARKER } from "./wal-transform-edits.mjs";
export { TRANSFORM_MARKER };

/** The repo-relative target path of a module id (file path, file URL or Vite id with a query), or null when the module is not a target. */
export function walTarget(id) {
  const clean = String(id).replace(/^file:\/\//, "").split("?")[0].replace(/\\/g, "/");
  for (const key of Object.keys(EDITS)) if (clean.endsWith("/" + key)) return key;
  return null;
}

function applyEdit(source, target, edit) {
  const first = source.indexOf(edit.anchor);
  if (first < 0) throw new Error(`wal-transform: anchor "${edit.name}" not found in ${target}`);
  if (source.indexOf(edit.anchor, first + 1) >= 0) throw new Error(`wal-transform: anchor "${edit.name}" is not unique in ${target}`);
  return source.slice(0, first) + edit.insert(edit.anchor) + source.slice(first + edit.anchor.length);
}

/** Returns the transformed source for a target module, or the input unchanged for any other module. Identity and exports are preserved. */
export function transformWalSource(id, source) {
  const target = walTarget(id);
  if (!target) return source;
  let out = restoreSeams(String(source), target);
  for (const edit of EDITS[target]) out = applyEdit(out, target, edit);
  return out;
}

function restoreSeams(source, target) {
  const spans = [];
  for (const e of SEAM_RESTORE[target] ?? []) {
    const first = source.indexOf(e.anchor);
    if (first < 0) throw new Error(`wal-transform: seam anchor "${e.name}" not found in ${target}`);
    if (source.indexOf(e.anchor, first + 1) >= 0) throw new Error(`wal-transform: seam anchor "${e.name}" is not unique in ${target}`);
    spans.push([first, first + e.anchor.length, e.insert, e.name]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  for (let k = 1; k < spans.length; k++) if (spans[k - 1][1] > spans[k][0]) throw new Error(`wal-transform: seam anchors "${spans[k - 1][3]}" and "${spans[k][3]}" overlap in ${target}`);
  let out = source;
  for (let k = spans.length - 1; k >= 0; k--) out = out.slice(0, spans[k][0]) + spans[k][2] + out.slice(spans[k][1]);
  return out;
}
