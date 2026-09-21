import { z } from "zod";

// Guided first run — the frozen contract for 0.1.58.
//
// The SERVER owns the list, the order and every step's `done`. A model may
// add a sentence of personality between cards; it never decides that a step
// is finished. Every `done` in here is DERIVED from live state on every
// read, so re-running `/setup` on a working install shows the finished steps
// as finished and reinstalls nothing.
//
// 0.1.58 re-cut the list, and then re-cut it again. 0.1.57 asked eight
// questions in a modal. The first 0.1.58 pass answered as many as it could
// first and left six steps. W16 cuts those six to FIVE, and on a machine with
// nothing to think with the person sees four, because the second one is
// skipped entirely.
//
// The cut, and why each one moved:
//
//   hello  · who you are            (unchanged)
//   detect · what is already here   (was `agents`; renamed for what it does)
//   flux   · switch it on           (unchanged)
//   chat   · first chat             (new: the Chief asks what to take on)
//   flow   · do the thing           (new: the chosen job, start to finish)
//
// `apps` STOPPED BEING A STEP. Connecting Gmail or a calendar out of context,
// before anything has asked for them, is a form to fill in; the same two
// connections asked for by a job the person just chose are obviously worth
// making. So the standalone step disappears into per-job connect inside
// `flow`, and the hard block that guarded it is kept as `connectedAppsBlock`
// below rather than thrown away.
//
// `brief` and `routines` STOPPED BEING STEPS. They are outcomes of a job the
// person picked, not rows on a checklist. The morning brief is what the
// `brief` job produces, and the offer to run it every morning arrives on that
// result. Nothing about the brief is weakened: the routine is still the
// server's, and it still has to exist before anything claims it does.
//
// Detection comes first everywhere: a question whose answer is already on the
// machine is a question that should never have been asked.

/** The five steps, in the order they are presented. On a machine with
 *  nothing to think with, `detect` is already settled and the person sees
 *  four. See `nothingToThinkWith`. */
export const SETUP_STEPS = ["hello", "detect", "flux", "chat", "flow"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const setupStepSchema = z.enum(SETUP_STEPS);

/** An answer is a short note, not a document: it is persisted, echoed back to
 *  the panel and shown to the user. Longer material belongs in the thing the
 *  step configures (MEMORY.md, a bot profile), never in the checklist. */
export const SETUP_NOTE_MAX = 500;

/** How many routines count as "a couple more" beyond the morning brief. The
 *  brief is one of them, so the offer asks for one more thing, not two.
 *
 *  PARKED, NOT DEAD. `routines` is no longer a step, so nothing derives a
 *  `done` from this any more. The `more-routines` card it belongs to is one
 *  of the surfaces held for the owner's decision (Q8), so the number it was
 *  agreed at is held with it rather than re-guessed later. */
export const SETUP_ROUTINES_TARGET = 2;

/**
 * 3, because W16 re-cut the step keys.
 *
 * A version-2 file names `agents`, `apps`, `brief` and `routines`, none of
 * which exist any more, and `setupStepsSchema` is `.strict()`. Bumping is the
 * honest way to say that rather than leaving a stale file to be rejected by
 * accident: `loadState` sees a version it does not recognise and starts a
 * fresh checklist.
 *
 * NOTHING REAL IS LOST BY THAT RESET. Every `done` is re-derived from live
 * state on the very next read, so a saved name, a saved Flux key and a brief
 * that exists all re-tick immediately. Only the recorded answer notes go, and
 * those are a transcript of what was typed, not a source of truth.
 */
export const SETUP_STATE_VERSION = 3;

export const setupStepStateSchema = z.object({
  done: z.boolean(),
  /** When the step last became done, or was skipped. Absent while it is open. */
  at: z.number().int().nonnegative().optional(),
  /** Passed over deliberately. Skipped is NOT done — the checklist moves on
   *  and says plainly that the step is still outstanding. */
  skipped: z.boolean().optional(),
  /**
   * THE FLOW HAS BEEN PAST THIS STEP, AND THAT IS A FACT ABOUT WHAT
   * HAPPENED RATHER THAN A RE-DERIVATION FROM WHAT IS TRUE NOW.
   *
   * Every other field on this record is re-decided on every read, which is
   * the right rule for a step that measures the machine: a Flux key deleted
   * from the keychain puts `flux` back, and it should. It is the WRONG rule
   * for a step whose only support was "there was nothing here to show you".
   *
   * The blank machine is the case. `detect` is settled on a machine with
   * nothing to think with, because there is no honest "here is what I
   * found" to write for it. Then the person pays, the key fills the shipped
   * engine's catalogue, `live.agents` stops being empty,
   * `nothingToThinkWith` flips false, and the ONLY thing holding `detect`
   * done goes with it. `nextSetupStep` then sends them BACK to a step that
   * cannot be settled, immediately after they paid. Reported as the flow
   * going backwards; it was the predicate going backwards underneath it.
   *
   * So passing is latched. See `LATCHED_STEPS` and `deriveSetupState`.
   */
  latched: z.boolean().optional(),
  /** What the person answered. Recorded, never trusted as proof of `done`. */
  note: z.string().max(SETUP_NOTE_MAX).optional(),
}).strict();
export type SetupStepState = z.infer<typeof setupStepStateSchema>;

const setupStepsSchema = z.object({
  hello: setupStepStateSchema,
  detect: setupStepStateSchema,
  flux: setupStepStateSchema,
  chat: setupStepStateSchema,
  flow: setupStepStateSchema,
}).strict();

export const setupStateSchema = z.object({
  version: z.literal(SETUP_STATE_VERSION),
  startedAt: z.number().int().nonnegative(),
  steps: setupStepsSchema,
  /** The bot the person first met. It is the Chief of Staff and hosts setup;
   *  a crew installed later reports to it and never replaces it. */
  chiefBotId: z.string().min(1).max(180).optional(),
  /** The routine the brief step created, so the step can find it again
   *  without matching on a name the person is free to change. Recorded, and
   *  still checked against the live routine list on every read: a brief the
   *  person deleted puts the step back. */
  briefRoutineId: z.string().min(1).max(180).optional(),
}).strict();
export type SetupState = z.infer<typeof setupStateSchema>;

// The ordered list and the persisted shape must never drift apart: a step
// added to one and not the other is a compile error on these two lines.
type _StepsCoverEveryStep = Record<SetupStep, SetupStepState> extends SetupState["steps"] ? true : never;
type _StepsAddNothingElse = SetupState["steps"] extends Record<SetupStep, SetupStepState> ? true : never;
const _stepsAgree: [_StepsCoverEveryStep, _StepsAddNothingElse] = [true, true];
void _stepsAgree;

export function emptySetupState(now: number): SetupState {
  const steps = Object.fromEntries(SETUP_STEPS.map((step) => [step, { done: false }])) as SetupState["steps"];
  return { version: SETUP_STATE_VERSION, startedAt: now, steps };
}

// ── live state ─────────────────────────────────────────────────────────
/** Whether the engine Murage ships can be run on this machine, and the
 *  resolver's own sentence when it cannot. */
export interface SetupEngineReading {
  ready: boolean;
  reason?: string;
}

/** The Flux Router connection. `configured` and `conflict` are the app's own
 *  `FluxConnectionStatus`, so this step agrees with the connection card
 *  rather than forming a second opinion. */
export interface SetupFluxReading {
  /** A Flux workspace key is saved. */
  configured: boolean;
  /** Several different Flux keys are saved and none has been chosen. */
  conflict: boolean;
  /** The saved key is shaped like a key. A key saved through the connection
   *  card already passed that gate; one supplied by an environment variable
   *  never did. */
  looksValid: boolean;
}

/**
 * One engine this machine can actually run, as the agents step reports it.
 *
 * `installed` separates the two sentences the Chief has to be able to say.
 * An engine the person installed themselves is news to them only in the
 * sense that Murage found it ("you already had Claude Code and Codex here,
 * I have connected them"); the engine Murage ships is not something they
 * did, so on a bare machine the Chief says it came in the box instead.
 * Saying "I found three agents" on a machine with nothing on it is the kind
 * of small lie that costs the whole first hour its credibility.
 */
export interface SetupAgentReading {
  /** The engine instance id, as `/api/instances` reports it. */
  id: string;
  /** What to call it on screen. */
  name: string;
  /** Found on this computer, rather than shipped inside Murage. */
  installed: boolean;
  /** The command that signs this engine in, when its driver declares one.
   *  Only ever set on a signed-out reading, and only so the card can name the
   *  command rather than hardcode one per engine. */
  signInCommand?: string;
  /**
   * The local model this engine is actually pointed at, named the way its
   * owner names it, and the server it is running on.
   *
   * WHY THE CARD CANNOT JUST USE `name`. The generic connection's display
   * name is "OpenAI-compatible (OpenRouter / Groq)", which is an engine id
   * and two cloud vendors. Said to somebody whose model is on their own hard
   * disk it is wrong twice over, and it was the Chief's opening line. Anyone
   * who installed a local model will recognise the model, so the model is
   * what gets said.
   */
  localModel?: { model: string; host: string };
}

/**
 * Whether this machine can hand the person's phone a working address.
 *
 * Pairing runs over Tailscale. Without it the QR code would resolve to an
 * address the phone cannot reach, so the pairing card is not offered at all:
 * the Chief offers to set Tailscale up instead. Never a dead button, which is
 * the same rule the rest of this flow follows.
 *
 * NOT part of `SetupLiveState`, and deliberately so. Tailscale is found by
 * the Electron main process (`findTailscale`, electron/companion-remote-access.mjs),
 * and the server runs in a forked utility process that cannot see it. The
 * server reports only what the server can actually measure; the renderer asks
 * the desktop bridge for this one and decides the card for itself. A field on
 * the view that the server had to guess at would be a field that lies on some
 * machine.
 */
export interface SetupPhoneReading {
  /** Tailscale is installed on this computer. */
  installed: boolean;
  /** ...and signed in, so an address it hands out would actually resolve. */
  signedIn: boolean;
}

/** Whether the pairing card may be offered at all. Both halves are required:
 *  an installed Tailscale that nobody has signed into hands out an address
 *  that resolves for no one. */
export function phonePairable(phone: SetupPhoneReading): boolean {
  return phone.installed && phone.signedIn;
}

/** What the brief and routines steps measure. The brief is not done when it
 *  is scheduled; it is done when it has RUN. */
export interface SetupRoutineReading {
  /** Every routine in the workspace, however it was created. */
  total: number;
  /** The morning brief, once it exists. */
  briefId: string | null;
  /** ...and it has produced at least one completed run. */
  briefRan: boolean;
}

/**
 * A provider rejection recorded against an engine — the safe structured
 * facts only, never request or response text.
 *
 * `httpStatus` rather than a category name on purpose: what a 402 MEANS is
 * the provider-error module's job to classify and to word, and that wording
 * is being corrected separately. The checklist only needs to know that a
 * turn was refused on payment, which the status says on its own and will
 * keep saying whatever the category ends up called.
 */
export interface SetupRefusalReading {
  httpStatus: number;
  /** Set only when the rejection was provably Flux Router's. */
  provider?: string;
}

/** Everything the checklist measures. Re-measured on every read: nothing in
 *  here is remembered from an earlier answer, and no field may be supplied
 *  by a model or by the request body. */
export interface SetupLiveState {
  /** The name on the owner's profile, or "" when they have not given one.
   *  The hello step's only measurement, and what the Chief calls them. */
  ownerName: string;
  /** Engines this machine can run right now, bundled and found. */
  agents: readonly SetupAgentReading[];
  /**
   * Engines that are here and ready and that nobody is signed in to.
   *
   * SEPARATE FROM `agents`, AND IT MUST STAY SEPARATE. The agents step is done
   * when `agents` is non-empty, so anything in this list would tick the step
   * and let the Chief claim an engine that fails on first send. That was the
   * defect. These are offered instead: see `setupSignedOutReading`.
   */
  signedOutAgents: readonly SetupAgentReading[];
  /** The Flux Router connection as the app's own credential policy reports
   *  it, plus whether the saved key is shaped like a key at all. The key
   *  itself never leaves the server. */
  flux: SetupFluxReading;
  /** The engine Murage ships, as this machine can actually run it. */
  bundledEngine: SetupEngineReading;
  /** The Chief's OWN engine — its `modelSelection.instanceId`. "" = none. */
  chiefInstanceId: string;
  /** Engines that have actually produced a settled reply in the Chief's own
   *  threads. A per-task engine that answered is in here too, which is why
   *  the brain step compares it against the bot's own selection. */
  chiefAnsweredBy: readonly string[];
  /** The Chief's most recent provider rejection, and only while it is more
   *  recent than its most recent settled reply — a refusal the engine has
   *  since recovered from is history, not a blockage. */
  chiefRefusal: SetupRefusalReading | null;
  /** The Chief's own model routes through Flux Router. This is how a payment
   *  refusal is attributed: `classifyProviderError` deliberately drops the
   *  `flux-router` tag for a plain 402, so the error alone cannot say whose
   *  account ran out — but the engine the turn was dispatched to can. */
  chiefUsesFlux: boolean;
  /** Visible bots other than the Chief. */
  crewSize: number;
  /** Connected apps, or null when the connector store could not be read —
   *  "we do not know" is not "nothing is connected". */
  connectedApps: number | null;
  /**
   * WHICH apps are connected, by connector slug, or null when the store
   * could not be read. Same null, same meaning, on purpose.
   *
   * A COUNT WAS NOT ENOUGH ANY MORE. Per-job connect has to say "connect
   * Google Calendar" to somebody who has Gmail connected and nothing else,
   * and to tag the `brief` job `1 to connect` rather than `ready now`. A
   * number cannot answer either question. The slugs are the connector store's
   * own (`gmail`, `googlecalendar`, `slack`), not a second naming scheme.
   */
  connectedAppIds: readonly string[] | null;
  /** A settled engine reply exists somewhere in the workspace. */
  botReplyExists: boolean;
  /** Routines, and the morning brief's own state. */
  routines: SetupRoutineReading;
}

/**
 * The third state, and why it exists.
 *
 * A Flux Router key can be perfectly valid — the catalog loads, the account
 * is real — and still be unable to buy a single token, because the account
 * has hit its monthly spend ceiling. "Key accepted" would send the person
 * happily on to the step that then dies with an opaque error, which is the
 * exact first-hour friction this release exists to remove. So a step has a
 * third outcome: it was done properly, and something outside the person's
 * control stops it working. Not wrong, not missing, not skipped.
 */
export const SETUP_BLOCK_REASONS = [
  "payment-required",
  "engine-unavailable",
  "apps-unreadable",
  "flux-choice-needed",
  "flux-key-needed",
  "engine-needs-model",
] as const;
export type SetupBlockReason = (typeof SETUP_BLOCK_REASONS)[number];
export interface SetupStepBlock {
  reason: SetupBlockReason;
  message: string;
}
export type SetupStepStatus = "done" | "skipped" | "blocked" | "open";

/** A turn was refused on payment. HTTP 402 is the whole test — what kind of
 *  payment problem it is, and what will or will not fix it, is the provider
 *  error card's story to tell. */
function refusedOnPayment(live: SetupLiveState): boolean {
  return live.chiefRefusal?.httpStatus === 402;
}

/** That payment refusal was Flux Router's account, not somebody else's. */
function fluxRefusedOnPayment(live: SetupLiveState): boolean {
  return refusedOnPayment(live) && (live.chiefUsesFlux || live.chiefRefusal?.provider === "flux-router");
}

/** A Flux key is saved, well shaped and unambiguous. Per-job connect needs
 *  one before it can offer anything, so it reads this rather than forming its
 *  own opinion of the flux step. */
export function fluxUsable(live: SetupLiveState): boolean {
  return live.flux.configured && live.flux.looksValid && !live.flux.conflict;
}

/**
 * The apps a first-run job may ask the person to connect in 0.1.58.
 *
 * GMAIL AND CALENDAR ONLY, and that is a decision rather than an oversight.
 * Every extra sign-in is another door out of the flow and another browser
 * window to come back from. Anything else a job could use is said as
 * something it can use LATER, never offered as a sign-in during the first
 * run. Slack has a row written for it in the spec and is deliberately not
 * here; when it comes back it comes back with a decision, not by drifting in.
 */
export const SETUP_JOB_APPS = ["gmail", "googlecalendar"] as const;
export type SetupJobApp = (typeof SETUP_JOB_APPS)[number];

/**
 * Is this one app connected?
 *
 * `false` when the connector store could not be read, and the caller has to
 * live with that: an unreadable store is reported as `connectedAppsBlock`
 * below, which says "unknown rather than empty" in as many words. What must
 * never happen is the other way round — claiming a connection we cannot see,
 * and then failing on the person's first real job.
 */
export function jobAppConnected(live: SetupLiveState, app: SetupJobApp): boolean {
  return live.connectedAppIds?.includes(app) ?? false;
}

/**
 * THE SKIP PREDICATE, AND IT IS THE HEART OF THIS RELEASE.
 *
 * A machine with nothing skips the `detect` step entirely and the Flux screen
 * carries the "your bots need a brain first" framing instead, because there
 * is no honest version of "here is what I found" on a machine where nothing
 * was found.
 *
 * WHY IT RESTS ON `runnable()` AND NOT ON `state === "available"`. Murage
 * SHIPS the Fuigo binary, so `fuigo --version` always answers and the
 * instance always reports itself available. A bare machine therefore has an
 * "available" engine with an empty catalogue. `live.agents` is already
 * filtered by `runnable()` (server/setup.ts), whose third term is a non-empty
 * `models.default`, and that term is the whole difference between "available"
 * and "able to think". Reading availability instead is the exact bug fixed in
 * c0e4eb13, and `setupSignedOutReading` excludes `fuigoAgent` for the same
 * reason.
 *
 * `signedOutAgents` is in the predicate because a machine with a signed-out
 * Claude Code and nothing else is NOT blank. It has something on it worth
 * telling the person about, so it goes through detection and gets the
 * `signed-out` variant. Offering to sell that person a key, while a
 * subscription they already pay for sits one command away on their own
 * computer, is the mistake 3c9770f1 reverted arriving through another door.
 */
export function nothingToThinkWith(live: SetupLiveState): boolean {
  return live.agents.length === 0 && live.signedOutAgents.length === 0;
}

/**
 * NOTHING ON THIS MACHINE CAN ANSWER RIGHT NOW.
 *
 * A DIFFERENT QUESTION FROM THE ONE ABOVE, AND THE DIFFERENCE IS A DEFECT
 * THAT SHIPPED. `nothingToThinkWith` decides whether DETECTION is shown, and
 * its second term is right for that: a machine with a signed-out Claude Code
 * on it is not blank, it has something worth telling the person about, so it
 * goes through detection and gets the sign-in offer.
 *
 * It is the wrong predicate for JOB READINESS, and it was being reused as
 * one. On a machine whose only engine is Claude Code or Codex installed and
 * never signed in, `signedOutAgents` is non-empty, so `nothingToThinkWith` is
 * false, so notes, research and business all reported ready now. `agents` is
 * empty, so nothing could actually answer, and research could be dispatched
 * with no runnable engine behind it at all.
 *
 * `live.agents` is already filtered by `runnable()` AND by not being signed
 * out (server/setup.ts), so its emptiness IS "nothing here can answer". Read
 * off that list rather than restated, for the same reason `nothingToThinkWith`
 * is computed once: a second copy of the rule is a second chance to write
 * `state === "available"` instead of `runnable()` and bring c0e4eb13 back.
 */
export function nothingCanAnswer(live: SetupLiveState): boolean {
  return live.agents.length === 0;
}

/** Prefixes that identify a DIFFERENT provider, as the connection card's own
 *  gate lists them. A key that carries one of these is somebody else's. */
const FOREIGN_KEY_PREFIXES = ["sk-ant-", "sk-or-", "sk-proj-", "sk-svcacct-", "sk-admin-", "xai-", "gsk_"] as const;

/**
 * Shape only. It says the field holds a key rather than a pasted sentence,
 * never that the key is live and never that the account can spend.
 *
 * Deliberately the same test the connection card applies when a key is saved
 * — a secret of at least eight printable characters that does not carry
 * another provider's prefix — plus "no whitespace", because a key never has
 * any and a sentence typed into the box always does. A key that arrives in
 * an environment variable never passed the card's gate, which is the case
 * this exists for.
 */
export function fluxKeyLooksValid(key: string | null | undefined): boolean {
  const value = (key ?? "").trim();
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) return false;
  return !FOREIGN_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * What the renderer records when the person has read the detection report
 * and pressed on.
 *
 * A constant rather than a sentence typed at the call site, because a test
 * that hand-feeds its own note is a test that proves a state the app cannot
 * reach. `detect` is settled by an EVENT — the report was read — and this is
 * the only thing in the product that produces it, so a fixture built from it
 * is a fixture the button really writes.
 */
export const SETUP_DETECT_ANSWER = "detection read";

/** A step counts as answered when a non-empty note was recorded for it and
 *  it was not subsequently passed over. */
export function setupStepAnswered(recorded: SetupStepState): boolean {
  return recorded.skipped !== true && (recorded.note ?? "").trim().length > 0;
}

/**
 * The one place a step's `done` is decided.
 *
 * `hello`, `detect` and `flux` read live state, so answering them cannot make
 * them true on its own. `hello` is half an exception: a saved profile name is
 * a live fact read back from config, and the recorded answer only covers the
 * person who gave a name and then cleared it.
 *
 * `chat` AND `flow` ARE THE NEW EXCEPTIONS, AND IT IS DELIBERATE. "The person
 * chose a job" and "that job produced a result" are events in a conversation,
 * not facts about the machine, and there is nothing on disk to re-measure
 * them from. Inventing a live proxy would be worse than admitting that: the
 * nearest candidates are "a routine exists" and "a bot replied", and both are
 * true of installs where the person never chose anything. So these two are
 * recorded, exactly like a skip is recorded, and the honesty they owe is a
 * narrower one: the SERVER writes them, in response to something that
 * actually happened, and a model can never assert one.
 */
export function setupStepDone(step: SetupStep, recorded: SetupStepState, live: SetupLiveState): boolean {
  switch (step) {
    case "hello":
      return live.ownerName.trim().length > 0 || setupStepAnswered(recorded);
    case "detect":
      // THE SKIP. A machine with nothing to think with has nothing to be
      // shown, so this step is settled before it is ever presented and the
      // flow lands on `flux`, whose blank-machine opening does detection's
      // job of saying what was looked for.
      //
      // Otherwise it is settled once it has been shown, which is a thing
      // that happened in the transcript rather than a fact about the
      // machine: the card is a REPORT, and there is nothing to measure about
      // whether a person has read one. `live.agents.length >= 1` used to
      // stand in for it, and on nearly every machine that is true before
      // anybody has typed anything, so the step ticked itself before the
      // report it exists to deliver had been written.
      //
      // THE LATCH IS READ FIRST, AND IT IS WHAT STOPS THE FLOW REVERSING.
      // Saving the Flux key fills the shipped engine's catalogue, so
      // `nothingToThinkWith` goes false on the very machine it skipped this
      // step for. Without the latch that flips `done` back and the person is
      // sent to a step they have already been past, the moment they paid.
      return recorded.latched === true || nothingToThinkWith(live) || setupStepAnswered(recorded);
    case "flux":
      // A saved, well-shaped key is not the same as a key that can buy a
      // token. When Flux Router itself has refused a turn on payment, this
      // step is NOT done — it is blocked, with the key kept exactly as it
      // is, because the key is right and the spending is not. Several saved
      // keys with none chosen is not done either: nothing is routing yet.
      return fluxUsable(live) && !fluxRefusedOnPayment(live);
    case "chat":
      // A job was chosen. Not "a bot replied": a restored workspace has
      // replies going back months and has chosen nothing today.
      return setupStepAnswered(recorded);
    case "flow":
      // The chosen job produced a result. The job itself, the text typed into
      // it and the parsed items are NOT persisted anywhere and must not be:
      // restoring a half-typed day into a box the person has forgotten about
      // is worse than asking again. A restart mid-job returns to `chat` with
      // the jobs re-tagged from live state.
      return setupStepAnswered(recorded);
  }
}

/**
 * The steps whose passing is an EVENT, not a measurement.
 *
 * Only `detect`, and the shortness of this list is the point. Every other
 * step is re-decided from live state on every read and should be: a key
 * removed from the keychain puts `flux` back, a cleared profile name puts
 * `hello` back, and both of those are the checklist telling the truth. The
 * detection step is the one whose skip rests on a predicate that goes FALSE
 * as a direct result of the person moving forward, so it is the one that has
 * to remember rather than re-measure.
 *
 * `chat` and `flow` are not here because they never needed to be: their
 * `done` already reads a recorded note, which nothing about the machine can
 * take away.
 */
const LATCHED_STEPS: readonly SetupStep[] = ["detect"];

/**
 * Re-derive every step. `at` marks when a step last became done; it is
 * dropped again the moment the live state behind it goes away, so a stale
 * timestamp can never make a step look finished.
 *
 * AND IT LATCHES WHAT THE FLOW HAS BEEN PAST. A latched step is one the flow
 * has actually REACHED and settled, which is why `reached` is tracked: a
 * machine whose engine probe comes back momentarily empty on the very first
 * read, before the person has even said their name, must not have detection
 * stamped as delivered on the strength of it. The flow has to have got there.
 */
export function deriveSetupState(state: SetupState, live: SetupLiveState, now: number): SetupState {
  const steps = { ...state.steps };
  /** Every step before this one is settled, so the flow is really here. */
  let reached = true;
  for (const step of SETUP_STEPS) {
    const recorded = steps[step];
    const done = setupStepDone(step, recorded, live);
    const latch = reached && done && recorded.latched !== true && LATCHED_STEPS.includes(step);
    if (done !== recorded.done || latch) {
      const base = latch ? { ...recorded, latched: true } : recorded;
      steps[step] = done
        ? { ...base, done: true, at: base.at ?? now }
        : { ...base, done: false, at: base.skipped ? base.at : undefined };
    }
    reached = reached && (done || steps[step].skipped === true);
  }
  return { ...state, steps };
}

export function setupProgress(state: SetupState): { done: number; total: number } {
  return { done: SETUP_STEPS.filter((step) => state.steps[step].done).length, total: SETUP_STEPS.length };
}

/** The step the checklist is on: the first that is neither done nor passed
 *  over. Null when there is nothing left to present. */
export function nextSetupStep(state: SetupState): SetupStep | null {
  return SETUP_STEPS.find((step) => !state.steps[step].done && !state.steps[step].skipped) ?? null;
}

/**
 * Whether this install has never been set up, and may therefore be shown the
 * first run unasked.
 *
 * NOT "no step is done". Half the list is derived from things that are true
 * the moment the app opens on a brand new machine: the engine in the box
 * makes `agents` done before anybody has typed anything. Counting those would
 * say "this install has been set up" about an install that has done nothing.
 *
 * So the test is the opposite one: nothing recorded by a person, and no trace
 * of a workspace that has been USED. A restored backup trips every one of
 * these — it has answered turns, a saved key, connected apps and routines —
 * which is the case that matters most, because interrupting someone's
 * restored workspace with a welcome screen is the worst bug this flow has.
 */
export function setupIsFirstRun(state: SetupState, live: SetupLiveState): boolean {
  const untouched = SETUP_STEPS.every(
    (step) => !state.steps[step].skipped && (state.steps[step].note ?? "").trim().length === 0,
  );
  return untouched
    && live.ownerName.trim().length === 0
    && !live.botReplyExists
    && !live.flux.configured
    && (live.connectedApps ?? 0) === 0
    && live.routines.total === 0
    && live.crewSize === 0;
}

// ── what the card says ─────────────────────────────────────────────────
/**
 * What is stopping this step, when the answer is not "you have not done it".
 *
 * The wording stays deliberately neutral about WHY a provider refused
 * payment: the engine's own error card owns that explanation, and a second
 * copy of it here would be a second copy to get wrong.
 */
const PAYMENT_BLOCK: SetupStepBlock = {
  reason: "payment-required",
  message:
    "Your engine was refused on payment, so it cannot answer yet. Its own error card says what the provider "
    + "reported. Until that clears, use an engine you already pay for.",
};

/**
 * THE APPS HARD BLOCK, KEPT. It used to guard the standalone `apps` step,
 * which no longer exists; this is the same gate, exported, for the per-job
 * connect rows inside `flow` to call per app.
 *
 * It is why `flux` sorts to the front of a job's missing list: connecting
 * Gmail before there is a key produces a row that cannot be acted on, and the
 * person discovers that by pressing it.
 *
 * The unreadable case comes FIRST and stays distinct. "Your connected
 * accounts could not be read" is not "nothing is connected", and collapsing
 * the two would have the Chief cheerfully offering to connect an account the
 * person connected last week.
 */
export function connectedAppsBlock(live: SetupLiveState): SetupStepBlock | undefined {
  if (live.connectedAppIds === null || live.connectedApps === null) {
    return { reason: "apps-unreadable", message: "Your connected accounts could not be read, so this is unknown rather than empty." };
  }
  return fluxUsable(live)
    ? undefined
    : { reason: "flux-key-needed", message: "Your accounts connect through your key, so this one waits for that." };
}

export function setupStepBlock(
  step: SetupStep,
  recorded: SetupStepState,
  live: SetupLiveState,
): SetupStepBlock | undefined {
  if (setupStepDone(step, recorded, live)) return undefined;
  switch (step) {
    case "detect":
      // The engine in the box cannot run here at all: wrong architecture, a
      // binary that did not resolve. Distinct from having nothing to think
      // with, which is not a blockage of detection — it settles this step and
      // the Flux screen says so instead.
      return live.bundledEngine.ready
        ? undefined
        : {
            reason: "engine-unavailable",
            message:
              `The engine in the box cannot run on this system: ${live.bundledEngine.reason ?? "the shipped engine did not resolve"}. `
              + "Use an AI you already pay for, or a local model.",
          };
    case "flux":
      if (fluxRefusedOnPayment(live)) {
        return {
          reason: "payment-required",
          message:
            "Flux Router accepted this key and then refused a turn on payment. The key is saved and there is "
            + "nothing to paste again, because this is the account's spending rather than the key. What the key "
            + "unlocks stays locked until that clears.",
        };
      }
      return live.flux.conflict
        ? {
            reason: "flux-choice-needed",
            message:
              "More than one Flux Router key is saved and none has been chosen, so nothing is routing through "
              + "Flux yet. Pick the one to use on the Flux Router connection card.",
          }
        : undefined;
    case "chat":
      if (refusedOnPayment(live)) return PAYMENT_BLOCK;
      // THE BARE MACHINE, REPORTED WHERE IT BITES. Murage ships the engine,
      // not a brain, and on a computer with no key, no sign-in and no local
      // model within reach there is nothing behind it yet. The jobs are still
      // shown and each one says what it needs, which is the whole design of
      // this step; what is blocked is the answering, and saying so plainly is
      // the job, because a person told "you are set up" will not go looking
      // for the fix.
      return nothingToThinkWith(live) && !fluxUsable(live)
        ? {
            reason: "engine-needs-model",
            message:
              "The engine came in the box and has nothing to think with yet. One key turns it on. Any key does "
              + "it: a Flux Router one is what I would pick, and any OpenAI-style service you already pay for "
              + "works just as well.",
          }
        : undefined;
    case "flow":
      if (refusedOnPayment(live)) return PAYMENT_BLOCK;
      // Only the unreadable half of the apps gate belongs on the step. The
      // missing-key half is per job and per app, so it is asked for on the
      // row that needs it: a job that needs nothing connected must not be
      // reported as blocked because some other job would have been.
      return live.connectedAppIds === null || live.connectedApps === null
        ? connectedAppsBlock(live)
        : undefined;
    default:
      return undefined;
  }
}

/** Done wins; then the person's own decision to pass over; then a blockage;
 *  then simply outstanding. */
export function setupStepStatus(step: SetupStep, recorded: SetupStepState, live: SetupLiveState): SetupStepStatus {
  if (setupStepDone(step, recorded, live)) return "done";
  if (recorded.skipped) return "skipped";
  return setupStepBlock(step, recorded, live) ? "blocked" : "open";
}

/** Why an outstanding step is outstanding, in the words the card shows. A
 *  blocked step carries its block instead. */
export function setupStepDetail(step: SetupStep, recorded: SetupStepState, live: SetupLiveState): string | undefined {
  if (setupStepDone(step, recorded, live) || setupStepBlock(step, recorded, live)) return undefined;
  switch (step) {
    case "hello":
      return "I do not know what to call you yet.";
    case "detect":
      return "I have not told you what is on this computer yet.";
    case "flux":
      return live.flux.configured
        ? "The saved key is not in a shape Flux Router issues. Paste it again."
        : "One key turns on the latest models, your accounts and pictures.";
    case "chat":
      return "You have not asked me for anything yet.";
    case "flow":
      return "Nothing has been taken off your plate yet.";
    default:
      return undefined;
  }
}

// ── wire ───────────────────────────────────────────────────────────────
/** One step as the panel receives it. `status`, `block` and `detail` are
 *  computed per request from live state and never persisted. */
export interface SetupStepView extends SetupStepState {
  id: SetupStep;
  status: SetupStepStatus;
  block?: SetupStepBlock;
  detail?: string;
}

export interface SetupView {
  version: number;
  startedAt: number;
  chiefBotId?: string;
  /** What to call the person. "" until they say. */
  ownerName: string;
  /** The engine Murage ships, as this machine can run it. Reported whatever
   *  the Chief is currently on, so the agents card can name the included
   *  option and say plainly when it is not available here. */
  engine: SetupEngineReading;
  /** Engines this machine can run, bundled and found, so the Chief can open
   *  with an answer rather than a question. */
  agents: readonly SetupAgentReading[];
  /** Engines that are here and that nobody is signed in to, so the Chief can
   *  offer the sign-in instead of claiming them or pretending they are not
   *  there. Never counted as an agent: see `SetupLiveState.signedOutAgents`. */
  signedOutAgents: readonly SetupAgentReading[];
  /** Routines, and the morning brief's own state. */
  routines: SetupRoutineReading;
  /** Visible bots other than the Chief, for the "hire your first teammate"
   *  card: it is an offer on an empty bench and a nudge on a full one. */
  crewSize: number;
  /** Whether a saved key is routing. The key never leaves the server; this
   *  is the only thing the client is told about it. */
  fluxReady: boolean;
  /**
   * There is nothing on this computer to think with, so `detect` was skipped
   * and the Flux screen carries its framing.
   *
   * COMPUTED ONCE, HERE, rather than re-derived in the renderer. It decides
   * four separate things — whether detection is shown at all, which of two
   * openings the Flux screen uses, which status line the Chief opens with,
   * and whether EVERY job is tagged as needing Flux first — and four copies
   * of a predicate is four chances to write `state === "available"` instead
   * of `runnable()` and reintroduce c0e4eb13.
   *
   * Named for what it means. `isEmpty` would be a lie: the machine may be
   * full of engines that all report available and none of which can answer.
   */
  nothingToThinkWith: boolean;
  /**
   * Nothing on this computer can answer a question right now.
   *
   * THE JOB READINESS PREDICATE, AND IT IS NOT `nothingToThinkWith`. That one
   * counts a signed-out engine as something, which is correct for deciding
   * whether to run detection and wrong for deciding whether a job can be
   * done: an engine nobody is signed into cannot answer anything. See
   * `nothingCanAnswer`.
   */
  nothingCanAnswer: boolean;
  /**
   * Which of the first run's two connectable apps are connected, or null when
   * the connector store could not be read.
   *
   * Only the first-run set, not the whole connector list: this is what the
   * job tags need, and a view that shipped every connected service would be
   * answering a question nobody asked on a route documented as needing to
   * stay cheap.
   */
  connectedJobApps: readonly SetupJobApp[] | null;
  /** An install that has never been set up and has never been used. Only
   *  such an install is shown the first run without being asked. */
  firstRun: boolean;
  progress: { done: number; total: number };
  /** Steps that are neither done nor passed over, and are stopped by
   *  something the person did not do wrong. */
  blocked: SetupStep[];
  next: SetupStep | null;
  steps: SetupStepView[];
  /**
   * The guided first run is happening in the Chief's thread right now.
   *
   * NOT `firstRun`, and the difference is the whole reason this exists.
   * `firstRun` answers "has this install ever been set up", and one of the
   * traces it reads is a saved owner name, so it goes false at step one by
   * design. Anything that used it to decide whether the flow was STILL going
   * got one step of truth and then a lie: the checklist vanished after the
   * first answer, and nothing knew to keep looking for the next card.
   *
   * The server already had the honest answer and kept it to itself
   * (`conversationLive`, server/setup-conversation.ts): the welcome card is
   * in the thread, so the flow demonstrably started here and carries on until
   * there is nothing left to do.
   */
  conversationLive?: boolean;
}

export function setupView(state: SetupState, live: SetupLiveState): SetupView {
  const steps: SetupStepView[] = SETUP_STEPS.map((step) => {
    const recorded = state.steps[step];
    const block = setupStepBlock(step, recorded, live);
    const detail = setupStepDetail(step, recorded, live);
    return {
      id: step,
      ...recorded,
      status: setupStepStatus(step, recorded, live),
      ...(block ? { block } : {}),
      ...(detail ? { detail } : {}),
    };
  });
  return {
    version: state.version,
    startedAt: state.startedAt,
    ...(state.chiefBotId ? { chiefBotId: state.chiefBotId } : {}),
    ownerName: live.ownerName,
    engine: live.bundledEngine,
    agents: live.agents,
    signedOutAgents: live.signedOutAgents,
    routines: live.routines,
    crewSize: live.crewSize,
    fluxReady: fluxUsable(live),
    nothingToThinkWith: nothingToThinkWith(live),
    nothingCanAnswer: nothingCanAnswer(live),
    connectedJobApps: live.connectedAppIds === null
      ? null
      : SETUP_JOB_APPS.filter((app) => jobAppConnected(live, app)),
    firstRun: setupIsFirstRun(state, live),
    progress: setupProgress(state),
    blocked: steps.filter((step) => step.status === "blocked").map((step) => step.id),
    next: nextSetupStep(state),
    steps,
  };
}

export const setupAnswerRequestSchema = z.object({
  step: setupStepSchema,
  answer: z.string().min(1).max(SETUP_NOTE_MAX),
}).strict();
export const setupStepRequestSchema = z.object({ step: setupStepSchema }).strict();
