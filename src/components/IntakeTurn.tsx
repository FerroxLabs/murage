import { useState } from "react";

import { api, useStore, type Bot, type BotAnnouncement, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { setSkillCount } from "@/lib/bot-skill-count";
import { useDesktopSurface } from "@/lib/use-surface";
import {
  closeIntakeCard,
  confirmIntakeProfile,
  intakeChipAction,
  readIntakeCard,
  replyToIntake,
} from "@/lib/onboarding-intake";

/** ONE TURN OF THE SETUP CONVERSATION, rendered as the bot talking.
 *
 *  The thing it replaces was a panel docked above the composer with a title,
 *  a text box and a "Find it" button beside it. The verdict on it was that a
 *  new agent should have a conversation with you, not hand you an options box
 *  at the bottom of the screen. So this is a bubble in the transcript, in the
 *  same treatment every other thing the bot says gets, and the chips under it
 *  are shortcuts rather than the interface.
 *
 *  THREE THINGS IT DELIBERATELY DOES NOT HAVE:
 *
 *  No text input. Not because typing is discouraged, but the opposite: the
 *  composer is already on screen and is the free-text answer to every turn.
 *  A second box inside the bubble would be a form in a chat window and would
 *  put two inputs on one screen for one question. The chips never become the
 *  only way to answer, which is the failure mode the field literature names
 *  (a person answering "townhome" to a house/apartment chip pair and being
 *  told the bot is having trouble understanding).
 *
 *  No dismiss control. There is nothing to dismiss. Typing something else
 *  ends the conversation, and the server settles it as general chat, which is
 *  a real outcome rather than an escape.
 *
 *  No height bound of its own. The card this replaces measured 1,379px on a
 *  937px screen and pushed its own question and its own close button off the
 *  top, because it was pinned above the composer and grew downward from a
 *  fixed edge. A transcript row cannot do that: it scrolls with everything
 *  else the bot has said.
 *
 *  EVERY SENTENCE ON SCREEN COMES OFF THE CARD. Titles, subtitles, chip
 *  labels and the closing line are all written by the server, which is what
 *  keeps the bot's voice in one place and lets it change without a release of
 *  this file. */

/** Same treatment as a bot bubble in ChatView. Not a bordered panel: this is
 *  the bot talking. */
const BUBBLE =
  "w-fit max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink";

/** Quiet inline chips. Not a lettered A/B/C/D list in a bordered box: that
 *  shape is the four-button quiz this conversation replaced, and a person
 *  reads a row of four boxed options as a form to fill in. */
const CHIP =
  "rounded-full border border-hairline/50 bg-control px-3 py-1.5 text-[13.5px] text-ink hover:bg-raised-hover disabled:opacity-60";

/** What a phone is told instead of a button that would 404. Installing a
 *  skill is a desktop-only write, and saying so before the press is the only
 *  version of that policy a person can act on. */
const DESKTOP_ONLY = "Add this on your desktop";

export function IntakeTurn({ bot, message }: { bot: Bot; message: Message }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState("");

  const card = message.card;
  const intake = readIntakeCard(card);
  if (!card || !intake) return null;

  const answered = Boolean(card.answered);
  const confirming = intake.step === "confirm";
  /** The apply chip, and only that one, crosses the desktop boundary. */
  const applySlug = confirming && intake.outcome === "profile" ? (intake.candidate?.slug ?? "") : "";

  const report = (cause: unknown) => setFailure(cause instanceof Error ? cause.message : String(cause));

  const applyProfile = async (slug: string) => {
    if (busy || !slug || desktop !== true) return;
    setBusy(true);
    setFailure("");
    setErrors([]);
    try {
      const applied = await confirmIntakeProfile(bot.id, message.id, slug, {
        request: api,
        // Straight into the sidebar and the chat header, without waiting for
        // the broadcast to come back around. The question asked for something,
        // so the answer has to change something visible.
        announceBot: (next) => dispatch({ type: "botPatched", bot: next as BotAnnouncement }),
        publishSkillCount: setSkillCount,
      });
      setErrors(applied.errors);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const close = async (outcome: "general" | "library") => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await closeIntakeCard(bot.id, message.id, outcome, api);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const reply = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await replyToIntake(bot.id, message.id, text, api);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  /** What the press means is decided in `intakeChipAction`, where it is a
   *  pure function a test can execute. This is the part that has to touch
   *  React: the library outcome also opens the library, because "show me the
   *  library" that does not is an answer with nothing behind it. */
  const press = (index: number) => {
    if (busy || answered) return;
    const action = intakeChipAction(intake, card.options, index);
    if (!action) return;
    if (action.kind === "apply") {
      void applyProfile(action.slug);
      return;
    }
    if (action.kind === "reply") {
      void reply(action.text);
      return;
    }
    if (action.outcome === "library") dispatch({ type: "showTeamLibrary", botId: bot.id, view: "skills" });
    void close(action.outcome);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <div className={BUBBLE}>
        <div>{card.title}</div>
        {card.subtitle && <div className="mt-1 text-[13.5px] text-ink-secondary">{card.subtitle}</div>}
      </div>

      {/* An answered question is history. It keeps its words and loses its
          controls: the person's own answer is the very next bubble, so a
          "you picked X" state would say the same thing twice, and a row of
          disabled buttons would say it in grey. */}
      {!answered && card.options.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {card.options.map((option, index) =>
            index === 0 && applySlug && desktop === false ? (
              <span
                key={option}
                className="rounded-full border border-hairline/40 bg-control px-3 py-1.5 text-[13.5px] text-ink-secondary"
              >
                {DESKTOP_ONLY}
              </span>
            ) : (
              <button
                key={option}
                type="button"
                onClick={() => press(index)}
                disabled={busy || (index === 0 && applySlug !== "" && desktop !== true)}
                className={cn(CHIP)}
              >
                {option}
              </button>
            ),
          )}
        </div>
      )}

      {failure && (
        <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {failure}
        </div>
      )}

      {/* The profile applied and some of its skills did not. The conversation
          still ends, because it did what it said it would; the parts that
          failed are named rather than swallowed. */}
      {errors.length > 0 && (
        <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {errors.join(" ")}
        </div>
      )}
    </div>
  );
}
