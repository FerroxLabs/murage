// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase } from './database.ts';
import { Store, type BotRecord, type TaskRecord } from './store.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function world(count: number) {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const bot = store.createBot({ name: 'Index fixture' }, { seedMessages: false });
  const room = store.createGroup('Index room', [bot.id]);
  const template = bot.tasks![0]!;
  let visits = 0;
  const tasks = Array.from({ length: count }, (_, i) => ({ ...template, threadId: `task-${i}` }));
  tasks[count - 1]!.channelProjectDesk = { groupId: room.id };
  bot.tasks = tasks;
  store.recordTaskExternalUpdate(bot.id, `task-${count - 1}`, 'fixture-update');
  bot.tasks = new Proxy(tasks, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
    return Reflect.get(target, key, receiver);
  } });
  return { store, bot, tasks, reset: () => { visits = 0; }, visits: () => visits };
}

const lookups: Record<string, (store: Store, bot: BotRecord, thread: string) => boolean> = {
  patchTask: (store, bot, thread) => store.patchTask(bot.id, thread, { unread: true })?.threadId === thread,
  taskByThread: (store, bot, thread) => store.taskByThread(bot.id, thread)?.threadId === thread,
  botByThread: (store, bot, thread) => store.botByThread(thread)?.id === bot.id,
  directTaskTargets: (store, bot, thread) => store.directTaskTargets(bot.id).has(thread),
  deskTaskByThread: (store, bot, thread) => store.deskTaskByThread(bot.id, thread)?.threadId === thread,
  continuationHolder: (store, bot, thread) => store.continuationHolder(bot.id, thread)?.threadId === thread,
  threadIdsForBot: (store, bot, thread) => store.threadIdsForBot(bot.id).includes(thread),
  threadHolder: (store, bot, thread) => store.threadHolder(thread)?.id === bot.id,
  projectThreadsAmong: (store, _bot, thread) => store.projectThreadsAmong(store.groups[0]!, [thread]).includes(thread),
  pendingThreadsFor: (store, bot, thread) => store.pendingThreadsFor(bot.id).includes(thread),
  ensureProjectDesk: (store, bot, thread) => store.ensureProjectDesk(bot.id, store.groups[0]!.id, 'Index room')?.threadId === thread,
  setResumeCursor: (store, bot, thread) => {
    store.setResumeCursor(bot.id, 'fixture', thread, thread);
    return store.taskByThread(bot.id, thread)?.resumeCursors.fixture === thread;
  },
  markTaskDispatched: (store, bot, thread) => {
    store.markTaskDispatched(bot.id, thread, 'fixture');
    return store.taskByThread(bot.id, thread)?.lastInstanceId === 'fixture';
  },
  addTaskUsage: (store, bot, thread) => store.addTaskUsage(bot.id, thread, { input: 1, output: 1, costUsd: null }, 'fixture-turn') !== null,
};

it.each(Object.entries(lookups))('first per-turn %s lookup is bounded after publishing history', (name, lookup) => {
  const counts = [50, 5000].map(count => {
    const f = world(count); f.reset();
    const found = lookup(f.store, f.bot, `task-${count - 1}`);
    const missing = lookup(f.store, f.bot, 'missing-task');
    const visits = f.visits(); f.store.stopSeqStamps();
    expect(found).toBe(true);
    expect(missing).toBe(false);
    return visits;
  });
  console.log('Task index visits', JSON.stringify({ name, small: counts[0], large: counts[1] }));
  expect(counts[1]).toBeLessThanOrEqual(counts[0]! + 20);
});

it('replacing a task list of the same length updates first-match, missing and desk lookups', () => {
  const { store, bot, tasks } = world(50);
  const replacement: TaskRecord[] = tasks.map((task, i) => ({ ...task, threadId: `next-${i}`, unread: i === 2 }));
  replacement[3] = { ...replacement[3]!, threadId: 'next-2' };
  bot.tasks = replacement;
  expect(store.taskByThread(bot.id, 'task-2')).toBeUndefined();
  expect(store.taskByThread(bot.id, 'next-2')).toBe(replacement[2]);
  expect(store.botByThread('next-49')).toBe(bot);
  expect(store.directTaskTargets(bot.id).has('task-49')).toBe(false);
  expect(store.deskTaskByThread(bot.id, 'task-49')).toBeUndefined();
  expect(store.deskTaskByThread(bot.id, 'next-49')).toBe(replacement[49]);
  store.patchTask(bot.id, 'next-49', { unread: false });
  expect(bot.unread).toBe(true);
  // Length changes retain the legacy in-place append compatibility.
  replacement.push({ ...replacement[0]!, threadId: 'appended' });
  expect(store.taskByThread(bot.id, 'appended')).toBe(replacement[50]);
  store.stopSeqStamps();
});

it('clearing and republishing tasks keeps replacement indexing active', () => {
  const { store, bot, tasks } = world(50);
  store.patchBot(bot.id, { tasks: undefined });
  expect(store.taskByThread(bot.id, 'task-49')).toBeUndefined();
  bot.tasks = tasks.map(task => ({ ...task, threadId: `restored-${task.threadId}` }));
  expect(store.taskByThread(bot.id, 'task-49')).toBeUndefined();
  expect(store.taskByThread(bot.id, 'restored-task-49')).toBe(bot.tasks[49]);
  store.stopSeqStamps();
});

it('load prepares the first lookup and serializes ordinary task records', () => {
  const { store, bot, tasks } = world(50);
  // Keep a valid active pointer and the runtime values boot restores.
  for (const task of tasks) { task.busy = false; task.activity = 'idle'; }
  store.patchBot(bot.id, { tasks, threadId: 'task-0' });
  const reloaded = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const loaded = reloaded.bot(bot.id)!;
  const loadedTasks = loaded.tasks!;
  let visits = 0;
  // Observe an already published list without replacing its contents.
  Object.defineProperty(loaded, 'tasks', { configurable: true, enumerable: true, value: new Proxy(loadedTasks, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  }) });
  expect(reloaded.taskByThread(bot.id, 'task-49')).toBe(loadedTasks[49]);
  expect(reloaded.taskByThread(bot.id, 'missing-task')).toBeUndefined();
  expect(visits).toBe(0);
  expect(structuredClone(loadedTasks)).toEqual(tasks);
  store.stopSeqStamps(); reloaded.stopSeqStamps();
});
