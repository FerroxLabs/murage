// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new in 0.1.61 and 1.0.2: three cards in the approved 0.1.59 design (the
// whats-new-art/mockup-boards WN1, WN3 and WN4 layouts), with the copy and art
// Sean approved in whats-new-art-0161 (preview.html, brief.md). Sizes and
// colours are the mockups'; the colours are the `--wn-*` art-panel tokens in
// styles.css, which do not follow the skin.
//
// The dialog only presents, and loads on first open (WhatsNewHost.tsx), so
// none of it rides the first paint. Whoever mounts it decides what each
// shortcut does and records the page as seen when it closes, however it
// closes: X (card 1, as in the mockups), Escape, Got it, Let's go, or any
// shortcut.
//
// 1.0.2 has its own hero, six tiles and list (whats-new-art-0102). 1.0.6 leads
// with Murage for Chrome in the Chrome Web Store and reuses that art, no new
// pictures. Every other version with a page keeps the 0.1.61 content. The
// pictures all load with this lazy chunk, never with the first paint.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import teamHero from "@/assets/whats-new/team-hero.webp";
import tileRooms from "@/assets/whats-new/tile-rooms.webp";
import tileBlocks from "@/assets/whats-new/tile-blocks.webp";
import tilePacks from "@/assets/whats-new/tile-packs.webp";
import tileShapes from "@/assets/whats-new/tile-shapes.webp";
import tileGemini from "@/assets/whats-new/tile-gemini.webp";
import tileLongwork from "@/assets/whats-new/tile-longwork.webp";
import memoryHero from "@/assets/whats-new/memory-hero.webp";
import tileRouting from "@/assets/whats-new/tile-routing.webp";
import tileEngines from "@/assets/whats-new/tile-engines.webp";
import tileChrome from "@/assets/whats-new/tile-chrome.webp";
import tileSpeed from "@/assets/whats-new/tile-speed.webp";
import tileDesktops from "@/assets/whats-new/tile-desktops.webp";
import tileLabs from "@/assets/whats-new/tile-labs.webp";

export type WhatsNewAction =
  | "teams" | "rooms" | "blocks" | "packs" | "shapes" | "gemini" | "longwork"
  | "memory" | "routing" | "engines" | "chrome" | "speed" | "desktops" | "library"
  | "allChats" | "draftOnly" | "venues" | "ownWords" | "fuigo" | "backups";

type Tile = { action: Exclude<WhatsNewAction, "teams" | "memory">; img: string; alt: string; dot: string; title: string; body: string };

export const WHATS_NEW_CARD_COUNT = 3;

export const WHATS_NEW_TILES: Tile[] = [
  { action: "rooms", img: tileRooms, alt: "Three glowing orange glass pebbles sharing one pool of light", dot: "bg-[var(--wn-accent)]", title: "Rooms that work as one", body: "Every bot in a room sees what its teammates said, and bots on Fuigo can ask and hand off to teammates again." },
  { action: "blocks", img: tileBlocks, alt: "A stack of gold glass slabs with one slid forward", dot: "bg-[var(--wn-dot-gold)]", title: "Saved prompt blocks", body: "Save a character or a brand look as a named block, and every change keeps its own version." },
  { action: "packs", img: tilePacks, alt: "A fan of blank violet glass panes", dot: "bg-[var(--wn-dot-violet)]", title: "Reference packs", body: "Keep up to 16 reference images as a named pack and use them again whenever you need them." },
  { action: "shapes", img: tileShapes, alt: "Four blue frames of light in different proportions", dot: "bg-[var(--wn-dot-blue)]", title: "Any shape, any size", body: "Portrait, landscape or exact pixels, several at once, PNG, JPEG or WebP, a seed or a clear background, where the model allows." },
  { action: "gemini", img: tileGemini, alt: "Two mint spheres joined by a looping ribbon of light", dot: "bg-[var(--wn-dot-mint)]", title: "Gemini for chat and images", body: "Add your Google Gemini key once and bots can chat on Gemini and make images with it." },
  { action: "longwork", img: tileLongwork, alt: "One unbroken line of white light crossing a dark plain", dot: "bg-[var(--wn-ink)]", title: "Work runs to the end", body: "No fixed clocks: a working turn or a long command stops only when it goes quiet or you press Stop." },
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
export const WHATS_NEW_TILES_102: Tile[] = [
  { action: "routing", img: tileRouting, alt: "A ring of dim glass pebbles with one glowing orange pebble picked out by a thread of light", dot: "bg-[var(--wn-accent)]", title: "Ask the room, the right bot answers", body: "In a group chat, Murage picks the bot best placed to reply, in about a second." },
  { action: "library", img: tileLabs, alt: "Five white glass pebbles in a crescent, one with a warm glow", dot: "bg-[var(--wn-ink)]", title: "Six teams, ready to hire", body: "Dev Shop, Marketing Agency, SEO Content Engine Room, Rival Watch, Follow-Up Desk and Community Lead Finder, each with a lead, a workflow and a first routine." },
  { action: "engines", img: tileEngines, alt: "A glowing blue sphere resting among three differently shaped glass cradles", dot: "bg-[var(--wn-dot-blue)]", title: "Any model, any bot", body: "Move a bot between Claude, GPT, Grok and Gemini. It keeps working and tells you what it can do there." },
  { action: "chrome", img: tileChrome, alt: "Two matching gold glass rings, one set inside the other", dot: "bg-[var(--wn-dot-gold)]", title: "Your bot, right in Chrome", body: "Work beside your bot in Chrome, with its own name and colour and the same access levels you use in the app." },
  { action: "speed", img: tileSpeed, alt: "One calm ribbon of mint light running smoothly across a dark plane", dot: "bg-[var(--wn-dot-mint)]", title: "Long chats stay quick", body: "Memory answers in about a tenth of a second, even on a long history, and takes a fraction of the disk." },
  { action: "desktops", img: tileDesktops, alt: "A neat row of eight violet glass panes, one slightly brighter", dot: "bg-[var(--wn-dot-violet)]", title: "Up to eight desktops per bot", body: "Give a busy bot several local desktops of its own and let it work on them side by side." },
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
export const WHATS_NEW_TILES_106: Tile[] = [
  { action: "allChats", img: tileBlocks, alt: "A stack of gold glass slabs with one slid forward", dot: "bg-[var(--wn-dot-gold)]", title: "Every chat in one list", body: "Find any conversation in one searchable list, opened from a wider chat pop-up." },
  { action: "draftOnly", img: tilePacks, alt: "A fan of blank violet glass panes", dot: "bg-[var(--wn-dot-violet)]", title: "Bots that draft, you send", body: "A draft-only bot prepares replies for you to review and send, on every engine and channel. Ticket Triage in the library works this way." },
  { action: "venues", img: tileRooms, alt: "Three glowing orange glass pebbles sharing one pool of light", dot: "bg-[var(--wn-accent)]", title: "Bots know where they belong", body: "Each bot knows which projects and groups it is part of." },
  { action: "ownWords", img: tileGemini, alt: "Two mint spheres joined by a looping ribbon of light", dot: "bg-[var(--wn-dot-mint)]", title: "Memories in your own words", body: "What your bots learn from you is anchored to what you said, and Forget clears it the moment you click." },
  { action: "fuigo", img: tileSpeed, alt: "One calm ribbon of mint light running smoothly across a dark plane", dot: "bg-[var(--wn-dot-blue)]", title: "Fuigo starts fast on Windows", body: "Fuigo starts quickly and steadily on Windows, however Murage was installed." },
  { action: "backups", img: tileLongwork, alt: "One unbroken line of white light crossing a dark plain", dot: "bg-[var(--wn-ink)]", title: "Backups that cover it all", body: "Every backup includes every folder Murage keeps." },
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

export type WhatsNewContentId = "0.1.61" | "1.0.2" | "1.0.6";

/** Which content a page shows: 1.0.2 and 1.0.6 have their own; every other version with a page keeps 0.1.61's. */
export function whatsNewContentFor(version: string | undefined): WhatsNewContentId {
  return version === "1.0.2" || version === "1.0.6" ? version : "0.1.61";
}

type Hero = { img: string; alt: string; fit: string; title: string; body: string; action: "teams" | "memory" | "chrome"; button: string };

/** Each content set: the hero, the six tiles and the list of small wins. */
export const WHATS_NEW_CONTENT: Readonly<Record<WhatsNewContentId, { hero: Hero; tiles: Tile[]; more: string[] }>> = {
  "0.1.61": {
    hero: { img: teamHero, alt: "A constellation of orange orbs of light, each joined to every other by fine threads", fit: "object-cover", title: "Your team, in step.", body: "Every bot in a room sees what its teammates said, on every engine. Images get saved looks and reference packs, and long work runs until it is done.", action: "teams", button: "Open Teams" },
    tiles: WHATS_NEW_TILES,
    more: WHATS_NEW_MORE,
  },
  "1.0.2": {
    hero: { img: memoryHero, alt: "A slim glowing column of fine glass layers with one small orange orb leaning toward you", fit: "object-cover", title: "Bots that remember what matters", body: "Your bots now check with you before they keep something about you. Keep it, edit it or let it go from one Needs you list.", action: "memory", button: "Open Memory" },
    tiles: WHATS_NEW_TILES_102,
    more: WHATS_NEW_MORE_102,
  },
  // The Chrome art is square: shown whole at the right, so the rings stay clear of the title.
  "1.0.6": {
    hero: { img: tileChrome, alt: "Two matching gold glass rings, one set inside the other", fit: "object-contain object-right", title: "Murage for Chrome is here", body: "Add it from the Chrome Web Store and your bot works beside you in your own browser, on the sites you choose.", action: "chrome", button: "Open Chrome Web Store" },
    tiles: WHATS_NEW_TILES_106,
    more: WHATS_NEW_MORE_106,
  },
};

// Shared control styles. 44px targets everywhere; a visible focus ring that
// reads on the dark panels.
const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wn-accent)]";
const primaryDark = cn("min-h-11 cursor-pointer rounded-xl border-0 bg-[var(--wn-accent)] px-5 text-[14px] font-semibold text-[var(--wn-on-accent)] hover:brightness-110", focusRing);
const ghostDark = cn("min-h-11 cursor-pointer rounded-xl border border-[var(--wn-ghost-edge)] bg-transparent px-[18px] text-[14px] font-medium text-[var(--wn-ink)] hover:bg-white/5", focusRing);
const headingFocus = "outline-none";

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

/** One dot per card, the current one a long pill. Each dot is a button that
 *  goes to its card, on every card: on the last card the dots used to be a
 *  picture, and there was no way back at all. */
function Pager({ index, onGo }: { index: number; onGo?: (index: number) => void }) {
  return (
    <span role="group" aria-label={`Card ${index + 1} of ${WHATS_NEW_CARD_COUNT}`} className="flex">
      {Array.from({ length: WHATS_NEW_CARD_COUNT }, (_, dot) => (
        <button
          key={dot}
          type="button"
          data-whats-new-dot={dot}
          aria-label={`Card ${dot + 1}`}
          aria-current={dot === index ? "step" : undefined}
          onClick={() => onGo?.(dot)}
          className={cn("flex min-h-11 min-w-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 px-[3px]", focusRing)}
        >
          <span aria-hidden="true" className={cn("block h-1.5 rounded-[3px]", dot === index ? "w-[18px] bg-[var(--wn-accent)]" : "w-1.5 bg-[var(--wn-ghost-edge)]")} />
        </button>
      ))}
    </span>
  );
}

export interface WhatsNewCardProps {
  index: number;
  /** Which version's page this is. Without it, the 0.1.61 page. */
  version?: string;
  releaseNotesUrl: string;
  onNext: () => void;
  /** The card before this one. Offered on every card after the first. */
  onBack?: () => void;
  /** A pager dot: straight to that card. */
  onGo?: (index: number) => void;
  onClose: () => void;
  onAction: (action: WhatsNewAction) => void;
  headingRef?: (node: HTMLHeadingElement | null) => void;
}

/** One card, by index. Rendered alone by the tests; the dialog wraps it. */
export function WhatsNewCard({ index, version, releaseNotesUrl, onNext, onBack, onGo, onClose, onAction, headingRef }: WhatsNewCardProps): ReactNode {
  const titleId = `whats-new-title-${index + 1}`;
  const { hero, tiles, more } = WHATS_NEW_CONTENT[whatsNewContentFor(version)];
  if (index === 0) {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="hero" className="whats-new-card max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(820px,calc(100vw-32px))] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
        <div className="relative h-[342px] bg-[var(--wn-ground)] max-md:h-[260px] [@media(max-height:720px)]:h-[250px]">
          <img src={hero.img} alt={hero.alt} width={820} height={342} className={cn("block h-full w-full", hero.fit)} />
          <div className="absolute left-[34px] top-[26px] flex gap-2">
            <span className="rounded-full border border-[var(--wn-chip-edge)] bg-[var(--wn-chip-ground)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-accent-ink)]">NEW IN MURAGE</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={cn("absolute right-3.5 top-3.5 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-[var(--wn-close-ground)] text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", focusRing)}><CloseIcon /></button>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display absolute bottom-[30px] left-[34px] right-[34px] m-0 text-[58px] leading-none tracking-[-0.01em] text-[var(--wn-ink-strong)] max-sm:text-[44px]", headingFocus)}>{hero.title}</h2>
        </div>
        <div className="flex flex-col gap-3.5 px-[34px] pb-[26px] pt-6 max-sm:px-5">
          <p className="m-0 text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)]">{hero.body}</p>
          <div className="mt-1.5 flex items-center gap-2.5">
            <button type="button" className={primaryDark} onClick={() => onAction(hero.action)}>{hero.button}</button>
            <button type="button" className={ghostDark} onClick={onNext}>Next</button>
            <span className="grow" />
            <Pager index={0} onGo={onGo} />
          </div>
        </div>
      </section>
    );
  }
  if (index === 1) {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="highlights" className="whats-new-card box-border flex max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(1040px,calc(100vw-32px))] flex-col gap-5 overflow-y-auto rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel-deep)] px-8 pb-[26px] pt-[30px] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-sm:px-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND THERE'S MORE</span>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Made for bigger work</h2>
        </div>
        <ul className="m-0 grid list-none grid-cols-3 gap-3.5 p-0 max-[820px]:grid-cols-2 max-sm:grid-cols-1">
          {tiles.map((tile) => (
            <li key={tile.action} className="flex">
              <button
                type="button"
                data-whats-new-tile={tile.action}
                onClick={() => onAction(tile.action)}
                className={cn("flex w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-[var(--wn-tile-edge)] bg-[var(--wn-tile)] p-0 text-left text-[var(--wn-ink)] transition-colors hover:border-[var(--wn-ghost-edge)]", focusRing)}
              >
                <img src={tile.img} alt={tile.alt} width={316} height={150} className="block h-[150px] w-full object-cover [@media(max-height:720px)]:h-[100px]" />
                <span className="flex flex-col gap-1 px-3.5 pb-3.5 pt-3">
                  <span className="flex items-center gap-2"><span aria-hidden="true" className={cn("size-2 rounded-full", tile.dot)} /><span className="text-[14.5px] font-semibold">{tile.title}</span></span>
                  <span className="text-[13px] leading-normal text-[var(--wn-ink-muted)]">{tile.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2.5">
          <button type="button" className={ghostDark} onClick={onBack}>Back</button>
          <button type="button" className={primaryDark} onClick={onNext}>Next</button>
          <button type="button" className={ghostDark} onClick={onClose}>Got it</button>
          <span className="grow" />
          <span className="text-[12.5px] text-[var(--wn-ink-faint)] max-sm:hidden">Click any card to try it</span>
          <span className="ml-3.5"><Pager index={1} onGo={onGo} /></span>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby={titleId} data-whats-new-card="more" className="whats-new-card relative box-border flex max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(900px,calc(100vw-32px))] flex-col gap-[22px] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel)] px-[38px] pb-7 pt-[34px] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-sm:px-5">
      <svg width="420" height="420" viewBox="0 0 420 420" aria-hidden="true" className="pointer-events-none absolute -right-[120px] -top-[150px]">
        <g fill="none" stroke="var(--wn-accent)" strokeOpacity="0.18"><circle cx="210" cy="210" r="90" /><circle cx="210" cy="210" r="140" /><circle cx="210" cy="210" r="190" /></g>
      </svg>
      <div className="relative flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND A LOT MORE</span>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Plus a long list of small wins</h2>
      </div>
      <ul className="relative m-0 grid list-none grid-cols-2 gap-x-9 gap-y-3.5 p-0 max-sm:grid-cols-1">
        {more.map((line) => (
          <li key={line} className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--wn-accent)]" />
            <span className="text-[14.5px] font-semibold leading-[1.45]">{line}</span>
          </li>
        ))}
      </ul>
      <div className="relative flex items-center gap-2.5">
        <button type="button" className={ghostDark} onClick={onBack}>Back</button>
        <button type="button" className={cn(primaryDark, "px-[22px]")} onClick={onClose}>Let's go</button>
        <a href={releaseNotesUrl} target="_blank" rel="noopener noreferrer" className={cn("flex min-h-11 items-center rounded-xl px-3 text-[13.5px] font-medium text-[var(--wn-accent-ink)] hover:text-[var(--wn-accent-ink-hover)]", focusRing)}>Read the full release notes</a>
        <span className="grow" />
        <Pager index={2} onGo={onGo} />
      </div>
    </section>
  );
}

/** What an arrow key does on any card: -1 back, +1 forward, 0 nothing. The
 *  dialog clamps, so Right on the last card and Left on the first stay put. */
export function whatsNewArrowStep(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight") return 1;
  if (key === "ArrowLeft") return -1;
  return 0;
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function WhatsNewDialog({
  open,
  version,
  onClose,
  onAction,
  releaseNotesUrl,
}: {
  open: boolean;
  /** Every way out: X, Escape, Got it, Let's go. */
  onClose: () => void;
  /** A shortcut was chosen. The host closes the page and goes there. */
  onAction: (action: WhatsNewAction) => void;
  releaseNotesUrl: string;
  /** The version whose page this is. */
  version?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [index, setIndex] = useState(0);
  const moved = useRef(false);

  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current, previous = document.activeElement;
    setIndex(0);
    moved.current = false;
    if (!element.open) element.showModal();
    heading.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  // A new card: its title takes focus, so a screen reader reads where it is.
  useEffect(() => {
    if (!open || !moved.current) return;
    heading.current?.focus();
  }, [index, open]);

  if (!open) return null;
  const go = (target: number) => { moved.current = true; setIndex(Math.max(0, Math.min(target, WHATS_NEW_CARD_COUNT - 1))); };
  const next = () => go(index + 1);
  const back = () => go(index - 1);
  const trap = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    // The arrow keys page through the cards the same way on every card.
    const step = whatsNewArrowStep(event.key);
    if (step !== 0) { event.preventDefault(); go(index + step); return; }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active) || active === heading.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus();
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`whats-new-title-${index + 1}`}
      data-whats-new
      className="whats-new m-auto max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 font-sans backdrop:bg-black/[0.66]"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={trap}
    >
      <WhatsNewCard
        key={index}
        index={index}
        version={version}
        releaseNotesUrl={releaseNotesUrl}
        onNext={next}
        onBack={back}
        onGo={go}
        onClose={onClose}
        onAction={onAction}
        headingRef={(node) => { heading.current = node; }}
      />
    </dialog>
  );
}
