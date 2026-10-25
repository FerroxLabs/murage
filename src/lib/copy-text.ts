// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2435 and #2405, Apache-2.0 (see NOTICE).
// One way to copy text. The web clipboard first (with a timeout, because a
// blocked clipboard can leave the promise pending), then the desktop bridge,
// then the old select-and-copy route. Never throws: the answer is whether the
// text reached the clipboard, so every Copy button can show a check mark or
// say so plainly.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";

export const COPY_TIMEOUT_MS = 3000;
export const COPY_FEEDBACK_MS = 1200;

export interface CopyEnv {
  web?: (text: string) => Promise<void>;
  bridge?: (text: string) => Promise<boolean>;
  legacy?: (text: string) => boolean;
  timeoutMs?: number;
}

function liveEnv(): CopyEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const bridge = (globalThis as { muragebox?: { copyText?: (text: string) => Promise<boolean> } }).muragebox?.copyText;
  return {
    web: nav?.clipboard?.writeText ? (text) => nav.clipboard.writeText(text) : undefined,
    bridge: bridge ? (text) => bridge(text) : undefined,
    legacy: legacyCopy,
  };
}

/** The select-and-copy route: a hidden textarea and execCommand. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("clipboard timed out")), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Copy `text`. Resolves true when it reached the clipboard, false otherwise; never rejects. */
export async function copyText(text: string, env: CopyEnv = liveEnv()): Promise<boolean> {
  if (!text) return false;
  const ms = env.timeoutMs ?? COPY_TIMEOUT_MS;
  if (env.web) {
    try { await withTimeout(env.web(text), ms); return true; } catch { /* try the next route */ }
  }
  if (env.bridge) {
    try { if (await withTimeout(env.bridge(text), ms)) return true; } catch { /* try the next route */ }
  }
  try { return env.legacy?.(text) ?? false; } catch { return false; }
}

/** For a `try { ... } catch` call site: copy or throw a plain sentence. */
export async function copyTextOrThrow(text: string): Promise<void> {
  if (!(await copyText(text))) throw new Error("Murage could not reach the clipboard. Select the text and press Ctrl+C or Cmd+C.");
}

export type CopyMark = "idle" | "copied" | "failed";

/** A Copy button's state: a check mark for 1.2 s, or a visible failure. */
export function useCopyFeedback(ms: number = COPY_FEEDBACK_MS): { mark: CopyMark; copy: (text: string) => Promise<boolean> } {
  const [mark, setMark] = useState<CopyMark>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    setMark(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMark("idle"), ms);
    return ok;
  }, [ms]);
  return { mark, copy };
}

/** For a menu item with no mark of its own: copy, and say so through `report` when it did not work. */
export async function copyOrReport(text: string, report: (message: string) => void): Promise<boolean> {
  const ok = await copyText(text);
  if (!ok) report(t("copy.failed"));
  return ok;
}
