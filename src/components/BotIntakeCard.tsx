import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Sparkles, X } from "lucide-react";

import { api, useStore, type Bot, type BotAnnouncement } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  invalidateSkillCount,
  setSkillCount,
  setupOverwriteReasons,
  setupWouldOverwrite,
  useSkillCount,
} from "@/lib/bot-skill-count";
// The shared hook, not a local copy. This file had its own four-line version
// that asked the harness and stopped there — no check of the Electron preload
// bridge. On the desktop, served as a production bundle by a harness that did
// not fork Electron, `/api/config` answers "remote", so the card decided the
// desktop was a phone and rendered "Add this on your desktop" as dead text
// next to a button the person at the keyboard could not press.
//
// That is the same defect d2c984fd fixed in `resolveDesktopSurface`, surviving
// in a second copy the fix could not reach. One answer, one place.
import { useDesktopSurface } from "@/lib/use-surface";
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

/** THE CARD NEVER EXCEEDS THE VIEWPORT.
 *
 *  Measured, before this bound existed: typing "hi" produced a 1,379px card on
 *  a 937px screen, with the question and the dismiss button pushed off the top
 *  and no scrollbar anywhere — the person could neither read what they were
 *  agreeing to nor close it.
 *
 *  `--vvh` is the VISUAL viewport height, published on <html> by
 *  `trackVisualViewport`. It is the right number rather than `100vh` because
 *  it shrinks when the iOS keyboard opens, which is exactly when this card is
 *  on screen with a focused input above it — and `100vh` does not. The `var()`
 *  fallback covers the browsers with no visualViewport at all.
 *
 *  52% leaves the composer and a readable slice of transcript below it. The
 *  absolute cap stops the card growing into a wall on a tall monitor, where a
 *  percentage alone would hand three checkboxes 700px of card. */
const CARD_MAX_HEIGHT = "min(560px, calc(var(--vvh, 100vh) * 0.52))";

const FIELD =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
const PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-60";
const QUIET =
  "-mx-1 rounded-md px-1.5 py-1 text-[13px] text-ink-secondary underline decoration-hairline underline-offset-2 hover:bg-control hover:text-ink";

/** What a phone is told instead of a button that would 404.
 *
 *  Installing a skill is a desktop-only write — the apply routes require the
 *  desktop marker and the browser door strips it. Before this, both buttons
 *  rendered normally on a paired phone, fired, failed, and printed the raw
 *  server error into the card. "Installs are a keyboard decision" is only a
 *  policy if the UI says so before the press, not after. */
const DESKTOP_ONLY = "Add this on your desktop";

/** THE QUESTION ITSELF, with no opinion about where it is allowed to appear.
 *
 *  One press of the button it produces configures THE BOT YOU ARE IN. It never
 *  creates a second bot: an orphan blank agent left in the sidebar next to the
 *  one you thought you were setting up is the exact failure this replaces.
 *
 *  ONE caller now. It used to have two: this and a copy docked above the
 *  composer for any agent that looked new. That one is gone, because a new
 *  agent asks in the transcript instead, in its own voice (`IntakeTurn`).
 *  What survives is the deliberate door: `BotSetupAction` puts this on any
 *  agent's own profile, behind a button and, when there is something to lose,
 *  behind a warning.
 *
 *  Keeping it is not a leftover. It is the parallel surface that makes the
 *  conversation safe to walk away from: every answer the conversation could
 *  have collected is reachable here on purpose, so abandoning a setup chat
 *  costs nothing and nothing has to nag to finish. */
function IntakeQuestion({
  bot,
  onDismiss,
  autoFocus = false,
}: {
  bot: Bot;
  onDismiss: () => void;
  autoFocus?: boolean;
}) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [answer, setAnswer] = useState("");
  const [suggestion, setSuggestion] = useState<IntakeSuggestion | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [keepName, setKeepName] = useState(true);
  const [busy, setBusy] = useState<"" | "searching" | "applying">("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A late answer for the bot you left must never land in the card for the
  // bot you are on.
  const request = useRef(0);

  useEffect(() => {
    setAnswer("");
    setSuggestion(null);
    setChosen(new Set());
    setKeepName(true);
    setBusy("");
    setError("");
  }, [bot.id]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, bot.id]);

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
      // NOTHING IS PRE-TICKED. The button says how many skills are about to be
      // installed and into which agent, and it must never say a number the
      // person did not choose. Pre-ticking eight search results turned "Find
      // it" into a one-press install of whatever bm25 happened to rank.
      setChosen(new Set());
      setKeepName(true);
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
    if (!profile || busy || desktop !== true) return;
    setBusy("applying");
    setError("");
    try {
      const applied = await applyProfileToBot(bot.id, profile.slug, api, { rename: !keepName });
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
    if (chosen.size === 0 || busy || desktop !== true) return;
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

  /** The one action on the empty state, and the one action under a phone's
   *  disabled buttons: the library, already on Skills, already knowing which
   *  agent this is about. A dead end with an apology in it is not an answer. */
  const browseLibrary = () => {
    dispatch({ type: "showTeamLibrary", botId: bot.id, view: "skills" });
  };

  const profile = suggestion?.profile ?? null;
  const looseSkills = suggestion?.skills ?? [];
  const renames = Boolean(profile && profile.name !== bot.name);

  return (
    <div className="mx-auto flex w-full min-h-0 max-w-[840px] flex-col px-4 pb-2">
      <div
        data-testid="bot-intake-card"
        className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card"
        style={{ maxHeight: CARD_MAX_HEIGHT }}
      >
        {/* The question and the way out never scroll away. They sit OUTSIDE
            the scroller rather than `position: sticky` inside it, which is
            the only version that cannot be defeated by a long result list. */}
        <div className="shrink-0 p-4 pb-0">
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
              onClick={onDismiss}
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
        </div>

        {/* Everything a search produced scrolls HERE, inside the bound. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {error && (
            <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
              {error}
            </div>
          )}

          {/* A matched profile is the whole answer: a specialist description AND
              the skills it was built with, in one press. */}
          {profile && (
            <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-3.5">
              {/* The front door is labelled as one. Offering Concierge as
                  though the catalogue had matched it would be exactly the
                  confident wrong answer that returning null exists to
                  prevent — and the person can tell the difference, so the
                  card should too. */}
              {profile.fallback && (
                <p className="mb-2 text-[12.5px] text-ink-secondary">
                  Nothing in the library matches that exactly. This one works out what you need and hands it on:
                </p>
              )}
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
              {/* KEEP THE NAME, by default. The agent in front of you already
                  has a name a person can see in the sidebar and may well have
                  chosen — the live workspace has one hand-named "Bruce (Smart
                  Trader)". A rename nobody asked for is the one surprise this
                  flow could spring, so the safe answer is pre-selected and the
                  other one has to be chosen on purpose. */}
              {renames && (
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={keepName}
                    onChange={() => setKeepName((current) => !current)}
                    className="size-4 shrink-0"
                  />
                  Keep the name {bot.name}
                </label>
              )}
              <div className="mt-3.5 flex flex-wrap items-center gap-3">
                {desktop === false ? (
                  <span className="rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink-secondary">
                    {DESKTOP_ONLY}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void applyProfile()}
                    disabled={busy !== "" || desktop !== true}
                    className={PRIMARY}
                  >
                    {busy === "applying" ? "Setting up…" : applyProfileLabel(bot.name, profile.name)}
                  </button>
                )}
                <button type="button" onClick={() => setSuggestion(null)} className={QUIET}>
                  Ask something else
                </button>
              </div>
              <div className="mt-2 text-[12px] text-ink-secondary">
                {applyProfileDetail(profile, bot.name, !keepName)} Nothing else in your workspace changes —{" "}
                no new agent is created.
              </div>
            </div>
          )}

          {/* No profile fits, so assemble one out of loose skills instead. At
              most three, and NOT ONE OF THEM PRE-TICKED. */}
          {suggestion && !profile && looseSkills.length > 0 && (
            <div className="mt-4 rounded-xl border border-hairline/40 bg-inset p-3.5">
              <div className="text-[13.5px] text-ink">
                No ready-made assistant covers that, so here is what {bot.name} can learn instead.
              </div>
              <div className="mt-2.5 divide-y divide-hairline/35">
                {looseSkills.map((skill) => {
                  const picked = chosen.has(skill.id);
                  return (
                    <label key={skill.id} className="flex cursor-pointer items-start gap-3 py-2.5">
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
                {desktop === false ? (
                  <span className="rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink-secondary">
                    {DESKTOP_ONLY}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void applySkills()}
                    // The count is what is TICKED, never what was returned.
                    disabled={chosen.size === 0 || busy !== "" || desktop !== true}
                    className={cn(PRIMARY)}
                  >
                    {busy === "applying" ? "Adding…" : addSkillsLabel(bot.name, chosen.size)}
                  </button>
                )}
                <button type="button" onClick={() => setSuggestion(null)} className={QUIET}>
                  Ask something else
                </button>
              </div>
            </div>
          )}

          {/* ZERO CLEAR MATCHES IS AN ANSWER, and it gets exactly one way out.
              Before this, an answer with no topic words in it fell through to
              an ungated search and came back with eight strangers, every one
              pre-ticked. Saying "nothing matched" and pointing at the library
              is the honest version. */}
          {suggestion && !profile && looseSkills.length === 0 && (
            <div className="mt-4 rounded-xl border border-hairline/40 bg-inset px-3.5 py-3">
              <div className="text-[13.5px] text-ink-secondary">
                Nothing in the library clearly matches that. Try naming the work itself — "reading my trading
                charts", "chasing invoices", "writing blog posts".
              </div>
              <button
                type="button"
                onClick={browseLibrary}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised"
              >
                <BookOpen size={14} />
                Browse the library
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** SETUP, WHERE YOU GO AND ASK FOR IT: the bot's own profile, beside the role
 *  control, which is already where a person goes to change what a bot IS.
 *
 *  Always available — an agent with no skills and no way anywhere in the app to
 *  ask for some is the one-way door this whole feature exists to remove, and
 *  removing the composer chip is only safe because this is here.
 *
 *  And because it is always available, it has to be honest about what it would
 *  do. On an established agent it names what it would touch — the skills it
 *  already has, its title, its description, the length of the conversation
 *  behind it — and waits. Setup stops being something that ambushes a bot and
 *  becomes something you deliberately ask for, having read what it costs. */
export function BotSetupAction({ bot }: { bot: Bot }) {
  const skillCount = useSkillCount(bot.id, api);
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    setOpen(false);
    setAcknowledged(false);
  }, [bot.id]);

  const warns = setupWouldOverwrite(skillCount, bot);
  const reasons = setupOverwriteReasons(skillCount, bot);
  const checking = skillCount === null;
  const unavailable = skillCount === -1;

  if (!open) {
    return (
      <div className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-ink">Set up this bot</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {checking ? `Checking what ${bot.name} already has…` : unavailable ? `Could not read ${bot.name}'s skills. Retry the check before starting setup.` : warns
                ? `Say what you want ${bot.name} for and pick a specialist profile or skills to match. ${bot.name} is already set up, so this will say what it would change first.`
                : `Say what you want ${bot.name} for and pick a specialist profile or skills to match.`}
            </div>
          </div>
          <button
            type="button"
            disabled={checking}
            onClick={() => {
              if (checking) return;
              if (unavailable) {
                invalidateSkillCount(bot.id);
                return;
              }
              setOpen(true);
              setAcknowledged(!warns);
            }}
            className="shrink-0 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:cursor-wait disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={14} />
              {checking ? "Checking setup…" : unavailable ? "Retry skill check" : "Set up"}
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (!acknowledged) {
    return (
      <div className="rounded-xl border border-warning/40 bg-card p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-ink">{reasons.length > 0 ? `${bot.name} is already set up` : "Review the current setup"}</div>
            <div className="mt-1 text-[13px] text-ink-secondary">
              {reasons.length > 0
                ? `Running setup can add skills and change what ${bot.name} is for. This agent already has ${listPhrase(reasons)}.`
                : `Running setup can add skills and change what ${bot.name} is for, and this build could not read what ${bot.name} already has.`}
            </div>
            <div className="mt-1.5 text-[13px] text-ink-secondary">
              Nothing changes until you press the button on the suggestion, and {bot.name} keeps this name unless you
              clear the checkbox there. Existing skills are not removed.
            </div>
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setAcknowledged(true)}
            className="rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white hover:brightness-110"
          >
            Continue anyway
          </button>
          <button type="button" onClick={() => setOpen(false)} className={QUIET}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return <IntakeQuestion bot={bot} autoFocus onDismiss={() => setOpen(false)} />;
}

/** "3 skills it already has, its title and a conversation 12 turns long". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
