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
}

const NOTHING: SetupConversationPlan = { append: [], settle: [] };

/**
 * The closing card is not a checklist row. It belongs to the flow, so it
 * rides on the last step, exactly as `shared/setup-card.ts` says.
 */
const CLOSING_STEP: SetupStep = SETUP_STEPS[SETUP_STEPS.length - 1];

/**
 * The card that ASKED for each step.
 *
 * Only these are settled when their step finishes. `brief-ran` is a report of
 * something that already happened and `next` is the closing offer; neither is
 * an outstanding question, so neither is ever "settled".
 */
const ASK_VARIANTS: Record<SetupStep, readonly SetupCardVariant[]> = {
  hello: ["welcome"],
  agents: ["found", "bare", "bare-needs-key", "signed-out"],
  flux: ["key"],
  apps: ["apps"],
  brief: ["brief"],
  routines: ["more-routines"],
};

/**
 * Every word a person can read here obeys the release's copy rules: no em
 * dashes, nothing about what anything costs, the connected-app catalog is
 * "500+ apps" named by example, and Flux Router leads with routing. Three
 * sentences is the ceiling and one is usually better.
 */
const CARD_COPY: Record<SetupCardVariant, { title: string; subtitle: string }> = {
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
   * THIS ENTRY WAS MISSING AND THE BLANK MACHINE IS THE PATH THAT NEEDED IT.
   *
   * `asked()` builds its block with `...CARD_COPY[variant]`, and spreading
   * `undefined` is a silent no-op in JS, so a machine with no agents produced
   * a card with no title and no subtitle at all. Only the server typecheck saw
   * it, and the server typecheck was not being run.
   *
   * The words match `FIRST_RUN_COPY.agents["bare-needs-key"]` in the renderer
   * on purpose: the same card must not say two different things depending on
   * which half of the app you read. And it must not say what `bare` above
   * says, because on this machine "you are ready" is false.
   */
  "bare-needs-key": {
    title: "I came with the engine",
    subtitle: "There was nothing else on this computer to connect, and nothing to think with yet. One key sorts that, and it is the next thing I will ask you for.",
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
    title: "One key turns the rest on",
    subtitle:
      "Flux Router gives you all the latest AI models, with smart routing that sends each job to the best one. "
      + "The same key unlocks 500+ apps, pictures, voice and transcription.",
  },
  "no-key": {
    title: "Not now, then",
    subtitle: "We carry on with what is already on this computer. You can add the key whenever you like.",
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

function plan(step: SetupStep, variant: SetupCardVariant): SetupCardPlan {
  return { step, variant, key: setupCardKey(step, variant), ...CARD_COPY[variant] };
}

/** The variant the step the flow is ON should open with, chosen from live
 *  detection rather than guessed. */
function variantForCurrentStep(step: SetupStep, view: SetupView): SetupCardVariant {
  switch (step) {
    case "hello":
      return "welcome";
    case "agents":
      // "I found three agents" on a machine with nothing on it is the kind of
      // small lie that costs the first hour its credibility. So is "the one
      // in the box is already running" on a machine where it has nothing to
      // think with, which is every bare install before a key exists.
      if (view.agents.some((agent) => agent.installed)) return "found";
      // An engine that is HERE and signed out beats both bare cards, and the
      // ordering is an economic decision as much as an honest one.
      //
      // Above `bare-needs-key` is obvious: a sign-in is what is missing, not a
      // key, and sending that person to buy something would be wrong.
      //
      // Above plain `bare` is the one worth stating. `bare` is reached with a
      // keyed Fuigo running, which IS usable, so nothing is broken. But that
      // person has a subscription sitting one command away on their own
      // computer, and saying nothing would quietly leave them on a metered
      // router while they pay for a flat rate elsewhere. That is the mistake
      // 3c9770f1 reverted in `pickDefaultEngine`, arriving through a different
      // door.
      //
      // Below `found`, though. If something usable really was found, a second
      // engine nobody signed into is noise, and the first run has no room for
      // noise.
      if (view.signedOutAgents.length > 0) return "signed-out";
      return view.agents.length === 0 ? "bare-needs-key" : "bare";
    case "flux":
      return "key";
    case "apps":
      return "apps";
    case "brief":
      return "brief";
    case "routines":
      return "more-routines";
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

  // What this machine can already run, said once, as soon as the greeting is
  // behind us.
  //
  // This card cannot ride on `view.next` alone. `agents` is done whenever a
  // single engine is runnable, and on almost every machine that is true before
  // anybody has typed anything, because Murage ships one. `view.next` would
  // therefore skip straight past it and the person would never be told what
  // was found. It is a report rather than a question, like the brief that ran,
  // so it is owed the moment the flow gets past hello. When there is genuinely
  // no engine, `view.next` IS `agents` and the same key covers both.
  const hello = stepView(view, "hello");
  if (hello?.done === true || hello?.skipped === true) {
    wanted.push(plan("agents", variantForCurrentStep("agents", view)));
  }

  // A step passed over says so once, in the person's own transcript. The flow
  // has already moved past `flux` by the time this is true, so it cannot ride
  // on `view.next`.
  if (stepView(view, "flux")?.skipped === true) wanted.push(plan("flux", "no-key"));

  // The release's central rule, in card form: a scheduled routine is a
  // promise, a routine that has run is proof. `brief` is done only once a run
  // completed, so this card can only appear after the person saw it work.
  // KEYED ON THE RUN, NOT ON THE STEP.
  //
  // It used to read the step's `done`, which was the same thing while the
  // step required a completed run. It no longer does: the flow stopped
  // waiting for the brief so that approving its tool calls could happen in
  // the background. Left as it was, "it has already run" would appear the
  // moment the brief was merely scheduled, which is the exact claim this
  // release exists to stop making.
  if (view.routines.briefRan) wanted.push(plan("brief", "brief-ran"));

  // SHOW BEFORE ASKING, AND SHOW IT NEXT TO THE THING IT IS ASKING FOR.
  //
  // Both cross-research models, independently, proposed the same thing: put a
  // real brief in front of the person BEFORE the key card, rendered from
  // example data. It answers "what does this actually do" with the thing
  // itself rather than a sentence about it, and it turns the next card from a
  // request into an offer they can already see the point of.
  //
  // It sat on the FLUX step first, which put a rendered brief four cards away
  // from the ask it motivates and one card ahead of a request for a key. The
  // owner's objection is the right one: a brief is made of a calendar and a
  // mailbox, so showing one to somebody who has not connected either is
  // showing them a thing they cannot have, and it argues for the wrong
  // purchase. It belongs immediately before "shall I do this every morning?",
  // after the connections that make it real.
  //
  // It can sit ahead of that ask precisely because it costs nothing to
  // produce: no model call, no network, no key. There is no free allowance to
  // abuse because nothing is spent.
  //
  // A report rather than a question, like the agents card and the brief that
  // ran, so it is deliberately NOT in ASK_VARIANTS and never settles. It stays
  // in the transcript afterwards, which is the point: it is their template.
  if (view.next === "brief") wanted.push(plan("brief", "sample-brief"));

  if (view.next !== null) wanted.push(plan(view.next, variantForCurrentStep(view.next, view)));
  else wanted.push(plan(CLOSING_STEP, "next"));

  const settle: string[] = [];
  for (const step of SETUP_STEPS) {
    const entry = stepView(view, step);
    if (!entry || (!entry.done && !entry.skipped)) continue;
    for (const variant of ASK_VARIANTS[step]) {
      const key = setupCardKey(step, variant);
      if (present.has(key)) settle.push(key);
    }
  }

  // One card per key, within this plan as well as against the thread: the
  // agents report and the agents step can both ask for the same card.
  const append: SetupCardPlan[] = [];
  const claimed = new Set(present);
  for (const card of wanted) {
    if (claimed.has(card.key)) continue;
    claimed.add(card.key);
    append.push(card);
  }
  return { append, settle };
}
