// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One Needs you row (UX L2B). Collapsed it is a line to read: avatar, the
// question it asks, "<bot> · waiting since 07:12", and Open. Nothing on the
// collapsed row commits anything (R1-04: a one-line row once sent an email the
// owner never saw). Open expands the same card the chat shows, in place, and
// every verb lives there. On a phone (UX L7) the open card rises as a sheet
// over the list instead, so its verbs sit under the thumb.
import type { ReactNode, Ref } from "react";
import { t } from "@/lib/i18n";
import { useNarrowViewport } from "@/lib/media-query";
import { PhoneSheet } from "@/components/phone/PhoneSheet";

export interface NeedsRowProps {
  id: string;
  /** the question, never an option */
  line: string;
  /** "Max · waiting since 07:12" */
  meta: string;
  avatar?: ReactNode;
  open: boolean;
  /** "came back" after a snooze ran out */
  cameBack?: boolean;
  onToggle: () => void;
  /** the expanded card: shown only while open */
  children?: ReactNode;
  headRef?: Ref<HTMLButtonElement>;
}

const openButton = "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-hairline/50 bg-control px-3 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function NeedsRow({ id, line, meta, avatar, open, cameBack, onToggle, children, headRef }: NeedsRowProps) {
  const bodyId = `needs-row-body-${id}`;
  const phone = useNarrowViewport();
  const inline = open && !phone;
  const sheet = open && phone;
  // One element names the entry at a time: the row, or on a phone the open sheet (portalled to the end of the body, it carries
  // data-needs-row so the door's key model finds its row). Two elements with the same marker made the entry ambiguous.
  return (
    <li data-needs-row={sheet ? undefined : id} data-open={open ? "true" : "false"} className={`rounded-xl border bg-inset ${open ? "border-accent/40" : "border-hairline/50"}`}>
      <div className="flex min-h-14 items-center gap-3 px-3 py-2">
        {avatar && <span aria-hidden className="shrink-0">{avatar}</span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium leading-snug text-ink">{line}</p>
          <p className="truncate text-[12px] text-ink-secondary">
            {meta}
            {cameBack && <span className="ml-2 rounded-md bg-control px-1.5 py-0.5 text-[11px] text-ink">{t("ux.l2b.door.cameBack")}</span>}
          </p>
        </div>
        <button ref={headRef} type="button" data-needs-open={id} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle} className={openButton}>
          {open ? t("ux.l2b.door.close") : t("ux.l2b.door.open")}
        </button>
      </div>
      {inline && <div id={bodyId} className="border-t border-hairline/40 px-4 pb-4">{children}</div>}
      {sheet && <PhoneSheet title={line} onClose={onToggle} bodyData={{ "data-needs-row": id }} bodyId={bodyId} namedByBodyHeading>{children}</PhoneSheet>}
    </li>
  );
}
