// EVERY WORD OF THE GUIDED FIRST RUN, IN ONE PLACE.
//
// The first run is a conversation with the Chief of Staff, in the Chief's own
// thread. Each step arrives as a message carrying a setup card, and the card
// on the wire says only WHICH card it is (shared/setup-card.ts). The words
// live here: data, no JSX, no components, no React. One file the product
// owner can read end to end, and one file a test can walk string by string.
//
// THE RULES THIS FILE IS HELD TO, all of them enforced by
// first-run-copy.test.ts rather than by good intentions:
//
//   No em dash. Not one. A full stop, a comma, or "and".
//   Never sell on price. No money words, no figures about money at all.
//   Never name the connected-app broker. It is "500+ apps", named by
//     example: Gmail, Slack, Notion, GitHub.
//   Never a model count. "All the latest models" is the claim.
//   Flux Router leads with routing, then the apps, then pictures and
//     transcription. NOT voice: the key transcribes and does not speak, and
//     the only row allowed to mention speaking is one marked "Coming soon".
//   Never describe a capability as a limit. Sending email is graduated
//     trust: you approve, I send, and you can raise how much I do on my own.
//   Never promise a grant the approval system cannot key. A remembered
//     approval is keyed by the WHOLE tool name (`approvalKey`,
//     server/auto-approve.ts) and every connected-app call, read or write,
//     Gmail or Slack, arrives through one wrapper tool (server/composio.ts).
//     So "once you trust me with a kind of email" was a key that cannot
//     exist, and it shipped for as long as it did because a test required
//     that exact sentence.
//   No school framing. Nobody is being taught a lesson.
//
// Three sentences is the ceiling for a card body, which is why most bodies
// here are two short fields rather than one long paragraph: the renderer sets
// them as separate lines and a person reads them as separate thoughts.

/** Where a person gets a Flux Router key. Mirrors FLUX_SIGNUP_URL in
 *  src/components/FluxRouterConnection.tsx, imported by the card itself so
 *  there is one URL and not two. */
// The extension is explicit because this file is now also read through
// tsconfig.server.json, which resolves as NodeNext: a server test drives the
// business result with the real starter package and needs these words.
import type { SetupCardVariant } from "../../shared/setup-card.ts";

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

/** One connectable account, with the reason it is worth connecting said in a
 *  few words. The reason is the whole row: "Gmail" on its own is a logo, and
 *  "so I can read your mail and draft the replies" is an offer. */
export interface FirstRunAppRow {
  slug: string;
  label: string;
  why: string;
}

/**
 * One thing the Flux Router key turns on.
 *
 * EVERY ROW IS TRACEABLE TO THE FILE THAT STOPS WORKING WITHOUT THE KEY, and
 * that is the test for adding a seventh, not "does the key appear in this
 * file". Smart routing is server/flux-routing.ts. The apps are the hard block
 * kept as `connectedAppsBlock`. The models are the flux-* catalogue. Pictures
 * are server/avatar-image.ts. Transcription is server/voice/flux-voice.ts.
 *
 * Routines, teams and memory are NOT Flux features and have never been. Memory
 * is built into Murage: any enabled engine carrying `extractMemory` is
 * eligible. Routines contain zero Flux references. That mistake has been made
 * five times and each time it read as a feature list written by somebody who
 * had not opened the code.
 */
export interface FirstRunFluxFeature {
  id: string;
  title: string;
  body: string;
  /**
   * Whether this row works TODAY.
   *
   * A row that is not live carries the "Coming soon" pill and a dashed tick,
   * and it is the only kind of row allowed to describe speaking out loud. The
   * owner's ruling: "voice mode is coming so you can have it as coming soon
   * and then we flick it over when it's available."
   */
  state: "live" | "coming-soon";
  /**
   * Set on a live row that mentions speech, naming WHICH half of speech is
   * true of it. `transcription` is you talking and Murage typing, which the
   * Flux key really does at POST /v1/audio/transcriptions. There is no
   * `synthesis` member on purpose: the key has no synthesis endpoint, so a row
   * that wanted one would have nothing honest to declare.
   */
  speech?: "transcription";
}

/** One thing the closing card can offer to do. `say` is the sentence that
 *  goes into the conversation when it is pressed, in the person's voice,
 *  because the answer to "what would you like to do" is them asking. */
export interface FirstRunOffer {
  label: string;
  say: string;
}

/**
 * One of the Chief's five jobs, as words.
 *
 * `id` is a wire identifier and is the join to `FIRST_RUN_JOB_SHAPES` in
 * src/lib/first-run-jobs.ts, which says what each one needs and what box it
 * opens. Two lists rather than one because the words belong in this file,
 * where the house rules are checked over them, and the behaviour does not.
 * first-run-jobs.test.ts pins the two together so neither can grow a row the
 * other does not have.
 */
export interface FirstRunJobRowCopy {
  id: "brief" | "day" | "notes" | "research" | "business";
  title: string;
  sub: string;
}

/** One step of the Tailscale walkthrough, which happens in the chat and not
 *  in a settings pane. `action` is the button under it. */
export interface FirstRunWalkStep {
  label: string;
  detail: string;
  action: string;
}

/**
 * A line across the page with the step's name on it.
 *
 * The first run is one long thread and it read as one: card, card, card, with
 * nothing to say where one thing ended and the next began. The owner asked
 * for "almost like a title to act as a separator", which is the right
 * instinct twice over. It gives the eye somewhere to stop on a page that
 * scrolls, and it tells somebody who has come back to the thread tomorrow
 * what part of it they are looking at.
 *
 * Only the card that OPENS a step carries one, so a step with a report and an
 * ask in it gets one heading rather than two. Keyed by variant rather than by
 * step for exactly that reason: the opener is a specific card, not just the
 * first one that happens to arrive.
 *
 * Named for what happens, not what it is called internally. Nobody is being
 * walked through "the flux step".
 */
export const FIRST_RUN_STEP_HEADINGS: Partial<Record<SetupCardVariant, string>> = {
  // THE APPROVED FLOW'S TOP BARS, WORD FOR WORD.
  //
  // The simulation puts a top bar above each step and the build spec quotes
  // all three: "Welcome", "Looking around", "Flux Router". In this build the
  // first run is a thread rather than a stack of full screens, so the separator
  // rule IS the top bar: it is the one thing on the page that says which part
  // of the conversation you are in. Same words, so a person who saw the
  // simulation and a person who runs the app are looking at the same flow.
  //
  // `bare-needs-key` moved with its step. It used to say "What is already
  // here", which is the detection step's bar, and it is the FLUX step's second
  // opening on a machine where detection never ran. A separator naming a step
  // the person was never shown is a separator that lies about where they are.
  welcome: "Welcome",
  found: "Looking around",
  bare: "Looking around",
  "bare-needs-key": "Flux Router",
  "signed-out": "Looking around",
  key: "Flux Router",
  apps: "Where your work lives",
  "sample-brief": "Your mornings",
  "more-routines": "A couple more",
};

export function stepHeadingFor(variant: SetupCardVariant): string | null {
  return FIRST_RUN_STEP_HEADINGS[variant] ?? null;
}

export const FIRST_RUN_COPY = {
  hello: {
    /**
     * STEP ONE, AND IT IS ASKED BEFORE DETECTION IS REPORTED.
     *
     * Not a UX preference. The owner ruled that this builds the list and is a
     * business requirement, so it goes first and the look around the machine
     * happens underneath it while they type. Every word here is the approved
     * flow's, and the two fields say what each one is FOR: a name is what the
     * Chief calls them, an email is how it reaches them when they are not sat
     * in front of this computer. A field with no stated purpose is a field
     * people skip, and this is the one step that cannot afford that.
     */
    welcome: {
      heading: "First, who am I working for?",
      lead:
        "I am your chief of staff. Your name is what I call you. Your email is how I reach you when you are "
        + "away from this computer, and how Murage tells you when there is something new it can do.",
      nameLabel: "Your name",
      namePlaceholder: "What should I call you?",
      emailLabel: "Your email",
      emailPlaceholder: "you@example.com",
      submit: "Continue",
      working: "Saving",
      skip: "Skip for now",
      detecting: "While you type, I am having a look around this computer to see what is already here.",
      failure: "That did not save. Try once more, or skip it and carry on.",
    },
  },
  agents: {
    /**
     * STEP TWO, THE REPORT, AND IT IS SKIPPED ON A MACHINE WITH NOTHING.
     *
     * One row per engine, and the row says three things: what it is, one fact
     * about it, and whether it can answer right now. The three details below
     * are the three shapes a row can take, and each one is a fact the setup
     * view can prove rather than a sentence about how good anything is.
     *
     * WHAT IS NOT HERE. The approved flow marks one row "using this", and this
     * build cannot prove which row that is: the engine the Chief is actually
     * on lives on `SetupLiveState.chiefInstanceId` and is not carried on the
     * view. On a machine with two local models that tag would be false on one
     * of them, and a false tag in the first minute is what the whole release
     * exists to stop. Every runnable engine gets the claim that is true of all
     * of them until there is a field that can prove the stronger one.
     */
    detect: {
      heading: "What is already here.",
      /** An engine pointed at a model on this machine. */
      localDetail: "Nothing you type leaves this computer.",
      /** A remote engine the person signed in to themselves. Not named by
       *  vendor: the reading knows the engine, not whose account it is on. */
      cloudDetail: "Signed in on your own account.",
      /** The engine Murage ships. It is not something they did, and claiming
       *  an account for it would be the Chief taking credit for one that does
       *  not exist. */
      bundledDetail: "It came in the box, and it is already running.",
      /** Installed, nobody signed in. Said without blame: nothing is broken
       *  and nothing was installed wrong. */
      offDetail: "Installed, nobody signed in.",
      readyTag: "ready when you want it",
      offTag: "one command away",
      more: (count: number) => `and ${count} more on this computer`,
      hide: "Hide them",
      /**
       * THE HANDOVER TO THE FLUX SCREEN, AND IT IS THE HONEST VERSION.
       *
       * Not "you are all set", which is what a machine with a signed-in Claude
       * Code on it would hear as an ending. What was found can answer
       * questions; what it cannot do is reach the person's mail, their
       * calendar or their apps. Saying both halves is what makes the next
       * screen an offer rather than a pitch.
       */
      closing: "That is enough for me to answer you. It is not enough for me to do the interesting part.",
      action: "Show me the interesting part",
    },
    found: {
      second: "They answer to you in here now, and they still work exactly as they did on their own.",
    },
    bare: {
      body: "There was nothing else on this computer to connect, and there does not need to be.",
      second: "The one that came in the box is already running. It is what is talking to you now.",
    },
    /**
     * The bare machine before there is a key.
     *
     * Murage ships the engine. It does not ship a brain, and on a computer
     * with no key, no sign-in and no local model within reach there is
     * nothing behind it yet. The "bare" card above says the opposite, and on
     * this machine it would be the first thing the Chief ever said and it
     * would be false. Saying it plainly is also the honest lead-in, because
     * the fix is literally the next card.
     */
    "bare-needs-key": {
      body: "There was nothing else on this computer to connect, so it is you and me.",
      second: "I came with the engine but not yet with anything to think with. One key sorts that, and it is the next thing I will ask you for.",
    },
    /**
     * IT IS HERE AND NOBODY IS SIGNED IN TO IT.
     *
     * This card used not to exist, and the absence was a bug rather than a
     * gap. A signed-out engine still answers `--version` and still hands over
     * its model list, so it read as working, the "found" card above said we
     * had connected it, and the Chief was pointed at something that died on
     * the first thing it was ever asked to do.
     *
     * The register is set by who is reading. They installed Claude Code or
     * Codex themselves, so they are not the person who needs to be told what
     * it is. Say what is true, say what fixes it, do not explain.
     *
     * And no pressure: whatever is already running keeps running. An offer
     * that implies they are stuck until they comply is the school framing
     * this file bans.
     */
    "signed-out": {
      second: "Sign in and it is yours to use in here, working exactly as it does on its own.",
      third: "Or leave it. What is already running carries on either way.",
      action: "Help me sign in",
      /** Named, because two engines mean two commands and an unlabelled pair
       *  of them is a puzzle. */
      commandFor: (name: string) => `Run this once, in a terminal, to sign in to ${name}.`,
      copy: "Copy",
      copied: "Copied",
      /** The sign-in finishes in another window, on its own time. A button
       *  that admits that beats a spinner that cannot know. */
      recheck: "I have done it",
      /** Everything on the list got signed in while the card was open. */
      done: "You are signed in now, and I have connected it.",
    },
  },
  flux: {
    /**
     * SHOW, THEN ASK.
     *
     * The words are deliberately small, because the card below them is doing
     * the talking. Three short lines and then the thing itself.
     *
     * It says plainly that the day is made up. A sample that let somebody
     * believe it was their real morning would be a lie they would catch
     * within seconds, and catching the assistant in one on its first day is
     * not recoverable.
     */
    "sample-brief": {
      body: "Here is what tomorrow morning could look like.",
      second: "The day in it is made up. The shape of it is real, and yours would be built from what you have just connected.",
      third: "Would you like one of these every morning?",
      frameTitle: "An example morning brief",
      /** The sheet is labelled so it reads as a thing that was handed over
       *  rather than as more of the same conversation. */
      sheetLabel: "An example brief",
      showAll: "Show the whole thing",
      showLess: "Show less",
    },
    key: {
      /**
       * THE SCREEN THE COMPANY MAKES ITS MONEY ON, AND IT GETS TWO OPENINGS.
       *
       * The heading is the owner's, exactly: "Get the right answer faster."
       * Not what it is, not what it costs, what it does for the person reading
       * it. NO PRICE FIGURE AND NO PLAN COMPARISON ANYWHERE ON THIS SCREEN,
       * which is a ruling and is also enforced twice over by the money rules
       * in first-run-copy.test.ts.
       */
      heading: "Get the right answer faster.",
      // Five sentences, on the card the whole release leads with, under a
      // rule that has said "three is the ceiling" since the file was written.
      // Nothing was asserting it. The words are unchanged; the two-word
      // sentences that were doing the work of one clause are now one clause.
      lead:
        "You should not have to know which AI is good at what. Flux Router picks for you, every time you ask: "
        + "big job, big model, quick job, quick model. You just get the answer.",
      /**
       * THE SECOND OPENING, ON A MACHINE WHERE DETECTION NEVER RAN.
       *
       * This screen has to do step two's job as well as its own, because step
       * two was skipped: there is no honest "here is what I found" for a
       * machine where nothing was found. So it says what was looked for, says
       * plainly that nothing turned up, and then asks for the one thing that
       * fixes it. The owner's framing, exactly.
       */
      headingBare: "Your bots need a brain first.",
      leadBare:
        "Murage came with an engine. It did not come with anything to think with, and there is nothing on "
        + "this computer I can use. One connection fixes that, and it is the same one your apps run through.",
      /** The card's own two corners. */
      cardTitle: "Flux Router",
      cardAccount: "Your account",
      /** The pill on a row that is not live yet. */
      comingSoon: "Coming soon",
      features: [
        {
          id: "routing",
          title: "Smart routing",
          body:
            "every question goes to the AI that handles it best. The biggest one is not always the best one. "
            + "Often it is just the slowest",
          state: "live",
        },
        {
          id: "apps",
          title: "500+ apps",
          body: "Gmail, Slack, Notion, GitHub. Connect one once and it follows your key to any computer you sign in on",
          state: "live",
        },
        {
          id: "models",
          title: "All the latest models",
          body: "one key. Not an account each with OpenAI, Anthropic, Google and xAI",
          state: "live",
        },
        {
          id: "pictures",
          title: "Pictures",
          body: "make them right in the chat. Or hand over four and ask for a change",
          state: "live",
        },
        {
          // TRUE TODAY, AND IT IS THE HALF OF SPEECH THIS KEY ACTUALLY DOES.
          // You talk, Murage types. POST /v1/audio/transcriptions, and nothing
          // else. Named "instead of type" rather than "talk to me" for exactly
          // that reason: the second one promises an answer out loud.
          id: "dictation",
          title: "Talk instead of type",
          body: "say it out loud. Works from your phone too, not just this computer",
          state: "live",
          speech: "transcription",
        },
        {
          // NOT TODAY, AND SAYING SO IS THE WHOLE POINT OF THE ROW. Selling
          // speech on this key is a false claim that has already shipped once
          // and was then ENFORCED by a test. It arrives marked, or it does not
          // arrive.
          id: "voice",
          title: "Voice mode",
          body: "a real back and forth, out loud",
          state: "coming-soon",
        },
      ] as readonly FirstRunFluxFeature[],
      keyCaveat: "Your key stays in this computer's keychain. It never appears in our conversation.",
      /** The way past, and it is a real answer rather than a postponement.
       *  Two versions, because a machine with a local model on it has
       *  somewhere to go and a blank one does not. */
      dismissLocal: "Not yet, start me on the local model",
      dismissCaveat: "You can turn it on later from any job that needs it.",
      /** §3.3, the screen that takes the key. The browser is already open on
       *  the sign-up page by the time this is read. */
      connectHeading: "Your browser is open on the sign-up page.",
      connectLead:
        "Make the account, copy the key it gives you, and bring it back here. Once, and then never again on "
        + "this computer.",
      connectSubmit: "Connect",
      connectCaveat: "It goes into this computer's keychain. The server never hands it back, and no bot ever sees it.",
      connectAgain: "Open the page again",
      connectCancel: "Cancel",

      // ── SUPERSEDED BY THE SIX ROWS ABOVE, AND PARKED RATHER THAN CUT. ──
      //
      // `title`, `body`, `second`, `third` and `signup` are the three-sentence
      // version of this card. The approved flow replaced them with a heading,
      // a lead and six rows, and nothing renders these any more.
      //
      // They stay because they are still held to the house rules by the copy
      // walk, and because the claims in them are the ones that were argued
      // over: routing first, the apps named by example, no model count, and
      // transcription rather than voice. Anybody tempted to rewrite a row
      // above can read what the same promise looked like when it was fought
      // over. They are NOT a second source of truth: the card reads `features`
      // and only `features`.
      title: "One key worth having",
      body: "Flux Router gives you all the latest AI models, with smart routing that sends each job to the one that is best at it.",
      second: "The same key connects 500+ apps, Gmail, Slack, Notion and GitHub among them.",
      /**
       * NOT "voice". Flux Router has no synthesis endpoint of any kind:
       * server/voice/flux-voice.ts says so in its own header, and
       * src/lib/flux-invite.ts already refused to claim speech for the same
       * reason. Murage speaks through ElevenLabs on the person's OWN key, or
       * the free OS voices, never on this one. Transcription IS on this key
       * (POST /v1/audio/transcriptions), which is the half worth selling:
       * dictation that works from a phone, where the native macOS helper
       * cannot reach.
       */
      third: "It brings pictures, and transcription so you can talk instead of type from your phone.",
      /**
       * TWO PEOPLE ARE READING THIS CARD AND THEY ARE NOT IN THE SAME
       * SITUATION.
       *
       * Murage ships the engine, not the brain. Somebody on a clean machine
       * has nothing to think with until this key exists, and calling it
       * "recommended" to them is an understatement they will discover the
       * hard way one card later. Somebody who already had Claude Code or
       * Codex on the machine is working already, and telling THEM they need
       * this would be false, and the kind of false that reads as a sales
       * pitch.
       *
       * Same key, same card, and the honest sentence about it depends on
       * which of the two is reading. Chosen in the renderer from live
       * detection rather than by splitting the card in two, so there is
       * exactly one key card in the transcript however the machine's answer
       * changes while they are looking at it.
       */
      recommendation: "Recommended, because it is the one key that opens everything else.",
      /** Nothing on this machine can think yet. */
      recommendationBare: "This is the one that matters. I came with the engine and this is what gives it something to think with.",
      /**
       * They already have a working engine, so this is a genuine extra.
       *
       * IT SAID "pictures and voice", AND THE SPEECH TEST COULD NOT SEE IT.
       * That test named four fields by hand and this was not one of them, so
       * the exact false claim it was written to stop went on shipping one line
       * below the fields it guarded. Synthesis selects ElevenLabs or the
       * system voices; the Flux key configures neither. The test now walks
       * every string in this file instead of a hand-picked four.
       */
      recommendationBonus: "Optional, and worth it. You are already up and running, and this adds all the latest models, your apps, pictures and transcription on top.",
      /** Visually hidden on the connect screen: the heading above it has
       *  already said what this is, and a second label would be a second
       *  reading of the same sentence. */
      fieldLabel: "Your Flux Router key",
      placeholder: "Paste your key here",
      /**
       * THE BUTTON SAYS WHAT HAPPENS, NOT WHAT IT DOES MECHANICALLY.
       *
       * It said "Save it". Both cross-research models, independently, attacked
       * that whole framing: the person does not want to save a key, they want
       * the thing the key turns on, and "save" describes our plumbing. The
       * headline above stays warm on purpose. The button is where a person
       * looks to find out what pressing it will do, so it is the one place
       * that has to be literal.
       *
       * The field still says paste, because pasting is still honestly what
       * they do next.
       */
      submit: "Connect Flux Router",
      working: "Connecting",
      signup: "I need a key",
      dismiss: "Not now",
      saved: "Connected, and the key is locked away on this computer. It never appears in our conversation.",
      failure: "That key did not connect. Check it and try again, or carry on without it.",
    },
    "no-key": {
      body: "Noted. We carry on with what is on this machine, and that is plenty to be going on with.",
      second: "I will bring the key up again only when something you have asked me for actually needs it.",
      /**
       * THE SAME ANSWER FROM SOMEBODY WITH NOTHING MEANS SOMETHING ELSE.
       *
       * "We carry on with what is on this machine" is true and friendly when
       * there is something on the machine. On a bare install there is
       * nothing, and saying it would leave a person sitting in front of an
       * assistant that cannot think, believing they had chosen that.
       *
       * The engine takes any OpenAI-style endpoint with a key, which is most
       * of the industry, so this is not a dead end and must not read like
       * one. It names the two real ways on, and it does not invent an in-chat
       * flow that does not exist yet.
       */
      bodyBare: "Noted. Then I do need something else to think with, or I am only a nice window.",
      // "Any OpenAI-style service you already PAY for" was the one money
      // word left in the flow, on the one branch a blank machine reaches by
      // declining the key. The banned-word regex had every other spelling of
      // money and not that one. What matters about the service is that they
      // already have it, not what they hand over for it.
      secondBare: "Any OpenAI-style service you already use will do, and so will a model running on this computer. Add either one under Models in Settings and I will pick it up from there.",
    },
  },
  /**
   * STEP FOUR. The Chief asks one question and offers five answers.
   *
   * The five are jobs, not features. "Brief me every morning" is a thing
   * somebody wants; "connect your calendar" is a thing software wants, and
   * the whole re-cut is that the second one is only ever asked for by the
   * first. Every row carries what it still needs, recomputed live, so
   * nothing is offered that cannot run and nothing is hidden that could.
   *
   * The behaviour behind these words is in src/lib/first-run-jobs.ts, which
   * holds no readable strings of its own. The two lists are pinned together
   * by a test rather than by hoping.
   */
  chat: {
    jobs: {
      question: "What can I take off your plate",
      lead: "Pick one and I will do it now. I only ask for what that job needs, when it needs it.",
      /** A machine with nothing to think with. The jobs are still shown,
       *  because seeing what this would do for you is the reason to connect
       *  anything, but not one of them is claimed to be ready. */
      leadNoBrain: "Pick one anyway. I will show you exactly what it needs before anything happens.",
      status: {
        connected: "Connected. Smart routing on, and your apps are a click away when a job needs them.",
        noBrain: "Nothing to think with yet, so every job below is waiting on one connection.",
        /** Wrapped around the engine's real name. The name comes from the
         *  reading, never from a sample: a status line that named an engine
         *  this computer does not have would be the first thing the person
         *  read and the first thing that was wrong. */
        localPrefix: "Running on",
        localTail: "here on this computer.",
        localUnnamed: "Running on what is already on this computer.",
      },
      rows: [
        {
          id: "brief",
          title: "Brief me every morning",
          sub: "What is fixed, what is owed, what will slip.",
        },
        {
          id: "day",
          title: "Organise my day",
          sub: "Today's commitments, in an order that survives the first phone call.",
        },
        {
          id: "notes",
          title: "Make sense of these notes",
          sub: "Paste anything. Get back what matters and what to do next.",
        },
        {
          id: "research",
          title: "Look into something for me",
          sub: "I search the web and read what comes back, then tell you where each thing came from.",
        },
        {
          id: "business",
          title: "Help me run my business",
          sub: "Two bots and a Monday review, set up in one go.",
        },
      ] as readonly FirstRunJobRowCopy[],
      /** What one missing thing is called out loud. Shared by the tag on a
       *  job row and the bold on a connect row, so the person reads the same
       *  name in both places. */
      needLabels: {
        flux: "Flux Router",
        gmail: "Gmail",
        googlecalendar: "Google Calendar",
      },
      tags: {
        ready: "ready now",
        flux: "needs Flux Router",
        /** Followed by one need label. */
        connectOne: "connect",
        /** Follows a count, from two upwards. */
        countTail: "to connect",
      },
      /**
       * SAID ONLY WHEN THERE IS SOMETHING TO SAY.
       *
       * Searching on an unconfigured machine goes out anonymously and uses
       * no account of the person's, which is checked in first-run-jobs.ts
       * against the route rather than assumed, so the ordinary case has no
       * line at all. These three are the machines where somebody chose
       * otherwise before they got here, and a job that searched without
       * saying whose account it was searching on would be the thing that
       * check exists to prevent.
       */
      searchNotes: {
        "own-account": "Searching goes out through the search account you connected yourself.",
        unconfigured: "The search service picked for this computer has no key on it yet, so I will work from what you tell me and say where I am unsure.",
        off: "Web search is switched off on this computer, so I will answer from what you give me and say plainly what I could not check.",
      },
      /** The way out for somebody whose thing is not on the list. Goes
       *  straight to the notes box, which asks for nothing. */
      escape: "Or just tell me what you need",
      /**
       * BLANK MACHINE, NO KEY, AND THEY TYPED SOMETHING ANYWAY.
       *
       * There is nothing here to ask, and Murage does not offer to fetch a
       * model. So this keeps what they wrote and says so. It promises no
       * answer and starts no wait, because a box that spins forever tells
       * somebody something false no matter how carefully the words around it
       * are chosen.
       */
      kept: "I have that, and I am keeping it. The moment there is something here to think with, it is the first thing I pick up.",
    },
  },
  /**
   * STEP FIVE. The chosen job, from what it needs through to its result.
   *
   * `connect` is the front of it, and it is the standalone apps step's
   * replacement: the same two sign-ins, asked for by a job the person just
   * picked, with the reason on each row written for THAT job rather than in
   * general.
   */
  flow: {
    "do-it": {
      connect: {
        headingOne: "One thing, and then I can do it.",
        /** Follows a count, from two upwards. */
        headingManyTail: "things, and then I can do it.",
        lead: "Everything this job needs is on this screen. Nothing else gets asked, and you can stop after any of them.",
        /**
         * The reason on each row, written for the job in hand.
         *
         * "You sign in on Google's own screen, and take it back there" is
         * the sentence that does the work: the person is about to be sent to
         * a browser and handed back, and being told that first is the
         * difference between a step and a surprise.
         *
         * THE SIMULATION PUT THAT SAME SENTENCE ON A SLACK ROW, where it is
         * simply untrue. Slack is not offered in 0.1.58 at all
         * (`SETUP_JOB_APPS`), so the wrong sentence is not here to be read;
         * if Slack ever comes back it comes back saying Slack's own screen.
         */
        reasons: {
          flux: "your apps run through it, and it picks the right model for this job",
          gmail: "so I can see what came in overnight and who is waiting. You sign in on Google's own screen, and take it back there.",
          googlecalendar: "so I know what is already fixed in your day. You sign in on Google's own screen, and take it back there.",
        },
        /** Offered only by a job that has a box, because a job with no box
         *  has nothing to type instead. */
        skipToInput: "Skip that and let me type it in instead",
        elsewhere: "Something else",
      },
      /**
       * THE BOX. Three of them, one per job that asks for something.
       *
       * `placeholder` IS A PLACEHOLDER AND MUST STAY ONE. An earlier version
       * pre-filled the notes box with example text and it was caught in
       * review: text in the box is the person's, always, and a box that
       * arrives with words in it is a box somebody sends without noticing.
       */
      input: {
        day: {
          heading: "What is on today?",
          lead: "Meetings, deadlines, people you owe something to. Rough is fine, one per line.",
          placeholder: "9:30 standup\nboard pack due Thursday\ncall Rahul back about the lease",
          rows: 7,
        },
        notes: {
          heading: "Paste the notes.",
          lead: "Anything at all. Meeting scrawl, a wall of messages, half a plan.",
          placeholder: "paste anything here",
          rows: 7,
        },
        topic: {
          heading: "What should I look into?",
          lead: "One line is enough. I will tell you what I find and what I could not confirm.",
          placeholder: "whether we should move our billing to Stripe",
          rows: 3,
        },
        /** Said only when the job's accounts are all connected, so the
         *  person knows what they do not have to type out again. */
        calendarConnected: "Your calendar is connected, so add anything that is not already in it.",
        go: "Go on then",
        elsewhere: "Something else",
      },
      /**
       * THE THREE LINES WHILE IT WORKS.
       *
       * Every number in them is counted from what the person typed. The
       * fixed sentences are here; the counted ones are assembled in
       * first-run-flow.ts out of these pieces and the parsed items, and they
       * are checked against the house rules there.
       */
      working: {
        ready: "Ready.",
        businessShape: "Picking a shape that fits one person running the whole thing.",
        /**
         * THE SIMULATION SAID "THREE BOTS, TWO ROUTINES" AND THAT IS WRONG.
         *
         * `library/packages/starter-solo-business.json` holds two agents and
         * one routine. A first run that announced a third bot would be
         * describing a crew the person does not then have, on the one screen
         * whose whole job is showing them what they just got.
         */
        businessBuilt: "Two bots and one review, and no plumbing for you to do.",
        topicSourced: "Keeping what has a source, flagging what does not.",
        /** Wrapped around the first words of what they typed, so they can
         *  see it is their topic and not a generic one. */
        topicPrefix: "Reading around",
        noneTimed: "None has a time on it.",
        timedTail: "a time on it.",
        thingOne: "thing.",
        thingMany: "things.",
        noneDue: "None of them carries a deadline I can see.",
        dueTail: "a deadline and no slot.",
        hasOne: "has",
        hasMany: "have",
      },
      /** The day and the brief share a result; only the header, the
       *  provenance and the morning offer differ. */
      day: {
        headerBrief: "Tomorrow morning",
        headerDay: "Today",
        fromLines: "From your",
        linesOne: "line",
        linesMany: "lines",
        plusCalendar: "your calendar",
        plusMail: "your mail",
        riskEyebrow: "The one that will slip",
        /**
         * WHY THERE ARE TWO VERSIONS OF THE DEADLINE REASON.
         *
         * The approved wording was "It is the only thing you gave me with a
         * deadline and no time against it", which is a fine sentence right
         * up to the second such line, and then it is a claim about their day
         * that is simply untrue. The number is counted, like every other
         * number on this screen, and the sentence follows the count.
         */
        riskDueOnly: "It is the only thing you gave me with a deadline and no time against it.",
        riskDueFirstPrefix: "It is the first of",
        riskDueFirstTail: "things you gave me with a deadline and no time against it.",
        riskOwed: "Somebody is waiting on it and it has no time against it, so it loses to everything that has.",
        riskAdviceGap: "Put it in the first gap your fixed points leave open.",
        riskAdviceSlot: "Give it a slot before anything else claims one.",
        /** IT SAYS NOTHING IS AT RISK RATHER THAN MANUFACTURE ONE. An
         *  earlier version invented "or it moves to Wednesday" and was
         *  caught in audit. */
        calmEyebrow: "Nothing here is at risk",
        calmBody: "Everything you gave me either has a time on it or nobody waiting for it.",
        calmSecond: "Put a deadline or a person against any line and I will tell you which one goes first.",
        fixedHeading: "Fixed",
        fixedEmpty: "Nothing you gave me has a time against it.",
        waitingHeading: "Someone is waiting",
        waitingEmpty: "Nobody is waiting on anything you gave me.",
      },
      /**
       * THE MORNING OFFER, ON THE BRIEF RESULT AND NOWHERE ELSE.
       *
       * "It never goes to your inbox" is load-bearing. Murage reads their
       * mail; mailing them a summary of their mail is circular, and the
       * owner has ruled on it. The brief is delivered here, in the app.
       *
       * One button and one time, deliberately. The shipped card had a time
       * picker and then reported 07:00 back whatever was chosen, so there is
       * no second time to get wrong: the offer, the request and the
       * confirmation are all built from `FIRST_RUN_BRIEF_TIME`, which is the
       * server template's own default.
       */
      morning: {
        heading: "Want this waiting for you every morning?",
        bodyPrefix: "Built at",
        bodyTail: "on weekdays and waiting here when you open this computer. It never goes to your inbox.",
        buttonTail: ", weekdays",
        takenPrefix: "Set. Weekdays at",
        working: "Setting it up",
        failure: "That did not go through. Ask me again whenever you like.",
      },
      notes: {
        header: "What is in there",
        fromPrefix: "From the",
        fromTailOne: "line you pasted.",
        fromTailMany: "lines you pasted.",
        eyebrow: "Next steps, in the order I would take them",
        tagDue: "has a date",
        tagOwed: "owed",
        tagTimed: "timed",
        tagOpen: "open",
        empty: "There was nothing in there I could turn into a step. Give me a line with a person or a date in it.",
        caveat: "I ordered these by what has a date on it and who is waiting. Nothing else was in the notes, so nothing else is in the list.",
      },
      research: {
        /** Said under a real answer on a machine running on its own engine.
         *  Never on a machine with nothing: that machine never reaches this
         *  screen, because the job asks for the key first. */
        onLocal: "Running on the local model. Flux Router would put a bigger one on this, and it reads faster.",
      },
      /**
       * THE CREW, AND IT MATCHES THE PACKAGE OR IT IS WRONG.
       *
       * The names, the count, the schedule and the fact that it installs
       * switched off all come from `starter-solo-business.json` at render
       * time. Only the one-line descriptions are written here, keyed by the
       * package's own agent keys, so a renamed bot shows its new name and a
       * bot that disappears takes its description with it.
       */
      business: {
        header: "Your crew",
        lead: "Installed and running. Change any of it whenever you like.",
        botsEyebrowOne: "One bot",
        botsEyebrowMany: "Two bots",
        roles: {
          "business-planner": "priorities, and what finished means",
          "draft-partner": "writes it, then reviews it",
        },
        reviewEyebrow: "One review, paused until you want it",
        reviewTail: "It arrives switched off so nothing starts behind your back.",
        minutesTail: "minutes.",
        offer: "Switch the Monday review on",
        offerWhy: "It works from what you tell it. Connect your calendar later and it reads that too.",
        offerTaken: "On. It runs on Monday.",
      },
      /** The way back to the Chief, on every result. Clears the job, the
       *  text and the parsed items; none of them was ever persisted. */
      again: "Take something else off my plate",
    },
  },
  apps: {
    apps: {
      title: "Where your work actually lives",
      body: "Connect the accounts your day runs through and I can do the work in them instead of talking about it.",
      second: "One click each, and one is enough to start.",
      rows: [
        { slug: "gmail", label: "Gmail", why: "so I can read your mail and draft the replies" },
        { slug: "googlecalendar", label: "Google Calendar", why: "so I know what your day already looks like" },
        { slug: "slack", label: "Slack", why: "so I can keep an eye on the rooms that matter" },
      ] as readonly FirstRunAppRow[],
      connect: "Connect",
      connecting: "Finish it in the window that just opened",
      /**
       * WHOSE CONNECTION IS IT.
       *
       * This said only "Connected", and on a machine where the owner had
       * connected nothing it read as a plain lie. It was not: connected apps
       * travel with the Flux Router key rather than with the computer, so a
       * key that has Gmail on it arrives with Gmail already working, on a
       * machine that has never seen it. Reported as "I have never connected
       * them on this machine, so that's bullshit", which is exactly the right
       * reaction to a word that claims something the machine did not do.
       *
       * Saying where it came from turns the same fact from a broken-looking
       * claim into the good news it actually is: you do this once, not once
       * per computer.
       */
      connected: "Connected",
      connectedElsewhere: "Connected, through your key",
      /** Said once above the rows when at least one of them arrived with the
       *  key, so the rows themselves stay short. */
      cameWithKey: "Some of these are already on, because they came with your Flux Router key. You connected them once and they work everywhere you sign in.",
      /**
       * GRADUATED TRUST, SAID AS THE SYSTEM CAN ACTUALLY KEEP IT.
       *
       * This promised "once you trust me with a kind of email, I can send
       * those myself". Nothing can deliver that. A remembered approval is
       * keyed by the whole tool name (`approvalKey`, server/auto-approve.ts)
       * and every connected-app call arrives through one wrapper tool, so
       * there is no key that separates sending mail from reading it, let
       * alone one kind of mail from another. What really exists is a level:
       * ask every time, or hand me more, and take it back whenever.
       */
      trust: "On email you stay in charge. You approve, I send. You can raise how much I do on my own later, and lower it again just as easily.",
      desktopOnly: "Connect this from Murage on your computer",
      dismiss: "Not now",
      failure: "That connection did not finish. Try it again whenever you are ready.",
    },
  },
  brief: {
    brief: {
      title: "Your morning brief",
      /**
       * SAID BEFORE IT HAPPENS, NOT AFTER.
       *
       * The first real brief reaches for mail and calendar, and nothing is
       * auto-approved on a fresh install, so it raises an approval card for
       * each one. Unwarned, that reads as the app breaking: the person set a
       * time and was immediately handed a stack of permission questions.
       *
       * Warned, it reads as the thing working exactly as promised, because
       * "you approve, I send" is the line this whole release is built on. The
       * same sentence also says it is not blocking them, which is the other
       * half of the complaint: they can carry on while it runs.
       */
      permission: "The first one will ask your permission as it reaches for each thing. Answer those whenever you like, it carries on in the background.",
      body: "Each morning I read everything that came in overnight and put one page on top: what needs you, what moved, and what you said you would do.",
      second: "Pick a time and it will be waiting before you sit down.",
      timeLabel: "What time?",
      weekdays: "Weekdays only",
      submit: "Set my morning brief",
      working: "Setting it up",
      dismiss: "Not now",
      failure: "The brief could not be set up. Try again in a moment.",
    },
    "brief-ran": {
      body: "I have just run it, so you can read the real thing rather than take my word for it.",
    },
  },
  routines: {
    "more-routines": {
      title: "Two more worth having",
      body: "Going by what is connected, these are the two I would start with.",
      rows: [
        {
          template: "triage",
          label: "Triage my inbox",
          why: "I sort the morning's mail and draft the replies. You approve, I send, and you can raise how much I do on my own whenever you like.",
        },
        {
          template: "watch",
          label: "Keep an eye on one thing",
          why: "Tell me what matters and I will tell you the moment it moves.",
          placeholder: "For example: anything from my accountant",
        },
      ],
      add: "Set it up",
      working: "Setting it up",
      added: "Running",
      dismiss: "That is enough for now",
      failure: "That one could not be set up. Try again in a moment.",
    },
    next: {
      title: "So, what shall we do?",
      body: "Anything here is a fine place to start, and none of it ties you to anything.",
      workLabel: "Put me to work",
      work: [
        { label: "Run my business", say: "Help me run my business." },
        { label: "Do some research", say: "I would like you to look into something for me." },
        { label: "Organise my day", say: "Organise my day for me." },
        { label: "Build and create", say: "I want to build something." },
      ] as readonly FirstRunOffer[],
      moreLabel: "Or something bigger",
      more: [
        { label: "Start a project", say: "I want to start a project." },
        { label: "Hire your first teammate", say: "I would like to hire a teammate and give them a job." },
        { label: "Put me in your pocket", say: "Put Murage on my phone." },
      ] as readonly FirstRunOffer[],
      hireWhy: "A teammate is a job, not a crowd. You say what the job is and they turn up and do it.",
    },
  },
  /**
   * The backups line on the closing card.
   *
   * It used to say backups were already running. They were not: turning them
   * on picks a folder and writes a recovery key, and Murage asks before doing
   * either. A first run that claimed it had done that would be lying in the
   * one place a person most needs to be able to believe it.
   *
   * So the default is chosen and the whole thing is one press, and the line
   * tells the truth about which of the two states this computer is in.
   */
  backups: {
    on: "Your backups are running quietly in the background. Nothing for you to do there.",
    offer: "One more thing worth a press. I can keep a private copy of everything on this computer, taken fresh every day.",
    offerSecond: "I will ask you where to keep it, write you a recovery key, and take the first one straight away.",
    turnOn: "Keep me backed up",
    working: "Setting your backups up",
    capturing: "Taking your first backup now. Murage closes and reopens its own window to do that, and comes back by itself.",
    cancelled: "Nothing was changed. Ask me again any time and we will do it then.",
    unfinished: "Your folder and your recovery key are saved. The daily run is not on yet, so ask me again and I will finish it.",
    failure: "That did not go through. Ask me again in a little while and we will try once more.",
    keptKey: "Keep the recovery key somewhere safe. Without it a backup cannot be opened, not even by me.",
  },
  phone: {
    phone: {
      title: "Put me in your pocket",
      body: "Point your phone's camera at this and Murage opens on it, already signed in.",
      second: "Nothing to install, and it stays on your own private network.",
      codeLabel: "Or type this code",
      typedLead: "No camera? Open this address on the other device and type the code.",
      refresh: "Give me a new code",
      preparing: "Getting your code ready",
      failure: "The code could not be made. Try again in a moment.",
      dismiss: "Not now",
    },
    "phone-needs-tailscale": {
      title: "One small thing first",
      body: "Your phone and this computer need a private line between them, and the app that makes one is called Tailscale.",
      second: "It is not set up here yet. I will walk you through it right here, one step at a time.",
      steps: [
        {
          label: "Get Tailscale",
          detail: "I will open its download page for you, and you install it the way you would install anything.",
          action: "Open the download page",
        },
        {
          label: "Sign in on this computer",
          detail: "Open Tailscale and sign in. Any of the sign in choices it offers is fine.",
          action: "Done, I signed in",
        },
        {
          label: "Back to me",
          detail: "I will look again, and if it is ready your code appears right here in the chat.",
          action: "Check now",
        },
      ] as readonly FirstRunWalkStep[],
      checking: "Looking",
      stillMissing: "Still not seeing it. Give it a moment to settle after signing in, then check again.",
      dismiss: "Not now",
    },
  },
  /**
   * What the composer says when it catches a key on its way into the chat.
   *
   * People paste a key wherever the conversation is, and the conversation is
   * the only thing on screen. A key that reaches send is a key in the
   * transcript, on disk, and in the next prompt a model reads, so the
   * composer takes it out of the message before anything leaves the machine
   * and says so plainly rather than silently eating what they typed.
   */
  pastedKey: {
    saved: "I caught that key before it reached our conversation and put it straight into secure storage. You are connected.",
    failed: "That looked like a key, so I kept it out of our conversation. It did not save though, so try it again on the key card.",
  },
  /** Said under a card that has been acted on, in place of a row of dead
   *  buttons. */
  settled: "Done",
} as const;

/**
 * The agents card on a machine that already had engines on it.
 *
 * Written as a function because the honest version of this sentence names
 * the real engines, and a card that said "I found your agents" without
 * naming them would be a card nobody could check. On a bare machine this is
 * never called: that is the "bare" variant, which says the opposite thing.
 */
export function foundAgentsLine(names: readonly string[]): string {
  const listed = joinNames(names);
  if (!listed) return "I have connected the engines that were already on this computer.";
  return `You already had ${listed} on this computer, so I have connected them.`;
}

/**
 * The machine with a model already running on it.
 *
 * WHAT THIS REPLACES. The person running llama.cpp or Ollama was told they
 * "already had OpenAI-compatible (OpenRouter / Groq)". That is an engine id
 * and two cloud vendors, said to somebody whose model is on their own hard
 * disk. It named the wrong thing and it named it wrongly.
 *
 * So the model is what gets said. Somebody who went and installed a local
 * model will recognise its name at a glance and will not recognise, or care
 * about, the connection type Murage reaches it through. Naming the server
 * too ("on Ollama") is what makes it checkable: they can go and look.
 *
 * `joinNames` is not reused here because these are not a list of peers, they
 * are one model in one place, and "Qwen3 and Ollama" would read as two
 * models.
 */
export function localModelLine(model: string, host: string): string {
  const named = model.trim();
  const where = host.trim();
  if (!named) return "You already have a local model running on this computer, so I have connected it.";
  if (!where) return `You already have ${named} running on this computer, so I have connected it.`;
  return `You already have ${named} running here on ${where}, so I have connected it.`;
}

/**
 * The agents card on a machine where an engine is installed and signed out.
 *
 * Names it, for the same reason `foundAgentsLine` names things: a sentence
 * about "an AI tool" that does not say which one is a sentence nobody can
 * check, and this person put it there themselves so they will recognise it
 * instantly.
 *
 * Says "you are not signed in", not "it is not working". Nothing is broken
 * and nothing was installed wrong. There is simply nobody signed in to it,
 * which is a true and unembarrassing thing to say to somebody who has done
 * nothing wrong.
 */
export function signedOutAgentsLine(names: readonly string[]): string {
  const listed = joinNames(names);
  if (!listed) return "There is an AI tool on this computer that nobody is signed in to.";
  // "signed in to it" reads as a mistake the moment there are two of them,
  // and two is the ordinary case on a developer's machine.
  const them = names.filter((name) => name.trim()).length > 1 ? "them" : "it";
  return `You have ${listed} on this computer, and nobody is signed in to ${them} yet.`;
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Fuigo". */
export function joinNames(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * A 24 hour time as a person says it out loud.
 *
 * "07:00" is how a time input speaks and "7:00 am" is how the owner's
 * mother reads a sentence, so every sentence in this flow that mentions a
 * time goes through here first.
 */
export function clockLabel(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return time.trim();
  const hours = Number(match[1]);
  const minutes = match[2];
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return time.trim();
  const suffix = hours < 12 ? "am" : "pm";
  const shown = hours % 12 === 0 ? 12 : hours % 12;
  return `${shown}:${minutes} ${suffix}`;
}

/** The second line of the brief-ran card: it is below, and from tomorrow it
 *  arrives without being asked. */
export function briefRanLine(time: string): string {
  return `It is just below. From tomorrow it arrives on its own at ${clockLabel(time)}.`;
}

/**
 * The confirmation under the two name fields, once the profile really saved.
 *
 * "Thank you, Sean. I have got that." was a receipt, and it read like one:
 * correct, and written by a form. This is the first sentence a chief of staff
 * ever says to the person they work for, and the right register is somebody
 * pleased to be starting, not somebody filing a record.
 */
export function greetingLine(name: string): string {
  const clean = name.trim();
  return clean ? `Good to meet you, ${clean}. Right then.` : "Good to meet you. Right then.";
}

/**
 * What the Chief calls somebody who skipped the name field.
 *
 * The approved flow says skipping sets the name to "there", and the sentence
 * it is there for is the Chief's question a step later: "What can I take off
 * your plate, there?", which reads correctly and warmly.
 *
 * IT IS A RENDER FALLBACK AND IT WRITES NOTHING. The simulation sets its own
 * `S.name`, which is a variable in a mock-up. The obvious translation of that
 * is to save "there" onto the owner profile when the step is skipped, and that
 * would be wrong twice over. It would put a word the person never typed into
 * the profile every other surface in the app reads from, and it would defeat
 * the greeting rule in the same spec: a skipped name DROPS the clause, so
 * `greetingLine` says "Good to meet you." and a stored "there" would make it
 * say "Good to meet you, there." Address and greeting want different things
 * from the same blank, which is only possible while the blank stays blank.
 *
 * So nothing is persisted, `live.ownerName` stays "" and `setupStepDone` keeps
 * treating the step as skipped rather than answered, and the only thing that
 * changes is the word on screen in the one sentence that needs one.
 */
export function firstRunAddress(name: string | null | undefined): string {
  return (name ?? "").trim() || "there";
}

/**
 * The detection report's opening line.
 *
 * It says the looking around happened WHILE THEY TYPED, because it did: the
 * hello card says so as they are filling it in, and a report that then claimed
 * to have gone away and looked would be describing a wait that never happened.
 *
 * A SKIPPED NAME DROPS THE CLAUSE RATHER THAN FILLING IT. "Good to meet you,
 * there. I had a look around" is a sentence nobody writes, and the whole
 * comma clause is what goes, not the greeting. This is the one place where
 * `firstRunAddress` would be wrong, which is why the two are separate
 * functions and neither calls the other.
 */
export function lookedAroundLine(name: string | null | undefined): string {
  return `${meetingGreeting(name)} I had a look around this computer while you typed.`;
}

/**
 * The same opening on a machine where nothing was found.
 *
 * It is the Flux screen's, not detection's, because detection never ran: a
 * machine with nothing to think with skips step two entirely, so this screen
 * owes the person the report as well as the offer. Saying what was looked FOR
 * is what makes the next sentence an explanation rather than a sales pitch.
 *
 * "found nothing I can think with" and not "found nothing". A bare machine
 * usually has plenty on it, including the engine in the box, which reports
 * itself available with an empty catalogue. What it has none of is something
 * to think with, and that distinction is the whole release.
 */
export function foundNothingLine(name: string | null | undefined): string {
  return `${meetingGreeting(name)} I looked around this computer while you typed and found nothing I can think with.`;
}

/** "Good to meet you, Sean." or, when the name was skipped, the greeting with
 *  the whole comma clause gone rather than "there" poured into it. */
function meetingGreeting(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  return clean ? `Good to meet you, ${clean}.` : "Good to meet you.";
}

/** The brief card's button, once a time is chosen. A button that repeats the
 *  choice back is a button nobody has to think about. */
export function briefButtonLabel(time: string): string {
  return `Set my brief for ${clockLabel(time)}`;
}

/** The default the brief card opens on. Early enough to be there first,
 *  late enough that nobody is reading it in the dark. */
export const FIRST_RUN_BRIEF_TIME = "07:00";
