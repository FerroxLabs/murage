// Bot name generator — a curated local list beats a naming API: instant,
// offline, and every name is on-brand (short, friendly, a little pet-like,
// which suits the Ember). Picks avoid names already in use; when the pool is
// exhausted it falls back to "Name 2", "Name 3", …
const NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Waffle", "Ziggy", "Noodle",
  "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
  "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli",
  "Ursa", "Yuki", "Zuko", "Momo", "Kiwi", "Plum", "Sprout", "Turnip",
];

/** The first Ember is always "Ember" — she is the default on a fresh start,
 *  in the brand's warm orange. Everyone after her gets a name from the pool. */
export const DEFAULT_BOT_NAME = "Ember";
export const DEFAULT_BOT_COLOR = "orange" as const;

export function pickBotName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  if (used.size === 0) return DEFAULT_BOT_NAME;
  const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  // pool exhausted — number a random base name
  const base = NAMES[Math.floor(Math.random() * NAMES.length)];
  for (let i = 2; ; i++) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}
