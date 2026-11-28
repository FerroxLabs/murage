// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 find: a skill row in the Settings search box asks the Skills page to open that skill's sheet. One pending ref,
// taken by the library when it mounts (the page was not open) or heard by it when it is already showing. The bot a result names
// rides with the ref, so the sheet opens on that bot (SkillReader bot mode) instead of the every-bot settings view.
export type SkillSheetRequest = { ref: string; botId?: string };
let pending: SkillSheetRequest | null = null;
const listeners = new Set<() => void>();

export function requestSkillSheet(ref: string, botId?: string): void {
  pending = { ref, ...(botId ? { botId } : {}) };
  for (const listener of [...listeners]) listener();
}

export function takeSkillSheet(): SkillSheetRequest | null {
  const ref = pending;
  pending = null;
  return ref;
}

export function onSkillSheetRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
