import { database } from "../database.ts";
export function memoryMetrics(){
  const db=database();
  return {
    jobs:db.prepare("SELECT status,count(*) AS count FROM memory_jobs GROUP BY status").all(),
    records:db.prepare("SELECT state,count(*) AS count FROM memory_records GROUP BY state").all(),
    projections:db.prepare("SELECT lexical_status,embedding_status,count(*) AS count FROM memory_projection_receipts GROUP BY lexical_status,embedding_status").all(),
    epochs:db.prepare("SELECT policy_revision,deletion_epoch,mode FROM memory_meta WHERE id=1").get(),
  };
}
