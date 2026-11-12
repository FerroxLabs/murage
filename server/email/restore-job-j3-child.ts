// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Child process for the real-death restore tests (restore-job-j3.test.ts): node runs it directly. "swap-and-die" arms, captures and swaps, then kills ITSELF with SIGKILL at
// the chosen point; "recover" is a fresh process running boot recovery and printing what it found.
import { join } from "node:path";
import { RestoreJobStore, type RestoreJobEffects } from "./restore-job.ts";
import { archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "./restore-job-effects.ts";

const [mode, dir, killAt] = process.argv.slice(2) as [string, string, string | undefined];
const live = join(dir, "messages.db"), archives = join(dir, "archives");
const aborts: string[] = [];
const real = sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 });
const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("unreachable"); };
const effects: RestoreJobEffects = mode === "swap-and-die" ? {
  ...real,
  install: j => { if (killAt === "before-install") die(); real.install(j); if (killAt === "after-install") die(); },
  prepare: j => { if (killAt === "before-prepare") die(); real.prepare(j); },
} : real;
const store = new RestoreJobStore({ dir, isLocalArchive: id => archiveIsLocal(archives, id), captureCarry: () => captureEmailCarry(live), effects, onAbort: j => { aborts.push(j.id); } });
if (mode === "swap-and-die") {
  store.arm({ archiveId: "arc1", source: "owner" }); store.capture(); store.swap({ archiveId: "arc1", source: "owner" }); store.prepare();
  process.stdout.write("survived\n");
} else {
  let action = "threw"; try { action = store.recover().action; } catch { /* reported as threw */ }
  process.stdout.write(JSON.stringify({ action, state: store.state(), windowOpen: store.windowOpen(), aborts }) + "\n");
}
