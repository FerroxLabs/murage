// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Chief of Staff guide, at the top of the Chief's Skills panel: a
// built-in that only the workspace Chief uses, on unless the owner switches
// it off here. "Read it" opens the same reader as every other skill.
import { useCallback, useEffect, useState } from "react";

import { Switch } from "../SettingsPrimitives";
import { CHIEF_GUIDE_REF, readSkill, refusalOf, setSkillForBot } from "@/lib/skills-api";

export const CHIEF_GUIDE_NAME = "Chief of Staff guide";
export const CHIEF_GUIDE_LINE = "How your Chief of Staff runs the morning brief, your day, your notes, research and the business.";

export interface ChiefGuideCardViewProps {
  on: boolean | null;
  busy: boolean;
  error: string;
  onToggle(): void;
  onRead(): void;
}

export function ChiefGuideCardView({ on, busy, error, onToggle, onRead }: ChiefGuideCardViewProps) {
  return (
    <section aria-label={CHIEF_GUIDE_NAME} className="mt-3 rounded-lg border border-hairline/50 bg-inset p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h4 className="text-[13px] font-medium text-ink">{CHIEF_GUIDE_NAME}</h4>
            <span className="text-[11px] text-ink-secondary">Built-in</span>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{CHIEF_GUIDE_LINE}</p>
          <button type="button" onClick={onRead} className="-ml-1 mt-1 rounded px-1 py-0.5 text-[12px] text-accent-text hover:bg-control">
            Read it
          </button>
        </div>
        <Switch
          checked={on === true}
          aria-label={`${on ? "Stop using" : "Use"} the ${CHIEF_GUIDE_NAME}`}
          disabled={busy || on === null}
          onClick={onToggle}
        />
      </div>
      {error && <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
    </section>
  );
}

export function ChiefGuideCard({ botId, onRead }: { botId: string; onRead(): void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const guide = await readSkill(CHIEF_GUIDE_REF);
      setOn(guide.bots.find((bot) => bot.botId === botId)?.enabled ?? false);
    } catch (cause) {
      setError(refusalOf(cause).message || "The guide couldn't be read.");
    }
  }, [botId]);
  useEffect(() => void load(), [load]);

  return (
    <ChiefGuideCardView
      on={on}
      busy={busy}
      error={error}
      onRead={onRead}
      onToggle={async () => {
        if (on === null) return;
        setBusy(true);
        setError("");
        try {
          await setSkillForBot(CHIEF_GUIDE_REF, botId, !on);
          setOn(!on);
        } catch (cause) {
          setError(refusalOf(cause).message || "That didn't change.");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
