// TEACH-ENTRY 1.0.23 D6: Settings → Skills → Taught by you. Every recording, who can use it, and the
// same two-choice control as the recorder to change it. No recordings, or a server without the route
// (Cloud, an older app), renders nothing: no empty heading, no error.
import { useEffect, useState } from "react";
import { listTaughtSkills, setTaughtSkillBots, type TaughtSkill } from "@/lib/skills-api";

type Bots = ReadonlyArray<{ id: string; name: string }>;

export function taughtScopeWords(skill: TaughtSkill): string {
  if (!skill.bots) return "All your bots";
  if (!skill.botNames?.length) return "No bot can use it: its bot was deleted";
  return skill.botNames.length === 1 ? `Only ${skill.botNames[0]}` : skill.botNames.join(", ");
}

function TaughtRow({ skill, bots, onSaved }: { skill: TaughtSkill; bots: Bots; onSaved: (next: TaughtSkill[], widened: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const saved = skill.bots ? "only" : "all";
  const [scope, setScope] = useState<"only" | "all">(saved);
  const [botId, setBotId] = useState(skill.bots?.find((id) => bots.some((bot) => bot.id === id)) ?? bots[0]?.id ?? "");
  const [error, setError] = useState("");
  const changed = scope !== saved || (scope === "only" && !(skill.bots?.length === 1 && skill.bots[0] === botId));
  const deleted = Boolean(skill.bots && !skill.botNames?.length);
  if (skill.damaged) {
    return <li className="rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink"><div className="font-medium">{skill.id}</div><div className="text-warning">This skill's file is damaged</div></li>;
  }
  const save = async () => {
    setError("");
    try {
      const next = await setTaughtSkillBots(skill.id, scope === "all" ? null : [botId]);
      onSaved(next.skills, scope === "all" || !skill.bots?.includes(botId));
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save who can use this skill. Nothing changed.");
    }
  };
  return (
    <li className="rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left">
        <span className="min-w-0"><span className="block font-medium">{skill.name}</span><span className="block truncate text-ink-secondary">{skill.description}</span></span>
        <span className={deleted ? "shrink-0 text-warning" : "shrink-0 text-ink-secondary"}>{taughtScopeWords(skill)}</span>
      </button>
      {open && (
        <fieldset className="mt-2">
          <legend className="text-[11px] font-medium text-ink-secondary">Who can use it</legend>
          <label className="mt-1 flex items-center gap-2"><input type="radio" name={`taught-${skill.id}`} value="only" checked={scope === "only"} disabled={!bots.length} onChange={() => setScope("only")} /> Only
            <select aria-label={`Which bot can use ${skill.name}`} value={botId} onChange={(event) => { setBotId(event.target.value); setScope("only"); }} className="rounded-lg border border-hairline bg-card px-2 py-1">
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
          <label className="mt-1 flex items-center gap-2"><input type="radio" name={`taught-${skill.id}`} value="all" checked={scope === "all"} onChange={() => setScope("all")} /> All my bots</label>
          <button type="button" disabled={!changed} onClick={() => void save()} className="mt-2 rounded-lg bg-control px-3 py-1.5 text-[12px] disabled:opacity-40">Save</button>
          {error && <div role="alert" className="mt-1 text-danger">{error}</div>}
        </fieldset>
      )}
    </li>
  );
}

export function TaughtByYou({ bots }: { bots: Bots }) {
  const [skills, setSkills] = useState<TaughtSkill[] | null>(null);
  const [widened, setWidened] = useState(false);
  useEffect(() => {
    let live = true;
    listTaughtSkills().then((answer) => { if (live) setSkills(Array.isArray(answer?.skills) ? answer.skills : []); }, () => { if (live) setSkills([]); });
    return () => { live = false; };
  }, []);
  if (!skills?.length) return null;
  return (
    <section aria-labelledby="taught-by-you-title" className="mt-4">
      <h3 id="taught-by-you-title" className="text-[13px] font-medium text-ink">Taught by you</h3>
      {widened && <p className="mt-1 text-[12px] text-ink-secondary">Chats already open pick it up in a new chat.</p>}
      <ul className="mt-2 space-y-2">
        {skills.map((skill) => <TaughtRow key={skill.id} skill={skill} bots={bots} onSaved={(next, wider) => { setSkills(next); if (wider) setWidened(true); }} />)}
      </ul>
    </section>
  );
}
