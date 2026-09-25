// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Announcements: one notice at a time, drawn from plain fields by our own
// components. An `info` notice is a banner at the foot of the sidebar; an
// `important` or `security` one is a full card, like What's new.
//
// The look is What's new's (WhatsNewDialog.tsx): the dark art panel, the
// Instrument Serif headline, the chip, the orange accent, the picture on top
// or at the side. Three layouts ("style packs") and five accents vary it
// from one notice to the next so the sidebar never grows a banner people
// learn to skip:
//
//   hero       picture across the top, headline over it (What's new card 1)
//   split      picture at the side, words beside it (What's new card 2)
//   spotlight  no picture, the accent rings (What's new card 4)
//
// A notice whose picture is missing or does not load is drawn as spotlight:
// the picture goes, never the notice.
import { Fragment, useCallback, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUpRight, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import {
  ANNOUNCEMENT_ACTION_SECTIONS,
  announcementSurface,
  openAnnouncementLink,
  parseAnnouncementBody,
  useAnnouncementImage,
  useAnnouncements,
  type AnnouncementActionTarget,
  type AnnouncementKind,
  type AnnouncementLayout,
  type AnnouncementView,
} from "@/lib/announcements";

const KIND_LABEL: Record<AnnouncementKind, string> = { info: "NEWS", important: "IMPORTANT", security: "SECURITY" };

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wn-accent)]";
const primary = cn("inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl border-0 bg-[var(--wn-accent)] px-5 text-[14px] font-semibold text-[var(--wn-on-accent)] hover:brightness-110", focusRing);
const ghost = cn("min-h-11 cursor-pointer rounded-xl border border-[var(--wn-ghost-edge)] bg-transparent px-[18px] text-[14px] font-medium text-[var(--wn-ink)] hover:bg-white/5", focusRing);

/** The layout actually drawn: the chosen one when there is a picture. */
export function drawnLayout(item: Pick<AnnouncementView, "layout">, imageUrl: string | null | undefined): AnnouncementLayout {
  return imageUrl ? item.layout : "spotlight";
}

/** The body's Markdown subset as elements. Nothing is parsed as HTML. */
export function AnnouncementBody({ body, className }: { body: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {parseAnnouncementBody(body).map((pieces, index) => (
        <p key={index} className="m-0">
          {pieces.map((piece, at) =>
            piece.type === "bold" ? (
              <strong key={at} className="font-semibold text-[var(--wn-ink-strong)]">{piece.text}</strong>
            ) : piece.type === "link" ? (
              <a
                key={at}
                href={piece.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => { event.preventDefault(); void openAnnouncementLink(piece.href); }}
                className={cn("rounded-sm font-medium text-[var(--wn-accent-ink)] underline decoration-1 underline-offset-2 hover:text-[var(--wn-accent-ink-hover)]", focusRing)}
              >
                {piece.text}
              </a>
            ) : (
              <Fragment key={at}>{piece.text}</Fragment>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Chip({ kind, onImage = false }: { kind: AnnouncementKind; onImage?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 self-start rounded-full border border-[var(--wn-chip-edge)] px-[11px] py-1.5 text-[12px] font-semibold tracking-[0.06em] text-[var(--wn-accent-ink)]",
      onImage ? "bg-[rgba(10,10,10,0.72)]" : "bg-[var(--wn-chip-ground)]",
    )}>
      {kind === "security" && <ShieldAlert size={13} aria-hidden="true" />}
      {KIND_LABEL[kind]}
    </span>
  );
}

function Rings({ className }: { className: string }) {
  return (
    <svg width="420" height="420" viewBox="0 0 420 420" aria-hidden="true" className={cn("pointer-events-none absolute", className)}>
      <g fill="none" stroke="var(--wn-accent)" strokeOpacity="0.2"><circle cx="210" cy="210" r="90" /><circle cx="210" cy="210" r="140" /><circle cx="210" cy="210" r="190" /></g>
    </svg>
  );
}

/** What the primary button says, when the notice has somewhere to go. */
function actLabel(item: AnnouncementView): string | null {
  return item.action?.label ?? item.link?.label ?? null;
}

export interface AnnouncementCardProps {
  item: AnnouncementView;
  imageUrl?: string | null;
  onAct: () => void;
  onDismiss: () => void;
  headingRef?: (node: HTMLHeadingElement | null) => void;
}

/** The full card for an important or security notice. */
export function AnnouncementCard({ item, imageUrl, onAct, onDismiss, headingRef }: AnnouncementCardProps): ReactNode {
  const layout = drawnLayout(item, imageUrl);
  const titleId = `announcement-title-${item.id}`;
  const label = actLabel(item);
  const buttons = (
    <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
      {label && (
        <button type="button" className={primary} onClick={onAct}>
          {label}
          {item.link && <ArrowUpRight size={16} aria-hidden="true" />}
        </button>
      )}
      <button type="button" className={label ? ghost : primary} onClick={onDismiss}>Got it</button>
    </div>
  );
  const close = (onImage: boolean) => (
    <button
      type="button"
      aria-label="Close"
      onClick={onDismiss}
      className={cn("absolute right-3.5 top-3.5 z-10 flex size-11 cursor-pointer items-center justify-center rounded-xl border-0 text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", onImage ? "bg-[var(--wn-close-ground)]" : "bg-transparent", focusRing)}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
  const title = (className: string) => (
    <h2 id={titleId} ref={headingRef} tabIndex={-1} className={cn("whats-new-display m-0 outline-none", className)}>{item.title}</h2>
  );
  const shell = "announce-in relative max-h-[calc(100dvh-32px)] overflow-y-auto overflow-x-hidden rounded-[22px] border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]";

  if (layout === "hero") {
    return (
      <section aria-labelledby={titleId} data-announcement-card={item.id} data-layout="hero" className={cn(shell, "w-[min(760px,calc(100vw-32px))]")}>
        <div className="relative h-[300px] bg-[var(--wn-ground)] max-md:h-[220px] [@media(max-height:640px)]:h-[190px]">
          <img src={imageUrl!} alt={item.imageAlt ?? ""} className="block h-full w-full object-cover" />
          <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_top,rgba(10,10,10,0.82),rgba(10,10,10,0.1)_55%,transparent)]" />
          <div className="absolute left-[34px] top-[26px] max-sm:left-5"><Chip kind={item.kind} onImage /></div>
          {close(true)}
          {title("absolute bottom-[26px] left-[34px] right-[34px] text-[50px] leading-[1.02] tracking-[-0.01em] text-white max-sm:left-5 max-sm:text-[38px]")}
        </div>
        <div className="flex flex-col gap-3.5 px-[34px] pb-[26px] pt-6 max-sm:px-5">
          <AnnouncementBody body={item.body} className="text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)]" />
          {buttons}
        </div>
      </section>
    );
  }
  if (layout === "split") {
    return (
      <section aria-labelledby={titleId} data-announcement-card={item.id} data-layout="split" className={cn(shell, "grid min-h-[400px] w-[min(880px,calc(100vw-32px))] grid-cols-[340px_minmax(0,1fr)] max-md:grid-cols-1")}>
        <div className="relative min-h-full bg-[var(--wn-ground)] max-md:h-[200px]">
          <img src={imageUrl!} alt={item.imageAlt ?? ""} className="absolute inset-0 block h-full w-full object-cover" />
        </div>
        <div className="relative flex min-h-0 flex-col gap-3.5 px-10 pb-[30px] pt-[38px] max-sm:px-6">
          {close(false)}
          <Chip kind={item.kind} />
          {title("pr-10 text-[42px] leading-[1.04]")}
          <AnnouncementBody body={item.body} className="text-[15px] leading-[1.55] text-[var(--wn-ink-body)]" />
          <span className="grow" />
          {buttons}
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby={titleId} data-announcement-card={item.id} data-layout="spotlight" className={cn(shell, "flex w-[min(700px,calc(100vw-32px))] flex-col gap-4 px-[38px] pb-7 pt-[34px] max-sm:px-5")}>
      <Rings className="-right-[140px] -top-[170px]" />
      {close(false)}
      <div className="relative flex flex-col gap-3">
        <Chip kind={item.kind} />
        {title("pr-10 text-[44px] leading-[1.04]")}
      </div>
      <AnnouncementBody body={item.body} className="relative text-[15.5px] leading-[1.55] text-[var(--wn-ink-body)]" />
      <div className="relative">{buttons}</div>
    </section>
  );
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The card as a modal. Escape, X and Got it all dismiss. */
export function AnnouncementDialog({ item, imageUrl, onAct, onDismiss }: Omit<AnnouncementCardProps, "headingRef">) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    if (!element.open) element.showModal();
    heading.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [item.id]);
  const trap = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current || !event.currentTarget.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`announcement-title-${item.id}`}
      data-announcement
      data-accent={item.accent}
      className="announce m-auto max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 font-sans backdrop:bg-black/[0.66]"
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}
      onKeyDown={trap}
    >
      <AnnouncementCard item={item} imageUrl={imageUrl} onAct={onAct} onDismiss={onDismiss} headingRef={(node) => { heading.current = node; }} />
    </dialog>
  );
}

/** The sidebar banner for an info notice. */
export function AnnouncementBanner({ item, imageUrl, onAct, onDismiss }: Omit<AnnouncementCardProps, "headingRef">) {
  const layout = drawnLayout(item, imageUrl);
  const titleId = `announcement-banner-title-${item.id}`;
  const label = actLabel(item);
  const close = (onImage: boolean) => (
    <button
      type="button"
      aria-label={`Dismiss: ${item.title}`}
      onClick={onDismiss}
      className={cn("absolute right-2 top-2 z-10 flex size-8 cursor-pointer items-center justify-center rounded-lg border-0 text-[var(--wn-close-ink)] hover:text-[var(--wn-ink-strong)]", onImage ? "bg-[var(--wn-close-ground)]" : "bg-transparent", focusRing)}
    >
      <X size={14} aria-hidden="true" />
    </button>
  );
  const kicker = (
    <span className="flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-[var(--wn-accent-ink)]">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--wn-accent)]" />
      {KIND_LABEL[item.kind]}
    </span>
  );
  const heading = (className: string) => <h2 id={titleId} className={cn("whats-new-display m-0 text-[var(--wn-ink-strong)]", className)}>{item.title}</h2>;
  const body = <AnnouncementBody body={item.body} className="text-[12.5px] leading-[1.5] text-[var(--wn-ink-body)]" />;
  const act = label ? (
    <button type="button" onClick={onAct} className={cn("inline-flex min-h-8 cursor-pointer items-center gap-1 self-start rounded-lg border-0 bg-transparent p-0 text-[12.5px] font-semibold text-[var(--wn-accent-ink)] hover:text-[var(--wn-accent-ink-hover)]", focusRing)}>
      {label}
      <ArrowUpRight size={14} aria-hidden="true" className={item.link ? undefined : "rotate-45"} />
    </button>
  ) : null;

  return (
    <section
      aria-labelledby={titleId}
      data-announcement-banner={item.id}
      data-layout={layout}
      data-accent={item.accent}
      className="announce announce-in relative overflow-hidden rounded-2xl border border-[var(--wn-edge)] bg-[var(--wn-panel)] text-[var(--wn-ink)] shadow-[0_10px_30px_rgba(0,0,0,0.28)]"
    >
      {layout === "hero" && (
        <>
          <img src={imageUrl!} alt={item.imageAlt ?? ""} className="block h-[92px] w-full object-cover" />
          {close(true)}
          <div className="flex flex-col gap-1.5 px-3.5 pb-3 pt-3">
            {kicker}
            {heading("text-[21px] leading-[1.08]")}
            {body}
            {act}
          </div>
        </>
      )}
      {layout === "split" && (
        <>
          {close(false)}
          <div className="flex gap-3 p-3 pr-9">
            <img src={imageUrl!} alt={item.imageAlt ?? ""} className="size-[60px] shrink-0 rounded-xl object-cover" />
            <div className="flex min-w-0 flex-col gap-1">
              {kicker}
              {heading("text-[19px] leading-[1.1]")}
            </div>
          </div>
          <div className="flex flex-col gap-1.5 px-3.5 pb-3">
            {body}
            {act}
          </div>
        </>
      )}
      {layout === "spotlight" && (
        <>
          <Rings className="-right-[150px] -top-[170px] scale-[0.6]" />
          {close(false)}
          <div className="relative flex flex-col gap-1.5 px-3.5 pb-3 pt-3.5 pr-9">
            {kicker}
            {heading("text-[21px] leading-[1.08]")}
            {body}
            {act}
          </div>
        </>
      )}
    </section>
  );
}

type Dispatch = ReturnType<typeof useStore>["dispatch"];

/** Where an in-app action goes. Apart from React so it can be tested. */
export function runAnnouncementAction(target: AnnouncementActionTarget, dispatch: Dispatch): void {
  if (target === "check-for-updates") {
    void window.muragebox?.updater?.check();
    dispatch({ type: "toggleAppSettings", open: true, section: "general" });
    return;
  }
  dispatch({ type: "toggleAppSettings", open: true, section: ANNOUNCEMENT_ACTION_SECTIONS[target] });
}

async function loadWithRequest(path: string): Promise<Blob> {
  const { ensureDesktopSurfaceSecret, desktopSurfaceHeaders } = await import("@/lib/live-events");
  await ensureDesktopSurfaceSecret();
  const response = await fetch(path, { headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() } });
  if (!response.ok) throw new Error(String(response.status));
  return response.blob();
}

/**
 * Shows the first notice: a card for important and security, a banner for
 * info. Mounted at the foot of the sidebar, where the banner sits; the card
 * is a modal, so where it is mounted does not matter.
 */
export function AnnouncementsHost({
  desktop,
  request,
  loadImage = loadWithRequest,
  showBanner = true,
  suspended = false,
  onNavigate,
}: {
  desktop: boolean | undefined;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  loadImage?: (path: string) => Promise<Blob>;
  /** False in the icon-only sidebar, where a banner does not fit. */
  showBanner?: boolean;
  /** True while another full-screen page (What's new) is open. */
  suspended?: boolean;
  onNavigate?: () => void;
}) {
  const { dispatch } = useStore();
  const { current, dismiss } = useAnnouncements(desktop, request);
  const image = useAnnouncementImage(current?.image, loadImage);
  const act = useCallback(() => {
    if (!current) return;
    if (current.link) void openAnnouncementLink(current.link.url);
    else if (current.action) { onNavigate?.(); runAnnouncementAction(current.action.target, dispatch); }
    dismiss(current.id);
  }, [current, dismiss, dispatch, onNavigate]);
  // A card waits for its picture (or for the picture to fail) so it does not
  // jump from one layout to another in front of someone.
  const pictureSettled = !current?.image || image.url !== null || image.failed;
  const surface = current ? announcementSurface(current) : null;
  const dismissCurrent = useCallback(() => { if (current) dismiss(current.id); }, [current, dismiss]);
  if (!current || !pictureSettled) return null;
  if (surface === "card") return suspended ? null : <AnnouncementDialog item={current} imageUrl={image.url} onAct={act} onDismiss={dismissCurrent} />;
  if (!showBanner) return null;
  return (
    <div className="mb-2">
      <AnnouncementBanner item={current} imageUrl={image.url} onAct={act} onDismiss={dismissCurrent} />
    </div>
  );
}
