// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Right-click a link in a message to attach it to the conversation (or take
// it off again), or copy it. Adapted from OpenMausBot PR #2687 (Apache-2.0).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link2, Link2Off, Pin } from "lucide-react";
import { copyOrReport } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { raiseTransientError } from "@/state/chat-error";
import { useStore, useStoreIfAny } from "@/state/store";
import { threadLinkUrl } from "../../shared/thread-link";

type ThreadLinkValue = { link?: string; assign: (link: string | null) => void };
const ThreadLinkContext = createContext<ThreadLinkValue | null>(null);

const ITEM_CLASS = "flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[12px] text-ink hover:bg-raised";

/** Makes the open conversation's link assignable from every link beneath it. */
export function ThreadLinkProvider({ botId, threadId, link, children }: { botId: string; threadId: string; link?: string; children: ReactNode }) {
  const { dispatch } = useStore();
  const value = useMemo<ThreadLinkValue>(
    () => ({ link, assign: (next) => dispatch({ type: "updateTask", botId, threadId, patch: { link: next } }) }),
    [link, botId, threadId, dispatch],
  );
  return <ThreadLinkContext value={value}>{children}</ThreadLinkContext>;
}

export function useThreadLinkMenu(href: string | undefined) {
  // A message can render with no store above it (an exported or static render); the menu needs one only when it reports a failed copy.
  const dispatch = useStoreIfAny()?.dispatch;
  const thread = useContext(ThreadLinkContext);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => { if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setAt(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("scroll", close, true); };
  }, [at]);
  const url = threadLinkUrl(href);
  if (!thread || !url) return { onContextMenu: undefined, menu: null };
  const assigned = thread.link === url;
  const run = (action: () => void) => () => { setAt(null); action(); };
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setAt({ left: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)), top: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)) });
    },
    menu: at && createPortal(
      <div ref={menuRef} role="group" aria-label={url} style={at}
        className="fixed z-50 w-[220px] rounded-lg border border-hairline/50 bg-card p-1 shadow-xl"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAt(null); } }}>
        <button type="button" onClick={run(() => thread.assign(assigned ? null : url))} className={ITEM_CLASS}>
          {assigned ? <Link2Off size={12} /> : <Pin size={12} />}{t(assigned ? "task.unassignLink" : "task.assignLink")}
        </button>
        <button type="button" onClick={run(() => void copyOrReport(url, (message) => { if (dispatch) raiseTransientError(dispatch, message); }))} className={ITEM_CLASS}><Link2 size={12} />{t("task.copyLink")}</button>
      </div>, document.body),
  };
}

/** An ordinary external link in a message, with the right-click menu when a conversation is open. */
export function MessageExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const linkMenu = useThreadLinkMenu(href);
  return (
    <>
      {linkMenu.menu}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onContextMenu={linkMenu.onContextMenu}
        className="[overflow-wrap:anywhere] text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </a>
    </>
  );
}
