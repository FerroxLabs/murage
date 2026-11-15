// Leaf module (no imports): learning-send.ts reads this list at load time, and authority-epoch.ts sits in an import cycle through database.ts.
/** Rows of memory_scope_bindings that background work rewrites all the time and that grant or remove nothing:
 * counters, cursors, intents of queued jobs. Every other binding (a person, a human thread, an exclusion, the
 * roster, a bot grant, the owner's settings) moves the epoch when it is written. */
export const NOISY_SYSTEM_SUBJECTS: readonly string[] = [
  "observability", "reveal-capture", "reveal-scan", "procedure-review", "procedure-review-pending", "pip-stance", "pip-render",
  "pip-reflect", "pip-coverage", "consolidation-pending", "consolidation", "consolidation-skip-due", "consolidation-skip-cursor", "parked-sweep", "parked-reconcile", "origin-backfill",
  "memory-shape-check", "gepa-job", "continuity-budget", "extract-budget", "learning-spend", "memory-status-snapshot", "notebook-migration",
  // The roster binding is rewritten on every save that adds a bot, a task or a room (a widening: nothing a hold rests on changes); what a
  // save WITHDRAWS is bumped by policy.ts itself (thread dependencies on a conversation removal, hard on a container removal, the policy revision on an audience change). A notebook
  // link records what was imported and when it was last looked at; a changed import's own revoke moves the epoch, a first import nothing.
  "roster", "notebook-link", "thread-deletion-clock",
];
