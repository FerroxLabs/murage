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
//   Flux Router leads with routing, then the apps, then pictures and voice.
//   Never describe a capability as a limit. Sending email is graduated
//     trust: you approve, I send, and then I can send that kind myself.
//   No school framing. Nobody is being taught a lesson.
//
// Three sentences is the ceiling for a card body, which is why most bodies
// here are two short fields rather than one long paragraph: the renderer sets
// them as separate lines and a person reads them as separate thoughts.

/** Where a person gets a Flux Router key. Mirrors FLUX_SIGNUP_URL in
 *  src/components/FluxRouterConnection.tsx, imported by the card itself so
 *  there is one URL and not two. */
import type { SetupCardVariant } from "../../shared/setup-card";

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

/** One connectable account, with the reason it is worth connecting said in a
 *  few words. The reason is the whole row: "Gmail" on its own is a logo, and
 *  "so I can read your mail and draft the replies" is an offer. */
export interface FirstRunAppRow {
  slug: string;
  label: string;
  why: string;
}

/** One thing the closing card can offer to do. `say` is the sentence that
 *  goes into the conversation when it is pressed, in the person's voice,
 *  because the answer to "what would you like to do" is them asking. */
export interface FirstRunOffer {
  label: string;
  say: string;
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
  welcome: "Hello",
  found: "What is already here",
  bare: "What is already here",
  "bare-needs-key": "What is already here",
  "signed-out": "What is already here",
  key: "One key",
  apps: "Where your work lives",
  "sample-brief": "Your mornings",
  "more-routines": "A couple more",
};

export function stepHeadingFor(variant: SetupCardVariant): string | null {
  return FIRST_RUN_STEP_HEADINGS[variant] ?? null;
}

export const FIRST_RUN_COPY = {
  hello: {
    welcome: {
      body: "Hello. I am your chief of staff, and I work for you.",
      second: "Tell me your name and where to reach you, and I will set the rest up around you.",
      nameLabel: "Your name",
      namePlaceholder: "What should I call you?",
      emailLabel: "Your email",
      emailPlaceholder: "you@example.com",
      submit: "That is me",
      working: "Saving",
      skip: "Skip this",
      detecting: "While you type, I am having a look around this computer to see what is already here.",
      failure: "That did not save. Try once more, or skip it and carry on.",
    },
  },
  agents: {
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
      third: "It brings pictures and transcription too, so you can talk to me from your phone.",
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
      /** They already have a working engine, so this is a genuine extra. */
      recommendationBonus: "Optional, and worth it. You are already up and running, and this adds all the latest models, your apps, pictures and voice on top.",
      fieldLabel: "Paste your key",
      placeholder: "Paste your Flux Router key here",
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
      secondBare: "Any OpenAI-style service you already pay for will do, and so will a model running on this computer. Add either one under Models in Settings and I will pick it up from there.",
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
      trust: "On email you stay in charge. You approve, I send. Once you trust me with a kind of email, I can send those myself.",
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
          why: "I sort the morning's mail and draft the replies. You approve, I send. Once you trust me with a kind of email, I can send those myself.",
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

/** The brief card's button, once a time is chosen. A button that repeats the
 *  choice back is a button nobody has to think about. */
export function briefButtonLabel(time: string): string {
  return `Set my brief for ${clockLabel(time)}`;
}

/** The default the brief card opens on. Early enough to be there first,
 *  late enough that nobody is reading it in the dark. */
export const FIRST_RUN_BRIEF_TIME = "07:00";
