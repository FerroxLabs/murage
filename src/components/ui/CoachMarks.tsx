// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hints once (UX overhaul slice 4, lane L4C): the host App.tsx mounts. It
// decides when a coach mark may show (src/lib/hints-seen.ts: once on this
// device, never at launch, never under 400 px, never two at once, never in
// first run or under help, a menu or a window) and loads the mark itself
// (CoachMark.tsx) only then, so the first paint does not carry it. It also
// gives the help panel its "Show hints again".
import { useEffect, useState, type ComponentType } from "react";
import { useStore } from "@/state/store";
import { registerHintsReset } from "@/components/help/HelpHost";
import { HINT_DELAY_MS, HINT_MIN_WIDTH, hintAllowed, markHintSeen, pageCovered, resetHints } from "@/lib/hints-seen";

export { pageCovered };
import type { CoachMarkProps } from "./CoachMark";

/** Every coach mark: the screen it belongs to, the control it points at (data-coach) and its words. At most two per screen. */
export const COACH_MARKS = [
  { screen: "chat", mark: "level-chip", text: "ux.l4c.coach.levelChip" },
] as const;

interface Showing { mark: (typeof COACH_MARKS)[number]; anchor: HTMLElement; name: string }

export function CoachMarks({ firstRun }: { firstRun: boolean }) {
  const { state } = useStore();
  const [resets, setResets] = useState(0);
  const [showing, setShowing] = useState<Showing | null>(null);
  const [Mark, setMark] = useState<ComponentType<CoachMarkProps> | null>(null);
  useEffect(() => registerHintsReset(() => { resetHints(); setResets((n) => n + 1); }), []);

  const bot = state.activeView === "chat" ? state.bots.find((b) => b.id === state.selectedId) : undefined;
  const botId = bot?.id;
  const botName = bot?.name ?? "";
  // Computer and Inspector are side panels, not windows: they cover the chat on a narrow window, so no hint then.
  const sidePanel = Boolean(state.computerOpen || state.inspectorOpen);
  useEffect(() => {
    setShowing(null);
    if (!botId || firstRun || sidePanel) return;
    let live = true;
    const timer = setTimeout(() => {
      for (const mark of COACH_MARKS) {
        const anchor = document.querySelector<HTMLElement>(`[data-coach="${mark.mark}"]`);
        if (!anchor) continue;
        if (!hintAllowed(mark.screen, mark.mark, { width: window.innerWidth, firstRun, showing: false, covered: pageCovered() })) continue;
        // Remembered before it is drawn: a hint that cannot be remembered is never shown, so it can never repeat.
        if (!markHintSeen(mark.screen, mark.mark)) return;
        import("./CoachMark").then((module) => {
          // The owner moved on while it loaded: it was shown in spirit, never drawn late on another screen.
          if (!live || pageCovered() || window.innerWidth < HINT_MIN_WIDTH || !anchor.isConnected) return;
          setMark(() => module.CoachMark);
          setShowing({ mark, anchor, name: botName });
        }).catch(() => { /* a stale chunk: the hint is skipped, never retried in a loop */ });
        return;
      }
    }, HINT_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [botId, botName, firstRun, resets, sidePanel]);

  if (!showing || !Mark) return null;
  return <Mark anchor={showing.anchor} textKey={showing.mark.text} params={{ name: showing.name }} onDone={() => setShowing(null)} />;
}
