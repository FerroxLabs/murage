// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-qual-h. Consumer owner: MAIN (publication crash qualification).
import { writeFileSync } from 'node:fs';
import { database, transaction } from '../../database.ts';
import { InternalCapabilities } from '../../internal-capabilities.ts';
import { Store } from '../../store.ts';
import { ioBudget } from '../../io-budget.ts';
import { captureSource } from '../capture.ts';
import { captureWork } from '../chunks.ts';
import { claimMemoryJob, publishMemoryWork } from '../jobs.ts';
import { refreshMemoryCheckpoint } from '../consolidate.ts';
import { materializeTerminalMemory } from '../terminal.ts';
import { storeAnchorMessage } from './anchor-message.ts';

const cut = process.argv[2], reached = process.argv[3], db = database();
const registry = new InternalCapabilities(), generation = registry.begin('bot', 'thread');
registry.bindProviderTurn('thread', generation, 'turn');
const token = registry.mint({ botId: 'bot', threadId: 'thread', generation, kind: 'memory', depth: 0, skillAuthoring: false });
let jobId: string | undefined;
let threadId = 'thread';
function crash() {
  const terminal = cut === 'before-terminal-commit' ? {
    sources: db.prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id=? AND kind='text'").get(threadId)!.n,
    marked: db.prepare("SELECT json_extract(json,'$.turnTerminal') AS terminal FROM messages WHERE thread_id=? AND role='bot' AND kind='text'").get(threadId)?.terminal,
  } : undefined;
  writeFileSync(reached, JSON.stringify({ cut, token, jobId, threadId, terminal }));
  process.kill(process.pid, 'SIGKILL');
  throw Error('fixture kill did not end process');
}
function beforeCommit() {
  const exec = db.exec.bind(db);
  db.exec = sql => { if (sql === 'COMMIT') crash(); exec(sql); };
}
if (cut === 'before-terminal-commit') {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const bot = store.createBot({}, { seedMessages: false });
  threadId = bot.threadId;
  store.appendMessage(threadId, { role: 'bot', kind: 'text', text: 'The fixture gate is green.', turnId: 'turn' });
  beforeCommit();
  store.markTerminalAssistantMessage(threadId, 'turn', 'completed');
  throw Error('fixture terminal commit was not reached');
}
transaction(() => {
  storeAnchorMessage(db, 'thread', 'terminal', 'The fixture gate is green.', 'bot');
  captureSource(db, { id: 'message:thread:terminal', threadId: 'thread', messageId: 'terminal', turnId: 'turn', kind: 'text', speaker: 'assistant', outcome: 'recorded', text: 'The fixture gate is green.' });
  if (cut === 'before-source-commit') crash();
});
if (cut === 'source-committed') crash();
if (cut === 'refused-before-notice') {
  ioBudget.setIsIdle(() => true);
  if (materializeTerminalMemory(registry, registry.resolve(`Bearer ${token}`)!, 'terminal') !== 'pending') throw Error('fixture refusal did not remain pending');
  crash();
}
const work = claimMemoryJob(generation);
if (!work) throw Error('fixture exact source was not claimable');
jobId = work.id;
if (cut === 'claim-committed') crash();
if (cut === 'during-capture-commit') beforeCommit();
publishMemoryWork(work, generation, captureWork(work));
if (cut === 'capture-committed') crash();
if (cut === 'during-checkpoint-commit') beforeCommit();
refreshMemoryCheckpoint(work.id);
if (cut === 'checkpoint-committed') crash();
throw Error('fixture crash boundary was not reached');
