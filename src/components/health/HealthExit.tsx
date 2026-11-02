// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The way out of Health (Sean 11-02, 1.0.14): Back on the left, a close button on the right, and Esc, all three
// going to the view the person came from (App.tsx picks it, shell-nav.ts healthReturn). The rail's doors leave
// Health too. Phones get the same two buttons beside the bot-list button.
//
// The header is one piece, HealthHeadTop, drawn the same while the page loads, after it failed to load, and once it
// is up. Loading and failure sit in the body under it (HealthFrame), never over it, so a phone always has a way out.
import { useEffect, type ReactNode } from "react";
import { ArrowLeft, Loader2, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { BOX_FRAME, BoxBody, BoxHead } from "@/components/ui/BoxShell";
import { OpenBotListButton } from "@/components/OpenBotListButton";

export const HEALTH_FRAME = `${BOX_FRAME} h-full min-w-0 flex-1 bg-app text-ink`;
export const HEALTH_HEAD = "flex-col items-start gap-0 px-4 pt-6 sm:px-6";
export const HEALTH_BODY = "flex flex-col px-4 pb-6 pt-3 sm:px-6";

const BUTTON = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function HealthExitButtons({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="flex w-full items-center gap-2" data-testid="health-exit">
      <button type="button" onClick={onLeave} data-testid="health-back" className={`${BUTTON} gap-1.5 px-2 text-[13px] font-medium`}>
        <ArrowLeft size={16} aria-hidden="true" />{t("ux.l2a.health.back")}
      </button>
      <button type="button" onClick={onLeave} data-testid="health-close" aria-label={t("ux.l2a.health.close")} title={t("ux.l2a.health.close")} className={`${BUTTON} ml-auto min-w-11`}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The top of Health's header: the phone's bot-list button (`menu`, each caller draws its own <OpenBotListButton />,
 * as every main view does), Back and close, then the title. `dot` is the status dot once the page knows it. */
export function HealthHeadTop({ onLeave, menu, dot }: { onLeave: () => void; menu: ReactNode; dot?: ReactNode }) {
  return (
    <>
      <div className="flex w-full items-center gap-1">
        <div className="md:hidden">{menu}</div>
        <HealthExitButtons onLeave={onLeave} />
      </div>
      <h1 id="health-page-title" className="flex items-center gap-2 text-[20px] font-semibold">
        {dot}{t("ux.l2a.health.title")}
      </h1>
    </>
  );
}

/** Health before its body is up, loading or failed to load: the same header, and what is happening in the body. */
export function HealthFrame({ onLeave, children }: { onLeave: () => void; children: ReactNode }) {
  return (
    <main aria-labelledby="health-page-title" className={HEALTH_FRAME}>
      <BoxHead className={HEALTH_HEAD}><HealthHeadTop onLeave={onLeave} menu={<OpenBotListButton />} /></BoxHead>
      <BoxBody className={HEALTH_BODY}>{children}</BoxBody>
    </main>
  );
}

/** The spinner while Health's body arrives, inside the page and under its header. */
export function HealthLoading() {
  return (
    <div role="status" aria-label={t("ux.l2a.health.loading")} data-health-loading className="flex flex-1 items-center justify-center py-12">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}

/** Anything open on top of Health that Esc closes first: a dialog, Settings, a menu. One selector a line. */
export const OPEN_ON_TOP = [
  "dialog[open]",
  '[role="dialog"][aria-modal="true"]',
  '[role="menu"]',
  "[data-room-menu]",
  "[data-section-picker]",
  "[data-bot-menu]",
].join(", ");

type KeyTarget = { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;

/** Esc leaves Health unless something on top of it (a dialog, a menu, a field's own Esc) takes the key first. */
export function escapeLeavesHealth(event: { key: string; defaultPrevented: boolean; target?: unknown }, doc: Pick<Document, "querySelector"> | undefined): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  const target = (event.target ?? null) as KeyTarget;
  if (target?.isContentEditable || target?.closest?.("input, textarea, select")) return false;
  return !doc?.querySelector(OPEN_ON_TOP);
}

/** The keydown listener Health binds while it is on screen. */
export function healthEscapeListener(onLeave: () => void, doc: () => Pick<Document, "querySelector"> | undefined) {
  return (event: { key: string; defaultPrevented: boolean; target?: unknown; preventDefault: () => void }) => {
    if (!escapeLeavesHealth(event, doc())) return;
    event.preventDefault();
    onLeave();
  };
}

export function useHealthEscape(onLeave: () => void) {
  useEffect(() => {
    const onKey = healthEscapeListener(onLeave, () => globalThis.document);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLeave]);
}
