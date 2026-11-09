// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: the words on each release's page, as data, one entry per
// version. Every release gets its own page, even a small one: a hero, then
// 1 to 6 tiles and a list of small wins when there are any. There is no
// fallback content: a version missing here has no page, and the dialog shows
// nothing for it.
//
// Pictures are named, not imported: WhatsNewDialog.tsx turns each name into
// its file in src/assets/whats-new, and only that lazy chunk loads them, so
// this table and every picture stay out of the first paint. The spec in
// src/e2e reads this file in Node, which is why it imports nothing.
//
// src/lib/whats-new.ts says which versions have a page (WHATS_NEW_BY_VERSION,
// first paint, no words); whats-new.test.ts fails when the two disagree or
// when package.json's version has no page here.
//
// Copy: plain words, no em dashes, never "safe" or "free", Fuigo and Flux
// first where they belong, and every tile and button goes to a real place.

export type WhatsNewAction =
  | "teams" | "rooms" | "blocks" | "packs" | "shapes" | "gemini" | "longwork"
  | "memory" | "routing" | "engines" | "chrome" | "speed" | "desktops" | "library"
  | "allChats" | "draftOnly" | "venues" | "ownWords" | "fuigo" | "backups"
  | "needsYou" | "health";

/** The pictures in src/assets/whats-new, by file name. */
export type WhatsNewArt =
  | "team-hero" | "memory-hero"
  | "tile-blocks" | "tile-chrome" | "tile-desktops" | "tile-engines" | "tile-gemini" | "tile-labs" | "tile-longwork"
  | "tile-packs" | "tile-rooms" | "tile-routing" | "tile-shapes" | "tile-speed"
  | "tile-fuigo-start" | "tile-one-place";

export type WhatsNewTile = { action: WhatsNewAction; art: WhatsNewArt; alt: string; dot: string; title: string; body: string };
export type WhatsNewHero = { art: WhatsNewArt; alt: string; fit: string; title: string; body: string; action: WhatsNewAction; button: string };
export type WhatsNewPageContent = {
  hero: WhatsNewHero;
  /** 0 to 6. With none, the page has no tiles card. */
  tiles: readonly WhatsNewTile[];
  /** The tiles card's title. */
  tilesTitle?: string;
  /** With none, the page has no list card. */
  more: readonly string[];
};
export type WhatsNewCardKind = "hero" | "highlights" | "more";

/** The cards a page shows, in order: the hero, then tiles and list when it has them. */
export function whatsNewCards(page: WhatsNewPageContent): WhatsNewCardKind[] {
  return ["hero", ...(page.tiles.length ? ["highlights" as const] : []), ...(page.more.length ? ["more" as const] : [])];
}

// Square tile art in a hero is shown whole at the right, so it stays clear of the title.
const SQUARE_HERO = "object-contain object-right";

export const WHATS_NEW_TILES: WhatsNewTile[] = [
  { action: "rooms", art: "tile-rooms", alt: "Three glowing orange glass pebbles sharing one pool of light", dot: "bg-[var(--wn-accent)]", title: "Rooms that work as one", body: "Every bot in a room sees what its teammates said, and bots on Fuigo can ask and hand off to teammates again." },
  { action: "blocks", art: "tile-blocks", alt: "A stack of gold glass slabs with one slid forward", dot: "bg-[var(--wn-dot-gold)]", title: "Saved prompt blocks", body: "Save a character or a brand look as a named block, and every change keeps its own version." },
  { action: "packs", art: "tile-packs", alt: "A fan of blank violet glass panes", dot: "bg-[var(--wn-dot-violet)]", title: "Reference packs", body: "Keep up to 16 reference images as a named pack and use them again whenever you need them." },
  { action: "shapes", art: "tile-shapes", alt: "Four blue frames of light in different proportions", dot: "bg-[var(--wn-dot-blue)]", title: "Any shape, any size", body: "Portrait, landscape or exact pixels, several at once, PNG, JPEG or WebP, a seed or a clear background, where the model allows." },
  { action: "gemini", art: "tile-gemini", alt: "Two mint spheres joined by a looping ribbon of light", dot: "bg-[var(--wn-dot-mint)]", title: "Gemini for chat and images", body: "Add your Google Gemini key once and bots can chat on Gemini and make images with it." },
  { action: "longwork", art: "tile-longwork", alt: "One unbroken line of white light crossing a dark plain", dot: "bg-[var(--wn-ink)]", title: "Work runs to the end", body: "No fixed clocks: a working turn or a long command stops only when it goes quiet or you press Stop." },
];

export const WHATS_NEW_MORE: string[] = [
  "Your recovery key stays out of cloud-synced folders",
  "A one-time Move for a recovery key that already syncs",
  "Translations load when you pick them, so Murage opens faster",
  "The first 10 images in a message go through, with a note for the rest",
  "Withheld replies stay withheld, in memory and handoffs too",
  "Each teammate gets its turn right after its own reply",
  "Room replies stop only after 20 quiet minutes",
  "Long image renders are followed to the end",
  "See each image model's limits and when it last worked",
  "Every saved image-capable key shows in Image generation",
  "Slow models on MiniMax, xAI and OpenAI-compatible engines get time to answer",
  "Tool names match the engine each bot runs on",
];

/** The 1.0.2 tiles, from the 1.0.2 changelog. Each opens a real place in the app. */
export const WHATS_NEW_TILES_102: WhatsNewTile[] = [
  { action: "routing", art: "tile-routing", alt: "A ring of dim glass pebbles with one glowing orange pebble picked out by a thread of light", dot: "bg-[var(--wn-accent)]", title: "Ask the room, the right bot answers", body: "In a group chat, Murage picks the bot best placed to reply, in about a second." },
  { action: "library", art: "tile-labs", alt: "Five white glass pebbles in a crescent, one with a warm glow", dot: "bg-[var(--wn-ink)]", title: "Six teams, ready to hire", body: "Dev Shop, Marketing Agency, SEO Content Engine Room, Rival Watch, Follow-Up Desk and Community Lead Finder, each with a lead, a workflow and a first routine." },
  { action: "engines", art: "tile-engines", alt: "A glowing blue sphere resting among three differently shaped glass cradles", dot: "bg-[var(--wn-dot-blue)]", title: "Any model, any bot", body: "Move a bot between Claude, GPT, Grok and Gemini. It keeps working and tells you what it can do there." },
  { action: "chrome", art: "tile-chrome", alt: "Two matching gold glass rings, one set inside the other", dot: "bg-[var(--wn-dot-gold)]", title: "Your bot, right in Chrome", body: "Work beside your bot in Chrome, with its own name and colour and the same access levels you use in the app." },
  { action: "speed", art: "tile-speed", alt: "One calm ribbon of mint light running smoothly across a dark plane", dot: "bg-[var(--wn-dot-mint)]", title: "Long chats stay quick", body: "Memory answers in about a tenth of a second, even on a long history, and takes a fraction of the disk." },
  { action: "desktops", art: "tile-desktops", alt: "A neat row of eight violet glass panes, one slightly brighter", dot: "bg-[var(--wn-dot-violet)]", title: "Up to eight desktops per bot", body: "Give a busy bot several local desktops of its own and let it work on them side by side." },
];

export const WHATS_NEW_MORE_102: string[] = [
  "Memory stays compact on long conversations",
  "A Needs you block and an Inbox card list the memories waiting for your word",
  "Keep, Keep all, Later, Edit and Undo on every waiting memory",
  "One quiet note on your phone when memories are waiting",
  "Unmatched actions sit in the Inspector beside the chat",
  "House rules keep every word you type",
  "Pictures through Flux use Flux's live image service",
  "Murage checks your Flux key once and waits for you",
  "Up to eight desktops, one for each bot",
  "MCP tools start from Windows command shims",
  "Phone pairing picks your real Wi-Fi or Ethernet address",
  "Every release is checked on an Intel Mac",
];

/** The 1.0.6 tiles, from the 1.0.6 changelog, on art already in the app. Each opens a real place in the app. */
export const WHATS_NEW_TILES_106: WhatsNewTile[] = [
  { action: "allChats", art: "tile-blocks", alt: "A stack of gold glass slabs with one slid forward", dot: "bg-[var(--wn-dot-gold)]", title: "Every chat in one list", body: "Find any conversation in one searchable list, opened from a wider chat pop-up." },
  { action: "draftOnly", art: "tile-packs", alt: "A fan of blank violet glass panes", dot: "bg-[var(--wn-dot-violet)]", title: "Bots that draft, you send", body: "A draft-only bot prepares replies for you to review and send, on every engine and channel. Ticket Triage in the library works this way." },
  { action: "venues", art: "tile-rooms", alt: "Three glowing orange glass pebbles sharing one pool of light", dot: "bg-[var(--wn-accent)]", title: "Bots know where they belong", body: "Each bot knows which projects and groups it is part of." },
  { action: "ownWords", art: "tile-gemini", alt: "Two mint spheres joined by a looping ribbon of light", dot: "bg-[var(--wn-dot-mint)]", title: "Memories in your own words", body: "What your bots learn from you is anchored to what you said, and Forget clears it the moment you click." },
  { action: "fuigo", art: "tile-speed", alt: "One calm ribbon of mint light running smoothly across a dark plane", dot: "bg-[var(--wn-dot-blue)]", title: "Fuigo starts fast on Windows", body: "Fuigo starts quickly and steadily on Windows, however Murage was installed." },
  { action: "backups", art: "tile-longwork", alt: "One unbroken line of white light crossing a dark plain", dot: "bg-[var(--wn-ink)]", title: "Backups that cover it all", body: "Every backup includes every folder Murage keeps." },
];

export const WHATS_NEW_MORE_106: string[] = [
  "At Full access, your own scripts on disk run straight through",
  "Bots look through your past chats without stopping to ask",
  "A new chat follows its bot's model, and the chip shows it",
  "Chats keep their live updates on a desktop with no internet",
  "Hand-offs wait for their check, then land in the right chat",
  "A Codex that needs a moment to start says so",
  "Stop on a Codex turn ends it as stopped by you",
  "Stop on a shared cloud computer ends just your turn",
  "Deleting conversations on long histories finishes faster",
  "Account and card numbers are masked in more formats, IBANs included",
  "An app connects under the label you confirm",
  "Library cards say plainly what each template does for you",
];

/** 1.0.14, from release-notes/1.0.14.md: a hero and the list, no tiles. */
export const WHATS_NEW_MORE_1014: string[] = [
  "Fuigo 1.0.38 brings in a trusted folder's project instructions at the next turn",
  "On Flux Router, a new chat starts straight away in its own work folder",
  "A bot's voice note plays on your phone and in the browser too",
  "A voice note or file sent partway through a turn sits in its reply",
  "Health and Today say Checking sign-in until Murage knows",
  "Needs you asks you to sign in only to engines your bots or routines use",
  "When Murage can't read a command, its approval card says so and asks first",
  "A PowerShell command split across lines gets the same checks as one line",
  "A queued message shows its images and files as chips",
  "A turn cut short by a restart shows it did not finish",
];

/** The 1.0.15 tiles, from what merged to int/1015. Each opens a real place in the app. */
export const WHATS_NEW_TILES_1015: WhatsNewTile[] = [
  { action: "needsYou", art: "tile-one-place", alt: "Thin threads of orange light gathering into one small glowing glass dish", dot: "bg-[var(--wn-accent)]", title: "Answer in one place", body: "A bot waiting on you shows one line in the chat. Answer it in the panel above the box, or from the bar on your phone." },
  { action: "allChats", art: "tile-blocks", alt: "A stack of gold glass slabs with one slid forward", dot: "bg-[var(--wn-dot-gold)]", title: "All chats, easier to get around", body: "All chats has Back and a close button at the top right, like every other page." },
  { action: "health", art: "tile-longwork", alt: "One unbroken line of white light crossing a dark plain", dot: "bg-[var(--wn-ink)]", title: "Esc closes what's on top", body: "Esc closes the menu or panel in front first. Health closes with Back, its close button or Esc." },
];

export const WHATS_NEW_MORE_1015: string[] = [
  "Waiting messages fold to one tidy line each",
  "Memories keep what you said, not tool output",
  "Murage opens faster",
];

/** 1.0.16, from release-notes/1.0.16.md: a hero and the list, no tiles. */
export const WHATS_NEW_MORE_1016: string[] = [
  "Rows in Needs you open in place, so you can answer without leaving the list",
  "Every bot replies the same way: the answer first, one question at a time",
  "A team lead bot can now set up a new section for a client",
  "Bundled Fuigo moves to 1.0.39",
  "Pi tells you when a session is slow to start, and shows what it costs",
  "Entering the pairing code on your phone is quicker",
  "In a call, the transcript matches the words that were spoken",
];

/** 1.0.17, from release-notes/1.0.17.md: a hero and the list, no tiles. */
export const WHATS_NEW_MORE_1017: string[] = [
  "Settings search takes you straight to the setting",
  "Ask about this screen puts your question into your Chief of Staff's chat",
  "Choose the font Murage uses in Settings",
  "A reply with a wide table uses the full width of the chat",
  "With your own ElevenLabs key, search the Voice Library and add a voice",
  "If a bot paused your browser, Murage shows how to resume",
  "Commands that run PowerShell are checked faster",
];

/** 1.0.18, from release-notes/1.0.18.md: a hero and the list, no tiles. */
export const WHATS_NEW_MORE_1018: string[] = [
  "No limits: when you start the request yourself, your bot gets on with the job, and Murage keeps your keys, sign-ins and other protected places protected",
  "Today has a Calm view and a Detailed view",
  "Search all your chats from one box",
  "A bot can read your other chats, and you pick the excerpts it shares into a room",
  "Muse Code joins the engine list",
  "Use my Chrome setup takes you through it in three steps",
  "The phone app has tabs and a You sheet",
  "Fuigo 1.0.40 is on board",
  "The dollar meter gives you a heads-up at 80 percent",
  "A notice tells you when a new version is ready",
  "Stop works on every engine, and usage is counted on each",
];

const PAGE_0161: WhatsNewPageContent = {
  hero: { art: "team-hero", alt: "A constellation of orange orbs of light, each joined to every other by fine threads", fit: "object-cover", title: "Your team, in step.", body: "Every bot in a room sees what its teammates said, on every engine. Images get saved looks and reference packs, and long work runs until it is done.", action: "teams", button: "Open Teams" },
  tiles: WHATS_NEW_TILES,
  more: WHATS_NEW_MORE,
};

/** Every page, by version. One entry per release from 1.0.14 on. */
export const WHATS_NEW_PAGES: Readonly<Record<string, WhatsNewPageContent>> = {
  // 0.1.59 and 0.1.60 show the 0.1.61 words: those versions' own code had their pages.
  "0.1.59": PAGE_0161,
  "0.1.60": PAGE_0161,
  "0.1.61": PAGE_0161,
  "1.0.2": {
    hero: { art: "memory-hero", alt: "A slim glowing column of fine glass layers with one small orange orb leaning toward you", fit: "object-cover", title: "Bots that remember what matters", body: "Your bots now check with you before they keep something about you. Keep it, edit it or let it go from one Needs you list.", action: "memory", button: "Open Memory" },
    tiles: WHATS_NEW_TILES_102,
    more: WHATS_NEW_MORE_102,
  },
  "1.0.6": {
    hero: { art: "tile-chrome", alt: "Two matching gold glass rings, one set inside the other", fit: SQUARE_HERO, title: "Murage for Chrome is here", body: "Add it from the Chrome Web Store and your bot works beside you in your own browser, on the sites you choose.", action: "chrome", button: "Open Chrome Web Store" },
    tiles: WHATS_NEW_TILES_106,
    more: WHATS_NEW_MORE_106,
  },
  "1.0.14": {
    hero: { art: "tile-engines", alt: "A glowing blue sphere resting among three differently shaped glass cradles", fit: SQUARE_HERO, title: "Sign in with one button", body: "First run sets you up on Fuigo and Flux. Signing in to any other engine is one button in Settings, with no terminal and no commands to copy, and Ember in chat gives you the same button.", action: "engines", button: "Open Engines" },
    tiles: [],
    more: WHATS_NEW_MORE_1014,
  },
  "1.0.15": {
    hero: { art: "tile-fuigo-start", alt: "A small blue sphere of light settling into a softly lit glass cradle", fit: SQUARE_HERO, title: "New bots start on Fuigo", body: "A new bot you have not picked an engine for starts on Fuigo when Fuigo can answer, and otherwise on the engine Murage found on this computer, so your first chat gets a reply.", action: "fuigo", button: "Open Engines" },
    tiles: WHATS_NEW_TILES_1015,
    tilesTitle: "Less in your way",
    more: WHATS_NEW_MORE_1015,
  },
  "1.0.16": {
    hero: { art: "tile-longwork", alt: "One unbroken line of white light crossing a dark plain", fit: SQUARE_HERO, title: "Health shows what to fix first", body: "Health lists what needs your attention in order, Flux and Fuigo first, with one button to fix each and a way to check again.", action: "health", button: "Open Health" },
    tiles: [],
    more: WHATS_NEW_MORE_1016,
  },
  "1.0.17": {
    hero: { art: "tile-blocks", alt: "A stack of gold glass slabs with one slid forward", fit: SQUARE_HERO, title: "Approve all", body: "Answer a stack of waiting requests in one go from Needs you. Payments, email, deleting and other big steps still wait for you one by one.", action: "needsYou", button: "Open Needs you" },
    tiles: [],
    more: WHATS_NEW_MORE_1017,
  },
  "1.0.18": {
    hero: { art: "tile-one-place", alt: "Thin threads of orange light gathering into one small glowing glass dish", fit: SQUARE_HERO, title: "Approve in one tap", body: "Answer a waiting request right inside Needs you, or Approve all for the stack. A refusal still shows its reason.", action: "needsYou", button: "Open Needs you" },
    tiles: [],
    more: WHATS_NEW_MORE_1018,
  },
};

/** The page for `version`, or null: never another version's words. */
export function whatsNewContent(version: string | undefined): WhatsNewPageContent | null {
  return version !== undefined && Object.hasOwn(WHATS_NEW_PAGES, version) ? WHATS_NEW_PAGES[version]! : null;
}
