// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new in 0.1.60: three cards in the approved 0.1.59 design (the
// whats-new-art/mockup-boards WN1, WN3 and WN4 layouts), with new art from
// whats-new-art-0160/brief.md. Sizes and colours are the mockups'; the colours
// are the `--wn-*` art-panel tokens in styles.css, which do not follow the skin.
//
// The dialog only presents. Whoever mounts it (Sidebar.tsx) decides what each
// shortcut does and records the page as seen when it closes, however it
// closes: X (card 1, as in the mockups), Escape, Got it, Let's go, or any
// shortcut.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import backupsHero from "@/assets/whats-new/backups-hero.webp";
import tileBackups from "@/assets/whats-new/tile-backups.webp";
import tileOffsite from "@/assets/whats-new/tile-offsite.webp";
import tileRoutines from "@/assets/whats-new/tile-routines.webp";
import tileDelete from "@/assets/whats-new/tile-delete.webp";
import tilePhone from "@/assets/whats-new/tile-phone.webp";
import tileAboutMe from "@/assets/whats-new/tile-aboutme.webp";

export type WhatsNewAction = "backups" | "offsite" | "routines" | "delete" | "phone" | "aboutMe";

export const WHATS_NEW_CARD_COUNT = 3;

// `crop` keeps the picture's subject inside the tile's wide crop of a square image.
export const WHATS_NEW_TILES: Array<{ action: WhatsNewAction; img: string; alt: string; dot: string; title: string; body: string; crop?: string }> = [
  { action: "backups", img: tileBackups, alt: "A stack of glowing glass discs with a seam of light", dot: "bg-[var(--wn-dot-blue)]", title: "Backups, start to finish", body: "Turn backups on once. Murage makes your recovery key, backs up every day and checks every backup." },
  { action: "offsite", img: tileOffsite, alt: "Two glowing forms, near and far, joined by a thread of light", dot: "bg-[var(--wn-accent)]", title: "Off-site, your way", body: "A second encrypted copy on your own NAS or server over SFTP, or in S3-compatible storage. Murage sets it up for you.", crop: "object-[center_30%]" },
  { action: "routines", img: tileRoutines, alt: "A ribbon of light looping through a glowing ring", dot: "bg-[var(--wn-dot-gold)]", title: "Routines that keep going", body: "Each routine has its own approval level, so a routine on No limits gets on with it. If it needs you, it says so straight away." },
  { action: "delete", img: tileDelete, alt: "A glass shard dissolving into fine particles of light", dot: "bg-[var(--wn-dot-violet)]", title: "Delete means gone", body: "Deleting a conversation removes it everywhere, including the history your engines kept." },
  { action: "phone", img: tilePhone, alt: "A slim glowing slab with light rising from it", dot: "bg-[var(--wn-dot-mint)]", title: "Murage on your phone", body: "Photo uploads that work, a faster app, and Sign out this device." },
  { action: "aboutMe", img: tileAboutMe, alt: "A single soft, warm form of light", dot: "bg-[var(--wn-ink)]", title: "About me", body: "A short profile of you that your bots read on your own turns." },
];

export const WHATS_NEW_MORE: string[] = [
  "Snooze conversations",
  "Manage teams (rename, members, lead, delete)",
  "Always allow this exact command",
  "Every voice has a play button",
  "Plain names for connected-app tools",
  "Connected apps stay connected",
  "Ask any bot how Murage works",
];

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

/** One dot per card, the current one a long pill. */
function Pager({ index }: { index: number }) {
  return (
    <span role="img" aria-label={`Card ${index + 1} of ${WHATS_NEW_CARD_COUNT}`} className="flex gap-1.5">
      {Array.from({ length: WHATS_NEW_CARD_COUNT }, (_, dot) => (
        <span
          key={dot}
          className={cn("h-1.5 rounded-[3px]", dot === index ? "w-[18px] bg-[var(--wn-accent)]" : "w-1.5 bg-[var(--wn-ghost-edge)]")}
        />
      ))}
    </span>
  );
}

export interface WhatsNewCardProps {
  index: number;
  releaseNotesUrl: string;
  onNext: () => void;
  onClose: () => void;
  onAction: (action: WhatsNewAction) => void;
  headingRef?: (node: HTMLHeadingElement | null) => void;
}

/** One card, by index. Rendered alone by the tests; the dialog wraps it. */
export function WhatsNewCard({ index, releaseNotesUrl, onNext, onClose, onAction, headingRef }: WhatsNewCardProps): ReactNode {
  const titleId = `whats-new-title-${index + 1}`;
  if (index === 0) {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="backups" className="whats-new-card max-h-[calc(100dvh-32px)] w-[min(820px,calc(100vw-32px))] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
        <div className="relative h-[342px] bg-[var(--wn-ground)] max-md:h-[260px] [@media(max-height:720px)]:h-[250px]">
          <img src={backupsHero} alt="A sphere of orange light held in layered glass shells, with a fainter copy off to one side" width={820} height={342} className="block h-full w-full object-cover" />
          <div className="absolute left-[34px] top-[26px] flex gap-2">
            <span className="rounded-full border border-[var(--wn-chip-edge)] bg-[var(--wn-chip-ground)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-accent-ink)]">NEW IN MURAGE</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={cn("absolute right-3.5 top-3.5 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-[var(--wn-close-ground)] text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", focusRing)}><CloseIcon /></button>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display absolute bottom-[30px] left-[34px] right-[34px] m-0 text-[58px] leading-none tracking-[-0.01em] text-[var(--wn-ink-strong)] max-sm:text-[44px]", headingFocus)}>Your work, kept.</h2>
        </div>
        <div className="flex flex-col gap-3.5 px-[34px] pb-[26px] pt-6 max-sm:px-5">
          <p className="m-0 text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)]">Backups that run themselves, a copy somewhere else, and routines that don't stop to ask.</p>
          <div className="mt-1.5 flex items-center gap-2.5">
            <button type="button" className={primaryDark} onClick={() => onAction("backups")}>Open Backups</button>
            <button type="button" className={ghostDark} onClick={onNext}>Next</button>
            <span className="grow" />
            <Pager index={0} />
          </div>
        </div>
      </section>
    );
  }
  if (index === 1) {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="highlights" className="whats-new-card box-border flex max-h-[calc(100dvh-32px)] w-[min(1040px,calc(100vw-32px))] flex-col gap-5 overflow-y-auto rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel-deep)] px-8 pb-[26px] pt-[30px] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-sm:px-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND THERE'S MORE</span>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Built to be relied on</h2>
        </div>
        <ul className="m-0 grid list-none grid-cols-3 gap-3.5 p-0 max-[820px]:grid-cols-2 max-sm:grid-cols-1">
          {WHATS_NEW_TILES.map((tile) => (
            <li key={tile.action} className="flex">
              <button
                type="button"
                data-whats-new-tile={tile.action}
                onClick={() => onAction(tile.action)}
                className={cn("flex w-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-[var(--wn-tile-edge)] bg-[var(--wn-tile)] p-0 text-left text-[var(--wn-ink)] transition-colors hover:border-[var(--wn-ghost-edge)]", focusRing)}
              >
                <img src={tile.img} alt={tile.alt} width={316} height={150} className={cn("block h-[150px] w-full object-cover [@media(max-height:720px)]:h-[100px]", tile.crop)} />
                <span className="flex flex-col gap-1 px-3.5 pb-3.5 pt-3">
                  <span className="flex items-center gap-2"><span aria-hidden="true" className={cn("size-2 rounded-full", tile.dot)} /><span className="text-[14.5px] font-semibold">{tile.title}</span></span>
                  <span className="text-[13px] leading-normal text-[var(--wn-ink-muted)]">{tile.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2.5">
          <button type="button" className={primaryDark} onClick={onNext}>Next</button>
          <button type="button" className={ghostDark} onClick={onClose}>Got it</button>
          <span className="grow" />
          <span className="text-[12.5px] text-[var(--wn-ink-faint)] max-sm:hidden">Click any card to try it</span>
          <span className="ml-3.5"><Pager index={1} /></span>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby={titleId} data-whats-new-card="more" className="whats-new-card relative box-border flex max-h-[calc(100dvh-32px)] w-[min(900px,calc(100vw-32px))] flex-col gap-[22px] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel)] px-[38px] pb-7 pt-[34px] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-sm:px-5">
      <svg width="420" height="420" viewBox="0 0 420 420" aria-hidden="true" className="pointer-events-none absolute -right-[120px] -top-[150px]">
        <g fill="none" stroke="var(--wn-accent)" strokeOpacity="0.18"><circle cx="210" cy="210" r="90" /><circle cx="210" cy="210" r="140" /><circle cx="210" cy="210" r="190" /></g>
      </svg>
      <div className="relative flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND A LOT MORE</span>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Plus a long list of small wins</h2>
      </div>
      <ul className="relative m-0 grid list-none grid-cols-2 gap-x-9 gap-y-3.5 p-0 max-sm:grid-cols-1">
        {WHATS_NEW_MORE.map((line) => (
          <li key={line} className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--wn-accent)]" />
            <span className="text-[14.5px] font-semibold leading-[1.45]">{line}</span>
          </li>
        ))}
      </ul>
      <div className="relative flex items-center gap-2.5">
        <button type="button" className={cn(primaryDark, "px-[22px]")} onClick={onClose}>Let's go</button>
        <a href={releaseNotesUrl} target="_blank" rel="noopener noreferrer" className={cn("flex min-h-11 items-center rounded-xl px-3 text-[13.5px] font-medium text-[var(--wn-accent-ink)] hover:text-[var(--wn-accent-ink-hover)]", focusRing)}>Read the full release notes</a>
        <span className="grow" />
        <Pager index={2} />
      </div>
    </section>
  );
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function WhatsNewDialog({
  open,
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
  const next = () => { moved.current = true; setIndex((current) => Math.min(current + 1, WHATS_NEW_CARD_COUNT - 1)); };
  const trap = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
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
        releaseNotesUrl={releaseNotesUrl}
        onNext={next}
        onClose={onClose}
        onAction={onAction}
        headingRef={(node) => { heading.current = node; }}
      />
    </dialog>
  );
}
