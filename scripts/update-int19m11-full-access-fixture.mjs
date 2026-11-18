// SPDX-License-Identifier: AGPL-3.0-or-later
// Run with Node's type stripping; verdicts come from the production writer.
import { writeFileSync } from 'node:fs';
import { autoVerdict } from '../server/auto-approve.ts';
import { r2Rows, physicalFullAccessRows } from '../server/testing/no-limits-r2-cases.ts';
import { segmentDesignRows } from '../server/testing/no-limits-segment-design-cases.ts';
import { y3bRows } from '../server/testing/no-limits-y3b-cases.ts';

const rows = [...r2Rows, ...physicalFullAccessRows, ...segmentDesignRows.map(row => ({ ...row, cwd: '/work' })), ...y3bRows];
const actual = rows.map((row, index) => ({ index, id: row.id, verdict: autoVerdict(
  { autoApprove: true, fullAccess: true, noLimits: false },
  'tool' in row ? row.tool ?? 'Bash' : 'Bash', row.command,
  { ownerStarted: true, fullAccessOrigin: 'owner', outsideRead: null, commandText: row.command,
    commandCwd: row.cwd, workFolder: row.cwd, unseen: { platform: 'posix' },
    promptFacts: { cwd: row.cwd, home: '/home/fixture' } },
) }));
writeFileSync(new URL('../server/testing/int19m11-full-access.fixture.json', import.meta.url), JSON.stringify(actual, null, 2) + '\n');
