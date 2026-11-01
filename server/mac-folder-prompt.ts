// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// While macOS's folder prompt holds the engine, the conversation says so (designs/MAC-FOLDER-PROMPT-1013.md).
// This module only reads events and writes one line. It holds no request and answers none: it reaches the permission
// path in no way, so it cannot open a card, deny, or stop a turn. A wrong guess costs a line that clears itself.
import type { RuntimeEvent } from "./contracts.ts";
import { FOLDER_PROMPT_DELAY_MS, macFoldersNamed, type MacPromptFolder } from "../shared/mac-folder-prompt.ts";

/** A tool call's text is read this far. The path comes first, and a large Write is not worth reading to the end. */
const SCAN_CHARS = 16_384;
const LIVENESS_SWEEP_MS = 60_000;

export type MacFolderPromptDeps = {
  platform: NodeJS.Platform;
  /** The turn is still running (a host retirement sends no provider event: a provider reload, a room stall). */
  live: (threadId: string) => boolean;
  /** A card is open on the thread. */
  askOpen: (threadId: string) => boolean;
  /** Write the line; returns the row's id. */
  show: (threadId: string, folder: MacPromptFolder) => string;
  clear: (threadId: string, rowId: string, folder: MacPromptFolder) => void;
  delayMs?: number;
  sweepMs?: number;
};

type Watch = { folder: MacPromptFolder; turnId?: string; items: Set<string>; timer?: ReturnType<typeof setTimeout>; rowId?: string };

function toolText(title: unknown, input: unknown): string {
  let text = typeof title === "string" ? title : "";
  try {
    if (input !== undefined) text += `\n${JSON.stringify(input)}`;
  } catch { /* input that cannot be written out names nothing */ }
  return text.slice(0, SCAN_CHARS);
}

export function createMacFolderPromptWatch(deps: MacFolderPromptDeps): { observe(event: RuntimeEvent): void } {
  const threads = new Map<string, Map<MacPromptFolder, Watch>>();
  let sweep: ReturnType<typeof setInterval> | undefined;

  const end = (threadId: string, watch: Watch) => {
    clearTimeout(watch.timer);
    const watches = threads.get(threadId);
    watches?.delete(watch.folder);
    if (!watches?.size) threads.delete(threadId);
    if (!threads.size && sweep) {
      clearInterval(sweep);
      sweep = undefined;
    }
    if (watch.rowId === undefined) return;
    try { deps.clear(threadId, watch.rowId, watch.folder); } catch { /* the thread is gone, and its row with it */ }
  };
  const endThread = (threadId: string, only?: (watch: Watch) => boolean) => {
    for (const watch of [...(threads.get(threadId)?.values() ?? [])]) if (!only || only(watch)) end(threadId, watch);
  };
  const fire = (threadId: string, watch: Watch) => {
    watch.timer = undefined;
    if (!deps.live(threadId) || deps.askOpen(threadId)) return end(threadId, watch);
    try { watch.rowId = deps.show(threadId, watch.folder); } catch { /* the thread is gone */ }
  };

  return {
    observe(event) {
      if (deps.platform !== "darwin") return;
      switch (event.type) {
        case "item.started": {
          if (event.itemType !== "tool" || event.origin !== "engine" || !event.itemId) return;
          const folders = macFoldersNamed(toolText(event.title, event.input));
          if (!folders.length) return;
          // a stopped turn's watch can only be older than this one
          endThread(event.threadId, (watch) => watch.turnId !== event.turnId);
          let watches = threads.get(event.threadId);
          if (!watches) threads.set(event.threadId, (watches = new Map()));
          for (const folder of folders) {
            let watch = watches.get(folder);
            if (!watch) {
              const created: Watch = watch = { folder, turnId: event.turnId, items: new Set() };
              created.timer = setTimeout(() => fire(event.threadId, created), deps.delayMs ?? FOLDER_PROMPT_DELAY_MS);
              created.timer.unref?.();
              watches.set(folder, created);
            }
            watch.items.add(event.itemId);
          }
          sweep ??= setInterval(() => {
            for (const threadId of [...threads.keys()]) if (!deps.live(threadId)) endThread(threadId);
          }, deps.sweepMs ?? LIVENESS_SWEEP_MS);
          sweep.unref?.();
          return;
        }
        case "item.completed": {
          if (event.itemType !== "tool" || !event.itemId) return;
          for (const watch of [...(threads.get(event.threadId)?.values() ?? [])]) {
            if (watch.items.delete(event.itemId) && !watch.items.size) end(event.threadId, watch);
          }
          return;
        }
        // The blocked engine sends nothing, so an ask or a tool heartbeat proves it is not held at the prompt: a long
        // command in a folder the Mac already allowed says nothing past its first heartbeat.
        case "item.updated":
          if (event.itemType === "tool") endThread(event.threadId);
          return;
        case "request.opened":
        case "session.exited":
          endThread(event.threadId);
          return;
        case "turn.started":
          endThread(event.threadId, (watch) => watch.turnId !== event.turnId);
          return;
        case "turn.completed":
          endThread(event.threadId, (watch) => !event.turnId || !watch.turnId || watch.turnId === event.turnId);
          return;
      }
    },
  };
}
