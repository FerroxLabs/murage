import { z } from "zod";

// Guided first run — the frozen contract for 0.1.57.
//
// The SERVER owns the list, the order and every step's `done`. A model may
// add a sentence of personality between cards; it never decides that a step
// is finished. Every `done` in here is DERIVED from live state on every
// read, so re-running `/setup` on a working install shows the finished steps
// as finished and reinstalls nothing.

/** The eight steps, in the order they are presented. `flux` is always first:
 *  the key unlocks the included brain and the connected apps, so it is asked
 *  before anything else. */
export const SETUP_STEPS = ["flux", "purpose", "brain", "crew", "apps", "first-task", "voice", "wrap"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const setupStepSchema = z.enum(SETUP_STEPS);

/** An answer is a short note, not a document: it is persisted, echoed back to
 *  the panel and shown to the user. Longer material belongs in the thing the
 *  step configures (MEMORY.md, a bot profile), never in the checklist. */
export const SETUP_NOTE_MAX = 500;

/** The crew step's "just one assistant" choice, recorded as the step's note.
 *  The one note value the server reads rather than merely stores. */
export const SETUP_SOLO_CREW = "just-one-assistant";

export const SETUP_STATE_VERSION = 1;

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
  flux: setupStepStateSchema,
  purpose: setupStepStateSchema,
  brain: setupStepStateSchema,
  crew: setupStepStateSchema,
  apps: setupStepStateSchema,
  "first-task": setupStepStateSchema,
  voice: setupStepStateSchema,
  wrap: setupStepStateSchema,
}).strict();

export const setupStateSchema = z.object({
  version: z.literal(SETUP_STATE_VERSION),
  startedAt: z.number().int().nonnegative(),
  steps: setupStepsSchema,
  /** The bot the person first met. It is the Chief of Staff and hosts setup;
   *  a crew installed later reports to it and never replaces it. */
  chiefBotId: z.string().min(1).max(180).optional(),
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
  /** The Chief's MEMORY.md holds something other than the seed template. */
  chiefMemoryWritten: boolean;
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
export const SETUP_BLOCK_REASONS = ["payment-required", "engine-unavailable", "apps-unreadable", "flux-choice-needed"] as const;
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
 * Five of the eight read live state alone, so answering them cannot make them
 * true. `purpose` and `voice` have nothing outside the answer to measure;
 * `wrap` needs both the confirmation and the lines actually on disk; and
 * `crew` takes a deliberate "just one assistant" as an answer to a question
 * whose other answer is a bot that exists.
 */
export function setupStepDone(step: SetupStep, recorded: SetupStepState, live: SetupLiveState): boolean {
  switch (step) {
    case "flux":
      // A saved, well-shaped key is not the same as a key that can buy a
      // token. When Flux Router itself has refused a turn on payment, this
      // step is NOT done — it is blocked, with the key kept exactly as it
      // is, because the key is right and the spending is not. Several saved
      // keys with none chosen is not done either: nothing is routing yet.
      return live.flux.configured
        && live.flux.looksValid
        && !live.flux.conflict
        && !fluxRefusedOnPayment(live);
    case "purpose":
      return setupStepAnswered(recorded);
    case "brain":
      // Not "an engine is selected" and not "some engine answered": the
      // Chief's OWN selection is the one that has to work, because that is
      // what every channel and every teammate hand-off will use. A model
      // picked for one task only does not qualify.
      return live.chiefInstanceId !== "" && live.chiefAnsweredBy.includes(live.chiefInstanceId);
    case "crew":
      return live.crewSize >= 1 || (setupStepAnswered(recorded) && recorded.note?.trim() === SETUP_SOLO_CREW);
    case "apps":
      return (live.connectedApps ?? 0) >= 1;
    case "first-task":
      return live.botReplyExists;
    case "voice":
      return setupStepAnswered(recorded);
    case "wrap":
      return setupStepAnswered(recorded) && live.chiefMemoryWritten;
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
      "Your Chief's engine was refused on payment, so it cannot answer yet. Its own error card says what the " +
      "provider reported. Until that clears, use an engine you already pay for.",
  };
  switch (step) {
    case "flux":
      if (fluxRefusedOnPayment(live)) {
        return {
          reason: "payment-required",
          message:
            "Flux Router accepted this key and then refused a turn on payment. The key is saved and there is " +
            "nothing to re-paste — this is the account's spending, not the key — but the included brain and " +
            "the connected apps cannot answer until it clears.",
        };
      }
      return live.flux.conflict
        ? {
            reason: "flux-choice-needed",
            message:
              "More than one Flux Router key is saved and none has been chosen, so nothing is routing through " +
              "Flux yet. Pick the one to use on the Flux Router connection card.",
          }
        : undefined;
    case "brain":
      if (refusedOnPayment(live)) return payment;
      return live.chiefInstanceId === "" && !live.bundledEngine.ready
        ? {
            reason: "engine-unavailable",
            message:
              `The included brain cannot run on this system: ${live.bundledEngine.reason ?? "the shipped engine did not resolve"}. ` +
              "Use the AI you already pay for, or a local model.",
          }
        : undefined;
    case "first-task":
      return refusedOnPayment(live) ? payment : undefined;
    case "apps":
      return live.connectedApps === null
        ? { reason: "apps-unreadable", message: "Connected apps could not be read, so this is unknown rather than empty." }
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
    case "flux":
      return live.flux.configured
        ? "The saved Flux Router key is not in a shape Flux Router issues — paste it again."
        : "No Flux Router key is saved. The included brain and the connected apps stay locked without one.";
    case "brain":
      return live.chiefInstanceId === ""
        ? "Your Chief has no engine selected yet."
        : "Your Chief has an engine, but it has not answered yet. Say hello to prove it can.";
    case "crew":
      return "No bots beyond your Chief yet.";
    case "apps":
      return "No apps are connected yet.";
    case "first-task":
      return "No bot has produced a real reply yet.";
    case "wrap":
      return live.chiefMemoryWritten
        ? "Confirm the lines your Chief will remember."
        : "Your Chief's notebook is still empty.";
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
  /** The engine Murage ships, as this machine can run it. Reported whatever
   *  the Chief is currently on, so the brain card can name the included
   *  option and say plainly when it is not available here. */
  engine: SetupEngineReading;
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
    engine: live.bundledEngine,
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
