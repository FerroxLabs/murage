// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: one page per release, in the approved 0.1.59 design (the
// whats-new-art/mockup-boards WN1, WN3 and WN4 layouts). The words and the
// picture names for every version are data in whats-new-pages.ts; this file
// draws them. Sizes and colours are the mockups'; the colours are the `--wn-*`
// art-panel tokens in styles.css, which do not follow the skin.
//
// A page is a hero, then a tiles card and a list card when the page has tiles
// or lines, so a release with one or two pictures still gets its own page.
// The hero names the version. A version with no page here shows nothing: no
// other version's words stand in for it.
//
// The dialog only presents, and loads on first open (WhatsNewHost.tsx), so
// none of it, pictures included, rides the first paint. Whoever mounts it
// decides what each shortcut does and records the page as seen when it
// closes, however it closes: X, Escape, Got it, Let's go, or any shortcut.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";
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
import tileFuigoStart from "@/assets/whats-new/tile-fuigo-start.webp";
import tileOnePlace from "@/assets/whats-new/tile-one-place.webp";
import { whatsNewCards, whatsNewContent, type WhatsNewAction, type WhatsNewArt, type WhatsNewCardKind } from "./whats-new-pages";

export type { WhatsNewAction } from "./whats-new-pages";
export {
  WHATS_NEW_PAGES, WHATS_NEW_TILES, WHATS_NEW_MORE, WHATS_NEW_TILES_102, WHATS_NEW_MORE_102, WHATS_NEW_TILES_106, WHATS_NEW_MORE_106,
  WHATS_NEW_MORE_1014, WHATS_NEW_TILES_1015, WHATS_NEW_MORE_1015, WHATS_NEW_MORE_1016, WHATS_NEW_MORE_1017, whatsNewCards, whatsNewContent,
} from "./whats-new-pages";

/** Each picture name to its file. */
export const WHATS_NEW_ART: Readonly<Record<WhatsNewArt, string>> = {
  "team-hero": teamHero, "memory-hero": memoryHero,
  "tile-blocks": tileBlocks, "tile-chrome": tileChrome, "tile-desktops": tileDesktops, "tile-engines": tileEngines, "tile-gemini": tileGemini,
  "tile-labs": tileLabs, "tile-longwork": tileLongwork, "tile-packs": tilePacks, "tile-rooms": tileRooms, "tile-routing": tileRouting,
  "tile-shapes": tileShapes, "tile-speed": tileSpeed, "tile-fuigo-start": tileFuigoStart, "tile-one-place": tileOnePlace,
};

/** How many cards `version`'s page has: 0 when it has no page. */
export function whatsNewCardCount(version: string | undefined): number {
  const page = whatsNewContent(version);
  return page ? whatsNewCards(page).length : 0;
}

/** The tiles card's grid: as many columns as tiles, up to three. */
const TILE_GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2 max-sm:grid-cols-1",
  3: "grid-cols-3 max-[820px]:grid-cols-2 max-sm:grid-cols-1",
};

// Shared control styles. 44px targets everywhere; a visible focus ring that
// reads on the dark panels.
const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wn-accent)]";
const primaryDark = cn("min-h-11 cursor-pointer rounded-xl border-0 bg-[var(--wn-accent)] px-5 text-[14px] font-semibold text-[var(--wn-on-accent)] hover:brightness-110", focusRing);
const ghostDark = cn("min-h-11 cursor-pointer rounded-xl border border-[var(--wn-ghost-edge)] bg-transparent px-[18px] text-[14px] font-medium text-[var(--wn-ink)] hover:bg-white/5", focusRing);
const headingFocus = "outline-none";
// What scrolls on a card takes focus, so a keyboard alone can scroll it on a short or narrow window.
const bodyFocus = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--wn-accent)]";

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

/** One dot per card, the current one a long pill. Each dot is a button that
 *  goes to its card, on every card. A one-card page has no pager. */
function Pager({ index, count, onGo }: { index: number; count: number; onGo?: (index: number) => void }) {
  if (count < 2) return null;
  return (
    <span role="group" aria-label={`Card ${index + 1} of ${count}`} className="flex">
      {Array.from({ length: count }, (_, dot) => (
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

function ReleaseNotesLink({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className={cn("flex min-h-11 items-center rounded-xl px-3 text-[13.5px] font-medium text-[var(--wn-accent-ink)] hover:text-[var(--wn-accent-ink-hover)]", focusRing)}>Read the full release notes</a>;
}

export interface WhatsNewCardProps {
  index: number;
  /** Which version's page this is. A version with no page draws nothing. */
  version: string;
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
  const page = whatsNewContent(version);
  if (!page) return null;
  const cards = whatsNewCards(page);
  const kind: WhatsNewCardKind | undefined = cards[index];
  if (!kind) return null;
  const count = cards.length, last = index === count - 1;
  const titleId = `whats-new-title-${index + 1}`;
  const { hero, tiles, more } = page;
  if (kind === "hero") {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="hero" data-whats-new-version={version} className={cn(BOX_FRAME, "whats-new-card relative max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(820px,calc(100vw-32px))] rounded-[22px] border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]")}>
        {/* On the card, not in what scrolls: a short window cannot take Close away. */}
        <button type="button" aria-label="Close" onClick={onClose} className={cn("absolute right-3.5 top-3.5 z-10 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-[var(--wn-close-ground)] text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", focusRing)}><CloseIcon /></button>
        <BoxBody tabIndex={0} role="region" aria-labelledby={titleId} className={bodyFocus}>
        <div className="relative h-[342px] bg-[var(--wn-ground)] max-md:h-[260px] [@media(max-height:720px)]:h-[250px]">
          <img src={WHATS_NEW_ART[hero.art]} alt={hero.alt} width={820} height={342} decoding="async" className={cn("block h-full w-full", hero.fit)} />
          <div className="absolute left-[34px] top-[26px] flex gap-2">
            <span className="rounded-full border border-[var(--wn-chip-edge)] bg-[var(--wn-chip-ground)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-accent-ink)]">NEW IN MURAGE {version}</span>
          </div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display absolute bottom-[30px] left-[34px] right-[34px] m-0 text-[58px] leading-none tracking-[-0.01em] text-[var(--wn-ink-strong)] max-sm:text-[44px]", headingFocus)}>{hero.title}</h2>
        </div>
        <p className="m-0 px-[34px] pb-2 pt-6 text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)] max-sm:px-5">{hero.body}</p>
        </BoxBody>
        <BoxFoot className="flex-wrap justify-start gap-2.5 px-[34px] pb-[26px] pt-3 max-sm:px-5">
            <button type="button" className={primaryDark} onClick={() => onAction(hero.action)}>{hero.button}</button>
            {last
              ? <><button type="button" className={ghostDark} onClick={onClose}>Got it</button><ReleaseNotesLink url={releaseNotesUrl} /></>
              : <button type="button" className={ghostDark} onClick={onNext}>Next</button>}
            <span className="grow" />
            <Pager index={index} count={count} onGo={onGo} />
        </BoxFoot>
      </section>
    );
  }
  if (kind === "highlights") {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="highlights" className={cn(BOX_FRAME, "whats-new-card box-border max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(1040px,calc(100vw-32px))] gap-4 rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel-deep)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]")}>
        <BoxHead className="flex-col items-stretch gap-1.5 px-8 pt-[30px] max-sm:px-5">
          <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND THERE'S MORE</span>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>{page.tilesTitle ?? "Made for bigger work"}</h2>
        </BoxHead>
        <BoxBody tabIndex={0} role="region" aria-labelledby={titleId} className={cn("px-8 py-1 max-sm:px-5", bodyFocus)}>
        <ul className={cn("m-0 grid list-none gap-3.5 p-0", TILE_GRID[Math.min(tiles.length, 3)])}>
          {tiles.map((tile) => (
            <li key={tile.action} className="flex">
              <button
                type="button"
                data-whats-new-tile={tile.action}
                onClick={() => onAction(tile.action)}
                className={cn("flex w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-[var(--wn-tile-edge)] bg-[var(--wn-tile)] p-0 text-left text-[var(--wn-ink)] transition-colors hover:border-[var(--wn-ghost-edge)]", focusRing)}
              >
                <img src={WHATS_NEW_ART[tile.art]} alt={tile.alt} width={316} height={150} decoding="async" className="block h-[150px] w-full object-cover [@media(max-height:720px)]:h-[100px]" />
                <span className="flex flex-col gap-1 px-3.5 pb-3.5 pt-3">
                  <span className="flex items-center gap-2"><span aria-hidden="true" className={cn("size-2 rounded-full", tile.dot)} /><span className="text-[14.5px] font-semibold">{tile.title}</span></span>
                  <span className="text-[13px] leading-normal text-[var(--wn-ink-muted)]">{tile.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        </BoxBody>
        <BoxFoot className="flex-wrap justify-start gap-2.5 px-8 pb-[26px] max-sm:px-5">
          <button type="button" className={ghostDark} onClick={onBack}>Back</button>
          {last
            ? <><button type="button" className={cn(primaryDark, "px-[22px]")} onClick={onClose}>Let's go</button><ReleaseNotesLink url={releaseNotesUrl} /></>
            : <><button type="button" className={primaryDark} onClick={onNext}>Next</button><button type="button" className={ghostDark} onClick={onClose}>Got it</button></>}
          <span className="grow" />
          <span className="text-[12.5px] text-[var(--wn-ink-faint)] max-sm:hidden">Click any card to try it</span>
          <span className="ml-3.5"><Pager index={index} count={count} onGo={onGo} /></span>
        </BoxFoot>
      </section>
    );
  }
  return (
    <section aria-labelledby={titleId} data-whats-new-card="more" className={cn(BOX_FRAME, "whats-new-card relative box-border max-h-[calc(100dvh-32px-2*max(var(--inset-top),var(--inset-bottom)))] w-[min(900px,calc(100vw-32px))] gap-[22px] rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]")}>
      <svg width="420" height="420" viewBox="0 0 420 420" aria-hidden="true" className="pointer-events-none absolute -right-[120px] -top-[150px]">
        <g fill="none" stroke="var(--wn-accent)" strokeOpacity="0.18"><circle cx="210" cy="210" r="90" /><circle cx="210" cy="210" r="140" /><circle cx="210" cy="210" r="190" /></g>
      </svg>
      <BoxHead className="relative flex-col items-stretch gap-1.5 px-[38px] pt-[34px] max-sm:px-5">
        <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND A LOT MORE</span>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Plus a long list of small wins</h2>
      </BoxHead>
      <BoxBody tabIndex={0} role="region" aria-labelledby={titleId} className={cn("relative px-[38px] max-sm:px-5", bodyFocus)}>
      <ul className="relative m-0 grid list-none grid-cols-2 gap-x-9 gap-y-3.5 p-0 max-sm:grid-cols-1">
        {more.map((line) => (
          <li key={line} className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--wn-accent)]" />
            <span className="text-[14.5px] font-semibold leading-[1.45]">{line}</span>
          </li>
        ))}
      </ul>
      </BoxBody>
      <BoxFoot className="relative flex-wrap justify-start gap-2.5 px-[38px] pb-7 max-sm:px-5">
        {index > 0 && <button type="button" className={ghostDark} onClick={onBack}>Back</button>}
        <button type="button" className={cn(primaryDark, "px-[22px]")} onClick={onClose}>Let's go</button>
        <ReleaseNotesLink url={releaseNotesUrl} />
        <span className="grow" />
        <Pager index={index} count={count} onGo={onGo} />
      </BoxFoot>
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

  const count = whatsNewCardCount(version);
  if (!open || !version || count === 0) return null;
  const go = (target: number) => { moved.current = true; setIndex(Math.max(0, Math.min(target, count - 1))); };
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
      data-box-exempt="a clear carrier, the card inside it is the box"
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
