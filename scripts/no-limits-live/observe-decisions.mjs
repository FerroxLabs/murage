// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only observer of the product's existing decision event, before the durable
// privacy log replaces specific rule names with "rule". Never retains summaries,
// tool inputs, environment values, names or credentials. Does not alter verdicts.
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { onDecisionAppended } from '../../server/decision-log.ts';

const RULES = new Set(['delete-home', 'delete-root', 'delete-system-folder', 'disk-erase', 'fork-bomb', 'protected-path', 'unknown-target', 'unreadable', 'plainWipe']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
export function installDecisionObserver() {
  if (!isMainThread) return;
  const dataDir = process.env.MURAGE_DATA_DIR;
  if (!dataDir) throw Error('decision observer requires the owned fixture data directory');
  const file = join(dataDir, 'nolim-decisions.ndjson');
  if(!existsSync(file))writeFileSync(file, JSON.stringify({ observer: 'nolim-live', schema: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
  onDecisionAppended((dir, row) => {
    if (dir !== dataDir) return;
    appendFileSync(file, JSON.stringify({ at: Date.now(), threadId: identifier(row.threadId), requestId: identifier(row.requestId),
      decision: identifier(row.decision), source: identifier(row.source), rule: row.rule === undefined ? undefined : RULES.has(row.rule) ? row.rule : 'other',
      unattended: row.unattended }) + '\n');
  });
}
if (process.env.NOLIM_LIVE_OBSERVER === '1') installDecisionObserver();
