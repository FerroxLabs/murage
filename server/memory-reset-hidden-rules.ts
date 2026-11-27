import "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-seanclean: the command of server/memory/reset-hidden-rules.ts (owner of both: q1023-seanclean). A bundled server entry
// (scripts/bundle-server.mjs), started by the packaged app's hidden flag (electron/memory-reset-entry.mjs):
//   Murage --memory-reset-hidden-rules [--data-dir <folder>] [--finish-minutes <n>] [--dry-run] [--no-check]
// It only ever FINISHES revokes (every owed mark is written): nothing a revoke hid is released.
// The app must be closed: the command takes the data folder's lease for its whole run (as the app does) and refuses while
// another owner holds it. It prints one JSON line per step with counts only, never a word of anyone's content.
// Exit: 0 clean or nothing to do, 2 something is still open (the store is whole; run it again or start the app),
// 3 refused (the app is running, or no store), 1 error, 64 usage.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryRoster } from "./memory/policy.ts";

export const EXIT = { ok: 0, error: 1, incomplete: 2, refused: 3, usage: 64 } as const;
export interface ResetArguments { dataDir: string; finishMinutes: number; dryRun: boolean; check: boolean }

/** Parses the command's own arguments (after the entry path). Null when they are not understood. */
export function parseResetArguments(argv: readonly string[], home: string = homedir()): ResetArguments | null {
  const out: ResetArguments = { dataDir: join(home, ".murage"), finishMinutes: 30, dryRun: false, check: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--memory-reset-hidden-rules") continue;
    if (arg === "--data-dir") {
      const value = argv[++i];
      if (typeof value !== "string" || !value || value.startsWith("--") || value.includes("\0")) return null;
      out.dataDir = isAbsolute(value) ? value : resolve(value);
    } else if (arg === "--finish-minutes") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0 || value > 24 * 60) return null;
      out.finishMinutes = value;
    } else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--no-check") out.check = false;
    else return null;
  }
  return out;
}

const say = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify({ type: "murage:memory-reset", ...line })}\n`); };

export async function runReset(args: ResetArguments): Promise<number> {
  const file = join(args.dataDir, "messages.db");
  if (!existsSync(file)) { say({ status: "refused", why: "no-store" }); return EXIT.refused; }
  // before any server module resolves the data folder (config.ts reads it at load)
  process.env.MURAGE_DATA_DIR = args.dataDir;
  const { acquireDataDirLeaseForProcess } = await import("./data-dir-lease.ts");
  let lease: { release(): unknown } | null = null;
  if (!args.dryRun) {
    try { lease = acquireDataDirLeaseForProcess(args.dataDir, {}); }
    catch (error) { say({ status: "refused", why: "app-running-or-folder-held", code: String((error as { code?: unknown })?.code ?? "LEASE") }); return EXIT.refused; }
  }
  let db: DatabaseSync | null = null;
  try {
    const { hiddenRuleCounts, hiddenRulesSettled, resetHiddenRules } = await import("./memory/reset-hidden-rules.ts");
    db = new DatabaseSync(file, { readOnly: args.dryRun });
    db.exec("PRAGMA busy_timeout=1000");
    if (args.dryRun) {
      const counts = hiddenRuleCounts(db);
      say({ status: "dry-run", settled: hiddenRulesSettled(counts), counts });
      return EXIT.ok;
    }
    // as the app opens it (database.ts)
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144;");
    const started = Date.now();
    // q1023-cleanfix: a Forget job FINISH ends tells the app's own hook (server/forgotten-messages-hook.ts, what server/index.ts registers):
    // the roster as the app's Store reads it (bots.json, groups.json: store.ts readPersistedRecords), a message's time from its row.
    // A roster that does not read throws inside the job's step: the step rolls back and the job stays for the app (report "incomplete").
    const { forgottenMessagesHook } = await import("./forgotten-messages-hook.ts");
    const { readPersistedRecords } = await import("./persisted-state.ts");
    let roster: MemoryRoster | null = null;
    const forgottenMessages = forgottenMessagesHook({
      roster: () => (roster ??= { bots: readPersistedRecords(join(args.dataDir, "bots.json")), groups: readPersistedRecords(join(args.dataDir, "groups.json")) }),
      messageAt: (at, thread, id) => { const row = at.prepare("SELECT at FROM messages WHERE thread_id=? AND id=?").get(thread, id); return row ? Number(row.at) : undefined; },
    });
    const report = resetHiddenRules(db, {
      forgottenMessages,
      finishMs: args.finishMinutes * 60_000,
      progress: (phase, counts) => say({ status: "working", phase, seconds: Math.round((Date.now() - started) / 1000), jobsOpen: counts.jobsOpen, pending: counts.pendingThreads + counts.pendingScopes, bookkeeping: counts.bookkeeping }),
    });
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* the app checkpoints at its start */ }
    let check: string | null = null;
    if (args.check) check = String((db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined)?.quick_check ?? "unread");
    say({ ...report, seconds: Math.round((Date.now() - started) / 1000), ...(check === null ? {} : { quickCheck: check }) });
    if (check !== null && check !== "ok") return EXIT.error;
    return report.status === "incomplete" ? EXIT.incomplete : report.status === "not-a-memory-store" ? EXIT.refused : EXIT.ok;
  } catch (error) {
    const e = error as { code?: unknown; errcode?: unknown; name?: unknown };
    say({ status: "error", code: String(e?.code ?? e?.errcode ?? e?.name ?? "error").slice(0, 64) });
    return EXIT.error;
  } finally {
    try { db?.close(); } catch { /* closed */ }
    try { lease?.release(); } catch { /* released with the process */ }
  }
}

const invoked = (() => { try { return Boolean(process.argv[1]) && /memory-reset-hidden-rules\.(ts|js)$/.test(process.argv[1]!); } catch { return false; } })();
if (invoked) {
  const args = parseResetArguments(process.argv.slice(2));
  if (!args) { say({ status: "usage", usage: "--memory-reset-hidden-rules [--data-dir <folder>] [--finish-minutes <n>] [--dry-run] [--no-check]" }); process.exit(EXIT.usage); }
  else runReset(args).then(code => process.exit(code), () => process.exit(EXIT.error));
}
