// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE TERMS SCREENS, loaded on demand by TermsGate.tsx so the first-paint
// budget never carries them. Shown before anything else on a first run, and once to an
// existing install the first time it opens a build that asks for newer terms
// (TERMS_VERSION, shared/terms.ts). Nothing behind it is mounted until the
// owner has ticked the box and pressed Accept, so nothing can be sent. The
// record is the server's (server/terms.ts); the same screen shows on a paired
// phone or browser, because accepting on any owner screen covers the install.
// Only the desktop app offers Quit: a browser tab is closed with the tab.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import { canAccept, isTermsRefusal, PRIVACY_URL, TERMS_URL } from "@/lib/terms";
import { openAnnouncementLink } from "@/lib/announcements";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => { event.preventDefault(); void openAnnouncementLink(href); }}
      className="rounded-sm font-medium text-accent underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      {children}
    </a>
  );
}

/** The checkbox sentence with its two links, in the order each language puts them. */
function agreement(): ReactNode[] {
  const pieces = t("terms.checkbox").split(/(\{terms\}|\{privacy\})/);
  return pieces.map((piece, at) => {
    if (piece === "{terms}") return <ExternalLink key={at} href={TERMS_URL}>{t("terms.link.terms")}</ExternalLink>;
    if (piece === "{privacy}") return <ExternalLink key={at} href={PRIVACY_URL}>{t("terms.link.privacy")}</ExternalLink>;
    return piece;
  });
}

/** The dialog shell. Height-constrained and scrolling, so a short viewport or
 *  400% zoom can always reach the controls; nothing is clipped by the page's
 *  hidden overflow. */
function Frame({ titleId, children }: { titleId: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-terms-frame
      className="fixed inset-0 z-[70] flex overflow-y-auto bg-app p-4"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
    >
      <div
        data-terms-card
        className="m-auto w-full max-w-[460px] rounded-2xl border border-hairline/60 bg-panel p-6"
      >
        {children}
      </div>
    </div>
  );
}

function QuitButton() {
  const quit = window.muragebox?.quit;
  if (!quit) return null;
  return (
    <button
      type="button"
      onClick={() => void quit()}
      className="h-11 rounded-xl border border-hairline/60 px-4 text-[14px] font-medium text-ink hover:bg-inset focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      {t("terms.quit")}
    </button>
  );
}

/** The check itself failed. The gate stays up (a failed check never lets the
 *  app through); it retries on its own and the button asks now. */
export function TermsUnreachable({ onRetry, hint = false }: { onRetry: () => void; hint?: boolean }) {
  const titleId = useId();
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { retryRef.current?.focus(); }, []);
  return (
    <Frame titleId={titleId}>
      <h2 id={titleId} tabIndex={-1} className="text-[18px] font-medium text-ink">{t("terms.title")}</h2>
      <p role="status" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("terms.unreachable")}</p>
      {hint && <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("terms.desktopOnly")}</p>}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <button
          ref={retryRef}
          type="button"
          onClick={onRetry}
          className="h-11 flex-1 rounded-xl bg-accent px-4 text-[14px] font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {t("terms.retry")}
        </button>
        <QuitButton />
      </div>
    </Frame>
  );
}

export function TermsScreen({ updated, onAccept, onRecheck }: { updated: boolean; onAccept: () => Promise<void>; onRecheck?: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<false | "retry" | "elsewhere">(false);
  const titleId = useId();
  const boxRef = useRef<HTMLInputElement>(null);
  useEffect(() => { boxRef.current?.focus(); }, []);
  const accept = async () => {
    if (!canAccept(ticked, saving)) return;
    setSaving(true);
    setFailed(false);
    try {
      await onAccept();
    } catch (error) {
      setFailed(isTermsRefusal(error) ? "elsewhere" : "retry");
      setSaving(false);
    }
  };
  return (
    <Frame titleId={titleId}>
      <h2 id={titleId} className="text-[18px] font-medium text-ink">{t("terms.title")}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{updated ? t("terms.updatedIntro") : t("terms.intro")}</p>
      <label className="mt-5 flex cursor-pointer items-start gap-3 text-[14px] leading-relaxed text-ink">
        <input
          ref={boxRef}
          data-terms-checkbox
          type="checkbox"
          checked={ticked}
          onChange={(event) => setTicked(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-accent/70"
        />
        <span>{agreement()}</span>
      </label>
      {failed && <p role="alert" className="mt-3 text-[13px] text-ink-secondary">{failed === "elsewhere" ? t("terms.desktopOnly") : t("terms.error")}</p>}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="button"
          data-terms-accept
          disabled={!canAccept(ticked, saving)}
          onClick={() => void accept()}
          className="h-11 flex-1 rounded-xl bg-accent px-4 text-[14px] font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("terms.accept")}
        </button>
        <QuitButton />
      </div>
      {failed === "elsewhere" && onRecheck && (
        <button
          type="button"
          data-terms-recheck
          onClick={onRecheck}
          className="mt-2 h-11 w-full rounded-xl border border-hairline/60 px-4 text-[14px] font-medium text-ink hover:bg-inset focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {t("terms.retry")}
        </button>
      )}
    </Frame>
  );
}

