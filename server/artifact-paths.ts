import { beginWrite, endWrite, undoWrite } from "./write-tx.ts";
// S5 site 13: migrate before the saved-file reader applies its source_root filter.
import type { DatabaseSync } from "node:sqlite";
import { artifactWorkspaceIdentity } from "./artifacts.ts";
import { dataRoots } from "./data-roots.ts";
import { rebaseStoredPath, type Constructors } from "./stored-paths.ts";

export function rebaseArtifactSourceRoots(db: DatabaseSync, constructors: (row: { botId: string; threadId: string }) => Constructors): number {
  if (!dataRoots().previousRoots().length) return 0;
  beginWrite(db, "s5_artifact_paths");
  try {
    const rows = db.prepare("SELECT id,bot_id,thread_id,source_root FROM artifacts").all() as Array<{ id: string; bot_id: string; thread_id: string; source_root: string }>;
    const update = db.prepare("UPDATE OR IGNORE artifacts SET source_root=? WHERE id=? AND source_root=?");
    let count = 0;
    for (const row of rows) {
      const next = rebaseStoredPath(row.source_root, constructors({ botId: row.bot_id, threadId: row.thread_id }));
      if ("path" in next) count += Number(update.run(artifactWorkspaceIdentity(next.path), row.id, row.source_root).changes);
    }
    endWrite(db, "s5_artifact_paths");
    if (count) console.warn(`data-dir-rebase kind=artifact count=${count}`);
    return count;
  } catch (error) {
    undoWrite(db, "s5_artifact_paths");
    throw error;
  }
}
