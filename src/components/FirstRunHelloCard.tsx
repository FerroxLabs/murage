// CARD ONE: hello.
//
// Two fields and a way past them. The signup behind it is not new and is not
// reimplemented: it is the same three steps Onboarding.tsx has always taken
// (PUT /api/config with the profile, CONFIRM the save came back, then
// identify and subscribe), moved into a message so that the first thing a
// person sees is their chief of staff talking to them rather than a form on
// top of an app they have not met.
//
// The confirmation check is the part worth keeping deliberately: a profile
// save that silently did not save would have the Chief using a name it does
// not have, all week.

import { useState } from "react";

import { identifyEmail, setEmailGateDone } from "@/lib/analytics";
import { FIRST_RUN_COPY, greetingLine } from "@/lib/first-run-copy";
import { api } from "@/state/store";
import {
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
  skipSetupStep,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.hello.welcome;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function FirstRunHelloCard({ settled }: { settled: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(settled);

  const valid = EMAIL.test(email.trim());

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setFailure("");
    const profile = { name: name.trim(), email: email.trim().toLowerCase() };
    try {
      const result = await api("/api/config", { method: "PUT", body: JSON.stringify({ profile }) });
      // The same confirmation Onboarding makes: a PUT that answered is not a
      // PUT that saved.
      if (result?.profile?.name !== profile.name || result?.profile?.email !== profile.email) {
        throw new Error(copy.failure);
      }
      identifyEmail(profile.email);
      void api("/api/subscribe", { method: "POST", body: JSON.stringify(profile) }).catch(() => {});
      try { setEmailGateDone("submitted"); } catch { /* a blocked store is not a failed signup */ }
      await answerSetupStep("hello", profile.name || profile.email);
      setSaved(greetingLine(profile.name));
      setDone(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      try { setEmailGateDone("skipped"); } catch { /* as above */ }
      await skipSetupStep("hello");
      setDone(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstRunBubble>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>

      {!done && (
        <div className="mt-3 grid gap-2">
          <label className="text-[13px] text-ink-secondary">
            {copy.nameLabel}
            <input
              aria-label={copy.nameLabel}
              placeholder={copy.namePlaceholder}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              className={`mt-1.5 ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
            />
          </label>
          <label className="text-[13px] text-ink-secondary">
            {copy.emailLabel}
            <input
              aria-label={copy.emailLabel}
              type="email"
              inputMode="email"
              placeholder={copy.emailPlaceholder}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
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
            <button type="button" disabled={busy || !valid} onClick={() => void save()} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`}>
              {busy ? copy.working : copy.submit}
            </button>
            <button type="button" disabled={busy} onClick={() => void skip()} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
              {copy.skip}
            </button>
          </div>
        </div>
      )}

      {saved && <FirstRunNote>{saved}</FirstRunNote>}
      <FirstRunFailure message={failure} />

      {/* Detection is already running while they type, and saying so is the
          difference between a wait and a pause. One line, and quiet. */}
      {!done && <FirstRunLine quiet>{copy.detecting}</FirstRunLine>}
    </FirstRunBubble>
  );
}
