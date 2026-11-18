// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { setSkillOnBot } from "@/lib/skillsLibrary";
import { findingLines, refusalOf, setSkillForBot, type SkillDetail, type SkillScan } from "@/lib/skills-api";
import { BLOCKED_LINE } from "../skills/SkillReader";
import { useFocusTrap } from "@/lib/focus-trap";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "../ui/BoxShell";

export type LibraryBot = { id: string; name: string };
export const SKILL_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const SOFT = `min-h-[34px] rounded-full bg-control px-3 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50 ${SKILL_FOCUS}`;

export interface BotsPickerProps {
  skillId: string;
  skill: SkillDetail;
  bots: LibraryBot[];
  onChanged(): void | Promise<void>;
  /** The Bots tab has the same actions and acknowledgement flow. */
  view?: "picker" | "list";
  disabled?: boolean;
  /** Finish moving a reviewed copy only after its own assignment succeeds. */
  originalSkillId?: string;
}

export function BotsPicker({ skillId, skill, bots, onChanged, view = "picker", disabled = false, originalSkillId }: BotsPickerProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ bot: LibraryBot; scan: SkillScan } | null>(null);
  const [enabled, setEnabled] = useState(() => new Set(skill.bots.filter((bot) => bot.enabled).map((bot) => bot.botId)));
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const id = useId();
  const close = () => { if (!inFlight.current) { setOpen(false); setPending(null); } };
  useFocusTrap(dialog, open, { name: "skill-bots-picker", kind: "dialog", returnFocusTo: trigger.current, fallbackFocus: trigger.current, onEscape: close });
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setEnabled(new Set(skill.bots.filter((bot) => bot.enabled).map((bot) => bot.botId))); }, [skill]);

  const change = async (bot: LibraryBot, on: boolean, scan?: SkillScan) => {
    if (inFlight.current || disabled) return;
    if (on && !scan && skill.verdict === "review") { setPending({ bot, scan: skill.scan }); return; }
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    let copyInstalled = false;
    try {
      // The reviewed hash is sent through the existing owner-aware PUT helper.
      // It must never be silently acknowledged by the library client.
      if (scan) await setSkillForBot(skillId, bot.id, on, scan.contentHash);
      else await setSkillOnBot(skillId, bot.id, on);
      if (live.current) {
        setEnabled((old) => { const next = new Set(old); if (on) next.add(bot.id); else next.delete(bot.id); return next; });
        setPending(null);
      }
      if (on && originalSkillId && originalSkillId !== skillId) {
        copyInstalled = true;
        await setSkillOnBot(originalSkillId, bot.id, false);
      }
      if (live.current) {
        setNotice(`${on ? "Added to" : "Removed from"} ${bot.name}. Changes apply from the bot’s next message.`);
      }
      await onChanged();
    } catch (cause) {
      if (!live.current) return;
      const refusal = refusalOf(cause);
      if (copyInstalled) {
        setError(`Added your copy to ${bot.name}, but the original couldn’t be switched off. Remove the original from that bot before using your copy.`);
        await onChanged();
      }
      else if (on && refusal.code === "needs-review" && refusal.scan) setPending({ bot, scan: refusal.scan });
      else setError(refusal.message || "That change couldn't be saved. Try again.");
    } finally { inFlight.current = false; if (live.current) setBusy(false); }
  };

  const rows = <>
    {bots.length === 0 && <p className="py-3 text-[12.5px] text-ink-secondary">You have no bots yet.</p>}
    {skill.verdict === "blocked" && <p role="note" className="py-2 text-[12.5px] text-danger">{BLOCKED_LINE}</p>}
    <ul className="min-w-0 divide-y divide-hairline/30">
      {bots.map((bot) => {
        const on = enabled.has(bot.id);
        const unsupported = skill.bots.find((entry) => entry.botId === bot.id)?.canUseSkills === false;
        const rowDisabled = disabled || busy || (on ? false : skill.verdict === "blocked" || unsupported);
        const label = `${on ? "Remove from" : "Add to"} ${bot.name}`;
        return <li key={bot.id} className="flex min-h-12 min-w-0 items-center gap-2 py-2">
          {view === "picker" && <input id={`${id}-${bot.id}`} type="checkbox" aria-label={label} checked={on} disabled={rowDisabled} onChange={() => void change(bot, !on)} className={`size-4 shrink-0 accent-accent ${SKILL_FOCUS}`} />}
          {view === "list" && <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-[13px] font-semibold">{bot.name.slice(0, 1)}</span>}
          <span className="min-w-0 flex-1">
            {view === "picker" ? <label htmlFor={`${id}-${bot.id}`} className="block cursor-pointer break-words text-[13px] font-medium">{bot.name}</label> : <span className="block break-words text-[13px] font-medium">{bot.name}</span>}
            <span className={`block text-[11.5px] ${on ? "text-success" : "text-ink-secondary"}`}>{on ? "Uses this skill" : unsupported ? "This bot's engine can't use skills." : "Not using this skill"}</span>
          </span>
          <button type="button" disabled={rowDisabled} onClick={() => void change(bot, !on)} className={`${SOFT} max-w-[55%] shrink-0 break-words ${on ? "border border-danger/40 bg-transparent text-danger hover:bg-danger/10" : ""}`}>{label}</button>
        </li>;
      })}
    </ul>
    {pending && <div role="alertdialog" data-box-exempt="inline confirm inside a section" aria-label="Use this skill anyway?" className="rounded-lg border border-warning/40 bg-card p-3 text-[12.5px]">
      <p className="font-medium">Use {skill.name} anyway?</p>
      <p className="mt-1 text-ink-secondary">The skill check found:</p>
      <ul className="my-2 list-disc pl-4">{findingLines(pending.scan).map((line) => <li key={line}>{line}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={SOFT} onClick={() => void change(pending.bot, true, pending.scan)}>Use it anyway</button>
        <button type="button" disabled={busy} className={SOFT} onClick={() => setPending(null)}>Cancel</button>
      </div>
    </div>}
    {error && <p role="alert" className="py-2 text-[12.5px] text-danger">{error}</p>}
    {notice && <p role="status" className="py-2 text-[12px] text-ink-secondary">{notice}</p>}
  </>;

  if (view === "list") return <div>{rows}</div>;
  return <div className="relative min-w-0">
    <button ref={trigger} disabled={disabled} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else setOpen(true); }} className={`flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50 ${SKILL_FOCUS}`}>
      <Plus size={15} aria-hidden="true" />Add or remove bots
    </button>
    {open && <>
      <button type="button" tabIndex={-1} aria-label="Close this menu" className="fixed inset-0 z-20 cursor-default bg-black/35" onClick={close} />
      <div ref={dialog} id={id} role="dialog" aria-label="Which bots should use this skill?" tabIndex={-1} className={`${BOX_FRAME} absolute left-0 top-full z-30 mt-2 max-h-[min(420px,60vh)] w-80 max-w-[calc(100vw-3rem)] rounded-xl border border-hairline bg-card p-3 text-ink shadow-2xl`}>
        <BoxHead><h3 className="mb-1 px-1 text-[14px] font-semibold">Which bots should use this skill?</h3></BoxHead>
        <BoxBody className="thin-scroll">{rows}</BoxBody>
        <BoxFoot className="pt-2"><button type="button" disabled={busy} onClick={close} className={`${SOFT} w-full`}>Done</button></BoxFoot>
      </div>
    </>}
  </div>;
}
