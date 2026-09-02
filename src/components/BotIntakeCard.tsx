import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";

import { api, useStore, type Bot, type BotAnnouncement } from "@/state/store";
import { cn } from "@/lib/cn";
import { needsSetup, setSkillCount, useSkillCount } from "@/lib/bot-skill-count";
import {
  addSkillsLabel,
  applyProfileDetail,
  applyProfileLabel,
  applyProfileToBot,
  assignSkillsToBot,
  intakeQuery,
  suggestForAnswer,
  type IntakeSuggestion,
} from "@/lib/onboarding-intake";

/** The dismissal is per bot and per machine — a preference, not a fact about
 *  the bot, so it does not belong on the server. A browser that refuses
 *  storage simply shows the question again, which is the safe direction. */
const DISMISSED_KEY = "murage.intake.dismissed";

function readDismissed(botId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY}.${botId}`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(botId: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(`${DISMISSED_KEY}.${botId}`, "1");
    else window.localStorage.removeItem(`${DISMISSED_KEY}.${botId}`);
  } catch {
    // storage is a convenience here; the card still works without it
  }
}

const FIELD =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
const PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-60";
const QUIET =
  "-mx-1 rounded-md px-1.5 py-1 text-[13px] text-ink-secondary underline decoration-hairline underline-offset-2 hover:bg-control hover:text-ink";

/** The first thing a new bot should do: ask what it is for.
 *
 *  "New Bot" makes a blank agent — no profile, no skills, no question. This is
 *  the question, and one press of the button it produces configures THE BOT
 *  YOU ARE IN. It never creates a second bot: an orphan blank agent left in
 *  the sidebar next to the one you thought you were setting up is the exact
 *  failure this replaces.
 *
 *  It shows itself only while the agent has no skills, and it stays reachable
 *  after it is dismissed — the previous setup question was a one-way door
 *  with nothing anywhere in the app to reopen it. */
export function BotIntakeCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  // Shared with the transcript, which uses the same answer to retire the old
  // seeded four-option quiz rather than ask the same question twice.
  const skillCount = useSkillCount(bot.id, api);
  const [collapsed, setCollapsed] = useState(() => readDismissed(bot.id));
  const [answer, setAnswer] = useState("");
  const [suggestion, setSuggestion] = useState<IntakeSuggestion | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"" | "searching" | "applying">("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A late answer for the bot you left must never land in the card for the
  // bot you are on.
  const request = useRef(0);

  useEffect(() => {
    setCollapsed(readDismissed(bot.id));
    setAnswer("");
    setSuggestion(null);
    setChosen(new Set());
    setBusy("");
    setError("");
  }, [bot.id]);

  const ask = async () => {
    const query = intakeQuery(answer);
    if (!query || busy) return;
    setBusy("searching");
    setError("");
    const token = ++request.current;
    try {
      const result = await suggestForAnswer(query, api);
      if (token !== request.current) return;
      setSuggestion(result);
      setChosen(new Set(result.skills.map((skill) => skill.id)));
    } catch (cause) {
      if (token !== request.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === request.current) setBusy("");
    }
  };

  /** The agent is configured. Publish the new count rather than invalidating
   *  it: an invalidation would read `null` for one frame, and `null` means
   *  "not known", which would flash the old seeded quiz back onto the screen
   *  between this frame and the refetch. The card only ever renders at zero,
   *  so what just installed IS the whole count.
   *
   *  No dismissal is written. This card is going away because the work is
   *  done, not because the person waved it off — and if every skill is later
   *  removed, the question should come back on its own. */
  const finish = (installed: number) => {
    setSuggestion(null);
    setAnswer("");
    setSkillCount(bot.id, Math.max(installed, 1));
  };

  const applyProfile = async () => {
    const profile = suggestion?.profile;
    if (!profile || busy) return;
    setBusy("applying");
    setError("");
    try {
      const applied = await applyProfileToBot(bot.id, profile.slug, api);
      // Straight into the sidebar and the chat header, without waiting for the
      // broadcast to come back around.
      dispatch({ type: "botPatched", bot: applied.bot as BotAnnouncement });
      finish(applied.installed.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const applySkills = async () => {
    if (chosen.size === 0 || busy) return;
    setBusy("applying");
    setError("");
    try {
      const added = await assignSkillsToBot(bot.id, [...chosen], api);
      finish(added.installed.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  // Still counting, unreadable, or already configured — nothing to offer.
  if (!needsSetup(skillCount)) return null;

  if (collapsed) {
    return (
      <div className="mx-auto w-full max-w-[840px] px-4 pb-1">
        <button
          type="button"
          onClick={() => {
            setCollapsed(false);
            writeDismissed(bot.id, false);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          <Sparkles size={13} />
          Set {bot.name} up
        </button>
      </div>
    );
  }

  const profile = suggestion?.profile ?? null;
  const looseSkills = suggestion?.skills ?? [];

  return (
    <div className="mx-auto w-full max-w-[840px] px-4 pb-2">
      <div className="rounded-2xl border border-hairline/50 bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-ink">What do you mostly want help with?</div>
            <div className="mt-0.5 text-[14px] text-ink-secondary">
              Say it in your own words and {bot.name} will set itself up for it.
            </div>
          </div>
          <button
            type="button"
            aria-label="Hide this question"
            title="Hide this question — you can bring it back"
            onClick={() => {
              setCollapsed(true);
              writeDismissed(bot.id, true);
            }}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            ref={inputRef}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void ask();
              }
            }}
            placeholder="Reading my trading charts, say"
            aria-label="What do you mostly want help with?"
            className={FIELD}
          />
          <button
            type="button"
            onClick={() => void ask()}
            disabled={!intakeQuery(answer) || busy !== ""}
            className={PRIMARY}
          >
            {busy === "searching" ? "Looking…" : "Find it"}
          </button>
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            {error}
          </div>
        )}

        {/* A matched profile is the whole answer: a specialist description AND
            the skills it was built with, in one press. */}
        {profile && (
          <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-3.5">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold text-ink">{profile.name}</span>
              <span className="text-[12px] text-ink-secondary">{profile.category}</span>
            </div>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">{profile.summary}</p>
            {profile.outcome && (
              <p className="mt-1.5 text-[12.5px] text-ink-secondary">What you get: {profile.outcome}</p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {profile.skills.map((skill) => (
                <span
                  key={skill.id}
                  title={skill.description}
                  className="rounded-md border border-hairline/50 bg-control px-2 py-1 text-[11.5px] text-ink-secondary"
                >
                  {skill.name}
                </span>
              ))}
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void applyProfile()} disabled={busy !== ""} className={PRIMARY}>
                {busy === "applying" ? "Setting up…" : applyProfileLabel(bot.name, profile.name)}
              </button>
              <button type="button" onClick={() => setSuggestion(null)} className={QUIET}>
                Ask something else
              </button>
            </div>
            <div className="mt-2 text-[12px] text-ink-secondary">
              {applyProfileDetail(profile, bot.name, true)} Nothing else in your workspace changes — no new agent
              is created.
            </div>
          </div>
        )}

        {/* No profile fits, so assemble one out of loose skills instead. */}
        {suggestion && !profile && looseSkills.length > 0 && (
          <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-3.5">
            <div className="text-[13.5px] text-ink">
              No ready-made assistant covers that, so here is what {bot.name} can learn instead.
            </div>
            <div className="mt-2.5 divide-y divide-hairline/35">
              {looseSkills.map((skill) => {
                const picked = chosen.has(skill.id);
                return (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer items-start gap-3 py-2.5"
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() =>
                        setChosen((current) => {
                          const next = new Set(current);
                          if (next.has(skill.id)) next.delete(skill.id);
                          else next.add(skill.id);
                          return next;
                        })
                      }
                      className="mt-0.5 size-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-medium text-ink">{skill.name}</span>
                      <span className="mt-0.5 block line-clamp-2 text-[12.5px] text-ink-secondary">
                        {skill.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void applySkills()}
                disabled={chosen.size === 0 || busy !== ""}
                className={cn(PRIMARY)}
              >
                {busy === "applying" ? "Adding…" : addSkillsLabel(bot.name, chosen.size)}
              </button>
              <button type="button" onClick={() => setSuggestion(null)} className={QUIET}>
                Ask something else
              </button>
            </div>
          </div>
        )}

        {suggestion && !profile && looseSkills.length === 0 && (
          <div className="mt-4 rounded-xl border border-hairline/40 bg-inset px-3.5 py-3 text-[13.5px] text-ink-secondary">
            Nothing in the library matched that. Try naming the work itself — "reading my trading charts",
            "chasing invoices", "writing blog posts".
          </div>
        )}
      </div>
    </div>
  );
}
