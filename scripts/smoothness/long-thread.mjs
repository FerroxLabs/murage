// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Relocate only the selected copied conversation before measuring S5. */
export async function prepareLongThread({ call, bot, threadId, folder }) {
  const cwd = await call("PATCH", `/api/bots/${bot.id}`, { cwd: folder });
  if (cwd.status !== 200) throw new Error(`rig: S5 could not set bot folder (status ${cwd.status})`);
  // The primary task pins its folder too. A bot PATCH does not change any
  // existing task pin (Store.pinTaskCwd), even when bot.threadId === threadId.
  const task = await call("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { cwd: folder });
  if (task.status !== 200 || task.json?.task?.cwd !== folder) {
    throw new Error(`rig: S5 could not set selected task folder (status ${task.status})`);
  }
  if (bot.threadId !== threadId) {
    const selected = await call("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=0`, {});
    if (selected.status !== 200) throw new Error(`rig: S5 could not select task folder (status ${selected.status})`);
  }
  return { cwdPatch: cwd.status, taskCwdPatch: task.status };
}
