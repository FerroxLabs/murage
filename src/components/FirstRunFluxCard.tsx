// STEP THREE: the key, and the screen the company makes its money on.
//
// It gets the most care of anything in this flow, and it gets two openings.
// On a machine where detection ran it is an offer. On a machine with nothing
// to think with, step two was SKIPPED, so this screen owes the person the
// report as well: what was looked for, what was not found, and then the one
// connection that fixes it.
//
// SIX ROWS, IN THE ORDER THEY WERE ARGUED IN: routing first, because that is
// what the key IS; then the apps it opens; then the models, pictures, and
// talking instead of typing. The sixth is Voice mode and it is marked "Coming
// soon", which is the only way a row on this card is allowed to mention
// speaking out loud. Selling speech on this key is a false claim that has
// shipped once and was then enforced by a test.
//
// NO PRICE, NO FIGURE, NO PLAN COMPARISON ANYWHERE ON THIS SCREEN. A ruling,
// and there is an assertion on the rendered markup as well as on the copy,
// because a number that arrived through a component would sail past a gate
// that only walks FIRST_RUN_COPY.
//
// The paste field saves through `saveAndProveFluxKey`, which is the Settings
// card's own road into the operating system's keychain and then the Settings
// card's own live check on top of it. The key is never put in a message,
// never sent to a model, and never re-displayed.
//
// THE CONFIRMATION IS EARNED OR IT IS NOT SAID. This card used to check the
// SHAPE of the key, write it, and answer the step, at which point the Chief
// said "That is saved, and locked away on this computer" in his own voice
// over a key nobody had tried. Now the answer carries which of three things
// happened, and a key Flux Router refused answers nothing at all.

import { useState } from "react";

import { FIRST_RUN_COPY, foundNothingLine, type FirstRunFluxFeature } from "@/lib/first-run-copy";
import {
  FLUX_KEY_NOT_A_KEY,
  FLUX_KEY_REJECTED,
  fluxBridge,
  readFluxStatus,
  saveAndProveFluxKey,
} from "@/lib/flux-key-paste";
import { SETUP_FLUX_PROVED_ANSWER, SETUP_FLUX_UNPROVED_ANSWER } from "../../shared/first-run-chief";
import { useDesktopSurface } from "@/lib/use-surface";
import { api, useStore } from "@/state/store";
import { FLUX_SIGNUP_URL } from "./FluxRouterConnection";
import {
  FIRST_RUN_FOCUS,
  FIRST_RUN_INPUT,
  FIRST_RUN_PRIMARY,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  answerSetupStep,
  failureText,
  openOutside,
  skipSetupStep,
  useSetupView,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.flux.key;

/**
 * Which of the two true sentences this person should read.
 *
 * `view.agents` is everything this machine can actually think with right now,
 * and it is empty exactly when nothing can. Murage ships the engine, not the
 * brain, so on a clean machine the key is the thing standing between them and
 * an assistant, and on a machine that already had Claude Code or Codex it is
 * a genuine extra. Telling the second person they need it would be false.
 *
 * Unknown view answers the cautious one: the milder claim is the one that is
 * never wrong.
 */
export function fluxRecommendation(view: { agents?: readonly unknown[] } | null | undefined): string {
  if (!view?.agents) return copy.recommendation;
  return view.agents.length === 0 ? copy.recommendationBare : copy.recommendationBonus;
}

/**
 * ONE ROW OF THE CARD.
 *
 * A row that is not live carries the pill and a dashed tick, and it is the
 * only kind of row allowed to describe speaking out loud. That pairing is not
 * decoration: the copy test lets a row mention speech ONLY when it declares
 * `coming-soon` or `transcription`, so the marker that buys the exemption is
 * the same marker the person reads. A row cannot quietly become a promise.
 */
function FirstRunFluxRow({ row }: { row: FirstRunFluxFeature }) {
  const soon = row.state === "coming-soon";
  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <span aria-hidden="true" className={`mt-0.5 shrink-0 ${soon ? "text-ink-secondary opacity-60" : "text-success"}`}>
        {soon ? "◌" : "✓"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-[14px] font-medium text-ink">{row.title}</span>
        {soon && (
          <span className="ml-2 rounded-full border border-hairline/50 px-2 py-0.5 text-[11.5px] text-ink-secondary">
            {copy.comingSoon}
          </span>
        )}
        <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-secondary">{row.body}</span>
      </span>
    </li>
  );
}

/**
 * THE SECOND SCREEN: their browser is open, and this takes what it gave them.
 *
 * Presentational and exported, which is what lets a test render it. It holds
 * no state of its own, so the key it shows is the key the card is holding, and
 * there is exactly one copy of it in the process rather than two that could
 * disagree about what was typed.
 *
 * `Cancel` saves nothing and therefore has nothing to undo. `Open the page
 * again` stays on this screen: somebody who closed the tab by accident wants
 * the tab back, not the offer back.
 */
export function FirstRunFluxConnect({
  value,
  busy,
  failure,
  onChange,
  onSubmit,
  onAgain,
  onCancel,
}: {
  value: string;
  busy: boolean;
  failure: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onAgain: () => void;
  onCancel: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.connectHeading}</div>
      <FirstRunLine>{copy.connectLead}</FirstRunLine>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-56">
          {/* The heading above has already said what this box is, so a second
              label would be the same sentence read twice. Hidden, not absent:
              a field with no accessible name is a field nobody can find. */}
          <span className="sr-only">{copy.fieldLabel}</span>
          <input
            aria-label={copy.fieldLabel}
            type="password"
            name="flux-router-key"
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            placeholder={copy.placeholder}
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }}
            className={`${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
          />
        </label>
        <button type="button" disabled={busy || !value.trim()} onClick={onSubmit} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
          {busy ? copy.working : copy.connectSubmit}
        </button>
      </div>
      <FirstRunLine quiet>{copy.connectCaveat}</FirstRunLine>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={onAgain} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {copy.connectAgain}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {copy.connectCancel}
        </button>
      </div>
      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

export function FirstRunFluxCard({ settled }: { settled: boolean }) {
  // Live, because what is true about this key depends on what else this
  // machine can think with, and that can change while the card is on screen.
  const { view } = useSetupView();
  const desktop = useDesktopSurface();
  const { refreshAfterKey } = useStore();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // THE OFFER AND THE PASTE BOX ARE TWO SCREENS, NOT ONE.
  //
  // They used to be one, with the field sitting under the copy and a separate
  // "I need a key" chip beside the button. That asks somebody who has never
  // heard of Flux Router to paste something they do not have, and puts the way
  // to GET one third in a row of three. The approved flow presses one button,
  // opens the sign-up page in their real browser, and then asks for the paste,
  // which is the order the thing actually happens in.
  const [pasting, setPasting] = useState(false);
  // A CARD SETTLES FROM THE SERVER, NOT ONLY FROM THIS COMPONENT.
  //
  // This was `useState(settled)`, which reads the prop ONCE. `settled` is set
  // by the server when the step lands, and that can happen after this card
  // first rendered: another surface answered it, the step completed on its
  // own, or the app reopened mid-flow. The card went on showing an open form
  // with live buttons for a question that was already answered, which is most
  // of why the thread read as a wall of unfinished business.
  //
  // Derived instead, so the two ways a card can be finished agree: this
  // component did it, or the server says so.
  const [acted, setActed] = useState(false);
  const done = acted || settled;

  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true);
    setFailure("");
    try {
      const status = await readFluxStatus(api);
      // SAVED, AND THEN ACTUALLY TRIED.
      //
      // A shape check is not a key check. `^sk-flux-…$` passes a revoked key,
      // somebody else's key and a key with one character wrong, and the
      // Chief used to confirm all three in his own voice; the person found
      // out on their first question with nothing joining the two. The proof
      // is one catalogue read on the key that was just stored, and it is
      // free: no model runs (src/lib/flux-key-paste.ts, `proveFluxKey`).
      const proof = await saveAndProveFluxKey(key, { status, bridge: fluxBridge(), request: api, desktop: desktop === true, refresh: refreshAfterKey });
      // Out of React's hands the moment it is stored. Nothing above keeps a
      // copy and nothing below renders one.
      setKey("");
      if (proof === "rejected") {
        // The step is NOT answered, so the Chief says nothing and the card
        // keeps the floor with its paste field open. "Not now" is still
        // there, one screen back, so nobody is stuck on a key they cannot
        // make work.
        setFailure(FLUX_KEY_REJECTED);
        return;
      }
      setActed(true);
      await answerSetupStep("flux", proof === "proved" ? SETUP_FLUX_PROVED_ANSWER : SETUP_FLUX_UNPROVED_ANSWER);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  const notNow = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await skipSetupStep("flux");
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  // TWO OPENINGS, ONE BODY.
  //
  // On a machine where detection ran, this is an offer. On a machine with
  // nothing to think with, step two was SKIPPED, so this screen owes the
  // person the report as well: what was looked for, what was not found, and
  // then the one connection that fixes it. `nothingToThinkWith` is computed
  // once on the server for exactly this reason, so four surfaces cannot each
  // re-derive it and one of them get it wrong.
  const noBrain = view?.nothingToThinkWith === true;
  // WHAT THERE IS TO CARRY ON WITH, WHICH IS NOT THE SAME QUESTION.
  //
  // THE DEFECT. The dismissal offered "Not yet, start me on the local model"
  // whenever `noBrain` was false, and `nothingToThinkWith` is FALSE on a
  // machine whose only engine is signed out. So the one audience the
  // `signed-out` variant exists for was offered a local model to start on
  // while `view.agents` was empty and there was none. `agents` is already
  // filtered by `runnable()`, so it is the reading that answers this: the
  // offer is made only where something can really take it, and anywhere else
  // the dismissal is the plain "Not now" that is true on every machine.
  const canCarryOn = (view?.agents.length ?? 0) > 0;

  if (pasting && !done) {
    return (
      <FirstRunFluxConnect
        value={key}
        busy={busy}
        failure={failure}
        onChange={(next) => {
          setKey(next);
          // Both of the failures that mean "that key was wrong" clear the
          // moment they start typing a different one. A refusal left on
          // screen over a fresh paste is the card arguing with them.
          if (failure === FLUX_KEY_NOT_A_KEY || failure === FLUX_KEY_REJECTED) setFailure("");
        }}
        onSubmit={() => void save()}
        onAgain={() => void openOutside(FLUX_SIGNUP_URL)}
        onCancel={() => setPasting(false)}
      />
    );
  }

  return (
    <FirstRunBubble>
      {/* NO EYEBROW HERE, and it is not an omission. The approved screen has
          "Flux Router" in a top bar AND again as an eyebrow, which is two
          separate elements on a full screen. In a thread the step separator
          above this card IS the top bar and already says it, so a second one
          would be the same two words twice in a row. On a blank machine the
          status line takes that slot: the report step two never got to make. */}
      {noBrain && <FirstRunLine quiet>{foundNothingLine(view?.ownerName ?? "")}</FirstRunLine>}
      <div className="text-[17px] font-semibold text-ink">{noBrain ? copy.headingBare : copy.heading}</div>
      <FirstRunLine>{noBrain ? copy.leadBare : copy.lead}</FirstRunLine>

      {/* THE CARD. No price, no figure, no plan comparison anywhere on it: a
          ruling, and also two assertions in first-run-copy.test.ts. Every row
          is something that stops working without the key. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-hairline/50 bg-inset">
        <div className="flex items-center justify-between gap-3 border-b border-hairline/40 px-3 py-2">
          <span className="text-[12.5px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{copy.cardTitle}</span>
          <span className="text-[12.5px] text-ink-secondary">{copy.cardAccount}</span>
        </div>
        <ul className="divide-y divide-hairline/30">
          {copy.features.map((row) => (
            <FirstRunFluxRow key={row.id} row={row} />
          ))}
        </ul>
      </div>

      <FirstRunLine quiet>{fluxRecommendation(view)}</FirstRunLine>

      {!done && (
        <div className="mt-3 grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // The browser first, because the next screen says it is open.
                void openOutside(FLUX_SIGNUP_URL);
                setPasting(true);
              }}
              className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}
            >
              {copy.submit}
            </button>
          </div>
          <p className="text-[13px] text-ink-secondary">{copy.keyCaveat}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void notNow()} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
              {/* A machine with nothing runnable on it has nothing to carry
                  on WITH, so it is not offered anything to carry on with. */}
              {canCarryOn ? copy.dismissLocal : copy.dismiss}
            </button>
            <span className="text-[13px] text-ink-secondary">{copy.dismissCaveat}</span>
          </div>
        </div>
      )}

      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

/** The other half of card three: they said not now, and that is a real
 *  answer rather than a postponement with a reminder attached. */
export function FirstRunNoKeyCard() {
  const { view } = useSetupView();
  const copyNoKey = FIRST_RUN_COPY.flux["no-key"];
  // Nothing on this machine can think, so "we carry on with what is here" is
  // not a thing that can be said. `view.agents` is empty exactly then.
  const bare = view ? view.agents.length === 0 : false;
  return (
    <FirstRunBubble>
      <FirstRunLine>{bare ? copyNoKey.bodyBare : copyNoKey.body}</FirstRunLine>
      <FirstRunLine>{bare ? copyNoKey.secondBare : copyNoKey.second}</FirstRunLine>
    </FirstRunBubble>
  );
}
