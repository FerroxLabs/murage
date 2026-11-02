// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The level menu's state in Settings › Level: the open confirm card, the
// status line, and who may press what next. The calls, the words and what
// follows each answer are in src/lib/level-change.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fromAnswer, useStoreActions, type Bot, type BotAnnouncement } from "@/state/store";
import { needsLevelConfirm, permissionModeOf, type PermissionMode } from "@/lib/permission-mode";
import {
  changeDirect, directLine, fromWire, levelAcks, noteLine, openLevelCard, pressUse, undoLevelChange, undoneLine,
  type LevelCard, type LevelDeps, type LevelLine,
} from "@/lib/level-change";

type LevelBot = Pick<Bot, "id" | "name" | "autoApprove" | "fullAccess" | "noLimits" | "fullAccessAcknowledgedAt" | "noLimitsAcknowledgedAt">;

export function useLevelChange({ bot, desktop, drivesComputer }: { bot: LevelBot; desktop: boolean | undefined; drivesComputer: boolean }) {
  const { dispatch, flushBotPatches } = useStoreActions();
  const deps = useMemo<LevelDeps>(() => ({
    api,
    flush: flushBotPatches,
    onBot: (answer) => dispatch({ type: "botPatched", ...fromAnswer(answer as BotAnnouncement), bot: answer as BotAnnouncement }),
  }), [dispatch, flushBotPatches]);
  const [card, setCard] = useState<LevelCard | null>(null);
  const [line, setLine] = useState<LevelLine | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [reviewAsk, setReviewAsk] = useState(0);
  // Every answer checks it: picking again, or moving to another bot, retires what was in flight.
  const turn = useRef(0);
  const botRef = useRef(bot);
  botRef.current = bot;
  const botId = bot.id;

  useEffect(() => {
    turn.current += 1;
    setCard(null); setLine(null); setBusy(false); setUndoing(false);
  }, [botId]);

  const pick = useCallback(async (mode: PermissionMode) => {
    const current = botRef.current;
    const previous = permissionModeOf(current);
    if (mode === previous) return;
    const mine = ++turn.current;
    setBusy(true);
    setLine(null);
    if ((mode === "full" || mode === "unlimited") && needsLevelConfirm(previous, mode)) {
      const view = await openLevelCard(deps, { botId, target: mode });
      if (mine !== turn.current) return;
      setBusy(false); setCard(view.card); setLine(view.line);
      return;
    }
    setCard(null);
    const onDesktop = desktop !== false;
    const outcome = await changeDirect(deps, { botId, target: mode, previous, desktop: onDesktop, acks: levelAcks(current, previous, mode, drivesComputer) });
    if (mine !== turn.current) return;
    setBusy(false);
    setLine(outcome.kind === "saved" ? directLine(current.name, outcome, onDesktop, drivesComputer, Date.now()) : noteLine(outcome.message, Date.now()));
  }, [deps, botId, desktop, drivesComputer]);

  const use = useCallback(async (conversations: boolean) => {
    if (!card || busy) return;
    const mine = ++turn.current;
    const current = botRef.current;
    setBusy(true);
    const view = await pressUse(deps, { botId, bot: current.name, card, conversations, drivesComputer, acks: levelAcks(current, fromWire(card.preview.botLevel), card.target, drivesComputer) });
    if (mine !== turn.current) return;
    setBusy(false); setCard(view.card); setLine(view.line);
  }, [card, busy, deps, botId, drivesComputer]);

  const keep = useCallback(() => { turn.current += 1; setCard(null); setBusy(false); }, []);

  const undo = useCallback(async () => {
    if (!line?.undo || undoing) return;
    const mine = turn.current;
    setUndoing(true);
    const result = await undoLevelChange(deps, botId, line.undo);
    if (mine !== turn.current) return;
    setUndoing(false);
    setLine(undoneLine(botRef.current.name, result, Date.now()));
  }, [line, undoing, deps, botId]);

  const review = useCallback(() => { setLine(null); setReviewAsk((n) => n + 1); }, []);

  return { card, line, busy, undoing, reviewAsk, drivesComputer, pick, use, keep, undo, review };
}

export type LevelChange = ReturnType<typeof useLevelChange>;
