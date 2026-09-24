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

/**
 * Whether Continue may be pressed.
 *
 * BOTH, OR NEITHER, and it is its own function so the rule can be executed by
 * a test rather than inferred from a disabled attribute in a string of markup.
 *
 * This used to be the email alone, so Continue lit up with the name box empty
 * and a person could send a profile carrying an address and nobody's name. The
 * approved flow is explicit: Continue stays disabled until BOTH validate. That
 * is not a wall, because the way past is a button rather than a valid form.
 * "Skip for now" sits beside it and passes the whole step over. What the flow
 * does not have is a half answer, where the Chief has somewhere to write to
 * and nothing to call the person it is writing to.
 */
export function helloAnswerReady(name: string, email: string): boolean {
  return name.trim().length > 0 && EMAIL.test(email.trim());
}

/** What the hello step talks to. The live versions are below; a test hands
 *  its own and watches what the step actually calls. */
export interface HelloAnswerDeps {
  api: (path: string, init?: RequestInit) => Promise<any>;
  identify: (email: string) => void;
  markGate: (status: "submitted" | "skipped") => void;
  answer: (step: "hello", answer: string) => Promise<void>;
  skip?: (step: "hello") => Promise<void>;
}

const LIVE: HelloAnswerDeps = {
  api,
  identify: identifyEmail,
  markGate: setEmailGateDone,
  answer: answerSetupStep,
  skip: skipSetupStep,
};

/**
 * THE WHOLE HELLO ANSWER, OUT OF THE COMPONENT SO IT CAN BE RUN.
 *
 * THE DEFECT THIS EXISTS FOR. The signup behind this step is the only thing
 * on the first run that leaves the machine for a list, and the only guard on
 * it was a `readFileSync` of this file grepping for the string
 * `"/api/subscribe"`. A reviewer replaced the real call with a dead constant
 * and 22 tests stayed green: the list would have collected nothing, from
 * everybody, and the suite would have been happy about it. A grep cannot tell
 * a call from a comment, a constant, or dead code.
 *
 * So the sequence is a function now, and FirstRunHelloCard.test.ts RUNS it:
 * the profile is saved, the save is CONFIRMED (a PUT that answered is not a
 * PUT that saved, which is the check worth keeping deliberately — a profile
 * that silently did not save has the Chief using a name it does not have, all
 * week), and only then is the address identified and put on the list. The
 * subscribe is fire and forget on purpose: entry to the app has never been
 * allowed to depend on a marketing list being reachable.
 */
export async function saveHelloAnswer(
  typed: { name: string; email: string },
  deps: HelloAnswerDeps = LIVE,
): Promise<{ profile: { name: string; email: string }; greeting: string }> {
  const profile = { name: typed.name.trim(), email: typed.email.trim().toLowerCase() };
  const result = await deps.api("/api/config", { method: "PUT", body: JSON.stringify({ profile }) });
  // The same confirmation Onboarding makes: a PUT that answered is not a PUT
  // that saved.
  if (result?.profile?.name !== profile.name || result?.profile?.email !== profile.email) {
    throw new Error(copy.failure);
  }
  deps.identify(profile.email);
  void deps.api("/api/subscribe", { method: "POST", body: JSON.stringify(profile) }).catch(() => {});
  try { deps.markGate("submitted"); } catch { /* a blocked store is not a failed signup */ }
  // Both halves, because both are what they just told the Chief and the
  // transcript is where a person checks what an assistant heard.
  await deps.answer("hello", [profile.name, profile.email].filter(Boolean).join(", "));
  return { profile, greeting: greetingLine(profile.name) };
}

/**
 * "Skip for now" PASSES OVER THE EMAIL, NOT A NAME THEY ALREADY TYPED.
 *
 * It used to drop both, so somebody who typed their name and skipped the
 * address was called "there" from then on. A typed name is saved (and the
 * save confirmed, as above); the email is never saved or sent on a skip,
 * however much of it was typed, and nobody goes on the list.
 */
export async function skipHelloAnswer(
  typed: { name: string; email: string },
  deps: HelloAnswerDeps = LIVE,
): Promise<{ greeting: string }> {
  const name = typed.name.trim();
  if (name) {
    const result = await deps.api("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name } }) });
    if (result?.profile?.name !== name) throw new Error(copy.failure);
  }
  try { deps.markGate("skipped"); } catch { /* a blocked store is not a failed skip */ }
  await (deps.skip ?? skipSetupStep)("hello");
  return { greeting: name ? greetingLine(name) : "" };
}

export function FirstRunHelloCard({ settled }: { settled: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [failure, setFailure] = useState("");
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

  const valid = helloAnswerReady(name, email);

  // Nothing but the form state lives here: the answer itself is
  // `saveHelloAnswer` above, which a test runs.
  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setFailure("");
    try {
      setSaved((await saveHelloAnswer({ name, email })).greeting);
      setActed(true);
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
      const { greeting } = await skipHelloAnswer({ name, email });
      if (greeting) setSaved(greeting);
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.heading}</div>
      <FirstRunLine>{copy.lead}</FirstRunLine>

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
              // Enter moves the form on from either field. It used to work
              // from the email box alone, which is the box a person is in
              // second; somebody who types a name and presses Enter should
              // not have to discover that it does nothing here.
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
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
