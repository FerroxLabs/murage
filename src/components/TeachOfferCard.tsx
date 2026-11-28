// TEACH-ENTRY 1.0.23 D9.4: the inline "Teach {bot} a skill" card a direct chat shows after a bare
// teach offer or /teach. Local to this send: not stored, not sent to the model, not on other devices.
// Start is a click handler only (no timer, no auto-focus, no shortcut): nothing records without it.
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { TEACH_TASK_MAX } from "../../shared/teach-intent";

export type TeachCardPhase = "open" | "opened" | "dismissed";

export function TeachOfferCard({ botName, task, phase, describeOn, onStart, onNotNow, onDescribe }: {
  botName: string;
  task: string;
  phase: TeachCardPhase;
  /** /learn is on, so "Describe it in words instead" can work. */
  describeOn: boolean;
  onStart: (task: string) => void;
  onNotNow: () => void;
  onDescribe: (task: string) => void;
}) {
  const [value, setValue] = useState(task);
  if (phase === "dismissed") {
    return <div data-teach-card="dismissed" className="max-w-[620px] rounded-2xl bg-card px-4 py-2.5 text-[13px] text-ink-secondary">Not now. Type /teach any time.</div>;
  }
  const opened = phase === "opened";
  return (
    <section data-teach-card={phase} aria-label={`Teach ${botName} a skill`} className="max-w-[620px] rounded-2xl border border-hairline bg-card px-4 py-3 text-ink">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Sparkles size={15} aria-hidden="true" /> Teach {botName} a skill</div>
      <p className="mt-1 text-[13px] text-ink-secondary">Show {botName} the task once on your screen. Nothing is recorded until you press Start.</p>
      <label className="mt-3 block text-[11px] font-medium text-ink-secondary" htmlFor={`teach-task-${botName}`}>Task</label>
      <input id={`teach-task-${botName}`} value={value} maxLength={TEACH_TASK_MAX} disabled={opened} onChange={(event) => setValue(event.target.value)} className="mt-1 w-full rounded-xl border border-hairline bg-inset px-3 py-2 text-[13px] outline-none focus:border-accent" />
      {opened ? (
        <p className="mt-3 text-[12.5px] text-ink-secondary">Recorder opened</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onStart(value.trim())} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-semibold text-white">Start</button>
          <button type="button" onClick={onNotNow} className="rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">Not now</button>
          {describeOn && <button type="button" onClick={() => onDescribe(value.trim())} className="ml-auto text-[12px] text-ink-secondary underline hover:text-ink">Describe it in words instead</button>}
        </div>
      )}
    </section>
  );
}
