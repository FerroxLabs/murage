// CARD ONE: hello.
//
// Two fields and a way past them. The signup behind it is not new and is not
// reimplemented: it is the same three steps Onboarding.tsx has always taken
// (PUT /api/config with the profile, CONFIRM the save came back, then
// subscribe), moved into a message so that the first thing a
// person sees is their chief of staff talking to them rather than a form on
// top of an app they have not met.
//
// The confirmation check is the part worth keeping deliberately: a profile
// save that silently did not save would have the Chief using a name it does
// not have, all week.

import { useId, useState } from "react";

import { setEmailGateDone } from "@/lib/analytics";
import { FIRST_RUN_COPY, greetingLine, probeLine } from "@/lib/first-run-copy";
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
  useSetupView,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.hello.welcome;
/** Said when the card was answered but the updates-list signup was refused. The person is in either way. */
export const SIGNUP_FAILED_NOTE = "You are all set. We could not add you to Murage news just now. You can join any time from Settings, under About.";
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
 * "Skip" sits beside it and passes the whole step over. What the flow
 * does not have is a half answer, where the Chief has somewhere to write to
 * and nothing to call the person it is writing to.
 */
export function helloAnswerReady(name: string, email: string): boolean {
  // O16 (0.1.61): the email is optional on Continue, as Skip already proved
  // it was. A typed one still has to be a real address.
  return name.trim().length > 0 && (!email.trim() || EMAIL.test(email.trim()));
}

/** An email typed that is not an address. Empty is fine: the email is optional. */
function emailWrong(email: string): boolean {
  return email.trim().length > 0 && !EMAIL.test(email.trim());
}

/**
 * What Continue (the button or Enter in either box) does with what is typed.
 *
 * A WRONG EMAIL SAYS WHY. It used to only hold Continue back, so pressing it,
 * or Enter, did nothing and said nothing (upstream 7f61ed1fc). Now it asks
 * for the email to be checked, which shows the note below the box.
 */
export function helloContinue(name: string, email: string): "save" | "check-email" | "need-name" {
  if (emailWrong(email)) return "check-email";
  return helloAnswerReady(name, email) ? "save" : "need-name";
}

/** The note under the email box: said once the box was left or Continue was
 *  tried, never while the first characters are still being typed. */
export function helloEmailNote(email: string, checked: boolean): string {
  return checked && emailWrong(email) ? copy.emailInvalid : "";
}

/** What the hello step talks to. The live versions are below; a test hands
 *  its own and watches what the step actually calls. */
export interface HelloAnswerDeps {
  api: (path: string, init?: RequestInit) => Promise<any>;
  markGate: (status: "submitted" | "skipped") => void;
  answer: (step: "hello", answer: string) => Promise<void>;
  skip?: (step: "hello") => Promise<void>;
}

const LIVE: HelloAnswerDeps = {
  api,
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
 * week), and only then is the address put on the list. The subscribe is fire
 * and forget on purpose: entry to the app has never been allowed to depend on
 * a mailing list being reachable. The local server records it and posts it to
 * murage.ai from its own process, retrying quietly (server/news-signup.ts);
 * this file never makes a network call of its own.
 *
 * NO ANALYTICS WITH THE ADDRESS (1.0.7, Sean: "no analytics, no device id").
 * This used to identify the person to analytics with their email first. The
 * address now goes to one place, the news list, and nowhere else.
 */
export async function saveHelloAnswer(
  typed: { name: string; email: string },
  deps: HelloAnswerDeps = LIVE,
): Promise<{ profile: { name: string; email: string }; greeting: string; signup: Promise<"ok" | "failed" | "none"> }> {
  const profile = { name: typed.name.trim(), email: typed.email.trim().toLowerCase() };
  if (!profile.email) {
    // A name and no email (O16): the name is saved and confirmed, the step is
    // answered with it, and nothing goes to the list. Any address saved
    // earlier is left alone rather than blanked.
    const saved = await deps.api("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name: profile.name } }) });
    if (saved?.profile?.name !== profile.name) throw new Error(copy.failure);
    try { deps.markGate("skipped"); } catch { /* a blocked store is not a failed save */ }
    await deps.answer("hello", profile.name);
    return { profile, greeting: greetingLine(profile.name), signup: Promise.resolve("none") };
  }
  const result = await deps.api("/api/config", { method: "PUT", body: JSON.stringify({ profile }) });
  // The same confirmation Onboarding makes: a PUT that answered is not a PUT
  // that saved.
  if (result?.profile?.name !== profile.name || result?.profile?.email !== profile.email) {
    throw new Error(copy.failure);
  }
  // Not awaited: entry never waits on the list. The outcome is returned so the
  // card can tell the person if the signup did not go through. It never rejects.
  const signup: Promise<"ok" | "failed"> = deps.api("/api/subscribe", { method: "POST", body: JSON.stringify({ ...profile, from: "hello" }) }).then(() => "ok" as const, () => "failed" as const);
  try { deps.markGate("submitted"); } catch { /* a blocked store is not a failed signup */ }
  // Both halves, because both are what they just told the Chief and the
  // transcript is where a person checks what an assistant heard.
  await deps.answer("hello", [profile.name, profile.email].filter(Boolean).join(", "));
  return { profile, greeting: greetingLine(profile.name), signup };
}

/**
 * "Skip" PASSES OVER THE EMAIL, NOT A NAME THEY ALREADY TYPED.
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
  // Set when the email box is left, or Continue or Enter is pressed.
  const [emailChecked, setEmailChecked] = useState(false);
  const emailNoteId = useId();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [failure, setFailure] = useState("");
  const [signupNote, setSignupNote] = useState("");
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
  // The look around runs while they type; once the view has landed, the
  // footer says what it found instead of that it is looking (§1.3).
  const { view } = useSetupView();
  const found = probeLine(view);
  const helperId = useId();

  const valid = helloAnswerReady(name, email);
  const emailNote = helloEmailNote(email, emailChecked);

  // Nothing but the form state lives here: the answer itself is
  // `saveHelloAnswer` above, which a test runs.
  const save = async () => {
    if (busy) return;
    const next = helloContinue(name, email);
    if (next === "check-email") setEmailChecked(true);
    if (next !== "save") return;
    setBusy(true);
    setFailure("");
    try {
      const answer = await saveHelloAnswer({ name, email });
      setSaved(answer.greeting);
      setActed(true);
      void answer.signup.then((outcome) => { if (outcome === "failed") setSignupNote(SIGNUP_FAILED_NOTE); });
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
      <FirstRunLine>{copy.chief}</FirstRunLine>
      <div className="mt-2 text-[15px] font-semibold text-ink">{copy.heading}</div>

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
              aria-invalid={emailNote ? true : undefined}
              aria-describedby={`${helperId} ${emailNoteId}`}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setEmailChecked(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
              className={`mt-1.5 ${FIRST_RUN_INPUT} ${FIRST_RUN_FOCUS}`}
            />
          </label>
          <p id={helperId} className="-mt-1 text-[12.5px] leading-snug text-ink-secondary">{copy.emailHelper}</p>
          {/* Always in the page, so a screen reader hears the note when it appears. */}
          <p id={emailNoteId} aria-live="polite" className="text-[12.5px] leading-snug text-danger empty:hidden">
            {emailNote}
          </p>
          {/* One primary action, on the right; the ghost before it. */}
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => void skip()} className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
              {copy.skip}
            </button>
            {/* A wrong email holds Continue (dimmed, aria-disabled) yet leaves it
                pressable, so pressing it says why. No name, and it is off. */}
            <button
              type="button"
              disabled={busy || !name.trim()}
              aria-disabled={!valid || undefined}
              onClick={() => void save()}
              className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS} aria-disabled:opacity-50`}
            >
              {busy ? copy.working : copy.submit}
            </button>
          </div>
        </div>
      )}

      {saved && <FirstRunNote>{saved}</FirstRunNote>}
      <FirstRunFailure message={failure} />
      {signupNote && <p role="status" className="mt-2 text-[13px] text-ink-secondary" data-testid="hello-signup-note">{signupNote}</p>}

      {/* Detection is already running while they type, and saying so is the
          difference between a wait and a pause. One line, and quiet. */}
      {!done && <p aria-live="polite" className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{found ?? copy.detecting}</p>}

      {/* How learning works, once, where the owner is already reading. */}
      <FirstRunLine quiet>{copy.learnLine}</FirstRunLine>
    </FirstRunBubble>
  );
}
