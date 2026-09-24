// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new in 0.1.59: four cards, built from the owner-approved mockups
// (whats-new-art/mockup-boards WN1 to WN4). Sizes, copy and colours are the
// mockups'; the colours are the `--wn-*` art-panel tokens in styles.css,
// which do not follow the skin.
//
// The dialog only presents. Whoever mounts it (Sidebar.tsx) decides what each
// shortcut does and records the page as seen when it closes, however it
// closes: X (cards 1 and 2, as in the mockups), Escape, Got it, Let's go, or
// any shortcut.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import voiceHero from "@/assets/whats-new/voice-hero.webp";
import projectsSplit from "@/assets/whats-new/projects-split.webp";
import tileSearch from "@/assets/whats-new/tile-search.webp";
import tileSkills from "@/assets/whats-new/tile-skills.webp";
import tileHouseRules from "@/assets/whats-new/tile-houserules.webp";
import tileFullAccess from "@/assets/whats-new/tile-fullaccess.webp";
import tileCommands from "@/assets/whats-new/tile-commands.webp";
import tileShapes from "@/assets/whats-new/tile-shapes.webp";

export type WhatsNewAction = "call" | "project" | "search" | "skills" | "houseRules" | "fullAccess" | "commands" | "shapes";

export const WHATS_NEW_CARD_COUNT = 4;

const VOICE_POINTS: Array<[string, string]> = [
  ["Talk over it", `, or say "stop"`],
  ["Live answers", " from the web, mid-call"],
  ["Approve out loud", ", in plain words"],
  ["Voice notes", " in chat, Telegram, Slack, Discord"],
  ["41 voices", " through Flux, one per bot"],
  ["No extra keys", ", your Flux key covers it"],
];

export const WHATS_NEW_TILES: Array<{ action: WhatsNewAction; img: string; alt: string; dot: string; title: string; body: string }> = [
  { action: "search", img: tileSearch, alt: "A glass globe with a pulse of light", dot: "bg-[var(--wn-dot-search)]", title: "Real-time search", body: "Bots search the live web for current answers, in chat and while you talk on a call." },
  { action: "skills", img: tileSkills, alt: "Glass cards behind a glowing shield", dot: "bg-[var(--wn-accent)]", title: "Skills, checked first", body: "Every skill in one place. Skill Guard checks each one before a bot can use it." },
  { action: "houseRules", img: tileHouseRules, alt: "An open notebook with a fountain pen", dot: "bg-[var(--wn-dot-rules)]", title: "House Rules", body: "Write how your bots should work once. Every bot reads it first." },
  { action: "fullAccess", img: tileFullAccess, alt: "A trail of light passing through three arches", dot: "bg-[var(--wn-dot-access)]", title: "Full access, with brakes", body: "Fast on everything, but it stops before deleting, paying or messaging someone new." },
  { action: "commands", img: tileCommands, alt: "A glowing forward slash", dot: "bg-[var(--wn-dot-commands)]", title: "Engine commands", body: "Type / to use Claude Code, Codex, Fuigo, Grok Build and OpenCode commands." },
  { action: "shapes", img: tileShapes, alt: "Stacked glass layers with light passing through", dot: "bg-[var(--wn-ink)]", title: "See what shapes a bot", body: "Everything a bot reads, in order. Switch off what you chose." },
];

export const WHATS_NEW_MORE: Array<[string, string]> = [
  ["Approvals in the menu bar", "See what needs you, and allow ordinary requests, without opening Murage."],
  ["No limits", "A fourth level that just does it, and still asks before touching your keys."],
  ["Bots know the time", "Today’s date, the time and your time zone, in every reply."],
  ["New Bot and New Team", "Say what you want done and the right templates come up."],
  ["A proper editor", "Toolbar, / menu, tables and checklists for files, skills and rules."],
  ["A new welcome", "Your Chief of Staff walks you through setup."],
  ["Math and diagrams in chat", "Equations and Mermaid diagrams, drawn right in the conversation."],
  ["Faster long chats", "Big conversations open faster and load older messages as you scroll."],
  ["A calmer Inbox", "Clear what needs nothing from you, one at a time or all at once."],
  ["New models", "Claude Opus 5.5, GPT-6 Sol and Luna, and Grok 4.7."],
];

// Shared control styles. 44px targets everywhere; a visible focus ring that
// reads on both the dark panels and the Paper card.
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

/** Four dots, the current one a long pill. Paper uses its own two tones. */
function Pager({ index, paper = false }: { index: number; paper?: boolean }) {
  return (
    <span role="img" aria-label={`Card ${index + 1} of ${WHATS_NEW_CARD_COUNT}`} className="flex gap-1.5">
      {Array.from({ length: WHATS_NEW_CARD_COUNT }, (_, dot) => (
        <span
          key={dot}
          className={cn(
            "h-1.5 rounded-[3px]",
            dot === index ? "w-[18px]" : "w-1.5",
            dot === index
              ? paper ? "bg-[var(--wn-paper-accent)]" : "bg-[var(--wn-accent)]"
              : paper ? "bg-[var(--wn-paper-edge)]" : "bg-[var(--wn-ghost-edge)]",
          )}
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
      <section aria-labelledby={titleId} data-whats-new-card="voice" className="whats-new-card max-h-[calc(100dvh-32px)] w-[min(820px,calc(100vw-32px))] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
        <div className="relative h-[342px] bg-[var(--wn-ground)] max-md:h-[260px] [@media(max-height:720px)]:h-[250px]">
          <img src={voiceHero} alt="An orange voice waveform flowing into a glowing orb" width={820} height={342} className="block h-full w-full object-cover" />
          <div className="absolute left-[34px] top-[26px] flex gap-2">
            <span className="rounded-full border border-[var(--wn-chip-edge)] bg-[var(--wn-chip-ground)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-accent-ink)]">NEW IN MURAGE</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className={cn("absolute right-3.5 top-3.5 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-[var(--wn-close-ground)] text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", focusRing)}><CloseIcon /></button>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display absolute bottom-[30px] left-[34px] right-[34px] m-0 text-[58px] leading-none tracking-[-0.01em] text-[var(--wn-ink-strong)] max-sm:text-[44px]", headingFocus)}>Just talk to your bots</h2>
        </div>
        <div className="flex flex-col gap-3.5 px-[34px] pb-[26px] pt-6 max-sm:px-5">
          <p className="m-0 text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)]">Call any bot and have a real conversation. It answers from its first sentence, looks things up while you talk, and hands real work to its own engine while it keeps talking to you.</p>
          <ul className="m-0 grid list-none grid-cols-2 gap-x-7 gap-y-2 p-0 text-[14px] leading-normal text-[var(--wn-ink-list)] max-sm:grid-cols-1">
            {VOICE_POINTS.map(([lead, rest]) => (
              <li key={lead} className="flex gap-2.5"><span aria-hidden="true" className="font-bold text-[var(--wn-accent)]">·</span><span><strong className="font-semibold text-[var(--wn-ink-strong)]">{lead}</strong>{rest}</span></li>
            ))}
          </ul>
          <div className="mt-1.5 flex items-center gap-2.5">
            <button type="button" className={primaryDark} onClick={() => onAction("call")}>Call a bot</button>
            <button type="button" className={ghostDark} onClick={onNext}>Next</button>
            <span className="grow" />
            <Pager index={0} />
          </div>
        </div>
      </section>
    );
  }
  if (index === 1) {
    const paperFocus = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wn-paper-accent)]";
    return (
      <section aria-labelledby={titleId} data-whats-new-card="projects" className="whats-new-card grid h-[580px] max-h-[calc(100dvh-32px)] w-[min(940px,calc(100vw-32px))] grid-cols-[380px_minmax(0,1fr)] overflow-hidden rounded-[22px] bg-[var(--wn-paper)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-md:h-auto max-md:grid-cols-1">
        <div className="relative bg-[var(--wn-paper-art)] max-md:h-[220px]">
          <img src={projectsSplit} alt="Small sculpted tokens around a glowing central goal, joined by threads of light" width={380} height={580} className="block h-full w-full object-cover" />
        </div>
        <div className="relative flex min-h-0 flex-col gap-3.5 overflow-y-auto px-10 pb-[30px] pt-[38px] text-[var(--wn-paper-ink)] max-sm:px-6">
          <button type="button" aria-label="Close" onClick={onClose} className={cn("absolute right-3.5 top-3.5 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 bg-transparent text-[var(--wn-paper-close)] hover:text-[var(--wn-paper-ink)]", paperFocus)}><CloseIcon /></button>
          <span className="self-start rounded-full bg-[var(--wn-paper-chip)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-paper-accent)]">PROJECTS</span>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 pr-10 text-[46px] leading-[1.02]", headingFocus)}>One goal. The right bots. Their own space.</h2>
          <p className="m-0 text-[15px] leading-[1.55] text-[var(--wn-paper-ink-body)]">A project is a piece of work with its own goal, files and chat. Every bot you add to it follows the goal, so you stop repeating yourself.</p>
          <ol className="m-0 mt-0.5 list-decimal pl-[22px] text-[14.5px] leading-[1.8] text-[var(--wn-paper-ink-list)]">
            <li>Click <strong>+</strong> and choose <strong>New Project</strong></li>
            <li>Say what it's about. That becomes the brief every bot in it follows</li>
            <li>Add the bots that should work on it, and get going</li>
          </ol>
          <p className="m-0 text-[13px] leading-normal text-[var(--wn-paper-ink-muted)]">Its home keeps the goal and progress, with its chat, members, files and memory close by.</p>
          <span className="grow" />
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => onAction("project")} className={cn("min-h-11 cursor-pointer rounded-xl border-0 bg-[var(--wn-paper-ink)] px-5 text-[14px] font-semibold text-[var(--wn-paper-on-ink)] hover:opacity-90", paperFocus)}>Start a project</button>
            <button type="button" onClick={onNext} className={cn("min-h-11 cursor-pointer rounded-xl border border-[var(--wn-paper-edge)] bg-transparent px-[18px] text-[14px] font-medium text-[var(--wn-paper-ink)] hover:bg-black/5", paperFocus)}>Next</button>
            <span className="grow" />
            <Pager index={1} paper />
          </div>
        </div>
      </section>
    );
  }
  if (index === 2) {
    return (
      <section aria-labelledby={titleId} data-whats-new-card="highlights" className="whats-new-card box-border flex max-h-[calc(100dvh-32px)] w-[min(1040px,calc(100vw-32px))] flex-col gap-5 overflow-y-auto rounded-[22px] border border-[var(--wn-edge-soft)] bg-[var(--wn-panel-deep)] px-8 pb-[26px] pt-[30px] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)] max-sm:px-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">AND THERE'S MORE</span>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 text-[42px] leading-[1.05]", headingFocus)}>Smarter, sharper, more yours</h2>
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
          <button type="button" className={primaryDark} onClick={onNext}>Next</button>
          <button type="button" className={ghostDark} onClick={onClose}>Got it</button>
          <span className="grow" />
          <span className="text-[12.5px] text-[var(--wn-ink-faint)] max-sm:hidden">Click any card to try it</span>
          <span className="ml-3.5"><Pager index={2} /></span>
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
        {WHATS_NEW_MORE.map(([title, body]) => (
          <li key={title} className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-[var(--wn-accent)]" />
            <span className="flex flex-col gap-0.5"><span className="text-[14.5px] font-semibold">{title}</span><span className="text-[13px] leading-[1.45] text-[var(--wn-ink-muted)]">{body}</span></span>
          </li>
        ))}
      </ul>
      <div className="relative flex items-center gap-2.5">
        <button type="button" className={cn(primaryDark, "px-[22px]")} onClick={onClose}>Let's go</button>
        <a href={releaseNotesUrl} target="_blank" rel="noopener noreferrer" className={cn("flex min-h-11 items-center rounded-xl px-3 text-[13.5px] font-medium text-[var(--wn-accent-ink)] hover:text-[var(--wn-accent-ink-hover)]", focusRing)}>Read the full release notes</a>
        <span className="grow" />
        <Pager index={3} />
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
