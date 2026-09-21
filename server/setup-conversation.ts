// What the Chief of Staff says next, and when.
//
// The 0.1.58 first run is a conversation, not a modal: every step arrives as
// an ordinary bot-authored card in the Chief's own thread. Something has to
// decide WHICH card is owed at this moment, and that decision is re-taken on
// every single read of `/api/setup` — a poll, a reload, a reopened window.
// So it lives here, as a pure function of the view and of what is already in
// the thread, with no I/O of any kind. A function that can only look and
// compare cannot double-post, cannot reorder itself under load, and can be
// tested without a server.
//
// Two rules do all the work:
//   1. A card has an identity (`setupCardKey`). A key already in the thread is
//      never emitted again. Same state in, nothing new out.
//   2. The flow is driven by `view.next`, which the server derives from live
//      state on every read. Nothing here measures anything.

import {
  type SetupCardVariant,
  setupCardKey,
} from "../shared/setup-card.ts";
import {
  SETUP_STEPS,
  type SetupStep,
  type SetupStepView,
  type SetupView,
} from "../shared/setup.ts";

/** A card the driver wants appended, with the plain sentences a transcript
 *  exported without the renderer still reads correctly by. The renderer owns
 *  the real wording; these are the fallback. */
export interface SetupCardPlan {
  step: SetupStep;
  variant: SetupCardVariant;
  key: string;
  title: string;
  subtitle: string;
}

export interface SetupConversationPlan {
  /** Cards to append, in the order a person should read them. */
  append: SetupCardPlan[];
  /** Keys of cards ALREADY in the thread that should now be shown settled. */
  settle: string[];
  /**
   * Keys of cards already in the thread that must be shown LIVE again.
   *
   * SETTLED USED TO BE A ONE-WAY LATCH AND THAT WAS RELEASE BLOCK #2. The
   * driver set `settled: true` and nothing in the tree ever set it back, so
   * "Something else" on the do-it card reopened `chat` on the checklist while
   * the jobs card above it stayed settled: five greyed-out rows, the escape
   * hatch hidden, and the server refusing to append a replacement because
   * `chat:jobs` was already claimed. The person had asked for another job and
   * there was nothing on screen that could take one.
   *
   * It is the same list as `settle`, read the other way round, so the
   * transcript says what the checklist says. `deriveSetupState` re-decides
   * every step from live state on every read and calls that the checklist
   * telling the truth; a card that cannot follow it back is a card that lies
   * on the way down.
   */
  unsettle: string[];
}

const NOTHING: SetupConversationPlan = { append: [], settle: [], unsettle: [] };

// THE CLOSING CARD IS PARKED WITH THE REST. It used to ride on the last step
// once `view.next` went null. The `flow` step now ends on the job's own
// result, which carries "take something else off my plate" and puts the
// person back at the jobs, so a separate "what would you like to do next?"
// would be a second ending to the same scene. The `next` variant and its copy
// stay in the tree; nothing emits them.

/**
 * The card that ASKED for each step.
 *
 * Only these are settled when their step finishes. `brief-ran` is a report of
 * something that already happened and `next` is the closing offer; neither is
 * an outstanding question, so neither is ever "settled".
 *
 * EXPORTED BECAUSE A CARD THAT ASKS MUST BE ANSWERABLE ON SCREEN, and that is
 * a claim about the renderer rather than about this file.
 * `FirstRunCard.test.ts` renders every variant in here and fails on one with
 * no live control, which is the exact shape of the block this list was edited
 * to close: the Flux step opened on `bare-needs-key`, a card of two sentences
 * and no button, and the only key box in the flow was on the card that
 * machine was never shown. The two halves meet here, so moving the dead end
 * back into a step fails one side or the other.
 */
export const SETUP_ASK_VARIANTS: Record<SetupStep, readonly SetupCardVariant[]> = {
  hello: ["welcome"],
  // Detection is a REPORT, not a question, and it settles when it has been
  // read rather than when something was chosen. It is here all the same so
  // that a read card is shown settled instead of sitting open forever.
  detect: ["found", "bare", "signed-out"],
  // `bare-needs-key` is NOT here, and its absence is the park rather than an
  // omission: nothing emits it, so nothing can be waiting on it, and a parked
  // card in an upgrading person's transcript renders settled on sight.
  flux: ["key"],
  chat: ["jobs"],
  flow: ["do-it"],
};

/**
 * Every word a person can read here obeys the release's copy rules: no em
 * dashes, nothing about what anything costs, the connected-app catalog is
 * "500+ apps" named by example, and Flux Router leads with routing. Three
 * sentences is the ceiling and one is usually better.
 *
 * EXPORTED BECAUSE THE RULES ARE CHECKED OVER IT, AND WERE NOT.
 *
 * The copy gate used to walk src/lib/first-run-copy.ts alone, and these
 * sentences are rendered into the person's transcript exactly as visibly. A
 * reviewer put "Talk to me and I will answer out loud." on the jobs card and
 * the whole suite stayed green. This map is now a registered first-run
 * surface (src/lib/first-run-surfaces.ts) and every house rule runs over it.
 */
export const SETUP_CARD_COPY: Record<SetupCardVariant, { title: string; subtitle: string }> = {
  welcome: {
    title: "Hello",
    subtitle: "I am your Chief of Staff. Tell me what to call you and I will get the rest ready.",
  },
  found: {
    title: "You already had help on this computer",
    subtitle: "I found the AI tools that were here and connected them. Nothing to install.",
  },
  bare: {
    title: "There is one in the box",
    subtitle: "Murage brought its own AI with it, so you are ready without installing anything.",
  },
  /**
   * THIS ENTRY WAS MISSING ONCE AND THE BLANK MACHINE IS THE PATH THAT
   * NEEDED IT.
   *
   * The old `plan()` built its block with `...SETUP_CARD_COPY[variant]`, and
   * spreading `undefined` is a silent no-op in JS, so a machine with no
   * agents produced a card with no title and no subtitle at all. Only the
   * server typecheck saw it, and the server typecheck was not being run. That
   * class of mistake is now impossible twice over: this map is an exhaustive
   * `Record<SetupCardVariant, …>`, and `setupCardCopy` below THROWS rather than
   * spreading a hole. A test executes it for every variant.
   *
   * IT IS PARKED NOW, and the copy stays because the card stays readable in
   * the transcript of anybody who was handed one. Nothing plans it: the Flux
   * step opens on `key` on every machine, and the card says this same thing
   * itself on a blank one, above a button that can act on it. A variant whose
   * card has no controls must never be what a step opens with, which is
   * exactly the hole it left here.
   */
  "bare-needs-key": {
    title: "Your bots need a brain first",
    subtitle: "Murage came with an engine. It did not come with anything to think with, and there is nothing on this computer I can use. One connection fixes that, and it is the same one your apps run through.",
  },
  "signed-out": {
    title: "You are not signed in to it yet",
    subtitle: "There is an AI tool on this computer that nobody is signed in to. Sign in and it is yours to use in here.",
  },
  "sample-brief": {
    title: "This is what tomorrow morning could look like",
    subtitle: "A made up day, so you can see the shape of it. Yours would be built from what you have just connected.",
  },
  key: {
    title: "Get the right answer faster",
    subtitle:
      "You should not have to know which AI is good at what. Flux Router picks for you, every time you ask. "
      + "The same key opens 500+ apps and pictures in the chat.",
  },
  "no-key": {
    title: "Not now, then",
    subtitle: "We carry on with what is already on this computer. You can add the key whenever you like.",
  },
  jobs: {
    title: "What can I take off your plate?",
    subtitle: "Pick one and I will do it now. I only ask for what that job needs, when it needs it.",
  },
  "do-it": {
    title: "On it",
    subtitle: "Everything this job needs is on one screen, and you can stop after any of it.",
  },
  apps: {
    title: "Where your work actually lives",
    subtitle: "Connect Gmail, Slack, Notion or GitHub and I can work on what is inside them.",
  },
  brief: {
    title: "Your morning brief",
    subtitle:
      "Pick a time. I will go through the calendar, what came in overnight and anything that moved, "
      + "then boil it down to a few lines.",
  },
  "brief-ran": {
    title: "It has already run",
    subtitle: "Here is your brief, so you can see it working rather than take my word for it.",
  },
  "more-routines": {
    title: "A couple more",
    subtitle:
      "Most people keep two or three. I can sort your inbox and draft the replies for you to approve, "
      + "or keep an eye on one thing and speak up when it changes.",
  },
  next: {
    title: "What would you like to do next?",
    subtitle: "That is you set up. Ask me for anything, or just tell me what is on today.",
  },
  phone: {
    title: "Your phone, in your pocket",
    subtitle: "Scan this and you can reach me from your phone.",
  },
  "phone-needs-tailscale": {
    title: "Your phone needs one more thing",
    subtitle: "Your phone cannot find this computer yet. I can set that up for you.",
  },
};

/**
 * The words for one card, or a throw.
 *
 * THE LOOKUP THROWS ON PURPOSE. `plan()` used to spread `SETUP_CARD_COPY[variant]`
 * straight into its block, and a missing entry spreads as nothing at all, so
 * a card with no title and no subtitle reached a person's transcript in
 * silence. `SETUP_CARD_COPY` is an exhaustive `Record` and the compiler will catch
 * the next hole — but that was true when the hole shipped, because the server
 * typecheck was not being run. A map lookup that cannot fail quietly is the
 * belt to that braces, and `setup-conversation.test.ts` executes this for
 * every variant in `SETUP_CARD_VARIANTS` rather than reading the source.
 */
export function setupCardCopy(variant: SetupCardVariant): { title: string; subtitle: string } {
  const copy = SETUP_CARD_COPY[variant] as { title: string; subtitle: string } | undefined;
  if (!copy?.title?.trim() || !copy.subtitle?.trim()) {
    throw new Error(`First-run card "${variant}" has no copy. Add it to SETUP_CARD_COPY.`);
  }
  return copy;
}

function plan(step: SetupStep, variant: SetupCardVariant): SetupCardPlan {
  return { step, variant, key: setupCardKey(step, variant), ...setupCardCopy(variant) };
}

/** The variant the step the flow is ON should open with, chosen from live
 *  detection rather than guessed. Never returns a parked variant. */
function variantForCurrentStep(step: SetupStep, view: SetupView): SetupCardVariant {
  switch (step) {
    case "hello":
      return "welcome";
    case "detect":
      // "I found three agents" on a machine with nothing on it is the kind of
      // small lie that costs the first hour its credibility.
      if (view.agents.some((agent) => agent.installed)) return "found";
      // An engine that is HERE and signed out beats the bare card, and the
      // ordering is an economic decision as much as an honest one. `bare` is
      // reached with a keyed engine in the box, which IS usable, so nothing
      // is broken. But that person has a subscription sitting one command
      // away on their own computer, and saying nothing would quietly leave
      // them on a metered router while they pay for a flat rate elsewhere.
      // That is the mistake 3c9770f1 reverted in `pickDefaultEngine`,
      // arriving through a different door.
      //
      // Below `found`, though. If something usable really was found, a second
      // engine nobody signed into is noise, and the first run has no room for
      // noise.
      //
      // `bare-needs-key` IS NOT REACHABLE HERE, and it is no longer reachable
      // anywhere: a machine with nothing to think with has
      // `nothingToThinkWith` true, so `detect` is already settled and the
      // flow never stops on it, and the Flux step now opens on the one card
      // that can actually take a key. The variant is PARKED.
      return view.signedOutAgents.length > 0 ? "signed-out" : "bare";
    case "flux":
      // ONE CARD, AND IT FRAMES ITSELF.
      //
      // THE DEAD END THIS REPLACES. This used to hand the blank machine
      // `bare-needs-key`, which routes to a card with two sentences on it and
      // NO CONTROL OF ANY KIND. The only `saveFluxKey` and the only
      // `skipSetupStep("flux")` in the flow live on `FirstRunFluxCard`, and
      // that card was shown only when `nothingToThinkWith` was FALSE, so the
      // one machine that cannot leave this step without a key was the one
      // machine never offered a way to enter one. `setupStepDone("flux")`
      // wants a real saved key (shared/setup.ts), so the flow stopped there
      // for ever, reading "One key sorts that, and it is the next thing I
      // will ask you for" with nothing following it. It is the original
      // audit's release block #1, which moved from `agents` to `flux` with
      // the re-cut and did not get fixed on the way.
      //
      // The blank machine's framing was never the missing thing: the card
      // already reads `view.nothingToThinkWith` itself and swaps its heading,
      // its lead, its status line and its dismiss wording (`noBrain` in
      // FirstRunFluxCard.tsx). Choosing a DIFFERENT CARD to say the same
      // thing was what cost the person the controls. So the step opens on one
      // card on every machine and the card decides how it speaks.
      return "key";
    case "chat":
      return "jobs";
    case "flow":
      return "do-it";
  }
}

const stepView = (view: SetupView, step: SetupStep): SetupStepView | undefined =>
  view.steps.find((entry) => entry.id === step);

/**
 * Whether this thread is in the guided first run at all.
 *
 * `view.firstRun` is the gate on STARTING. It has to be, because it is the
 * only thing that tells a restored backup apart from a brand new machine, and
 * interrupting somebody's restored workspace with a welcome card is the worst
 * bug this flow has.
 *
 * It cannot also be the gate on CONTINUING, and this is not a loophole: the
 * first run's own first step is to learn the person's name, and a saved name
 * is one of the traces `setupIsFirstRun` reads as "this workspace has been
 * used". The flag therefore goes false the moment the flow works, by design.
 * So a thread that already carries the opening card is a thread the flow
 * demonstrably started in, and it carries on. An install that never got that
 * card never gets any of them.
 */
export function conversationLive(view: SetupView, present: ReadonlySet<string>): boolean {
  return view.firstRun || present.has(setupCardKey("hello", "welcome"));
}

/**
 * The cards owed right now.
 *
 * Called on every read of the setup view, so it MUST be idempotent: the only
 * thing that makes it emit anything is a key that is not in `present` yet.
 */
export function setupConversationPlan(
  view: SetupView,
  present: ReadonlySet<string>,
): SetupConversationPlan {
  if (!conversationLive(view, present)) return NOTHING;

  const wanted: SetupCardPlan[] = [];

  // WHAT IS ALREADY HERE, SAID ONCE, AS SOON AS THE GREETING IS BEHIND US.
  //
  // Skipped entirely on a machine with nothing to think with. There is no
  // honest "here is what I found" to write for that machine, so detection is
  // settled before it is presented and the Flux card carries the report
  // instead. That is the release's skip predicate doing its one job, and it
  // rests on `runnable()` rather than on an engine reporting itself
  // available: Murage ships the Fuigo binary, so a bare machine ALWAYS has
  // something calling itself available with an empty catalogue.
  //
  // It cannot ride on `view.next` alone even when it is shown. It is a report
  // rather than a question, and it is owed the moment the flow gets past
  // hello; when it is genuinely outstanding, `view.next` IS `detect` and the
  // same key covers both.
  //
  // AND IT READS THE LATCH, NOT ONLY THE LIVE PREDICATE. `nothingToThinkWith`
  // is a fact about the machine RIGHT NOW, and it goes false the moment a
  // Flux key fills the shipped engine's catalogue. A blank machine that has
  // been past this step and then bought a key would otherwise arrive here
  // with the predicate false and the step latched done, and be handed a
  // detection card for the first time, after the flow had moved on. A step
  // the flow has been past is never re-opened, and it is never re-reported.
  const hello = stepView(view, "hello");
  const detect = stepView(view, "detect");
  if (
    (hello?.done === true || hello?.skipped === true)
    && !view.nothingToThinkWith
    && detect?.latched !== true
  ) {
    wanted.push(plan("detect", variantForCurrentStep("detect", view)));
  }

  // A step passed over says so once, in the person's own transcript. The flow
  // has already moved past `flux` by the time this is true, so it cannot ride
  // on `view.next`.
  if (stepView(view, "flux")?.skipped === true) wanted.push(plan("flux", "no-key"));

  // The brief cards, the apps step and the closing card used to be planned
  // here. They are PARKED, not deleted: `brief-ran`, `sample-brief`, `apps`,
  // `more-routines`, `next`, `phone` and `phone-needs-tailscale` still exist
  // as variants with their copy intact, and nothing emits them. The morning
  // brief is now an outcome of the `brief` job rather than a checklist row,
  // and its "every morning?" offer arrives on that job's own result, where
  // the person has just seen one.

  if (view.next !== null) wanted.push(plan(view.next, variantForCurrentStep(view.next, view)));

  // SETTLED FOLLOWS THE STEP, IN BOTH DIRECTIONS. A step that is finished
  // shows its card settled; a step that is outstanding shows its card live,
  // including one that WAS finished and has been put back. Deciding both here
  // is what stops the two halves disagreeing: the old code emitted only the
  // settling half, so a reopened step left its card greyed out for ever.
  const settle: string[] = [];
  const unsettle: string[] = [];
  for (const step of SETUP_STEPS) {
    const entry = stepView(view, step);
    const finished = entry !== undefined && (entry.done || entry.skipped === true);
    for (const variant of SETUP_ASK_VARIANTS[step]) {
      const key = setupCardKey(step, variant);
      if (!present.has(key)) continue;
      (finished ? settle : unsettle).push(key);
    }
  }

  // One card per key, within this plan as well as against the thread: the
  // detection report and the detection step can both ask for the same card.
  const append: SetupCardPlan[] = [];
  const claimed = new Set(present);
  for (const card of wanted) {
    if (claimed.has(card.key)) continue;
    claimed.add(card.key);
    append.push(card);
  }
  return { append, settle, unsettle };
}
