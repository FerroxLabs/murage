// SPDX-License-Identifier: AGPL-3.0-or-later
// Crash witness owner: recall-fix-j. Recovery consumer owner: recall-prod-x.
import { writeFileSync } from 'node:fs';
import { database } from '../../database.ts';
import { InternalCapabilities } from '../../internal-capabilities.ts';
import { captureSource } from '../capture.ts';
import { captureWork } from '../chunks.ts';
import { refreshMemoryCheckpoint } from '../consolidate.ts';
import { claimMemoryJob, publishMemoryWork } from '../jobs.ts';
import { storeAnchorMessage } from './anchor-message.ts';

const [cut, reached] = process.argv.slice(2), db = database();
const registry = new InternalCapabilities(), generation = registry.begin('bot', 'thread');
const token = registry.mint({ botId: 'bot', threadId: 'thread', generation, kind: 'memory', depth: 0, skillAuthoring: false });
const text = 'The fixture gate is green.';
storeAnchorMessage(db, 'thread', 'fixture-message', text);
captureSource(db, { id: 'fixture-source', threadId: 'thread', messageId: 'fixture-message', kind: 'text', speaker: 'owner', outcome: 'recorded', text });
const work = claimMemoryJob(generation)!;
publishMemoryWork(work, generation, captureWork(work));
function crash() {
  writeFileSync(reached, JSON.stringify({ cut, token, jobId: work.id }));
  process.kill(process.pid, 'SIGKILL');
  throw Error('fixture kill did not end process');
}
if (cut === 'capture-committed') crash();
if (cut === 'during-checkpoint-commit') {
  const exec = db.exec.bind(db);
  db.exec = sql => { if (sql === 'COMMIT') crash(); exec(sql); };
}
refreshMemoryCheckpoint(work.id);
if (cut === 'checkpoint-before-ack') crash();
throw Error('fixture crash cut was not reached');
