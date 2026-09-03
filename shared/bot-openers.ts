/** The first line a brand-new bot says, before the setup question that
 *  follows it.
 *
 *  Register: understated, plain, a little dry. American spelling
 *  (`unspecialized`), British idiom welcome (`at a loose end`, `diary`,
 *  `more or less`). No exclamation marks, no "How can I help you today",
 *  no "I'm excited to", no "Let's get you set up".
 *
 *  Punctuation rule, enforced by a test rather than left to good manners:
 *  no em dash and no en dash anywhere in this module. Use commas, full
 *  stops or parentheses. The rule is mechanical because it is the kind of
 *  thing that quietly comes back when somebody adds a thirty-first line.
 *
 *  An opener never asks a question. The question is the card that follows
 *  it, so the greeting stays one stable string a test can pin.
 *
 *  Lives in `shared/` because both halves import it: the server seeds the
 *  transcript with it and the renderer's tests assert against the same
 *  array. `src/lib/` would make the server reach across the `@/` alias and
 *  `server/` would make a renderer test pull the server in.
 */

/** 30 templates. Every one contains `{name}` exactly once. */
export const BOT_OPENERS: readonly string[] = [
  "I'm {name}. Newly made, so there's nothing in my head yet.",
  "Hello. {name}, if we're doing names.",
  "{name} here. Blank slate, more or less.",
  "I'm {name}. No idea what I'm for yet, which is where you come in.",
  "Right. I'm {name}.",
  "Hello. I'm {name} and I have done precisely nothing so far.",
  "{name}. That's the name I've been given, anyway.",
  "I'm {name}. Fresh out of the box and slightly underemployed.",
  "Hello there. {name}.",
  "I'm {name}. I'd say I know my way around, but I've been here about four seconds.",
  "New bot, name of {name}.",
  "Hello. I'm {name}, and I'm as new as this window.",
  "{name}, at a loose end.",
  "I'm {name}. Empty head, willing hands.",
  "Hello. The name's {name}, which somebody else picked.",
  "I'm {name}. Nothing set up, nothing learned, nothing assumed.",
  "{name} here, waiting to be told what this is about.",
  "I'm {name}. So far my entire job description is this sentence.",
  "Hello. {name}. No history, no opinions, not yet.",
  "I'm {name}, and I'm starting from nothing, which is quite freeing.",
  "{name}. Brand new, in case that wasn't obvious.",
  "I'm {name}. Untrained, unhurried, ready when you are.",
  "Hello. I'm {name} and this is my first minute of existence.",
  "{name} speaking. Or typing.",
  "I'm {name}. I know your name is on the tab and that is genuinely all I have.",
  "Hello. {name} here, with an empty diary.",
  "I'm {name}. Nobody has told me anything yet.",
  "{name}. I'm new, so you'll have to fill in a few blanks.",
  "I'm {name}, freshly made and thoroughly unspecialized.",
  "Hello. I'm {name}. Let's work out what I'm actually for.",
];

/** The opener at `index`, rendered for `name`. Deterministic, so a test can
 *  pin every line. Any integer is valid: the index wraps, and negatives wrap
 *  the same way rather than reading off the front of the array. */
export function openerAt(index: number, name: string): string {
  const size = BOT_OPENERS.length;
  const slot = ((Math.trunc(index) % size) + size) % size;
  return BOT_OPENERS[slot].replaceAll("{name}", name);
}

/** What `createBot` calls.
 *
 *  `pick` returns a number in [0, 1) and exists so the seed is deterministic
 *  under test. The default is `Math.random`: rotation state that survived a
 *  restart would cost a migration, and an occasional repeat across two new
 *  bots costs nothing, because nobody reads two greetings side by side. */
export function openingLine(name: string, pick: () => number = Math.random): string {
  return openerAt(Math.floor(pick() * BOT_OPENERS.length), name);
}
