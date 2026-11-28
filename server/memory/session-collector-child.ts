// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: memory V2 lane H. Test tree only: the real process of the H-R3 kill matrix (session-collector-harness.ts). It opens the store
// through the real database.ts, runs one scenario and is killed (SIGKILL, by itself, right after its `kill`-th statement returned), so
// nothing it held in memory survives. With kill=0 it runs to the end and prints how many statements it executed, which, and after which
// one the deletion was committed.
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { database } from '../database.ts';
import { clock, hasCheck, instrument, runScenario, type Guard, type Meter, type Path } from './session-collector-harness.ts';

const [path, guard, killArg] = process.argv.slice(2) as [Path, Guard, string];
const kill = Number(killArg);
Date.now = () => clock.now;
const file = join(DATA_DIR, 'messages.db');
const db = database();
let commitAt = -1;
const trace: string[] = [];
const meter: Meter = instrument(db, {
  after(k, sql, handle) {
    if (k === kill) process.kill(process.pid, 'SIGKILL');
    trace.push(`${handle === 'foreign' ? 'foreign: ' : ''}${sql.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
    // committed: the check is gone and this connection holds no transaction, whichever handle deleted it (read on this connection,
    // uncounted: a third connection opening the file would be an event of its own)
    if (commitAt < 0 && !db.isTransaction && meter.aside(() => !hasCheck(db))) commitAt = k;
  },
});
runScenario(db, file, path, guard, meter);
process.stdout.write(`\nH-MATRIX ${JSON.stringify({ statements: meter.count(), commitAt, trace })}\n`); // the store logs on stdout too
process.exit(0);
