import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";
// S5 site 13: migrate before the saved-file reader applies its source_root filter.
import type { DatabaseSync } from "node:sqlite";
import { artifactWorkspaceIdentity } from "./artifacts.ts";
import { dataRoots } from "./data-roots.ts";
import { rebaseDone, rebaseInputKey, rebaseStart, rebaseStoredPath, type Constructors } from "./stored-paths.ts";

export function rebaseArtifactSourceRoots(db: DatabaseSync, constructors: (row: { botId: string; threadId: string }) => Constructors): number {
  if (!dataRoots().previousRoots().length) return 0;
  beginWrite(db, "s5_artifact_paths");
  try {
    // rows the marker for these roots already covered are not read again (see rebaseInputKey)
    const key = rebaseInputKey(), after = rebaseStart(db, "artifacts", key, "artifacts");
    const through = Number((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS top FROM artifacts").get() as { top: number }).top);
    const rows = db.prepare("SELECT rowid AS position,id,bot_id,thread_id,source_root FROM artifacts WHERE rowid > ?").all(after) as Array<{ position: number; id: string; bot_id: string; thread_id: string; source_root: string }>;
    const update = db.prepare("UPDATE OR IGNORE artifacts SET source_root=? WHERE id=? AND source_root=?");
    let count = 0, retry = Infinity;
    for (const row of rows) {
      const next = rebaseStoredPath(row.source_root, constructors({ botId: row.bot_id, threadId: row.thread_id }));
      if (!("path" in next)) continue;
      const changed = Number(update.run(artifactWorkspaceIdentity(next.path), row.id, row.source_root).changes);
      // an update the unique key IGNOREd (its current-root twin exists) is tried again on the next start, as before the marker (M1)
      if (changed) count += changed; else retry = Math.min(retry, Number(row.position));
    }
    rebaseDone(db, "artifacts", key, Number.isFinite(retry) ? retry - 1 : through, "artifacts");
    endWrite(db, "s5_artifact_paths");
    if (count) console.warn(`data-dir-rebase kind=artifact count=${count}`);
    return count;
  } catch (error) {
    undoWrite(db, "s5_artifact_paths");
    throw error;
  }
}
