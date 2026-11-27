import { DatabaseSync } from "node:sqlite";
import { commitGate, type CommitPlan } from "./commit-gate.ts";

export async function runCrashChild(
  path: string,
  plan: CommitPlan,
  workload: {
    prepare(db: DatabaseSync): void;
    run(db: DatabaseSync): void | Promise<void>;
    onCommit?(db: DatabaseSync): void;
  },
) {
  const db = new DatabaseSync(path);
  try {
    workload.prepare(db);
    await workload.run(commitGate(db, plan, () => workload.onCommit?.(db)));
  } finally {
    db.close();
  }
}
