import { z } from "zod";

// Guided first run — the frozen contract for 0.1.58.
//
// The SERVER owns the list, the order and every step's `done`. A model may
// add a sentence of personality between cards; it never decides that a step
// is finished. Every `done` in here is DERIVED from live state on every
// read, so re-running `/setup` on a working install shows the finished steps
// as finished and reinstalls nothing.
//
// 0.1.58 re-cut the list. 0.1.57 asked eight questions in a modal; this one
// answers as many as it can before it asks anything, and what remains is six
// steps in the order the person experiences them: say hello, see what is
// already on the machine, unlock the rest with one key, connect the accounts
// the work actually lives in, get one useful thing running, then add a
// couple more. Detection comes first everywhere: a question whose answer is
// already on the machine is a question that should never have been asked.

/** The six steps, in the order they are presented. */
export const SETUP_STEPS = ["hello", "agents", "flux", "apps", "brief", "routines"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const setupStepSchema = z.enum(SETUP_STEPS);

/** An answer is a short note, not a document: it is persisted, echoed back to
 *  the panel and shown to the user. Longer material belongs in the thing the
 *  step configures (MEMORY.md, a bot profile), never in the checklist. */
export const SETUP_NOTE_MAX = 500;

/** How many routines count as "a couple more" beyond the morning brief. The
 *  brief is one of them, so the routines step asks for one more thing, not
 *  two. */
export const SETUP_ROUTINES_TARGET = 2;

export const SETUP_STATE_VERSION = 2;

export const setupStepStateSchema = z.object({
  done: z.boolean(),
  /** When the step last became done, or was skipped. Absent while it is open. */
  at: z.number().int().nonnegative().optional(),
  /** Passed over deliberately. Skipped is NOT done — the checklist moves on
   *  and says plainly that the step is still outstanding. */
  skipped: z.boolean().optional(),
  /** What the person answered. Recorded, never trusted as proof of `done`. */
  note: z.string().max(SETUP_NOTE_MAX).optional(),
}).strict();
export type SetupStepState = z.infer<typeof setupStepStateSchema>;

const setupStepsSchema = z.object({
  hello: setupStepStateSchema,
  agents: setupStepStateSchema,
  flux: setupStepStateSchema,
  apps: setupStepStateSchema,
  brief: setupStepStateSchema,
  routines: setupStepStateSchema,
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

/** A Flux key is saved, well shaped and unambiguous. The apps step needs one
 *  before it can offer anything, so it reads this rather than forming its own
 *  opinion of the flux step. */
export function fluxUsable(live: SetupLiveState): boolean {
  return live.flux.configured && live.flux.looksValid && !live.flux.conflict;
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

/** A step counts as answered when a non-empty note was recorded for it and
 *  it was not subsequently passed over. */
export function setupStepAnswered(recorded: SetupStepState): boolean {
  return recorded.skipped !== true && (recorded.note ?? "").trim().length > 0;
}

/**
 * The one place a step's `done` is decided.
 *
 * Five of the six read live state alone, so answering them cannot make them
 * true. `hello` is the exception, and only half an exception: a saved profile
 * name is a live fact read back from config, and the recorded answer only
 * covers the person who gave a name and then cleared it.
 *
 * `brief` is the rule this release exists to enforce. A scheduled routine is
 * a promise; the step is done when the brief has actually RUN once, because
 * configured is not the same as working and the whole point of the first run
 * is that the person SEES the thing work before they are left alone with it.
 */
export function setupStepDone(step: SetupStep, recorded: SetupStepState, live: SetupLiveState): boolean {
  switch (step) {
    case "hello":
      return live.ownerName.trim().length > 0 || setupStepAnswered(recorded);
    case "agents":
      // Not "an engine is configured": an engine this machine can RUN. On a
      // bare machine that is the one in the box, which is why this is
      // normally already true by the time anybody reads it.
      return live.agents.length >= 1;
    case "flux":
      // A saved, well-shaped key is not the same as a key that can buy a
      // token. When Flux Router itself has refused a turn on payment, this
      // step is NOT done — it is blocked, with the key kept exactly as it
      // is, because the key is right and the spending is not. Several saved
      // keys with none chosen is not done either: nothing is routing yet.
      return fluxUsable(live) && !fluxRefusedOnPayment(live);
    case "apps":
      return (live.connectedApps ?? 0) >= 1;
    case "brief":
      return live.routines.briefId !== null && live.routines.briefRan;
    case "routines":
      return live.routines.total >= SETUP_ROUTINES_TARGET;
  }
}

/** Re-derive every step. `at` marks when a step last became done; it is
 *  dropped again the moment the live state behind it goes away, so a stale
 *  timestamp can never make a step look finished. */
export function deriveSetupState(state: SetupState, live: SetupLiveState, now: number): SetupState {
  const steps = { ...state.steps };
  for (const step of SETUP_STEPS) {
    const recorded = steps[step];
    const done = setupStepDone(step, recorded, live);
    if (done === recorded.done) continue;
    steps[step] = done
      ? { ...recorded, done: true, at: recorded.at ?? now }
      : { ...recorded, done: false, at: recorded.skipped ? recorded.at : undefined };
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
export function setupStepBlock(
  step: SetupStep,
  recorded: SetupStepState,
  live: SetupLiveState,
): SetupStepBlock | undefined {
  if (setupStepDone(step, recorded, live)) return undefined;
  const payment: SetupStepBlock = {
    reason: "payment-required",
    message:
      "Your engine was refused on payment, so it cannot answer yet. Its own error card says what the provider "
      + "reported. Until that clears, use an engine you already pay for.",
  };
  const needsKey: SetupStepBlock = {
    reason: "flux-key-needed",
    message: "Your accounts connect through your key, so this one waits for that.",
  };
  switch (step) {
    case "agents":
      if (!live.bundledEngine.ready) {
        return {
          reason: "engine-unavailable",
          message:
            `The engine in the box cannot run on this system: ${live.bundledEngine.reason ?? "the shipped engine did not resolve"}. `
            + "Use an AI you already pay for, or a local model.",
        };
      }
      // THE BARE MACHINE. The engine is here and has nothing to think with:
      // Murage ships the engine, not a brain, and on a computer with no key,
      // no sign-in and no local model within reach there is nothing behind it
      // yet. Saying so plainly is the whole job, because the fix is the very
      // next card and a person who is told "you are set up" will not go
      // looking for it.
      return live.agents.length === 0
        ? {
            reason: "engine-needs-model",
            message:
              "The engine came in the box and has nothing to think with yet. One key turns it on, and it is the "
              + "next thing I will ask you for. Any key does it: a Flux Router one is what I would pick, and any "
              + "OpenAI-style service you already pay for works just as well.",
          }
        : undefined;
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
    case "apps":
      if (live.connectedApps === null) {
        return { reason: "apps-unreadable", message: "Your connected accounts could not be read, so this is unknown rather than empty." };
      }
      return fluxUsable(live) ? undefined : needsKey;
    case "brief":
      if (refusedOnPayment(live)) return payment;
      return live.agents.length === 0
        ? {
            reason: "engine-unavailable",
            message: "Nothing here can think yet, so there is nobody to write your brief.",
          }
        : undefined;
    case "routines":
      return refusedOnPayment(live) ? payment : undefined;
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
    case "flux":
      return live.flux.configured
        ? "The saved key is not in a shape Flux Router issues. Paste it again."
        : "One key turns on the latest models, your accounts, pictures and voice.";
    case "apps":
      return "None of your accounts are connected yet.";
    case "brief":
      return live.routines.briefId === null
        ? "Your morning brief is not set up yet."
        : "Your morning brief is set up and has not run yet.";
    case "routines":
      return "One routine so far. Most people keep two or three.";
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
  /** Routines, and the morning brief's own state. */
  routines: SetupRoutineReading;
  /** Visible bots other than the Chief, for the "hire your first teammate"
   *  card: it is an offer on an empty bench and a nudge on a full one. */
  crewSize: number;
  /** Whether a saved key is routing. The key never leaves the server; this
   *  is the only thing the client is told about it. */
  fluxReady: boolean;
  /** An install that has never been set up and has never been used. Only
   *  such an install is shown the first run without being asked. */
  firstRun: boolean;
  progress: { done: number; total: number };
  /** Steps that are neither done nor passed over, and are stopped by
   *  something the person did not do wrong. */
  blocked: SetupStep[];
  next: SetupStep | null;
  steps: SetupStepView[];
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
    routines: live.routines,
    crewSize: live.crewSize,
    fluxReady: fluxUsable(live),
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
