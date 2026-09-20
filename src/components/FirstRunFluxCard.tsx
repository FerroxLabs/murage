// CARD THREE: the key, in the chat.
//
// Three sentences in the order that matters: routing first, because that is
// what the key IS; then the apps it opens; then pictures, voice and
// transcription. A recommendation under them, because this one card decides
// how much of the rest of the product works.
//
// The paste field saves through `saveFluxKey`, which is the Settings card's
// own road into the operating system's keychain. The key is never put in a
// message, never sent to a model, and never re-displayed.

import { useState } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import {
  FLUX_KEY_NOT_A_KEY,
  fluxBridge,
  readFluxStatus,
  saveFluxKey,
} from "@/lib/flux-key-paste";
import { useDesktopSurface } from "@/lib/use-surface";
import { api } from "@/state/store";
import { FLUX_SIGNUP_URL } from "./FluxRouterConnection";
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
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.flux.key;

export function FirstRunFluxCard({ settled }: { settled: boolean }) {
  const desktop = useDesktopSurface();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(settled);

  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true);
    setFailure("");
    try {
      const status = await readFluxStatus(api);
      await saveFluxKey(key, { status, bridge: fluxBridge(), request: api, desktop: desktop === true });
      // Out of React's hands the moment it is stored. Nothing above keeps a
      // copy and nothing below renders one.
      setKey("");
      setSaved(true);
      setDone(true);
      await answerSetupStep("flux", "key saved");
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
      setDone(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>
      <FirstRunLine>{copy.third}</FirstRunLine>
      <FirstRunLine quiet>{copy.recommendation}</FirstRunLine>

      {!done && (
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
                if (failure === FLUX_KEY_NOT_A_KEY) setFailure("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
              className={`mt-1.5 ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
            />
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !key.trim()} onClick={() => void save()} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
              {busy ? copy.working : copy.submit}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void openOutside(FLUX_SIGNUP_URL)}
              className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
            >
              {copy.signup}
            </button>
            <button type="button" disabled={busy} onClick={() => void notNow()} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
              {copy.dismiss}
            </button>
          </div>
        </div>
      )}

      {saved && <FirstRunNote>{copy.saved}</FirstRunNote>}
      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

/** The other half of card three: they said not now, and that is a real
 *  answer rather than a postponement with a reminder attached. */
export function FirstRunNoKeyCard() {
  const copyNoKey = FIRST_RUN_COPY.flux["no-key"];
  return (
    <FirstRunBubble>
      <FirstRunLine>{copyNoKey.body}</FirstRunLine>
      <FirstRunLine>{copyNoKey.second}</FirstRunLine>
    </FirstRunBubble>
  );
}
