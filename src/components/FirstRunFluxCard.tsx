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

import { FIRST_RUN_COPY, type FirstRunFluxFeature } from "@/lib/first-run-copy";
import { useOnline } from "@/lib/first-run";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import {
  FLUX_KEY_NOT_A_KEY,
  FLUX_KEY_REJECTED,
  fluxBridge,
  readFluxStatus,
  saveAndProveFluxKey,
} from "@/lib/flux-key-paste";
import { SETUP_FLUX_PROVED_ANSWER, SETUP_FLUX_UNPROVED_ANSWER } from "../../shared/first-run-chief";
import { useDesktopSurface } from "@/lib/use-surface";
import { opensPurchasePages } from "@/lib/native-shell";
import { api, useStore } from "@/state/store";
import { FLUX_ACCOUNT_URL, FLUX_SIGNUP_URL } from "./FluxRouterConnection";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_INPUT,
  FIRST_RUN_PRIMARY,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  FirstRunNote,
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
export function fluxRecommendation(view: { agents?: readonly unknown[]; signedOutAgents?: readonly unknown[]; nothingToThinkWith?: boolean } | null | undefined): string {
  // The heading's own answer wins when the server gave one. An engine can be
  // listed and still unable to think (seen on Windows), and then counting
  // `agents` put "you are already up and running" under "your bots need a
  // brain first" on the same card.
  if (view?.nothingToThinkWith === true) return copy.recommendationBare;
  if (!view?.agents) return copy.recommendation;
  if (view.agents.length === 0) return view.nothingToThinkWith === false ? copy.recommendation : copy.recommendationBare;
  // "Already up and running" is a claim about what detection FOUND. The
  // engine Murage ships (`installed: false`) answers only once this very key
  // is in, so on a box where nothing was found it made the card say the
  // person had been running all along (0.1.60 Linux customer pass).
  // §1.5: a signed-in engine gets the bonus framing; a machine whose only
  // help is a local model gets "Recommended", because this key is what opens
  // everything else for it.
  const found = view.agents.filter((agent) => (agent as { installed?: unknown } | null)?.installed !== false);
  if (found.some((agent) => !(agent as { localModel?: unknown }).localModel)) return copy.recommendationBonus;
  if (found.length > 0) return copy.recommendation;
  return (view.signedOutAgents?.length ?? 0) > 0 ? copy.recommendation : copy.recommendationBare;
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
  /** Absent inside the phone app, which opens no sign-up page. */
  onAgain?: () => void;
  onCancel: () => void;
}) {
  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{onAgain ? copy.connectHeading : copy.connectHeadingInApp}</div>
      <FirstRunLine>{onAgain ? copy.connectLead : copy.connectLeadInApp}</FirstRunLine>
      {!onAgain ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={onCancel} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
            {copy.connectCancel}
          </button>
        </div>
      ) : (<>
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
        {onAgain && <button type="button" disabled={busy} onClick={onAgain} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {copy.connectAgain}
        </button>}
        <button type="button" disabled={busy} onClick={onCancel} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {copy.connectCancel}
        </button>
      </div>
      </>)}
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
  // The allowance screen's one button opens the account page; it goes
  // through useAction so a page that will not open says so.
  const openAccount = useAction(() => openOutside(FLUX_ACCOUNT_URL));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // THE SIGN-UP SCREEN. 1.0.12 (UX-FIRSTRUN-SCALE-1012 §1.5) puts the key
  // field on the card itself, for somebody who already has a key, with
  // "I need a key" opening the sign-up page and switching to this screen,
  // which says the browser is open and takes the paste.
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
  // Only a key that answered its proof read earns "Connected". A skip or a
  // saved-but-unproved key finishes the card without claiming a connection.
  const [proved, setProved] = useState(false);
  const [declinedBare, setDeclinedBare] = useState(false);
  const [offlineAsked, setOfflineAsked] = useState(false);
  const online = useOnline();
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
      setProved(proof === "proved");
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
  const canCarryOn = (view?.agents.length ?? 0) > 0;
  // §1.5: the ghost names the local model only on a machine that has one.
  const onLocal = (view?.agents ?? []).some((agent) => Boolean(agent.localModel));
  const fluxStep = view?.steps.find((step) => step.id === "flux");
  const allowanceUsed = fluxStep?.status === "blocked" && fluxStep.block?.reason === "payment-required";

  if (pasting && !done) {
    return (
      <FirstRunFluxConnect
        value={key}
        busy={busy}
        failure={failure}
        onChange={(next) => {
          setKey(next);
          if (failure === FLUX_KEY_NOT_A_KEY || failure === FLUX_KEY_REJECTED) setFailure("");
        }}
        onSubmit={() => void save()}
        onAgain={opensPurchasePages() ? () => void openOutside(FLUX_SIGNUP_URL) : undefined}
        onCancel={() => setPasting(false)}
      />
    );
  }

  // §1.9: no internet. The buttons stay; pressing one that needs it says so
  // instead of failing, and the card picks up when the connection is back.
  const needsInternet = (): boolean => {
    if (online) return false;
    setOfflineAsked(true);
    return true;
  };

  const notNowPressed = () => {
    if (busy) return;
    // §1.5 bare decline: nothing here can think, so passing over would leave
    // a window with nothing behind it. The Chief says so and the card stays,
    // with the same buttons; the step stays where it is.
    if (!canCarryOn) {
      setDeclinedBare(true);
      return;
    }
    void notNow();
  };

  return (
    <FirstRunBubble>
      {/* NO EYEBROW HERE: the step separator above the card already says
          "Flux Router". The example brief sits above this bubble (§1.5). */}
      <div className="text-[17px] font-semibold text-ink">
        {allowanceUsed ? copy.allowanceHeading : noBrain ? copy.headingBare : copy.heading}
      </div>
      <FirstRunLine>{allowanceUsed ? copy.allowanceLead : fluxRecommendation(view)}</FirstRunLine>

      {/* THE CARD. No price, no figure, no plan comparison anywhere on it: a
          ruling, and also two assertions in first-run-copy.test.ts. Every row
          is something that stops working without the key. */}
      {!allowanceUsed && (
        <div className="mt-3 overflow-hidden rounded-xl border border-hairline/50 bg-inset">
          <ul className="divide-y divide-hairline/30">
            {copy.features.map((row) => (
              <FirstRunFluxRow key={row.id} row={row} />
            ))}
          </ul>
        </div>
      )}

      {allowanceUsed && !done && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {opensPurchasePages() && (
            <ActionButton action={openAccount} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
              {copy.allowanceOpen}
            </ActionButton>
          )}
        </div>
      )}

      {!done && !allowanceUsed && (
        <div className="mt-3 grid gap-2">
          <label className="text-[13px] text-ink-secondary">
            {copy.fieldLabel}
            <input
              aria-label={copy.fieldLabel}
              type="password"
              name="flux-router-key"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              placeholder={copy.placeholder}
              value={key}
              disabled={busy}
              onChange={(event) => {
                setKey(event.target.value);
                if (failure === FLUX_KEY_NOT_A_KEY || failure === FLUX_KEY_REJECTED) setFailure("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!needsInternet()) void save();
                }
              }}
              className={`mt-1.5 ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
            />
          </label>
          <p className="text-[13px] text-ink-secondary">{copy.keyCaveat}</p>
          {/* One primary action, on the right; the secondary and the ghost
              before it, in the same order on every surface. */}
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={notNowPressed} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
              {onLocal ? copy.dismissLocal : copy.dismiss}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (needsInternet()) return;
                if (opensPurchasePages()) void openOutside(FLUX_SIGNUP_URL);
                setPasting(true);
              }}
              className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
            >
              {copy.signup}
            </button>
            <button
              type="button"
              disabled={busy || !key.trim()}
              onClick={() => {
                if (!needsInternet()) void save();
              }}
              className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}
            >
              {busy ? copy.working : copy.submit}
            </button>
          </div>
          {offlineAsked && !online && <p role="status" className="text-[13px] text-ink-secondary">{copy.offline}</p>}
        </div>
      )}

      {acted && proved && !failure && <FirstRunNote>{copy.saved}</FirstRunNote>}
      <FirstRunFailure message={failure} />

      {/* §1.5 and §1.9, nothing to think with and "Not now": the Chief says
          why it cannot just carry on, and the jobs it would do are shown
          waiting, not pressable. */}
      {declinedBare && !done && (
        <div className="mt-3">
          <FirstRunLine>{copy.notNowBare}</FirstRunLine>
          <ul className="mt-2 grid gap-1.5" aria-disabled="true">
            {FIRST_RUN_COPY.chat.jobs.rows.map((row) => (
              <li key={row.id} className="rounded-xl border border-hairline/40 bg-inset px-3 py-2 opacity-60">
                <span className="block text-[14px] font-medium text-ink">{row.title}</span>
                <span className="block text-[12.5px] text-ink-secondary">{row.sub}</span>
              </li>
            ))}
          </ul>
          <FirstRunLine quiet>{copy.jobsWaiting}</FirstRunLine>
        </div>
      )}
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
